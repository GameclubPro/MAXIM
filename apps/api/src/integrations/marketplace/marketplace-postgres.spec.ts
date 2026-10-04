import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, createPrismaAdapter } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import { MarketplaceStateService } from './marketplace-state.service';
import { MarketplaceStatisticsService } from './marketplace-statistics.service';
import { MarketplaceCollectorService } from './marketplace-collector.service';
import type { MaxClientService } from '../../max/max-client.service';
import { marketplaceRowsHash } from './marketplace-statistics';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);
postgres('marketplace SQL generations and collection', () => {
  let db: PrismaClient;
  let state: MarketplaceStateService;
  let statistics: MarketplaceStatisticsService;
  let id: string;
  let entityId: string;
  let published: Date;
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 2, statement_timeout: 10_000 }),
    });
    await db.$connect();
    state = new MarketplaceStateService(
      db as PrismaService,
      new ConfigService({
        SVYAZKA_ANALYTICS_TOKEN: 'a'.repeat(64),
        SVYAZKA_PROFILE_TOKEN: 'b'.repeat(64),
      }),
    );
    statistics = new MarketplaceStatisticsService(db as PrismaService, state);
  });
  beforeEach(async () => {
    id = randomUUID();
    entityId = '-' + String(Date.now()) + String(Math.floor(Math.random() * 10000));
    published = new Date(Date.now() - 3 * 86400_000);
    published.setUTCHours(8, 0, 0, 0);
    await db.chat.create({
      data: { id: entityId, title: 'Synthetic marketplace channel', entityType: 'CHANNEL' },
    });
    await db.chatBotMembership.create({
      data: { chatId: entityId, botId: 'test-bot', status: 'ACTIVE', botAccessState: 'UNKNOWN' },
    });
    const metadata = {
      title: 'Synthetic marketplace channel',
      description: '',
      imageUrl: null,
      publicUrl: null,
      audience: 100,
      isPublic: true,
    };
    await db.$executeRaw`INSERT INTO marketplace_bindings(id,actor_user_id,entity_id,kind,profile,bot_id,state,checked_at,valid_until,metadata,statistics_consent,history_complete,history_from,history_to)
      VALUES(${id}::uuid,'323459159',${entityId},'CHANNEL','moderation','test-bot','ACTIVE',now(),now()+interval '10 minutes',${JSON.stringify(metadata)}::jsonb,true,true,now()-interval '89 days',now())`;
    for (const [messageId, delay] of [
      ['within', 900],
      ['late', 901],
    ] as const) {
      await db.channelPost.create({
        data: {
          chatId: entityId,
          messageId,
          publishedAt: published,
          latestViews: 1000,
          latestSnapshotAt: new Date(),
          viewsAt24h: 50,
          viewsAt24hCapturedAt: new Date(published.getTime() + 86400_000 + delay * 1000),
        },
      });
    }
  });
  afterEach(async () => {
    await db.$executeRaw`DELETE FROM marketplace_statistics_generations WHERE binding_id=${id}::uuid`;
    await db.$executeRaw`DELETE FROM marketplace_post_samples WHERE binding_id=${id}::uuid`;
    await db.$executeRaw`DELETE FROM marketplace_audience_observations WHERE binding_id=${id}::uuid`;
    await db.$executeRaw`DELETE FROM marketplace_bindings WHERE id=${id}::uuid`;
    await db.chat.delete({ where: { id: entityId } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  it('exports only strict measured horizons and stable immutable 200-row pages', async () => {
    const row = (await state.read(id))!;
    const generationId = await statistics.createGeneration(row);
    const first = await statistics.page(id, { generationId });
    expect(first.rows).toHaveLength(200);
    expect(first.nextCursor).not.toBeNull();
    await db.channelPost.updateMany({ where: { chatId: entityId }, data: { latestViews: 9000 } });
    const newer = await statistics.createGeneration((await state.read(id))!);
    expect(newer).not.toBe(generationId);
    const all = [...first.rows];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await statistics.page(id, { generationId, cursor });
      expect(page.manifest.generationId).toBe(generationId);
      all.push(...page.rows);
      cursor = page.nextCursor;
    }
    expect(all).toHaveLength(first.manifest.rowCount);
    expect(marketplaceRowsHash(all)).toBe(first.manifest.sha256);
    const measured = all.find(
      (point) =>
        point.metric === 'REACH' &&
        point.horizon === 24 &&
        point.bucket.slice(0, 10) === published.toISOString().slice(0, 10),
    );
    expect(measured).toMatchObject({
      posts: 2,
      samples: 1,
      views: 50,
      incomplete: true,
      maxDelaySeconds: 900,
    });
    expect(JSON.stringify(all)).not.toContain('within');
    expect(JSON.stringify(all)).not.toContain('test-bot');
    await expect(
      statistics.page(id, { generationId: newer, cursor: first.nextCursor! }),
    ).rejects.toThrow('Курсор относится к другой выгрузке');
  });
  it('deduplicates native and newly sampled identical posts, preserving native late captures', async () => {
    await db.$executeRaw`INSERT INTO marketplace_post_samples(binding_id,message_id,published_at,views,observed_at,views_24,captured_24)
      VALUES(${id}::uuid,'within',${published},1200,now(),60,${new Date(published.getTime() + 86400_000 + 300_000)})`;
    const generationId = await statistics.createGeneration((await state.read(id))!);
    let page = await statistics.page(id, { generationId });
    const all = [...page.rows];
    while (page.nextCursor) {
      page = await statistics.page(id, { cursor: page.nextCursor });
      all.push(...page.rows);
    }
    const measured = all.find(
      (point) =>
        point.metric === 'REACH' &&
        point.horizon === 24 &&
        point.bucket.slice(0, 10) === published.toISOString().slice(0, 10),
    );
    expect(measured).toMatchObject({ posts: 2, samples: 1, views: 60 });
    expect(
      (
        await db.channelPost.findUnique({
          where: { chatId_messageId: { chatId: entityId, messageId: 'late' } },
        })
      )?.viewsAt24h,
    ).toBe(50);
  });
  it('keeps identical UTC buckets under a non-UTC database session', async () => {
    const asOf = new Date();
    const first = await statistics.createGeneration((await state.read(id))!, asOf);
    const otherUrl = new URL(databaseUrl);
    otherUrl.searchParams.set('options', '-c timezone=Asia/Tokyo');
    const other = new PrismaClient({
      adapter: createPrismaAdapter(otherUrl.toString(), { max: 1, statement_timeout: 10_000 }),
    });
    try {
      await other.$connect();
      const changed = await new MarketplaceStatisticsService(
        other as PrismaService,
        state,
      ).createGeneration((await state.read(id))!, asOf);
      const original = await db.$queryRaw<
        Array<{ rows: unknown }>
      >`SELECT rows FROM marketplace_statistics_generations WHERE id=${first}::uuid`;
      const newer = await db.$queryRaw<
        Array<{ rows: unknown }>
      >`SELECT rows FROM marketplace_statistics_generations WHERE id=${changed}::uuid`;
      expect(newer[0]!.rows).toEqual(original[0]!.rows);
      expect(changed).toBe(first);
    } finally {
      await other.$disconnect();
    }
  });
  it('resolves CTA from its exact fresh bot grant and stops on observed removal', async () => {
    await db.$executeRaw`UPDATE marketplace_bindings SET append_enabled=true,public_url='https://max.ru/id613000037577_3_bot',public_verified_until=now()+interval '5 minutes' WHERE id=${id}::uuid`;
    expect(
      await state.resolvePublicationButton({ chatId: entityId, botId: 'test-bot' }),
    ).not.toBeNull();
    expect(
      await state.resolvePublicationButton({ chatId: entityId, botId: 'another-bot' }),
    ).toBeNull();
    await db.chatMembershipActivityEvent.create({
      data: {
        chatId: entityId,
        userId: '323459159',
        eventType: 'user_removed',
        eventAt: new Date(Date.now() + 1000),
        dedupeKey: randomUUID(),
      },
    });
    expect(
      await state.resolvePublicationButton({ chatId: entityId, botId: 'test-bot' }),
    ).toBeNull();
    await db.chatMembershipActivityEvent.deleteMany({ where: { chatId: entityId } });
  });
  it('finishes chat aggregate export without an unsupported message-history scan', async () => {
    await db.channelPost.deleteMany({ where: { chatId: entityId } });
    await db.$executeRaw`UPDATE marketplace_bindings SET kind='CHAT',history_complete=false,history_cursor=now() WHERE id=${id}::uuid`;
    const max = {
      listMessages: jest.fn(),
      getMessageSnapshot: jest.fn(),
    } as unknown as MaxClientService;
    await new MarketplaceCollectorService(db as PrismaService, max, state, statistics).tick();
    expect(max.listMessages).not.toHaveBeenCalled();
    expect((await state.read(id))!.history_cursor).toBeNull();
    const page = await statistics.page(id, {});
    expect(page.manifest.complete).toBe(true);
    expect(page.rows.map((row) => row.metric)).toEqual(['AUDIENCE']);
  });
  it('reuses unchanged generations but records successful refresh separately', async () => {
    const asOf = new Date();
    const first = await statistics.createGeneration((await state.read(id))!, asOf);
    const later = new Date(asOf.getTime() + 1000);
    const second = await statistics.createGeneration((await state.read(id))!, later);
    expect(second).toBe(first);
    expect((await state.read(id))!.statistics_checked_at).toEqual(later);
    expect((await statistics.page(id, { generationId: first })).manifest.asOf).toBe(
      asOf.toISOString(),
    );
  });
  it('resumes a 4101-post history through overlapping bounded pages', async () => {
    const from = new Date();
    from.setUTCHours(0, 0, 0, 0);
    from.setUTCDate(from.getUTCDate() - 89);
    const source = Array.from({ length: 4101 }, (_, index) => ({
      body: { mid: `large-${index}` },
      timestamp: from.getTime() + index * 30 * 60_000,
      stat: { views: index },
    }));
    const max = {
      listMessages: jest
        .fn()
        .mockImplementation(async (_id: string, options: { from: Date; to: Date }) =>
          source
            .filter(
              (post) =>
                post.timestamp <= options.from.getTime() && post.timestamp >= options.to.getTime(),
            )
            .reverse()
            .slice(0, 100),
        ),
      getMessageSnapshot: jest.fn(),
    } as unknown as MaxClientService;
    const generations = {
      createGeneration: jest.fn().mockResolvedValue('unused'),
    } as unknown as MarketplaceStatisticsService;
    await db.$executeRaw`UPDATE marketplace_bindings SET history_complete=false,history_from=${from},history_cursor=now(),history_to=now() WHERE id=${id}::uuid`;
    let calls = 0;
    while (!(await state.read(id))!.history_complete && calls++ < 50) {
      await db.$executeRaw`UPDATE marketplace_bindings SET next_collect_at=now() WHERE id=${id}::uuid`;
      // Recreating the worker each page proves that progress lives in SQL.
      await new MarketplaceCollectorService(db as PrismaService, max, state, generations).tick();
    }
    expect(calls).toBeGreaterThan(30);
    expect(calls).toBeLessThan(50);
    expect((await state.read(id))!).toMatchObject({
      history_complete: true,
      history_cursor: null,
      history_anomaly: false,
    });
    const count = await db.$queryRaw<
      Array<{ n: bigint }>
    >`SELECT count(*) AS n FROM marketplace_post_samples WHERE binding_id=${id}::uuid`;
    expect(Number(count[0]!.n)).toBe(4101);
  });
  it('marks a repeated boundary incomplete and preserves its retry backoff', async () => {
    const source = Array.from({ length: 100 }, (_, index) => ({
      body: { mid: `same-${index}` },
      timestamp: published.getTime(),
      stat: { views: 0 },
    }));
    const max = {
      listMessages: jest.fn().mockResolvedValue(source),
      getMessageSnapshot: jest.fn(),
    } as unknown as MaxClientService;
    const generations = {
      createGeneration: jest.fn().mockResolvedValue('unused'),
    } as unknown as MarketplaceStatisticsService;
    const collector = new MarketplaceCollectorService(db as PrismaService, max, state, generations);
    await db.$executeRaw`UPDATE marketplace_bindings SET history_complete=false,history_cursor=now() WHERE id=${id}::uuid`;
    await collector.tick();
    await db.$executeRaw`UPDATE marketplace_bindings SET next_collect_at=now() WHERE id=${id}::uuid`;
    await collector.tick();
    const binding = (await state.read(id))!;
    expect(binding.history_anomaly).toBe(true);
    expect(binding.history_complete).toBe(false);
    expect(binding.next_collect_at.getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
  });
  it('preserves immutable publication time and makes conflicting history incomplete', async () => {
    await db.$executeRaw`INSERT INTO marketplace_post_samples(binding_id,message_id,published_at) VALUES(${id}::uuid,'conflict',${published})`;
    await db.$executeRaw`UPDATE marketplace_bindings SET history_complete=false,history_cursor=now() WHERE id=${id}::uuid`;
    const max = {
      listMessages: jest.fn().mockResolvedValue([
        {
          body: { mid: 'conflict' },
          timestamp: published.getTime() + 3600_000,
          stat: { views: 5 },
        },
      ]),
      getMessageSnapshot: jest.fn(),
    } as unknown as MaxClientService;
    const generations = {
      createGeneration: jest.fn().mockResolvedValue('unused'),
    } as unknown as MarketplaceStatisticsService;
    await new MarketplaceCollectorService(db as PrismaService, max, state, generations).tick();
    expect((await state.read(id))!.history_anomaly).toBe(true);
    const sample = await db.$queryRaw<
      Array<{ published_at: Date }>
    >`SELECT published_at FROM marketplace_post_samples WHERE binding_id=${id}::uuid AND message_id='conflict'`;
    expect(sample[0]!.published_at).toEqual(published);
  });
  it('cannot write samples after consent changes during a remote history call', async () => {
    const max = {
      listMessages: jest.fn().mockImplementation(async () => {
        await db.$executeRaw`UPDATE marketplace_bindings SET statistics_consent=false,append_revision=append_revision+1 WHERE id=${id}::uuid`;
        return [{ body: { mid: 'revoked' }, timestamp: published.getTime(), stat: { views: 10 } }];
      }),
      getMessageSnapshot: jest.fn(),
    } as unknown as MaxClientService;
    const generations = { createGeneration: jest.fn() } as unknown as MarketplaceStatisticsService;
    await new MarketplaceCollectorService(db as PrismaService, max, state, generations).tick();
    const count = await db.$queryRaw<
      Array<{ n: bigint }>
    >`SELECT count(*) AS n FROM marketplace_post_samples WHERE binding_id=${id}::uuid`;
    expect(Number(count[0]!.n)).toBe(0);
    expect(generations.createGeneration).not.toHaveBeenCalled();
  });
  it('blocks export after revocation and never collects without consent', async () => {
    const max = {
      listMessages: jest.fn(),
      getMessageSnapshot: jest.fn(),
    } as unknown as MaxClientService;
    const collector = new MarketplaceCollectorService(db as PrismaService, max, state, statistics);
    await db.$executeRaw`UPDATE marketplace_bindings SET statistics_consent=false WHERE id=${id}::uuid`;
    await collector.tick();
    expect(max.listMessages).not.toHaveBeenCalled();
    await db.$executeRaw`UPDATE marketplace_bindings SET state='REVOKED' WHERE id=${id}::uuid`;
    await expect(statistics.page(id, {})).rejects.toThrow('Статистика недоступна');
  });
});
