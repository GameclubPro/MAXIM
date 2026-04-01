import { WebhookRoutingService } from './webhook-routing.service';
import { resolveJoinWebhookQueueNameForChatId } from './webhook-queues';

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

function buildWorkerGroupSnapshot(overrides: Partial<Record<string, { waiting: number; active: number }>> = {}) {
  return {
    'api-moderation': {
      queues: [
        'moderation-default-0',
        'moderation-default-4',
        'moderation-default-8',
        'moderation-default-12',
      ],
      counters: { waiting: 4, active: 1, delayed: 0, failed: 0, completed: 0, ...overrides['api-moderation'] },
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
  pendingCount?: bigint | number;
  queueSnapshot?: {
    webhookDefaultShards: Record<string, { waiting: number; active: number; delayed: number }>;
    webhookDefaultWorkerGroups: Record<string, { queues: string[]; counters: { waiting: number; active: number } }>;
  };
  config?: Partial<Record<string, number>>;
}) {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([{ pending_count: params?.pendingCount ?? 0 }]),
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
    await expect(service.resolveQueueName('evt-2', { type: 'user_removed' })).resolves.toBe(
      'moderation-background',
    );

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

    prisma.$queryRaw.mockResolvedValueOnce([{ pending_count: 0 }]);
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

    prisma.$queryRaw.mockResolvedValueOnce([{ pending_count: 2 }]);
    jest.advanceTimersByTime(5_001);

    await expect(
      service.resolveQueueName('evt-2', {
        type: 'message_created',
        message: { chatId: 'chat-busy' },
      }),
    ).resolves.toBe('moderation-default-7');

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

    prisma.$queryRaw.mockResolvedValueOnce([{ pending_count: 0 }]);
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
