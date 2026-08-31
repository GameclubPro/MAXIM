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

  it('deduplicates scheduled binding and actor refreshes for their full job lifecycle', async () => {
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const service = new PublisherBindingRefreshQueueService(queue as never);

    for (const [index, requestedAt] of [
      new Date('2026-08-26T12:00:00.000Z'),
      new Date('2026-08-26T12:01:00.000Z'),
    ].entries()) {
      await service.enqueue({
        chatId: 'chat-1',
        publisherBotId: 'publik-bot',
        reason: 'stale_access',
        requestedAt,
      });
      await service.enqueue({
        chatId: 'chat-1',
        publisherBotId: 'publik-bot',
        candidateUserId: 'admin-1',
        candidateVersion: `edge-v${index + 1}`,
        reason: 'stale_user_access',
        requestedAt,
      });
    }

    const bindingOptions = [queue.add.mock.calls[0]?.[2], queue.add.mock.calls[2]?.[2]];
    const actorOptions = [queue.add.mock.calls[1]?.[2], queue.add.mock.calls[3]?.[2]];
    expect(new Set(bindingOptions.map((options) => options.jobId)).size).toBe(2);
    expect(new Set(actorOptions.map((options) => options.jobId)).size).toBe(2);
    expect(new Set(bindingOptions.map((options) => options.deduplication?.id)).size).toBe(1);
    expect(new Set(actorOptions.map((options) => options.deduplication?.id)).size).toBe(1);
    expect(bindingOptions[0]?.deduplication).toEqual({
      id: expect.stringMatching(/^publisher-binding-refresh-scheduled-[a-f0-9]{40}$/u),
    });
    expect(actorOptions[0]?.deduplication).toEqual({
      id: expect.stringMatching(/^publisher-binding-refresh-scheduled-[a-f0-9]{40}$/u),
    });
    expect(actorOptions[0]?.deduplication?.id).not.toBe(bindingOptions[0]?.deduplication?.id);
  });

  it('compacts only non-active scheduled duplicates and preserves exact actor versions', async () => {
    const removableBinding = { remove: jest.fn().mockResolvedValue(undefined) };
    const removableActor = { remove: jest.fn().mockResolvedValue(undefined) };
    const keptBinding = { remove: jest.fn() };
    const keptActor = { remove: jest.fn() };
    const keptNewActorVersion = { remove: jest.fn() };
    const manual = { remove: jest.fn() };
    const jobs = [
      {
        id: 'binding-old',
        timestamp: 1,
        data: {
          version: 1,
          chatId: 'chat-1',
          publisherBotId: 'publik-bot',
          reason: 'stale_access',
          requestedAt: '2026-08-26T12:00:00.000Z',
        },
        ...keptBinding,
      },
      {
        id: 'binding-new',
        timestamp: 2,
        data: {
          version: 1,
          chatId: 'chat-1',
          publisherBotId: 'publik-bot',
          reason: 'stale_access',
          requestedAt: '2026-08-26T12:01:00.000Z',
        },
        ...removableBinding,
      },
      {
        id: 'actor-old',
        timestamp: 3,
        data: {
          version: 1,
          chatId: 'chat-1',
          publisherBotId: 'publik-bot',
          candidateUserId: 'admin-1',
          candidateVersion: 'edge-v1',
          reason: 'stale_user_access',
          requestedAt: '2026-08-26T12:00:00.000Z',
        },
        ...keptActor,
      },
      {
        id: 'actor-new',
        timestamp: 4,
        data: {
          version: 1,
          chatId: 'chat-1',
          publisherBotId: 'publik-bot',
          candidateUserId: 'admin-1',
          candidateVersion: 'edge-v1',
          reason: 'stale_user_access',
          requestedAt: '2026-08-26T12:01:00.000Z',
        },
        ...removableActor,
      },
      {
        id: 'actor-new-version',
        timestamp: 5,
        data: {
          version: 1,
          chatId: 'chat-1',
          publisherBotId: 'publik-bot',
          candidateUserId: 'admin-1',
          candidateVersion: 'edge-v2',
          reason: 'stale_user_access',
          requestedAt: '2026-08-26T12:02:00.000Z',
        },
        ...keptNewActorVersion,
      },
      {
        id: 'manual',
        timestamp: 6,
        data: {
          version: 1,
          chatId: 'chat-1',
          publisherBotId: 'publik-bot',
          candidateUserId: 'admin-1',
          reason: 'manual_recheck',
          requestedAt: '2026-08-26T12:03:00.000Z',
        },
        ...manual,
      },
    ];
    const queue = {
      getJobs: jest.fn().mockImplementation(async ([state]: string[]) =>
        state === 'prioritized' ? jobs : [],
      ),
    };
    const service = new PublisherBindingRefreshQueueService(queue as never);

    await expect(service.compactScheduledBacklog()).resolves.toEqual({
      scannedCount: 6,
      scheduledCount: 5,
      duplicateCount: 2,
      removedCount: 2,
      racedCount: 0,
      truncated: false,
    });
    expect(queue.getJobs).toHaveBeenNthCalledWith(1, ['prioritized'], 0, 249, true);
    expect(queue.getJobs).toHaveBeenNthCalledWith(2, ['waiting'], 0, 249, true);
    expect(queue.getJobs).toHaveBeenNthCalledWith(3, ['delayed'], 0, 249, true);
    expect(queue.getJobs).toHaveBeenNthCalledWith(4, ['paused'], 0, 249, true);
    expect(removableBinding.remove).toHaveBeenCalledTimes(1);
    expect(removableActor.remove).toHaveBeenCalledTimes(1);
    expect(keptBinding.remove).not.toHaveBeenCalled();
    expect(keptActor.remove).not.toHaveBeenCalled();
    expect(keptNewActorVersion.remove).not.toHaveBeenCalled();
    expect(manual.remove).not.toHaveBeenCalled();
  });

  it('bounds compaction removal concurrency and tolerates activation races', async () => {
    let activeRemovals = 0;
    let maxActiveRemovals = 0;
    const jobs = Array.from({ length: 18 }, (_, index) => ({
      id: `scheduled-${index}`,
      timestamp: index,
      data: {
        version: 1,
        chatId: 'chat-1',
        publisherBotId: 'publik-bot',
        reason: 'stale_access',
        requestedAt: new Date(1_000 + index).toISOString(),
      },
      remove: jest.fn(async () => {
        activeRemovals += 1;
        maxActiveRemovals = Math.max(maxActiveRemovals, activeRemovals);
        await Promise.resolve();
        activeRemovals -= 1;
        if (index === 9) {
          throw new Error('job became active');
        }
      }),
    }));
    const queue = {
      getJobs: jest.fn().mockImplementation(async ([state]: string[]) =>
        state === 'prioritized' ? jobs : [],
      ),
    };
    const service = new PublisherBindingRefreshQueueService(queue as never);

    await expect(service.compactScheduledBacklog()).resolves.toMatchObject({
      scannedCount: 18,
      scheduledCount: 18,
      duplicateCount: 17,
      removedCount: 16,
      racedCount: 1,
      truncated: false,
    });
    expect(maxActiveRemovals).toBe(8);
    expect(jobs[0]?.remove).not.toHaveBeenCalled();
  });

  it('applies one shared scan budget across BullMQ job states', async () => {
    let nextJob = 0;
    const queue = {
      getJobs: jest.fn().mockImplementation(async (_states: string[], start: number, end: number) =>
        Array.from({ length: end - start + 1 }, () => {
          const index = nextJob++;
          return {
            id: `manual-${index}`,
            timestamp: index,
            data: {
              version: 1,
              chatId: `chat-${index}`,
              publisherBotId: 'publik-bot',
              reason: 'manual_recheck',
              requestedAt: '2026-08-26T12:00:00.000Z',
            },
            remove: jest.fn(),
          };
        }),
      ),
    };
    const service = new PublisherBindingRefreshQueueService(queue as never);

    await expect(service.compactScheduledBacklog()).resolves.toMatchObject({
      scannedCount: 5_000,
      scheduledCount: 0,
      duplicateCount: 0,
      removedCount: 0,
      racedCount: 0,
      truncated: true,
    });
    expect(queue.getJobs).toHaveBeenCalledTimes(20);
    expect(queue.getJobs.mock.calls.every(([states]) => states.length === 1)).toBe(true);
    expect(nextJob).toBe(5_000);
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
    expect(queue.add.mock.calls[0]?.[2]).not.toHaveProperty('deduplication');
    expect(queue.add.mock.calls[1]?.[2]).not.toHaveProperty('deduplication');
  });

  it('coalesces stale ordinary webhook observations without delaying actor handshakes', async () => {
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const service = new PublisherBindingRefreshQueueService(queue as never);
    const requestedAt = new Date('2026-08-27T12:00:30.000Z');

    for (let index = 0; index < 10; index += 1) {
      await service.enqueue({
        chatId: 'chat-1',
        publisherBotId: 'publik-bot',
        reason: 'webhook_observed',
        requestedAt,
        eventAt: new Date(requestedAt.getTime() + index),
      });
    }
    await service.enqueue({
      chatId: 'chat-1',
      publisherBotId: 'publik-bot',
      candidateUserId: 'admin-1',
      candidateVersion: 'direct:start-1',
      reason: 'webhook_observed',
      requestedAt,
      eventAt: requestedAt,
    });

    const ordinaryOptions = queue.add.mock.calls.slice(0, 10).map((call) => call[2]);
    expect(new Set(ordinaryOptions.map((options) => options.jobId)).size).toBe(1);
    expect(new Set(ordinaryOptions.map((options) => options.deduplication?.id)).size).toBe(1);
    expect(ordinaryOptions[0]?.deduplication).toEqual({
      id: expect.stringMatching(/^publisher-binding-refresh-observed-[a-f0-9]{24}$/u),
      ttl: 60_000,
    });
    expect(queue.add.mock.calls[10]?.[2]).not.toHaveProperty('deduplication');
    expect(queue.add.mock.calls[10]?.[2]?.jobId).not.toBe(ordinaryOptions[0]?.jobId);
  });
});
