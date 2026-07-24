import { randomUUID } from 'node:crypto';
import { open, realpath, stat, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export const COMMERCIAL_OUTPUT_LOCK_STALE_MS = 15 * 60 * 1000;

type FileIdentity = {
  dev: number;
  ino: number;
};

type PathIdentity = {
  canonicalPath: string;
  fileIdentity: FileIdentity | null;
  originalPath: string;
};

type AcquiredOutputLock = FileIdentity & {
  path: string;
  handle: FileHandle;
  token: string;
};

type LockMetadata = {
  pid: number;
  createdAt: string;
  token?: string;
};

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return null;
  }
  return typeof error.code === 'string' ? error.code : null;
}

function lockPathForOutput(pathname: string): string {
  return `${resolve(pathname)}.lock`;
}

export async function assertCommercialOutputLockPathsSafe(
  outputPaths: readonly string[],
): Promise<void> {
  const resolvedOutputs = [...new Set(outputPaths.map((pathname) => resolve(pathname)))];
  const lockPaths = resolvedOutputs.map(lockPathForOutput);
  const [outputIdentities, lockIdentities] = await Promise.all([
    Promise.all(resolvedOutputs.map(resolvePathIdentity)),
    Promise.all(lockPaths.map(resolvePathIdentity)),
  ]);
  for (const output of outputIdentities) {
    const collidingLock = lockIdentities.find((lock) => pathIdentitiesAlias(output, lock));
    if (collidingLock) {
      throw new Error(
        `Commercial output path collides with an output lock path: ${output.originalPath} and ${collidingLock.originalPath}`,
      );
    }
  }
}

async function resolvePathIdentity(pathname: string): Promise<PathIdentity> {
  const originalPath = resolve(pathname);
  try {
    const [canonicalPath, pathStat] = await Promise.all([
      realpath(originalPath),
      stat(originalPath),
    ]);
    return {
      canonicalPath,
      fileIdentity: { dev: pathStat.dev, ino: pathStat.ino },
      originalPath,
    };
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
  }

  const canonicalParent = await realpath(dirname(originalPath));
  return {
    canonicalPath: join(canonicalParent, basename(originalPath)),
    fileIdentity: null,
    originalPath,
  };
}

function pathIdentitiesAlias(left: PathIdentity, right: PathIdentity): boolean {
  if (left.canonicalPath === right.canonicalPath) {
    return true;
  }
  return Boolean(
    left.fileIdentity &&
    right.fileIdentity &&
    sameFileIdentity(left.fileIdentity, right.fileIdentity),
  );
}

export async function assertCommercialPathsDistinct(paths: readonly string[]): Promise<void> {
  const identities = await Promise.all(paths.map(resolvePathIdentity));
  for (let leftIndex = 0; leftIndex < identities.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < identities.length; rightIndex += 1) {
      const left = identities[leftIndex];
      const right = identities[rightIndex];
      if (pathIdentitiesAlias(left, right)) {
        throw new Error(
          `Commercial audit paths must resolve to different files: ${left.originalPath} and ${right.originalPath}`,
        );
      }
    }
  }
}

function lockMetadata(token: string): string {
  return `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token })}\n`;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function parseLockMetadata(body: string): LockMetadata | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const metadata = parsed as Record<string, unknown>;
  if (
    !Number.isSafeInteger(metadata.pid) ||
    (metadata.pid as number) <= 0 ||
    typeof metadata.createdAt !== 'string' ||
    (metadata.token !== undefined && typeof metadata.token !== 'string')
  ) {
    return null;
  }
  return {
    pid: metadata.pid as number,
    createdAt: metadata.createdAt,
    ...(typeof metadata.token === 'string' ? { token: metadata.token } : {}),
  };
}

async function removePathIfIdentityMatches(
  pathname: string,
  expectedIdentity: FileIdentity,
): Promise<boolean> {
  let currentStat;
  try {
    currentStat = await stat(pathname);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
  if (!sameFileIdentity(currentStat, expectedIdentity)) {
    return false;
  }
  try {
    await unlink(pathname);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function initializeLock(lockPath: string, handle: FileHandle): Promise<AcquiredOutputLock> {
  const fileStat = await handle.stat();
  const token = randomUUID();
  const lock: AcquiredOutputLock = {
    path: lockPath,
    handle,
    token,
    dev: fileStat.dev,
    ino: fileStat.ino,
  };
  try {
    await handle.writeFile(lockMetadata(token), 'utf8');
    if (!(await lockPathIsOwned(lock))) {
      throw new Error(`Commercial output lock ownership changed during acquisition: ${lockPath}`);
    }
    return lock;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await removePathIfIdentityMatches(lockPath, lock).catch(() => undefined);
    throw error;
  }
}

async function tryCreateOutputLock(lockPath: string): Promise<AcquiredOutputLock | null> {
  let handle: FileHandle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      return null;
    }
    throw error;
  }
  return initializeLock(lockPath, handle);
}

function processIsDefinitelyAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === 'ESRCH';
  }
}

async function recoverableStaleLockIdentity(lockPath: string): Promise<FileIdentity | null> {
  if (typeof process.getuid !== 'function') {
    return null;
  }

  let pathHandle: FileHandle;
  try {
    pathHandle = await open(lockPath, 'r');
  } catch {
    return null;
  }

  let body: string;
  let lockStat;
  try {
    [body, lockStat] = await Promise.all([pathHandle.readFile('utf8'), pathHandle.stat()]);
  } catch {
    return null;
  } finally {
    await pathHandle.close().catch(() => undefined);
  }
  if (lockStat.uid !== process.getuid()) {
    return null;
  }
  const metadata = parseLockMetadata(body);
  if (!metadata) {
    return null;
  }
  const createdAtMs = Date.parse(metadata.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    return null;
  }
  const newestTimestampMs = Math.max(createdAtMs, lockStat.mtimeMs);
  if (Date.now() - newestTimestampMs < COMMERCIAL_OUTPUT_LOCK_STALE_MS) {
    return null;
  }
  if (!processIsDefinitelyAbsent(metadata.pid)) {
    return null;
  }

  const currentStat = await stat(lockPath).catch(() => null);
  if (!currentStat || !sameFileIdentity(currentStat, lockStat)) {
    return null;
  }
  return { dev: lockStat.dev, ino: lockStat.ino };
}

async function removeRecoverableStaleLock(lockPath: string): Promise<boolean> {
  const identity = await recoverableStaleLockIdentity(lockPath);
  return identity ? removePathIfIdentityMatches(lockPath, identity) : false;
}

async function tryAcquireRecoveryLock(recoveryPath: string): Promise<AcquiredOutputLock | null> {
  const created = await tryCreateOutputLock(recoveryPath);
  if (created) {
    return created;
  }
  if (!(await removeRecoverableStaleLock(recoveryPath))) {
    return null;
  }
  return tryCreateOutputLock(recoveryPath);
}

async function tryRecoverAndAcquireOutputLock(
  lockPath: string,
): Promise<AcquiredOutputLock | null> {
  const recoveryPath = `${lockPath}.recovery`;
  const recoveryLock = await tryAcquireRecoveryLock(recoveryPath);
  if (!recoveryLock) {
    return null;
  }

  let recoveredLock: AcquiredOutputLock | null = null;
  let recoveryError: unknown;
  try {
    if (await removeRecoverableStaleLock(lockPath)) {
      recoveredLock = await tryCreateOutputLock(lockPath);
    }
  } catch (error) {
    recoveryError = error;
  }

  const cleanupErrors = await releaseOutputLocks([recoveryLock]);
  if (recoveryError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [recoveryError, ...cleanupErrors],
        'Commercial output lock recovery failed and recovery-lock cleanup was incomplete',
      );
    }
    throw recoveryError;
  }
  if (cleanupErrors.length > 0) {
    if (recoveredLock) {
      cleanupErrors.push(...(await releaseOutputLocks([recoveredLock])));
    }
    throw new AggregateError(cleanupErrors, 'Commercial recovery-lock cleanup failed');
  }
  return recoveredLock;
}

async function acquireOutputLock(lockPath: string): Promise<AcquiredOutputLock> {
  const created = await tryCreateOutputLock(lockPath);
  if (created) {
    return created;
  }

  const recovered = await tryRecoverAndAcquireOutputLock(lockPath);
  if (recovered) {
    return recovered;
  }
  throw new Error(`Output is locked by another process: ${lockPath}`);
}

async function lockPathIsOwned(lock: AcquiredOutputLock): Promise<boolean> {
  const openHandleStat = await lock.handle.stat();
  if (!sameFileIdentity(openHandleStat, lock)) {
    return false;
  }

  let pathHandle: FileHandle;
  try {
    pathHandle = await open(lock.path, 'r');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }

  let pathBody: string;
  let pathHandleStat;
  try {
    [pathBody, pathHandleStat] = await Promise.all([
      pathHandle.readFile('utf8'),
      pathHandle.stat(),
    ]);
  } finally {
    await pathHandle.close().catch(() => undefined);
  }
  const metadata = parseLockMetadata(pathBody);
  if (!metadata || metadata.token !== lock.token || !sameFileIdentity(pathHandleStat, lock)) {
    return false;
  }

  const finalPathStat = await stat(lock.path).catch(() => null);
  return Boolean(finalPathStat && sameFileIdentity(finalPathStat, lock));
}

async function releaseOutputLocks(locks: readonly AcquiredOutputLock[]): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const lock of [...locks].reverse()) {
    try {
      if (await lockPathIsOwned(lock)) {
        await unlink(lock.path);
      } else {
        errors.push(new Error(`Commercial output lock ownership changed: ${lock.path}`));
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        errors.push(error);
      }
    }
    try {
      await lock.handle.close();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

// This serializes cooperative publishers; it cannot make two filesystem renames crash-atomic.
// A non-cooperating same-owner process with directory write access can still race path-identity
// checks and unlink operations. Replay/evaluation consumers must verify the companion summary's
// payload SHA after a hard crash.
export async function withCommercialOutputLocks<T>(
  outputPaths: readonly string[],
  action: () => Promise<T>,
): Promise<T> {
  await assertCommercialOutputLockPathsSafe(outputPaths);
  const lockPaths = [...new Set(outputPaths.map(lockPathForOutput))].sort();
  const locks: AcquiredOutputLock[] = [];

  try {
    for (const lockPath of lockPaths) {
      const lock = await acquireOutputLock(lockPath);
      locks.push(lock);
    }
  } catch (error) {
    const cleanupErrors = await releaseOutputLocks(locks);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Commercial output lock acquisition failed and cleanup was incomplete',
      );
    }
    throw error;
  }

  let result: T | undefined;
  let actionError: unknown;
  try {
    result = await action();
  } catch (error) {
    actionError = error;
  }

  const cleanupErrors = await releaseOutputLocks(locks);
  if (actionError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [actionError, ...cleanupErrors],
        'Commercial output publication failed and lock cleanup was incomplete',
      );
    }
    throw actionError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Commercial output lock cleanup failed');
  }
  return result as T;
}
