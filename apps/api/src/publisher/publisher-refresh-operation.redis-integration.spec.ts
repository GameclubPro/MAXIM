import { Queue, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { PublisherBindingRefreshQueueService } from './publisher-binding-refresh.queue';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const integration = redisUrl ? describe : describe.skip;

integration('Publisher refresh operation Redis status', () => {
  it('lets aged maintenance join urgent FIFO before subsequent publication requests', async () => {
    const url = new URL(redisUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Local Redis required');
    const options = {
      prefix: `test-${randomUUID()}`,
      connection: { host: url.hostname, port: Number(url.port) },
    };
    const queue = new Queue('maintenance-urgent-aging', options);
    let worker: Worker | undefined;
    try {
      await queue.pause();
      const base = {
        version: 1,
        publisherBotId: 'publisher',
        requestedAt: new Date().toISOString(),
      };
      await queue.add(
        'refresh',
        { ...base, chatId: 'maintenance', reason: 'binding_maintenance' },
        { jobId: 'maintenance', priority: 20, timestamp: Date.now() - 120_000 },
      );
      for (let i = 0; i < 10; i += 1)
        await queue.add(
          'refresh',
          { ...base, chatId: `before-${i}`, reason: 'publication_due' },
          { priority: 5 },
        );
      const service = new PublisherBindingRefreshQueueService(queue as never);
      await service.compactScheduledBacklog();
      for (let i = 0; i < 100; i += 1)
        await queue.add(
          'refresh',
          { ...base, chatId: `after-${i}`, reason: 'publication_due' },
          { priority: 5 },
        );
      const order: string[] = [];
      worker = new Worker(
        'maintenance-urgent-aging',
        async (job) => {
          order.push(job.data.chatId);
        },
        options,
      );
      const drained = new Promise<void>((resolve) => {
        worker!.on('completed', () => {
          if (order.length === 111) resolve();
        });
      });
      await queue.resume();
      await drained;
      expect(order.indexOf('maintenance')).toBe(10);
      expect(order.slice(11).every((id) => id.startsWith('after-'))).toBe(true);
    } finally {
      await worker?.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
  it('ages persisted delayed actor checks without changing their deadline or activating them', async () => {
    const url = new URL(redisUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Local Redis required');
    const queue = new Queue('refresh-delayed-aging', {
      prefix: `test-${randomUUID()}`,
      connection: { host: url.hostname, port: Number(url.port) },
    });
    try {
      const old = Date.now() - 120_000;
      const job = await queue.add(
        'refresh',
        {
          version: 1,
          chatId: 'chat',
          publisherBotId: 'publisher',
          candidateUserId: 'actor',
          reason: 'stale_user_access',
          requestedAt: new Date(old).toISOString(),
        },
        { jobId: 'actor', timestamp: old, priority: 20, delay: 600_000 },
      );
      const deadline = job.timestamp + job.delay;
      const service = new PublisherBindingRefreshQueueService(queue as never);
      await expect(service.compactScheduledBacklog()).resolves.toMatchObject({
        reprioritizedCount: 1,
      });
      const retained = (await queue.getJob('actor'))!;
      expect(retained.priority).toBe(5);
      expect(await retained.getState()).toBe('delayed');
      expect(retained.timestamp + retained.delay).toBe(deadline);
      await expect(service.compactScheduledBacklog()).resolves.toMatchObject({
        reprioritizedCount: 0,
      });
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('promotes an aged actor on rediscovery without moving it behind newer bot jobs again', async () => {
    const url = new URL(redisUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Local Redis required');
    const options = {
      prefix: `test-${randomUUID()}`,
      connection: { host: url.hostname, port: Number(url.port) },
    };
    const queue = new Queue('refresh-aging', options);
    const service = new PublisherBindingRefreshQueueService(queue as never);
    let worker: Worker | undefined;
    try {
      await queue.pause();
      const actor = {
        chatId: 'actor-chat',
        publisherBotId: 'publisher',
        candidateUserId: 'actor',
        reason: 'stale_user_access' as const,
      };
      const old = Date.now() - 120_000;
      const clock = jest.spyOn(Date, 'now').mockReturnValue(old);
      let actorId: string | null;
      try {
        actorId = await service.enqueue({ ...actor, requestedAt: new Date(old) });
      } finally {
        clock.mockRestore();
      }
      await service.enqueue({
        chatId: 'bot-before',
        publisherBotId: 'publisher',
        reason: 'stale_access',
      });
      expect(await service.enqueue(actor)).toBe(actorId!);
      expect((await queue.getJob(actorId!))?.priority).toBe(5);
      await service.enqueue({
        chatId: 'bot-after',
        publisherBotId: 'publisher',
        reason: 'stale_access',
      });
      await service.enqueue(actor);
      await service.enqueue({
        chatId: 'manual',
        publisherBotId: 'publisher',
        reason: 'manual_recheck',
      });
      const order: string[] = [];
      worker = new Worker(
        'refresh-aging',
        async (job) => {
          order.push(job.data.chatId);
        },
        options,
      );
      const drained = new Promise<void>((resolve) =>
        worker!.on('completed', () => {
          if (order.length === 4) resolve();
        }),
      );
      await queue.resume();
      await drained;
      expect(order).toEqual(['manual', 'actor-chat', 'bot-before', 'bot-after']);
    } finally {
      await worker?.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('serves bot access before scheduled actor checks in an existing paused backlog', async () => {
    const url = new URL(redisUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Local Redis required');
    const options = {
      prefix: `test-${randomUUID()}`,
      connection: { host: url.hostname, port: Number(url.port) },
    };
    const queue = new Queue('refresh-priority', options);
    const service = new PublisherBindingRefreshQueueService(queue as never);
    let worker: Worker | undefined;
    try {
      await queue.pause();
      const base = {
        version: 1,
        chatId: 'chat-1',
        publisherBotId: 'publisher',
        requestedAt: new Date().toISOString(),
      };
      for (let index = 0; index < 8; index += 1) {
        await queue.add(
          'refresh',
          {
            ...base,
            candidateUserId: `actor-${index}`,
            reason: 'stale_user_access',
          },
          { jobId: `actor-${index}`, priority: 5 },
        );
      }
      await queue.add(
        'refresh',
        { ...base, reason: 'stale_access' },
        {
          jobId: 'bot-access',
          priority: 20,
        },
      );
      const delayed = await queue.add(
        'refresh',
        {
          ...base,
          chatId: 'delayed-chat',
          candidateUserId: 'delayed-actor',
          reason: 'stale_user_access',
        },
        { jobId: 'delayed-actor', priority: 5, delay: 60_000 },
      );
      await service.enqueue({
        ...base,
        chatId: 'new-bot',
        reason: 'stale_access',
        requestedAt: new Date(),
      });
      await service.enqueue({
        ...base,
        candidateUserId: 'new-actor',
        reason: 'stale_user_access',
        requestedAt: new Date(),
      });
      await service.enqueue({ ...base, reason: 'manual_recheck', requestedAt: new Date() });
      await service.compactScheduledBacklog();
      const repairedDelayed = (await queue.getJob(delayed.id!))!;
      expect(repairedDelayed.priority).toBeGreaterThan(
        (await queue.getJob('bot-access'))!.priority,
      );
      expect(await repairedDelayed.getState()).toBe('delayed');
      expect(repairedDelayed.timestamp + repairedDelayed.delay).toBe(
        delayed.timestamp + delayed.delay,
      );
      await expect(service.compactScheduledBacklog()).resolves.toMatchObject({
        reprioritizedCount: 0,
      });

      const order: string[] = [];
      worker = new Worker(
        'refresh-priority',
        async (job) => {
          order.push(job.data.reason);
        },
        options,
      );
      const drained = new Promise<void>((resolve) =>
        worker!.on('completed', () => {
          if (order.length === 12) resolve();
        }),
      );
      await queue.resume();
      await drained;
      expect(order.slice(0, 3)).toEqual(['manual_recheck', 'stale_access', 'stale_access']);
      expect(order.slice(3)).toEqual(Array(9).fill('stale_user_access'));
    } finally {
      await worker?.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('tracks real worker completion and rejects another actor or bot', async () => {
    const url = new URL(redisUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Local Redis required');
    const options = {
      prefix: `test-${randomUUID()}`,
      connection: { host: url.hostname, port: Number(url.port) },
    };
    const queue = new Queue('refresh-operation', options);
    const service = new PublisherBindingRefreshQueueService(queue as never);
    let worker: Worker | undefined;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      const params = {
        chatId: 'chat-1',
        publisherBotId: 'publisher',
        candidateUserId: 'author',
        reason: 'manual_recheck' as const,
      };
      const originalId = await service.enqueue({ ...params, requestedAt: new Date() });
      const coalescedId = await service.enqueue({
        ...params,
        requestedAt: new Date(Date.now() + 10_000),
      });
      expect(coalescedId).toBe(originalId);
      const job = (await queue.getJob(originalId!))!;
      const id = await service.saveOperation('author', 'publisher', [job.id!]);
      expect((await service.readOperation(id, 'author', 'publisher')).state).toBe('queued');
      await expect(service.readOperation(id, 'another', 'publisher')).rejects.toMatchObject({
        status: 404,
      });
      await expect(service.readOperation(id, 'author', 'other-bot')).rejects.toMatchObject({
        status: 404,
      });
      worker = new Worker(
        'refresh-operation',
        async () => {
          entered();
          await gate;
        },
        options,
      );
      const completed = new Promise<void>((resolve) => worker!.once('completed', () => resolve()));
      await started;
      expect((await service.readOperation(id, 'author', 'publisher')).state).toBe('running');
      release();
      await completed;
      expect(await service.readOperation(id, 'author', 'publisher')).toMatchObject({
        state: 'complete',
        completed: 1,
      });
      await job.remove();
      expect((await service.readOperation(id, 'author', 'publisher')).state).toBe('unavailable');
    } finally {
      release();
      await worker?.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
