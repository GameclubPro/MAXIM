import { WebhookStatus } from '@prisma/client';
import { getQueueToken } from '@nestjs/bullmq';
import { WebhookOutboxService } from './webhook-outbox.service';
import {
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  JOIN_WEBHOOK_QUEUE_NAMES,
  resolveDefaultWebhookQueueNameForChatId,
  resolveJoinWebhookQueueNameForChatId,
  resolveWebhookQueueName,
} from './webhook-queues';

type JobMock = {
  getState: jest.Mock<Promise<string>, []>;
  retry: jest.Mock<Promise<void>, []>;
  remove: jest.Mock<Promise<void>, []>;
  failedReason?: string;
};

type QueueMock = {
  add: jest.Mock<Promise<void>, [string, { webhookEventId: string }, Record<string, unknown>]>;
  getJob: jest.Mock<Promise<JobMock | null | undefined>, [string]>;
};

type DefaultShardQueueMocks = Record<(typeof DEFAULT_WEBHOOK_QUEUE_NAMES)[number], QueueMock>;
type JoinShardQueueMocks = Record<(typeof JOIN_WEBHOOK_QUEUE_NAMES)[number], QueueMock>;
type QueueSet = {
  criticalQueue: QueueMock;
  backgroundQueue: QueueMock;
  legacyQueue: QueueMock;
} & DefaultShardQueueMocks &
  JoinShardQueueMocks;

type MockWebhookEventRow = {
  id: string;
  status: WebhookStatus;
  botId: string | null;
  queueName: string | null;
  enqueueAttempts: number;
  createdAt: Date;
  queuedAt: Date | null;
  nextEnqueueAt: Date | null;
  processedAt: Date | null;
  normalizedPayload: unknown;
};

function matchesDateFilter(value: Date | null, filter: unknown): boolean {
  if (!(filter && typeof filter === 'object')) {
    return true;
  }

  const rowMs = value?.getTime() ?? null;
  if (rowMs === null) {
    return false;
  }

  const lte = (filter as { lte?: Date }).lte;
  if (lte instanceof Date && rowMs > lte.getTime()) {
    return false;
  }

  return true;
}

function matchesScalarFilter<T>(value: T | null, filter: unknown): boolean {
  if (filter === undefined) {
    return true;
  }

  if (filter === null) {
    return value === null;
  }

  if (filter && typeof filter === 'object' && 'not' in (filter as Record<string, unknown>)) {
    return value !== ((filter as { not?: T | null }).not ?? null);
  }

  return value === filter;
}

function matchesWebhookEventWhere(
  row: MockWebhookEventRow,
  where: Record<string, unknown> | undefined,
): boolean {
  if (!where) {
    return true;
  }

  if (Array.isArray(where.AND)) {
    const andMatched = where.AND.every((entry) =>
      matchesWebhookEventWhere(row, entry as Record<string, unknown> | undefined),
    );
    if (!andMatched) {
      return false;
    }
  }

  if (Array.isArray(where.OR)) {
    const orMatched = where.OR.some((entry) =>
      matchesWebhookEventWhere(row, entry as Record<string, unknown> | undefined),
    );
    if (!orMatched) {
      return false;
    }
  }

  if (!matchesScalarFilter(row.status, where.status)) {
    return false;
  }

  if (!matchesScalarFilter(row.queueName, where.queueName)) {
    return false;
  }

  if (!matchesScalarFilter(row.processedAt, where.processedAt)) {
    return false;
  }

  if (!matchesDateFilter(row.createdAt, where.createdAt)) {
    return false;
  }

  if (!matchesDateFilter(row.queuedAt, where.queuedAt)) {
    return false;
  }

  if (!matchesDateFilter(row.nextEnqueueAt, where.nextEnqueueAt)) {
    return false;
  }

  return true;
}

function createService(params?: {
  findManyResult?: Array<{
    id: string;
    status?: WebhookStatus;
    botId?: string | null;
    queueName?: string | null;
    enqueueAttempts: number;
    createdAt?: Date;
    queuedAt?: Date | null;
    nextEnqueueAt?: Date | null;
    processedAt?: Date | null;
    normalizedPayload?: unknown;
  }>;
  manualCloseChatIds?: string[];
  addError?: Error | null;
  criticalJob?: JobMock | null;
  defaultJob?: JobMock | null;
  backgroundJob?: JobMock | null;
  legacyJob?: JobMock | null;
  undefinedJobs?: boolean;
  configOverrides?: Partial<Record<string, number>>;
  resolvedQueueName?: string;
}) {
  const webhookRows: MockWebhookEventRow[] = (params?.findManyResult ?? []).map((item) => ({
    ...item,
    status: item.status ?? WebhookStatus.RECEIVED,
    botId: item.botId ?? null,
    queueName: item.queueName ?? null,
    createdAt: item.createdAt ?? new Date('2026-03-24T00:00:00.000Z'),
    queuedAt: item.queuedAt ?? null,
    nextEnqueueAt: item.nextEnqueueAt ?? null,
    processedAt: item.processedAt ?? null,
    normalizedPayload: item.normalizedPayload ?? null,
  }));

  const prisma = {
    webhookEvent: {
      findMany: jest
        .fn()
        .mockImplementation(async (args?: { where?: Record<string, unknown>; take?: number }) =>
          webhookRows
            .filter((row) => matchesWebhookEventWhere(row, args?.where))
            .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
            .slice(0, args?.take ?? Number.POSITIVE_INFINITY),
        ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    chatSettings: {
      findMany: jest.fn().mockResolvedValue(
        (params?.manualCloseChatIds ?? []).map((chatId) => ({
          chatId,
        })),
      ),
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
    getJob: jest.fn().mockResolvedValue(params?.undefinedJobs ? undefined : (job ?? null)),
  });

  const criticalQueue = createQueue(params?.addError, params?.criticalJob);
  const joinShardQueues = Object.fromEntries(
    JOIN_WEBHOOK_QUEUE_NAMES.map((queueName) => [queueName, createQueue(params?.addError, null)]),
  ) as JoinShardQueueMocks;
  const defaultShardQueues = Object.fromEntries(
    DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName, index) => [
      queueName,
      createQueue(params?.addError, index === 0 ? params?.defaultJob : null),
    ]),
  ) as DefaultShardQueueMocks;
  const backgroundQueue = createQueue(params?.addError, params?.backgroundJob);
  const legacyQueue = createQueue(params?.addError, params?.legacyJob);
  const queueTokens = Object.fromEntries(
    [...JOIN_WEBHOOK_QUEUE_NAMES, ...DEFAULT_WEBHOOK_QUEUE_NAMES].map((queueName) => [
      getQueueToken(queueName),
      queueName in joinShardQueues
        ? joinShardQueues[queueName as keyof JoinShardQueueMocks]
        : defaultShardQueues[queueName as keyof DefaultShardQueueMocks],
    ]),
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
    WEBHOOK_FAILED_RETENTION_HOURS: 24,
    MODERATION_RETENTION_DAYS: 90,
    ...(params?.configOverrides ?? {}),
  };
  const config = {
    get: jest.fn((key: string, fallback?: number) =>
      key in configValues ? configValues[key] : fallback,
    ),
  };

  const queues: QueueSet = {
    criticalQueue,
    ...joinShardQueues,
    ...defaultShardQueues,
    backgroundQueue,
    legacyQueue,
  };
  const webhookRoutingService = {
    resolveQueueName: jest.fn(
      async (_eventId: string, payload: unknown) =>
        params?.resolvedQueueName ?? resolveWebhookQueueName(payload),
    ),
  };

  const service = new WebhookOutboxService(
    prisma as never,
    config as never,
    moduleRef as never,
    webhookRoutingService as never,
    criticalQueue as never,
    backgroundQueue as never,
    legacyQueue as never,
  );
  return {
    service,
    prisma,
    queues,
    webhookRoutingService,
  };
}

describe('WebhookOutboxService', () => {
  it('requests FAILED candidates only when nextEnqueueAt is due', async () => {
    const { service, prisma } = createService();

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(prisma.webhookEvent.findMany.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            where: expect.objectContaining({
              status: WebhookStatus.FAILED,
              nextEnqueueAt: { lte: expect.any(Date) },
            }),
          }),
        ],
      ]),
    );
  });

  it('also rechecks ancient queued rows by createdAt, not only by queuedAt', async () => {
    const { service, prisma } = createService();

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(prisma.webhookEvent.findMany.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            where: expect.objectContaining({
              status: WebhookStatus.QUEUED,
              processedAt: null,
              AND: expect.arrayContaining([
                expect.objectContaining({
                  OR: expect.arrayContaining([
                    expect.objectContaining({ queuedAt: { lte: expect.any(Date) } }),
                    expect.objectContaining({ createdAt: { lte: expect.any(Date) } }),
                  ]),
                }),
              ]),
            }),
          }),
        ],
      ]),
    );
  });

  it('repairs stale queued user-facing rows after the fast repair window', async () => {
    const { service, queues } = createService({
      findManyResult: [
        {
          id: 'evt-fast-default',
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-default-0',
          queuedAt: new Date(Date.now() - 30_000),
          createdAt: new Date(Date.now() - 30_000),
          enqueueAttempts: 1,
          normalizedPayload: { type: 'message_created', message: { chatId: 'chat-1' } },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues['moderation-default-0'].add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-fast-default' },
      expect.objectContaining({ jobId: 'evt-fast-default' }),
    );
  });

  it('does not repair queued background rows before the slower background repair window', async () => {
    const { service, queues, prisma } = createService({
      findManyResult: [
        {
          id: 'evt-background-too-fresh',
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-background',
          queuedAt: new Date(Date.now() - 30_000),
          createdAt: new Date(Date.now() - 30_000),
          enqueueAttempts: 1,
          normalizedPayload: { type: 'user_removed', chatId: 'chat-1' },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues.backgroundQueue.add).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
  });

  it('does not increment attempts when existing job is already waiting', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('waiting'),
      retry: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
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

  it('does not refresh queuedAt when reconciling an already queued waiting job', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('waiting'),
      retry: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const { service, prisma } = createService({
      findManyResult: [
        {
          id: 'evt-queued-waiting',
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-default-0',
          queuedAt: new Date('2026-03-24T00:00:00.000Z'),
          enqueueAttempts: 5,
        },
      ],
      defaultJob: job,
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const updateArg = prisma.webhookEvent.updateMany.mock.calls[0][0];
    expect(updateArg.data.status).toBe(WebhookStatus.QUEUED);
    expect(updateArg.data.queuedAt).toBeUndefined();
    expect(updateArg.data.enqueueAttempts).toBeUndefined();
  });

  it('re-enqueues a stale queued event back into its stored queue to preserve ordering', async () => {
    const { service, queues } = createService({
      findManyResult: [
        {
          id: 'evt-stale-critical',
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-critical',
          queuedAt: new Date('2026-03-24T00:00:00.000Z'),
          enqueueAttempts: 1,
          normalizedPayload: { type: 'message_created', message: { chatId: 'chat-1' } },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues.criticalQueue.add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-stale-critical' },
      expect.objectContaining({
        jobId: 'evt-stale-critical',
      }),
    );
    expect(queues['moderation-default-0'].add).not.toHaveBeenCalled();
  });

  it('retries existing failed job and increments attempts once', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
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
      remove: jest.fn().mockResolvedValue(undefined),
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
          event: {
            id: string;
            status: WebhookStatus;
            botId: string | null;
            queueName: string | null;
            enqueueAttempts: number;
            createdAt: Date;
            queuedAt: Date | null;
            normalizedPayload: unknown;
          },
          priority: number,
          queueName: 'moderation-default-0',
        ) => Promise<void>;
      }
    ).enqueueOne(
      {
        id: 'evt-3',
        status: WebhookStatus.RECEIVED,
        botId: null,
        queueName: null,
        enqueueAttempts: 120,
        createdAt: new Date('2026-03-24T00:00:00.000Z'),
        queuedAt: null,
        normalizedPayload: { type: 'message_created', message: { chatId: 'chat-1' } },
      },
      6,
      'moderation-default-0',
    );

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

  it('preserves the terminal BullMQ failure reason when a failed job exhausts retries', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
      failedReason: 'Request failed with status code 503',
    };
    const { service, prisma } = createService();

    await (
      service as unknown as {
        retryFailedJob: (
          webhookEventId: string,
          enqueueAttempts: number,
          job: JobMock,
        ) => Promise<void>;
      }
    ).retryFailedJob('evt-terminal-503', 120, job);

    expect(job.retry).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WebhookStatus.FAILED,
          nextEnqueueAt: null,
          errorMessage: expect.stringContaining('Request failed with status code 503'),
        }),
      }),
    );
  });

  it('uses shorter cleanup retention for exhausted failed webhook rows', async () => {
    const { service, prisma } = createService({
      configOverrides: {
        WEBHOOK_RETENTION_DAYS: 7,
        WEBHOOK_FAILED_RETENTION_HOURS: 24,
        MODERATION_RETENTION_DAYS: 90,
      },
    });

    await (service as unknown as { cleanupRetention: () => Promise<void> }).cleanupRetention();

    expect(prisma.webhookEvent.deleteMany).toHaveBeenNthCalledWith(1, {
      where: {
        createdAt: { lt: expect.any(Date) },
        status: { in: [WebhookStatus.PROCESSED, WebhookStatus.DUPLICATE] },
      },
    });
    expect(prisma.webhookEvent.deleteMany).toHaveBeenNthCalledWith(2, {
      where: {
        createdAt: { lt: expect.any(Date) },
        status: WebhookStatus.FAILED,
        nextEnqueueAt: null,
      },
    });
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

  it('uses a wider priority selection window than the enqueue batch size', async () => {
    const { service, prisma } = createService({
      configOverrides: { ENQUEUE_BATCH_SIZE: 2 },
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(prisma.webhookEvent.findMany.mock.calls).toEqual(
      expect.arrayContaining([[expect.objectContaining({ take: 6 })]]),
    );
  });

  it('enqueues high-priority membership joins before older message_created events', async () => {
    const joinChatId = '-72826040868309';
    const joinQueueName = resolveJoinWebhookQueueNameForChatId(joinChatId);
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
          normalizedPayload: { type: 'user_added', message: { chatId: joinChatId } },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues[joinQueueName].add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-user-added',
    ]);
    expect(
      queues['moderation-default-0'].add.mock.calls.map((call) => call[1].webhookEventId),
    ).toEqual(['evt-message']);
  });

  it('prioritizes manual-close messages ahead of older regular messages', async () => {
    const { service, queues } = createService({
      configOverrides: { ENQUEUE_BATCH_SIZE: 1 },
      manualCloseChatIds: ['chat-manual'],
      findManyResult: [
        {
          id: 'evt-regular-message',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId: 'chat-regular' },
          },
        },
        {
          id: 'evt-manual-close-message',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId: 'chat-manual' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues.criticalQueue.add).toHaveBeenCalledTimes(1);
    expect(queues.criticalQueue.add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-manual-close-message' },
      expect.objectContaining({
        jobId: 'evt-manual-close-message',
        priority: 3,
      }),
    );
    expect(queues['moderation-default-0'].add).not.toHaveBeenCalled();
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
      remove: jest.fn().mockResolvedValue(undefined),
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

  it('skips standby shared-chat message_created events before they enter BullMQ', async () => {
    const { service, prisma, queues } = createService({
      findManyResult: [
        {
          id: 'evt-standby-message',
          enqueueAttempts: 0,
          botId: 'id613002203036_4_bot',
          normalizedPayload: {
            type: 'message_created',
            botId: 'id613002203036_4_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: { chatId: '-100123' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues['moderation-default-0'].add).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WebhookStatus.PROCESSED,
          queueName: null,
        }),
      }),
    );
  });

  it('skips standby shared-chat user_added events before they enter BullMQ', async () => {
    const { service, prisma, queues } = createService({
      findManyResult: [
        {
          id: 'evt-standby-user-added',
          enqueueAttempts: 0,
          botId: 'id613002203036_4_bot',
          normalizedPayload: {
            type: 'user_added',
            botId: 'id613002203036_4_bot',
            executionOwnerBotId: 'id613002203036_bot',
            user: { chatId: '-100123' },
            chatId: '-100123',
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    for (const queueName of JOIN_WEBHOOK_QUEUE_NAMES) {
      expect(queues[queueName].add).not.toHaveBeenCalled();
    }
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WebhookStatus.PROCESSED,
          queueName: null,
        }),
      }),
    );
  });

  it('removes queued standby shared-chat jobs and marks them processed', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('prioritized'),
      retry: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const { service, prisma, queues } = createService({
      findManyResult: [
        {
          id: 'evt-standby-queued',
          enqueueAttempts: 2,
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-default-0',
          botId: 'id613002203036_4_bot',
          normalizedPayload: {
            type: 'message_created',
            botId: 'id613002203036_4_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: { chatId: '-100123' },
          },
        },
      ],
      defaultJob: job,
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues['moderation-default-0'].getJob).toHaveBeenCalledWith('evt-standby-queued');
    expect(job.remove).toHaveBeenCalledTimes(1);
    expect(queues['moderation-default-0'].add).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WebhookStatus.PROCESSED,
        }),
      }),
    );
  });
});
