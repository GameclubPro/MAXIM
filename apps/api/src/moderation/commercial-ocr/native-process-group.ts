import type { ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const PROCESS_GROUP_POLL_MS = 10;

export type NativeProcessGroupDependencies = Readonly<{
  platform: NodeJS.Platform;
  signal: (processId: number, signal: NodeJS.Signals | 0) => void;
  now: () => number;
  wait: (delayMs: number) => Promise<void>;
}>;

const defaultDependencies: NativeProcessGroupDependencies = Object.freeze({
  platform: process.platform,
  signal: (processId, signal) => process.kill(processId, signal),
  now: () => performance.now(),
  wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
});

export function nativeProcessGroupSpawnOptions(): Readonly<{ detached: boolean }> {
  return Object.freeze({ detached: process.platform !== 'win32' });
}

export function signalNativeProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
  options: Readonly<{
    requireIsolatedGroup?: boolean;
    dependencies?: NativeProcessGroupDependencies;
  }> = {},
): boolean {
  const dependencies = options.dependencies ?? defaultDependencies;
  const processGroupId = resolveProcessGroupId(child, dependencies.platform);
  if (processGroupId !== null) {
    try {
      dependencies.signal(-processGroupId, signal);
      return true;
    } catch (error: unknown) {
      if (isMissingProcess(error)) {
        return true;
      }
      return false;
    }
  }
  if (options.requireIsolatedGroup) {
    return false;
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

export async function verifyNativeProcessGroupTeardown(
  child: ChildProcess,
  options: Readonly<{
    graceMs: number;
    requireIsolatedGroup?: boolean;
    dependencies?: NativeProcessGroupDependencies;
  }>,
): Promise<boolean> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const processGroupId = resolveProcessGroupId(child, dependencies.platform);
  if (processGroupId === null) {
    return options.requireIsolatedGroup !== true;
  }
  if (!processGroupExists(processGroupId, dependencies)) {
    return true;
  }
  try {
    dependencies.signal(-processGroupId, 'SIGKILL');
  } catch (error: unknown) {
    if (isMissingProcess(error)) {
      return true;
    }
    return false;
  }

  const deadlineAt = dependencies.now() + normalizeGraceMs(options.graceMs);
  while (dependencies.now() < deadlineAt) {
    if (!processGroupExists(processGroupId, dependencies)) {
      return true;
    }
    await dependencies.wait(
      Math.min(PROCESS_GROUP_POLL_MS, Math.max(1, deadlineAt - dependencies.now())),
    );
  }
  return !processGroupExists(processGroupId, dependencies);
}

export function nativeProcessGroupIsolationSupported(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== 'win32';
}

function resolveProcessGroupId(child: ChildProcess, platform: NodeJS.Platform): number | null {
  return nativeProcessGroupIsolationSupported(platform) &&
    Number.isSafeInteger(child.pid) &&
    child.pid !== undefined &&
    child.pid > 1
    ? child.pid
    : null;
}

function processGroupExists(
  processGroupId: number,
  dependencies: NativeProcessGroupDependencies,
): boolean {
  try {
    dependencies.signal(-processGroupId, 0);
    return true;
  } catch (error: unknown) {
    return !isMissingProcess(error);
  }
}

function isMissingProcess(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null | undefined)?.code === 'ESRCH';
}

function normalizeGraceMs(value: number): number {
  return Number.isSafeInteger(value) && value >= 1 && value <= 10_000 ? value : 250;
}
