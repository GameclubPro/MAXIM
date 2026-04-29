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
        findMany: jest.fn().mockResolvedValue([
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
        ]),
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'evt-old',
            createdAt: new Date('2026-04-29T11:59:50.000Z'),
          })
          .mockResolvedValueOnce({
            processedAt: new Date('2026-04-29T11:59:59.400Z'),
          }),
      },
    };
    const service = new WebhookSloService(
      prisma as never,
      createConfig({
        SYSTEM_WEBHOOK_SLO_WINDOW_SEC: 900,
        SYSTEM_WEBHOOK_SLO_TARGET_MS: 1000,
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
    });
  });
});
