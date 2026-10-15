import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { inspectBackupReadiness } from './check-postgres-backup-readiness.mjs';

const RESPONSE_LIMIT = 65_536;
// FLAG: Ordinary readiness caches its response for two seconds. Wait past that
// boundary once, inside the original probe deadline; never accept the fallback.
const REFRESH_WAIT_MS = 2_250;

function parseResponse(response) {
  let snapshot;
  let invalid = false;
  const oversized = Buffer.byteLength(response.body ?? '') > RESPONSE_LIMIT;
  if (!oversized) {
    try {
      snapshot = JSON.parse(response.body);
    } catch {
      invalid = true;
    }
  }
  const report = inspectBackupReadiness(snapshot, response.exitCode);
  if (invalid || oversized) {
    report.ok = false;
    report.failures.unshift(oversized ? 'response_too_large' : 'invalid_json');
  }
  return { snapshot, report };
}

function sampleTime(snapshot) {
  const raw = snapshot?.checks?.queueLag?.sampleGeneratedAt;
  return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(raw)
    ? Date.parse(raw)
    : NaN;
}

function mayObserveRefresh({ snapshot, report }, nowMs) {
  const queue = snapshot?.checks?.queueLag;
  const age = nowMs - sampleTime(snapshot);
  return (
    report.failures.length === 1 &&
    report.failures[0] === 'queue_soft_warning' &&
    queue?.softWarningCode === 'stale-ready-fallback' &&
    Number.isFinite(age) &&
    age >= 0 &&
    age <= 30_000 &&
    typeof queue.thresholdSec === 'number' &&
    Number.isFinite(queue.thresholdSec) &&
    queue.thresholdSec > 0 &&
    ['effectiveLagSec', 'oldestReceivedLagSec', 'oldestQueuedLagSec'].every(
      (field) =>
        typeof queue[field] === 'number' &&
        Number.isFinite(queue[field]) &&
        queue[field] >= 0 &&
        queue[field] <= queue.thresholdSec,
    )
  );
}

export async function probeBackupReadiness({
  request,
  timeoutMs,
  now = Date.now,
  wait = delay,
  emit = (report) => process.stderr.write(`${JSON.stringify(report)}\n`),
}) {
  const deadline = now() + timeoutMs;
  const first = parseResponse(await request(Math.max(1, deadline - now())));
  if (first.report.ok && now() <= deadline) return true;
  if (first.report.ok) {
    first.report.ok = false;
    first.report.failures.push('probe_deadline');
  }
  emit(first.report);
  if (!mayObserveRefresh(first, now()) || deadline - now() < REFRESH_WAIT_MS + 250) return false;

  await wait(REFRESH_WAIT_MS);
  if (deadline - now() < 250) return false;
  const next = parseResponse(await request(deadline - now()));
  // FLAG: A strict successful response must contain a newer non-future sample.
  // Neither clearing the warning nor replaying a cached JSON body proves refresh.
  const refreshedAt = sampleTime(next.snapshot);
  if (
    next.report.ok &&
    (!Number.isFinite(refreshedAt) ||
      refreshedAt <= sampleTime(first.snapshot) ||
      refreshedAt > now() ||
      now() - refreshedAt > 5_000 ||
      now() > deadline)
  ) {
    next.report.ok = false;
    next.report.failures.push('refresh_not_observed_within_deadline');
  }
  if (!next.report.ok) {
    emit(next.report);
    return false;
  }
  emit({
    metric: 'backup_readiness_refresh_v1',
    ok: true,
    observedAt: new Date(now()).toISOString(),
    sampleAgeMs: now() - refreshedAt,
    probes: 2,
  });
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [url, seconds, ...extra] = process.argv.slice(2);
  if (
    extra.length ||
    !/^https?:\/\/[^\r\n]+$/u.test(url ?? '') ||
    !/^([1-9]|[1-5][0-9]|60)$/u.test(seconds ?? '')
  )
    throw new Error('Expected readiness URL and original timeout seconds (1-60).');
  const ok = await probeBackupReadiness({
    timeoutMs: Number(seconds) * 1_000,
    request: (remainingMs) => {
      const result = spawnSync(
        'curl',
        ['--fail-with-body', '-sS', '--max-time', String(remainingMs / 1_000), url],
        { encoding: 'utf8', maxBuffer: RESPONSE_LIMIT, timeout: remainingMs },
      );
      // Never emit curl stderr or the readiness body: both may contain private data.
      return { exitCode: result.status ?? 1, body: result.stdout ?? '' };
    },
  });
  process.exitCode = ok ? 0 : 1;
}
