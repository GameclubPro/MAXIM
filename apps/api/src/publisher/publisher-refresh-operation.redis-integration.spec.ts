import { Queue, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { PublisherBindingRefreshQueueService } from './publisher-binding-refresh.queue';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const integration = redisUrl ? describe : describe.skip;

integration('Publisher refresh operation Redis status', () => {
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
