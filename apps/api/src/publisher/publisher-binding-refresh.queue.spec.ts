import { PublisherBindingRefreshQueueService } from './publisher-binding-refresh.queue';

describe('PublisherBindingRefreshQueueService', () => {
  it('prioritizes manual rechecks and deduplicates only the short in-flight window', async () => {
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const service = new PublisherBindingRefreshQueueService(queue as never);

    await service.enqueue({
      chatId: 'chat-1',
      publisherBotId: 'publik-bot',
      reason: 'manual_recheck',
      requestedAt: new Date('2026-08-26T12:00:00.123Z'),
    });

    expect(queue.add).toHaveBeenCalledWith(
      'refresh',
      expect.objectContaining({ reason: 'manual_recheck' }),
      expect.objectContaining({
        jobId: expect.stringContaining('-manual_recheck-1787745600123'),
        priority: 1,
        deduplication: {
          id: expect.stringMatching(/^publisher-binding-refresh-manual-[a-f0-9]{24}$/u),
          ttl: 5_000,
        },
      }),
    );
  });

  it('keeps background scans bucketed and behind lifecycle refresh work', async () => {
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const service = new PublisherBindingRefreshQueueService(queue as never);

    await service.enqueue({
      chatId: 'chat-1',
      publisherBotId: 'publik-bot',
      reason: 'bootstrap',
      requestedAt: new Date('2026-08-26T12:00:30.000Z'),
    });

    expect(queue.add).toHaveBeenCalledWith(
      'refresh',
      expect.objectContaining({ reason: 'bootstrap' }),
      expect.objectContaining({ priority: 20 }),
    );
    expect(queue.add.mock.calls[0]?.[2]).not.toHaveProperty('deduplication');
  });

  it('scopes actor refresh deduplication to the normalized Publisher user', async () => {
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const service = new PublisherBindingRefreshQueueService(queue as never);

    await service.enqueue({
      chatId: 'chat-1',
      publisherBotId: 'publik-bot',
      candidateUserId: '  admin-1  ',
      reason: 'manual_recheck',
      requestedAt: new Date('2026-08-26T12:00:00.000Z'),
    });

    expect(queue.add).toHaveBeenCalledWith(
      'refresh',
      expect.objectContaining({ candidateUserId: 'admin-1' }),
      expect.objectContaining({
        deduplication: {
          id: expect.stringMatching(
            /^publisher-binding-refresh-manual-[a-f0-9]{24}-[a-f0-9]{16}$/u,
          ),
          ttl: 5_000,
        },
      }),
    );
  });

  it('preserves the durable forwarded actor fence and private reply context', async () => {
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const service = new PublisherBindingRefreshQueueService(queue as never);

    await service.enqueue({
      chatId: '-70001',
      publisherBotId: 'publik-bot',
      candidateUserId: '20002',
      candidateVersion: 'forwarded:update-1',
      replyChatId: '10001',
      requiresReadAccess: true,
      reason: 'forwarded_private',
      eventAt: new Date('2026-08-27T12:00:00.000Z'),
    });

    expect(queue.add).toHaveBeenCalledWith(
      'refresh',
      expect.objectContaining({
        chatId: '-70001',
        publisherBotId: 'publik-bot',
        candidateUserId: '20002',
        candidateVersion: 'forwarded:update-1',
        replyChatId: '10001',
        requiresReadAccess: true,
        reason: 'forwarded_private',
      }),
      expect.objectContaining({ priority: 5, attempts: 6 }),
    );
  });

  it('uses different job identities for old and new candidate versions at the same event time', async () => {
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const service = new PublisherBindingRefreshQueueService(queue as never);
    const eventAt = new Date('2026-08-27T12:00:00.000Z');

    for (const candidateVersion of ['direct:old', 'direct:new']) {
      await service.enqueue({
        chatId: '-70001',
        publisherBotId: 'publik-bot',
        candidateUserId: '20002',
        candidateVersion,
        reason: 'webhook_observed',
        eventAt,
      });
    }

    const oldJobId = queue.add.mock.calls[0]?.[2]?.jobId;
    const newJobId = queue.add.mock.calls[1]?.[2]?.jobId;
    expect(oldJobId).toEqual(expect.any(String));
    expect(newJobId).toEqual(expect.any(String));
    expect(newJobId).not.toBe(oldJobId);
  });
});
