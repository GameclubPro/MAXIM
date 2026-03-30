import { WebhookStatus } from '@prisma/client';
import { getQueueToken } from '@nestjs/bullmq';
import { QueueMetricsService } from './queue-metrics.service';
import { DEFAULT_WEBHOOK_QUEUE_NAMES } from '../webhook/webhook-queues';

function createQueueMock(counts: {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}) {
  return {
    getWaitingCount: jest.fn().mockResolvedValue(counts.waiting),
    getActiveCount: jest.fn().mockResolvedValue(counts.active),
    getDelayedCount: jest.fn().mockResolvedValue(counts.delayed),
    getFailedCount: jest.fn().mockResolvedValue(counts.failed),
    getCompletedCount: jest.fn().mockResolvedValue(counts.completed),
  };
}

describe('QueueMetricsService', () => {
  it('returns queue counters, webhook status metrics, and action health in one snapshot', async () => {
    const prisma = {
      webhookEvent: {
        count: jest.fn().mockImplementation(async ({ where }: { where: { status: WebhookStatus } }) => {
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
    };
    const defaultQueues = Object.fromEntries(
      DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName, index) => [
        queueName,
        createQueueMock(
          index === 0
            ? { waiting: 1, active: 1, delayed: 0, failed: 0, completed: 4 }
            : index === 1
              ? { waiting: 1, active: 0, delayed: 0, failed: 0, completed: 5 }
              : { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        ),
      ]),
    );
    const moduleRef = {
      get: jest.fn((token: string) =>
        Object.fromEntries(
          DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName) => [getQueueToken(queueName), defaultQueues[queueName]]),
        )[token],
      ),
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
      createQueueMock({ waiting: 1, active: 0, delayed: 0, failed: 0, completed: 10 }) as never,
      createQueueMock({ waiting: 0, active: 0, delayed: 1, failed: 0, completed: 4 }) as never,
      createQueueMock({ waiting: 0, active: 0, delayed: 0, failed: 1, completed: 2 }) as never,
      createQueueMock({ waiting: 3, active: 1, delayed: 0, failed: 0, completed: 11 }) as never,
    );

    const snapshot = await service.getSnapshot();

    expect(snapshot.moderation).toEqual({
      waiting: 3,
      active: 1,
      delayed: 1,
      failed: 1,
      completed: 25,
    });
    expect(snapshot.actions).toEqual({
      waiting: 3,
      active: 1,
      delayed: 0,
      failed: 0,
      completed: 11,
    });
    expect(snapshot.webhookDefaultShards['moderation-default-0']).toEqual({
      waiting: 1,
      active: 1,
      delayed: 0,
      failed: 0,
      completed: 4,
    });
    expect(snapshot.webhookDefaultShards['moderation-default-7']).toEqual({
      waiting: 0,
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
          total: 50,
          success: 48,
          failure: 2,
          critical: 1,
          errorRate: 0.04,
          criticalRate: 0.02,
        },
      }),
    );
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
    };
    const defaultQueues = Object.fromEntries(
      DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName, index) => [
        queueName,
        createQueueMock(
          queueName === 'moderation-default-0'
            ? { waiting: 2, active: 1, delayed: 0, failed: 0, completed: 0 }
            : index === 1
              ? { waiting: 1, active: 0, delayed: 0, failed: 0, completed: 0 }
              : { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        ),
      ]),
    );
    const moduleRef = {
      get: jest.fn((token: string) =>
        Object.fromEntries(
          DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName) => [getQueueToken(queueName), defaultQueues[queueName]]),
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
                queueName === 'moderation-default-0' ? 'api-moderation' : 'api-moderation-realtime-b',
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
      createQueueMock({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }) as never,
      createQueueMock({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }) as never,
      createQueueMock({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }) as never,
      createQueueMock({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }) as never,
    );

    const snapshot = await service.getSnapshot();

    expect(snapshot.webhookDynamicLeases?.mode).toBe('canary');
    expect(snapshot.webhookDefaultWorkerGroups['api-moderation-realtime-b']).toEqual({
      queues: ['moderation-default-0', 'moderation-default-1'],
      counters: {
        waiting: 3,
        active: 1,
        delayed: 0,
        failed: 0,
        completed: 0,
      },
    });
  });
});
