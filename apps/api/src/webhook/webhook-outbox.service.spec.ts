import { WebhookStatus } from '@prisma/client';
import { getQueueToken } from '@nestjs/bullmq';
import { WebhookOutboxService } from './webhook-outbox.service';
import {
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  resolveDefaultWebhookQueueNameForChatId,
} from './webhook-queues';

type JobMock = {
  getState: jest.Mock<Promise<string>, []>;
  retry: jest.Mock<Promise<void>, []>;
};

type QueueMock = {
  add: jest.Mock<Promise<void>, [string, { webhookEventId: string }, Record<string, unknown>]>;
  getJob: jest.Mock<Promise<JobMock | null | undefined>, [string]>;
};

type DefaultShardQueueMocks = Record<(typeof DEFAULT_WEBHOOK_QUEUE_NAMES)[number], QueueMock>;
type QueueSet = {
  criticalQueue: QueueMock;
  backgroundQueue: QueueMock;
  legacyQueue: QueueMock;
} & DefaultShardQueueMocks;

function createService(params?: {
  findManyResult?: Array<{
    id: string;
    enqueueAttempts: number;
    createdAt?: Date;
    normalizedPayload?: unknown;
  }>;
  addError?: Error | null;
  criticalJob?: JobMock | null;
  defaultJob?: JobMock | null;
  backgroundJob?: JobMock | null;
  legacyJob?: JobMock | null;
  undefinedJobs?: boolean;
}) {
  const prisma = {
    webhookEvent: {
      findMany: jest.fn().mockResolvedValue(
        (params?.findManyResult ?? []).map((item) => ({
          ...item,
          createdAt: item.createdAt ?? new Date('2026-03-24T00:00:00.000Z'),
        })),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    moderationEvent: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    violation: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };

  const createQueue = (
    addError: Error | null | undefined,
    job: JobMock | null | undefined,
  ): QueueMock => ({
    add: addError ? jest.fn().mockRejectedValue(addError) : jest.fn().mockResolvedValue(undefined),
    getJob: jest
      .fn()
      .mockResolvedValue(params?.undefinedJobs ? undefined : (job ?? null)),
  });

  const criticalQueue = createQueue(params?.addError, params?.criticalJob);
  const defaultShardQueues = Object.fromEntries(
    DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName, index) => [
      queueName,
      createQueue(params?.addError, index === 0 ? params?.defaultJob : null),
    ]),
  ) as DefaultShardQueueMocks;
  const backgroundQueue = createQueue(params?.addError, params?.backgroundJob);
  const legacyQueue = createQueue(params?.addError, params?.legacyJob);
  const queueTokens = Object.fromEntries(
    DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName) => [getQueueToken(queueName), defaultShardQueues[queueName]]),
  );
  const moduleRef = {
    get: jest.fn((token: string) => queueTokens[token]),
  };

  const configValues: Record<string, number> = {
    ENQUEUE_POLL_INTERVAL_MS: 500,
    ENQUEUE_BATCH_SIZE: 200,
    ENQUEUE_CONCURRENCY: 25,
    ENQUEUE_MAX_ATTEMPTS: 120,
    WEBHOOK_RETENTION_DAYS: 7,
    MODERATION_RETENTION_DAYS: 90,
  };
  const config = {
    get: jest.fn((key: string, fallback?: number) =>
      key in configValues ? configValues[key] : fallback,
    ),
  };

  const queues: QueueSet = {
    criticalQueue,
    ...defaultShardQueues,
    backgroundQueue,
    legacyQueue,
  };

  const service = new WebhookOutboxService(
    prisma as never,
    config as never,
    moduleRef as never,
    criticalQueue as never,
    backgroundQueue as never,
    legacyQueue as never,
  );
  return {
    service,
    prisma,
    queues,
  };
}

describe('WebhookOutboxService', () => {
  it('requests FAILED candidates only when nextEnqueueAt is due', async () => {
    const { service, prisma } = createService();

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(prisma.webhookEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              status: WebhookStatus.FAILED,
              nextEnqueueAt: { lte: expect.any(Date) },
            }),
          ]),
        }),
      }),
    );
  });

  it('does not increment attempts when existing job is already waiting', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('waiting'),
      retry: jest.fn().mockResolvedValue(undefined),
    };
    const { service, prisma } = createService({
      findManyResult: [{ id: 'evt-1', enqueueAttempts: 5 }],
      addError: new Error('Job evt-1 already exists'),
      defaultJob: job,
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const updateArg = prisma.webhookEvent.updateMany.mock.calls[0][0];
    expect(updateArg.data.status).toBe(WebhookStatus.QUEUED);
    expect(updateArg.data.queuedAt).toBeInstanceOf(Date);
    expect(updateArg.data.enqueueAttempts).toBeUndefined();
    expect(job.retry).not.toHaveBeenCalled();
  });

  it('retries existing failed job and increments attempts once', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
    };
    const { service, prisma } = createService({
      findManyResult: [{ id: 'evt-2', enqueueAttempts: 5 }],
      addError: new Error('Job evt-2 already exists'),
      defaultJob: job,
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(job.retry).toHaveBeenCalledTimes(1);
    const updateArg = prisma.webhookEvent.updateMany.mock.calls[0][0];
    expect(updateArg.data.status).toBe(WebhookStatus.QUEUED);
    expect(updateArg.data.enqueueAttempts).toEqual({ increment: 1 });
  });

  it('retries an existing failed job before attempting duplicate add', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
    };
    const { service, prisma, queues } = createService({
      findManyResult: [{ id: 'evt-2b', enqueueAttempts: 5 }],
      defaultJob: job,
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues['moderation-default-0'].getJob).toHaveBeenCalledWith('evt-2b');
    expect(queues['moderation-default-0'].add).not.toHaveBeenCalled();
    expect(job.retry).toHaveBeenCalledTimes(1);
    const updateArg = prisma.webhookEvent.updateMany.mock.calls[0][0];
    expect(updateArg.data.status).toBe(WebhookStatus.QUEUED);
    expect(updateArg.data.enqueueAttempts).toEqual({ increment: 1 });
  });

  it('marks event as FAILED without re-enqueue when max attempts is reached', async () => {
    const { service, prisma, queues } = createService();

    await (
      service as unknown as {
        enqueueOne: (
          id: string,
          attempts: number,
          priority: number,
          queueName: 'moderation-default-0',
        ) => Promise<void>;
      }
    ).enqueueOne('evt-3', 120, 6, 'moderation-default-0');

    expect(queues['moderation-default-0'].add).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WebhookStatus.FAILED,
          nextEnqueueAt: null,
        }),
      }),
    );
  });

  it('assigns highest BullMQ priority to callback events', async () => {
    const { service, queues } = createService({
      findManyResult: [
        {
          id: 'evt-callback',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: { type: 'message_callback' },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues.criticalQueue.add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-callback' },
      expect.objectContaining({
        jobId: 'evt-callback',
        priority: 1,
      }),
    );
  });

  it('enqueues high-priority membership joins before older message_created events', async () => {
    const { service, queues } = createService({
      findManyResult: [
        {
          id: 'evt-message',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: { type: 'message_created' },
        },
        {
          id: 'evt-user-added',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:05.000Z'),
          normalizedPayload: { type: 'user_added' },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues.criticalQueue.add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-user-added',
    ]);
    expect(
      queues['moderation-default-0'].add.mock.calls.map((call) => call[1].webhookEventId),
    ).toEqual(['evt-message']);
  });

  it('routes membership leave events into the background queue', async () => {
    const { service, queues } = createService({
      findManyResult: [
        {
          id: 'evt-user-removed',
          enqueueAttempts: 0,
          normalizedPayload: { type: 'user_removed' },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues.backgroundQueue.add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-user-removed' },
      expect.objectContaining({
        jobId: 'evt-user-removed',
      }),
    );
  });

  it('retries existing jobs found in the legacy queue before scheduling new work', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
    };
    const { service, queues } = createService({
      findManyResult: [{ id: 'evt-legacy', enqueueAttempts: 1 }],
      legacyJob: job,
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues.legacyQueue.getJob).toHaveBeenCalledWith('evt-legacy');
    expect(job.retry).toHaveBeenCalledTimes(1);
    expect(queues['moderation-default-0'].add).not.toHaveBeenCalled();
  });

  it('treats undefined BullMQ lookups as missing jobs and enqueues normally', async () => {
    const { service, queues } = createService({
      findManyResult: [{ id: 'evt-undefined', enqueueAttempts: 0 }],
      undefinedJobs: true,
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues['moderation-default-0'].add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-undefined' },
      expect.objectContaining({
        jobId: 'evt-undefined',
      }),
    );
  });

  it('shards message_created events by chatId across default queues', async () => {
    const { service, queues } = createService({
      findManyResult: [
        {
          id: 'evt-chat-a',
          enqueueAttempts: 0,
          normalizedPayload: { type: 'message_created', message: { chatId: 'a' } },
        },
        {
          id: 'evt-chat-b',
          enqueueAttempts: 0,
          normalizedPayload: { type: 'message_created', message: { chatId: 'b' } },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const shardAdds = DEFAULT_WEBHOOK_QUEUE_NAMES.flatMap((queueName) =>
      queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId),
    );
    const queueForChatA = resolveDefaultWebhookQueueNameForChatId('a');
    const queueForChatB = resolveDefaultWebhookQueueNameForChatId('b');

    expect(shardAdds.sort()).toEqual(['evt-chat-a', 'evt-chat-b']);
    expect(queues[queueForChatA].add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-chat-a' },
      expect.objectContaining({ jobId: 'evt-chat-a' }),
    );
    expect(queues[queueForChatB].add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-chat-b' },
      expect.objectContaining({ jobId: 'evt-chat-b' }),
    );
    expect(new Set([queueForChatA, queueForChatB]).size).toBeGreaterThan(1);
  });
});
