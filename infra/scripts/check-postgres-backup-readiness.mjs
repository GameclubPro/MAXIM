import { pathToFileURL } from 'node:url';

export function inspectBackupReadiness(snapshot, curlExitCode = 0) {
  const queue = snapshot?.checks?.queueLag;
  const failures = [];
  if (curlExitCode !== 0) failures.push('http_or_transport');
  if (snapshot?.ok !== true) failures.push('readiness');
  if (snapshot?.checks?.database !== true) failures.push('database');
  if (snapshot?.checks?.redis !== true) failures.push('redis');
  if (queue?.rawOk !== true) failures.push('raw_queue_lag');
  if (queue?.softWarning === true) failures.push('queue_soft_warning');
  const scalar = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  // FLAG: Emit only fixed diagnostic fields. The health response can contain private
  // event identities and free-form detail; never print it or use diagnostics as authority.
  return {
    metric: 'backup_readiness_v1',
    ok: failures.length === 0,
    observedAt: new Date().toISOString(),
    failures,
    effectiveLagSec: scalar(queue?.effectiveLagSec),
    oldestReceivedLagSec: scalar(queue?.oldestReceivedLagSec),
    oldestQueuedLagSec: scalar(queue?.oldestQueuedLagSec),
    thresholdSec: scalar(queue?.thresholdSec),
    breachDurationSec: scalar(queue?.breachDurationSec),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const code = process.argv[2];
  if (process.argv.length !== 3 || !/^(0|[1-9][0-9]{0,2})$/.test(code ?? '')) {
    throw new Error('Expected only the curl exit status.');
  }
  let raw = '';
  let bytes = 0;
  let tooLarge = false;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 65_536) {
      tooLarge = true;
      break;
    }
    raw += chunk.toString();
  }
  let snapshot;
  let invalidJson = false;
  if (!tooLarge) {
    try {
      snapshot = JSON.parse(raw);
    } catch {
      invalidJson = true;
    }
  }
  const report = inspectBackupReadiness(snapshot, Number(code));
  if (tooLarge || invalidJson) {
    report.ok = false;
    report.failures.unshift(tooLarge ? 'response_too_large' : 'invalid_json');
  }
  if (!report.ok) {
    process.stderr.write(JSON.stringify(report) + '\n');
    process.exitCode = 1;
  }
}
