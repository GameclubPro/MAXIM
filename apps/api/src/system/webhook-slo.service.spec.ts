import { WebhookSloService } from './webhook-slo.service';

function createConfig(overrides: Record<string, unknown> = {}) {
  return {
    get: jest.fn((key: string) => overrides[key]),
  };
}

describe('WebhookSloService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('computes webhook processing SLO from recent events', async () => {
    const now = new Date('2026-04-29T12:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());
    const prisma = {
      webhookEvent: {
        count: jest
          .fn()
          .mockResolvedValueOnce(10)
          .mockResolvedValueOnce(8)
          .mockResolvedValueOnce(1),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              createdAt: new Date('2026-04-29T11:59:58.000Z'),
              processedAt: new Date('2026-04-29T11:59:58.300Z'),
            },
            {
              createdAt: new Date('2026-04-29T11:59:57.000Z'),
              processedAt: new Date('2026-04-29T11:59:59.400Z'),
            },
            {
              createdAt: new Date('2026-04-29T11:59:56.000Z'),
              processedAt: new Date('2026-04-29T11:59:56.800Z'),
            },
          ])
          .mockResolvedValueOnce([
            {
              createdAt: new Date('2026-04-29T11:59:58.000Z'),
              queuedAt: new Date('2026-04-29T11:59:58.120Z'),
            },
            {
              createdAt: new Date('2026-04-29T11:59:57.000Z'),
              queuedAt: new Date('2026-04-29T11:59:58.600Z'),
            },
            {
              createdAt: new Date('2026-04-29T11:59:56.000Z'),
              queuedAt: new Date('2026-04-29T11:59:55.900Z'),
            },
          ]),
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'evt-old',
            createdAt: new Date('2026-04-29T11:59:50.000Z'),
          })
          .mockResolvedValueOnce({
            id: 'evt-pending-enqueue',
            createdAt: new Date('2026-04-29T11:59:52.000Z'),
          })
          .mockResolvedValueOnce({
            processedAt: new Date('2026-04-29T11:59:59.400Z'),
          })
          .mockResolvedValueOnce({
            queuedAt: new Date('2026-04-29T11:59:58.600Z'),
          }),
      },
    };
    const service = new WebhookSloService(
      prisma as never,
      createConfig({
        SYSTEM_WEBHOOK_SLO_WINDOW_SEC: 900,
        SYSTEM_WEBHOOK_SLO_TARGET_MS: 1000,
        SYSTEM_WEBHOOK_ENQUEUE_SLO_TARGET_MS: 500,
      }) as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      status: 'critical',
      totalEvents: 10,
      processedEvents: 8,
      failedEvents: 1,
      sampledProcessedEvents: 3,
      p95ProcessingMs: 2400,
      underTargetRatio: 0.667,
      oldestUnprocessedLagSec: 10,
      oldestUnprocessedEventId: 'evt-old',
      lastProcessedAt: '2026-04-29T11:59:59.400Z',
      enqueue: {
        targetMs: 500,
        sampledEvents: 3,
        p95LatencyMs: 1600,
        p99LatencyMs: 1600,
        underTargetRatio: 0.667,
        oldestPendingLagSec: 8,
        oldestPendingEventId: 'evt-pending-enqueue',
        lastQueuedAt: '2026-04-29T11:59:58.600Z',
      },
    });
  });

  it('returns empty enqueue SLO fields when no recent event has been queued', async () => {
    const now = new Date('2026-04-29T12:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());
    const prisma = {
      webhookEvent: {
        count: jest
          .fn()
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(0),
        findMany: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null),
      },
    };
    const service = new WebhookSloService(
      prisma as never,
      createConfig({
        SYSTEM_WEBHOOK_SLO_WINDOW_SEC: 900,
      }) as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      status: 'healthy',
      sampledProcessedEvents: 0,
      p95ProcessingMs: null,
      underTargetRatio: null,
      enqueue: {
        sampledEvents: 0,
        p95LatencyMs: null,
        p99LatencyMs: null,
        underTargetRatio: null,
        oldestPendingLagSec: 0,
        oldestPendingEventId: null,
        lastQueuedAt: null,
      },
    });
  });
});
