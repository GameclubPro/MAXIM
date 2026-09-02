'use strict';

const { spawn } = require('node:child_process');
const { readFileSync, statfsSync } = require('node:fs');
const os = require('node:os');
const { resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const readyMonitorPath =
  __filename === '[stdin]'
    ? resolve(process.cwd(), 'infra/scripts/monitor-ready-status.cjs')
    : resolve(__dirname, 'monitor-ready-status.cjs');
const { ADMIN_READY_URL, INGRESS_READY_URL, probeReadyEndpoint } = require(readyMonitorPath);

const DEFAULT_BLOCK_DEVICE = 'vda';
const DEFAULT_DISK_PATH = '/var/lib/docker';
const DEFAULT_SAMPLE_MS = 1_000;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const PROCESS_TIMEOUT_MS = 5_000;
const QUEUE_CONTROL_HELPER = 'infra/scripts/webhook-queue-rollout-control.cjs';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseProcStat(raw) {
  const line = raw.split(/\r?\n/u).find((candidate) => candidate.startsWith('cpu '));
  if (!line) throw new Error('Host CPU counters are unavailable.');
  const values = line.trim().split(/\s+/u).slice(1, 9).map(Number);
  if (values.length < 5 || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Host CPU counters are invalid.');
  }
  return {
    total: values.reduce((sum, value) => sum + value, 0),
    iowait: values[4],
  };
}

function parseVmstat(raw) {
  const values = new Map();
  for (const line of raw.split(/\r?\n/u)) {
    const match = /^([a-z_]+)\s+(\d+)$/u.exec(line.trim());
    if (match) values.set(match[1], Number(match[2]));
  }
  const swapInPages = values.get('pswpin');
  if (!Number.isSafeInteger(swapInPages) || swapInPages < 0) {
    throw new Error('Host swap-in counter is unavailable.');
  }
  return { swapInPages };
}

function parseMeminfo(raw) {
  const values = new Map();
  for (const line of raw.split(/\r?\n/u)) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB$/u.exec(line.trim());
    if (match) values.set(match[1], Number(match[2]) * 1024);
  }
  const required = ['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'];
  if (required.some((field) => !Number.isSafeInteger(values.get(field)))) {
    throw new Error('Host memory counters are unavailable.');
  }
  return {
    memoryTotalBytes: values.get('MemTotal'),
    memoryAvailableBytes: values.get('MemAvailable'),
    swapTotalBytes: values.get('SwapTotal'),
    swapUsedBytes: Math.max(0, values.get('SwapTotal') - values.get('SwapFree')),
  };
}

function parseDiskstats(raw, device) {
  const line = raw
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim().split(/\s+/u))
    .find((fields) => fields[2] === device);
  if (!line || line.length < 14) throw new Error('Host block-device counters are unavailable.');
  const ioMs = Number(line[12]);
  const weightedIoMs = Number(line[13]);
  if (![ioMs, weightedIoMs].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error('Host block-device counters are invalid.');
  }
  return { ioMs, weightedIoMs };
}

function calculateCounterRates(before, after, elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    throw new Error('Capacity sample interval is invalid.');
  }
  const cpuDelta = after.cpu.total - before.cpu.total;
  const iowaitDelta = after.cpu.iowait - before.cpu.iowait;
  const swapInDelta = after.vmstat.swapInPages - before.vmstat.swapInPages;
  const diskIoDelta = after.disk.ioMs - before.disk.ioMs;
  const weightedIoDelta = after.disk.weightedIoMs - before.disk.weightedIoMs;
  if (
    [cpuDelta, iowaitDelta, swapInDelta, diskIoDelta, weightedIoDelta].some((value) => value < 0)
  ) {
    throw new Error('Capacity counters moved backwards.');
  }
  return {
    cpuIowaitPct: cpuDelta > 0 ? (iowaitDelta / cpuDelta) * 100 : null,
    swapInPagesPerSec: (swapInDelta * 1_000) / elapsedMs,
    diskUtilPct: Math.min(100, (diskIoDelta / elapsedMs) * 100),
    diskAvgQueueDepth: weightedIoDelta / elapsedMs,
  };
}

function readHostCounters(device) {
  return {
    cpu: parseProcStat(readFileSync('/proc/stat', 'utf8')),
    vmstat: parseVmstat(readFileSync('/proc/vmstat', 'utf8')),
    disk: parseDiskstats(readFileSync('/proc/diskstats', 'utf8'), device),
  };
}

function diskCapacity(path) {
  const stats = statfsSync(path, { bigint: true });
  const totalBytes = stats.blocks * stats.bsize;
  const availableBytes = stats.bavail * stats.bsize;
  if (totalBytes <= 0n || availableBytes < 0n || availableBytes > totalBytes) {
    throw new Error('Host filesystem counters are invalid.');
  }
  return {
    totalBytes: Number(totalBytes),
    availableBytes: Number(availableBytes),
    usedPct: Number(((totalBytes - availableBytes) * 10_000n) / totalBytes) / 100,
  };
}

function unwrapHealthBody(raw) {
  if (!isRecord(raw)) return {};
  return isRecord(raw.message) ? raw.message : raw;
}

function normalizeReadyProbe(probe, includeQueue) {
  const body = unwrapHealthBody(probe?.body);
  const checks = isRecord(body.checks) ? body.checks : {};
  const queueLag = isRecord(checks.queueLag) ? checks.queueLag : {};
  const systemMode = isRecord(body.systemMode) ? body.systemMode : {};
  const burst = isRecord(body.burst) ? body.burst : {};
  const httpStatus = Number.isInteger(probe?.httpStatus) ? probe.httpStatus : null;
  const softWarning = typeof queueLag.softWarning === 'boolean' ? queueLag.softWarning : null;
  const softWarningCode =
    softWarning === false && queueLag.softWarningCode === null
      ? 'none'
      : softWarning === true &&
          ['queue-lag-hysteresis', 'stale-ready-fallback'].includes(queueLag.softWarningCode)
        ? queueLag.softWarningCode
        : 'unknown';
  const result = {
    available: httpStatus !== null && typeof body.ok === 'boolean',
    httpStatus,
    ok: typeof body.ok === 'boolean' ? body.ok : null,
    database: typeof checks.database === 'boolean' ? checks.database : null,
    redis: typeof checks.redis === 'boolean' ? checks.redis : null,
  };
  if (!includeQueue) return result;
  return {
    ...result,
    rawOk: typeof queueLag.rawOk === 'boolean' ? queueLag.rawOk : null,
    queueOk: typeof queueLag.ok === 'boolean' ? queueLag.ok : null,
    softWarning,
    softWarningCode,
    queueLagSec: finiteNonNegative(queueLag.effectiveLagSec ?? systemMode.queueLagSec),
    mode:
      systemMode.mode === 'normal' || systemMode.mode === 'degrade' ? systemMode.mode : 'unknown',
    condition:
      typeof systemMode.condition === 'string' &&
      ['healthy', 'queue_backlog', 'max_api', 'mixed', 'stabilizing', 'manual', 'unknown'].includes(
        systemMode.condition,
      )
        ? systemMode.condition
        : 'unknown',
    burstActive: typeof burst.active === 'boolean' ? burst.active : null,
  };
}

function normalizeQueueFence(raw) {
  if (!isRecord(raw)) throw new Error('Webhook queue status is invalid.');
  const integerFields = ['queueCount', 'pausedCount', 'activeCount'];
  if (integerFields.some((field) => !Number.isSafeInteger(raw[field]) || raw[field] < 0)) {
    throw new Error('Webhook queue status counters are invalid.');
  }
  if (typeof raw.ownerPresent !== 'boolean') {
    throw new Error('Webhook queue ownership status is invalid.');
  }
  return {
    available: true,
    queueCount: raw.queueCount,
    pausedCount: raw.pausedCount,
    activeCount: raw.activeCount,
    ownerPresent: raw.ownerPresent,
  };
}

function runBounded(command, args, options = {}) {
  return new Promise((resolve) => {
    let output = '';
    let outputBytes = 0;
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, output: '' });
    }, options.timeoutMs ?? PROCESS_TIMEOUT_MS);
    child.once('error', () => finish({ ok: false, output: '' }));
    child.stdin.on('error', () => undefined);
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > (options.maxOutputBytes ?? MAX_PROCESS_OUTPUT_BYTES)) {
        child.kill('SIGKILL');
        finish({ ok: false, output: '' });
        return;
      }
      output += chunk.toString('utf8');
    });
    child.once('close', (code) => finish({ ok: code === 0, output }));
    child.stdin.end(options.input ?? '');
  });
}

async function probeQueueFence() {
  let helper;
  try {
    helper = readFileSync(QUEUE_CONTROL_HELPER, 'utf8');
  } catch {
    return { available: false };
  }
  const result = await runBounded(
    'docker',
    [
      'compose',
      '--env-file',
      '.env',
      '-p',
      'infra',
      '-f',
      'infra/docker-compose.yml',
      'exec',
      '-T',
      'api-admin',
      'node',
      '-',
      'status',
    ],
    { input: helper },
  );
  if (!result.ok) return { available: false };
  try {
    return normalizeQueueFence(JSON.parse(result.output));
  } catch {
    return { available: false };
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDevice(value) {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_BLOCK_DEVICE;
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(candidate)) {
    throw new Error('Capacity block device is invalid.');
  }
  return candidate;
}

async function collectCapacitySnapshot(options = {}) {
  const device = normalizeDevice(options.device);
  const sampleMs = options.sampleMs ?? DEFAULT_SAMPLE_MS;
  if (!Number.isSafeInteger(sampleMs) || sampleMs < 250 || sampleMs > 5_000) {
    throw new Error('Capacity sample duration must be between 250 and 5000 milliseconds.');
  }
  const before = readHostCounters(device);
  const startedAt = performance.now();
  const probesPromise = Promise.all([
    probeReadyEndpoint(INGRESS_READY_URL),
    probeReadyEndpoint(ADMIN_READY_URL),
    probeQueueFence(),
  ]);
  await wait(sampleMs);
  const after = readHostCounters(device);
  const elapsedMs = performance.now() - startedAt;
  const [ingressProbe, adminProbe, queueFence] = await probesPromise;
  const rates = calculateCounterRates(before, after, elapsedMs);
  const memory = parseMeminfo(readFileSync('/proc/meminfo', 'utf8'));
  let filesystem;
  let diskPath = options.diskPath ?? DEFAULT_DISK_PATH;
  try {
    filesystem = diskCapacity(diskPath);
  } catch {
    diskPath = '/';
    filesystem = diskCapacity(diskPath);
  }

  return {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    host: {
      cpuCount: os.cpus().length,
      load1: finiteNonNegative(os.loadavg()[0]),
      ...memory,
      cpuIowaitPct: finiteNonNegative(rates.cpuIowaitPct),
      swapInPagesPerSec: finiteNonNegative(rates.swapInPagesPerSec),
      disk: {
        device,
        path: diskPath,
        ...filesystem,
        utilPct: finiteNonNegative(rates.diskUtilPct),
        avgQueueDepth: finiteNonNegative(rates.diskAvgQueueDepth),
      },
    },
    readiness: normalizeReadyProbe(ingressProbe, true),
    adminReadiness: normalizeReadyProbe(adminProbe, false),
    queueFence,
  };
}

module.exports = {
  DEFAULT_BLOCK_DEVICE,
  DEFAULT_DISK_PATH,
  calculateCounterRates,
  collectCapacitySnapshot,
  normalizeQueueFence,
  normalizeReadyProbe,
  parseDiskstats,
  parseMeminfo,
  parseProcStat,
  parseVmstat,
};

if (require.main === module || __filename === '[stdin]') {
  void collectCapacitySnapshot({ device: process.argv[2] })
    .then((snapshot) => {
      process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    })
    .catch(() => {
      process.stdout.write(
        `${JSON.stringify({ schemaVersion: 1, observedAt: new Date().toISOString(), unavailable: true })}\n`,
      );
      process.exitCode = 1;
    });
}
