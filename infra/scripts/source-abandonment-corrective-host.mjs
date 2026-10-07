import { pathToFileURL } from 'node:url';
import { runLegacyColdHost } from './legacy-cold-host.mjs';
import { parseSourceAbandonmentHostRequest } from './source-abandonment-host.mjs';

export function parseSourceAbandonmentCorrectiveHostRequest(text) {
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error('corrective_request_budget');
  const value = JSON.parse(text);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'controllerSha,runtimeRequest,version' ||
    value.version !== 1 ||
    !/^[0-9a-f]{40}$/u.test(value.controllerSha ?? '') ||
    !['apply', 'reconcile', 'retry-preview', 'refreeze-preview'].includes(
      value.runtimeRequest?.operation,
    )
  )
    throw new Error('corrective_continuation_required');
  const refreeze = value.runtimeRequest.operation === 'refreeze-preview';
  const runtimeRequest = parseSourceAbandonmentHostRequest(
    JSON.stringify(
      refreeze ? { ...value.runtimeRequest, operation: 'apply' } : value.runtimeRequest,
    ),
  );
  if (refreeze) runtimeRequest.operation = 'refreeze-preview';
  if (value.controllerSha === runtimeRequest.targetSha)
    throw new Error('separate_controller_identity_required');
  return { version: 1, controllerSha: value.controllerSha, runtimeRequest };
}

export async function runSourceAbandonmentCorrectiveHost(envelope) {
  const { controllerSha, runtimeRequest } = parseSourceAbandonmentCorrectiveHostRequest(
    JSON.stringify(envelope),
  );
  const result = await runLegacyColdHost(runtimeRequest, {
    protocol: 'source-abandonment-v1',
    controllerSha,
  });
  return { version: 1, controllerSha, runtimeSha: runtimeRequest.targetSha, result };
}

async function main() {
  let text = '';
  const timer = setTimeout(() => process.stdin.destroy(new Error('stdin_deadline')), 5_000);
  try {
    if (process.argv.length !== 2) throw new Error('stdin_only');
    for await (const part of process.stdin) {
      text += part;
      if (Buffer.byteLength(text) > 64 * 1024) throw new Error('stdin_budget');
    }
    clearTimeout(timer);
    const result = await runSourceAbandonmentCorrectiveHost(
      parseSourceAbandonmentCorrectiveHostRequest(text),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.result.decision === 'DENY') process.exitCode = 1;
  } catch {
    process.stderr.write(
      'Corrective source abandonment refused; inspect its private controller receipt and durable journal.\n',
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
