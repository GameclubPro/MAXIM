import { WebhookStatus } from '../prisma/prisma-client';
import { getQueueToken } from '@nestjs/bullmq';
import {
  AUXILIARY_QUEUE_NAMES,
  QueueMetricsService,
  USER_FACING_WEBHOOK_UPDATE_TYPES,
} from './queue-metrics.service';
import {
  MAX_ACTION_BACKGROUND_QUEUE,
  MAX_ACTION_CRITICAL_QUEUE,
  MAX_ACTION_INTERACTIVE_QUEUE,
  MAX_ACTION_LEGACY_QUEUE,
} from '../max/max-action.queue';
import { DEFAULT_WEBHOOK_QUEUE_NAMES } from '../webhook/webhook-queues';
import { MODERATION_DELETE_INTENT_QUEUE } from '../moderation/moderation-delete-intent.queue';
import { PHOTO_DUPLICATE_QUEUE } from '../moderation/photo-duplicate/photo-duplicate.queue';
import { PUBLISHER_BINDING_REFRESH_QUEUE } from '../publisher/publisher-binding-refresh.queue';
import { PUBLISHER_CHAT_COMMENT_QUEUE } from '../publisher/publisher-chat-comment.queue';
import { PUBLISHER_AUTO_REPLY_QUEUE } from '../publisher/publisher-auto-reply.queue';
import { PUBLISHER_AUTO_REPLY_AUTHORING_QUEUE } from '../publisher/publisher-auto-reply-authoring.queue';
import { PUBLISHER_SUGGESTION_PUBLICATION_QUEUE } from '../admin/publisher-suggestion-publication.queue';

function createQueueMock(counts: {
  waiting: number;
  prioritized: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}) {
  return {
    getJobCounts: jest.fn().mockResolvedValue({
      waiting: counts.waiting,
      paused: 0,
      prioritized: counts.prioritized,
      active: counts.active,
      delayed: counts.delayed,
      failed: counts.failed,
      completed: counts.completed,
    }),
  };
}

describe('QueueMetricsService', () => {
  it('reads every BullMQ counter in one call and includes paused jobs in waiting', async () => {
    const getJobCounts = jest.fn().mockResolvedValue({
      waiting: 2,
      paused: 3,
      prioritized: 4,
      active: 5,
      delayed: 6,
      failed: 7,
      completed: 8,
    });
    const service = Object.create(QueueMetricsService.prototype) as QueueMetricsService;

    await expect((service as any).readQueueCounters({ getJobCounts })).resolves.toEqual({
      waiting: 5,
      prioritized: 4,
      active: 5,
      delayed: 6,
      failed: 7,
      completed: 8,
    });
    expect(getJobCounts).toHaveBeenCalledWith(
      'waiting',
      'prioritized',
      'active',
      'delayed',
      'failed',
      'completed',
    );
  });

  it('returns queue counters, webhook status metrics, and action health in one snapshot', async () => {
    const prisma = {
      webhookEvent: {
        count: jest
          .fn()
          .mockImplementation(async ({ where }: { where: { status: WebhookStatus } }) => {
            switch (where.status) {
              case WebhookStatus.RECEIVED:
                return 7;
              case WebhookStatus.QUEUED:
                return 3;
              case WebhookStatus.FAILED:
                return 2;
              default:
                return 0;
            }
          }),
        findFirst: jest
          .fn()
          .mockImplementation(async ({ where }: { where: { status: WebhookStatus } }) => {
            switch (where.status) {
              case WebhookStatus.RECEIVED:
                return {
                  id: 'received-1',
                  createdAt: new Date(Date.now() - 12_000),
                };
              case WebhookStatus.QUEUED:
                return {
                  id: 'queued-1',
                  createdAt: new Date(Date.now() - 25_000),
                };
              case WebhookStatus.FAILED:
                return {
                  id: 'failed-1',
                  createdAt: new Date(Date.now() - 40_000),
                };
              default:
                return null;
            }
          }),
        groupBy: jest.fn().mockResolvedValue([
          {
            queueName: 'moderation-default-0',
            _count: {
              _all: 3,
            },
          },
        ]),
      },
    };
    const actionHealthService = {
      refreshSnapshots: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn().mockReturnValue({
        windowSec: 60,
        total: 50,
        success: 48,
        failure: 2,
        critical: 1,
        errorRate: 0.04,
        criticalRate: 0.02,
      }),
      getCombinedSnapshot: jest.fn().mockReturnValue({
        windowSec: 60,
        total: 20,
        success: 19,
        failure: 1,
        critical: 0,
        errorRate: 0.05,
        criticalRate: 0,
      }),
    };
    const defaultQueues = Object.fromEntries(
      DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName, index) => [
        queueName,
        createQueueMock(
          index === 0
            ? { waiting: 1, prioritized: 0, active: 1, delayed: 0, failed: 0, completed: 4 }
            : index === 1
              ? { waiting: 1, prioritized: 2, active: 0, delayed: 0, failed: 0, completed: 5 }
              : { waiting: 0, prioritized: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        ),
      ]),
    );
    const auxiliaryQueues = {
      'admin-managed-entities-refresh': createQueueMock({
        waiting: 4,
        prioritized: 0,
        active: 1,
        delayed: 12,
        failed: 2,
        completed: 80,
      }),
      [MODERATION_DELETE_INTENT_QUEUE]: createQueueMock({
        waiting: 6,
        prioritized: 1,
        active: 2,
        delayed: 9,
        failed: 3,
        completed: 44,
      }),
    };
    const queueProviders: Record<string, ReturnType<typeof createQueueMock> | undefined> = {
      ...Object.fromEntries(
        DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName) => [
          getQueueToken(queueName),
          defaultQueues[queueName],
        ]),
      ),
      [getQueueToken('admin-managed-entities-refresh')]:
        auxiliaryQueues['admin-managed-entities-refresh'],
      [getQueueToken(MODERATION_DELETE_INTENT_QUEUE)]:
        auxiliaryQueues[MODERATION_DELETE_INTENT_QUEUE],
      [getQueueToken(PUBLISHER_BINDING_REFRESH_QUEUE)]: createQueueMock({
        waiting: 5,
        prioritized: 0,
        active: 1,
        delayed: 2,
        failed: 3,
        completed: 21,
      }),
      [getQueueToken(PUBLISHER_CHAT_COMMENT_QUEUE)]: createQueueMock({
        waiting: 7,
        prioritized: 1,
        active: 2,
        delayed: 4,
        failed: 6,
        completed: 31,
      }),
      [getQueueToken(PUBLISHER_AUTO_REPLY_QUEUE)]: createQueueMock({
        waiting: 4,
        prioritized: 2,
        active: 1,
        delayed: 3,
        failed: 1,
        completed: 18,
      }),
      [getQueueToken(PUBLISHER_AUTO_REPLY_AUTHORING_QUEUE)]: createQueueMock({
        waiting: 2,
        prioritized: 1,
        active: 1,
        delayed: 0,
        failed: 0,
        completed: 9,
      }),
      [getQueueToken(PUBLISHER_SUGGESTION_PUBLICATION_QUEUE)]: createQueueMock({
        waiting: 9,
        prioritized: 0,
        active: 1,
        delayed: 8,
        failed: 4,
        completed: 12,
      }),
      [getQueueToken(MAX_ACTION_CRITICAL_QUEUE)]: createQueueMock({
        waiting: 2,
        prioritized: 0,
        active: 1,
        delayed: 0,
        failed: 0,
        completed: 5,
      }),
      [getQueueToken(MAX_ACTION_INTERACTIVE_QUEUE)]: createQueueMock({
        waiting: 4,
        prioritized: 1,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 6,
      }),
      [getQueueToken(MAX_ACTION_BACKGROUND_QUEUE)]: createQueueMock({
        waiting: 0,
        prioritized: 0,
        active: 0,
        delayed: 3,
        failed: 1,
        completed: 7,
      }),
    };
    const moduleRef = {
      get: jest.fn((token: string) => queueProviders[token]),
    };
    const botRegistry = {
      getAllBots: jest.fn().mockReturnValue([{ id: '777000_bot' }]),
      getDefaultBot: jest.fn().mockReturnValue({ id: '777000_bot' }),
    };

    const service = new QueueMetricsService(
      prisma as never,
      actionHealthService as never,
      moduleRef as never,
      botRegistry as never,
      undefined,
      createQueueMock({
        waiting: 1,
        prioritized: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 10,
      }) as never,
      createQueueMock({
        waiting: 0,
        prioritized: 0,
        active: 0,
        delayed: 1,
        failed: 0,
        completed: 4,
      }) as never,
      createQueueMock({
        waiting: 0,
        prioritized: 0,
        active: 0,
        delayed: 0,
        failed: 1,
        completed: 2,
      }) as never,
      createQueueMock({
        waiting: 3,
        prioritized: 0,
        active: 1,
        delayed: 0,
        failed: 0,
        completed: 11,
      }) as never,
      createQueueMock({
        waiting: 2,
        prioritized: 1,
        active: 1,
        delayed: 0,
        failed: 0,
        completed: 7,
      }) as never,
      {
        getSnapshot: jest.fn().mockResolvedValue({
          enabled: true,
          activeOnThisRole: true,
          staleAfterSec: 300,
          intervalSec: 60,
          lastRunAt: '2026-07-11T00:00:00.000Z',
          lastSuccessAt: '2026-07-11T00:00:01.000Z',
          lastError: null,
          lastRunReason: 'scheduled',
          staleCount: 3,
          staleEnqueuedCount: 2,
          staleInProgressCount: 1,
          oldestStaleAgeSec: 900,
          lastScannedCount: 3,
          lastReconciledCount: 2,
          lastQuarantinedCount: 1,
          lastTerminalFailedCount: 1,
          lastRecoveredSucceededCount: 0,
          lastDeferredCount: 1,
          lastConflictCount: 0,
          lastScanTruncated: false,
          generatedAt: '2026-07-11T00:00:02.000Z',
        }),
      } as never,
    );

    const snapshot = await service.getSnapshot();

    expect(defaultQueues[DEFAULT_WEBHOOK_QUEUE_NAMES[0]]?.getJobCounts).toHaveBeenCalledWith(
      'waiting',
      'prioritized',
      'active',
      'delayed',
      'failed',
      'completed',
    );
    expect(snapshot.moderation).toEqual({
      waiting: 3,
      prioritized: 2,
      active: 1,
      delayed: 1,
      failed: 1,
      completed: 25,
    });
    expect(snapshot.actions).toEqual({
      waiting: 9,
      prioritized: 1,
      active: 2,
      delayed: 3,
      failed: 1,
      completed: 29,
    });
    expect(snapshot.actionQueues).toEqual({
      [MAX_ACTION_LEGACY_QUEUE]: {
        waiting: 3,
        prioritized: 0,
        active: 1,
        delayed: 0,
        failed: 0,
        completed: 11,
      },
      [MAX_ACTION_CRITICAL_QUEUE]: {
        waiting: 2,
        prioritized: 0,
        active: 1,
        delayed: 0,
        failed: 0,
        completed: 5,
      },
      [MAX_ACTION_INTERACTIVE_QUEUE]: {
        waiting: 4,
        prioritized: 1,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 6,
      },
      [MAX_ACTION_BACKGROUND_QUEUE]: {
        waiting: 0,
        prioritized: 0,
        active: 0,
        delayed: 3,
        failed: 1,
        completed: 7,
      },
    });
    expect(snapshot.globalSpammerDenorm).toEqual({
      waiting: 2,
      prioritized: 1,
      active: 1,
      delayed: 0,
      failed: 0,
      completed: 7,
    });
    expect(snapshot.actionLedgerWatchdog).toEqual(
      expect.objectContaining({
        staleCount: 3,
        oldestStaleAgeSec: 900,
        lastQuarantinedCount: 1,
        lastError: null,
      }),
    );
    expect(snapshot.auxiliaryQueues['admin-managed-entities-refresh']).toEqual({
      waiting: 4,
      prioritized: 0,
      active: 1,
      delayed: 12,
      failed: 2,
      completed: 80,
    });
    expect(snapshot.auxiliaryQueues['vk-parsing-publish']).toEqual({
      waiting: 0,
      prioritized: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    });
    expect(snapshot.auxiliaryQueues[MODERATION_DELETE_INTENT_QUEUE]).toEqual({
      waiting: 6,
      prioritized: 1,
      active: 2,
      delayed: 9,
      failed: 3,
      completed: 44,
    });
    expect(snapshot.auxiliaryQueues[PUBLISHER_BINDING_REFRESH_QUEUE]).toMatchObject({
      waiting: 5,
      active: 1,
      failed: 3,
    });
    expect(snapshot.auxiliaryQueues[PUBLISHER_CHAT_COMMENT_QUEUE]).toMatchObject({
      waiting: 7,
      active: 2,
      failed: 6,
    });
    expect(snapshot.auxiliaryQueues[PUBLISHER_AUTO_REPLY_QUEUE]).toMatchObject({
      waiting: 4,
      active: 1,
      failed: 1,
    });
    expect(snapshot.auxiliaryQueues[PUBLISHER_AUTO_REPLY_AUTHORING_QUEUE]).toMatchObject({
      waiting: 2,
      active: 1,
      failed: 0,
    });
    expect(snapshot.auxiliaryQueues[PUBLISHER_SUGGESTION_PUBLICATION_QUEUE]).toMatchObject({
      waiting: 9,
      active: 1,
      failed: 4,
    });
    expect(snapshot.auxiliaryQueues).toHaveProperty(PHOTO_DUPLICATE_QUEUE);
    expect(Object.keys(snapshot.auxiliaryQueues).sort()).toEqual([...AUXILIARY_QUEUE_NAMES].sort());
    expect(snapshot.webhookDefaultShards['moderation-default-0']).toEqual({
      waiting: 1,
      prioritized: 0,
      active: 1,
      delayed: 0,
      failed: 0,
      completed: 4,
    });
    expect(snapshot.webhookDefaultShards['moderation-default-7']).toEqual({
      waiting: 0,
      prioritized: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    });
    expect(snapshot.webhookDefaultWorkerGroups['api-moderation']).toEqual({
      queues: [
        'moderation-default-0',
        'moderation-default-4',
        'moderation-default-8',
        'moderation-default-12',
      ],
      counters: {
        waiting: 1,
        prioritized: 0,
        active: 1,
        delayed: 0,
        failed: 0,
        completed: 4,
      },
    });
    expect(snapshot.webhookDefaultWorkerGroups['api-moderation-realtime-b']).toEqual({
      queues: [
        'moderation-default-1',
        'moderation-default-5',
        'moderation-default-9',
        'moderation-default-13',
      ],
      counters: {
        waiting: 1,
        prioritized: 2,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 5,
      },
    });
    expect(snapshot.webhookDefaultWorkerGroups['api-moderation-realtime-c']).toEqual({
      queues: [
        'moderation-default-2',
        'moderation-default-6',
        'moderation-default-10',
        'moderation-default-14',
      ],
      counters: {
        waiting: 0,
        prioritized: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 0,
      },
    });
    expect(snapshot.webhookDefaultWorkerGroups['api-moderation-realtime-d']).toEqual({
      queues: [
        'moderation-default-3',
        'moderation-default-7',
        'moderation-default-11',
        'moderation-default-15',
      ],
      counters: {
        waiting: 0,
        prioritized: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 0,
      },
    });
    expect(snapshot.webhookEvents).toMatchObject({
      received: {
        count: 7,
        oldestEventId: 'received-1',
      },
      queued: {
        count: 3,
        oldestEventId: 'queued-1',
      },
      failed: {
        count: 2,
        oldestEventId: 'failed-1',
        activeCount: 2,
        activeWindowSec: 21600,
      },
    });
    expect(snapshot.actionHealth).toEqual({
      windowSec: 60,
      total: 50,
      success: 48,
      failure: 2,
      critical: 1,
      errorRate: 0.04,
      criticalRate: 0.02,
    });
    expect(snapshot.webhookDynamicLeases).toBeNull();
    expect(snapshot.oldestQueuedEventId).toBe('queued-1');
    expect(snapshot.oldestReceivedEventId).toBe('received-1');
    expect(snapshot.effectiveLagSec).toBeGreaterThanOrEqual(snapshot.oldestQueuedLagSec);
    expect(snapshot.bots['777000_bot']).toEqual(
      expect.objectContaining({
        queuedByQueue: {
          'moderation-default-0': 3,
        },
        actionHealth: {
          windowSec: 60,
          total: 20,
          success: 19,
          failure: 1,
          critical: 0,
          errorRate: 0.05,
          criticalRate: 0,
        },
      }),
    );
  });

  it('separates active failed webhook events from stale historical tails', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-12T12:00:00.000Z'));

    try {
      const prisma = {
        webhookEvent: {
          count: jest
            .fn()
            .mockImplementation(
              async ({
                where,
              }: {
                where: { status: WebhookStatus; createdAt?: { gte: Date } };
              }) => {
                if (where.status !== WebhookStatus.FAILED) {
                  return 0;
                }

                return where.createdAt?.gte ? 1 : 5;
              },
            ),
          findFirst: jest
            .fn()
            .mockImplementation(async ({ where }: { where: { status: WebhookStatus } }) => {
              if (where.status !== WebhookStatus.FAILED) {
                return null;
              }

              return {
                id: 'failed-oldest',
                createdAt: new Date('2026-04-12T03:00:00.000Z'),
              };
            }),
          groupBy: jest.fn().mockResolvedValue([]),
        },
      };
      const actionHealthService = {
        refreshSnapshots: jest.fn().mockResolvedValue(undefined),
        getSnapshot: jest.fn().mockReturnValue({
          windowSec: 60,
          total: 0,
          success: 0,
          failure: 0,
          critical: 0,
          errorRate: 0,
          criticalRate: 0,
        }),
      };
      const moduleRef = {
        get: jest.fn(),
      };
      const botRegistry = {
        getAllBots: jest.fn().mockReturnValue([]),
        getDefaultBot: jest.fn().mockReturnValue({ id: '777000_bot' }),
      };

      const service = new QueueMetricsService(
        prisma as never,
        actionHealthService as never,
        moduleRef as never,
        botRegistry as never,
      );

      const snapshot = await service.getSnapshot();

      expect(snapshot.webhookEvents.failed).toEqual(
        expect.objectContaining({
          count: 5,
          activeCount: 1,
          staleCount: 4,
          activeWindowSec: 21600,
          oldestEventId: 'failed-oldest',
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the raw user-facing webhook metrics query scoped to the filtered CTE rows', async () => {
    const rawQuery = jest.fn().mockResolvedValue([
      {
        count: BigInt(0),
        activeCount: BigInt(0),
        oldestEventId: null,
        oldestCreatedAt: null,
      },
    ]);
    const prisma = {
      $queryRaw: rawQuery,
      webhookEvent: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };
    const actionHealthService = {
      refreshSnapshots: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn().mockReturnValue({
        windowSec: 60,
        total: 0,
        success: 0,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      }),
    };
    const moduleRef = {
      get: jest.fn(),
    };
    const botRegistry = {
      getAllBots: jest.fn().mockReturnValue([]),
      getDefaultBot: jest.fn().mockReturnValue({ id: '777000_bot' }),
    };

    const service = new QueueMetricsService(
      prisma as never,
      actionHealthService as never,
      moduleRef as never,
      botRegistry as never,
    );

    await service.getSnapshot();

    const queryTexts = rawQuery.mock.calls.map(([query]) => {
      const sqlQuery = query as { sql?: string; strings?: readonly string[] };
      return sqlQuery.sql ?? sqlQuery.strings?.join('') ?? String(query);
    });
    const queryValues = rawQuery.mock.calls.flatMap(([query]) => {
      const sqlQuery = query as { values?: readonly unknown[] };
      return Array.isArray(sqlQuery.values) ? sqlQuery.values : [];
    });

    expect(queryTexts.some((text) => text.includes('FROM filtered'))).toBe(true);
    for (const updateType of USER_FACING_WEBHOOK_UPDATE_TYPES) {
      expect(queryValues).toContain(updateType);
    }
    for (const lifecycleType of [
      'message_removed',
      'user_removed',
      'bot_removed',
      'bot_stopped',
      'dialog_removed',
      'chat_title_changed',
    ]) {
      expect(queryValues).not.toContain(lifecycleType);
    }
  });

  it('aggregates default worker group counters by dynamic lease actual owner when available', async () => {
    const prisma = {
      webhookEvent: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };
    const actionHealthService = {
      refreshSnapshots: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn().mockReturnValue({
        windowSec: 60,
        total: 0,
        success: 0,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      }),
      getCombinedSnapshot: jest.fn().mockReturnValue({
        windowSec: 60,
        total: 0,
        success: 0,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      }),
    };
    const defaultQueues = Object.fromEntries(
      DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName, index) => [
        queueName,
        createQueueMock(
          queueName === 'moderation-default-0'
            ? { waiting: 2, prioritized: 3, active: 1, delayed: 0, failed: 0, completed: 0 }
            : index === 1
              ? { waiting: 1, prioritized: 0, active: 0, delayed: 0, failed: 0, completed: 0 }
              : { waiting: 0, prioritized: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        ),
      ]),
    );
    const moduleRef = {
      get: jest.fn(
        (token: string) =>
          Object.fromEntries(
            DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName) => [
              getQueueToken(queueName),
              defaultQueues[queueName],
            ]),
          )[token],
      ),
    };
    const botRegistry = {
      getAllBots: jest.fn().mockReturnValue([]),
      getDefaultBot: jest.fn().mockReturnValue({ id: '777000_bot' }),
    };
    const webhookDynamicLeaseStatusService = {
      getSummary: jest.fn().mockResolvedValue({
        mode: 'canary',
        generatedAt: '2026-03-31T00:00:00.000Z',
        liveWorkerGroups: [
          'api-moderation',
          'api-moderation-realtime-b',
          'api-moderation-realtime-c',
          'api-moderation-realtime-d',
        ],
        workerLoads: {
          'api-moderation': 1,
          'api-moderation-realtime-b': 6,
          'api-moderation-realtime-c': 0,
          'api-moderation-realtime-d': 0,
        },
        queues: Object.fromEntries(
          DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName) => [
            queueName,
            {
              queueName,
              homeOwner:
                queueName === 'moderation-default-0'
                  ? 'api-moderation'
                  : 'api-moderation-realtime-b',
              actualOwner:
                queueName === 'moderation-default-0'
                  ? 'api-moderation-realtime-b'
                  : queueName === 'moderation-default-1'
                    ? 'api-moderation-realtime-b'
                    : 'api-moderation',
              desiredOwner:
                queueName === 'moderation-default-0'
                  ? 'api-moderation-realtime-b'
                  : queueName === 'moderation-default-1'
                    ? 'api-moderation-realtime-b'
                    : 'api-moderation',
              eligibleForDynamicLeases: queueName === 'moderation-default-0',
              handoffPending: false,
              activeJobs: 0,
              pressure: 0,
              reason: 'keep-current-owner',
              claimFencingToken: null,
              claimLeaseUntil: null,
              lastHandoffAt: null,
            },
          ]),
        ),
      }),
    };

    const service = new QueueMetricsService(
      prisma as never,
      actionHealthService as never,
      moduleRef as never,
      botRegistry as never,
      webhookDynamicLeaseStatusService as never,
      createQueueMock({
        waiting: 0,
        prioritized: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 0,
      }) as never,
      createQueueMock({
        waiting: 0,
        prioritized: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 0,
      }) as never,
      createQueueMock({
        waiting: 0,
        prioritized: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 0,
      }) as never,
      createQueueMock({
        waiting: 0,
        prioritized: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 0,
      }) as never,
    );

    const snapshot = await service.getSnapshot();

    expect(snapshot.webhookDynamicLeases?.mode).toBe('canary');
    expect(snapshot.webhookDefaultWorkerGroups['api-moderation-realtime-b']).toEqual({
      queues: ['moderation-default-0', 'moderation-default-1'],
      counters: {
        waiting: 3,
        prioritized: 3,
        active: 1,
        delayed: 0,
        failed: 0,
        completed: 0,
      },
    });
  });
});
