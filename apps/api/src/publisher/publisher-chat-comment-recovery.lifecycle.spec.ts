import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import type { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  closeRuntimeContextWithWorkerDrain,
  discoverRegisteredRuntimeWorkers,
  RUNTIME_WORKER_SHUTDOWN_GRACE_MS,
} from '../runtime/runtime-worker-shutdown';
import { PublisherActionCredentialService } from './publisher-action-credential.service';
import {
  PublisherBackgroundWorkCoordinatorClosedError,
  PublisherBackgroundWorkCoordinatorService,
} from './publisher-background-work-coordinator.service';
import {
  PUBLISHER_CHAT_COMMENT_RECOVERY_INTERVAL_MS,
  PUBLISHER_CHAT_COMMENT_RECOVERY_STARTUP_DELAY_MS,
  PublisherChatCommentRecoveryService,
} from './publisher-chat-comment-recovery.service';
import {
  PUBLISHER_CHAT_COMMENT_QUEUE,
  type PublisherChatCommentJob,
} from './publisher-chat-comment.queue';
import { PublisherDispatchHealthService } from './publisher-dispatch-health.service';
import { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';
import { PublisherReadinessService } from './publisher-readiness.service';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';

type MarkerDelegate = PrismaService['chatAutoCommentAttachMarker'];
type FindMany = MarkerDelegate['findMany'];
type PrismaPort = {
  chatAutoCommentAttachMarker: Pick<MarkerDelegate, 'findMany'>;
};
type QueuePort = Pick<Queue<PublisherChatCommentJob>, 'getJob'>;
type HealthPort = Pick<
  PublisherDispatchHealthService,
  'isGloballyPaused' | 'assertDispatchAllowed'
>;
type BoundaryPort = Pick<
  PublisherRuntimeBoundaryService,
  'dispatchEnabled' | 'assertDispatchEnabled'
>;
type ReadinessPort = Pick<PublisherReadinessService, 'assertEntityReady'>;
type IdentityPort = Pick<PublisherIdentityAttestationService, 'assertAttested'>;
type CredentialPort = Pick<PublisherActionCredentialService, 'getBotId'>;

class EmptyMarkerRead extends Promise<never[]> implements Prisma.PrismaPromise<never[]> {
  override readonly [Symbol.toStringTag] = 'PrismaPromise';
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type Settlement<T> =
  | { status: 'pending' }
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

function observe<T>(run: Promise<T>) {
  let state: Settlement<T> = { status: 'pending' };
  void run.then(
    (value) => {
      state = { status: 'fulfilled', value };
    },
    (reason: unknown) => {
      state = { status: 'rejected', reason };
    },
  );
  return {
    get state() {
      return state;
    },
  };
}

async function flushPromises(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
}

async function createHarness() {
  const findMany: jest.MockedFunction<FindMany> = jest.fn();
  findMany.mockReturnValue(new EmptyMarkerRead((resolve) => resolve([])));
  const prisma = { chatAutoCommentAttachMarker: { findMany } } satisfies PrismaPort;
  const isGloballyPaused: jest.MockedFunction<HealthPort['isGloballyPaused']> = jest.fn();
  isGloballyPaused.mockResolvedValue(false);
  const health = {
    isGloballyPaused,
    assertDispatchAllowed: jest.fn(async () => undefined),
  } satisfies HealthPort;
  const boundary = {
    dispatchEnabled: true,
    assertDispatchEnabled: jest.fn(() => undefined),
  } satisfies BoundaryPort;
  const identity = { assertAttested: jest.fn(async () => undefined) } satisfies IdentityPort;
  const credentials = { getBotId: () => 'publik-bot' } satisfies CredentialPort;
  const readiness = {
    assertEntityReady: jest.fn((): never => {
      throw new Error('Empty-batch lifecycle test reached entity readiness');
    }),
  } satisfies ReadinessPort;
  const queue = {
    getJob: jest.fn((): never => {
      throw new Error('Empty-batch lifecycle test reached BullMQ');
    }),
  } satisfies QueuePort;
  const context = await Test.createTestingModule({
    imports: [DiscoveryModule],
    providers: [
      PublisherChatCommentRecoveryService,
      PublisherBackgroundWorkCoordinatorService,
      { provide: PrismaService, useValue: prisma },
      { provide: getQueueToken(PUBLISHER_CHAT_COMMENT_QUEUE), useValue: queue },
      { provide: PublisherReadinessService, useValue: readiness },
      { provide: PublisherRuntimeBoundaryService, useValue: boundary },
      { provide: PublisherDispatchHealthService, useValue: health },
      { provide: PublisherActionCredentialService, useValue: credentials },
      { provide: PublisherIdentityAttestationService, useValue: identity },
      { provide: 'RECOVERY_ALIAS', useExisting: PublisherChatCommentRecoveryService },
    ],
  }).compile();
  const service = context.get(PublisherChatCommentRecoveryService);
  const coordinator = context.get(PublisherBackgroundWorkCoordinatorService);
  const closeSpy = jest.spyOn(context, 'close');
  const coordinatorDestroy = jest.spyOn(coordinator, 'onModuleDestroy');
  const laneRuns = jest.spyOn(coordinator, 'runExclusive');
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const cleanupGates: Array<() => void> = [];
  const runs: Promise<unknown>[] = [];

  function track<T>(run: Promise<T>): Promise<T> {
    runs.push(run);
    void run.catch(() => undefined);
    return run;
  }

  function hold<T>(cleanupValue: T) {
    const gate = deferred<T>();
    cleanupGates.push(() => gate.resolve(cleanupValue));
    return gate;
  }

  function startRuntimeClose() {
    const workers = discoverRegisteredRuntimeWorkers(context);
    return track(closeRuntimeContextWithWorkerDrain(context, 'SIGTERM', workers, { logger }));
  }

  return {
    context,
    service,
    coordinator,
    findMany,
    health,
    identity,
    readiness,
    queue,
    closeSpy,
    coordinatorDestroy,
    laneRuns,
    hold,
    track,
    startRuntimeClose,
    async dispose() {
      for (const release of cleanupGates) release();
      await Promise.allSettled(service.stopWorkerAdmission().map((worker) => worker.close(true)));
      await flushPromises();
      await Promise.allSettled(runs);
      await context.close();
    },
  };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function withHarness(scenario: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await createHarness();
  try {
    await harness.context.init();
    await scenario(harness);
  } finally {
    await harness.dispose();
  }
}

function recoverySubmissions(harness: Harness) {
  return harness.laneRuns.mock.calls.filter(([lane]) => lane === 'chat_comment_recovery');
}

describe('PublisherChatCommentRecoveryService runtime lifecycle', () => {
  let warnings: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function scheduledWarnings() {
    return warnings.mock.calls.filter(
      ([, message]) => message === 'Publisher chat-comment recovery sweep failed',
    );
  }

  it.each([false, true])(
    'drains an accepted first pause check returning %s before real Nest teardown',
    async (paused) => {
      await withHarness(async (h) => {
        const firstPause = h.hold<boolean>(true);
        h.health.isGloballyPaused.mockReturnValueOnce(firstPause.promise);
        jest.advanceTimersByTime(PUBLISHER_CHAT_COMMENT_RECOVERY_STARTUP_DELAY_MS);
        expect(h.health.isGloballyPaused).toHaveBeenCalledTimes(1);
        expect(h.findMany).not.toHaveBeenCalled();

        const firstSnapshot = discoverRegisteredRuntimeWorkers(h.context);
        const secondSnapshot = discoverRegisteredRuntimeWorkers(h.context);
        expect(firstSnapshot).toHaveLength(1);
        expect(secondSnapshot[0]).toBe(firstSnapshot[0]);
        expect(h.context.get('RECOVERY_ALIAS')).toBe(h.service);
        const closing = observe(h.startRuntimeClose());
        h.service.onModuleInit();
        await flushPromises();
        expect(closing.state.status).toBe('pending');
        expect(h.closeSpy).not.toHaveBeenCalled();
        expect(h.coordinatorDestroy).not.toHaveBeenCalled();

        firstPause.resolve(paused);
        await flushPromises();
        expect(closing.state).toMatchObject({
          status: 'fulfilled',
          value: { forced: false, workerCount: 1, closeFailureCount: 0, pauseFailureCount: 0 },
        });
        expect(h.health.isGloballyPaused).toHaveBeenCalledTimes(paused ? 1 : 2);
        expect(h.identity.assertAttested).toHaveBeenCalledTimes(paused ? 0 : 1);
        expect(h.findMany).toHaveBeenCalledTimes(paused ? 0 : 1);
        expect(h.closeSpy).toHaveBeenCalledTimes(1);
        expect(h.coordinatorDestroy).toHaveBeenCalledTimes(1);
        expect(h.queue.getJob).not.toHaveBeenCalled();
        expect(h.readiness.assertEntityReady).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);

        const stoppedResult = await h.service.recoverOnce();
        h.service.onModuleInit();
        jest.advanceTimersByTime(PUBLISHER_CHAT_COMMENT_RECOVERY_INTERVAL_MS);
        expect(stoppedResult).toMatchObject({ scanned: 0, alreadyRunning: false });
        expect(h.health.isGloballyPaused).toHaveBeenCalledTimes(paused ? 1 : 2);
        expect(h.findMany).toHaveBeenCalledTimes(paused ? 0 : 1);
        expect(jest.getTimerCount()).toBe(0);
      });
    },
  );

  it.each([false, true])(
    'keeps the real FIFO coordinator alive and honors second pause=%s',
    async (secondPause) => {
      await withHarness(async (h) => {
        const blocker = h.hold<void>(undefined);
        h.track(h.coordinator.runExclusive('binding_refresh', () => blocker.promise));
        await flushPromises();
        jest.advanceTimersByTime(PUBLISHER_CHAT_COMMENT_RECOVERY_STARTUP_DELAY_MS);
        await flushPromises();
        expect(recoverySubmissions(h)).toHaveLength(1);
        expect(h.health.isGloballyPaused).toHaveBeenCalledTimes(1);
        expect(h.findMany).not.toHaveBeenCalled();
        h.health.isGloballyPaused.mockResolvedValue(secondPause);

        const closing = observe(h.startRuntimeClose());
        await flushPromises();
        expect(closing.state.status).toBe('pending');
        expect(h.closeSpy).not.toHaveBeenCalled();
        expect(h.coordinatorDestroy).not.toHaveBeenCalled();
        blocker.resolve(undefined);
        await flushPromises();
        expect(closing.state).toMatchObject({ status: 'fulfilled', value: { forced: false } });
        expect(h.health.isGloballyPaused).toHaveBeenCalledTimes(2);
        expect(h.identity.assertAttested).toHaveBeenCalledTimes(secondPause ? 0 : 1);
        expect(h.findMany).toHaveBeenCalledTimes(secondPause ? 0 : 1);
        expect(h.coordinatorDestroy).toHaveBeenCalledTimes(1);
      });
    },
  );

  it('coalesces explicit followers without adding scheduled pause checks', async () => {
    await withHarness(async (h) => {
      const blocker = h.hold<void>(undefined);
      h.track(h.coordinator.runExclusive('binding_refresh', () => blocker.promise));
      await flushPromises();
      const first = observe(h.track(h.service.recoverOnce()));
      const follower = observe(h.track(h.service.recoverOnce()));
      expect(recoverySubmissions(h)).toHaveLength(1);
      const closing = observe(h.startRuntimeClose());
      await flushPromises();
      expect(first.state.status).toBe('pending');
      expect(follower.state.status).toBe('pending');
      expect(h.coordinatorDestroy).not.toHaveBeenCalled();

      blocker.resolve(undefined);
      await flushPromises();
      expect(first.state).toMatchObject({
        status: 'fulfilled',
        value: { scanned: 0, alreadyRunning: false },
      });
      expect(follower.state).toMatchObject({
        status: 'fulfilled',
        value: { scanned: 0, alreadyRunning: true },
      });
      expect(closing.state).toMatchObject({ status: 'fulfilled', value: { forced: false } });
      expect(h.findMany).toHaveBeenCalledTimes(1);
      expect(h.health.isGloballyPaused).not.toHaveBeenCalled();
    });
  });

  it('joins a pending explicit run after the scheduled first pause and suppresses extra timers', async () => {
    await withHarness(async (h) => {
      const blocker = h.hold<void>(undefined);
      const firstPause = h.hold<boolean>(true);
      h.track(h.coordinator.runExclusive('binding_refresh', () => blocker.promise));
      h.health.isGloballyPaused.mockReturnValueOnce(firstPause.promise);
      await flushPromises();
      jest.advanceTimersByTime(PUBLISHER_CHAT_COMMENT_RECOVERY_STARTUP_DELAY_MS);
      jest.advanceTimersByTime(2 * PUBLISHER_CHAT_COMMENT_RECOVERY_INTERVAL_MS);
      expect(h.health.isGloballyPaused).toHaveBeenCalledTimes(1);
      const explicit = observe(h.track(h.service.recoverOnce()));
      firstPause.resolve(false);
      await flushPromises();
      expect(recoverySubmissions(h)).toHaveLength(1);
      expect(h.findMany).not.toHaveBeenCalled();

      const closing = observe(h.startRuntimeClose());
      await flushPromises();
      expect(h.closeSpy).not.toHaveBeenCalled();
      blocker.resolve(undefined);
      await flushPromises();
      expect(explicit.state).toMatchObject({
        status: 'fulfilled',
        value: { alreadyRunning: false },
      });
      expect(closing.state).toMatchObject({ status: 'fulfilled', value: { forced: false } });
      expect(h.health.isGloballyPaused).toHaveBeenCalledTimes(1);
      expect(h.findMany).toHaveBeenCalledTimes(1);
    });
  });

  it('drains a pending typed Prisma read before closing the coordinator', async () => {
    await withHarness(async (h) => {
      const query = h.hold<never[]>([]);
      h.findMany.mockReturnValueOnce(
        new EmptyMarkerRead((resolve, reject) => {
          void query.promise.then(resolve, reject);
        }),
      );
      const recovery = observe(h.track(h.service.recoverOnce()));
      await flushPromises();
      expect(h.findMany).toHaveBeenCalledTimes(1);
      const closing = observe(h.startRuntimeClose());
      await flushPromises();
      expect(recovery.state.status).toBe('pending');
      expect(closing.state.status).toBe('pending');
      expect(h.closeSpy).not.toHaveBeenCalled();
      expect(h.coordinatorDestroy).not.toHaveBeenCalled();

      query.resolve([]);
      await flushPromises();
      expect(recovery.state).toMatchObject({ status: 'fulfilled', value: { scanned: 0 } });
      expect(closing.state).toMatchObject({ status: 'fulfilled', value: { forced: false } });
      expect(h.coordinatorDestroy).toHaveBeenCalledTimes(1);
    });
  });

  it('forces the actual runtime and Nest close at five seconds while first pause is unresolved', async () => {
    await withHarness(async (h) => {
      const firstPause = h.hold<boolean>(true);
      const pauseState = observe(firstPause.promise);
      h.health.isGloballyPaused.mockReturnValueOnce(firstPause.promise);
      jest.advanceTimersByTime(PUBLISHER_CHAT_COMMENT_RECOVERY_STARTUP_DELAY_MS);
      const closing = observe(h.startRuntimeClose());
      await jest.advanceTimersByTimeAsync(RUNTIME_WORKER_SHUTDOWN_GRACE_MS - 1);
      expect(closing.state.status).toBe('pending');
      expect(h.closeSpy).not.toHaveBeenCalled();
      expect(h.coordinatorDestroy).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      expect(pauseState.state.status).toBe('pending');
      expect(closing.state).toMatchObject({
        status: 'fulfilled',
        value: { forced: true, workerCount: 1, closeFailureCount: 0, pauseFailureCount: 0 },
      });
      expect(h.closeSpy).toHaveBeenCalledTimes(1);
      expect(h.coordinatorDestroy).toHaveBeenCalledTimes(1);
      expect(h.findMany).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  it('force bypasses pre-existing graceful waits and releases a cached direct destroy', async () => {
    await withHarness(async (h) => {
      const firstPause = h.hold<boolean>(true);
      const pauseState = observe(firstPause.promise);
      h.health.isGloballyPaused.mockReturnValueOnce(firstPause.promise);
      jest.advanceTimersByTime(PUBLISHER_CHAT_COMMENT_RECOVERY_STARTUP_DELAY_MS);
      const [worker] = discoverRegisteredRuntimeWorkers(h.context);
      const oldPause = observe(h.track(worker.pause(false)));
      const oldClose = observe(h.track(worker.close(false)));
      const oldDestroy = observe(h.track(h.service.onModuleDestroy()));
      await flushPromises();
      expect(oldPause.state.status).toBe('pending');
      expect(oldClose.state.status).toBe('pending');
      expect(oldDestroy.state.status).toBe('pending');

      const forced = observe(h.track(worker.close(true)));
      const afterForce = [
        observe(h.track(worker.pause(false))),
        observe(h.track(worker.close(false))),
        observe(h.track(h.service.onModuleDestroy())),
      ];
      await flushPromises();
      expect(pauseState.state.status).toBe('pending');
      expect(forced.state.status).toBe('fulfilled');
      expect(oldDestroy.state.status).toBe('fulfilled');
      for (const call of afterForce) expect(call.state.status).toBe('fulfilled');
      expect(oldPause.state.status).toBe('pending');
      expect(oldClose.state.status).toBe('pending');
      expect(h.findMany).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  it('shares one direct-destroy deadline across concurrent and repeated hooks', async () => {
    await withHarness(async (h) => {
      const firstPause = h.hold<boolean>(true);
      const pauseState = observe(firstPause.promise);
      h.health.isGloballyPaused.mockReturnValueOnce(firstPause.promise);
      jest.advanceTimersByTime(PUBLISHER_CHAT_COMMENT_RECOVERY_STARTUP_DELAY_MS);
      const first = observe(h.track(h.service.onModuleDestroy()));
      await jest.advanceTimersByTimeAsync(RUNTIME_WORKER_SHUTDOWN_GRACE_MS - 1);
      const second = observe(h.track(h.service.onModuleDestroy()));
      const third = observe(h.track(h.service.onModuleDestroy()));
      await flushPromises();
      for (const call of [first, second, third]) expect(call.state.status).toBe('pending');

      await jest.advanceTimersByTimeAsync(1);
      expect(pauseState.state.status).toBe('pending');
      for (const call of [first, second, third]) expect(call.state.status).toBe('fulfilled');
      const [worker] = discoverRegisteredRuntimeWorkers(h.context);
      const later = [
        observe(h.track(h.service.onModuleDestroy())),
        observe(h.track(worker.pause(false))),
        observe(h.track(worker.close(false))),
      ];
      await flushPromises();
      for (const call of later) expect(call.state.status).toBe('fulfilled');
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  it('clears the direct-destroy fallback when accepted work drains normally', async () => {
    await withHarness(async (h) => {
      const firstPause = h.hold<boolean>(true);
      h.health.isGloballyPaused.mockReturnValueOnce(firstPause.promise);
      jest.advanceTimersByTime(PUBLISHER_CHAT_COMMENT_RECOVERY_STARTUP_DELAY_MS);
      const destroying = observe(h.track(h.service.onModuleDestroy()));
      await flushPromises();
      expect(destroying.state.status).toBe('pending');
      firstPause.resolve(true);
      await flushPromises();
      expect(destroying.state.status).toBe('fulfilled');
      expect(jest.getTimerCount()).toBe(0);
      expect(h.coordinatorDestroy).not.toHaveBeenCalled();
    });
  });

  it('bounds actual direct Nest teardown without claiming FIFO drain ordering', async () => {
    await withHarness(async (h) => {
      const firstPause = h.hold<boolean>(true);
      const pauseState = observe(firstPause.promise);
      h.health.isGloballyPaused.mockReturnValueOnce(firstPause.promise);
      jest.advanceTimersByTime(PUBLISHER_CHAT_COMMENT_RECOVERY_STARTUP_DELAY_MS);
      const closing = observe(h.track(h.context.close()));
      await flushPromises();
      await jest.advanceTimersByTimeAsync(RUNTIME_WORKER_SHUTDOWN_GRACE_MS - 1);
      expect(closing.state.status).toBe('pending');
      await jest.advanceTimersByTimeAsync(1);
      expect(pauseState.state.status).toBe('pending');
      expect(closing.state.status).toBe('fulfilled');
      expect(h.coordinatorDestroy).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  it('initializes once through an alias and never reopens after discovery', async () => {
    await withHarness(async (h) => {
      expect(jest.getTimerCount()).toBe(2);
      h.service.onModuleInit();
      expect(jest.getTimerCount()).toBe(2);
      jest.advanceTimersByTime(PUBLISHER_CHAT_COMMENT_RECOVERY_STARTUP_DELAY_MS);
      await flushPromises();
      expect(h.findMany).toHaveBeenCalledTimes(1);
      h.service.onModuleInit();
      expect(jest.getTimerCount()).toBe(1);
      const snapshot = discoverRegisteredRuntimeWorkers(h.context);
      expect(snapshot).toHaveLength(1);
      expect(discoverRegisteredRuntimeWorkers(h.context)[0]).toBe(snapshot[0]);
      h.service.onModuleInit();
      const stopped = await h.service.recoverOnce();
      jest.advanceTimersByTime(2 * PUBLISHER_CHAT_COMMENT_RECOVERY_INTERVAL_MS);
      await flushPromises();
      expect(stopped).toMatchObject({ scanned: 0, alreadyRunning: false });
      expect(h.findMany).toHaveBeenCalledTimes(1);
      expect(h.health.isGloballyPaused).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  it.each(['pause', 'identity', 'query'] as const)(
    'warns once on scheduled %s failure and releases ownership for the next interval',
    async (phase) => {
      await withHarness(async (h) => {
        const failure = new Error(`scheduled ${phase} failed`);
        if (phase === 'pause') h.health.isGloballyPaused.mockRejectedValueOnce(failure);
        if (phase === 'identity') h.identity.assertAttested.mockRejectedValueOnce(failure);
        if (phase === 'query') {
          h.findMany.mockImplementationOnce(
            () => new EmptyMarkerRead((_, reject) => reject(failure)),
          );
        }
        jest.advanceTimersByTime(PUBLISHER_CHAT_COMMENT_RECOVERY_STARTUP_DELAY_MS);
        await flushPromises();
        expect(scheduledWarnings()).toEqual([
          [{ err: failure.message }, 'Publisher chat-comment recovery sweep failed'],
        ]);
        jest.advanceTimersByTime(
          PUBLISHER_CHAT_COMMENT_RECOVERY_INTERVAL_MS -
            PUBLISHER_CHAT_COMMENT_RECOVERY_STARTUP_DELAY_MS,
        );
        await flushPromises();
        expect(h.findMany).toHaveBeenCalledTimes(phase === 'query' ? 2 : 1);
        expect(recoverySubmissions(h)).toHaveLength(phase === 'pause' ? 1 : 2);
        expect(scheduledWarnings()).toHaveLength(1);
        const closing = observe(h.startRuntimeClose());
        await flushPromises();
        expect(closing.state).toMatchObject({ status: 'fulfilled', value: { forced: false } });
      });
    },
  );

  it.each(['identity', 'query'] as const)(
    'preserves explicit %s Error identity and permits the next explicit run',
    async (phase) => {
      await withHarness(async (h) => {
        const failure = new Error(`explicit ${phase} failed`);
        if (phase === 'identity') h.identity.assertAttested.mockRejectedValueOnce(failure);
        if (phase === 'query') {
          h.findMany.mockImplementationOnce(
            () => new EmptyMarkerRead((_, reject) => reject(failure)),
          );
        }
        const failed = observe(h.track(h.service.recoverOnce()));
        await flushPromises();
        expect(failed.state.status).toBe('rejected');
        if (failed.state.status === 'rejected') expect(failed.state.reason).toBe(failure);
        const next = observe(h.track(h.service.recoverOnce()));
        await flushPromises();
        expect(next.state).toMatchObject({
          status: 'fulfilled',
          value: { scanned: 0, alreadyRunning: false },
        });
        expect(h.findMany).toHaveBeenCalledTimes(phase === 'query' ? 2 : 1);
        expect(h.health.isGloballyPaused).not.toHaveBeenCalled();
        expect(scheduledWarnings()).toHaveLength(0);
      });
    },
  );

  it('cleans scheduled ownership after the actual coordinator rejects a queued operation', async () => {
    await withHarness(async (h) => {
      const blocker = h.hold<void>(undefined);
      h.track(h.coordinator.runExclusive('binding_refresh', () => blocker.promise));
      await flushPromises();
      jest.advanceTimersByTime(PUBLISHER_CHAT_COMMENT_RECOVERY_STARTUP_DELAY_MS);
      await flushPromises();
      expect(recoverySubmissions(h)).toHaveLength(1);
      h.coordinator.onModuleDestroy();
      await flushPromises();
      expect(scheduledWarnings()).toEqual([
        [
          { err: new PublisherBackgroundWorkCoordinatorClosedError().message },
          'Publisher chat-comment recovery sweep failed',
        ],
      ]);
      expect(h.identity.assertAttested).not.toHaveBeenCalled();
      expect(h.findMany).not.toHaveBeenCalled();
      const closing = observe(h.startRuntimeClose());
      await flushPromises();
      expect(closing.state).toMatchObject({ status: 'fulfilled', value: { forced: false } });
      expect(scheduledWarnings()).toHaveLength(1);
    });
  });
});
