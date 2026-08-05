import { DelayedError, type Job } from 'bullmq';
import { PhotoDuplicateProcessor } from './photo-duplicate.processor';
import {
  PHOTO_DUPLICATE_ORDERING_DEFER_MS,
  PHOTO_DUPLICATE_SOURCE_READY_DEFER_MS,
  PHOTO_DUPLICATE_SOURCE_READY_MAX_WAIT_MS,
  PhotoDuplicateSourceNotReadyError,
  type PhotoDuplicateJob,
} from './photo-duplicate.queue';

const sourceCreatedAt = '2026-08-05T12:00:00.000Z';
const idempotencyKey = `photo-duplicate__${'a'.repeat(64)}`;
const queuedAtMs = new Date('2026-08-05T12:29:00.000Z').getTime();

function buildJob(
  overrides: { attemptsMade?: number; attempts?: number; timestamp?: number } = {},
) {
  return {
    id: 'bullmq-job-id',
    data: {
      webhookEventId: 'webhook-event-1',
      chatId: 'chat-1',
      messageId: 'message-1',
      sourceCreatedAt,
      algorithmVersion: 1,
      idempotencyKey,
      retryPolicyName: 'photo-duplicate',
    },
    opts: { attempts: overrides.attempts ?? 5 },
    attemptsMade: overrides.attemptsMade ?? 0,
    timestamp: overrides.timestamp ?? queuedAtMs,
    moveToDelayed: jest.fn().mockResolvedValue(undefined),
  } as unknown as Job<PhotoDuplicateJob>;
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
      runInOrder: jest.fn().mockImplementation(async (_identity, operation) => {
        await operation({ assertOwned: jest.fn() });
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
      runInOrder: jest.fn().mockImplementation(async (_identity, operation) => {
        await operation({ assertOwned: jest.fn() });
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
      runInOrder: jest.fn().mockImplementation(async (_identity, operation) => ({
        kind: 'completed',
        value: await operation({ assertOwned: jest.fn() }),
      })),
      abandon: jest.fn(),
    };
    const processor = new PhotoDuplicateProcessor(
      moderationExecutionService as never,
      orderingStore as never,
    );

    await expect(processor.process(job)).resolves.toBeUndefined();

    expect(moderationExecutionService.processPhotoDuplicateJob).toHaveBeenCalledWith(
      job.data,
      expect.objectContaining({ assertOwned: expect.any(Function) }),
    );
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(orderingStore.abandon).not.toHaveBeenCalled();
  });

  it('abandons ordering state when the claimed operation exhausts its attempts', async () => {
    const job = buildJob({ attemptsMade: 4, attempts: 5 });
    const processingError = new Error('moderation failed');
    const moderationExecutionService = {
      processPhotoDuplicateJob: jest.fn().mockRejectedValue(processingError),
    };
    const orderingStore = {
      runInOrder: jest.fn().mockImplementation(async (_identity, operation) => {
        await operation({ assertOwned: jest.fn() });
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
