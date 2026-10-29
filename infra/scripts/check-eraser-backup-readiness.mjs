import { pathToFileURL } from 'node:url';

export function eraserBackupReady(status, value) {
  return (
    status === 200 &&
    value?.service === 'eraser' &&
    value.status === 'ok' &&
    value.schedulerHealthy === true &&
    /^[a-f0-9]{40}$/.test(value.commitSha ?? '') &&
    typeof value.enabled === 'boolean' &&
    (!value.enabled ||
      (value.workers?.cleanup?.healthy === true && value.workers?.connection?.healthy === true))
  );
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.length !== 2) throw new Error('No endpoint overrides are accepted.');
  let ok = false;
  try {
    const response = await fetch('http://127.0.0.1:3005/health', {
      signal: AbortSignal.timeout(5000),
    });
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 65536) {
        await reader.cancel();
        throw new Error('Response cap');
      }
      chunks.push(value);
    }
    ok = eraserBackupReady(response.status, JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    /* Only fixed failure metadata leaves the local readiness probe. */
  }
  if (!ok) {
    process.stderr.write('eraser_backup_readiness_unavailable\n');
    process.exitCode = 1;
  }
}
