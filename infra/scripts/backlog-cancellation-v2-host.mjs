import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createLegacyColdRuntime } from './legacy-cold-runtime.mjs';
import { LEGACY_COLD_API_SERVICES } from './multibot-legacy-cold-recovery.mjs';
import {
  readLegacyColdStoreConnection,
  isLegacyColdStoreEnvironment,
} from './legacy-cold-host.mjs';
import {
  assertInheritedDeployLock,
  assertNoActiveLegacyColdMaintenance,
} from './legacy-cold-journal.mjs';
import {
  readBacklogCancellationForRequest,
  writeBacklogCancellation,
} from './backlog-cancellation-journal.mjs';
import { validateCompleteReleaseManifest } from './release-manifest.mjs';

const ROOT = '/var/lib/maxim-deploy';
const CLIENT = 'apps/api/dist/apps/api/src/scripts/cancel-webhook-backlog-v2.js';
const DATA = '/app/backlog-cancellation-v2';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const hash = (value) => typeof value === 'string' && DIGEST.test(value);
const NOMINATION_BYTES = 16 * 1024;
const APPLY_BYTES = 4 * 1024;
const PREVIEW_BYTES = 8 * 1024 * 1024;
const HELPER_MS = 960_000;
const canonicalValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  return value;
};
export const cancellationV2Bytes = (value) => `${JSON.stringify(canonicalValue(value))}\n`;
const digest = (raw) => createHash('sha256').update(raw).digest('hex');
const digestValue = (value) => digest(cancellationV2Bytes(value));
const keys = (value, expected) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const iso = (value) =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const integer = (value, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= 0 && value <= max;
const text = (value, max = 128) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.trim() === value &&
  Array.from(value).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
  Buffer.byteLength(value) <= max;
const identity = (value) =>
  typeof value.id === 'string' &&
  UUID.test(value.id) &&
  typeof value.sourceSha === 'string' &&
  /^[a-f0-9]{40}$/u.test(value.sourceSha) &&
  typeof value.imageId === 'string' &&
  /^sha256:[a-f0-9]{64}$/u.test(value.imageId) &&
  iso(value.cutoff) &&
  Date.parse(value.cutoff) < Date.now();

function parseCanonical(raw, max) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > max)
    throw new Error('Invalid bounded v2 input');
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid v2 JSON');
  }
  if (cancellationV2Bytes(value) !== raw) throw new Error('Noncanonical v2 input');
  return value;
}

export function parseNominationV2(raw) {
  const value = parseCanonical(raw, NOMINATION_BYTES);
  if (
    !keys(value, ['version', 'id', 'cutoff', 'sourceSha', 'imageId', 'rootIds']) ||
    value.version !== 2 ||
    !identity(value) ||
    !Array.isArray(value.rootIds) ||
    value.rootIds.length < 1 ||
    value.rootIds.length > 128 ||
    value.rootIds.some((id, i) => !text(id) || (i && value.rootIds[i - 1] >= id))
  )
    throw new Error('Invalid v2 nomination');
  return value;
}

export function parseApplyV2(raw) {
  const value = parseCanonical(raw, APPLY_BYTES);
  if (
    !keys(value, ['version', 'id', 'cutoff', 'sourceSha', 'imageId', 'previewSha256']) ||
    value.version !== 2 ||
    !identity(value) ||
    !hash(value.previewSha256)
  )
    throw new Error('Invalid v2 apply request');
  return value;
}

function fsyncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function privateDirectory(root, id, create) {
  const parent = lstatSync(root);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid() ||
    (parent.mode & 0o022) !== 0
  )
    throw new Error('Unsafe v2 evidence parent');
  const path = join(root, `backlog-cancellation-${id}`);
  if (create) {
    try {
      mkdirSync(path, { mode: 0o700 });
      fsyncDirectory(root);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('Unsafe v2 evidence directory');
  return path;
}

function readPrivate(path, max, modes = [0o600]) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      stat.nlink !== 1 ||
      !modes.includes(stat.mode & 0o777) ||
      stat.size > max
    )
      throw new Error('Unsafe bounded v2 evidence file');
    // FLAG: A pre-stat size check alone cannot bound a concurrently growing file.
    // Read only the attested size plus one sentinel, and reject any metadata drift.
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (
      length !== stat.size ||
      ['dev', 'ino', 'size', 'mode', 'nlink', 'uid', 'mtimeMs', 'ctimeMs'].some(
        (key) => after[key] !== stat[key],
      )
    )
      throw new Error('V2 evidence changed during read');
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, length),
      );
    } catch {
      throw new Error('Invalid UTF-8 v2 evidence');
    }
  } finally {
    closeSync(fd);
  }
}

function immutable(path, raw, max) {
  if (Buffer.byteLength(raw) > max) throw new Error('V2 artifact budget');
  let fd;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, raw);
    fsyncSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (readPrivate(path, max) !== raw) throw new Error('Immutable v2 evidence mismatch');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  fsyncDirectory(join(path, '..'));
}

function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function readProcBounded(path, max) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(max + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > max) throw new Error('V2 CLI process identity budget');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)).trim();
  } finally {
    closeSync(fd);
  }
}

function linuxBootId() {
  const bootId = readProcBounded('/proc/sys/kernel/random/boot_id', 128);
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(bootId))
    throw new Error('V2 CLI boot identity unproved');
  return bootId;
}

function linuxCliStartTicks(pid) {
  let stat;
  try {
    stat = readProcBounded(`/proc/${pid}/stat`, 4096);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const end = stat.lastIndexOf(')');
  const startTicks = stat.slice(end + 2).split(' ')[19];
  if (!stat.startsWith(`${pid} (`) || end < 0 || !/^[1-9][0-9]{0,30}$/u.test(startTicks ?? ''))
    throw new Error('V2 CLI process identity unproved');
  return startTicks;
}

function replacePrivate(path, value, max) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  immutable(temporary, cancellationV2Bytes(value), max);
  renameSync(temporary, path);
  fsyncDirectory(join(path, '..'));
}

// FLAG: Only captured generation identities enter this digest. Running/stopped
// bookkeeping must not change it; native isolation boundaries remain bound.
export function cancellationRuntimeDigestV2(baseline) {
  const rows = [...(baseline?.services ?? []), ...(baseline?.auxiliaries ?? [])];
  const services = [...LEGACY_COLD_API_SERVICES, 'ocr-native-sandbox', 'photo-native-sandbox'];
  if (
    baseline?.complete !== true ||
    baseline.singletonCount !== 14 ||
    baseline.nativeCount !== 2 ||
    baseline.unreviewedProducers !== 0 ||
    rows.length !== 16 ||
    new Set(rows.map((row) => row.containerId)).size !== 16 ||
    new Set(rows.map((row) => row.serviceName)).size !== 16 ||
    rows.some((row) => !services.includes(row.serviceName)) ||
    rows.some(
      (row) =>
        !hash(row.containerId) ||
        row.imageId !== baseline.imageId ||
        row.sourceSha !== baseline.sourceSha ||
        row.exactGeneration !== true ||
        (row.serviceName.endsWith('native-sandbox') && !hash(row.nativeBoundaryDigest)),
    )
  )
    throw new Error('Incomplete v2 runtime identity');
  return digestValue({
    sourceSha: baseline.sourceSha,
    imageId: baseline.imageId,
    generations: rows
      .map((row) => ({
        serviceName: row.serviceName,
        containerId: row.containerId,
        ...(row.nativeBoundaryDigest ? { nativeBoundaryDigest: row.nativeBoundaryDigest } : {}),
      }))
      .sort((a, b) => (a.serviceName < b.serviceName ? -1 : a.serviceName > b.serviceName ? 1 : 0)),
  });
}

function validatePreview(raw, nomination, bindings) {
  const value = parseCanonical(raw, PREVIEW_BYTES);
  if (
    !keys(value, [
      'version',
      'kind',
      'id',
      'cutoff',
      'sourceSha',
      'imageId',
      'nominationSha256',
      'bindings',
      'familyPolicy',
      'childPolicy',
      'snapshotAt',
      'completedAt',
      'decision',
      'complete',
      'nonAtomicOnline',
      'stoppedRevalidationRequired',
      'roots',
      'receipts',
      'children',
      'retained',
      'cost',
      'issues',
    ]) ||
    value.version !== 2 ||
    value.kind !== 'BACKLOG_CANCELLATION_PREVIEW' ||
    ['id', 'cutoff', 'sourceSha', 'imageId'].some((key) => value[key] !== nomination[key]) ||
    value.nominationSha256 !== digestValue(nomination) ||
    cancellationV2Bytes(value.bindings) !== cancellationV2Bytes(bindings) ||
    value.familyPolicy !== 'EXACT_OBSERVED_PENDING_FAMILY_V1' ||
    value.childPolicy !== 'EXACT_SOURCE_CHILD_V1' ||
    !iso(value.snapshotAt) ||
    !iso(value.completedAt) ||
    value.snapshotAt > value.completedAt ||
    !['READY', 'DENY'].includes(value.decision) ||
    typeof value.complete !== 'boolean' ||
    value.nonAtomicOnline !== true ||
    value.stoppedRevalidationRequired !== true ||
    !Array.isArray(value.roots) ||
    value.roots.length > 128 ||
    !Array.isArray(value.receipts) ||
    value.receipts.length > 8192 ||
    !Array.isArray(value.children) ||
    value.children.length > 4096 ||
    !Array.isArray(value.issues) ||
    value.issues.length > 8192
  )
    throw new Error('V2 preview header mismatch');
  if (
    value.decision === 'READY' &&
    (!value.complete ||
      value.issues.length ||
      cancellationV2Bytes(value.roots.map((row) => row.receiptId).sort()) !==
        cancellationV2Bytes(nomination.rootIds))
  )
    throw new Error('Incomplete READY v2 preview');
  return value;
}

const execute = (args, options = {}) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();

function verifyStoreEnvironment(connection) {
  if (
    !hash(connection?.networkId) ||
    typeof connection?.environment !== 'string' ||
    Buffer.byteLength(connection.environment) > 64 * 1024 ||
    connection.environment.includes('\0') ||
    !connection.environment.endsWith('\n')
  )
    throw new Error('V2 store connection unproved');
  if (!isLegacyColdStoreEnvironment(connection.environment))
    throw new Error('V2 helper accepts only exact store credentials');
}

export function createBacklogCancellationHelpersV2({
  request,
  operationDirectory,
  connection,
  bindings,
  executeDocker = execute,
  spawnDocker = spawn,
  helperTimeoutMs = HELPER_MS,
  killGraceMs = 5000,
  closeGraceMs = 5000,
}) {
  if (
    !integer(helperTimeoutMs, HELPER_MS) ||
    !helperTimeoutMs ||
    !integer(killGraceMs, 5000) ||
    !killGraceMs ||
    !integer(closeGraceMs, 5000) ||
    !closeGraceMs ||
    helperTimeoutMs <= killGraceMs + closeGraceMs
  )
    throw new Error('Invalid v2 helper deadline');
  const termAfterMs = helperTimeoutMs - killGraceMs - closeGraceMs;
  const liveCli = new Set();
  const name = (mode) => {
    if (!['identity', 'preview', 'preflight', 'apply', 'prove-absent'].includes(mode))
      throw new Error('Unknown v2 helper mode');
    return `maxim-backlog-v2-${request.id}-${mode}`;
  };
  const cliFence = (mode) => {
    name(mode);
    return join(operationDirectory, `helper-cli-${mode}-unproved.json`);
  };
  const timeoutFence = (mode) => {
    name(mode);
    return join(operationDirectory, `helper-timeout-${mode}.json`);
  };
  const proveCliGone = (mode) => {
    if (liveCli.has(mode) || present(timeoutFence(mode)))
      throw new Error('V2 helper CLI exit unproved');
    if (!present(cliFence(mode))) return;
    const raw = readPrivate(cliFence(mode), APPLY_BYTES);
    const previous = parseCanonical(raw, APPLY_BYTES);
    if (
      !keys(previous, ['version', 'id', 'mode', 'pid', 'bootId', 'startTicks', 'cliExitProven']) ||
      previous.version !== 2 ||
      previous.id !== request.id ||
      previous.mode !== mode ||
      previous.cliExitProven !== false ||
      !integer(previous.pid) ||
      !previous.pid ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(previous.bootId ?? '') ||
      !/^[1-9][0-9]{0,30}$/u.test(previous.startTicks ?? '')
    )
      throw new Error('V2 helper CLI exit unproved');
    const bootId = linuxBootId();
    if (bootId === previous.bootId && linuxCliStartTicks(previous.pid) === previous.startTicks)
      throw new Error('V2 helper CLI exit unproved');
    // FLAG: Only absence of this boot/PID/start identity permits an interrupted
    // controller to resume. A no-close timeout always requires separate correction.
    immutable(
      join(operationDirectory, `helper-cli-${mode}-absence-${digest(raw)}.json`),
      cancellationV2Bytes({ ...previous, observedBootId: bootId, cliExitProven: true }),
      APPLY_BYTES,
    );
    unlinkSync(cliFence(mode));
    fsyncDirectory(operationDirectory);
  };
  const inspect = (mode) => {
    const ids = executeDocker(['ps', '-aq', '--no-trunc', '--filter', `name=^/${name(mode)}$`]);
    if (!ids) return null;
    if (!hash(ids)) throw new Error('Ambiguous v2 helper');
    const rows = JSON.parse(executeDocker(['inspect', ids]));
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row.Id !== ids ||
      row.Image !== request.imageId ||
      row.Config?.Labels?.['com.maxim.backlog-cancellation'] !== request.id ||
      row.Config?.Labels?.['com.maxim.backlog-cancellation-v2-mode'] !== mode
    )
      throw new Error('Foreign v2 helper');
    return ids;
  };
  const assertGone = (mode) => {
    proveCliGone(mode);
    if (inspect(mode)) throw new Error('V2 helper remains');
  };
  const cleanup = (mode) => {
    const id = inspect(mode);
    if (id) executeDocker(['rm', '-f', id]);
    assertGone(mode);
  };
  return {
    assertGone,
    cleanup,
    async run(mode, input) {
      cleanup(mode);
      const environmentFile = join(operationDirectory, `stores-${randomUUID()}.env`);
      if (mode !== 'identity') {
        verifyStoreEnvironment(connection);
        immutable(environmentFile, connection.environment, 64 * 1024);
      }
      const mounts =
        mode === 'identity'
          ? []
          : [
              'nomination.json',
              ...(mode === 'preview' ? [] : ['preview.json']),
              'bindings.json',
            ].flatMap((file) => [
              '--mount',
              `type=bind,src=${join(operationDirectory, file)},dst=${DATA}/${file},readonly`,
            ]);
      const args = [
        'run',
        '--rm',
        '--name',
        name(mode),
        '--label',
        `com.maxim.backlog-cancellation=${request.id}`,
        '--label',
        `com.maxim.backlog-cancellation-v2-mode=${mode}`,
        '--init',
        // FLAG: Immutable mounted evidence is owned0600 by the host controller.
        // The image's default node UID cannot read root-owned production proofs.
        '--user',
        `${process.getuid()}:${process.getgid()}`,
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
        mode === 'identity' ? 'none' : connection.networkId,
        ...(mode === 'identity'
          ? []
          : [
              '--env-file',
              environmentFile,
              ...mounts,
              '-e',
              `MAXIM_BACKLOG_V2_BINDINGS=${JSON.stringify(bindings)}`,
              '-e',
              `${['apply', 'prove-absent'].includes(mode) ? 'MAXIM_BACKLOG_COLD_OPERATION' : 'MAXIM_BACKLOG_PREVIEW_OPERATION'}=${request.id}`,
            ]),
        request.imageId,
        'node',
        ...(mode === 'identity'
          ? [
              '-e',
              `process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('${CLIENT}')).digest('hex'))`,
            ]
          : [CLIENT, `--${mode}`, cancellationV2Bytes(input)]),
      ];
      let output = Buffer.alloc(0),
        stderrBytes = 0;
      try {
        const result = await new Promise((resolve, reject) => {
          // FLAG: Persist before launch so controller death cannot erase the CLI
          // fence. An unknown PID always needs separate corrective proof on resume.
          let cli = {
            version: 2,
            id: request.id,
            mode,
            pid: null,
            bootId: null,
            startTicks: null,
            cliExitProven: false,
          };
          immutable(cliFence(mode), cancellationV2Bytes(cli), APPLY_BYTES);
          const child = spawnDocker('docker', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: termAfterMs,
          });
          liveCli.add(mode);
          try {
            if (integer(child.pid) && child.pid) {
              const bootId = linuxBootId();
              const startTicks = linuxCliStartTicks(child.pid);
              if (startTicks !== null) {
                cli = { ...cli, pid: child.pid, bootId, startTicks };
                replacePrivate(cliFence(mode), cli, APPLY_BYTES);
              }
            }
          } catch {
            // FLAG: Keep the persisted unknown-identity barrier if capture fails.
            // A normal close can clear it; interrupted ownership stays unproved.
          }
          const limit = mode === 'preview' ? PREVIEW_BYTES : 64 * 1024;
          let overflow = false,
            launchError = false,
            settled = false,
            terminating = false,
            timedOut = false;
          let deadlineTimer, killTimer, closeTimer;
          const finish = (error, value) => {
            if (settled) return;
            settled = true;
            for (const timer of [deadlineTimer, killTimer, closeTimer]) clearTimeout(timer);
            if (error) reject(error);
            else resolve(value);
          };
          const terminate = () => {
            if (terminating || settled) return;
            terminating = true;
            child.kill('SIGTERM');
            if (settled) return;
            killTimer = setTimeout(() => {
              child.kill('SIGKILL');
              if (settled) return;
              closeTimer = setTimeout(() => {
                // FLAG: No close proof means no safe restart, even after SIGKILL.
                // Detach only the stuck CLI handles; retain the pre-launch durable
                // barrier even if a later close arrives or a new controller starts.
                try {
                  immutable(
                    timeoutFence(mode),
                    cancellationV2Bytes({ ...cli, pid: integer(child.pid) ? child.pid : null }),
                    APPLY_BYTES,
                  );
                } catch {
                  // FLAG: Failed evidence persistence cannot authorize restoration.
                  // The pre-launch durable fence still keeps the host incomplete.
                } finally {
                  child.stdout.destroy();
                  child.stderr.destroy();
                  child.unref?.();
                  finish(new Error('V2 helper CLI exit unproved'));
                }
              }, closeGraceMs);
            }, killGraceMs);
          };
          deadlineTimer = setTimeout(() => {
            timedOut = true;
            terminate();
          }, termAfterMs);
          child.stdout.on('data', (chunk) => {
            if (output.length + chunk.length > limit) {
              overflow = true;
              terminate();
            } else output = Buffer.concat([output, chunk]);
          });
          // FLAG: Docker/database diagnostics can contain secrets. Never relay raw
          // stderr; retain only a bounded byte count and a fixed controller failure.
          child.stderr.on('data', (chunk) => {
            stderrBytes += chunk.length;
            if (stderrBytes > 64 * 1024) {
              overflow = true;
              terminate();
            }
          });
          child.once('error', () => {
            launchError = true;
            terminate();
          });
          // FLAG: exit may precede final stdout/stderr delivery. close is the
          // bounded child-plus-pipes boundary needed for a complete JSON receipt.
          child.once('close', (code, signal) => {
            if (settled) return;
            try {
              unlinkSync(cliFence(mode));
              fsyncDirectory(operationDirectory);
            } catch {
              finish(new Error('V2 helper CLI close persistence failed'));
              return;
            }
            liveCli.delete(mode);
            if (launchError) finish(new Error('V2 helper launch failed'));
            else if (overflow) finish(new Error('V2 helper output budget'));
            else if (timedOut) finish(new Error('V2 helper deadline'));
            else finish(null, { code, signal, stdout: output.toString('utf8') });
          });
        });
        assertGone(mode);
        return result;
      } catch {
        cleanup(mode);
        throw new Error('V2 helper execution failed');
      } finally {
        if (mode !== 'identity') {
          unlinkSync(environmentFile);
          fsyncDirectory(operationDirectory);
        }
      }
    },
  };
}

function assertActiveRelease(directory, request) {
  // FLAG: Tooling-only synchronization does not change the component manifest's
  // targetSha. Bind the installed API component, retaining complete static evidence.
  if (readdirSync(directory).some((name) => name.startsWith('current.invalid-')))
    throw new Error('V2 release transition unfinished');
  const manifest = JSON.parse(
    readPrivate(join(directory, 'current.json'), 64 * 1024, [0o600, 0o640]),
  );
  validateCompleteReleaseManifest(manifest);
  const api = manifest.components['api-shared'];
  if (
    api.sourceSha !== request.sourceSha ||
    api.imageRef !== `maxim-api:${request.sourceSha}` ||
    api.imageId !== request.imageId
  )
    throw new Error('V2 installed API manifest mismatch');
}

function bindController(op, nomination, controllerSha, create = false) {
  const path = join(op, 'controller.json');
  const raw = cancellationV2Bytes({
    version: 1,
    kind: 'BACKLOG_CANCELLATION_CONTROLLER_V1',
    id: nomination.id,
    controllerSha,
    sourceSha: nomination.sourceSha,
    imageId: nomination.imageId,
    nominationSha256: digestValue(nomination),
  });
  if (create) immutable(path, raw, APPLY_BYTES);
  if (present(path)) {
    if (readPrivate(path, APPLY_BYTES) !== raw) throw new Error('V2 immutable controller mismatch');
    return digest(raw);
  }
  // FLAG: Legacy evidence can resume only its original same-source controller.
  // Never backfill a different controller onto an old or incomplete preview.
  if (controllerSha !== nomination.sourceSha || present(join(op, 'controller-ready.json')))
    throw new Error('V2 immutable controller missing');
  return null;
}

function controllerReadyBytes(request, controllerSha256) {
  return cancellationV2Bytes({
    version: 1,
    kind: 'BACKLOG_CANCELLATION_CONTROLLER_READY_V1',
    id: request.id,
    controllerSha256,
    previewSha256: request.previewSha256,
  });
}

function context(request, options) {
  const directory = options.directory ?? ROOT;
  (options.assertLock ?? assertInheritedDeployLock)();
  const controllerSha = options.expectedSha ?? process.env.MAXIM_EXPECTED_DEPLOY_SHA;
  const runtimeSha =
    options.expectedRuntimeSha ?? process.env.MAXIM_EXPECTED_BACKLOG_RUNTIME_SHA ?? controllerSha;
  if (!/^[a-f0-9]{40}$/u.test(controllerSha ?? '') || runtimeSha !== request.sourceSha)
    throw new Error('V2 controller source mismatch');
  (options.assertMaintenance ?? assertNoActiveLegacyColdMaintenance)(directory, request.id);
  assertActiveRelease(directory, request);
  return {
    directory,
    controllerSha,
    report: options.report ?? ((value) => console.log(JSON.stringify(value))),
    runtime: (previous) =>
      (options.createRuntime ?? createLegacyColdRuntime)({
        bindings: {
          targetSha: request.sourceSha,
          targetImageId: request.imageId,
          controllerNonce: request.id,
          selectionDigest: request.id,
        },
        baseline: previous?.baseline ?? null,
      }),
    connection: (baseline) => {
      let connection;
      try {
        connection = (options.readConnection ?? readLegacyColdStoreConnection)(baseline);
      } catch {
        throw new Error('V2 store connection unproved');
      }
      verifyStoreEnvironment(connection);
      return connection;
    },
    helpers: options.createHelpers ?? createBacklogCancellationHelpersV2,
    readJournal: options.readJournal ?? readBacklogCancellationForRequest,
    writeJournal: options.writeJournal ?? writeBacklogCancellation,
    proveRestored: options.proveRestored ?? proveRestoredHealth,
  };
}

async function proveRestoredHealth(runtime) {
  const deadline = Date.now() + 120_000;
  let good = 0;
  while (Date.now() < deadline) {
    try {
      runtime.readRuntimeIdentity();
      const samples = [];
      for (const port of [3001, 3002]) {
        const response = await fetch(`http://127.0.0.1:${port}/api/health/ready`, {
          signal: AbortSignal.timeout(Math.min(5000, Math.max(1, deadline - Date.now()))),
          redirect: 'error',
          headers: { accept: 'application/json' },
        });
        const body = await response.json();
        const lag = body?.checks?.queueLag;
        const age = Date.now() - Date.parse(lag?.sampleGeneratedAt);
        const strictReady =
          response.ok && body?.ok === true && lag?.rawOk === true && lag.effectiveLagSec <= 10;
        const queueBacklogOnly =
          response.status === 503 &&
          body?.ok === false &&
          lag?.rawOk === false &&
          lag.effectiveLagSec > 10 &&
          body.systemMode?.source === 'auto' &&
          body.systemMode?.condition === 'queue_backlog' &&
          body.systemMode?.manualMode === null;
        if (
          body?.checks?.database !== true ||
          body?.checks?.redis !== true ||
          !Number.isFinite(lag?.effectiveLagSec) ||
          lag.effectiveLagSec < 0 ||
          !Number.isFinite(age) ||
          age < -1000 ||
          age > 15_000 ||
          (!strictReady && !queueBacklogOnly)
        )
          throw new Error('V2 restored dependencies unproved');
        samples.push({ port, strictReady, queueBacklogOnly, lagSeconds: lag.effectiveLagSec });
      }
      if (++good >= 3) return { version: 2, dependenciesReady: true, samples };
    } catch {
      good = 0;
    }
    await delay(Math.min(5000, Math.max(0, deadline - Date.now())));
  }
  throw new Error('V2 restored health deadline');
}

async function clientBindings(helpers, runtimeDigest) {
  const result = await helpers.run('identity');
  helpers.assertGone('identity');
  if (result.code !== 0 || !hash(result.stdout))
    throw new Error('V2 installed client identity unproved');
  return { runtimeDigest, clientSha256: result.stdout };
}

export async function runPreviewHostV2(request, options = {}) {
  request = parseNominationV2(cancellationV2Bytes(request));
  const ctx = context(request, options);
  // A preview cannot resume its own pending mutation under the own-ID exception.
  (options.assertMaintenance ?? assertNoActiveLegacyColdMaintenance)(ctx.directory);
  const op = privateDirectory(ctx.directory, request.id, true);
  const newNomination = !present(join(op, 'nomination.json'));
  // FLAG: Missing nomination bytes do not make retained READY evidence a new operation.
  if (newNomination && readdirSync(op).length !== 0)
    throw new Error('V2 incomplete retained evidence; use a new preview ID');
  immutable(join(op, 'nomination.json'), cancellationV2Bytes(request), NOMINATION_BYTES);
  const controllerSha256 = bindController(op, request, ctx.controllerSha, newNomination);
  if (present(join(op, 'preview-failure.json')) || present(join(op, 'apply.json')))
    throw new Error('V2 operation already consumed; use a new preview ID');
  const runtime = ctx.runtime(null);
  const baseline = runtime.inspectRuntime();
  const runtimeDigest = cancellationRuntimeDigestV2(baseline);
  const connection = ctx.connection(baseline);
  const helpers = ctx.helpers({ request, operationDirectory: op, connection, bindings: null });
  const bindings = await clientBindings(helpers, runtimeDigest);
  immutable(join(op, 'bindings.json'), cancellationV2Bytes(bindings), APPLY_BYTES);
  const boundHelpers = ctx.helpers({ request, operationDirectory: op, connection, bindings });
  try {
    let raw;
    if (present(join(op, 'preview.json')))
      raw = readPrivate(join(op, 'preview.json'), PREVIEW_BYTES);
    else {
      const result = await boundHelpers.run('preview', request);
      boundHelpers.assertGone('preview');
      if (![0, 2].includes(result.code)) throw new Error('V2 preview helper refused');
      raw = result.stdout;
      const preview = validatePreview(raw, request, bindings);
      if ((result.code === 0) !== (preview.decision === 'READY'))
        throw new Error('V2 preview exit/header mismatch');
    }
    const preview = validatePreview(raw, request, bindings);
    if (preview.decision !== 'READY') {
      immutable(join(op, 'preview-failure.json'), raw, PREVIEW_BYTES);
      const result = { phase: 'PREVIEW', operation: request.id, decision: 'DENY', exitCode: 2 };
      ctx.report(result);
      return result;
    }
    immutable(join(op, 'preview.json'), raw, PREVIEW_BYTES);
    const result = {
      phase: 'PREVIEW',
      operation: request.id,
      decision: 'READY',
      previewSha256: digest(raw),
      exitCode: 0,
    };
    if (controllerSha256 !== null)
      immutable(
        join(op, 'controller-ready.json'),
        controllerReadyBytes({ ...request, previewSha256: result.previewSha256 }, controllerSha256),
        APPLY_BYTES,
      );
    ctx.report(result);
    return result;
  } catch {
    immutable(
      join(op, 'preview-failure.json'),
      cancellationV2Bytes({
        version: 2,
        id: request.id,
        decision: 'DENY',
        code: 'HOST_PREVIEW_REFUSED',
      }),
      PREVIEW_BYTES,
    );
    throw new Error('V2 preview incomplete; use a new preview ID');
  }
}

function parseBoundResponse(raw, kind, request, extraKeys) {
  const value = parseCanonical(raw, 64 * 1024);
  if (
    !keys(value, ['version', 'kind', 'id', 'previewSha256', ...extraKeys]) ||
    value.version !== 2 ||
    value.kind !== kind ||
    value.id !== request.id ||
    value.previewSha256 !== request.previewSha256
  )
    throw new Error('V2 helper response identity mismatch');
  return value;
}

export async function runApplyHostV2(request, options = {}) {
  request = parseApplyV2(cancellationV2Bytes(request));
  const ctx = context(request, options);
  const op = privateDirectory(ctx.directory, request.id, false);
  const nomination = parseNominationV2(readPrivate(join(op, 'nomination.json'), NOMINATION_BYTES));
  if (['id', 'cutoff', 'sourceSha', 'imageId'].some((key) => nomination[key] !== request[key]))
    throw new Error('V2 nomination/apply identity mismatch');
  const controllerSha256 = bindController(op, nomination, ctx.controllerSha);
  const previewRaw = readPrivate(join(op, 'preview.json'), PREVIEW_BYTES);
  if (digest(previewRaw) !== request.previewSha256)
    throw new Error('V2 immutable preview mismatch');
  if (
    controllerSha256 !== null &&
    readPrivate(join(op, 'controller-ready.json'), APPLY_BYTES) !==
      controllerReadyBytes(request, controllerSha256)
  )
    throw new Error('V2 controller READY receipt mismatch');
  const bindings = parseCanonical(readPrivate(join(op, 'bindings.json'), APPLY_BYTES), APPLY_BYTES);
  if (
    !keys(bindings, ['runtimeDigest', 'clientSha256']) ||
    !hash(bindings.runtimeDigest) ||
    !hash(bindings.clientSha256)
  )
    throw new Error('Invalid v2 immutable bindings');
  const preview = validatePreview(previewRaw, nomination, bindings);
  if (preview.decision !== 'READY' || !preview.complete) throw new Error('V2 preview is not READY');
  let state = ctx.readJournal(ctx.directory, request);
  if (state && cancellationV2Bytes(state.request) !== cancellationV2Bytes(request))
    throw new Error('V2 exact request changed');
  if (
    state &&
    ((state.controllerSha256 ?? null) !== controllerSha256 ||
      state.previewSha256 !== request.previewSha256 ||
      state.nominationSha256 !== digestValue(nomination) ||
      cancellationV2Bytes(state.bindings) !== cancellationV2Bytes(bindings) ||
      cancellationRuntimeDigestV2(state.baseline) !== bindings.runtimeDigest)
  )
    throw new Error('V2 journal evidence mismatch');
  immutable(join(op, 'apply.json'), cancellationV2Bytes(request), APPLY_BYTES);
  if (state?.phase === 'COMPLETE') {
    if (!['APPLIED', 'ABORTED_UNWRITTEN'].includes(state.outcome))
      throw new Error('V2 completed outcome missing');
    const result = {
      phase: 'COMPLETE',
      operation: request.id,
      outcome: state.outcome,
      exitCode: state.outcome === 'APPLIED' ? 0 : 2,
      resumed: true,
    };
    ctx.report(result);
    return result;
  }
  const runtime = ctx.runtime(state);
  const baseline = state?.baseline ?? runtime.inspectRuntime();
  if (cancellationRuntimeDigestV2(baseline) !== bindings.runtimeDigest)
    throw new Error('V2 captured generations changed');
  const connection = ctx.connection(baseline);
  const helpers = ctx.helpers({ request, operationDirectory: op, connection, bindings });
  const installed = await clientBindings(helpers, bindings.runtimeDigest);
  if (cancellationV2Bytes(installed) !== cancellationV2Bytes(bindings))
    throw new Error('V2 installed client changed');
  const save = (phase, additions = {}) => {
    state = {
      ...state,
      version: 1,
      request,
      baseline,
      phase,
      nominationSha256: digestValue(nomination),
      previewSha256: request.previewSha256,
      bindings,
      ...(controllerSha256 === null ? {} : { controllerSha256 }),
      ...additions,
    };
    if (state.abortPending === false) delete state.abortPending;
    ctx.writeJournal(ctx.directory, state);
    ctx.report({
      phase,
      operation: request.id,
      ...(state.outcome ? { outcome: state.outcome } : {}),
    });
  };
  if (!state || state.phase === 'PREPARED') {
    const checked = await helpers.run('preflight', request);
    helpers.assertGone('preflight');
    const proof = parseBoundResponse(checked.stdout, 'BACKLOG_CANCELLATION_PREFLIGHT', request, [
      'valid',
    ]);
    if (checked.code !== 0 || proof.valid !== true)
      throw new Error('V2 live root preflight refused');
    save('PREPARED');
  }
  // FLAG: A failed writer may survive a disconnected Docker client. Remove only
  // this exact labelled/image-bound helper, then prove it absent before restoration.
  helpers.cleanup('apply');
  runtime.stopRuntime();
  runtime.readStoppedRuntime();
  save('STOPPED');
  const restoreUnwritten = async () => {
    helpers.assertGone('apply');
    const verified = await helpers.run('prove-absent', request);
    helpers.assertGone('prove-absent');
    const proof = parseBoundResponse(
      verified.stdout,
      'BACKLOG_CANCELLATION_NO_WRITE_PROOF',
      request,
      ['operationAbsent'],
    );
    if (verified.code !== 0 || proof.operationAbsent !== true)
      throw new Error('V2 write absence unproved; resume identical request');
    immutable(join(op, 'no-write-proof.json'), cancellationV2Bytes(proof), APPLY_BYTES);
    save('STOPPED', { abortPending: true });
    runtime.readStoppedRuntime();
    await runtime.startBoundRuntime();
    runtime.readRuntimeIdentity();
    const health = await ctx.proveRestored(runtime);
    immutable(
      join(op, `restored-health-${digestValue(health)}.json`),
      cancellationV2Bytes(health),
      APPLY_BYTES,
    );
    save('COMPLETE', { outcome: 'ABORTED_UNWRITTEN', abortPending: false });
    const result = {
      phase: 'COMPLETE',
      operation: request.id,
      outcome: 'ABORTED_UNWRITTEN',
      exitCode: 2,
    };
    ctx.report(result);
    return result;
  };
  if (state.abortPending) return restoreUnwritten();
  let applied;
  try {
    const result = await helpers.run('apply', request);
    helpers.assertGone('apply');
    applied = parseBoundResponse(result.stdout, 'BACKLOG_CANCELLATION_APPLY_RESULT', request, [
      'outcome',
      'operationExists',
      'sealed',
      'counts',
      'issues',
    ]);
    if (
      !keys(applied.counts, [
        'receipts',
        'projected',
        'children',
        'removed',
        'retainedLocked',
        'missingJobs',
      ]) ||
      Object.values(applied.counts).some((value) => !integer(value, 500_000)) ||
      !Array.isArray(applied.issues) ||
      applied.issues.length > 8192 ||
      !['APPLIED', 'REFUSED_UNWRITTEN', 'INCOMPLETE_WRITTEN'].includes(applied.outcome) ||
      typeof applied.operationExists !== 'boolean' ||
      typeof applied.sealed !== 'boolean'
    )
      throw new Error('Invalid v2 apply result');
    immutable(
      join(op, `apply-result-${digestValue(applied)}.json`),
      cancellationV2Bytes(applied),
      64 * 1024,
    );
    if (
      result.code !== 0 ||
      applied.outcome !== 'APPLIED' ||
      !applied.operationExists ||
      !applied.sealed ||
      applied.issues.length ||
      applied.counts.receipts !== preview.receipts.length
    )
      throw new Error('V2 apply not complete');
  } catch {
    helpers.cleanup('apply');
    if (applied?.operationExists === true)
      throw new Error('V2 cancellation incomplete after write; resume identical request');
    return restoreUnwritten();
  }
  save('APPLIED');
  helpers.assertGone('apply');
  await runtime.startBoundRuntime();
  runtime.readRuntimeIdentity();
  const health = await ctx.proveRestored(runtime);
  immutable(
    join(op, `restored-health-${digestValue(health)}.json`),
    cancellationV2Bytes(health),
    APPLY_BYTES,
  );
  save('COMPLETE', { outcome: 'APPLIED', abortPending: false });
  const result = { phase: 'COMPLETE', operation: request.id, outcome: 'APPLIED', exitCode: 0 };
  ctx.report(result);
  return result;
}
