import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import archiveModule from './monitor-capacity-archive.cjs';
import probeModule from './monitor-capacity-probe.cjs';

const root = resolve(import.meta.dirname, '../..');
const archivePath = resolve(root, 'infra/scripts/monitor-capacity-archive.cjs');
const probePath = resolve(root, 'infra/scripts/monitor-capacity-probe.cjs');
const monitorPath = resolve(root, 'infra/scripts/vps-monitor-readonly.sh');
const monitorSource = readFileSync(monitorPath, 'utf8');

const {
  MAX_ARCHIVE_HOURS,
  MAX_RECORDS_PER_HOUR,
  RETENTION_DAYS,
  archiveFilename,
  archiveSnapshot,
  evaluateAlerts,
  normalizeSnapshot,
} = archiveModule;
const {
  calculateCounterRates,
  normalizeQueueFence,
  normalizeReadyProbe,
  parseDiskstats,
  parseMeminfo,
  parseProcStat,
  parseVmstat,
} = probeModule;

function sample(observedAt, overrides = {}) {
  return {
    schemaVersion: 1,
    observedAt,
    host: {
      cpuCount: 8,
      load1: 3,
      memoryTotalBytes: 24 * 1024 ** 3,
      memoryAvailableBytes: 12 * 1024 ** 3,
      swapTotalBytes: 4 * 1024 ** 3,
      swapUsedBytes: 0,
      cpuIowaitPct: 5,
      swapInPagesPerSec: 0,
      disk: {
        device: 'vda',
        path: '/var/lib/docker',
        totalBytes: 300 * 1024 ** 3,
        availableBytes: 100 * 1024 ** 3,
        usedPct: 66.67,
        utilPct: 50,
        avgQueueDepth: 2,
      },
      ...(overrides.host ?? {}),
    },
    readiness: {
      available: true,
      httpStatus: 200,
      ok: true,
      database: true,
      redis: true,
      rawOk: true,
      queueOk: true,
      softWarning: false,
      softWarningCode: 'none',
      queueLagSec: 0.5,
      mode: 'normal',
      condition: 'healthy',
      burstActive: false,
      ...(overrides.readiness ?? {}),
    },
    adminReadiness: {
      available: true,
      httpStatus: 200,
      ok: true,
      database: true,
      redis: true,
      ...(overrides.adminReadiness ?? {}),
    },
    queueFence: {
      available: true,
      queueCount: 24,
      pausedCount: 0,
      activeCount: 0,
      ownerPresent: false,
      ...(overrides.queueFence ?? {}),
    },
    privateToken: 'must-not-survive',
  };
}

function minuteSamples(start, count, overrides) {
  const startedAtMs = Date.parse(start);
  return Array.from({ length: count }, (_, index) =>
    normalizeSnapshot(sample(new Date(startedAtMs + index * 60_000).toISOString(), overrides)),
  );
}

function archiveAt(directory, value) {
  return archiveSnapshot(value, { directory, nowMs: Date.parse(value.observedAt) });
}

function shellFunction(name) {
  const match = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'mu').exec(monitorSource);
  assert.ok(match, `missing shell function ${name}`);
  return match[0];
}

function runMonitorLogHarness(logPath, tempRoot) {
  const harness = [
    'set -euo pipefail',
    'umask 077',
    'LOG_FILE="$1"',
    'EPHEMERAL_LOG_DIR=""',
    'MONITOR_LOG_FD=""',
    'MONITOR_TEE_PID=""',
    'MONITOR_WORKER_PID=""',
    'CAPACITY_SAMPLER_PID=""',
    'CAPACITY_SAMPLER_LOCK_FD=""',
    'TMPDIR="$2"',
    shellFunction('cleanup_monitor_log'),
    shellFunction('cleanup_monitor'),
    shellFunction('prepare_monitor_log'),
    'trap cleanup_monitor EXIT',
    'prepare_monitor_log',
    'printf "private monitor line\\n" | tee -a "/dev/fd/$MONITOR_LOG_FD" >/dev/null',
    'printf "path=%s\\n" "$LOG_FILE"',
    'printf "mode=%s\\n" "$(stat -c \'%a\' -- "$LOG_FILE")"',
  ].join('\n');
  return spawnSync('bash', ['-c', harness, 'monitor-log-harness', logPath, tempRoot], {
    encoding: 'utf8',
  });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runMonitorLifecycleHarness(tempRoot, processRoot, exitStatus) {
  const childFile = join(processRoot, 'child.pid');
  const samplerFile = join(processRoot, 'sampler.pid');
  const harness = [
    'set -euo pipefail',
    'umask 077',
    'LOG_FILE=""',
    'EPHEMERAL_LOG_DIR=""',
    'MONITOR_LOG_FD=""',
    'MONITOR_TEE_PID=""',
    'MONITOR_WORKER_PID=""',
    'CAPACITY_SAMPLER_PID=""',
    'CAPACITY_SAMPLER_LOCK_FD=""',
    'DURATION_SEC=10',
    'TMPDIR="$1"',
    'RUN_STATUS="$2"',
    'child_file="$3"',
    'sampler_file="$4"',
    shellFunction('cleanup_monitor_log'),
    shellFunction('cleanup_monitor'),
    shellFunction('prepare_monitor_log'),
    shellFunction('stop_capacity_sampler'),
    shellFunction('start_monitor_worker'),
    shellFunction('stop_monitor_worker'),
    shellFunction('start_monitor_output'),
    shellFunction('stop_monitor_output'),
    shellFunction('run_monitor_with_capacity_sampler'),
    'start_capacity_sampler() {',
    '  setsid bash -c \'sleep 30 & printf "%s\\n" "$!" > "$1"; wait\' sampler "$child_file" &',
    '  CAPACITY_SAMPLER_PID=$!',
    '  printf "%s\\n" "$CAPACITY_SAMPLER_PID" > "$sampler_file"',
    '}',
    'run_monitor() {',
    '  for _ in $(seq 1 100); do [[ -s "$child_file" ]] && break; sleep 0.01; done',
    '  [[ -s "$child_file" ]]',
    '  return "$RUN_STATUS"',
    '}',
    'trap cleanup_monitor EXIT',
    'prepare_monitor_log',
    'exec {MONITOR_LOCK_FD}>"$TMPDIR/monitor.lock"',
    'start_monitor_output',
    'printf "path=%s\\n" "$LOG_FILE"',
    'if run_monitor_with_capacity_sampler; then status=0; else status=$?; fi',
    'exit "$status"',
  ].join('\n');
  const result = spawnSync(
    'bash',
    [
      '-c',
      harness,
      'monitor-lifecycle-harness',
      tempRoot,
      String(exitStatus),
      childFile,
      samplerFile,
    ],
    { encoding: 'utf8' },
  );
  return { childFile, result, samplerFile };
}

function writeExecutable(path, source) {
  writeFileSync(path, source, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function recordedProcesses(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => line.trim().split(/\s+/u).map(Number))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 1);
}

async function waitForCondition(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error('Timed out waiting for monitor harness state.');
}

function waitForClose(child, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('Monitor did not terminate in time.')), timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test('host counter parsers calculate bounded iowait, swap-in, and disk rates', () => {
  assert.deepEqual(parseProcStat('cpu  100 0 50 800 50 0 0 0 0 0\n'), {
    total: 1000,
    iowait: 50,
  });
  assert.deepEqual(parseVmstat('pgpgin 12\npswpin 42\npswpout 7\n'), { swapInPages: 42 });
  assert.deepEqual(
    parseMeminfo('MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 200 kB\nSwapFree: 150 kB\n'),
    {
      memoryTotalBytes: 1_024_000,
      memoryAvailableBytes: 409_600,
      swapTotalBytes: 204_800,
      swapUsedBytes: 51_200,
    },
  );
  assert.deepEqual(parseDiskstats('8 0 vda 10 0 20 30 40 0 50 60 0 70 80\n', 'vda'), {
    ioMs: 70,
    weightedIoMs: 80,
  });
  assert.deepEqual(
    calculateCounterRates(
      {
        cpu: { total: 1_000, iowait: 50 },
        vmstat: { swapInPages: 10 },
        disk: { ioMs: 100, weightedIoMs: 200 },
      },
      {
        cpu: { total: 1_100, iowait: 70 },
        vmstat: { swapInPages: 14 },
        disk: { ioMs: 700, weightedIoMs: 1_200 },
      },
      1_000,
    ),
    {
      cpuIowaitPct: 20,
      swapInPagesPerSec: 4,
      diskUtilPct: 60,
      diskAvgQueueDepth: 1,
    },
  );
});

test('readiness and queue probes retain only allowlisted aggregate fields', () => {
  const readiness = normalizeReadyProbe(
    {
      httpStatus: 503,
      body: {
        message: {
          ok: false,
          privateToken: 'secret',
          burst: { active: true, privateBotId: 'bot-private' },
          systemMode: {
            mode: 'degrade',
            condition: 'queue_backlog',
            queueLagSec: 31,
            reason: 'private detail',
          },
          checks: {
            database: true,
            redis: true,
            queueLag: {
              ok: false,
              rawOk: false,
              softWarning: false,
              softWarningCode: null,
              effectiveLagSec: 31,
            },
          },
        },
      },
    },
    true,
  );
  assert.deepEqual(readiness, {
    available: true,
    httpStatus: 503,
    ok: false,
    database: true,
    redis: true,
    rawOk: false,
    queueOk: false,
    softWarning: false,
    softWarningCode: 'none',
    queueLagSec: 31,
    mode: 'degrade',
    condition: 'queue_backlog',
    burstActive: true,
  });
  assert.deepEqual(
    normalizeQueueFence({
      queueCount: 24,
      pausedCount: 0,
      activeCount: 3,
      ownerPresent: false,
      ownerToken: 'secret',
    }),
    { available: true, queueCount: 24, pausedCount: 0, activeCount: 3, ownerPresent: false },
  );
  assert.doesNotMatch(JSON.stringify(readiness), /secret|private/u);
});

test('capacity probe resolves its sibling helper when executed through node stdin', () => {
  const result = spawnSync(process.execPath, ['-', 'invalid/device'], {
    cwd: root,
    input: readFileSync(probePath, 'utf8'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    observedAt: JSON.parse(result.stdout).observedAt,
    unavailable: true,
  });
});

test('alert windows require continuous samples and expose every requested outcome', () => {
  const high = minuteSamples('2026-09-02T12:00:00.000Z', 6, {
    host: {
      cpuIowaitPct: 35,
      memoryAvailableBytes: 2 * 1024 ** 3,
      swapInPagesPerSec: 2,
      swapUsedBytes: 1024 ** 3,
    },
  });
  const result = evaluateAlerts(high.slice(0, -1), high.at(-1));
  assert.equal(result.alerts.iowait_warning_5m.outcome, 'firing');
  assert.equal(result.alerts.iowait_critical_2m.outcome, 'firing');
  assert.equal(result.alerts.swap_in_sustained_5m.outcome, 'firing');
  assert.equal(result.alerts.swap_used_10pct_5m.outcome, 'firing');
  assert.equal(result.alerts.memory_available_warning_5m.outcome, 'firing');
  assert.equal(result.alerts.memory_available_critical_2m.outcome, 'firing');
  assert.equal(result.alerts.disk_free_40gib.outcome, 'clear');
  assert.equal(result.alerts.readiness.outcome, 'clear');
  assert.equal(result.alerts.queue_metrics.outcome, 'clear');
  assert.equal(result.alerts.queue_lag_warning.outcome, 'clear');
  assert.equal(result.alerts.queue_fence.outcome, 'clear');
  assert.equal(result.overallStatus, 'critical');

  const gap = [high[0], high.at(-1)];
  assert.equal(
    evaluateAlerts(gap.slice(0, -1), gap.at(-1)).alerts.iowait_warning_5m.outcome,
    'pending',
  );

  const unknown = normalizeSnapshot(
    sample('2026-09-02T12:03:00.000Z', { host: { cpuIowaitPct: null } }),
  );
  const interrupted = [...high.slice(0, 3), unknown, ...high.slice(4)];
  assert.equal(
    evaluateAlerts(interrupted.slice(0, -1), interrupted.at(-1)).alerts.iowait_warning_5m.outcome,
    'pending',
  );
});

test('immediate readiness, queue, fallback, mode, fence, and disk alerts fail closed', () => {
  const current = normalizeSnapshot(
    sample('2026-09-02T12:00:00.000Z', {
      host: { disk: { availableBytes: 39 * 1024 ** 3 } },
      readiness: {
        httpStatus: 503,
        ok: false,
        rawOk: false,
        queueOk: false,
        softWarning: true,
        softWarningCode: 'stale-ready-fallback',
        queueLagSec: 31,
        mode: 'degrade',
        condition: 'mixed',
        burstActive: true,
      },
      queueFence: { pausedCount: 24, ownerPresent: true },
    }),
  );
  const result = evaluateAlerts([], current);
  for (const id of [
    'disk_free_40gib',
    'readiness',
    'readiness_fallback',
    'queue_metrics',
    'system_mode',
    'queue_backlog_mode',
    'max_api_mode',
    'queue_lag_warning',
    'queue_lag_critical',
    'queue_fence',
  ]) {
    assert.equal(result.alerts[id].outcome, 'firing', id);
  }
  assert.equal(result.overallStatus, 'critical');

  const lagHysteresis = normalizeSnapshot(
    sample('2026-09-02T12:00:00.000Z', {
      readiness: {
        rawOk: false,
        queueOk: true,
        softWarning: true,
        softWarningCode: 'queue-lag-hysteresis',
        queueLagSec: 12,
      },
    }),
  );
  const lagHysteresisAlerts = evaluateAlerts([], lagHysteresis).alerts;
  assert.equal(lagHysteresisAlerts.readiness.outcome, 'clear');
  assert.equal(lagHysteresisAlerts.readiness_fallback.outcome, 'clear');
  assert.equal(lagHysteresisAlerts.queue_metrics.outcome, 'clear');
  assert.equal(lagHysteresisAlerts.queue_lag_warning.outcome, 'firing');
  assert.equal(lagHysteresisAlerts.queue_lag_critical.outcome, 'clear');

  const malformedSoftWarning = normalizeSnapshot(
    sample('2026-09-02T12:00:00.000Z', {
      readiness: { softWarning: true, softWarningCode: 'none' },
    }),
  );
  assert.equal(
    evaluateAlerts([], malformedSoftWarning).alerts.readiness_fallback.outcome,
    'unknown',
  );
  assert.equal(evaluateAlerts([], malformedSoftWarning).alerts.queue_metrics.outcome, 'unknown');

  const stabilizing = normalizeSnapshot(
    sample('2026-09-02T12:00:00.000Z', {
      readiness: { mode: 'degrade', condition: 'stabilizing', burstActive: true },
    }),
  );
  assert.equal(evaluateAlerts([], stabilizing).alerts.stabilizing_mode.outcome, 'firing');

  const manualNormal = normalizeSnapshot(
    sample('2026-09-02T12:00:00.000Z', {
      readiness: { mode: 'normal', condition: 'manual', burstActive: false },
    }),
  );
  const manualResult = evaluateAlerts([], manualNormal);
  assert.equal(manualResult.alerts.system_mode.outcome, 'firing');
  assert.equal(manualResult.alerts.system_mode.threshold, 'auto-normal/no-burst');
  assert.equal(manualResult.overallStatus, 'warning');

  const incompleteFence = normalizeSnapshot(
    sample('2026-09-02T12:00:00.000Z', { queueFence: { queueCount: 23 } }),
  );
  assert.equal(evaluateAlerts([], incompleteFence).alerts.queue_fence.outcome, 'firing');
});

test('archive is private, atomic, rotated, bounded, and excludes unknown input fields', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-archive-'));
  const old = join(directory, 'capacity-20260818T11.jsonl');
  const unrelated = join(directory, 'operator-note.txt');
  writeFileSync(old, '{}\n');
  writeFileSync(unrelated, 'preserve\n');

  const first = archiveAt(directory, sample('2026-09-02T12:00:00.000Z'));
  const second = archiveAt(directory, sample('2026-09-02T12:01:00.000Z'));
  const path = join(directory, second.filename);
  const content = readFileSync(path, 'utf8');

  assert.equal(RETENTION_DAYS, 14);
  assert.equal(MAX_ARCHIVE_HOURS, 337);
  assert.equal(MAX_RECORDS_PER_HOUR, 240);
  assert.equal(first.filename, archiveFilename(first.sample.observedAt));
  assert.equal(content.trim().split('\n').length, 2);
  assert.doesNotMatch(content, /must-not-survive|token|payload|secret|botId/u);
  assert.equal(lstatSync(directory).mode & 0o777, 0o700);
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  assert.equal(existsSync(old), false);
  assert.equal(readFileSync(unrelated, 'utf8'), 'preserve\n');
  assert.equal(
    readdirSync(directory).some((name) => name.includes('.tmp-')),
    false,
  );
});

test('archive rejects an existing non-private directory without changing its mode', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-public-'));
  chmodSync(directory, 0o755);
  assert.throws(
    () => archiveAt(directory, sample('2026-09-02T12:00:00.000Z')),
    /private to its owner/u,
  );
  assert.equal(lstatSync(directory).mode & 0o777, 0o755);
});

test('archive rejects a symlink directory and CLI prints explicit alert outcomes without jq', () => {
  const parent = mkdtempSync(join(tmpdir(), 'maxim-capacity-symlink-'));
  const target = join(parent, 'target');
  const link = join(parent, 'link');
  writeFileSync(target, 'not-a-directory');
  symlinkSync(target, link);
  assert.throws(() => archiveAt(link, sample('2026-09-02T12:00:00.000Z')), /real directory/u);

  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-cli-'));
  const result = spawnSync(process.execPath, [archivePath, '--archive-dir', directory], {
    input: JSON.stringify(sample(new Date().toISOString())),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /capacity-summary status=ok/u);
  assert.match(result.stdout, /capacity-alert id=iowait_warning_5m outcome=clear/u);
  assert.match(result.stdout, /capacity-alert id=queue_lag_critical outcome=clear/u);
  assert.doesNotMatch(readFileSync(archivePath, 'utf8'), /\bjq\b/u);
});

test('archive rejects remote clock jumps and preserves calendar-invalid reserved names', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-clock-'));
  const invalidName = join(directory, 'capacity-20269999T99.jsonl');
  writeFileSync(invalidName, 'operator-owned\n');
  assert.throws(
    () =>
      archiveSnapshot(sample('2026-09-03T12:00:00.000Z'), {
        directory,
        nowMs: Date.parse('2026-09-02T12:00:00.000Z'),
      }),
    /archive clock/u,
  );
  archiveAt(directory, sample('2026-09-02T12:00:00.000Z'));
  assert.equal(readFileSync(invalidName, 'utf8'), 'operator-owned\n');
});

test('archive trims the boundary hour to an exact 14-day retention window', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-boundary-'));
  const boundary = join(directory, 'capacity-20260819T12.jsonl');
  const record = (observedAt) =>
    JSON.stringify({
      schemaVersion: 1,
      sample: normalizeSnapshot(sample(observedAt)),
      alerts: {},
      overallStatus: 'ok',
    });
  writeFileSync(
    boundary,
    `${record('2026-08-19T12:00:00.000Z')}\n${record('2026-08-19T12:45:00.000Z')}\n`,
  );

  archiveSnapshot(sample('2026-09-02T12:30:00.000Z'), {
    directory,
    nowMs: Date.parse('2026-09-02T12:30:00.000Z'),
  });
  const retained = readFileSync(boundary, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    retained.map((item) => item.sample.observedAt),
    ['2026-08-19T12:45:00.000Z'],
  );
});

test('archive fails closed without rewriting a malformed owned hour', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-malformed-'));
  const path = join(directory, 'capacity-20260902T12.jsonl');
  writeFileSync(path, '{malformed}\n');
  assert.throws(() => archiveAt(directory, sample('2026-09-02T12:01:00.000Z')), /archive record/u);
  assert.equal(readFileSync(path, 'utf8'), '{malformed}\n');
  assert.equal(
    readdirSync(directory).some((name) => name.includes('.tmp-')),
    false,
  );
});

test('archive rewrites prior alerts without preserving free-form values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-alert-value-'));
  const observedAt = '2026-09-02T12:00:00.000Z';
  const path = join(directory, archiveFilename(observedAt));
  writeFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      sample: normalizeSnapshot(sample(observedAt)),
      alerts: {
        iowait_warning_5m: {
          outcome: 'firing',
          severity: 'warning',
          threshold: 15,
          windowSec: 300,
          value: 'private_token',
          sustainedForSec: 300,
        },
      },
      overallStatus: 'warning',
    })}\n`,
  );

  archiveAt(directory, sample('2026-09-02T12:01:00.000Z'));
  const records = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records[0].alerts.iowait_warning_5m.value, null);
  assert.doesNotMatch(JSON.stringify(records), /private_token/u);
});

test('legacy snapshots classify a missing system condition as unknown without preserving reason', () => {
  const raw = sample('2026-09-02T12:00:00.000Z');
  delete raw.readiness.condition;
  raw.readiness.reason = 'private MAX diagnostic';
  const normalized = normalizeSnapshot(raw);
  const alerts = evaluateAlerts([], normalized).alerts;
  assert.equal(normalized.readiness.condition, 'unknown');
  assert.equal(alerts.queue_backlog_mode.outcome, 'unknown');
  assert.equal(alerts.max_api_mode.outcome, 'unknown');
  assert.equal(alerts.stabilizing_mode.outcome, 'unknown');
  assert.doesNotMatch(JSON.stringify(normalized), /private MAX diagnostic|reason/u);
});

test('raw monitor logs are exclusive, private, and ephemeral by default', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'maxim-monitor-log-root-'));
  const ephemeral = runMonitorLogHarness('', tempRoot);
  assert.equal(ephemeral.status, 0, ephemeral.stderr);
  assert.match(ephemeral.stdout, /mode=600/u);
  const ephemeralPath = /^path=(.+)$/mu.exec(ephemeral.stdout)?.[1];
  assert.ok(ephemeralPath);
  assert.equal(existsSync(ephemeralPath), false);
  assert.deepEqual(readdirSync(tempRoot), []);

  const privateDirectory = mkdtempSync(join(tmpdir(), 'maxim-monitor-log-private-'));
  const retainedPath = join(privateDirectory, 'retained.log');
  const retained = runMonitorLogHarness(retainedPath, tempRoot);
  assert.equal(retained.status, 0, retained.stderr);
  assert.match(retained.stdout, /mode=600/u);
  assert.equal(readFileSync(retainedPath, 'utf8'), 'private monitor line\n');

  const existing = runMonitorLogHarness(retainedPath, tempRoot);
  assert.notEqual(existing.status, 0);
  assert.equal(readFileSync(retainedPath, 'utf8'), 'private monitor line\n');

  const publicDirectory = mkdtempSync(join(tmpdir(), 'maxim-monitor-log-public-'));
  chmodSync(publicDirectory, 0o755);
  const rejectedPath = join(publicDirectory, 'rejected.log');
  const rejected = runMonitorLogHarness(rejectedPath, tempRoot);
  assert.notEqual(rejected.status, 0);
  assert.equal(existsSync(rejectedPath), false);
});

test('capacity scheduler runs independently at a bounded cadence without overlapping itself', () => {
  const harness = [
    'set -euo pipefail',
    'clock=100',
    'CAPACITY_INTERVAL_SEC=15',
    'capacity_samples=0',
    'date() { [[ "$1" == "+%s" ]] && printf "%s\\n" "$clock"; }',
    'sleep() { clock=$((clock + $1)); }',
    'kill() { ((clock < 146)); }',
    'flock() { return 0; }',
    'sample_capacity_once() {',
    '  capacity_samples=$((capacity_samples + 1))',
    '}',
    shellFunction('is_positive_integer'),
    shellFunction('run_capacity_sampler'),
    'run_capacity_sampler 42 146 9',
    'printf "samples=%s clock=%s\\n" "$capacity_samples" "$clock"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', harness], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'samples=4 clock=146\n');
  assert.doesNotMatch(shellFunction('sample_once'), /capacity-observability/u);
  assert.doesNotMatch(shellFunction('run_monitor'), /sample_capacity|capacity-observability/u);
  const wrapper = shellFunction('run_monitor_with_capacity_sampler');
  assert.ok(wrapper.indexOf('start_capacity_sampler') < wrapper.indexOf('start_monitor_worker'));
  assert.ok(wrapper.indexOf('start_monitor_worker') < wrapper.indexOf('wait "$MONITOR_WORKER_PID"'));
});

test('occupied capacity lock fails before the heavy monitor worker starts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-lock-contention-'));
  const harness = [
    'set -euo pipefail',
    'DURATION_SEC=60',
    'ROOT_DIR=/unused',
    'CAPACITY_SAMPLER_PID=""',
    'CAPACITY_SAMPLER_LOCK_FD=""',
    'CAPACITY_SAMPLER_LOCK_FILE="$1"',
    'MONITOR_WORKER_PID=""',
    'worker_started=0',
    'exec {MONITOR_LOCK_FD}>"$2"',
    'exec {held_lock_fd}>>"$CAPACITY_SAMPLER_LOCK_FILE"',
    'flock -n "$held_lock_fd"',
    shellFunction('start_capacity_sampler'),
    shellFunction('stop_capacity_sampler'),
    shellFunction('run_monitor_with_capacity_sampler'),
    'start_monitor_worker() { worker_started=1; }',
    'if run_monitor_with_capacity_sampler; then status=0; else status=$?; fi',
    'printf "status=%s worker=%s\\n" "$status" "$worker_started"',
  ].join('\n');
  const result = spawnSync(
    'bash',
    [
      '-c',
      harness,
      'capacity-lock-harness',
      join(directory, 'capacity.lock'),
      join(directory, 'monitor.lock'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Another capacity sampler already holds/u);
  assert.match(result.stdout, /status=3 worker=0/u);
});

test('failed heavy-worker start reaps the capacity sampler and preserves failure status', () => {
  const harness = [
    'set -euo pipefail',
    'DURATION_SEC=60',
    'CAPACITY_SAMPLER_PID=""',
    'CAPACITY_SAMPLER_LOCK_FD=""',
    'MONITOR_WORKER_PID=""',
    shellFunction('stop_capacity_sampler'),
    shellFunction('run_monitor_with_capacity_sampler'),
    'sampler_file="$1"',
    'start_capacity_sampler() {',
    '  setsid sleep 30 &',
    '  CAPACITY_SAMPLER_PID=$!',
    '  printf "%s\\n" "$CAPACITY_SAMPLER_PID" > "$sampler_file"',
    '}',
    'start_monitor_worker() { return 29; }',
    'if run_monitor_with_capacity_sampler; then status=0; else status=$?; fi',
    'sampler_pid="$(<"$sampler_file")"',
    'printf "status=%s sampler_alive=%s\\n" "$status" "$(kill -0 "$sampler_pid" 2>/dev/null && echo yes || echo no)"',
  ].join('\n');
  const directory = mkdtempSync(join(tmpdir(), 'maxim-worker-start-failure-'));
  const result = spawnSync(
    'bash',
    ['-c', harness, 'worker-start-harness', join(directory, 'sampler.pid')],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'status=29 sampler_alive=no\n');
});

test('capacity sampler cleanup terminates and reaps its isolated process group', () => {
  const harness = [
    'set -euo pipefail',
    'child_file="$1"',
    'CAPACITY_SAMPLER_LOCK_FD=""',
    'setsid bash -c \'sleep 30 & printf "%s\\n" "$!" > "$1"; wait\' sampler "$child_file" &',
    'CAPACITY_SAMPLER_PID=$!',
    'for _ in $(seq 1 100); do [[ -s "$child_file" ]] && break; sleep 0.01; done',
    '[[ -s "$child_file" ]]',
    'sampler_pid="$CAPACITY_SAMPLER_PID"',
    'child_pid="$(<"$child_file")"',
    shellFunction('stop_capacity_sampler'),
    'stop_capacity_sampler',
    '! kill -0 "$sampler_pid" 2>/dev/null',
    '! kill -0 "$child_pid" 2>/dev/null',
  ].join('\n');
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-sampler-stop-'));
  const result = spawnSync('bash', ['-c', harness, 'capacity-stop-harness', join(directory, 'pid')], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('monitor entrypoint composes sampler and ephemeral-log cleanup without losing status', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'maxim-monitor-lifecycle-log-'));
  const processRoot = mkdtempSync(join(tmpdir(), 'maxim-monitor-lifecycle-process-'));
  const { childFile, result, samplerFile } = runMonitorLifecycleHarness(tempRoot, processRoot, 37);
  assert.equal(result.status, 37, result.stderr);
  const ephemeralPath = /^path=(.+)$/mu.exec(result.stdout)?.[1];
  assert.ok(ephemeralPath);
  assert.equal(existsSync(ephemeralPath), false);
  assert.equal(isProcessAlive(Number(readFileSync(samplerFile, 'utf8').trim())), false);
  assert.equal(isProcessAlive(Number(readFileSync(childFile, 'utf8').trim())), false);
  const wrapper = shellFunction('run_monitor_with_capacity_sampler');
  assert.doesNotMatch(wrapper, /trap (cleanup_monitor|stop_capacity_sampler) EXIT/u);
  assert.match(monitorSource, /trap cleanup_monitor EXIT/u);
  assert.match(monitorSource, /start_monitor_output[\s\S]*if run_monitor_with_capacity_sampler/u);
});

test('TERM to only the top-level monitor PID reaps every worker and ephemeral log', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'maxim-monitor-term-fixture-'));
  const scriptsDirectory = join(fixtureRoot, 'infra/scripts');
  const libraryDirectory = join(scriptsDirectory, 'lib');
  const binaryDirectory = join(fixtureRoot, 'bin');
  const processFile = join(fixtureRoot, 'processes.txt');
  const teeFile = join(fixtureRoot, 'tee.pid');
  const monitorLock = join(fixtureRoot, 'monitor.lock');
  mkdirSync(libraryDirectory, { recursive: true });
  mkdirSync(binaryDirectory, { recursive: true });
  writeFileSync(
    join(libraryDirectory, 'deploy-topology.sh'),
    'MAXIM_PRODUCTION_API_SERVICES=("api-ingress")\n',
  );
  writeFileSync(
    join(libraryDirectory, 'deploy-disk-capacity.sh'),
    'MAXIM_API_BUILD_HARD_MIN_FREE_BYTES=21474836480\n',
  );
  writeFileSync(join(scriptsDirectory, 'monitor-capacity-probe.cjs'), '// fixture\n');
  writeFileSync(join(scriptsDirectory, 'monitor-capacity-archive.cjs'), '// fixture\n');
  writeExecutable(join(scriptsDirectory, 'vps-monitor-readonly.sh'), monitorSource);
  writeExecutable(
    join(scriptsDirectory, 'vps-connect.sh'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'sleep 30 &',
      'child_pid=$!',
      'process_group="$(ps -o pgid= -p "$$" | tr -d "[:space:]")"',
      'printf "%s %s %s\\n" "$$" "$child_pid" "$process_group" >> "$MAXIM_TEST_PROCESS_FILE"',
      'wait "$child_pid"',
    ].join('\n'),
  );
  const systemTee = spawnSync('sh', ['-c', 'command -v tee'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(systemTee.startsWith('/'));
  writeExecutable(
    join(binaryDirectory, 'tee'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'printf "%s\\n" "$$" > "$MAXIM_TEST_TEE_FILE"',
      `exec ${systemTee} "$@"`,
    ].join('\n'),
  );

  const environment = {
    ...process.env,
    HOME: fixtureRoot,
    MAXIM_MONITOR_CAPACITY_ARCHIVE_DIR: join(fixtureRoot, 'archive'),
    MAXIM_MONITOR_LOCK_FILE: monitorLock,
    MAXIM_TEST_PROCESS_FILE: processFile,
    MAXIM_TEST_TEE_FILE: teeFile,
    PATH: `${binaryDirectory}:${process.env.PATH}`,
    TMPDIR: fixtureRoot,
    XDG_STATE_HOME: join(fixtureRoot, 'state'),
  };
  delete environment.MAXIM_MONITOR_LOG;
  const monitor = spawn(join(scriptsDirectory, 'vps-monitor-readonly.sh'), ['60', '300'], {
    cwd: fixtureRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  monitor.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  monitor.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  try {
    await waitForCondition(
      () =>
        /^log_file=.+$/mu.test(stdout) &&
        recordedProcesses(processFile).length >= 6 &&
        existsSync(teeFile),
      2_000,
    );
    const startedAt = Date.now();
    monitor.kill('SIGTERM');
    const result = await waitForClose(monitor, 2_000);
    assert.deepEqual(result, { code: 143, signal: null }, stderr);
    assert.ok(Date.now() - startedAt < 2_000, 'top-level TERM must be bounded');
    const ephemeralPath = /^log_file=(.+)$/mu.exec(stdout)?.[1];
    assert.ok(ephemeralPath);
    assert.equal(existsSync(ephemeralPath), false);
    assert.equal(existsSync(dirname(ephemeralPath)), false);
    for (const pid of [...recordedProcesses(processFile), ...recordedProcesses(teeFile)]) {
      assert.equal(isProcessAlive(pid), false, `monitor process ${pid} survived top-level TERM`);
    }
    const lockProbe = spawnSync(
      'bash',
      ['-c', 'exec 9>>"$1"; flock -n 9', 'monitor-lock-probe', monitorLock],
      { encoding: 'utf8' },
    );
    assert.equal(lockProbe.status, 0, lockProbe.stderr);
  } finally {
    if (isProcessAlive(monitor.pid)) monitor.kill('SIGKILL');
    const groups = new Set();
    for (const [index, pid] of recordedProcesses(processFile).entries()) {
      if (index % 3 === 2) groups.add(pid);
    }
    for (const processGroup of groups) {
      try {
        process.kill(-processGroup, 'SIGKILL');
      } catch {
        // The expected path already reaped the group.
      }
    }
    for (const pid of [...recordedProcesses(processFile), ...recordedProcesses(teeFile)]) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // The expected path already reaped the process.
      }
    }
  }
});

test('readonly monitor archives only the allowlisted capacity probe outside raw log capture', () => {
  const monitor = monitorSource;
  const probe = readFileSync(probePath, 'utf8');
  assert.match(monitor, /# shellcheck disable=SC2317,SC2329/u);
  assert.match(monitor, /set -euo pipefail\numask 077/u);
  assert.match(monitor, /run_step capacity-observability summarize_capacity_observability/u);
  assert.match(monitor, /monitor-capacity-probe\.cjs/u);
  assert.match(monitor, /monitor-capacity-archive\.cjs/u);
  assert.match(monitor, /XDG_STATE_HOME/u);
  assert.match(monitor, /\.local\/state/u);
  assert.match(monitor, /retention_days=14/u);
  assert.match(monitor, /MAXIM_MONITOR_CAPACITY_INTERVAL_SEC:-15/u);
  assert.match(monitor, /CAPACITY_INTERVAL_SEC < 15 \|\| CAPACITY_INTERVAL_SEC > 60/u);
  assert.match(monitor, /exec setsid [\s\S]*--internal-capacity-sampler/u);
  assert.match(monitor, /kill -TERM -- "-\$sampler_pid"/u);
  assert.match(monitor, /wait "\$sampler_pid"/u);
  assert.match(monitor, /exec \{MONITOR_LOCK_FD\}>&-/u);
  assert.match(monitor, /flock -n "\$CAPACITY_SAMPLER_LOCK_FD"/u);
  assert.match(monitor, /MAXIM_MONITOR_CAPACITY_ARCHIVE_DIR must be an absolute path/u);
  assert.match(monitor, /\)" \|\| probe_status=\$\?/u);
  assert.match(monitor, /return "\$probe_status"/u);
  assert.match(
    monitor,
    /if ! EPHEMERAL_LOG_DIR="\$\([\s\S]*mktemp -d "\$temp_root\/maxim-vps-readonly-monitor-\$\{UID\}\.XXXXXXXX"/u,
  );
  assert.match(monitor, /MAXIM_MONITOR_LOG parent must be owner-private/u);
  assert.match(monitor, /set -o noclobber/u);
  assert.match(monitor, /tee -a "\/dev\/fd\/\$MONITOR_LOG_FD"/u);
  assert.match(monitor, /unlink -- "\$LOG_FILE"/u);
  assert.doesNotMatch(monitor, /maxim-vps-readonly-monitor-\$\(date/u);
  assert.doesNotMatch(monitor, /scan_service_logs[\s\S]*monitor-capacity-archive/u);
  assert.doesNotMatch(monitor, /\bjq\b/u);
  assert.match(probe, /__filename === '\[stdin\]'/u);
  assert.match(probe, /resolve\(process\.cwd\(\), 'infra\/scripts\/monitor-ready-status\.cjs'\)/u);
});
