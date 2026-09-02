import { WorkerHost } from '@nestjs/bullmq';
import { DiscoveryService } from '@nestjs/core';
import type { Job, Worker } from 'bullmq';
import {
  closeRuntimeContextWithWorkerDrain,
  discoverRegisteredRuntimeWorkers,
  drainRuntimeWorkers,
  installRuntimeWorkerShutdown,
} from './runtime-worker-shutdown';

type TestWorker = Pick<Worker, 'close' | 'pause'> & { name: string };

class TestWorkerHost extends WorkerHost {
  async process(_job: Job): Promise<void> {}

  setWorker(worker: TestWorker): void {
    (this as unknown as { _worker: TestWorker })._worker = worker;
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createWorker(name: string): TestWorker {
  return {
    name,
    pause: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

function createLogger() {
  return {
    error: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
  };
}

describe('runtime worker shutdown', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('discovers only registered WorkerHost instances and de-duplicates workers', () => {
    const worker = createWorker('queue-a');
    const hostA = new TestWorkerHost();
    const hostB = new TestWorkerHost();
    hostA.setWorker(worker);
    hostB.setWorker(worker);
    const discovery = {
      getProviders: jest
        .fn()
        .mockReturnValue([{ instance: hostA }, { instance: { worker } }, { instance: hostB }]),
    };
    const context = {
      get: jest.fn((token: unknown) => {
        expect(token).toBe(DiscoveryService);
        return discovery;
      }),
    };

    expect(discoverRegisteredRuntimeWorkers(context as never)).toEqual([worker]);
  });

  it('skips a WorkerHost that has not been initialized yet', () => {
    const worker = createWorker('queue-a');
    const initializedHost = new TestWorkerHost();
    initializedHost.setWorker(worker);
    const discovery = {
      getProviders: jest
        .fn()
        .mockReturnValue([{ instance: new TestWorkerHost() }, { instance: initializedHost }]),
    };
    const context = {
      get: jest.fn().mockReturnValue(discovery),
    };

    expect(discoverRegisteredRuntimeWorkers(context as never)).toEqual([worker]);
  });

  it('stops admission and lets active jobs settle before the first graceful close', async () => {
    const active = deferred();
    const order: string[] = [];
    const worker = createWorker('queue-a');
    worker.pause = jest.fn(async (doNotWaitActive?: boolean) => {
      order.push(`pause:${String(doNotWaitActive)}`);
      await active.promise;
    });
    worker.close = jest.fn(async (force?: boolean) => {
      order.push(`close:${String(force)}`);
    });

    const shutdown = drainRuntimeWorkers([worker], { graceMs: 5_000, logger: createLogger() });
    await Promise.resolve();

    expect(worker.pause).toHaveBeenCalledWith(false);
    expect(worker.close).not.toHaveBeenCalled();
    active.resolve();

    await expect(shutdown).resolves.toEqual({
      closeFailureCount: 0,
      forced: false,
      pauseFailureCount: 0,
      workerCount: 1,
    });
    expect(order).toEqual(['pause:false', 'close:false']);
  });

  it('makes force close the first close call after the graceful deadline', async () => {
    jest.useFakeTimers();
    const worker = createWorker('queue-a');
    worker.pause = jest.fn(() => new Promise<void>(() => undefined));
    const logger = createLogger();

    const shutdown = drainRuntimeWorkers([worker], { graceMs: 5_000, logger });
    await jest.advanceTimersByTimeAsync(5_000);

    await expect(shutdown).resolves.toEqual({
      closeFailureCount: 0,
      forced: true,
      pauseFailureCount: 0,
      workerCount: 1,
    });
    expect(worker.pause).toHaveBeenCalledWith(false);
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(worker.close).toHaveBeenCalledWith(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('5000ms grace deadline'));
  });

  it('force closes every worker if graceful admission shutdown rejects', async () => {
    const workerA = createWorker('queue-a');
    const workerB = createWorker('queue-b');
    workerA.pause = jest.fn().mockRejectedValue(new Error('pause failed'));

    await expect(
      drainRuntimeWorkers([workerA, workerB], { graceMs: 5_000, logger: createLogger() }),
    ).resolves.toMatchObject({ forced: true, pauseFailureCount: 1, workerCount: 2 });
    expect(workerA.close).toHaveBeenCalledWith(true);
    expect(workerB.close).toHaveBeenCalledWith(true);
  });

  it('closes the Nest context only after workers have closed', async () => {
    const order: string[] = [];
    const worker = createWorker('queue-a');
    worker.pause = jest.fn(async () => {
      order.push('pause');
    });
    worker.close = jest.fn(async () => {
      order.push('worker-close');
    });
    const context = {
      close: jest.fn(async () => {
        order.push('context-close');
      }),
    };

    await closeRuntimeContextWithWorkerDrain(context as never, 'SIGTERM', [worker], {
      logger: createLogger(),
    });

    expect(context.close).toHaveBeenCalledWith('SIGTERM');
    expect(order).toEqual(['pause', 'worker-close', 'context-close']);
  });

  it('installs one coordinated handler and re-emits the signal after context close', async () => {
    const listeners = new Map<NodeJS.Signals, () => void>();
    const processHost = {
      pid: 123,
      on: jest.fn((signal: NodeJS.Signals, listener: () => void) => {
        listeners.set(signal, listener);
      }),
      removeListener: jest.fn((signal: NodeJS.Signals) => {
        listeners.delete(signal);
      }),
      kill: jest.fn(),
      exit: jest.fn(),
    };
    const context = { close: jest.fn().mockResolvedValue(undefined) };
    const registration = installRuntimeWorkerShutdown(context as never, {
      logger: createLogger(),
      processHost,
      resolveWorkers: () => [],
      signals: ['SIGTERM'],
    });

    listeners.get('SIGTERM')?.();
    listeners.get('SIGTERM')?.();
    await registration.shutdownPromise;

    expect(context.close).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledWith('SIGTERM');
    expect(processHost.kill).toHaveBeenCalledWith(123, 'SIGTERM');
    expect(processHost.exit).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it('hard exits before Docker grace when worker close never settles', async () => {
    jest.useFakeTimers();
    const listeners = new Map<NodeJS.Signals, () => void>();
    const processHost = {
      pid: 123,
      on: jest.fn((signal: NodeJS.Signals, listener: () => void) => {
        listeners.set(signal, listener);
      }),
      removeListener: jest.fn((signal: NodeJS.Signals) => {
        listeners.delete(signal);
      }),
      kill: jest.fn(),
      exit: jest.fn(),
    };
    const worker = createWorker('queue-a');
    worker.close = jest.fn(() => new Promise<void>(() => undefined));
    const context = { close: jest.fn().mockResolvedValue(undefined) };
    const logger = createLogger();
    installRuntimeWorkerShutdown(context as never, {
      graceMs: 5_000,
      hardTimeoutMs: 9_000,
      logger,
      processHost,
      resolveWorkers: () => [worker],
      signals: ['SIGTERM'],
    });

    listeners.get('SIGTERM')?.();
    await jest.advanceTimersByTimeAsync(9_000);

    expect(worker.close).toHaveBeenCalledWith(false);
    expect(context.close).not.toHaveBeenCalled();
    expect(processHost.exit).toHaveBeenCalledWith(1);
    expect(processHost.kill).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('worker-drain'));
    expect(listeners.size).toBe(0);
  });

  it('keeps the hard watchdog armed until context close settles', async () => {
    jest.useFakeTimers();
    const listeners = new Map<NodeJS.Signals, () => void>();
    const processHost = {
      pid: 123,
      on: jest.fn((signal: NodeJS.Signals, listener: () => void) => {
        listeners.set(signal, listener);
      }),
      removeListener: jest.fn((signal: NodeJS.Signals) => {
        listeners.delete(signal);
      }),
      kill: jest.fn(),
      exit: jest.fn(),
    };
    const context = { close: jest.fn(() => new Promise<void>(() => undefined)) };
    const logger = createLogger();
    installRuntimeWorkerShutdown(context as never, {
      graceMs: 5_000,
      hardTimeoutMs: 9_000,
      logger,
      processHost,
      resolveWorkers: () => [],
      signals: ['SIGTERM'],
    });

    listeners.get('SIGTERM')?.();
    await Promise.resolve();
    expect(context.close).toHaveBeenCalledWith('SIGTERM');

    await jest.advanceTimersByTimeAsync(8_999);
    expect(processHost.exit).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

    expect(processHost.exit).toHaveBeenCalledWith(1);
    expect(processHost.kill).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('context-close'));
  });
});
