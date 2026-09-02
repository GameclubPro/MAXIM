import { WorkerHost } from '@nestjs/bullmq';
import { Logger, ShutdownSignal, type INestApplicationContext } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { Worker } from 'bullmq';

export const RUNTIME_WORKER_SHUTDOWN_GRACE_MS = 5_000;
export const RUNTIME_SHUTDOWN_HARD_TIMEOUT_MS = 9_000;

type RuntimeWorker = Pick<Worker, 'close' | 'pause'> & {
  readonly name?: string;
};

type RuntimeShutdownContext = Pick<INestApplicationContext, 'get'> & {
  close(signal?: string): Promise<void>;
};

type RuntimeWorkerShutdownLogger = Pick<Logger, 'error' | 'log' | 'warn'>;

type RuntimeShutdownProcess = {
  readonly pid: number;
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
  kill(pid: number, signal: NodeJS.Signals): unknown;
  exit(code: number): unknown;
};

type RuntimeWorkerShutdownOptions = {
  graceMs?: number;
  hardTimeoutMs?: number;
  logger?: RuntimeWorkerShutdownLogger;
  processHost?: RuntimeShutdownProcess;
  resolveWorkers?: (context: RuntimeShutdownContext) => readonly RuntimeWorker[];
  signals?: readonly NodeJS.Signals[];
};

export type RuntimeWorkerShutdownResult = {
  closeFailureCount: number;
  forced: boolean;
  pauseFailureCount: number;
  workerCount: number;
};

export type RuntimeWorkerShutdownRegistration = {
  readonly shutdownPromise: Promise<void> | null;
  dispose(): void;
};

const DEFAULT_SHUTDOWN_SIGNALS = Object.freeze(Object.values(ShutdownSignal) as NodeJS.Signals[]);

export function discoverRegisteredRuntimeWorkers(context: RuntimeShutdownContext): RuntimeWorker[] {
  const discovery = context.get(DiscoveryService, { strict: false });
  const workers = new Set<RuntimeWorker>();

  for (const provider of discovery.getProviders()) {
    const instance = provider.instance;
    if (!(instance instanceof WorkerHost)) {
      continue;
    }
    try {
      workers.add(instance.worker);
    } catch {
      // A signal can arrive while Nest is still registering processors. Such a host
      // has not admitted work yet and can be left to the normal context teardown.
    }
  }

  return [...workers];
}

export async function drainRuntimeWorkers(
  workers: readonly RuntimeWorker[],
  options: Pick<RuntimeWorkerShutdownOptions, 'graceMs' | 'logger'> = {},
): Promise<RuntimeWorkerShutdownResult> {
  const graceMs = normalizeGraceMs(options.graceMs);
  const logger = options.logger ?? new Logger('RuntimeWorkerShutdown');
  const uniqueWorkers = [...new Set(workers)];
  if (uniqueWorkers.length === 0) {
    return {
      closeFailureCount: 0,
      forced: false,
      pauseFailureCount: 0,
      workerCount: 0,
    };
  }

  // pause(false) closes local admission immediately and waits for current jobs without
  // starting Worker.close(). This preserves the ability to make close(true) the first
  // close call if the graceful deadline expires.
  const pausePromises = uniqueWorkers.map((worker) => callWorkerPause(worker));
  const pauseOutcomePromise = Promise.allSettled(pausePromises);
  let timeout: NodeJS.Timeout | null = null;
  const outcome = await Promise.race([
    pauseOutcomePromise.then((results) => ({ kind: 'settled' as const, results })),
    new Promise<{ kind: 'timeout' }>((resolve) => {
      timeout = setTimeout(() => resolve({ kind: 'timeout' }), graceMs);
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }

  const pauseFailureCount =
    outcome.kind === 'settled'
      ? outcome.results.filter((result) => result.status === 'rejected').length
      : 0;
  const forced = outcome.kind === 'timeout' || pauseFailureCount > 0;
  if (forced) {
    logger.warn(
      `Forcing ${uniqueWorkers.length} BullMQ worker(s) closed after ` +
        `${outcome.kind === 'timeout' ? `${graceMs}ms grace deadline` : `${pauseFailureCount} pause failure(s)`}.`,
    );
  }

  const closeResults = await Promise.allSettled(
    uniqueWorkers.map((worker) => callWorkerClose(worker, forced)),
  );
  const closeFailureCount = closeResults.filter((result) => result.status === 'rejected').length;
  if (closeFailureCount > 0) {
    logger.error(`Failed to close ${closeFailureCount} BullMQ worker(s) during runtime shutdown.`);
  }

  return {
    closeFailureCount,
    forced,
    pauseFailureCount,
    workerCount: uniqueWorkers.length,
  };
}

export async function closeRuntimeContextWithWorkerDrain(
  context: RuntimeShutdownContext,
  signal: NodeJS.Signals,
  workers: readonly RuntimeWorker[],
  options: Pick<RuntimeWorkerShutdownOptions, 'graceMs' | 'logger'> = {},
): Promise<RuntimeWorkerShutdownResult> {
  const result = await drainRuntimeWorkers(workers, options);
  await context.close(signal);
  return result;
}

export function installRuntimeWorkerShutdown(
  context: RuntimeShutdownContext,
  options: RuntimeWorkerShutdownOptions = {},
): RuntimeWorkerShutdownRegistration {
  const logger = options.logger ?? new Logger('RuntimeWorkerShutdown');
  const processHost = options.processHost ?? process;
  const resolveWorkers = options.resolveWorkers ?? discoverRegisteredRuntimeWorkers;
  const signals = [...new Set(options.signals ?? DEFAULT_SHUTDOWN_SIGNALS)];
  const graceMs = normalizeGraceMs(options.graceMs);
  const hardTimeoutMs = normalizeHardTimeoutMs(options.hardTimeoutMs, graceMs);
  const listeners = new Map<NodeJS.Signals, () => void>();
  let disposed = false;
  let shutdownPromise: Promise<void> | null = null;

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const [signal, listener] of listeners) {
      processHost.removeListener(signal, listener);
    }
    listeners.clear();
  };

  for (const signal of signals) {
    const listener = () => {
      if (shutdownPromise) {
        return;
      }
      shutdownPromise = (async () => {
        let phase = 'worker-discovery';
        let hardTimeout: NodeJS.Timeout | null = setTimeout(() => {
          logger.error(
            `Runtime shutdown exceeded the ${hardTimeoutMs}ms hard deadline during ${phase}; exiting.`,
          );
          dispose();
          processHost.exit(1);
        }, hardTimeoutMs);
        try {
          const workers = resolveWorkers(context);
          logger.log(`Stopping ${workers.length} BullMQ worker(s) before ${signal} teardown.`);
          phase = 'worker-drain';
          await drainRuntimeWorkers(workers, {
            graceMs,
            logger,
          });
          phase = 'context-close';
          await context.close(signal);
          clearTimeout(hardTimeout);
          hardTimeout = null;
          dispose();
          processHost.kill(processHost.pid, signal);
        } catch (error: unknown) {
          if (hardTimeout) {
            clearTimeout(hardTimeout);
            hardTimeout = null;
          }
          dispose();
          logger.error(`Runtime shutdown failed after ${signal}: ${formatShutdownError(error)}.`);
          processHost.exit(1);
        }
      })();
    };
    listeners.set(signal, listener);
    processHost.on(signal, listener);
  }

  return {
    dispose,
    get shutdownPromise() {
      return shutdownPromise;
    },
  };
}

function callWorkerPause(worker: RuntimeWorker): Promise<void> {
  try {
    return Promise.resolve(worker.pause(false));
  } catch (error: unknown) {
    return Promise.reject(error);
  }
}

function callWorkerClose(worker: RuntimeWorker, force: boolean): Promise<void> {
  try {
    return Promise.resolve(worker.close(force));
  } catch (error: unknown) {
    return Promise.reject(error);
  }
}

function normalizeGraceMs(value: number | undefined): number {
  if (value === undefined) {
    return RUNTIME_WORKER_SHUTDOWN_GRACE_MS;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Runtime worker shutdown grace must be a positive safe integer');
  }
  return value;
}

function normalizeHardTimeoutMs(value: number | undefined, graceMs: number): number {
  const timeoutMs = value ?? RUNTIME_SHUTDOWN_HARD_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= graceMs) {
    throw new Error('Runtime shutdown hard timeout must be a safe integer above the worker grace');
  }
  return timeoutMs;
}

function formatShutdownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
