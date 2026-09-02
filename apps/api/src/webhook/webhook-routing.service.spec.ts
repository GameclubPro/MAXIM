import { WebhookRoutingService } from './webhook-routing.service';
import {
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  resolveDefaultWebhookQueueNameForChatId,
  resolveJoinWebhookQueueNameForChatId,
} from './webhook-queues';
import { WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX } from './webhook-timeout-quarantine';

function createConfigMock(overrides: Partial<Record<string, number>> = {}) {
  return {
    get: jest.fn((key: string) => {
      if (key in overrides) {
        return overrides[key];
      }
      return undefined;
    }),
  };
}

function buildDefaultShardSnapshot() {
  return Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [
      `moderation-default-${index}`,
      { waiting: 3, active: 1, delayed: 0, failed: 0, completed: 0 },
    ]),
  );
}

function buildWorkerGroupSnapshot(
  overrides: Partial<Record<string, { waiting: number; active: number }>> = {},
) {
  return {
    'api-moderation': {
      queues: [
        'moderation-default-0',
        'moderation-default-4',
        'moderation-default-8',
        'moderation-default-12',
      ],
      counters: {
        waiting: 4,
        active: 1,
        delayed: 0,
        failed: 0,
        completed: 0,
        ...overrides['api-moderation'],
      },
    },
    'api-moderation-realtime-b': {
      queues: [
        'moderation-default-1',
        'moderation-default-5',
        'moderation-default-9',
        'moderation-default-13',
      ],
      counters: {
        waiting: 4,
        active: 1,
        delayed: 0,
        failed: 0,
        completed: 0,
        ...overrides['api-moderation-realtime-b'],
      },
    },
    'api-moderation-realtime-c': {
      queues: [
        'moderation-default-2',
        'moderation-default-6',
        'moderation-default-10',
        'moderation-default-14',
      ],
      counters: {
        waiting: 4,
        active: 1,
        delayed: 0,
        failed: 0,
        completed: 0,
        ...overrides['api-moderation-realtime-c'],
      },
    },
    'api-moderation-realtime-d': {
      queues: [
        'moderation-default-3',
        'moderation-default-7',
        'moderation-default-11',
        'moderation-default-15',
      ],
      counters: {
        waiting: 4,
        active: 1,
        delayed: 0,
        failed: 0,
        completed: 0,
        ...overrides['api-moderation-realtime-d'],
      },
    },
  };
}

function createService(params?: {
  hasPending?: boolean;
  queueSnapshot?: {
    webhookDefaultShards: Record<string, { waiting: number; active: number; delayed: number }>;
    webhookDefaultWorkerGroups: Record<
      string,
      { queues: string[]; counters: { waiting: number; active: number } }
    >;
  };
  config?: Partial<Record<string, number>>;
}) {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([{ has_pending: params?.hasPending ?? false }]),
  };
  const queueMetricsService = {
    getWebhookDefaultShardSnapshot: jest.fn().mockResolvedValue(
      params?.queueSnapshot ?? {
        webhookDefaultShards: buildDefaultShardSnapshot(),
        webhookDefaultWorkerGroups: buildWorkerGroupSnapshot(),
      },
    ),
  };

  const service = new WebhookRoutingService(
    prisma as never,
    queueMetricsService as never,
    createConfigMock(params?.config) as never,
  );

  return {
    service,
    prisma,
    queueMetricsService,
  };
}

function readSqlText(value: unknown): string {
  const sql = value as { sql?: unknown; text?: unknown; strings?: unknown };
  if (typeof sql.sql === 'string') {
    return sql.sql;
  }
  if (typeof sql.text === 'string') {
    return sql.text;
  }
  if (Array.isArray(sql.strings)) {
    return sql.strings.join('?');
  }
  return String(value);
}

describe('WebhookRoutingService', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('routes critical and background update types without touching adaptive chat routing', async () => {
    const { service, prisma, queueMetricsService } = createService();
    const joinChatId = '-72826040868309';

    await expect(service.resolveQueueName('evt-1', { type: 'message_callback' })).resolves.toBe(
      'moderation-critical',
    );
    await expect(
      service.resolveQueueName('evt-join', { type: 'user_added', message: { chatId: joinChatId } }),
    ).resolves.toBe(resolveJoinWebhookQueueNameForChatId(joinChatId));
    for (const [eventId, type] of [
      ['evt-user-removed', 'user_removed'],
      ['evt-bot-removed', 'bot_removed'],
      ['evt-bot-stopped', 'bot_stopped'],
      ['evt-dialog-removed', 'dialog_removed'],
      ['evt-message-removed', 'message_removed'],
    ] as const) {
      await expect(service.resolveQueueName(eventId, { type })).resolves.toBe(
        'moderation-background',
      );
    }

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(queueMetricsService.getWebhookDefaultShardSnapshot).not.toHaveBeenCalled();
  });

  it('routes message_edited updates through adaptive default chat routing', async () => {
    const { service, prisma, queueMetricsService } = createService();

    await expect(
      service.resolveQueueName('evt-edit', {
        type: 'message_edited',
        message: { chatId: 'chat-edited' },
      }),
    ).resolves.toBe(resolveDefaultWebhookQueueNameForChatId('chat-edited'));

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(queueMetricsService.getWebhookDefaultShardSnapshot).toHaveBeenCalledTimes(1);
  });

  it('checks outstanding chat work with an existence query instead of a full count', async () => {
    const { service, prisma } = createService();
    const webhookEventId = 'evt-exists-shape';
    const chatId = 'chat-exists-shape';

    await service.resolveQueueName(webhookEventId, {
      type: 'message_created',
      message: { chatId },
    });

    const query = prisma.$queryRaw.mock.calls[0]?.[0] as
      | { values?: readonly unknown[] }
      | undefined;
    const sqlText = readSqlText(query).replace(/\s+/gu, ' ');
    const quarantineMarker = `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`;
    expect(sqlText).toContain('SELECT EXISTS');
    expect(sqlText).toContain('LIMIT 1');
    expect(sqlText).toContain('status = \'FAILED\'::"WebhookStatus"');
    expect(sqlText).toContain('next_enqueue_at IS NOT NULL');
    expect(sqlText).toContain(`LEFT(COALESCE(error_message, ''), 37) = '${quarantineMarker}'`);
    expect(query?.values).not.toContain(37);
    expect(query?.values).not.toContain(quarantineMarker);
    expect(query?.values).toEqual(expect.arrayContaining([webhookEventId, chatId]));
    expect(sqlText).not.toMatch(/COUNT\s*\(\s*\*\s*\)/iu);
  });

  it('routes managed entity Старт commands to critical without adaptive chat routing', async () => {
    const { service, prisma, queueMetricsService } = createService();

    await expect(
      service.resolveQueueName('evt-start', {
        type: 'message_created',
        message: {
          chatId: '-100500',
          text: 'Старт',
        },
      }),
    ).resolves.toBe('moderation-critical');

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(queueMetricsService.getWebhookDefaultShardSnapshot).not.toHaveBeenCalled();
  });

  it('keeps a fresh chat assignment stable during its lease window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-30T17:00:00.000Z'));

    const firstSnapshot = buildDefaultShardSnapshot();
    firstSnapshot['moderation-default-7'] = {
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    };
    const secondSnapshot = buildDefaultShardSnapshot();
    secondSnapshot['moderation-default-2'] = {
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    };
    const { service, queueMetricsService, prisma } = createService({
      queueSnapshot: {
        webhookDefaultShards: firstSnapshot,
        webhookDefaultWorkerGroups: buildWorkerGroupSnapshot(),
      },
      config: {
        WEBHOOK_ROUTING_CHAT_ASSIGNMENT_TTL_SEC: 90,
      },
    });
    queueMetricsService.getWebhookDefaultShardSnapshot
      .mockResolvedValueOnce({
        webhookDefaultShards: firstSnapshot,
        webhookDefaultWorkerGroups: buildWorkerGroupSnapshot(),
      })
      .mockResolvedValueOnce({
        webhookDefaultShards: secondSnapshot,
        webhookDefaultWorkerGroups: buildWorkerGroupSnapshot({
          'api-moderation-realtime-c': { waiting: 0, active: 0 },
        }),
      });

    await expect(
      service.resolveQueueName('evt-1', {
        type: 'message_created',
        message: { chatId: 'chat-stable' },
      }),
    ).resolves.toBe('moderation-default-7');

    jest.advanceTimersByTime(30_000);

    await expect(
      service.resolveQueueName('evt-2', {
        type: 'message_created',
        message: { chatId: 'chat-stable' },
      }),
    ).resolves.toBe('moderation-default-7');

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(queueMetricsService.getWebhookDefaultShardSnapshot).toHaveBeenCalledTimes(2);
  });

  it('rebalances an expired idle chat onto the least-pressured default queue', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-30T17:10:00.000Z'));

    const firstSnapshot = buildDefaultShardSnapshot();
    firstSnapshot['moderation-default-7'] = {
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    };
    const secondSnapshot = buildDefaultShardSnapshot();
    secondSnapshot['moderation-default-2'] = {
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    };
    const { service, prisma, queueMetricsService } = createService({
      queueSnapshot: {
        webhookDefaultShards: firstSnapshot,
        webhookDefaultWorkerGroups: buildWorkerGroupSnapshot(),
      },
      config: {
        WEBHOOK_ROUTING_CHAT_ASSIGNMENT_TTL_SEC: 5,
      },
    });

    await expect(
      service.resolveQueueName('evt-1', {
        type: 'message_created',
        message: { chatId: 'chat-idle' },
      }),
    ).resolves.toBe('moderation-default-7');

    prisma.$queryRaw.mockResolvedValueOnce([{ has_pending: false }]);
    queueMetricsService.getWebhookDefaultShardSnapshot.mockResolvedValueOnce({
      webhookDefaultShards: secondSnapshot,
      webhookDefaultWorkerGroups: buildWorkerGroupSnapshot({
        'api-moderation-realtime-c': { waiting: 0, active: 0 },
      }),
    });

    jest.advanceTimersByTime(5_001);

    await expect(
      service.resolveQueueName('evt-2', {
        type: 'message_created',
        message: { chatId: 'chat-idle' },
      }),
    ).resolves.toBe('moderation-default-2');
  });

  it('keeps the previous queue when a chat still has outstanding received or queued work', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-30T17:20:00.000Z'));

    const firstSnapshot = buildDefaultShardSnapshot();
    firstSnapshot['moderation-default-7'] = {
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    };
    const { service, prisma, queueMetricsService } = createService({
      queueSnapshot: {
        webhookDefaultShards: firstSnapshot,
        webhookDefaultWorkerGroups: buildWorkerGroupSnapshot(),
      },
      config: {
        WEBHOOK_ROUTING_CHAT_ASSIGNMENT_TTL_SEC: 5,
      },
    });

    await expect(
      service.resolveQueueName('evt-1', {
        type: 'message_created',
        message: { chatId: 'chat-busy' },
      }),
    ).resolves.toBe('moderation-default-7');

    prisma.$queryRaw.mockResolvedValueOnce([{ has_pending: true }]);
    jest.advanceTimersByTime(5_001);

    await expect(
      service.resolveQueueName('evt-2', {
        type: 'message_created',
        message: { chatId: 'chat-busy' },
      }),
    ).resolves.toBe('moderation-default-7');

    expect(queueMetricsService.getWebhookDefaultShardSnapshot).toHaveBeenCalledTimes(1);
  });

  it('restores the persisted outstanding shard after the in-memory chat assignment expires', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-15T11:00:00.000Z'));

    const chatId = 'chat-persisted-shard';
    const firstQueue = 'moderation-default-7';
    const persistedQueue = 'moderation-default-2';
    const firstSnapshot = buildDefaultShardSnapshot();
    firstSnapshot[firstQueue] = {
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    };
    const { service, prisma, queueMetricsService } = createService({
      queueSnapshot: {
        webhookDefaultShards: firstSnapshot,
        webhookDefaultWorkerGroups: buildWorkerGroupSnapshot(),
      },
      config: {
        WEBHOOK_ROUTING_CHAT_ASSIGNMENT_TTL_SEC: 5,
      },
    });

    await expect(
      service.resolveQueueName('evt-persisted-shard-1', {
        type: 'message_created',
        message: { chatId },
      }),
    ).resolves.toBe(firstQueue);

    prisma.$queryRaw.mockResolvedValueOnce([{ has_pending: true, queue_name: persistedQueue }]);
    jest.advanceTimersByTime(5_001);

    await expect(
      service.resolveQueueName('evt-persisted-shard-2', {
        type: 'message_created',
        message: { chatId },
      }),
    ).resolves.toBe(persistedQueue);

    expect(queueMetricsService.getWebhookDefaultShardSnapshot).toHaveBeenCalledTimes(1);
  });

  it('keeps distinct cross-bot chat messages on one ordered shard while work is outstanding', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-15T12:00:00.000Z'));

    const chatId = 'shared-chat-cross-bot-order';
    const hashedQueue = resolveDefaultWebhookQueueNameForChatId(chatId);
    const candidateQueues = DEFAULT_WEBHOOK_QUEUE_NAMES.filter(
      (queueName) => queueName !== hashedQueue,
    );
    const firstQueue = candidateQueues[0]!;
    const pressurePreferredQueue = candidateQueues[1]!;
    const firstSnapshot = buildDefaultShardSnapshot();
    firstSnapshot[firstQueue] = {
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    };
    const pressureSnapshot = buildDefaultShardSnapshot();
    pressureSnapshot[pressurePreferredQueue] = {
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    };
    const { service, prisma, queueMetricsService } = createService({
      queueSnapshot: {
        webhookDefaultShards: firstSnapshot,
        webhookDefaultWorkerGroups: buildWorkerGroupSnapshot(),
      },
      config: {
        WEBHOOK_ROUTING_CHAT_ASSIGNMENT_TTL_SEC: 5,
      },
    });

    await expect(
      service.resolveQueueName('evt-cross-bot-1', {
        updateId: 'update-cross-bot-1',
        botId: 'bot-1',
        type: 'message_created',
        message: { chatId, messageId: 'message-cross-bot-1' },
      }),
    ).resolves.toBe(firstQueue);

    prisma.$queryRaw.mockResolvedValueOnce([{ has_pending: true }]);
    queueMetricsService.getWebhookDefaultShardSnapshot.mockResolvedValueOnce({
      webhookDefaultShards: pressureSnapshot,
      webhookDefaultWorkerGroups: buildWorkerGroupSnapshot(),
    });
    jest.advanceTimersByTime(5_001);

    await expect(
      service.resolveQueueName('evt-cross-bot-2', {
        updateId: 'update-cross-bot-2',
        botId: 'bot-2',
        type: 'message_created',
        message: { chatId, messageId: 'message-cross-bot-2' },
      }),
    ).resolves.toBe(firstQueue);

    const secondSqlText = readSqlText(prisma.$queryRaw.mock.calls[1]?.[0]).replace(/\s+/gu, ' ');
    expect(secondSqlText).not.toContain('bot_id');
    expect(queueMetricsService.getWebhookDefaultShardSnapshot).toHaveBeenCalledTimes(1);
  });

  it('prefers a queue on a colder worker group even when raw queue depth looks similar', async () => {
    const queueSnapshot = {
      webhookDefaultShards: {
        ...buildDefaultShardSnapshot(),
        'moderation-default-7': {
          waiting: 0,
          active: 1,
          delayed: 0,
          failed: 0,
          completed: 0,
        },
        'moderation-default-2': {
          waiting: 0,
          active: 0,
          delayed: 0,
          failed: 0,
          completed: 0,
        },
      },
      webhookDefaultWorkerGroups: buildWorkerGroupSnapshot({
        'api-moderation-realtime-d': { waiting: 0, active: 1 },
        'api-moderation-realtime-c': { waiting: 0, active: 0 },
      }),
    };
    const { service } = createService({
      queueSnapshot,
    });

    await expect(
      service.resolveQueueName('evt-1', {
        type: 'message_created',
        message: { chatId: 'chat-hot-worker' },
      }),
    ).resolves.toBe('moderation-default-2');
  });

  it('rebalances a still-fresh assignment early when its worker group becomes dominant', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-30T17:30:00.000Z'));

    const firstSnapshot = buildDefaultShardSnapshot();
    firstSnapshot['moderation-default-7'] = {
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    };
    const secondSnapshot = buildDefaultShardSnapshot();
    secondSnapshot['moderation-default-7'] = {
      waiting: 1,
      active: 1,
      delayed: 0,
      failed: 0,
      completed: 0,
    };
    secondSnapshot['moderation-default-2'] = {
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    };
    const { service, prisma, queueMetricsService } = createService({
      queueSnapshot: {
        webhookDefaultShards: firstSnapshot,
        webhookDefaultWorkerGroups: buildWorkerGroupSnapshot({
          'api-moderation-realtime-d': { waiting: 0, active: 0 },
        }),
      },
      config: {
        WEBHOOK_ROUTING_CHAT_ASSIGNMENT_TTL_SEC: 90,
        WEBHOOK_ROUTING_HOT_WORKER_REBALANCE_MIN_AGE_MS: 12_000,
        WEBHOOK_ROUTING_HOT_WORKER_REBALANCE_PRESSURE_SHARE: 0.7,
        WEBHOOK_ROUTING_HOT_WORKER_REBALANCE_PRESSURE_MIN: 4,
      },
    });

    await expect(
      service.resolveQueueName('evt-1', {
        type: 'message_created',
        message: { chatId: 'chat-burst-rebalance' },
      }),
    ).resolves.toBe('moderation-default-7');

    prisma.$queryRaw.mockResolvedValueOnce([{ has_pending: false }]);
    queueMetricsService.getWebhookDefaultShardSnapshot.mockResolvedValueOnce({
      webhookDefaultShards: secondSnapshot,
      webhookDefaultWorkerGroups: buildWorkerGroupSnapshot({
        'api-moderation-realtime-d': { waiting: 10, active: 2 },
        'api-moderation-realtime-c': { waiting: 0, active: 0 },
        'api-moderation': { waiting: 0, active: 0 },
        'api-moderation-realtime-b': { waiting: 0, active: 0 },
      }),
    });
    queueMetricsService.getWebhookDefaultShardSnapshot.mockResolvedValueOnce({
      webhookDefaultShards: secondSnapshot,
      webhookDefaultWorkerGroups: buildWorkerGroupSnapshot({
        'api-moderation-realtime-d': { waiting: 10, active: 2 },
        'api-moderation-realtime-c': { waiting: 0, active: 0 },
        'api-moderation': { waiting: 0, active: 0 },
        'api-moderation-realtime-b': { waiting: 0, active: 0 },
      }),
    });

    jest.advanceTimersByTime(15_000);

    await expect(
      service.resolveQueueName('evt-2', {
        type: 'message_created',
        message: { chatId: 'chat-burst-rebalance' },
      }),
    ).resolves.toBe('moderation-default-2');
  });
});
