import { DelayedError, type Job } from 'bullmq';
import { PhotoDuplicateProcessor } from './photo-duplicate.processor';
import {
  PHOTO_DUPLICATE_ORDERING_DEFER_MS,
  PHOTO_DUPLICATE_ALGORITHM_VERSION,
  PHOTO_DUPLICATE_SOURCE_READY_DEFER_MS,
  PHOTO_DUPLICATE_SOURCE_READY_MAX_WAIT_MS,
  PhotoDuplicateSourceNotReadyError,
  type PhotoDuplicateJob,
} from './photo-duplicate.queue';

const sourceCreatedAt = '2026-08-05T12:00:00.000Z';
const idempotencyKey = `photo-duplicate__${'a'.repeat(64)}`;
const queuedAtMs = new Date('2026-08-05T12:29:00.000Z').getTime();

function buildJob(
  overrides: {
    attemptsMade?: number;
    attempts?: number;
    timestamp?: number;
    actionEligible?: unknown;
  } = {},
) {
  const data: Record<string, unknown> = {
    webhookEventId: 'webhook-event-1',
    chatId: 'chat-1',
    messageId: 'message-1',
    sourceCreatedAt,
    algorithmVersion: PHOTO_DUPLICATE_ALGORITHM_VERSION,
    actionEligible: overrides.actionEligible ?? true,
    idempotencyKey,
    retryPolicyName: 'photo-duplicate',
  };
  if (Object.prototype.hasOwnProperty.call(overrides, 'actionEligible')) {
    data.actionEligible = overrides.actionEligible;
  }
  return {
    id: 'bullmq-job-id',
    data,
    opts: { attempts: overrides.attempts ?? 5 },
    attemptsMade: overrides.attemptsMade ?? 0,
    timestamp: overrides.timestamp ?? queuedAtMs,
    moveToDelayed: jest.fn().mockResolvedValue(undefined),
  } as unknown as Job<PhotoDuplicateJob>;
}

function buildLease(actionEligible = true) {
  return {
    assertOwned: jest.fn(),
    resolveActionEligibility: jest.fn().mockResolvedValue(actionEligible),
  };
}

describe('PhotoDuplicateProcessor', () => {
  const originalAppRole = process.env.APP_ROLE;

  beforeEach(() => {
    process.env.APP_ROLE = 'moderation';
  });

  afterEach(() => {
    if (originalAppRole === undefined) {
      delete process.env.APP_ROLE;
    } else {
      process.env.APP_ROLE = originalAppRole;
    }
    jest.useRealTimers();
  });

  it('moves a non-head job to delayed without consuming an attempt', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T12:30:00.000Z'));
    const job = buildJob();
    const moderationExecutionService = {
      processPhotoDuplicateJob: jest.fn(),
    };
    const orderingStore = {
      runInOrder: jest.fn().mockResolvedValue({ kind: 'defer', reason: 'not_head' }),
      abandon: jest.fn(),
    };
    const processor = new PhotoDuplicateProcessor(
      moderationExecutionService as never,
      orderingStore as never,
    );

    await expect(processor.process(job, 'lock-token')).rejects.toBeInstanceOf(DelayedError);

    expect(orderingStore.runInOrder).toHaveBeenCalledWith(
      { jobId: idempotencyKey, chatId: 'chat-1', sourceCreatedAt },
      true,
      expect.any(Function),
    );
    expect(moderationExecutionService.processPhotoDuplicateJob).not.toHaveBeenCalled();
    expect(job.moveToDelayed).toHaveBeenCalledWith(
      new Date('2026-08-05T12:30:00.000Z').getTime() + PHOTO_DUPLICATE_ORDERING_DEFER_MS,
      'lock-token',
    );
    expect(orderingStore.abandon).not.toHaveBeenCalled();
  });

  it('moves an unfinished source webhook to delayed without consuming its final attempt', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T12:30:00.000Z'));
    const job = buildJob({ attemptsMade: 4, attempts: 5 });
    const moderationExecutionService = {
      processPhotoDuplicateJob: jest
        .fn()
        .mockRejectedValue(new PhotoDuplicateSourceNotReadyError('webhook-event-1')),
    };
    const orderingStore = {
      runInOrder: jest.fn().mockImplementation(async (_identity, _actionEligible, operation) => {
        await operation(buildLease(), true);
        return { kind: 'completed', value: undefined };
      }),
      abandon: jest.fn(),
    };
    const processor = new PhotoDuplicateProcessor(
      moderationExecutionService as never,
      orderingStore as never,
    );

    await expect(processor.process(job, 'lock-token')).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledWith(
      new Date('2026-08-05T12:30:00.000Z').getTime() + PHOTO_DUPLICATE_SOURCE_READY_DEFER_MS,
      'lock-token',
    );
    expect(orderingStore.abandon).not.toHaveBeenCalled();
  });

  it('abandons an unfinished source webhook after the bounded readiness window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T12:30:00.000Z'));
    const job = buildJob({
      timestamp:
        new Date('2026-08-05T12:30:00.000Z').getTime() - PHOTO_DUPLICATE_SOURCE_READY_MAX_WAIT_MS,
    });
    const moderationExecutionService = {
      processPhotoDuplicateJob: jest
        .fn()
        .mockRejectedValue(new PhotoDuplicateSourceNotReadyError('webhook-event-1')),
    };
    const orderingStore = {
      runInOrder: jest.fn().mockImplementation(async (_identity, _actionEligible, operation) => {
        await operation(buildLease(), true);
        return { kind: 'completed', value: undefined };
      }),
      abandon: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new PhotoDuplicateProcessor(
      moderationExecutionService as never,
      orderingStore as never,
    );

    await expect(processor.process(job, 'lock-token')).resolves.toBeUndefined();

    expect(orderingStore.abandon).toHaveBeenCalledWith({
      jobId: idempotencyKey,
      chatId: 'chat-1',
      sourceCreatedAt,
    });
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('executes a claimed operation and completes the processor job', async () => {
    const job = buildJob();
    const moderationExecutionService = {
      processPhotoDuplicateJob: jest.fn().mockResolvedValue(undefined),
    };
    const orderingStore = {
      runInOrder: jest.fn().mockImplementation(async (_identity, _actionEligible, operation) => ({
        kind: 'completed',
        value: await operation(buildLease(), true),
      })),
      abandon: jest.fn(),
    };
    const processor = new PhotoDuplicateProcessor(
      moderationExecutionService as never,
      orderingStore as never,
    );

    await expect(processor.process(job)).resolves.toBeUndefined();

    expect(moderationExecutionService.processPhotoDuplicateJob).toHaveBeenCalledWith(
      expect.objectContaining({ actionEligible: true }),
      expect.objectContaining({ assertOwned: expect.any(Function) }),
    );
    expect(
      Object.isFrozen(moderationExecutionService.processPhotoDuplicateJob.mock.calls[0]![0]),
    ).toBe(true);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(orderingStore.abandon).not.toHaveBeenCalled();
  });

  it('preserves an observation-only latch across processor retries', async () => {
    const job = buildJob({ actionEligible: false });
    const moderationExecutionService = {
      processPhotoDuplicateJob: jest.fn().mockResolvedValue(undefined),
    };
    const orderingStore = {
      runInOrder: jest.fn().mockImplementation(async (_identity, _actionEligible, operation) => ({
        kind: 'completed',
        value: await operation(buildLease(), true),
      })),
      abandon: jest.fn(),
    };
    const processor = new PhotoDuplicateProcessor(
      moderationExecutionService as never,
      orderingStore as never,
    );

    await expect(processor.process(job)).resolves.toBeUndefined();
    await expect(processor.process(job)).resolves.toBeUndefined();

    expect(moderationExecutionService.processPhotoDuplicateJob).toHaveBeenCalledTimes(2);
    for (const [data] of moderationExecutionService.processPhotoDuplicateJob.mock.calls) {
      expect(data).toEqual(expect.objectContaining({ actionEligible: false }));
      expect(Object.isFrozen(data)).toBe(true);
    }
    expect(job.data.actionEligible).toBe(false);
  });

  it('downgrades a missing runtime latch instead of inferring action eligibility', async () => {
    const job = buildJob({ actionEligible: undefined });
    const moderationExecutionService = {
      processPhotoDuplicateJob: jest.fn().mockResolvedValue(undefined),
    };
    const orderingStore = {
      runInOrder: jest.fn().mockImplementation(async (_identity, _actionEligible, operation) => ({
        kind: 'completed',
        value: await operation(buildLease(), true),
      })),
      abandon: jest.fn(),
    };
    const processor = new PhotoDuplicateProcessor(
      moderationExecutionService as never,
      orderingStore as never,
    );

    await expect(processor.process(job)).resolves.toBeUndefined();

    expect(moderationExecutionService.processPhotoDuplicateJob).toHaveBeenCalledWith(
      expect.objectContaining({ actionEligible: false }),
      expect.objectContaining({ assertOwned: expect.any(Function) }),
    );
    expect(orderingStore.runInOrder).toHaveBeenCalledWith(
      { jobId: idempotencyKey, chatId: 'chat-1', sourceCreatedAt },
      false,
      expect.any(Function),
    );
  });

  it('keeps a permissive job observation-only when the ordering latch was downgraded', async () => {
    const job = buildJob({ actionEligible: true });
    const moderationExecutionService = {
      processPhotoDuplicateJob: jest.fn().mockResolvedValue(undefined),
    };
    const orderingStore = {
      runInOrder: jest.fn().mockImplementation(async (_identity, _actionEligible, operation) => ({
        kind: 'completed',
        value: await operation(buildLease(false), false),
      })),
      abandon: jest.fn(),
    };
    const processor = new PhotoDuplicateProcessor(
      moderationExecutionService as never,
      orderingStore as never,
    );

    await expect(processor.process(job)).resolves.toBeUndefined();

    expect(moderationExecutionService.processPhotoDuplicateJob).toHaveBeenCalledWith(
      expect.objectContaining({ actionEligible: false }),
      expect.objectContaining({ assertOwned: expect.any(Function) }),
    );
  });

  it('abandons ordering state when the claimed operation exhausts its attempts', async () => {
    const job = buildJob({ attemptsMade: 4, attempts: 5 });
    const processingError = new Error('moderation failed');
    const moderationExecutionService = {
      processPhotoDuplicateJob: jest.fn().mockRejectedValue(processingError),
    };
    const orderingStore = {
      runInOrder: jest.fn().mockImplementation(async (_identity, _actionEligible, operation) => {
        await operation(buildLease(), true);
        return { kind: 'completed', value: undefined };
      }),
      abandon: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new PhotoDuplicateProcessor(
      moderationExecutionService as never,
      orderingStore as never,
    );

    await expect(processor.process(job)).rejects.toBe(processingError);

    expect(orderingStore.abandon).toHaveBeenCalledWith({
      jobId: idempotencyKey,
      chatId: 'chat-1',
      sourceCreatedAt,
    });
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('abandons a deferred ordering head when its final attempt has no lock token', async () => {
    const job = buildJob({ attemptsMade: 4, attempts: 5 });
    const moderationExecutionService = {
      processPhotoDuplicateJob: jest.fn(),
    };
    const orderingStore = {
      runInOrder: jest.fn().mockResolvedValue({ kind: 'defer', reason: 'busy' }),
      abandon: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new PhotoDuplicateProcessor(
      moderationExecutionService as never,
      orderingStore as never,
    );

    await expect(processor.process(job)).rejects.toThrow(
      'Photo duplicate deferred without a lock token: busy',
    );

    expect(orderingStore.abandon).toHaveBeenCalledWith({
      jobId: idempotencyKey,
      chatId: 'chat-1',
      sourceCreatedAt,
    });
  });

  it('abandons a deferred ordering head when moveToDelayed fails on its final attempt', async () => {
    const job = buildJob({ attemptsMade: 4, attempts: 5 });
    const moveError = new Error('redis unavailable');
    (job.moveToDelayed as jest.Mock).mockRejectedValue(moveError);
    const moderationExecutionService = {
      processPhotoDuplicateJob: jest.fn(),
    };
    const orderingStore = {
      runInOrder: jest.fn().mockResolvedValue({ kind: 'defer', reason: 'not_head' }),
      abandon: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new PhotoDuplicateProcessor(
      moderationExecutionService as never,
      orderingStore as never,
    );

    await expect(processor.process(job, 'lock-token')).rejects.toThrow(
      'Photo duplicate defer failed: not_head',
    );

    expect(orderingStore.abandon).toHaveBeenCalledWith({
      jobId: idempotencyKey,
      chatId: 'chat-1',
      sourceCreatedAt,
    });
  });
});
