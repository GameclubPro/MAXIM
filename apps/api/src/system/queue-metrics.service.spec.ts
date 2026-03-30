import { WebhookStatus } from '@prisma/client';
import { QueueMetricsService } from './queue-metrics.service';

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
      },
    };
    const actionHealthService = {
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

    const service = new QueueMetricsService(
      prisma as never,
      actionHealthService as never,
      createQueueMock({ waiting: 1, active: 0, delayed: 0, failed: 0, completed: 10 }) as never,
      createQueueMock({ waiting: 1, active: 1, delayed: 0, failed: 0, completed: 4 }) as never,
      createQueueMock({ waiting: 1, active: 0, delayed: 0, failed: 0, completed: 5 }) as never,
      createQueueMock({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }) as never,
      createQueueMock({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }) as never,
      createQueueMock({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }) as never,
      createQueueMock({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }) as never,
      createQueueMock({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }) as never,
      createQueueMock({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }) as never,
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
    expect(snapshot.oldestQueuedEventId).toBe('queued-1');
    expect(snapshot.oldestReceivedEventId).toBe('received-1');
    expect(snapshot.effectiveLagSec).toBeGreaterThanOrEqual(snapshot.oldestQueuedLagSec);
  });
});
