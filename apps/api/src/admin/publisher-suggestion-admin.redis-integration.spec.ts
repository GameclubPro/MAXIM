import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import {
  PUBLISHER_SUGGESTION_ADMIN_QUEUE,
  type PublisherSuggestionAdminJob,
} from '../publisher/publisher-suggestion-admin.queue';
import { PublisherSuggestionAdminProcessor } from './publisher-suggestion-admin.processor';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const integration = redisUrl ? describe : describe.skip;
jest.setTimeout(30_000);

integration('Publisher suggestion retries retain bounded diagnostics on real BullMQ', () => {
  let queue: Queue<PublisherSuggestionAdminJob>;
  let worker: Worker<PublisherSuggestionAdminJob>;
  const oldRole = process.env.APP_ROLE;
  const oldService = process.env.APP_SERVICE_NAME;

  beforeEach(() => {
    const url = new URL(redisUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname))
      throw new Error('Disposable local Redis required');
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const options = {
      prefix: `suggestion-diagnostics-test-${randomUUID()}`,
      connection: { host: url.hostname, port: Number(url.port) },
    };
    queue = new Queue(PUBLISHER_SUGGESTION_ADMIN_QUEUE, options);
    worker = new Worker(PUBLISHER_SUGGESTION_ADMIN_QUEUE, async () => undefined, {
      ...options,
      autorun: false,
    });
  });

  afterEach(async () => {
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
    if (oldRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = oldRole;
    if (oldService === undefined) delete process.env.APP_SERVICE_NAME;
    else process.env.APP_SERVICE_NAME = oldService;
  });

  it.each(['guard', 'delivery'] as const)(
    'a retained job failing at %s sheds oversized stack diagnostics without changing its work or attempts',
    async (stage) => {
      const failure = new Error('Synthetic unavailable dependency');
      const boundary = { assertDispatchEnabled: jest.fn() };
      const dialogs = { processPublisherSuggestionAdminDeliveryJob: jest.fn() };
      if (stage === 'guard')
        boundary.assertDispatchEnabled.mockImplementation(() => {
          throw failure;
        });
      else dialogs.processPublisherSuggestionAdminDeliveryJob.mockRejectedValue(failure);
      const processor = new PublisherSuggestionAdminProcessor(
        {} as never,
        {} as never,
        dialogs as never,
        {} as never,
        {} as never,
        { assertAttested: jest.fn() } as never,
        { assertDispatchAllowed: jest.fn() } as never,
        boundary as never,
        { getBotId: () => 'publisher-test' } as never,
      );
      const data: PublisherSuggestionAdminJob = {
        version: 1,
        kind: 'deliver',
        suggestionId: 'synthetic-suggestion',
        requiredBotId: 'publisher-test',
        requestedAt: '2026-10-15T21:00:00.000Z',
      };
      const stored = await queue.add('deliver', data, {
        attempts: 8,
        removeOnComplete: false,
        removeOnFail: false,
      });
      const redis = await queue.client;
      const historical = Array.from(
        { length: 2700 },
        (_, index) => `Synthetic historical failure ${index}: ${'x'.repeat(780)}`,
      );
      await redis.hset(queue.toKey(stored.id!), { stacktrace: JSON.stringify(historical) });
      expect(
        Buffer.byteLength((await redis.hget(queue.toKey(stored.id!), 'stacktrace'))!),
      ).toBeGreaterThan(2_000_000);

      const first = (await worker.getNextJob('first-attempt'))!;
      expect(first.opts.stackTraceLimit).toBeUndefined();
      await expect(processor.process(first, 'first-attempt')).rejects.toBe(failure);
      await first.moveToFailed(failure, 'first-attempt', false);

      const retried = (await queue.getJob(stored.id!))!;
      expect(retried.data).toEqual(data);
      expect(retried.attemptsMade).toBe(1);
      expect(retried.opts.attempts).toBe(8);
      expect(await retried.getState()).toBe('waiting');
      expect(retried.failedReason).toBe(failure.message);
      expect(retried.stacktrace?.at(-1)).toBe(failure.stack);
      expect(retried.stacktrace).toContain(historical.at(-1));
      expect(
        Buffer.byteLength((await redis.hget(queue.toKey(stored.id!), 'stacktrace'))!),
      ).toBeLessThan(16_384);
      expect(dialogs.processPublisherSuggestionAdminDeliveryJob).toHaveBeenCalledTimes(
        stage === 'guard' ? 0 : 1,
      );

      boundary.assertDispatchEnabled.mockReset();
      dialogs.processPublisherSuggestionAdminDeliveryJob.mockReset();
      const next = (await worker.getNextJob('next-attempt'))!;
      expect(next.id).toBe(first.id);
      expect(next.attemptsMade).toBe(1);
      await processor.process(next, 'next-attempt');
      await next.moveToCompleted(undefined, 'next-attempt', false);
      expect(await next.getState()).toBe('completed');
      expect(dialogs.processPublisherSuggestionAdminDeliveryJob).toHaveBeenCalledTimes(1);
      expect(dialogs.processPublisherSuggestionAdminDeliveryJob).toHaveBeenCalledWith(
        data.suggestionId,
        data.requiredBotId,
      );
    },
  );
});
