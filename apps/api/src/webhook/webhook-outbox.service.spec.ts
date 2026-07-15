import { WebhookStatus } from '../prisma/prisma-client';
import { getQueueToken } from '@nestjs/bullmq';
import { WebhookOutboxService } from './webhook-outbox.service';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
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
  dedupKey: string | null;
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

function resolveTestWebhookDedupKey(payload: unknown, rowBotId: string | null): string | null {
  const value =
    payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  if (!value) {
    return null;
  }
  const updateId = typeof value.updateId === 'string' ? value.updateId.trim() : '';
  if (!updateId) {
    return null;
  }
  const botId =
    typeof value.botId === 'string' && value.botId.trim().length > 0
      ? value.botId.trim()
      : (rowBotId ?? '').trim();
  return botId ? `${botId}:${updateId}` : updateId;
}

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
  const gte = (filter as { gte?: Date }).gte;
  if (gte instanceof Date && rowMs < gte.getTime()) {
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

  if (filter && typeof filter === 'object' && Array.isArray((filter as { in?: unknown }).in)) {
    return (filter as { in: unknown[] }).in.includes(value);
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

  if (!matchesScalarFilter(row.id, where.id)) {
    return false;
  }

  if (!matchesScalarFilter(row.dedupKey, where.dedupKey)) {
    return false;
  }

  if (!matchesScalarFilter(row.botId, where.botId)) {
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

function createStatusAwareUpdateManyMock(
  eventId: string,
  readStatus: () => WebhookStatus,
  writeStatus: (status: WebhookStatus) => void,
) {
  return async (args?: { where?: Record<string, unknown>; data?: { status?: WebhookStatus } }) => {
    const matched =
      matchesScalarFilter(eventId, args?.where?.id) &&
      matchesScalarFilter(readStatus(), args?.where?.status);

    if (matched && args?.data?.status) {
      writeStatus(args.data.status);
    }

    return { count: matched ? 1 : 0 };
  };
}

function createService(params?: {
  findManyResult?: Array<{
    id: string;
    dedupKey?: string | null;
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
  prepareResult?: {
    canonical: boolean;
    prepared: boolean;
    normalizedPayload: unknown;
    executionBotId: string | null;
  };
}) {
  const webhookRows: MockWebhookEventRow[] = (params?.findManyResult ?? []).map((item) => ({
    ...item,
    dedupKey:
      item.dedupKey ??
      resolveTestWebhookDedupKey(item.normalizedPayload, item.botId ?? null) ??
      null,
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
      findFirst: jest
        .fn()
        .mockImplementation(
          async (args?: { where?: Record<string, unknown> }) =>
            webhookRows.find((row) => matchesWebhookEventWhere(row, args?.where)) ?? null,
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
    moderationViolationMessageClaim: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    chatUserDisplayName: {
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
    USER_DISPLAY_NAME_RETENTION_DAYS: 180,
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
  const canonicalEventBySemanticKey = new Map<string, string>();
  for (const row of webhookRows) {
    if (row.status === WebhookStatus.RECEIVED) {
      continue;
    }
    const semanticKey = buildWebhookSemanticEventKey(row.normalizedPayload);
    if (semanticKey && !canonicalEventBySemanticKey.has(semanticKey)) {
      canonicalEventBySemanticKey.set(semanticKey, row.id);
    }
  }
  const webhookService = {
    preparePersistedWebhookEvent: jest.fn(async (eventId: string) => {
      const row = webhookRows.find((candidate) => candidate.id === eventId);
      if (params?.prepareResult) {
        return params.prepareResult;
      }
      const semanticKey = buildWebhookSemanticEventKey(row?.normalizedPayload);
      const canonicalEventId = semanticKey
        ? canonicalEventBySemanticKey.get(semanticKey)
        : undefined;
      if (semanticKey && !canonicalEventId) {
        canonicalEventBySemanticKey.set(semanticKey, eventId);
      }
      const canonical = !semanticKey || !canonicalEventId || canonicalEventId === eventId;
      if (!canonical) {
        await prisma.webhookEvent.updateMany({
          where: { id: eventId },
          data: {
            status: WebhookStatus.DUPLICATE,
          },
        });
      }
      return {
        canonical,
        prepared: true,
        normalizedPayload: row?.normalizedPayload ?? null,
        executionBotId:
          row?.normalizedPayload && typeof row.normalizedPayload === 'object'
            ? (((row.normalizedPayload as Record<string, unknown>).executionOwnerBotId as
                | string
                | null) ?? null)
            : null,
      };
    }),
  };

  const service = new WebhookOutboxService(
    prisma as never,
    config as never,
    moduleRef as never,
    webhookRoutingService as never,
    webhookService as never,
    criticalQueue as never,
    backgroundQueue as never,
    legacyQueue as never,
  );
  return {
    service,
    prisma,
    queues,
    webhookRoutingService,
    webhookService,
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

  it('uses queuedAt as the stale reference and falls back to createdAt only when it is missing', async () => {
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
                    expect.objectContaining({
                      queuedAt: null,
                      createdAt: { lte: expect.any(Date) },
                    }),
                  ]),
                }),
              ]),
            }),
          }),
        ],
      ]),
    );
  });

  it('does not repeatedly repair a newly queued old event', async () => {
    const { service, queues, prisma } = createService({
      findManyResult: [
        {
          id: 'evt-old-but-freshly-queued',
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-default-0',
          createdAt: new Date(Date.now() - 60 * 60 * 1_000),
          queuedAt: new Date(),
          enqueueAttempts: 1,
          normalizedPayload: { type: 'message_created', message: { chatId: 'chat-1' } },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues['moderation-default-0'].add).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
  });

  it('reserves enqueue capacity for received events while repairing an old queue backlog', async () => {
    const receivedRows = Array.from({ length: 4 }, (_, index) => ({
      id: `evt-received-${index}`,
      status: WebhookStatus.RECEIVED,
      enqueueAttempts: 0,
      createdAt: new Date(Date.now() - (4 - index) * 1_000),
      normalizedPayload: {
        updateId: `received-${index}`,
        type: 'message_created',
        message: { chatId: `received-chat-${index}`, messageId: `received-message-${index}` },
      },
    }));
    const staleQueuedRows = Array.from({ length: 8 }, (_, index) => ({
      id: `evt-stale-${index}`,
      status: WebhookStatus.QUEUED,
      queueName: 'moderation-default-0',
      enqueueAttempts: 1,
      createdAt: new Date(Date.now() - (60 + index) * 1_000),
      queuedAt: new Date(Date.now() - 30_000),
      normalizedPayload: {
        updateId: `stale-${index}`,
        type: 'message_callback',
      },
    }));
    const { service, queues } = createService({
      findManyResult: [...receivedRows, ...staleQueuedRows],
      configOverrides: { ENQUEUE_BATCH_SIZE: 4 },
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const enqueuedIds = Object.values(queues).flatMap((queue) =>
      queue.add.mock.calls.map((call) => call[1].webhookEventId),
    );
    expect(enqueuedIds).toHaveLength(4);
    expect(enqueuedIds.filter((id) => id.startsWith('evt-received-'))).toHaveLength(3);
    expect(enqueuedIds.filter((id) => id.startsWith('evt-stale-'))).toHaveLength(1);
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
      expect.objectContaining({
        jobId: 'evt-fast-default',
        removeOnComplete: true,
        removeOnFail: {
          age: 7 * 24 * 60 * 60,
          count: 5_000,
        },
      }),
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

  it('does not let ordinary enqueue mark a freshly failed event as queued', async () => {
    const chatId = 'race-chat';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    let storedStatus: WebhookStatus = WebhookStatus.RECEIVED;
    const { service, prisma, queues } = createService({
      findManyResult: [
        {
          id: 'evt-failed-after-add',
          status: WebhookStatus.RECEIVED,
          enqueueAttempts: 0,
          normalizedPayload: { type: 'message_created', message: { chatId } },
        },
      ],
    });
    queues[queueName].add.mockImplementation(async () => {
      storedStatus = WebhookStatus.FAILED;
    });
    prisma.webhookEvent.updateMany.mockImplementation(
      createStatusAwareUpdateManyMock(
        'evt-failed-after-add',
        () => storedStatus,
        (status) => {
          storedStatus = status;
        },
      ),
    );

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues[queueName].add).toHaveBeenCalledTimes(1);
    const updateArg = prisma.webhookEvent.updateMany.mock.calls[0][0];
    expect(updateArg.where.status.in).not.toContain(WebhookStatus.FAILED);
    expect(storedStatus).toBe(WebhookStatus.FAILED);
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

  it('allows explicit failed job retry to mark a failed event queued', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    let storedStatus: WebhookStatus = WebhookStatus.FAILED;
    const { service, prisma } = createService({
      findManyResult: [
        {
          id: 'evt-explicit-failed-retry',
          status: WebhookStatus.FAILED,
          enqueueAttempts: 5,
          nextEnqueueAt: new Date(Date.now() - 1_000),
        },
      ],
      defaultJob: job,
    });
    prisma.webhookEvent.updateMany.mockImplementation(
      createStatusAwareUpdateManyMock(
        'evt-explicit-failed-retry',
        () => storedStatus,
        (status) => {
          storedStatus = status;
        },
      ),
    );

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(job.retry).toHaveBeenCalledTimes(1);
    const updateArg = prisma.webhookEvent.updateMany.mock.calls[0][0];
    expect(updateArg.where.status.in).toContain(WebhookStatus.FAILED);
    expect(storedStatus).toBe(WebhookStatus.QUEUED);
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
        USER_DISPLAY_NAME_RETENTION_DAYS: 180,
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
    expect(prisma.moderationViolationMessageClaim.deleteMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: expect.any(Date) },
      },
    });
    expect(prisma.chatUserDisplayName.deleteMany).toHaveBeenCalledWith({
      where: {
        observedAt: { lt: expect.any(Date) },
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

  it('enqueues standby-only shared-chat message_created events as recovery deliveries', async () => {
    const chatId = '-100123';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, prisma, queues } = createService({
      findManyResult: [
        {
          id: 'evt-standby-message',
          enqueueAttempts: 0,
          botId: 'id613002203036_4_bot',
          normalizedPayload: {
            updateId: 'u-standby-message-only',
            type: 'message_created',
            botId: 'id613002203036_4_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: { chatId, messageId: 'mid-owner-retryable' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues[queueName].add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-standby-message' },
      expect.objectContaining({ jobId: 'evt-standby-message' }),
    );
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WebhookStatus.QUEUED,
          queueName,
        }),
      }),
    );
  });

  it('skips standby shared-chat events while the owner failed delivery is retryable', async () => {
    const chatId = '-100123';
    const retryAt = new Date(Date.now() + 15_000);
    const { service, prisma, queues } = createService({
      findManyResult: [
        {
          id: 'evt-owner-retryable-failed',
          status: WebhookStatus.FAILED,
          enqueueAttempts: 1,
          botId: 'id613002203036_bot',
          nextEnqueueAt: retryAt,
          normalizedPayload: {
            updateId: 'u-owner-retryable-failed',
            type: 'message_created',
            botId: 'id613002203036_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: { chatId, messageId: 'mid-owner-retryable' },
          },
        },
        {
          id: 'evt-standby-owner-retryable',
          enqueueAttempts: 0,
          botId: 'id613002203036_4_bot',
          normalizedPayload: {
            updateId: 'u-owner-retryable-failed',
            type: 'message_created',
            botId: 'id613002203036_4_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: { chatId, messageId: 'mid-owner-retryable' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const queuedIds = DEFAULT_WEBHOOK_QUEUE_NAMES.flatMap((queueName) =>
      queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId),
    );
    const duplicateIds = prisma.webhookEvent.updateMany.mock.calls
      .filter(([args]) => args.data.status === WebhookStatus.DUPLICATE)
      .map(([args]) => args.where.id);

    expect(queuedIds).toEqual([]);
    expect(duplicateIds).toContain('evt-standby-owner-retryable');
  });

  it('skips standby shared-chat events with different update ids when the owner has the same message', async () => {
    const chatId = '-100123';
    const { service, prisma, queues } = createService({
      findManyResult: [
        {
          id: 'evt-owner-same-message',
          status: WebhookStatus.QUEUED,
          enqueueAttempts: 0,
          botId: 'id613002203036_bot',
          normalizedPayload: {
            updateId: 'u-owner-same-message',
            type: 'message_created',
            botId: 'id613002203036_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: {
              chatId,
              messageId: 'mid-shared-semantic-1',
            },
          },
        },
        {
          id: 'evt-standby-same-message',
          enqueueAttempts: 0,
          botId: 'id613002203036_4_bot',
          normalizedPayload: {
            updateId: 'u-standby-same-message',
            type: 'message_created',
            botId: 'id613002203036_4_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: {
              chatId,
              messageId: 'mid-shared-semantic-1',
            },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const queuedIds = DEFAULT_WEBHOOK_QUEUE_NAMES.flatMap((queueName) =>
      queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId),
    );
    const duplicateIds = prisma.webhookEvent.updateMany.mock.calls
      .filter(([args]) => args.data.status === WebhookStatus.DUPLICATE)
      .map(([args]) => args.where.id);

    expect(queuedIds).toEqual(['evt-owner-same-message']);
    expect(duplicateIds).toContain('evt-standby-same-message');
  });

  it('does not execute a mirrored receipt after the canonical claim failed terminally', async () => {
    const chatId = '-100123';
    const { service, queues } = createService({
      findManyResult: [
        {
          id: 'evt-owner-terminal-failed',
          status: WebhookStatus.FAILED,
          enqueueAttempts: 120,
          botId: 'id613002203036_bot',
          nextEnqueueAt: null,
          normalizedPayload: {
            updateId: 'u-owner-terminal-failed',
            type: 'message_created',
            botId: 'id613002203036_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: { chatId, messageId: 'mid-owner-terminal' },
          },
        },
        {
          id: 'evt-standby-owner-terminal',
          enqueueAttempts: 0,
          botId: 'id613002203036_4_bot',
          normalizedPayload: {
            updateId: 'u-owner-terminal-failed',
            type: 'message_created',
            botId: 'id613002203036_4_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: { chatId, messageId: 'mid-owner-terminal' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    for (const queueName of DEFAULT_WEBHOOK_QUEUE_NAMES) {
      expect(queues[queueName].add).not.toHaveBeenCalled();
    }
  });

  it('skips N-way mirrored standby message_created events before BullMQ and enqueues only the owner', async () => {
    const chatId = '-100123';
    const ownerBotId = 'bot-1';
    const botIds = ['bot-1', 'bot-2', 'bot-3', 'bot-4', 'bot-5', 'bot-6'];
    const ownerEventId = 'evt-mirrored-bot-1';
    const standbyEventIds = botIds.slice(1).map((botId) => `evt-mirrored-${botId}`);
    const ownerQueueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, prisma, queues, webhookService } = createService({
      configOverrides: {
        ENQUEUE_CONCURRENCY: 6,
      },
      findManyResult: botIds.map((botId, index) => ({
        id: `evt-mirrored-${botId}`,
        enqueueAttempts: 0,
        botId,
        createdAt: new Date(`2026-03-24T00:00:0${index}.000Z`),
        normalizedPayload: {
          updateId: 'u-mirrored-message',
          type: 'message_created',
          botId,
          executionOwnerBotId: ownerBotId,
          message: {
            chatId,
            messageId: 'mid-mirrored-shared',
          },
        },
      })),
    });
    const prepareImplementation =
      webhookService.preparePersistedWebhookEvent.getMockImplementation()!;
    let activePreparations = 0;
    let maxActivePreparations = 0;
    let releasePreparations!: () => void;
    const allPreparationsStarted = new Promise<void>((resolve) => {
      releasePreparations = resolve;
    });
    webhookService.preparePersistedWebhookEvent.mockImplementation(async (eventId: string) => {
      activePreparations += 1;
      maxActivePreparations = Math.max(maxActivePreparations, activePreparations);
      if (activePreparations === botIds.length) {
        releasePreparations();
      }
      await allPreparationsStarted;
      try {
        return await prepareImplementation(eventId);
      } finally {
        activePreparations -= 1;
      }
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const defaultQueueAdds = DEFAULT_WEBHOOK_QUEUE_NAMES.flatMap((queueName) =>
      queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId),
    );
    const duplicateIds = prisma.webhookEvent.updateMany.mock.calls
      .filter(([args]) => args.data.status === WebhookStatus.DUPLICATE)
      .map(([args]) => args.where.id)
      .sort();
    const queuedIds = prisma.webhookEvent.updateMany.mock.calls
      .filter(([args]) => args.data.status === WebhookStatus.QUEUED)
      .map(([args]) => args.where.id)
      .sort();

    expect(defaultQueueAdds).toEqual([ownerEventId]);
    expect(queues[ownerQueueName].add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: ownerEventId },
      expect.objectContaining({
        jobId: ownerEventId,
        priority: 5,
      }),
    );
    expect(duplicateIds).toEqual(standbyEventIds.sort());
    expect(queuedIds).toEqual([ownerEventId]);
    expect(prisma.webhookEvent.findFirst).not.toHaveBeenCalled();
    expect(maxActivePreparations).toBe(6);
  });

  it('enqueues standby-only shared-chat message_edited events as recovery deliveries', async () => {
    const chatId = '-100123';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, prisma, queues } = createService({
      findManyResult: [
        {
          id: 'evt-standby-edited-message',
          enqueueAttempts: 0,
          botId: 'id613002203036_4_bot',
          normalizedPayload: {
            updateId: 'u-standby-edited-only',
            type: 'message_edited',
            botId: 'id613002203036_4_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: { chatId },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues[queueName].add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-standby-edited-message' },
      expect.objectContaining({ jobId: 'evt-standby-edited-message' }),
    );
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WebhookStatus.QUEUED,
          queueName,
        }),
      }),
    );
  });

  it('enqueues standby-only shared-chat user_added events as recovery deliveries', async () => {
    const chatId = '-100123';
    const queueName = resolveJoinWebhookQueueNameForChatId(chatId);
    const { service, prisma, queues } = createService({
      findManyResult: [
        {
          id: 'evt-standby-user-added',
          enqueueAttempts: 0,
          botId: 'id613002203036_4_bot',
          normalizedPayload: {
            updateId: 'u-standby-user-added-only',
            type: 'user_added',
            botId: 'id613002203036_4_bot',
            executionOwnerBotId: 'id613002203036_bot',
            user: { chatId },
            chatId,
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues[queueName].add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-standby-user-added' },
      expect.objectContaining({ jobId: 'evt-standby-user-added' }),
    );
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WebhookStatus.QUEUED,
          queueName,
        }),
      }),
    );
  });

  it('enqueues standby-only shared-chat user_removed events as recovery deliveries', async () => {
    const chatId = '-100123';
    const { service, prisma, queues } = createService({
      findManyResult: [
        {
          id: 'evt-standby-user-removed',
          enqueueAttempts: 0,
          botId: 'id613002203036_4_bot',
          normalizedPayload: {
            updateId: 'u-standby-user-removed-only',
            type: 'user_removed',
            botId: 'id613002203036_4_bot',
            executionOwnerBotId: 'id613002203036_bot',
            user: { chatId },
            chatId,
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues.backgroundQueue.add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-standby-user-removed' },
      expect.objectContaining({ jobId: 'evt-standby-user-removed' }),
    );
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-background',
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
          id: 'evt-owner-processed',
          enqueueAttempts: 0,
          status: WebhookStatus.DUPLICATE,
          processedAt: new Date('2026-03-24T00:00:02.000Z'),
          botId: 'id613002203036_bot',
          normalizedPayload: {
            updateId: 'u-standby-queued',
            type: 'message_created',
            botId: 'id613002203036_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: { chatId: '-100123', messageId: 'mid-standby-queued' },
          },
        },
        {
          id: 'evt-standby-queued',
          enqueueAttempts: 2,
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-default-0',
          botId: 'id613002203036_4_bot',
          normalizedPayload: {
            updateId: 'u-standby-queued',
            type: 'message_created',
            botId: 'id613002203036_4_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: { chatId: '-100123', messageId: 'mid-standby-queued' },
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
          status: WebhookStatus.DUPLICATE,
        }),
      }),
    );
  });
});
