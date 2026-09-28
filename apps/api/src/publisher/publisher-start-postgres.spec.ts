import { Queue, Worker, UnrecoverableError } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { PrismaClient, createPrismaAdapter } from '../prisma/prisma-client';
import { WebhookParser } from '../webhook/webhook.parser';
import { PublisherStartQueueService, type PublisherStartJob } from './publisher-start.queue';
import { PublisherStartRecoveryService } from './publisher-start-recovery.service';
import { PublisherBackgroundWorkCoordinatorService } from './publisher-background-work-coordinator.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const integration = databaseUrl && redisUrl ? describe : describe.skip;

integration('Publisher greeting outbox PostgreSQL/Redis recovery', () => {
  let db: PrismaClient;
  let queue: Queue<PublisherStartJob>;
  let producer: PublisherStartQueueService;
  let recovery: PublisherStartRecoveryService;
  const botId = `greeting-${randomUUID()}`;
  const registry = { getPublisherBotDescriptor: () => ({ id: botId }) };
  const runtime = { dispatchEnabled: true };
  const parser = new WebhookParser();
  const update = () =>
    parser.parse(
      { update_type: 'bot_started', timestamp: Date.now(), chat_id: 123, user: { user_id: 42 } },
      { botId },
    );

  beforeAll(async () => {
    const pg = new URL(databaseUrl);
    const redis = new URL(redisUrl);
    if (
      !['localhost', '127.0.0.1'].includes(pg.hostname) ||
      !pg.pathname.includes('race_test') ||
      !['localhost', '127.0.0.1'].includes(redis.hostname)
    )
      throw new Error('Local disposable services required');
    db = new PrismaClient({ adapter: createPrismaAdapter(databaseUrl, { max: 3 }) });
    queue = new Queue('publisher-start-test', {
      prefix: `test-${randomUUID()}`,
      connection: { host: redis.hostname, port: Number(redis.port) },
    });
    producer = new PublisherStartQueueService(queue as never, registry as never, db as never);
    recovery = new PublisherStartRecoveryService(
      db as never,
      producer,
      registry as never,
      runtime as never,
      new PublisherBackgroundWorkCoordinatorService(),
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    runtime.dispatchEnabled = true;
    await queue.obliterate({ force: true });
    await db.publisherStartIntent.deleteMany({ where: { publisherBotId: botId } });
  });
  afterAll(async () => {
    await queue?.close();
    await db?.$disconnect();
  });

  it('recovers the same intent after Redis loses an acknowledged job, and never after attempt', async () => {
    await producer.observeWebhook(update());
    const intent = await db.publisherStartIntent.findFirstOrThrow({
      where: { publisherBotId: botId },
    });
    const original = (await queue.getJob(intent.id))!;
    const data = original.data;
    await original.remove();
    await recovery.recoverOnce(new Date(Date.now() + 61_000));
    expect((await queue.getJob(intent.id))?.data).toEqual(data);
    const claims = await Promise.all([
      producer.claimDurableDispatch(intent.id, data),
      producer.claimDurableDispatch(intent.id, data),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await (await queue.getJob(intent.id))!.remove();
    await recovery.recoverOnce(new Date(Date.now() + 121_000));
    expect(await queue.getJob(intent.id)).toBeUndefined();
    expect(
      (await db.publisherStartIntent.findUniqueOrThrow({ where: { id: intent.id } })).status,
    ).toBe('ATTEMPTED');
  });

  it('recovers a committed intent after enqueue fails and expires it without extending freshness', async () => {
    const add = jest.spyOn(queue, 'add').mockRejectedValueOnce(new Error('Redis unavailable'));
    await expect(producer.observeWebhook(update())).rejects.toThrow('Redis unavailable');
    add.mockRestore();
    const intent = await db.publisherStartIntent.findFirstOrThrow({
      where: { publisherBotId: botId },
    });
    runtime.dispatchEnabled = false;
    await recovery.recoverOnce();
    expect(await queue.getJob(intent.id)).toBeUndefined();
    runtime.dispatchEnabled = true;
    await recovery.recoverOnce(new Date(intent.expiresAt.getTime() + 1));
    expect(
      (await db.publisherStartIntent.findUniqueOrThrow({ where: { id: intent.id } })).status,
    ).toBe('EXPIRED');
    expect(await queue.getJob(intent.id)).toBeUndefined();
  });

  it('revives a failed pre-attempt Redis job without changing its identity', async () => {
    await producer.observeWebhook(update());
    const intent = await db.publisherStartIntent.findFirstOrThrow({
      where: { publisherBotId: botId },
    });
    const worker = new Worker(
      queue.name,
      async () => {
        throw new UnrecoverableError('pre-dispatch fixture');
      },
      { connection: queue.opts.connection, prefix: queue.opts.prefix },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Worker did not fail the fixture')), 5000);
        worker.once('failed', () => {
          clearTimeout(timer);
          resolve();
        });
        worker.once('error', reject);
      });
    } finally {
      await worker.close();
    }
    expect(await (await queue.getJob(intent.id))!.getState()).toBe('failed');
    await recovery.recoverOnce(new Date(Date.now() + 61_000));
    expect(await (await queue.getJob(intent.id))!.getState()).toBe('waiting');
    expect(
      (await db.publisherStartIntent.findUniqueOrThrow({ where: { id: intent.id } })).status,
    ).toBe('PENDING');
  });
});
