import { execFile } from 'node:child_process';

const probeUrls = [
  'http://127.0.0.1:3001/api/health/ready',
  'http://127.0.0.1:3002/api/health/ready',
];
const probeOptions = {
  encoding: 'utf8',
  timeout: 3_000,
  maxBuffer: 256 * 1024,
  killSignal: 'SIGKILL',
};
const maximumAgeMs = 30_000;
const maximumFutureMs = 5_000;
const admissionLagSec = 10;
const sustainedLagSec = 30;
const severeLagSec = 120;
const sustainedDurationMs = 90_000;

function runProbe(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, options, (error, stdout) =>
      error ? reject(error) : resolve({ stdout }),
    );
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
}

function fail(code) {
  throw new Error(`MULTIBOT_PREPARE_RUNTIME_${code}`);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function timestamp(value) {
  if (typeof value !== 'string') fail('INVALID');
  const ms = Date.parse(value);
  if (!Number.isSafeInteger(ms) || new Date(ms).toISOString() !== value) fail('INVALID');
  return ms;
}

function validateProbe(value, nowMs) {
  if (!record(value) || ![200, 503].includes(value.status) || !record(value.body)) fail('INVALID');
  const body = value.body;
  const checks = body.checks;
  const queue = checks?.queueLag;
  if (
    typeof body.ok !== 'boolean' ||
    (value.status === 200) !== body.ok ||
    !record(checks) ||
    !record(queue) ||
    typeof checks.database !== 'boolean' ||
    typeof checks.redis !== 'boolean' ||
    typeof queue.ok !== 'boolean' ||
    typeof queue.rawOk !== 'boolean' ||
    typeof queue.softWarning !== 'boolean' ||
    typeof queue.effectiveLagSec !== 'number' ||
    !Number.isFinite(queue.effectiveLagSec) ||
    queue.effectiveLagSec < 0 ||
    ![null, 'queue-lag-hysteresis', 'stale-ready-fallback'].includes(queue.softWarningCode) ||
    queue.softWarning !== (queue.softWarningCode !== null) ||
    (queue.rawOk && !queue.ok) ||
    Object.keys(checks).some((key) => !['database', 'redis', 'queueLag', 'ocr'].includes(key))
  )
    fail('INVALID');
  const atMs = timestamp(body.timestamp);
  const sampleMs = timestamp(queue.sampleGeneratedAt);
  if (
    queue.softWarningCode === 'stale-ready-fallback' ||
    [atMs, sampleMs].some((ms) => nowMs - ms > maximumAgeMs || ms - nowMs > maximumFutureMs) ||
    sampleMs - atMs > maximumFutureMs
  )
    fail('STALE');
  if (
    checks.database !== true ||
    checks.redis !== true ||
    (checks.ocr !== undefined && (!record(checks.ocr) || checks.ocr.ready !== true)) ||
    body.ok !== queue.ok
  )
    fail('NOT_READY');
  return { ready: body.ok, lagSec: queue.effectiveLagSec, sampleMs };
}

// FLAG: Read only two fixed local readiness endpoints; HTTP 503 is retained for queue-only pressure.
// The returned envelope can be passed directly to createMultibotRuntimeGuard.
export async function readMultibotRuntimePressure({ run = runProbe, now = Date.now } = {}) {
  const results = await Promise.allSettled(
    probeUrls.map((url) =>
      run(
        'curl',
        [
          '--disable',
          '--silent',
          '--show-error',
          '--noproxy',
          '*',
          '--connect-timeout',
          '1',
          '--max-time',
          '2',
          '--write-out',
          '\n%{http_code}',
          url,
        ],
        probeOptions,
      ),
    ),
  );
  if (results.some((result) => result.status !== 'fulfilled')) fail('UNAVAILABLE');
  const probes = results.map((result) => {
    const output = result.value?.stdout;
    if (typeof output !== 'string') fail('INVALID');
    const delimiter = output.lastIndexOf('\n');
    const statusText = output.slice(delimiter + 1);
    if (delimiter < 0 || !/^(200|503)$/u.test(statusText)) fail('INVALID');
    let body;
    try {
      body = JSON.parse(output.slice(0, delimiter));
    } catch {
      fail('INVALID');
    }
    return { status: Number(statusText), body };
  });
  const checkedAtMs = now();
  if (!Number.isSafeInteger(checkedAtMs)) fail('CLOCK_INVALID');
  for (const probe of probes) validateProbe(probe, checkedAtMs);
  return { checkedAtMs, ingress: probes[0], admin: probes[1] };
}

// FLAG: admit/finish require both fresh ready endpoints and lag <=10s. observe tolerates
// queue-only failure, aborting >120s immediately or >30s continuously for 90s.
export function createMultibotRuntimeGuard({ now = Date.now } = {}) {
  let breachStartedAtMs = null;
  let previousAtMs = null;
  const previousSamples = new Map();
  function check(snapshot, phase) {
    const atMs = now();
    if (!Number.isSafeInteger(atMs) || (previousAtMs !== null && atMs < previousAtMs))
      fail('CLOCK_INVALID');
    if (!record(snapshot) || !Number.isSafeInteger(snapshot.checkedAtMs)) fail('INVALID');
    if (atMs - snapshot.checkedAtMs > maximumAgeMs || snapshot.checkedAtMs - atMs > maximumFutureMs)
      fail('STALE');
    const probes = ['ingress', 'admin'].map((name) => {
      const probe = validateProbe(snapshot[name], atMs);
      const previous = previousSamples.get(name);
      if (previous && probe.sampleMs < previous.sampleMs) fail('STALE');
      if (previous && probe.sampleMs === previous.sampleMs && probe.lagSec !== previous.lagSec)
        fail('INVALID');
      return { name, ...probe };
    });
    previousAtMs = atMs;
    for (const probe of probes) previousSamples.set(probe.name, probe);
    const lagSec = Math.max(...probes.map((probe) => probe.lagSec));
    if (phase !== 'work') {
      if (probes.some((probe) => !probe.ready) || lagSec > admissionLagSec)
        fail(phase === 'admission' ? 'ADMISSION_BLOCKED' : 'FINAL_BLOCKED');
      breachStartedAtMs = null;
    } else {
      if (lagSec > severeLagSec) fail('QUEUE_LAG');
      if (lagSec > sustainedLagSec) {
        breachStartedAtMs ??= atMs;
        if (atMs - breachStartedAtMs >= sustainedDurationMs) fail('QUEUE_LAG');
      } else breachStartedAtMs = null;
    }
    return { lagSec, ready: probes.every((probe) => probe.ready), breachStartedAtMs };
  }
  return {
    admit: (snapshot) => check(snapshot, 'admission'),
    observe: (snapshot) => check(snapshot, 'work'),
    finish: (snapshot) => check(snapshot, 'final'),
  };
}
