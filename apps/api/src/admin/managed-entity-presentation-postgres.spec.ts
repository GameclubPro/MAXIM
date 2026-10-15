import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { createPrismaAdapter, PrismaClient } from '../prisma/prisma-client';
import { ManagedEntityPresentationService } from './managed-entity-presentation.service';
import {
  ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE,
  type AdminManagedEntitiesRefreshJob,
} from './admin-managed-entities-refresh.queue';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const integration = databaseUrl && redisUrl ? describe : describe.skip;

integration('home presentation with PostgreSQL and a durable Redis queue', () => {
  let db: PrismaClient;
  let queue: Queue<AdminManagedEntitiesRefreshJob>;
  let events: QueueEvents;
  let worker: Worker | undefined;
  let service: ManagedEntityPresentationService;
  const id = `presentation-${randomUUID()}`;
  const actor = `actor-${randomUUID()}`;
  const bot = `bot-${randomUUID()}`;
  const max = { getChatSnapshot: jest.fn() };
  const cache = { setManagedEntityHeader: jest.fn() };
  const request = { entityType: 'chat' as const, entityIds: [id] };
  const user = { userId: actor, username: null, displayName: null };

  beforeAll(async () => {
    if (
      !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname) ||
      !new URL(databaseUrl).pathname.includes('race_test') ||
      !['localhost', '127.0.0.1'].includes(new URL(redisUrl).hostname)
    )
      throw new Error('Disposable stores required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 3, statement_timeout: 10000 }),
    });
    const connection = {
      host: new URL(redisUrl).hostname,
      port: Number(new URL(redisUrl).port || 6379),
    };
    const prefix = `presentation-test-${randomUUID()}`;
    queue = new Queue(ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE, { connection, prefix });
    events = new QueueEvents(ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE, { connection, prefix });
    await events.waitUntilReady();
    const registry = {
      getAllBots: () => [{ id: bot, state: 'active' }],
      getBotById: () => ({ state: 'active' }),
    };
    service = new ManagedEntityPresentationService(
      db as never,
      registry as never,
      max as never,
      cache as never,
      queue,
    );
    await db.chat.create({ data: { id, title: `Chat ${id}`, primaryBotId: bot } });
    await db.chatBotMembership.create({
      data: {
        chatId: id,
        botId: bot,
        botAccessState: 'CONFIRMED_ADMIN',
        botAccessSource: 'explicit_activation',
      },
    });
    await db.managedEntityAccessEdge.create({
      data: {
        chatId: id,
        userId: actor,
        botId: bot,
        state: 'GRANTED',
        userRole: 'ADMIN',
        expiresAt: new Date(0),
      },
    });
    await db.managedBotChatCatalog.create({
      data: { chatId: id, botId: bot, title: `Chat ${id}` },
    });
    max.getChatSnapshot.mockResolvedValue({
      chatId: id,
      entityType: 'chat',
      title: 'Живое имя',
      avatarUrl: 'https://i.oneme.ru/known.webp',
      avatarState: 'present',
    });
    worker = new Worker(ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE, (job) => service.process(job.data), {
      connection,
      prefix,
      autorun: false,
    });
  });

  afterAll(async () => {
    await worker?.close();
    await events?.close();
    if (queue) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
    await db?.managedBotChatCatalog.deleteMany({ where: { botId: bot } });
    await db?.chat.deleteMany({ where: { id } });
    await db?.$disconnect();
  });

  it('survives producer return, deduplicates concurrent viewers and returns the photo on a later local read', async () => {
    const [first, second] = await Promise.all([
      service.read(user, request),
      service.read(user, request),
    ]);
    expect(first.items[0].pending).toBe(true);
    expect(second.items[0].pending).toBe(true);
    expect(max.getChatSnapshot).not.toHaveBeenCalled();
    const jobs = await queue.getJobs(['prioritized', 'waiting']);
    expect(jobs).toHaveLength(1);
    void worker!.run();
    await jobs[0].waitUntilFinished(events, 15000);
    const after = await service.read(user, request);
    expect(after.items[0]).toMatchObject({
      title: 'Живое имя',
      avatarUrl: 'https://i.oneme.ru/known.webp',
      pending: false,
    });
    expect(max.getChatSnapshot).toHaveBeenCalledTimes(1);
    expect(
      (await db.managedEntityAccessEdge.findFirst({ where: { chatId: id } }))?.expiresAt,
    ).toEqual(new Date(0));
  });

  it('preserves explicit revocation and refuses old queued requests after access loss', async () => {
    await db.managedEntityAccessEdge.updateMany({
      where: { chatId: id },
      data: { state: 'USER_DENIED' },
    });
    max.getChatSnapshot.mockClear();
    await service.process({
      userId: actor,
      entityType: 'chat',
      presentationEntityId: id,
      bypassRemoteCache: false,
      resetRefreshCursor: false,
    });
    expect((await service.read(user, request)).items).toEqual([]);
    expect(max.getChatSnapshot).not.toHaveBeenCalled();
    await db.managedEntityAccessEdge.updateMany({
      where: { chatId: id },
      data: { state: 'GRANTED' },
    });
  });

  it('does not let a delayed MAX response overwrite a newer catalog observation', async () => {
    max.getChatSnapshot.mockImplementationOnce(async () => {
      await db.managedBotChatCatalog.update({
        where: { botId_chatId: { botId: bot, chatId: id } },
        data: {
          title: 'Более новое имя',
          avatarState: 'absent',
          avatarUrl: null,
          metadataObservedAt: new Date(Date.now() + 1000),
        },
      });
      return {
        chatId: id,
        entityType: 'chat',
        title: 'Старый ответ',
        avatarState: 'present',
        avatarUrl: 'https://i.oneme.ru/old.webp',
      };
    });
    cache.setManagedEntityHeader.mockClear();
    await service.process({
      userId: actor,
      entityType: 'chat',
      presentationEntityId: id,
      bypassRemoteCache: false,
      resetRefreshCursor: false,
    });
    const after = await service.read(user, request);
    expect(after.items[0]).toMatchObject({
      title: 'Более новое имя',
      avatarState: 'absent',
      avatarUrl: null,
    });
    expect(cache.setManagedEntityHeader).not.toHaveBeenCalled();
  });
});
