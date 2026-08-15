import { WebhookStatus } from '../prisma/prisma-client';
import { getQueueToken } from '@nestjs/bullmq';
import { WebhookOutboxService } from './webhook-outbox.service';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import {
  isPendingWebhookTimeoutQuarantineMessage,
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX,
} from './webhook-timeout-quarantine';
import {
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  extractWebhookType,
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

type SqlQuery = {
  strings?: readonly string[];
  values?: readonly unknown[];
};

type RetentionInternals = {
  cleanupRetention: () => Promise<void>;
  runRetentionCleanupPhase: (phase: {
    name: string;
    maxBatches: number;
    deleteBatch: () => Promise<number>;
  }) => Promise<{
    rows: number;
    batches: number;
    durationMs: number;
    budgetExhausted: boolean;
  }>;
  retentionBatchDelayMs: number;
  enabled: boolean;
  cleaning: boolean;
};

function extractSql(query: unknown): string {
  return ((query as SqlQuery | undefined)?.strings ?? []).join('?').replace(/\s+/g, ' ').trim();
}

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
  timeoutQuarantineExpiresAt: Date | null;
  errorMessage: string | null;
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

function extractOrderedWebhookChatId(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return '';
  }

  const row = payload as { message?: { chatId?: unknown }; chatId?: unknown };
  for (const value of [row.message?.chatId, row.chatId]) {
    if (typeof value === 'string' || typeof value === 'number') {
      const normalized = String(value).trim();
      if (normalized) {
        return normalized;
      }
    }
  }
  return '';
}

function matchesDateFilter(value: Date | null, filter: unknown): boolean {
  if (filter === null) {
    return value === null;
  }
  if (filter instanceof Date) {
    return value?.getTime() === filter.getTime();
  }
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

  if (
    typeof value === 'string' &&
    filter &&
    typeof filter === 'object' &&
    typeof (filter as { startsWith?: unknown }).startsWith === 'string'
  ) {
    return value.startsWith((filter as { startsWith: string }).startsWith);
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

  if (!matchesScalarFilter(row.enqueueAttempts, where.enqueueAttempts)) {
    return false;
  }

  if (!matchesScalarFilter(row.processedAt, where.processedAt)) {
    return false;
  }

  if (!matchesScalarFilter(row.errorMessage, where.errorMessage)) {
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

  if (!matchesDateFilter(row.timeoutQuarantineExpiresAt, where.timeoutQuarantineExpiresAt)) {
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

function createWebhookEventUpdateManyMock(rows: MockWebhookEventRow[]) {
  return async (args?: {
    where?: Record<string, unknown>;
    data?: {
      status?: WebhookStatus;
      queueName?: string | null;
      queuedAt?: Date | null;
      nextEnqueueAt?: Date | null;
      timeoutQuarantineExpiresAt?: Date | null;
      processedAt?: Date | null;
      errorMessage?: string | null;
      enqueueAttempts?: { increment?: number };
    };
  }) => {
    const row = rows.find((candidate) => matchesWebhookEventWhere(candidate, args?.where));
    if (!row) {
      return { count: 0 };
    }

    const data = args?.data;
    if (data?.status !== undefined) {
      row.status = data.status;
    }
    if (data?.queueName !== undefined) {
      row.queueName = data.queueName;
    }
    if (data?.queuedAt !== undefined) {
      row.queuedAt = data.queuedAt;
    }
    if (data?.nextEnqueueAt !== undefined) {
      row.nextEnqueueAt = data.nextEnqueueAt;
    }
    if (data?.timeoutQuarantineExpiresAt !== undefined) {
      row.timeoutQuarantineExpiresAt = data.timeoutQuarantineExpiresAt;
    }
    if (data?.processedAt !== undefined) {
      row.processedAt = data.processedAt;
    }
    if (data?.errorMessage !== undefined) {
      row.errorMessage = data.errorMessage;
    }
    const attemptIncrement = data?.enqueueAttempts?.increment;
    if (typeof attemptIncrement === 'number') {
      row.enqueueAttempts += attemptIncrement;
    }

    return { count: 1 };
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
    timeoutQuarantineExpiresAt?: Date | null;
    processedAt?: Date | null;
    errorMessage?: string | null;
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
  timeoutExecutionClaim?: {
    status: string;
    completedAt?: Date | null;
  } | null;
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
    timeoutQuarantineExpiresAt: item.timeoutQuarantineExpiresAt ?? null,
    processedAt: item.processedAt ?? null,
    errorMessage: item.errorMessage ?? null,
    normalizedPayload: item.normalizedPayload ?? null,
  }));

  const prisma = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockImplementation(async (query: SqlQuery) => {
      const values = query.values ?? [];
      const findHead = (chatId: string, afterCreatedAt: Date | null, afterId: string | null) => {
        const rows = webhookRows
          .filter(
            (row) =>
              (row.status === WebhookStatus.RECEIVED ||
                row.status === WebhookStatus.QUEUED ||
                (row.status === WebhookStatus.FAILED &&
                  (row.nextEnqueueAt !== null ||
                    isPendingWebhookTimeoutQuarantineMessage(row.errorMessage)))) &&
              ['message_created', 'message_edited'].includes(
                extractWebhookType(row.normalizedPayload),
              ) &&
              extractOrderedWebhookChatId(row.normalizedPayload) === chatId,
          )
          .filter((row) => {
            if (!afterCreatedAt || !afterId) {
              return true;
            }
            const createdAtDiff = row.createdAt.getTime() - afterCreatedAt.getTime();
            return createdAtDiff > 0 || (createdAtDiff === 0 && row.id > afterId);
          })
          .sort((left, right) => {
            const createdAtDiff = left.createdAt.getTime() - right.createdAt.getTime();
            return createdAtDiff !== 0
              ? createdAtDiff
              : left.id < right.id
                ? -1
                : left.id > right.id
                  ? 1
                  : 0;
          });
        return rows[0] ?? null;
      };

      if (extractSql(query).includes('requested_chats')) {
        return values.flatMap((value) => {
          if (typeof value !== 'string') {
            return [];
          }
          const row = findHead(value, null, null);
          return row ? [{ chatId: value, id: row.id, createdAt: row.createdAt }] : [];
        });
      }

      const stringValues = values.filter(
        (value): value is string =>
          typeof value === 'string' && value !== `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`,
      );
      const chatId = stringValues[0] ?? '';
      const afterCreatedAt = values.find((value): value is Date => value instanceof Date) ?? null;
      const afterId = afterCreatedAt ? (stringValues.at(-1) ?? null) : null;
      const row = findHead(chatId, afterCreatedAt, afterId);
      return row ? [{ id: row.id, createdAt: row.createdAt }] : [];
    }),
    webhookEvent: {
      findMany: jest
        .fn()
        .mockImplementation(
          async (args?: {
            where?: Record<string, unknown>;
            take?: number;
            orderBy?:
              | { createdAt?: 'asc' | 'desc'; id?: 'asc' | 'desc' }
              | Array<{ createdAt?: 'asc' | 'desc'; id?: 'asc' | 'desc' }>;
          }) => {
            const orderBy = Array.isArray(args?.orderBy)
              ? args.orderBy
              : args?.orderBy
                ? [args.orderBy]
                : [];
            const createdAtDirection = orderBy.find((entry) => entry.createdAt)?.createdAt ?? 'asc';
            const idDirection = orderBy.find((entry) => entry.id)?.id ?? createdAtDirection;
            const rows = webhookRows
              .filter((row) => matchesWebhookEventWhere(row, args?.where))
              .sort((left, right) => {
                const createdAtDiff = left.createdAt.getTime() - right.createdAt.getTime();
                if (createdAtDiff !== 0) {
                  return createdAtDirection === 'desc' ? -createdAtDiff : createdAtDiff;
                }
                const idDiff = left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
                return idDirection === 'desc' ? -idDiff : idDiff;
              });
            return rows.slice(0, args?.take ?? Number.POSITIVE_INFINITY);
          },
        ),
      findFirst: jest
        .fn()
        .mockImplementation(
          async (args?: { where?: Record<string, unknown> }) =>
            webhookRows.find((row) => matchesWebhookEventWhere(row, args?.where)) ?? null,
        ),
      findUnique: jest
        .fn()
        .mockImplementation(
          async (args?: { where?: Record<string, unknown> }) =>
            webhookRows.find((row) => matchesWebhookEventWhere(row, args?.where)) ?? null,
        ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    webhookExecutionClaim: {
      findFirst: jest.fn().mockResolvedValue(params?.timeoutExecutionClaim ?? null),
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
    webhookRows,
  };
}

describe('WebhookOutboxService', () => {
  it('requests FAILED candidates when due or when a completed timeout claim needs repair', async () => {
    const { service, prisma } = createService();

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(prisma.webhookEvent.findMany.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            where: expect.objectContaining({
              status: WebhookStatus.FAILED,
              OR: [
                { nextEnqueueAt: { lte: expect.any(Date) } },
                {
                  nextEnqueueAt: null,
                  errorMessage: {
                    startsWith: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`,
                  },
                  executionClaims: {
                    some: {
                      kind: 'EXECUTION',
                      status: 'COMPLETED',
                    },
                  },
                },
              ],
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
    const receivedRows = Array.from({ length: 12 }, (_, index) => ({
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
    const staleQueuedRows = Array.from({ length: 16 }, (_, index) => ({
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
    expect(enqueuedIds).toContain('evt-received-0');
    expect(enqueuedIds).toContain('evt-received-9');
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

  it('backs off repeated observation of an already queued delayed job', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-24T00:01:00.000Z'));
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('delayed'),
      retry: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const { service, prisma } = createService({
      findManyResult: [
        {
          id: 'evt-queued-delayed',
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
    expect(updateArg.data.nextEnqueueAt).toEqual(new Date('2026-03-24T00:01:20.000Z'));
    expect(updateArg.data.enqueueAttempts).toBeUndefined();
  });

  it('does not observe a delayed job again before its bounded backoff expires', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-24T00:01:00.000Z'));
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('delayed'),
      retry: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const { service, queues, prisma } = createService({
      findManyResult: [
        {
          id: 'evt-delayed-backoff',
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-default-0',
          queuedAt: new Date('2026-03-24T00:00:00.000Z'),
          nextEnqueueAt: new Date('2026-03-24T00:01:20.000Z'),
          enqueueAttempts: 5,
        },
      ],
      defaultJob: job,
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues['moderation-default-0'].getJob).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
  });

  it('repairs a missing delayed job after its observation backoff expires', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-24T00:01:21.000Z'));
    const { service, queues } = createService({
      findManyResult: [
        {
          id: 'evt-delayed-missing-after-backoff',
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-default-0',
          queuedAt: new Date('2026-03-24T00:00:00.000Z'),
          nextEnqueueAt: new Date('2026-03-24T00:01:20.000Z'),
          enqueueAttempts: 5,
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues['moderation-default-0'].getJob).toHaveBeenCalledWith(
      'evt-delayed-missing-after-backoff',
    );
    expect(queues['moderation-default-0'].add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-delayed-missing-after-backoff' },
      expect.objectContaining({ jobId: 'evt-delayed-missing-after-backoff' }),
    );
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
    expect(updateArg.where.status).toBe(WebhookStatus.RECEIVED);
    expect(storedStatus).toBe(WebhookStatus.FAILED);
  });

  it('does not overwrite a terminal worker failure after enqueueing a due FAILED event', async () => {
    const chatId = 'failed-retry-cas-chat';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const retryAt = new Date(Date.now() - 1_000);
    const { service, prisma, queues, webhookRows } = createService({
      findManyResult: [
        {
          id: 'evt-failed-retry-cas',
          status: WebhookStatus.FAILED,
          queueName: null,
          enqueueAttempts: 5,
          nextEnqueueAt: retryAt,
          normalizedPayload: { type: 'message_created', message: { chatId } },
        },
      ],
    });
    const row = webhookRows[0]!;
    prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(webhookRows),
    );
    queues[queueName].add.mockImplementation(async () => {
      row.status = WebhookStatus.FAILED;
      row.nextEnqueueAt = null;
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: WebhookStatus.FAILED,
          enqueueAttempts: 5,
          nextEnqueueAt: retryAt,
        }),
        data: expect.objectContaining({ status: WebhookStatus.QUEUED }),
      }),
    );
    expect(prisma.webhookEvent.findUnique).not.toHaveBeenCalled();
    expect(row.status).toBe(WebhookStatus.FAILED);
    expect(row.nextEnqueueAt).toBeNull();
    expect(row.enqueueAttempts).toBe(6);
  });

  it('does not let a late enqueue error overwrite a terminal worker outcome', async () => {
    const chatId = 'late-enqueue-error-cas-chat';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, prisma, queues, webhookRows } = createService({
      findManyResult: [
        {
          id: 'evt-late-enqueue-error-cas',
          status: WebhookStatus.RECEIVED,
          enqueueAttempts: 0,
          normalizedPayload: { type: 'message_created', message: { chatId } },
        },
      ],
    });
    const row = webhookRows[0]!;
    prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(webhookRows),
    );
    queues[queueName].add.mockImplementation(async () => {
      row.status = WebhookStatus.FAILED;
      row.nextEnqueueAt = null;
      throw new Error('Redis connection closed after worker terminal failure');
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: WebhookStatus.QUEUED,
          queueName,
          enqueueAttempts: 1,
          queuedAt: expect.any(Date),
          nextEnqueueAt: null,
        }),
        data: expect.objectContaining({ status: WebhookStatus.FAILED }),
      }),
    );
    expect(prisma.webhookEvent.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'evt-late-enqueue-error-cas' } }),
    );
    expect(row.status).toBe(WebhookStatus.FAILED);
    expect(row.queueName).toBe(queueName);
    expect(row.enqueueAttempts).toBe(1);
    expect(row.nextEnqueueAt).toBeNull();
  });

  it('lets only one concurrent poller activate an event across different shards', async () => {
    const chatId = 'concurrent-poller-claim-chat';
    const firstQueueName = DEFAULT_WEBHOOK_QUEUE_NAMES[0]!;
    const secondQueueName = DEFAULT_WEBHOOK_QUEUE_NAMES[1]!;
    const { service, prisma, queues, webhookRows, webhookRoutingService } = createService({
      findManyResult: [
        {
          id: 'evt-concurrent-poller-claim',
          status: WebhookStatus.RECEIVED,
          enqueueAttempts: 0,
          normalizedPayload: {
            updateId: 'update-concurrent-poller-claim',
            type: 'message_created',
            message: { chatId, messageId: 'message-concurrent-poller-claim' },
          },
        },
      ],
    });
    prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(webhookRows),
    );
    webhookRoutingService.resolveQueueName
      .mockResolvedValueOnce(firstQueueName)
      .mockResolvedValueOnce(secondQueueName);

    await Promise.all([
      (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch(),
      (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch(),
    ]);

    const queueAdds = [firstQueueName, secondQueueName].flatMap((queueName) =>
      queues[queueName].add.mock.calls.map((call) => ({
        queueName,
        webhookEventId: call[1].webhookEventId,
      })),
    );
    expect(queueAdds).toHaveLength(1);
    expect(queueAdds[0]?.webhookEventId).toBe('evt-concurrent-poller-claim');
    expect(webhookRows[0]?.status).toBe(WebhookStatus.QUEUED);
    expect(webhookRows[0]?.queueName).toBe(queueAdds[0]?.queueName);
    expect(webhookRows[0]?.enqueueAttempts).toBe(1);
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
    expect(updateArg.where.status).toBe(WebhookStatus.FAILED);
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
            nextEnqueueAt: Date | null;
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
        nextEnqueueAt: null,
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

  it('keeps a live queued job outstanding even when its enqueue attempt cap is reached', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('waiting'),
      retry: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const { service, prisma, queues } = createService({
      findManyResult: [
        {
          id: 'evt-max-attempt-live-job',
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-default-0',
          enqueueAttempts: 120,
          queuedAt: new Date('2026-03-24T00:00:00.000Z'),
        },
      ],
      defaultJob: job,
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(job.getState).toHaveBeenCalledTimes(1);
    expect(job.retry).not.toHaveBeenCalled();
    expect(queues['moderation-default-0'].add).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: WebhookStatus.QUEUED }),
      }),
    );
    expect(
      prisma.webhookEvent.updateMany.mock.calls.some(
        ([args]) => args.data.status === WebhookStatus.FAILED,
      ),
    ).toBe(false);
  });

  it('does not terminalize a stale exhausted snapshot after another poller queues it', async () => {
    const retryAt = new Date('2026-03-24T00:00:02.000Z');
    const { service, prisma, queues, webhookRows } = createService({
      findManyResult: [
        {
          id: 'evt-stale-exhausted-cas',
          status: WebhookStatus.FAILED,
          queueName: null,
          enqueueAttempts: 120,
          queuedAt: null,
          nextEnqueueAt: retryAt,
        },
      ],
    });
    const row = webhookRows[0]!;
    const staleSnapshot = { ...row };
    row.status = WebhookStatus.QUEUED;
    row.queueName = 'moderation-default-0';
    row.queuedAt = new Date('2026-03-24T00:00:03.000Z');
    row.nextEnqueueAt = null;
    row.enqueueAttempts = 121;
    prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(webhookRows),
    );

    const outcome = await (
      service as unknown as {
        enqueueOne: (
          event: typeof staleSnapshot,
          priority: number,
          queueName: 'moderation-default-0',
        ) => Promise<string>;
      }
    ).enqueueOne(staleSnapshot, 6, 'moderation-default-0');

    expect(outcome).toBe('outstanding');
    expect(queues['moderation-default-0'].add).not.toHaveBeenCalled();
    expect(row.status).toBe(WebhookStatus.QUEUED);
    expect(row.queueName).toBe('moderation-default-0');
    expect(row.enqueueAttempts).toBe(121);
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
          event: {
            id: string;
            status: WebhookStatus;
            botId: string | null;
            queueName: string | null;
            enqueueAttempts: number;
            createdAt: Date;
            queuedAt: Date | null;
            nextEnqueueAt: Date | null;
            normalizedPayload: unknown;
          },
          job: JobMock,
        ) => Promise<void>;
      }
    ).retryFailedJob(
      {
        id: 'evt-terminal-503',
        status: WebhookStatus.FAILED,
        botId: null,
        queueName: 'moderation-default-0',
        enqueueAttempts: 120,
        createdAt: new Date('2026-03-24T00:00:00.000Z'),
        queuedAt: new Date('2026-03-24T00:00:01.000Z'),
        nextEnqueueAt: new Date('2026-03-24T00:00:02.000Z'),
        normalizedPayload: null,
      },
      job,
    );

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

  it('defers retention cleanup until the first hourly timer', async () => {
    jest.useFakeTimers();
    const { service } = createService();
    const internals = service as unknown as RetentionInternals;
    internals.enabled = true;
    const tick = jest.spyOn(service as any, 'tick').mockResolvedValue(undefined);
    const cleanup = jest.spyOn(service as any, 'cleanupRetention').mockResolvedValue(undefined);

    service.onModuleInit();
    expect(tick).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();

    jest.advanceTimersByTime(60 * 60 * 1_000 - 1);
    expect(cleanup).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(cleanup).toHaveBeenCalledTimes(1);

    service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('uses bounded ordered SQL for every sequential retention phase', async () => {
    const { service, prisma } = createService({
      configOverrides: {
        WEBHOOK_RETENTION_DAYS: 7,
        WEBHOOK_FAILED_RETENTION_HOURS: 24,
        MODERATION_RETENTION_DAYS: 90,
        USER_DISPLAY_NAME_RETENTION_DAYS: 180,
      },
    });
    const logger = jest.spyOn((service as any).logger, 'log');

    await (service as unknown as RetentionInternals).cleanupRetention();

    const queries = prisma.$executeRaw.mock.calls.map(([query]) => ({
      sql: extractSql(query),
      values: (query as SqlQuery).values ?? [],
    }));
    expect(queries).toHaveLength(6);
    for (const query of queries) {
      expect(query.sql).toContain('WITH expired AS');
      expect(query.sql).toContain('ORDER BY');
      expect(query.sql).toContain('LIMIT ?');
      expect(query.sql).toContain('FOR UPDATE SKIP LOCKED');
      expect(query.values).toContain(500);
    }
    expect(queries[0]?.sql).toContain(
      `"status" IN ('PROCESSED'::"WebhookStatus", 'DUPLICATE'::"WebhookStatus")`,
    );
    expect(queries[1]?.values).toContain(WebhookStatus.FAILED);
    expect(queries[1]?.sql).toContain('"next_enqueue_at" IS NULL');
    expect(queries.map((query) => query.sql)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('DELETE FROM "moderation_events" target'),
        expect.stringContaining('DELETE FROM "violations" target'),
        expect.stringContaining('DELETE FROM "moderation_violation_message_claims" target'),
        expect.stringContaining('DELETE FROM "chat_user_display_names" target'),
      ]),
    );
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        phases: expect.objectContaining({
          webhookProcessedOrDuplicate: expect.objectContaining({
            rows: 0,
            batches: 1,
            durationMs: expect.any(Number),
            budgetExhausted: false,
          }),
          userDisplayNames: expect.objectContaining({ rows: 0, batches: 1 }),
        }),
      }),
      'Retention cleanup finished',
    );
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'webhookProcessedOrDuplicate',
        rows: 0,
        batches: 1,
        maxBatches: 80,
        batchSize: 500,
      }),
      'Retention cleanup phase finished',
    );
  });

  it('does not start the next retention phase before the current phase finishes', async () => {
    let resolveFirstBatch!: (rows: number) => void;
    const firstBatch = new Promise<number>((resolve) => {
      resolveFirstBatch = resolve;
    });
    const { service, prisma } = createService();
    prisma.$executeRaw.mockImplementationOnce(() => firstBatch).mockResolvedValue(0);

    const cleanup = (service as unknown as RetentionInternals).cleanupRetention();
    await Promise.resolve();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);

    resolveFirstBatch(0);
    await cleanup;
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(6);
  });

  it('repeats full retention batches and stops after a partial batch', async () => {
    const { service } = createService();
    const internals = service as unknown as RetentionInternals;
    internals.retentionBatchDelayMs = 0;
    const deleteBatch = jest.fn().mockResolvedValueOnce(500).mockResolvedValueOnce(499);

    await expect(
      internals.runRetentionCleanupPhase({ name: 'test', maxBatches: 10, deleteBatch }),
    ).resolves.toEqual({
      rows: 999,
      batches: 2,
      durationMs: expect.any(Number),
      budgetExhausted: false,
    });
    expect(deleteBatch).toHaveBeenCalledTimes(2);
  });

  it('shares one 80-batch budget across processed and duplicate webhook retention', async () => {
    const { service, prisma } = createService();
    const internals = service as unknown as RetentionInternals;
    internals.retentionBatchDelayMs = 0;
    prisma.$executeRaw.mockImplementation(async (query: SqlQuery) => {
      const sql = extractSql(query);
      return sql.includes('"webhook_events"') &&
        sql.includes(`'PROCESSED'::"WebhookStatus"`) &&
        sql.includes(`'DUPLICATE'::"WebhookStatus"`)
        ? 500
        : 0;
    });

    await internals.cleanupRetention();

    const completedWebhookCalls = prisma.$executeRaw.mock.calls.filter(([query]) => {
      return (
        extractSql(query).includes('"webhook_events"') &&
        extractSql(query).includes(`'PROCESSED'::"WebhookStatus"`) &&
        extractSql(query).includes(`'DUPLICATE'::"WebhookStatus"`)
      );
    });
    expect(completedWebhookCalls).toHaveLength(80);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(85);
  });

  it('reports the failed retention phase and resets the cleaning guard', async () => {
    const { service, prisma } = createService();
    const internals = service as unknown as RetentionInternals;
    const logger = jest.spyOn((service as any).logger, 'warn');
    prisma.$executeRaw.mockRejectedValueOnce(new Error('retention database unavailable'));

    await internals.cleanupRetention();

    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'webhookProcessedOrDuplicate',
        rows: 0,
        batches: 0,
        err: 'retention database unavailable',
      }),
      'Retention cleanup phase failed',
    );
    expect(internals.cleaning).toBe(false);

    await internals.cleanupRetention();

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(7);
    expect(internals.cleaning).toBe(false);
  });

  it('skips overlapping retention cleanup runs', async () => {
    let resolveFirstBatch!: (rows: number) => void;
    const firstBatch = new Promise<number>((resolve) => {
      resolveFirstBatch = resolve;
    });
    const { service, prisma } = createService();
    prisma.$executeRaw.mockImplementationOnce(() => firstBatch).mockResolvedValue(0);
    const internals = service as unknown as RetentionInternals;

    const firstCleanup = internals.cleanupRetention();
    await Promise.resolve();
    await internals.cleanupRetention();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);

    resolveFirstBatch(0);
    await firstCleanup;
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

  it('does not prepare a newer chat event after the older event becomes outstanding', async () => {
    const chatId = 'chat-serial-preparation';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, queues, webhookService } = createService({
      configOverrides: { ENQUEUE_CONCURRENCY: 8 },
      findManyResult: [
        {
          id: 'evt-chat-older-slow',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            updateId: 'update-chat-older-slow',
            type: 'message_created',
            message: { chatId, messageId: 'message-chat-older-slow' },
          },
        },
        {
          id: 'evt-chat-newer-fast',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            updateId: 'update-chat-newer-fast',
            type: 'message_created',
            message: { chatId, messageId: 'message-chat-newer-fast' },
          },
        },
      ],
    });
    const prepareImplementation =
      webhookService.preparePersistedWebhookEvent.getMockImplementation()!;
    let releaseOlder!: () => void;
    const olderPreparationGate = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    webhookService.preparePersistedWebhookEvent.mockImplementation(async (eventId: string) => {
      if (eventId === 'evt-chat-older-slow') {
        await olderPreparationGate;
      }
      return prepareImplementation(eventId);
    });

    const enqueuePromise = (
      service as unknown as { enqueueBatch: () => Promise<void> }
    ).enqueueBatch();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(webhookService.preparePersistedWebhookEvent.mock.calls).toEqual([
      ['evt-chat-older-slow'],
    ]);
    expect(queues[queueName].add).not.toHaveBeenCalled();

    releaseOlder();
    await enqueuePromise;

    expect(
      webhookService.preparePersistedWebhookEvent.mock.calls.map(([eventId]) => eventId),
    ).toEqual(['evt-chat-older-slow']);
    expect(queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-chat-older-slow',
    ]);
  });

  it('uses the event id as a deterministic same-chat tie-breaker for equal createdAt values', async () => {
    const chatId = 'chat-created-at-tie';
    const createdAt = new Date('2026-03-24T00:00:00.000Z');
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, queues, webhookService } = createService({
      findManyResult: [
        {
          id: 'evt-tie-z',
          enqueueAttempts: 0,
          createdAt,
          normalizedPayload: {
            updateId: 'update-tie-z',
            type: 'message_created',
            message: { chatId, messageId: 'message-tie-z' },
          },
        },
        {
          id: 'evt-tie-a',
          enqueueAttempts: 0,
          createdAt,
          normalizedPayload: {
            updateId: 'update-tie-a',
            type: 'message_created',
            message: { chatId, messageId: 'message-tie-a' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-tie-a',
    ]);
    expect(webhookService.preparePersistedWebhookEvent).toHaveBeenCalledTimes(1);
    expect(webhookService.preparePersistedWebhookEvent).toHaveBeenCalledWith('evt-tie-a');
  });

  it('retains bounded preparation concurrency between different chats', async () => {
    const chatIds = ['chat-parallel-a', 'chat-parallel-b', 'chat-parallel-c'];
    const { service, prisma, webhookService } = createService({
      configOverrides: { ENQUEUE_CONCURRENCY: 2 },
      findManyResult: chatIds.map((chatId, index) => ({
        id: `evt-parallel-${index}`,
        enqueueAttempts: 0,
        createdAt: new Date(`2026-03-24T00:00:0${index}.000Z`),
        normalizedPayload: {
          updateId: `update-parallel-${index}`,
          type: 'message_created',
          message: { chatId, messageId: `message-parallel-${index}` },
        },
      })),
    });
    const prepareImplementation =
      webhookService.preparePersistedWebhookEvent.getMockImplementation()!;
    let activePreparations = 0;
    let maxActivePreparations = 0;
    const startedEventIds: string[] = [];
    let releaseFirstWorkers!: () => void;
    const firstWorkersGate = new Promise<void>((resolve) => {
      releaseFirstWorkers = resolve;
    });
    webhookService.preparePersistedWebhookEvent.mockImplementation(async (eventId: string) => {
      activePreparations += 1;
      maxActivePreparations = Math.max(maxActivePreparations, activePreparations);
      startedEventIds.push(eventId);
      if (startedEventIds.length <= 2) {
        await firstWorkersGate;
      }
      try {
        return await prepareImplementation(eventId);
      } finally {
        activePreparations -= 1;
      }
    });

    const enqueuePromise = (
      service as unknown as { enqueueBatch: () => Promise<void> }
    ).enqueueBatch();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(startedEventIds).toHaveLength(2);
    expect(activePreparations).toBe(2);

    releaseFirstWorkers();
    await enqueuePromise;

    expect(startedEventIds).toHaveLength(3);
    expect(maxActivePreparations).toBe(2);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const orderedHeadsQuery = prisma.$queryRaw.mock.calls[0]![0] as SqlQuery;
    const orderedHeadsSql = extractSql(orderedHeadsQuery);
    const quarantineMarker = `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`;
    expect(orderedHeadsSql).toContain('requested_chats');
    expect(orderedHeadsSql).toContain('JOIN LATERAL');
    expect(orderedHeadsSql).not.toContain('CROSS JOIN LATERAL');
    expect(orderedHeadsSql).toContain(
      `LEFT(COALESCE("error_message", ''), 37) = '${quarantineMarker}'`,
    );
    expect(orderedHeadsQuery.values).not.toContain(37);
    expect(orderedHeadsQuery.values).not.toContain(quarantineMarker);
    expect(orderedHeadsQuery.values).toEqual(expect.arrayContaining(chatIds));
  });

  it('keeps the partial-index predicate literal while binding a single-chat head cursor', async () => {
    const { service, prisma } = createService();
    const chatId = 'chat-ordered-head-sql-shape';
    const after = {
      id: 'evt-ordered-head-cursor',
      createdAt: new Date('2026-08-15T12:30:00.000Z'),
    };

    await (
      service as unknown as {
        findOrderedWebhookHeadForChat: (
          targetChatId: string,
          cursor: { id: string; createdAt: Date },
        ) => Promise<unknown>;
      }
    ).findOrderedWebhookHeadForChat(chatId, after);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const orderedHeadQuery = prisma.$queryRaw.mock.calls[0]![0] as SqlQuery;
    const orderedHeadSql = extractSql(orderedHeadQuery);
    const quarantineMarker = `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`;
    expect(orderedHeadSql).toContain(
      `LEFT(COALESCE("error_message", ''), 37) = '${quarantineMarker}'`,
    );
    expect(orderedHeadQuery.values).not.toContain(37);
    expect(orderedHeadQuery.values).not.toContain(quarantineMarker);
    expect(orderedHeadQuery.values).toEqual(
      expect.arrayContaining([chatId, after.createdAt, after.id]),
    );
  });

  it('enqueues a due retryable same-chat failure before a newer receipt', async () => {
    const chatId = 'chat-due-retry-barrier';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, queues, webhookRows } = createService({
      findManyResult: [
        {
          id: 'evt-due-retry-older',
          status: WebhookStatus.FAILED,
          enqueueAttempts: 1,
          nextEnqueueAt: new Date(Date.now() - 1_000),
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            updateId: 'update-due-retry-older',
            type: 'message_created',
            message: { chatId, messageId: 'message-due-retry-older' },
          },
        },
        {
          id: 'evt-due-retry-newer',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            updateId: 'update-due-retry-newer',
            type: 'message_created',
            message: { chatId, messageId: 'message-due-retry-newer' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-due-retry-older',
    ]);

    const olderRow = webhookRows.find((row) => row.id === 'evt-due-retry-older')!;
    olderRow.status = WebhookStatus.PROCESSED;
    olderRow.nextEnqueueAt = null;

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-due-retry-older',
      'evt-due-retry-newer',
    ]);
  });

  it('does not let an older terminal failure block a newer distinct message', async () => {
    const chatId = 'chat-terminal-failure-release';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, queues, webhookService } = createService({
      findManyResult: [
        {
          id: 'evt-terminal-failure-older',
          status: WebhookStatus.FAILED,
          enqueueAttempts: 120,
          nextEnqueueAt: null,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            updateId: 'update-terminal-failure-older',
            type: 'message_created',
            message: { chatId, messageId: 'message-terminal-failure-older' },
          },
        },
        {
          id: 'evt-after-terminal-failure',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            updateId: 'update-after-terminal-failure',
            type: 'message_created',
            message: { chatId, messageId: 'message-after-terminal-failure' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(webhookService.preparePersistedWebhookEvent).toHaveBeenCalledTimes(1);
    expect(webhookService.preparePersistedWebhookEvent).toHaveBeenCalledWith(
      'evt-after-terminal-failure',
    );
    expect(queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-after-terminal-failure',
    ]);
  });

  it('keeps a newer same-chat message behind a live timeout quarantine', async () => {
    const chatId = 'chat-live-timeout-quarantine';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, queues, webhookService } = createService({
      findManyResult: [
        {
          id: 'evt-live-timeout-a',
          status: WebhookStatus.FAILED,
          enqueueAttempts: 1,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: new Date(Date.now() + 60_000),
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-a: still running`,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId, messageId: 'message-live-timeout-a' },
          },
        },
        {
          id: 'evt-live-timeout-b',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId, messageId: 'message-live-timeout-b' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(webhookService.preparePersistedWebhookEvent).not.toHaveBeenCalled();
    expect(queues[queueName].add).not.toHaveBeenCalled();
  });

  it('keeps an expired timeout quarantine fenced without replaying or advancing the chat head', async () => {
    const chatId = 'chat-expired-timeout-quarantine';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, prisma, queues, webhookRows } = createService({
      findManyResult: [
        {
          id: 'evt-expired-timeout-a',
          status: WebhookStatus.FAILED,
          enqueueAttempts: 1,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: new Date(Date.now() - 1_000),
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-a: crashed`,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId, messageId: 'message-expired-timeout-a' },
          },
        },
        {
          id: 'evt-expired-timeout-b',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId, messageId: 'message-expired-timeout-b' },
          },
        },
      ],
    });
    prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(webhookRows),
    );

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues[queueName].add).not.toHaveBeenCalled();
    expect(queues[queueName].add).not.toHaveBeenCalledWith(
      expect.anything(),
      { webhookEventId: 'evt-expired-timeout-a' },
      expect.anything(),
    );
    const expiredRow = webhookRows[0]!;
    expect(expiredRow.status).toBe(WebhookStatus.FAILED);
    expect(expiredRow.nextEnqueueAt).toBeNull();
    expect(expiredRow.timeoutQuarantineExpiresAt?.getTime()).toBeLessThan(Date.now());
    expect(expiredRow.errorMessage).toMatch(
      new RegExp(`^${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`),
    );
  });

  it('repairs a timeout quarantine only from a durably completed claim', async () => {
    const chatId = 'chat-completed-timeout-quarantine';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const completedAt = new Date('2026-03-24T00:00:05.000Z');
    const { service, prisma, queues, webhookRows } = createService({
      timeoutExecutionClaim: { status: 'COMPLETED', completedAt },
      findManyResult: [
        {
          id: 'evt-completed-timeout-a',
          status: WebhookStatus.FAILED,
          enqueueAttempts: 1,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: new Date(Date.now() - 1_000),
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-a: completion write interrupted`,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId, messageId: 'message-completed-timeout-a' },
          },
        },
        {
          id: 'evt-completed-timeout-b',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId, messageId: 'message-completed-timeout-b' },
          },
        },
      ],
    });
    prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(webhookRows),
    );

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(webhookRows[0]).toEqual(
      expect.objectContaining({
        status: WebhookStatus.PROCESSED,
        processedAt: completedAt,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
        errorMessage: null,
      }),
    );
    expect(queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-completed-timeout-b',
    ]);
  });

  it('never releases an expired timeout quarantine without a completed claim', async () => {
    const chatId = 'chat-timeout-heartbeat-race';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, prisma, queues, webhookRows } = createService({
      findManyResult: [
        {
          id: 'evt-heartbeat-race-a',
          status: WebhookStatus.FAILED,
          enqueueAttempts: 1,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: new Date(Date.now() - 1_000),
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-a: running`,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId, messageId: 'message-heartbeat-race-a' },
          },
        },
        {
          id: 'evt-heartbeat-race-b',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId, messageId: 'message-heartbeat-race-b' },
          },
        },
      ],
    });
    prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(webhookRows),
    );

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();
    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(webhookRows[0]!.nextEnqueueAt).toBeNull();
    expect(webhookRows[0]!.timeoutQuarantineExpiresAt!.getTime()).toBeLessThan(Date.now());
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
    expect(queues[queueName].add).not.toHaveBeenCalled();
  });

  it('keeps a legacy null-deadline timeout quarantine fenced indefinitely', async () => {
    const chatId = 'chat-legacy-timeout-quarantine';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, prisma, queues, webhookRows } = createService({
      findManyResult: [
        {
          id: 'evt-legacy-timeout-a',
          status: WebhookStatus.FAILED,
          enqueueAttempts: 1,
          nextEnqueueAt: null,
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}: detached work unresolved`,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId, messageId: 'message-legacy-timeout-a' },
          },
        },
        {
          id: 'evt-legacy-timeout-b',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId, messageId: 'message-legacy-timeout-b' },
          },
        },
      ],
    });
    prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(webhookRows),
    );

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();
    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(webhookRows[0]!.nextEnqueueAt).toBeNull();
    expect(webhookRows[0]!.timeoutQuarantineExpiresAt).toBeNull();
    expect(webhookRows[0]!.errorMessage).toMatch(
      new RegExp(`^${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`),
    );
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
    expect(queues[queueName].add).not.toHaveBeenCalled();
  });

  it('advances past a canonical duplicate to the next distinct message in one batch', async () => {
    const chatId = 'chat-canonical-duplicate-release';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, queues, webhookService, webhookRows } = createService({
      findManyResult: [
        {
          id: 'evt-canonical-duplicate-older',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            updateId: 'update-canonical-duplicate-older',
            type: 'message_created',
            message: { chatId, messageId: 'message-canonical-duplicate-older' },
          },
        },
        {
          id: 'evt-after-canonical-duplicate',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            updateId: 'update-after-canonical-duplicate',
            type: 'message_created',
            message: { chatId, messageId: 'message-after-canonical-duplicate' },
          },
        },
      ],
    });
    const prepareImplementation =
      webhookService.preparePersistedWebhookEvent.getMockImplementation()!;
    webhookService.preparePersistedWebhookEvent.mockImplementation(async (eventId: string) => {
      if (eventId === 'evt-canonical-duplicate-older') {
        webhookRows[0]!.status = WebhookStatus.DUPLICATE;
        webhookRows[0]!.processedAt = new Date();
        return {
          canonical: false,
          prepared: true,
          normalizedPayload: webhookRows[0]!.normalizedPayload,
          executionBotId: null,
          enforced: true,
        };
      }
      return prepareImplementation(eventId);
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(
      webhookService.preparePersistedWebhookEvent.mock.calls.map(([eventId]) => eventId),
    ).toEqual(['evt-canonical-duplicate-older', 'evt-after-canonical-duplicate']);
    expect(queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-after-canonical-duplicate',
    ]);
  });

  it('blocks a newer high BullMQ priority behind the older same-chat head', async () => {
    const chatId = 'chat-priority-order';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const createdAt = new Date('2026-03-24T00:00:00.000Z');
    const priorityRows = [
      {
        id: 'evt-priority-newer',
        enqueueAttempts: 0,
        createdAt: new Date(createdAt.getTime() + 1_000),
        normalizedPayload: {
          updateId: 'update-priority-newer',
          type: 'message_created',
          message: { chatId, messageId: 'message-priority-newer' },
        },
      },
      {
        id: 'evt-priority-older',
        enqueueAttempts: 0,
        createdAt,
        normalizedPayload: {
          updateId: 'update-priority-older',
          type: 'message_created',
          message: { chatId, messageId: 'message-priority-older' },
        },
      },
    ];
    const { service, queues } = createService({ findManyResult: priorityRows });
    const baseCandidate = {
      status: WebhookStatus.RECEIVED,
      botId: null,
      queueName: null,
      enqueueAttempts: 0,
      createdAt,
      queuedAt: null,
    };

    await (
      service as unknown as {
        enqueueCandidates: (candidates: unknown[]) => Promise<void>;
      }
    ).enqueueCandidates([
      {
        ...baseCandidate,
        id: 'evt-priority-newer',
        priority: 1,
        createdAt: new Date(createdAt.getTime() + 1_000),
        normalizedPayload: priorityRows[0]!.normalizedPayload,
      },
      {
        ...baseCandidate,
        id: 'evt-priority-older',
        priority: 5,
        normalizedPayload: priorityRows[1]!.normalizedPayload,
      },
    ]);

    expect(
      queues[queueName].add.mock.calls.map((call) => ({
        webhookEventId: call[1].webhookEventId,
        priority: call[2].priority,
      })),
    ).toEqual([{ webhookEventId: 'evt-priority-older', priority: 5 }]);
  });

  it('blocks a selected recent receipt behind an older same-chat receipt omitted from the batch', async () => {
    const chatId = 'chat-omitted-head';
    const { service, prisma, queues, webhookService, webhookRows } = createService({
      findManyResult: [
        {
          id: 'evt-omitted-older',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            updateId: 'update-omitted-older',
            type: 'message_created',
            message: { chatId, messageId: 'message-omitted-older' },
          },
        },
        {
          id: 'evt-selected-newer',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            updateId: 'update-selected-newer',
            type: 'message_created',
            message: { chatId, messageId: 'message-selected-newer' },
          },
        },
      ],
    });
    const selectedNewer = webhookRows.find((row) => row.id === 'evt-selected-newer')!;
    prisma.webhookEvent.findMany.mockResolvedValue([selectedNewer]);

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(webhookService.preparePersistedWebhookEvent).not.toHaveBeenCalled();
    for (const queueName of DEFAULT_WEBHOOK_QUEUE_NAMES) {
      expect(queues[queueName].add).not.toHaveBeenCalled();
    }
  });

  it('keeps a newer manual-close receipt behind an older queued event from a prior poll', async () => {
    const chatId = 'chat-manual-transition';
    const priorQueueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const now = new Date();
    const { service, queues, webhookRoutingService, webhookService, webhookRows } = createService({
      manualCloseChatIds: [chatId],
      findManyResult: [
        {
          id: 'evt-prior-normal-queued',
          status: WebhookStatus.QUEUED,
          queueName: priorQueueName,
          enqueueAttempts: 1,
          createdAt: new Date(now.getTime() - 60_000),
          queuedAt: now,
          normalizedPayload: {
            updateId: 'update-prior-normal-queued',
            type: 'message_created',
            message: { chatId, messageId: 'message-prior-normal-queued' },
          },
        },
        {
          id: 'evt-newer-manual-close',
          enqueueAttempts: 0,
          createdAt: new Date(now.getTime() - 1_000),
          normalizedPayload: {
            updateId: 'update-newer-manual-close',
            type: 'message_created',
            message: { chatId, messageId: 'message-newer-manual-close' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(webhookService.preparePersistedWebhookEvent).not.toHaveBeenCalled();
    expect(webhookRoutingService.resolveQueueName).not.toHaveBeenCalled();
    expect(queues.criticalQueue.add).not.toHaveBeenCalled();

    const priorRow = webhookRows.find((row) => row.id === 'evt-prior-normal-queued')!;
    priorRow.queuedAt = new Date(now.getTime() - 30_000);

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(
      webhookService.preparePersistedWebhookEvent.mock.calls.map(([eventId]) => eventId),
    ).toEqual(['evt-prior-normal-queued']);
    expect(queues.criticalQueue.add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-prior-normal-queued',
    ]);
  });

  it('does not enqueue B after queued A later becomes retryable FAILED', async () => {
    const chatId = 'chat-failure-after-enqueue';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, queues, webhookService, webhookRows } = createService({
      findManyResult: [
        {
          id: 'evt-sequence-a',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            updateId: 'update-sequence-a',
            type: 'message_created',
            message: { chatId, messageId: 'message-sequence-a' },
          },
        },
        {
          id: 'evt-sequence-b',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            updateId: 'update-sequence-b',
            type: 'message_created',
            message: { chatId, messageId: 'message-sequence-b' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const firstRow = webhookRows.find((row) => row.id === 'evt-sequence-a')!;
    firstRow.status = WebhookStatus.FAILED;
    firstRow.queueName = null;
    firstRow.nextEnqueueAt = new Date(Date.now() + 30_000);

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-sequence-a',
    ]);
    expect(
      webhookService.preparePersistedWebhookEvent.mock.calls.map(([eventId]) => eventId),
    ).toEqual(['evt-sequence-a']);
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
    const { service, prisma, queues, webhookService } = createService({
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
    expect(duplicateIds).toEqual([]);
    expect(webhookService.preparePersistedWebhookEvent).not.toHaveBeenCalled();
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
    expect(duplicateIds).toEqual([]);
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

  it('holds N-way mirrored message receipts behind the outstanding owner', async () => {
    const chatId = '-100123';
    const ownerBotId = 'bot-1';
    const botIds = ['bot-1', 'bot-2', 'bot-3', 'bot-4', 'bot-5', 'bot-6'];
    const ownerEventId = 'evt-mirrored-bot-1';
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
    webhookService.preparePersistedWebhookEvent.mockImplementation(async (eventId: string) => {
      activePreparations += 1;
      maxActivePreparations = Math.max(maxActivePreparations, activePreparations);
      await Promise.resolve();
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
    expect(duplicateIds).toEqual([]);
    expect(queuedIds).toEqual([ownerEventId]);
    expect(prisma.webhookEvent.findFirst).not.toHaveBeenCalled();
    expect(maxActivePreparations).toBe(1);
    expect(webhookService.preparePersistedWebhookEvent).toHaveBeenCalledTimes(1);
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
