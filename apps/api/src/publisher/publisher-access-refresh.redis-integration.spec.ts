import { Queue, Worker } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PublisherAccessRefreshPolicy } from './publisher-access-refresh-policy';
import { PublisherBindingRefreshQueueService } from './publisher-binding-refresh.queue';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const integration = redisUrl ? describe : describe.skip;

integration('Publisher deadline queue on Redis', () => {
  const policy = new PublisherAccessRefreshPolicy(
    new ConfigService({ MAX_PUBLISHER_ACCESS_REFRESH_MODE: 'on' }),
  );
  function setup() {
    const url = new URL(redisUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Local Redis required');
    const options = {
      prefix: `test-${randomUUID()}`,
      connection: { host: url.hostname, port: Number(url.port) },
    };
    const queue = new Queue('access-refresh', options);
    return {
      options,
      queue,
      service: new PublisherBindingRefreshQueueService(queue as never, policy),
    };
  }
  it.each([1000, 2000])(
    'runs urgent work before %i aged maintenance jobs at concurrency two',
    async (size) => {
      const { options, queue, service } = setup();
      let worker: Worker | undefined;
      try {
        await queue.pause();
        await queue.addBulk(
          Array.from({ length: size }, (_, i) => ({
            name: 'refresh',
            data: {
              version: 1,
              chatId: `chat-${i}`,
              publisherBotId: 'publisher',
              reason: 'binding_maintenance',
              requestedAt: new Date(Date.now() - 3600000).toISOString(),
            },
            opts: { jobId: `maintenance-${i}`, priority: 5, timestamp: Date.now() - 3600000 },
          })),
        );
        await service.compactScheduledBacklog();
        await service.enqueue({
          chatId: 'urgent',
          publisherBotId: 'publisher',
          reason: 'publication_due',
        });
        await service.enqueue({
          chatId: 'interactive',
          publisherBotId: 'publisher',
          reason: 'manual_recheck',
        });
        const order: string[] = [];
        let finished!: () => void;
        const done = new Promise<void>((resolve) => {
          finished = resolve;
        });
        worker = new Worker(
          'access-refresh',
          async (job) => {
            order.push(job.data.chatId);
          },
          { ...options, concurrency: 2 },
        );
        worker.on('completed', () => {
          if (order.length >= size + 2) finished();
        });
        await queue.resume();
        await done;
        expect(order.slice(0, 2)).toEqual(['interactive', 'urgent']);
        expect(await queue.getJob('maintenance-0')).toMatchObject({ priority: 10 });
      } finally {
        await worker?.close();
        await queue.obliterate({ force: true });
        await queue.close();
      }
    },
    30000,
  );

  it('promotes the same delayed bot job across restart without resetting its retry or deadline', async () => {
    const { options, queue, service } = setup();
    let worker: Worker | undefined;
    try {
      await queue.pause();
      const id = await service.enqueue({
        chatId: 'chat',
        publisherBotId: 'publisher',
        reason: 'scheduled_bot_access',
        requiredBefore: new Date(Date.now() + 240000),
      });
      worker = new Worker('access-refresh', async () => undefined, { ...options, autorun: false });
      await queue.resume();
      const first = (await worker.getNextJob('test-lock'))!;
      await first.moveToDelayed(Date.now() + 300000, 'test-lock');
      const before = (await queue.getJob(id!))!;
      const restarted = new PublisherBindingRefreshQueueService(queue as never, policy);
      expect(
        await restarted.enqueue({
          chatId: 'chat',
          publisherBotId: 'publisher',
          reason: 'publication_due',
          requiredBefore: new Date(Date.now() + 240000),
        }),
      ).toBe(id);
      await restarted.compactScheduledBacklog();
      const after = (await queue.getJob(id!))!;
      expect(after.priority).toBe(5);
      expect(await after.getState()).toBe('delayed');
      expect(after.timestamp + after.delay).toBe(before.timestamp + before.delay);
      expect(after.attemptsMade).toBe(before.attemptsMade);
      expect(after.data.reason).toBe('scheduled_bot_access');
      expect(await queue.getJobCounts('delayed')).toMatchObject({ delayed: 1 });
    } finally {
      await worker?.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('promotes the exact actor version without creating a second pending proof', async () => {
    const { queue, service } = setup();
    try {
      const base = {
        chatId: 'chat',
        publisherBotId: 'publisher',
        candidateUserId: 'actor',
        candidateVersion: 'v1',
      };
      const id = await service.enqueue({ ...base, reason: 'stale_user_access' });
      expect(await service.enqueue({ ...base, reason: 'publication_actor_due' })).toBe(id);
      await service.compactScheduledBacklog();
      expect((await queue.getJob(id!))!.priority).toBe(5);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('keeps actor candidate versions independent and accepts old envelopes without deadlines', async () => {
    const { queue, service } = setup();
    try {
      const base = {
        chatId: 'chat',
        publisherBotId: 'publisher',
        candidateUserId: 'actor',
        reason: 'publication_actor_due' as const,
      };
      const a = await service.enqueue({ ...base, candidateVersion: 'v1' });
      const b = await service.enqueue({ ...base, candidateVersion: 'v2' });
      expect(a).not.toBe(b);
      const old = await queue.add(
        'refresh',
        {
          version: 1,
          chatId: 'old',
          publisherBotId: 'publisher',
          reason: 'scheduled_bot_access',
          requestedAt: new Date(0).toISOString(),
        },
        { priority: 5, timestamp: 1 },
      );
      await service.compactScheduledBacklog();
      expect((await queue.getJob(old.id!))!.priority).toBe(10);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
