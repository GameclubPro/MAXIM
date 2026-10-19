import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createLegacyColdRuntime } from './legacy-cold-runtime.mjs';
import { readLegacyColdStoreConnection } from './legacy-cold-host.mjs';
import {
  assertInheritedDeployLock,
  assertNoActiveLegacyColdMaintenance,
} from './legacy-cold-journal.mjs';
import {
  readBacklogCancellation,
  readBacklogCancellationForRequest,
  writeBacklogCancellation,
} from './backlog-cancellation-journal.mjs';
import {
  parseNominationV2,
  parseApplyV2,
  runPreviewHostV2,
  runApplyHostV2,
} from './backlog-cancellation-v2-host.mjs';

const directory = '/var/lib/maxim-deploy';
const execute = (args, options = {}) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();

export function readBacklogCancellationInput(fd = 0) {
  const bytes = Buffer.alloc(16 * 1024 + 1);
  let length = 0;
  while (length < bytes.length) {
    const count = readSync(fd, bytes, length, bytes.length - length, null);
    if (!count) break;
    length += count;
  }
  if (!length || length === bytes.length) throw new Error('Cancellation input exceeds its bound');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    bytes.subarray(0, length),
  );
}
export function parseBacklogCancellationRequest(raw) {
  if (Buffer.byteLength(raw) > 4096) throw new Error('Cancellation request too large');
  const request = JSON.parse(raw);
  if (
    Object.keys(request).sort().join(',') !== 'cutoff,id,imageId,sourceSha' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(request.id) ||
    !/^[a-f0-9]{40}$/.test(request.sourceSha) ||
    !/^sha256:[a-f0-9]{64}$/.test(request.imageId) ||
    !Number.isFinite(Date.parse(request.cutoff)) ||
    Date.parse(request.cutoff) >= Date.now() ||
    new Date(request.cutoff).toISOString() !== request.cutoff
  )
    throw new Error('Invalid cancellation request');
  return request;
}

export async function runBacklogCancellationHost(request, pendingOnly = false) {
  // FLAG: The legacy continuation captures global history and cannot accept an exact v2 scope.
  if (request?.version === 2) throw new Error('Version 2 requires the scoped controller');
  assertInheritedDeployLock();
  if (process.env.MAXIM_EXPECTED_DEPLOY_SHA !== request.sourceSha)
    throw new Error('Cancellation source mismatch');
  assertNoActiveLegacyColdMaintenance(directory, request.id);
  const previous = pendingOnly
    ? readBacklogCancellation(directory)
    : readBacklogCancellationForRequest(directory, request);
  if (pendingOnly && (!previous || previous.phase !== 'STOPPED'))
    throw new Error('Pending continuation requires the existing stopped operation');
  if (previous && JSON.stringify(previous.request) !== JSON.stringify(request))
    throw new Error('Use the existing immutable cancellation request');
  if (previous?.phase === 'COMPLETE') {
    console.log(JSON.stringify({ phase: 'COMPLETE', resumed: true }));
    return;
  }
  const runtime = createLegacyColdRuntime({
    bindings: {
      targetSha: request.sourceSha,
      targetImageId: request.imageId,
      controllerNonce: request.id,
      selectionDigest: request.id,
    },
    baseline: previous?.baseline ?? null,
  });
  const baseline = previous?.baseline ?? runtime.inspectRuntime();
  const connection = readLegacyColdStoreConnection(baseline);
  const privateDirectory = join(directory, `backlog-cancellation-${request.id}`);
  mkdirSync(privateDirectory, { mode: 0o700, recursive: true });
  const environmentFile = join(privateDirectory, 'stores.env');
  const fd = openSync(
    environmentFile,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, connection.environment);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  let state = previous ?? { version: 1, phase: 'PREPARED', request, baseline };
  const continuation = fileURLToPath(
    new URL('./backlog-cancellation-pending-client.cjs', import.meta.url),
  );
  if (pendingOnly) {
    const digest = createHash('sha256').update(readFileSync(continuation)).digest('hex');
    const revisions = state.pendingClientRevisions ?? [];
    const prior = revisions.at(-1) ?? state.pendingClientSha256;
    if (prior && prior !== digest) {
      if (process.env.MAXIM_BACKLOG_PENDING_PREVIOUS_SHA256 !== prior)
        throw new Error('Pending continuation changed without the exact previous digest');
      state = { ...state, pendingClientRevisions: [...revisions, digest] };
    }
    state = { ...state, pendingClientSha256: state.pendingClientSha256 ?? digest };
  }
  const save = (phase) => {
    state = { ...state, phase };
    writeBacklogCancellation(directory, state);
    console.log(JSON.stringify({ phase, operation: request.id }));
  };
  save(state.phase);
  const name = `maxim-backlog-cancel-${request.id}`;
  try {
    runtime.stopRuntime();
    runtime.readStoppedRuntime();
    save('STOPPED');
    // FLAG: Recover only this operation's helper after a lost connection. It has no
    // MAX credentials. Never start the fleet while a cancellation writer survives.
    const existing = execute(['ps', '-aq', '--filter', `name=^/${name}$`]);
    if (existing) {
      const [container] = JSON.parse(execute(['inspect', existing]));
      if (
        container.Config.Labels['com.maxim.backlog-cancellation'] !== request.id ||
        container.Image !== request.imageId
      )
        throw new Error('Foreign cancellation helper');
      execute(['rm', '-f', existing]);
    }
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        'docker',
        [
          'run',
          '--rm',
          '--name',
          name,
          '--label',
          `com.maxim.backlog-cancellation=${request.id}`,
          '--init',
          '--read-only',
          '--tmpfs',
          '/tmp:rw,noexec,nosuid,size=64m',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--cpus',
          '1',
          '--memory',
          '1g',
          '--network',
          connection.networkId,
          '--env-file',
          environmentFile,
          ...(pendingOnly
            ? [
                '--mount',
                `type=bind,src=${continuation},dst=/app/backlog-cancellation-pending-client.cjs,readonly`,
              ]
            : []),
          '-e',
          `MAXIM_BACKLOG_COLD_OPERATION=${request.id}`,
          request.imageId,
          'node',
          pendingOnly
            ? '/app/backlog-cancellation-pending-client.cjs'
            : 'apps/api/dist/apps/api/src/scripts/cancel-webhook-backlog.js',
          JSON.stringify(request),
        ],
        { stdio: ['ignore', 'inherit', 'inherit'], timeout: 960_000 },
      );
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (result.code !== 0) throw new Error('Cancellation incomplete; resume the same operation');
    if (execute(['ps', '-aq', '--filter', `name=^/${name}$`]))
      throw new Error('Cancellation helper remains');
    save('APPLIED');
    await runtime.startBoundRuntime();
    runtime.readRuntimeIdentity();
    save('COMPLETE');
  } finally {
    unlinkSync(environmentFile);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const mode = process.argv[2];
    if (process.argv.length > 3 || (mode && !['--resume-pending', '--preview'].includes(mode)))
      throw new Error('Invalid continuation arguments');
    const raw = readBacklogCancellationInput();
    if (mode === '--preview') {
      const result = await runPreviewHostV2(parseNominationV2(raw));
      process.exitCode = result.exitCode;
    } else if (JSON.parse(raw)?.version === 2) {
      if (mode === '--resume-pending')
        throw new Error('Scoped cancellation cannot resume global work');
      const result = await runApplyHostV2(parseApplyV2(raw));
      process.exitCode = result.exitCode;
    } else
      await runBacklogCancellationHost(
        parseBacklogCancellationRequest(raw),
        mode === '--resume-pending',
      );
  } catch {
    console.error('Cancellation refused or incomplete; preserve the exact operation.');
    process.exitCode = 1;
  }
}
