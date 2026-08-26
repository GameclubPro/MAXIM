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
});
