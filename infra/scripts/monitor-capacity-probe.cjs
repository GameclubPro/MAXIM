'use strict';

const { spawn } = require('node:child_process');
const { lstatSync, readFileSync, statfsSync } = require('node:fs');
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
const MAX_DOCKER_INSPECT_BYTES = 16 * 1024 * 1024;
const MAX_DOCKER_CONTAINER_COUNT = 128;
const PROCESS_TIMEOUT_MS = 5_000;
const QUEUE_CONTROL_HELPER = 'infra/scripts/webhook-queue-rollout-control.cjs';
const RELEASE_MANIFEST_PATH = resolve(
  process.env.MAXIM_RELEASE_STATE_DIR || '/var/lib/maxim-deploy',
  'current.json',
);
const MAX_RELEASE_MANIFEST_BYTES = 64 * 1024;
const DEFAULT_EXPECTED_API_SERVICES = Object.freeze([
  'api-ingress',
  'api-admin',
  'api-enqueue',
  'api-moderation',
  'api-moderation-critical',
  'api-moderation-join',
  'api-moderation-realtime-b',
  'api-moderation-realtime-c',
  'api-moderation-realtime-d',
  'api-moderation-background',
  'api-media-analysis',
  'api-action',
  'api-publisher',
]);
const HISTORICALLY_OPTIONAL_API_SERVICES = new Set(['api-media-analysis', 'api-publisher']);
const SAFE_IMAGE_REF_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,511}$/u;
const DIGEST_IMAGE_REF_PATTERN = /@sha256:[0-9a-f]{64}$/u;
const FULL_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const RELEASE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const ACTIVE_RELEASE_COMPONENTS = Object.freeze([
  'api-shared',
  'miniapp-major-static',
  'admin-static',
]);
const EXPECTED_APP_ROLE_BY_SERVICE = Object.freeze({
  'api-ingress': 'ingress',
  'api-admin': 'admin',
  'api-enqueue': 'enqueue',
  'api-moderation': 'moderation',
  'api-moderation-critical': 'moderation',
  'api-moderation-join': 'moderation',
  'api-moderation-realtime-b': 'moderation',
  'api-moderation-realtime-c': 'moderation',
  'api-moderation-realtime-d': 'moderation',
  'api-moderation-background': 'moderation',
  'api-media-analysis': 'moderation',
  'api-action': 'action',
  'api-publisher': 'publisher',
});
const API_ROLES = new Set([
  'all',
  'ingress',
  'admin',
  'enqueue',
  'moderation',
  'action',
  'publisher',
]);
const DOCKER_TOKEN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u;
const DOCKER_STATUS_PATTERN = /^(?:created|running|paused|restarting|removing|exited|dead)$/u;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeActionHealth(raw) {
  if (!isRecord(raw)) return null;
  const windowSec = raw.windowSec;
  const total = raw.total;
  const success = raw.success;
  const failure = raw.failure;
  const critical = raw.critical;
  const errorRate = raw.errorRate;
  const criticalRate = raw.criticalRate;
  const integers = [windowSec, total, success, failure, critical];
  if (
    !Number.isSafeInteger(windowSec) ||
    windowSec <= 0 ||
    windowSec > 86_400 ||
    integers.slice(1).some((value) => !Number.isSafeInteger(value) || value < 0) ||
    total !== success + failure ||
    critical > failure ||
    ![errorRate, criticalRate].every(
      (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1,
    )
  ) {
    return null;
  }
  const expectedErrorRate = total === 0 ? 0 : failure / total;
  const expectedCriticalRate = total === 0 ? 0 : critical / total;
  if (
    Math.abs(errorRate - expectedErrorRate) > 1e-9 ||
    Math.abs(criticalRate - expectedCriticalRate) > 1e-9
  ) {
    return null;
  }
  return { windowSec, total, success, failure, critical, errorRate, criticalRate };
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
    action: normalizeActionHealth(systemMode.action),
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

function normalizeExpectedApiServices(values) {
  const requiredServices = DEFAULT_EXPECTED_API_SERVICES.filter(
    (service) => !HISTORICALLY_OPTIONAL_API_SERVICES.has(service),
  );
  if (
    !Array.isArray(values) ||
    values.length < requiredServices.length ||
    values.length > DEFAULT_EXPECTED_API_SERVICES.length ||
    new Set(values).size !== values.length ||
    values.some(
      (value) => typeof value !== 'string' || !DEFAULT_EXPECTED_API_SERVICES.includes(value),
    ) ||
    requiredServices.some((service) => !values.includes(service))
  ) {
    throw new Error('Expected API service topology is invalid.');
  }
  return [...values];
}

function isSupportedApiImageRef(imageRef, sourceSha) {
  return (
    typeof imageRef === 'string' &&
    SAFE_IMAGE_REF_PATTERN.test(imageRef) &&
    (DIGEST_IMAGE_REF_PATTERN.test(imageRef) ||
      imageRef.endsWith(`:${sourceSha}`) ||
      imageRef.endsWith(`:runtime-rollback-${sourceSha}`))
  );
}

function readExpectedApiImage(path = RELEASE_MANIFEST_PATH) {
  const stats = lstatSync(path);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size <= 0 ||
    stats.size > MAX_RELEASE_MANIFEST_BYTES
  ) {
    throw new Error('Current release manifest is unavailable or unsafe.');
  }
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const componentEntries = isRecord(manifest?.components)
    ? Object.entries(manifest.components)
    : [];
  if (
    manifest?.schemaVersion !== 1 ||
    !RELEASE_ID_PATTERN.test(manifest?.releaseId ?? '') ||
    !FULL_SHA_PATTERN.test(manifest?.targetSha ?? '') ||
    componentEntries.length !== ACTIVE_RELEASE_COMPONENTS.length ||
    componentEntries.some(
      ([id, component]) =>
        !ACTIVE_RELEASE_COMPONENTS.includes(id) ||
        !isRecord(component) ||
        !FULL_SHA_PATTERN.test(component.sourceSha ?? '') ||
        !SAFE_IMAGE_REF_PATTERN.test(component.imageRef ?? '') ||
        !IMAGE_ID_PATTERN.test(component.imageId ?? ''),
    ) ||
    ACTIVE_RELEASE_COMPONENTS.some((id) => !Object.hasOwn(manifest.components, id))
  ) {
    throw new Error('Current release manifest is incomplete or invalid.');
  }
  const component = manifest?.components?.['api-shared'];
  const sourceSha = component?.sourceSha;
  const imageRef = component?.imageRef;
  const imageId = component?.imageId;
  if (
    typeof sourceSha !== 'string' ||
    !FULL_SHA_PATTERN.test(sourceSha) ||
    !isSupportedApiImageRef(imageRef, sourceSha) ||
    typeof imageId !== 'string' ||
    !IMAGE_ID_PATTERN.test(imageId)
  ) {
    throw new Error('Current release API image identity is invalid.');
  }
  return { imageId, imageRef, sourceSha };
}

function resolveExpectedApiServicesFromCompose(expectedServices, composeSource) {
  const expected = normalizeExpectedApiServices(expectedServices);
  if (
    typeof composeSource !== 'string' ||
    Buffer.byteLength(composeSource) > MAX_PROCESS_OUTPUT_BYTES
  ) {
    throw new Error('API source Compose topology is unavailable or oversized.');
  }
  const present = [];
  for (const service of expected) {
    const matches = composeSource.match(new RegExp(`^  ${service}:\\s*$`, 'gmu')) ?? [];
    if (matches.length > 1) throw new Error('API source Compose topology is ambiguous.');
    if (matches.length === 1) {
      present.push(service);
    } else if (!HISTORICALLY_OPTIONAL_API_SERVICES.has(service)) {
      throw new Error('API source Compose topology is missing a required role.');
    }
  }
  return normalizeExpectedApiServices(present);
}

function readOptionalDockerToken(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !DOCKER_TOKEN_PATTERN.test(value)) {
    throw new Error('Docker returned an invalid label token.');
  }
  return value;
}

function parseApiIdentityEnvironment(raw) {
  if (!Array.isArray(raw)) {
    return {
      appRole: null,
      appServiceName: null,
      commercialOcrVersionPresent: false,
      identityInvalid: true,
    };
  }
  const selected = new Map();
  let identityInvalid = false;
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const separator = entry.indexOf('=');
    if (separator < 1) continue;
    const key = entry.slice(0, separator);
    if (!['APP_ROLE', 'APP_SERVICE_NAME', 'COMMERCIAL_OCR_VERSION'].includes(key)) continue;
    if (selected.has(key)) identityInvalid = true;
    selected.set(key, entry.slice(separator + 1));
  }
  const appRoleRaw = selected.get('APP_ROLE');
  const appServiceNameRaw = selected.get('APP_SERVICE_NAME');
  const appRole = typeof appRoleRaw === 'string' && API_ROLES.has(appRoleRaw) ? appRoleRaw : null;
  const appServiceName =
    typeof appServiceNameRaw === 'string' && DOCKER_TOKEN_PATTERN.test(appServiceNameRaw)
      ? appServiceNameRaw
      : null;
  if (
    (selected.has('APP_ROLE') && appRole === null) ||
    (selected.has('APP_SERVICE_NAME') && appServiceName === null)
  ) {
    identityInvalid = true;
  }
  return {
    appRole,
    appServiceName,
    commercialOcrVersionPresent: Boolean(selected.get('COMMERCIAL_OCR_VERSION')),
    identityInvalid,
  };
}

function parseApiFleetInspection(raw) {
  // FLAG: Docker inspection contains secret-bearing env; retain only fixed identity signals in memory.
  if (typeof raw !== 'string' || Buffer.byteLength(raw) === 0) return [];
  if (Buffer.byteLength(raw) > MAX_DOCKER_INSPECT_BYTES) {
    throw new Error('Docker API fleet inspection is oversized.');
  }
  const inspection = JSON.parse(raw);
  if (!Array.isArray(inspection) || inspection.length > MAX_DOCKER_CONTAINER_COUNT) {
    throw new Error('Docker returned an invalid API fleet inspection.');
  }
  return inspection.map((container) => {
    const config = isRecord(container?.Config) ? container.Config : {};
    const labels = isRecord(config.Labels) ? config.Labels : {};
    const state = isRecord(container?.State) ? container.State : {};
    const id = container?.Id;
    const imageId = container?.Image;
    const imageRef = config.Image;
    const name = container?.Name;
    const restartCount = container?.RestartCount;
    const identity = parseApiIdentityEnvironment(config.Env);
    if (
      typeof id !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(id) ||
      typeof imageId !== 'string' ||
      !IMAGE_ID_PATTERN.test(imageId) ||
      typeof imageRef !== 'string' ||
      !SAFE_IMAGE_REF_PATTERN.test(imageRef) ||
      typeof name !== 'string' ||
      !/^\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/u.test(name) ||
      typeof state.Running !== 'boolean' ||
      typeof state.Status !== 'string' ||
      !DOCKER_STATUS_PATTERN.test(state.Status) ||
      !Number.isSafeInteger(restartCount) ||
      restartCount < 0
    ) {
      throw new Error('Docker returned invalid API fleet metadata.');
    }
    return {
      id,
      project: readOptionalDockerToken(labels['com.docker.compose.project']),
      service: readOptionalDockerToken(labels['com.docker.compose.service']),
      name,
      imageId,
      imageRef,
      running: state.Running,
      status: state.Status,
      restartCount,
      releaseProtected: labels['com.maxim.release-protected'] === 'true',
      ...identity,
    };
  });
}

function isApiLikeService(value) {
  return typeof value === 'string' && /^api(?:-|$)/u.test(value);
}

function isApiLikeContainerName(value) {
  return typeof value === 'string' && /(?:^|[-_])api(?:[-_]|$)/u.test(value.slice(1));
}

function isExpectedComposeServiceContainerName(value, service) {
  return (
    value === `/infra-${service}-1` ||
    value === `/infra_${service}_1` ||
    new RegExp(`^/infra(?:-|_)${service}(?:-|_)[1-9]\\d*$`, 'u').test(value)
  );
}

function isExpectedProjectApiContainerName(value) {
  if (typeof value !== 'string') return false;
  return ['api', ...DEFAULT_EXPECTED_API_SERVICES].some((service) =>
    isExpectedComposeServiceContainerName(value, service),
  );
}

function isApiFleetCandidate(container, expectedImage) {
  const apiLikeService = isApiLikeService(container.service);
  const apiLikeAppService = isApiLikeService(container.appServiceName);
  const apiLikeName = isApiLikeContainerName(container.name);
  const appRoleSignal = API_ROLES.has(container.appRole);
  const expectedServiceSignal = DEFAULT_EXPECTED_API_SERVICES.includes(container.service);
  const expectedAppServiceSignal = DEFAULT_EXPECTED_API_SERVICES.includes(container.appServiceName);
  const imageMatches = container.imageId === expectedImage.imageId;
  const maximImageRef = /(?:^|\/)maxim-api(?::|@)/u.test(container.imageRef);
  const ownedName = isExpectedProjectApiContainerName(container.name);
  const protectedApiSignal =
    container.releaseProtected &&
    (apiLikeService ||
      apiLikeAppService ||
      apiLikeName ||
      appRoleSignal ||
      expectedServiceSignal ||
      expectedAppServiceSignal ||
      imageMatches ||
      maximImageRef ||
      ownedName);
  const maximSpecificSignal =
    expectedServiceSignal ||
    expectedAppServiceSignal ||
    container.commercialOcrVersionPresent ||
    protectedApiSignal ||
    imageMatches ||
    maximImageRef ||
    ownedName;
  return (
    (['infra', 'infra-scale'].includes(container.project) &&
      (apiLikeService || appRoleSignal || maximSpecificSignal)) ||
    maximSpecificSignal ||
    (apiLikeService && appRoleSignal)
  );
}

function summarizeApiFleet(expectedServices, expectedImage, containers) {
  const expected = normalizeExpectedApiServices(expectedServices);
  if (
    !isRecord(expectedImage) ||
    typeof expectedImage.sourceSha !== 'string' ||
    !FULL_SHA_PATTERN.test(expectedImage.sourceSha) ||
    !isSupportedApiImageRef(expectedImage.imageRef, expectedImage.sourceSha) ||
    !IMAGE_ID_PATTERN.test(expectedImage.imageId ?? '')
  ) {
    throw new Error('Expected API image is invalid.');
  }
  const expectedSet = new Set(expected);
  const byService = new Map(expected.map((service) => [service, []]));
  let unexpectedApiContainerCount = 0;
  let unexpectedMainContainerCount = 0;
  let unexpectedScaleContainerCount = 0;
  let unexpectedManualContainerCount = 0;
  for (const container of containers) {
    if (
      !isRecord(container) ||
      (container.project !== null && typeof container.project !== 'string') ||
      (container.service !== null && typeof container.service !== 'string')
    ) {
      throw new Error('API fleet container metadata is invalid.');
    }
    if (container.project === 'infra' && expectedSet.has(container.service)) {
      byService.get(container.service).push(container);
    } else if (isApiFleetCandidate(container, expectedImage)) {
      unexpectedApiContainerCount += 1;
      if (container.project === 'infra') {
        unexpectedMainContainerCount += 1;
      } else if (container.project === 'infra-scale') {
        unexpectedScaleContainerCount += 1;
      } else {
        unexpectedManualContainerCount += 1;
      }
    }
  }

  let observedRoleCount = 0;
  let singletonRoleCount = 0;
  let runningRoleCount = 0;
  let identityRoleCount = 0;
  let exactImageRoleCount = 0;
  let duplicateContainerCount = 0;
  let totalRestartCount = 0;
  for (const service of expected) {
    const matches = byService.get(service);
    if (matches.length > 0) observedRoleCount += 1;
    duplicateContainerCount += Math.max(0, matches.length - 1);
    totalRestartCount += matches.reduce((sum, container) => sum + container.restartCount, 0);
    if (matches.length !== 1) continue;
    singletonRoleCount += 1;
    const container = matches[0];
    if (container.running === true && container.status === 'running') runningRoleCount += 1;
    if (
      container.identityInvalid === false &&
      container.appServiceName === service &&
      container.appRole === EXPECTED_APP_ROLE_BY_SERVICE[service] &&
      container.releaseProtected === true &&
      isExpectedComposeServiceContainerName(container.name, service)
    ) {
      identityRoleCount += 1;
    }
    if (
      container.imageId === expectedImage.imageId &&
      container.imageRef === expectedImage.imageRef
    ) {
      exactImageRoleCount += 1;
    }
  }

  return {
    available: true,
    expectedRoleCount: expected.length,
    observedRoleCount,
    singletonRoleCount,
    runningRoleCount,
    identityRoleCount,
    exactImageRoleCount,
    duplicateContainerCount,
    unexpectedApiContainerCount,
    unexpectedMainContainerCount,
    unexpectedScaleContainerCount,
    unexpectedManualContainerCount,
    totalRestartCount,
  };
}

async function probeApiFleet(expectedServices, options = {}) {
  try {
    const currentExpected = normalizeExpectedApiServices(expectedServices);
    const expectedImage = options.expectedImage ?? readExpectedApiImage(options.manifestPath);
    const run = options.runBounded ?? runBounded;
    const sourceCompose = await run('git', [
      'show',
      `${expectedImage.sourceSha}:infra/docker-compose.yml`,
    ]);
    if (!sourceCompose.ok) return { available: false };
    const expected = resolveExpectedApiServicesFromCompose(currentExpected, sourceCompose.output);
    const list = await run('docker', ['ps', '-a', '--no-trunc', '--format', '{{.ID}}']);
    if (!list.ok) return { available: false };
    const ids = list.output.trim() ? list.output.trim().split(/\s+/u) : [];
    if (
      ids.length > MAX_DOCKER_CONTAINER_COUNT ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !/^[0-9a-f]{64}$/u.test(id))
    ) {
      return { available: false };
    }
    if (ids.length === 0) return summarizeApiFleet(expected, expectedImage, []);
    const inspection = await run('docker', ['inspect', ...ids], {
      maxOutputBytes: MAX_DOCKER_INSPECT_BYTES,
    });
    if (!inspection.ok) return { available: false };
    const containers = parseApiFleetInspection(inspection.output);
    const inspectedIds = containers.map((container) => container.id);
    if (
      inspectedIds.length !== ids.length ||
      new Set(inspectedIds).size !== inspectedIds.length ||
      inspectedIds.some((id) => !ids.includes(id))
    ) {
      return { available: false };
    }
    return summarizeApiFleet(expected, expectedImage, containers);
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
  const expectedApiServices = normalizeExpectedApiServices(
    options.expectedApiServices ?? DEFAULT_EXPECTED_API_SERVICES,
  );
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
    probeApiFleet(expectedApiServices),
  ]);
  await wait(sampleMs);
  const after = readHostCounters(device);
  const elapsedMs = performance.now() - startedAt;
  const [ingressProbe, adminProbe, queueFence, apiFleet] = await probesPromise;
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
    apiFleet,
  };
}

module.exports = {
  DEFAULT_BLOCK_DEVICE,
  DEFAULT_DISK_PATH,
  DEFAULT_EXPECTED_API_SERVICES,
  calculateCounterRates,
  collectCapacitySnapshot,
  normalizeActionHealth,
  normalizeQueueFence,
  normalizeReadyProbe,
  parseApiFleetInspection,
  parseDiskstats,
  parseMeminfo,
  parseProcStat,
  parseVmstat,
  probeApiFleet,
  readExpectedApiImage,
  resolveExpectedApiServicesFromCompose,
  summarizeApiFleet,
};

if (require.main === module || __filename === '[stdin]') {
  void collectCapacitySnapshot({
    device: process.argv[2],
    expectedApiServices:
      process.argv.length > 3 ? process.argv.slice(3) : DEFAULT_EXPECTED_API_SERVICES,
  })
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
