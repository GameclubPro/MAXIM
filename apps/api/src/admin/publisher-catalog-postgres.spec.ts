import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, createPrismaAdapter } from '../prisma/prisma-client';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { PublisherCatalogQueryService } from './publisher-catalog-query.service';
import { publisherEntitiesCursorQuerySchema } from '@maxim/contracts/publisher';
import { PublisherReadinessService } from '../publisher/publisher-readiness.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const integration = databaseUrl && redisUrl ? describe : describe.skip;

integration('Publisher catalog SQL pages and shared cursors', () => {
  let db: PrismaClient;
  let cache: ChatContextCacheService;
  let first: PublisherCatalogQueryService;
  let replica: PublisherCatalogQueryService;
  const actor = `catalog-${randomUUID()}`;
  const bot = `bot-${randomUUID()}`;
  const prefix = `catalog-${randomUUID()}-`;

  beforeAll(async () => {
    if (
      !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname) ||
      !new URL(databaseUrl).pathname.includes('race_test') ||
      !['localhost', '127.0.0.1'].includes(new URL(redisUrl).hostname)
    )
      throw new Error('Local disposable services required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 3, statement_timeout: 10_000 }),
    });
    cache = new ChatContextCacheService(
      {} as never,
      { getOrThrow: () => redisUrl } as never,
      {} as never,
    );
    first = new PublisherCatalogQueryService(db as never, cache);
    replica = new PublisherCatalogQueryService(db as never, cache);
    for (let offset = 0; offset < 10_000; offset += 500) {
      const ids = Array.from(
        { length: 500 },
        (_, i) => `${prefix}${String(offset + i).padStart(5, '0')}`,
      );
      await db.chat.createMany({ data: ids.map((id) => ({ id, title: 'Catalog' })) });
      await db.managedBotChatCatalog.createMany({
        data: ids.map((id) => ({ botId: bot, chatId: id, title: 'Одинаковое имя' })),
      });
      await db.publisherEntityBinding.createMany({
        data: ids.map((id) => ({
          chatId: id,
          publisherBotId: bot,
          botAccessState: 'CONFIRMED_OWNER',
          botAccessCheckedAt: new Date(),
          botAccessExpiresAt: new Date(Date.now() + 3600_000),
        })),
      });
      await db.managedEntityAccessEdge.createMany({
        data: ids.map((id) => ({
          chatId: id,
          userId: actor,
          botId: bot,
          state: 'GRANTED',
          userRole: 'ADMIN',
          expiresAt: new Date(Date.now() + 3600_000),
        })),
      });
    }
    await db.$executeRawUnsafe(
      'ANALYZE managed_entity_access_edges, managed_bot_chat_catalog, publisher_entity_bindings, managed_entity_publication_policies',
    );
  }, 60_000);

  afterAll(async () => {
    await db?.managedBotChatCatalog.deleteMany({ where: { botId: bot } });
    await db?.chat.deleteMany({ where: { id: { startsWith: prefix } } });
    await db?.$disconnect();
    await cache?.onModuleDestroy();
  });

  it.each([100, 1000, 10_000])('returns at most one page for a %i entity query', async (size) => {
    const query = publisherEntitiesCursorQuerySchema.parse({
      pagination: 'cursor',
      limit: 30,
      query: size === 100 ? `${prefix}000` : size === 1000 ? `${prefix}00` : prefix,
    });
    const page = await first.page(actor, bot, query, true);
    expect(page.ids).toHaveLength(30);
    expect(page.filteredTotal).toBe(size);
    expect(page.summary.total).toBe(10_000);
    expect(page.summary.ready).toBe(10_000);
  });

  it('survives replica change, rechecks revocation and rejects foreign or changed cursor scope', async () => {
    const query = publisherEntitiesCursorQuerySchema.parse({
      pagination: 'cursor',
      limit: 30,
      readiness: 'ready',
    });
    const page = await first.page(actor, bot, query, true);
    const revoked = `${prefix}00030`;
    await db.managedEntityAccessEdge.update({
      where: { chatId_userId_botId: { chatId: revoked, userId: actor, botId: bot } },
      data: { state: 'USER_DENIED' },
    });
    const next = { ...query, cursor: page.nextCursor! };
    const continued = await replica.page(actor, bot, next, true);
    expect(continued.ids).toHaveLength(30);
    expect(continued.ids).not.toContain(revoked);
    expect(continued.ids.some((id) => page.ids.includes(id))).toBe(false);
    await expect(replica.page('another-actor', bot, next, true)).rejects.toMatchObject({
      status: 400,
    });
    await expect(replica.page(actor, 'another-bot', next, true)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      replica.page(actor, bot, { ...next, query: 'changed' }, true),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('keeps disabled policies visible but excludes them from ready pages', async () => {
    const id = `${prefix}09999`;
    await db.managedEntityPublicationPolicy.create({ data: { chatId: id, publikEnabled: false } });
    const query = publisherEntitiesCursorQuerySchema.parse({ pagination: 'cursor', query: id });
    expect((await replica.page(actor, bot, { ...query, readiness: 'ready' }, true)).ids).toEqual(
      [],
    );
    expect(
      (await replica.page(actor, bot, { ...query, readiness: 'attention' }, true)).ids,
    ).toEqual([id]);
  });

  it('expires shared cursors and preserves forward order across deletion and insertion', async () => {
    const query = publisherEntitiesCursorQuerySchema.parse({ pagination: 'cursor', limit: 30 });
    const page = await first.page(actor, bot, query, true);
    const deleted = `${prefix}00031`;
    await db.managedEntityAccessEdge.deleteMany({
      where: { userId: actor, botId: bot, chatId: deleted },
    });
    const inserted = `${prefix}00030-new`;
    await db.chat.create({ data: { id: inserted, title: 'Inserted' } });
    await db.managedBotChatCatalog.create({
      data: { chatId: inserted, botId: bot, title: 'Inserted' },
    });
    await db.publisherEntityBinding.create({
      data: {
        chatId: inserted,
        publisherBotId: bot,
        botAccessState: 'CONFIRMED_OWNER',
        botAccessCheckedAt: new Date(),
        botAccessExpiresAt: new Date(Date.now() + 3600_000),
      },
    });
    await db.managedEntityAccessEdge.create({
      data: {
        chatId: inserted,
        botId: bot,
        userId: actor,
        userRole: 'ADMIN',
        state: 'GRANTED',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const next = await replica.page(actor, bot, { ...query, cursor: page.nextCursor! }, true);
    expect(next.ids).toContain(inserted);
    expect(next.ids).not.toContain(deleted);
    expect(next.ids.every((id) => id > page.ids.at(-1)!)).toBe(true);
    const read = jest.spyOn(cache, 'readPublisherCatalogState').mockResolvedValueOnce(null);
    try {
      await expect(
        replica.page(actor, bot, { ...query, cursor: page.nextCursor! }, true),
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      read.mockRestore();
    }
  });

  it('executes a bounded indexed page on the 10000-entity fixture', async () => {
    const source = (
      first as unknown as {
        source: (user: string, bot: string, now: Date, available: boolean) => Prisma.Sql;
      }
    ).source(actor, bot, new Date(), true);
    const plan = await db.$queryRaw<
      Array<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown>; 'Execution Time': number }> }>
    >(Prisma.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) WITH scoped AS (${source})
      SELECT chat_id FROM scoped WHERE chat_id > ${`${prefix}05000`} ORDER BY chat_id ASC LIMIT 31
    `);
    const root = plan[0]!['QUERY PLAN'][0]!;
    expect(root.Plan['Node Type']).toBe('Limit');
    expect(root.Plan['Actual Rows']).toBe(31);
    expect(root['Execution Time']).toBeLessThan(1000);
    expect(JSON.stringify(root.Plan)).toMatch(/Index (Only )?Scan/);
  });

  it.each([
    { permissionsKnown: true, permissions: [' \tCaN\tWrItE\n '] },
    { permissionsKnown: true, permissions: ['Post-Edit-Delete-Messages'] },
    { permissionsKnown: true, permissions: [null, {}, 1, 'read'] },
    { permissionsKnown: 'true', permissions: ['write'] },
    { permissionsKnown: true, permissions: 'write' },
    [],
  ])('matches readiness permission normalization for %j', async (snapshot) => {
    const id = `${prefix}09998`;
    const binding = await db.publisherEntityBinding.update({
      where: { chatId: id },
      data: {
        botAccessState: 'CONFIRMED_ADMIN',
        permissionsSnapshot: snapshot as Prisma.InputJsonValue,
      },
    });
    const readiness = new PublisherReadinessService(
      db as never,
      {} as never,
      { get: (name: string) => (name === 'MAX_PUBLISHER_BOT_ID' ? bot : true) } as never,
    );
    const expected = readiness.resolveReadiness(
      {
        id,
        entityType: 'CHAT',
        publicationPolicy: null,
        publisherSettings: null,
        publisherBinding: binding,
      },
      { runtimeAvailable: true },
    ).canPublish;
    const page = await first.page(
      actor,
      bot,
      publisherEntitiesCursorQuerySchema.parse({
        pagination: 'cursor',
        query: id,
        readiness: 'ready',
      }),
      true,
    );
    expect(page.ids.includes(id)).toBe(expected);
  });
});
