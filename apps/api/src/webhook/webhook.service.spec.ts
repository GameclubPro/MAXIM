import { WebhookStatus } from '@prisma/client';
import { WebhookService } from './webhook.service';

describe('WebhookService', () => {
  it('enqueues new webhook event', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-1' }),
        updateMany: jest.fn(),
      },
    };

    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const service = new WebhookService(prisma as never, queue as never);
    const result = await service.ingest(
      {
        updateId: 'u-1',
        type: 'message',
      },
      '127.0.0.1',
    );

    expect(result).toEqual({ accepted: true, duplicate: false });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('marks duplicate events', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockRejectedValue({ code: 'P2002' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const queue = {
      add: jest.fn(),
    };

    const service = new WebhookService(prisma as never, queue as never);
    const result = await service.ingest(
      {
        updateId: 'u-1',
        type: 'message',
      },
      '127.0.0.1',
    );

    expect(result).toEqual({ accepted: true, duplicate: true });
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith({
      where: { dedupKey: 'u-1' },
      data: { status: WebhookStatus.DUPLICATE },
    });
  });
});
