import type { Job, Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import {
  buildPublisherAutoReplyJobId,
  PublisherAutoReplyQueueService,
  type PublisherAutoReplyJob,
} from './publisher-auto-reply.queue';

function createService(queue: Queue<PublisherAutoReplyJob>, dispatchEnabled = true) {
  return new PublisherAutoReplyQueueService(
    queue,
    { get: jest.fn(() => 'publisher-bot') } as unknown as ConfigService,
    {
      read: jest.fn().mockResolvedValue({
        dispatchEnabled,
        blocker: dispatchEnabled ? null : 'runtime_disabled',
      }),
    } as never,
  );
}

describe('PublisherAutoReplyQueueService', () => {
  it('enqueues only a delivery identity with bounded retry policy', async () => {
    const queue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    } as unknown as Queue<PublisherAutoReplyJob>;
    const service = createService(queue);

    await service.ensureDeliveryJob('delivery-1');

    expect(queue.add).toHaveBeenCalledWith(
      'deliver',
      {
        version: 1,
        kind: 'deliver',
        retryPolicyName: 'publisher-auto-reply',
        deliveryId: 'delivery-1',
      },
      expect.objectContaining({
        jobId: buildPublisherAutoReplyJobId('delivery-1'),
        attempts: 7,
      }),
    );
    expect(JSON.stringify((queue.add as jest.Mock).mock.calls[0]?.[1])).not.toContain('base64');
  });

  it('keeps an existing live job for duplicate webhook delivery', async () => {
    const existing = {
      getState: jest.fn().mockResolvedValue('delayed'),
    } as unknown as Job<PublisherAutoReplyJob>;
    const queue = {
      getJob: jest.fn().mockResolvedValue(existing),
      add: jest.fn(),
    } as unknown as Queue<PublisherAutoReplyJob>;
    const service = createService(queue);

    await service.ensureDeliveryJob('delivery-1');

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('replaces a completed job when its durable delivery remains pending', async () => {
    const existing = {
      getState: jest.fn().mockResolvedValue('completed'),
      remove: jest.fn().mockResolvedValue(undefined),
    } as unknown as Job<PublisherAutoReplyJob>;
    const queue = {
      getJob: jest.fn().mockResolvedValue(existing),
      add: jest.fn().mockResolvedValue(undefined),
    } as unknown as Queue<PublisherAutoReplyJob>;
    const service = createService(queue);

    await service.ensureDeliveryJob('delivery-1');

    expect(existing.remove).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalled();
  });

  it('rejects admission while the Publisher runtime kill switch is active', async () => {
    const queue = {
      getJob: jest.fn(),
      add: jest.fn(),
    } as unknown as Queue<PublisherAutoReplyJob>;
    const service = createService(queue, false);

    await expect(service.ensureDeliveryJob('delivery-1')).rejects.toMatchObject({
      reason: 'dispatch_disabled',
    });
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
