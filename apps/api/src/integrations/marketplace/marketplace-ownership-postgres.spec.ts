import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, createPrismaAdapter } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import { MaxClientService } from '../../max/max-client.service';
import { MarketplaceStateService } from './marketplace-state.service';
import { MarketplaceStatisticsService } from './marketplace-statistics.service';
import { MarketplaceCollectorService } from './marketplace-collector.service';
import { MarketplaceNativeProjectionService } from './marketplace-native-projection.service';
import { MarketplaceIntegrationController } from './marketplace.controller';
import type { MarketplaceAccessService } from './marketplace-access.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);
postgres('shared native collection ownership', () => {
  let db: PrismaClient;
  let state: MarketplaceStateService;
  let statistics: MarketplaceStatisticsService;
  let native: MarketplaceNativeProjectionService;
  let entityId: string;
  let id: string;
  let second: string;
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 3, statement_timeout: 10_000 }),
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
    native = new MarketplaceNativeProjectionService(db as PrismaService);
  });
  beforeEach(async () => {
    [id, second] = [randomUUID(), randomUUID()].sort();
    entityId = `-${Date.now()}${Math.floor(Math.random() * 100000)}`;
    await db.chat.create({
      data: { id: entityId, title: 'Synthetic unified channel', entityType: 'CHANNEL' },
    });
    await db.chatBotMembership.create({
      data: { chatId: entityId, botId: 'synthetic-major', status: 'ACTIVE' },
    });
    const metadata = {
      title: 'Synthetic unified channel',
      description: '',
      imageUrl: null,
      publicUrl: null,
      audience: 42,
      isPublic: true,
    };
    await db.$executeRaw`INSERT INTO marketplace_bindings(id,actor_user_id,entity_id,kind,profile,bot_id,state,checked_at,valid_until,metadata,statistics_consent)
      VALUES(${id}::uuid,'323459159',${entityId},'CHANNEL','moderation','synthetic-major','ACTIVE',now(),now()+interval '5 minutes',${JSON.stringify(metadata)}::jsonb,true)`;
  });
  afterEach(async () => {
    await db.$executeRaw`DELETE FROM marketplace_statistics_generations WHERE binding_id IN (${id}::uuid,${second}::uuid)`;
    await db.$executeRaw`DELETE FROM marketplace_post_samples WHERE binding_id IN (${id}::uuid,${second}::uuid)`;
    await db.$executeRaw`DELETE FROM marketplace_audience_observations WHERE binding_id IN (${id}::uuid,${second}::uuid)`;
    await db.$executeRaw`DELETE FROM marketplace_bindings WHERE id IN (${id}::uuid,${second}::uuid)`;
    await db.chat.delete({ where: { id: entityId } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  function transport() {
    const parser = Object.create(MaxClientService.prototype) as MaxClientService;
    return {
      listMessages: jest.fn().mockResolvedValue([
        {
          body: { mid: 'synthetic-post' },
          timestamp: Date.now() - 6 * 3600_000,
          stat: { views: 125, reactions_total: 3 },
          reactions: [{ emoji: '👍', count: 3 }],
        },
      ]),
      getMessageSnapshot: jest.fn(),
      parseChannelMessageSnapshot: parser.parseChannelMessageSnapshot.bind(parser),
    };
  }
  async function collect() {
    const max = transport();
    await new MarketplaceCollectorService(
      db as PrismaService,
      max as unknown as MaxClientService,
      state,
      statistics,
      native,
    ).tick();
    return max;
  }
  async function handoff() {
    const row = (await state.read(id))!;
    const page = await statistics.page(id, {});
    const input = {
      expectedRevision: row.revision,
      generationId: page.manifest.generationId,
      sha256: page.manifest.sha256,
      metrics: ['REACH'],
    };
    const controller = new MarketplaceIntegrationController(
      {} as MarketplaceAccessService,
      state,
      statistics,
      db as PrismaService,
    );
    await controller.handoff(id, input);
    return { controller, input };
  }
  it('feeds native MAXIM and only suppresses covered metrics after a replay-safe verified handoff', async () => {
    await collect();
    expect(
      await db.channelPost.findUnique({
        where: { chatId_messageId: { chatId: entityId, messageId: 'synthetic-post' } },
      }),
    ).toMatchObject({ latestViews: 125, latestReactionsTotal: 3 });
    expect(await state.hasHealthyCollectionOwner({ entityId, metrics: ['REACH'] })).toBe(false);
    const { controller, input } = await handoff();
    const revision = (await state.read(id))!.revision;
    await controller.handoff(id, input);
    expect((await state.read(id))!.revision).toBe(revision);
    expect(await state.hasHealthyCollectionOwner({ entityId, metrics: ['REACH'] })).toBe(true);
    expect(await state.hasHealthyCollectionOwner({ entityId, metrics: ['AUDIENCE'] })).toBe(false);
    expect(
      await state.hasHealthyCollectionOwner({ entityId: 'another-entity', metrics: ['REACH'] }),
    ).toBe(false);
    await db.$executeRaw`UPDATE marketplace_bindings SET statistics_consent=false,state='REVOKED' WHERE id=${id}::uuid`;
    expect(await state.hasHealthyCollectionOwner({ entityId, metrics: ['REACH'] })).toBe(false);
    await expect(controller.handoff(id, input)).rejects.toThrow();
  });
  it('does not replace history when the derivative publication-hour coverage is incomplete', async () => {
    await collect();
    await handoff();
    expect(await state.hasHealthyCollectionOwner({ entityId, metrics: ['REACH'] })).toBe(true);
    await db.$executeRaw`UPDATE marketplace_statistics_generations g SET rows=(SELECT jsonb_agg(
      CASE WHEN point->>'metric'='PUBLICATION_HOUR' THEN jsonb_set(point,'{complete}','false'::jsonb) ELSE point END)
      FROM jsonb_array_elements(g.rows) point) WHERE binding_id=${id}::uuid`;
    expect(await state.hasHealthyCollectionOwner({ entityId, metrics: ['REACH'] })).toBe(false);
  });
  it.each(['statistics', 'native', 'full', 'future', 'grant', 'anomaly', 'bot', 'actor'])(
    'falls back when %s ownership evidence is no longer healthy',
    async (cause) => {
      await collect();
      await handoff();
      if (cause === 'statistics')
        await db.$executeRaw`UPDATE marketplace_bindings SET statistics_checked_at=now()-interval '6 minutes' WHERE id=${id}::uuid`;
      if (cause === 'native')
        await db.$executeRaw`UPDATE marketplace_bindings SET native_history_checked_at=NULL WHERE id=${id}::uuid`;
      if (cause === 'full')
        await db.$executeRaw`UPDATE marketplace_bindings SET native_full_checked_at=now()-interval '3 hours' WHERE id=${id}::uuid`;
      if (cause === 'future')
        await db.$executeRaw`UPDATE marketplace_bindings SET native_full_checked_at=now()+interval '1 hour' WHERE id=${id}::uuid`;
      if (cause === 'grant')
        await db.$executeRaw`UPDATE marketplace_bindings SET valid_until=now()-interval '1 second' WHERE id=${id}::uuid`;
      if (cause === 'anomaly')
        await db.$executeRaw`UPDATE marketplace_bindings SET history_anomaly=true WHERE id=${id}::uuid`;
      if (cause === 'bot')
        await db.chatBotMembership.updateMany({
          where: { chatId: entityId },
          data: { status: 'REMOVED' },
        });
      if (cause === 'actor')
        await db.chatMembershipActivityEvent.create({
          data: {
            chatId: entityId,
            userId: '323459159',
            eventType: 'user_removed',
            eventAt: new Date(Date.now() + 1000),
            dedupeKey: randomUUID(),
          },
        });
      expect(await state.hasHealthyCollectionOwner({ entityId, metrics: ['REACH'] })).toBe(false);
    },
  );
  it('uses one history request for two consented profiles and elects the survivor on revoke', async () => {
    await db.publisherEntityBinding.create({
      data: { chatId: entityId, publisherBotId: 'synthetic-publisher', status: 'ACTIVE' },
    });
    await db.$executeRaw`INSERT INTO marketplace_bindings(id,actor_user_id,entity_id,kind,profile,bot_id,state,checked_at,valid_until,metadata,statistics_consent)
      SELECT ${second}::uuid,actor_user_id,entity_id,kind,'publisher','synthetic-publisher',state,checked_at,valid_until,metadata,true FROM marketplace_bindings WHERE id=${id}::uuid`;
    const max = await collect();
    const follower = (await state.read(second))!;
    expect(max.listMessages).toHaveBeenCalledTimes(1);
    expect(follower.history_complete).toBe(true);
    expect(follower.native_full_checked_at).not.toBeNull();
    expect((await statistics.page(second, {})).manifest.complete).toBe(true);
    await db.$executeRaw`UPDATE marketplace_bindings SET state='REVOKED',statistics_consent=false WHERE id=${id}::uuid`;
    await db.$executeRaw`UPDATE marketplace_bindings SET next_collect_at=now() WHERE id=${second}::uuid`;
    const next = transport();
    next.listMessages.mockResolvedValue([]);
    await new MarketplaceCollectorService(
      db as PrismaService,
      next as unknown as MaxClientService,
      state,
      statistics,
      native,
    ).tick();
    expect(next.listMessages).toHaveBeenCalledTimes(1);
    expect(next.listMessages.mock.calls[0]![1]).toMatchObject({ botId: 'synthetic-publisher' });
    expect(
      await db.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT count(*)::bigint AS count FROM marketplace_post_samples WHERE binding_id=${second}::uuid`,
    ).toEqual([{ count: 1n }]);
  });
  it.each(['actor', 'bot', 'denial', 'bot-denial'])(
    'stops collection and export immediately after observed %s removal',
    async (kind) => {
      await collect();
      const remove = async () => {
        if (kind === 'bot')
          await db.chatBotMembership.updateMany({
            where: { chatId: entityId },
            data: { status: 'REMOVED', lifecycleEventAt: new Date() },
          });
        else if (kind === 'bot-denial') {
          // Real grants use JavaScript millisecond dates, unlike this fixture's SQL now().
          await db.$executeRaw`UPDATE marketplace_bindings SET checked_at=date_trunc('milliseconds',checked_at) WHERE id=${id}::uuid`;
          await db.chatBotMembership.updateMany({
            where: { chatId: entityId },
            data: {
              botAccessState: 'DENIED',
              botAccessCheckedAt: (await state.read(id))!.checked_at,
            },
          });
        } else if (kind === 'denial')
          await db.managedEntityAccessEdge.create({
            data: {
              chatId: entityId,
              userId: '323459159',
              botId: 'synthetic-major',
              entityType: 'CHANNEL',
              state: 'USER_DENIED',
              userRole: 'MEMBER',
              botRole: 'ADMIN',
              checkedAt: new Date(Date.now() + 1000),
            },
          });
        else
          await db.chatMembershipActivityEvent.create({
            data: {
              chatId: entityId,
              userId: '323459159',
              eventType: 'user_removed',
              eventAt: new Date(Date.now() + 1000),
              dedupeKey: randomUUID(),
            },
          });
      };
      await remove();
      await db.$executeRaw`UPDATE marketplace_bindings SET next_collect_at=now() WHERE id=${id}::uuid`;
      const max = await collect();
      expect(max.listMessages).not.toHaveBeenCalled();
      expect(max.getMessageSnapshot).not.toHaveBeenCalled();
      await expect(statistics.createGeneration((await state.read(id))!)).rejects.toThrow();
      await expect(statistics.page(id, {})).rejects.toThrow();
      const controller = new MarketplaceIntegrationController(
        {} as MarketplaceAccessService,
        state,
        statistics,
        db as PrismaService,
      );
      expect(await controller.get(id)).toMatchObject({ state: 'UNKNOWN', validUntil: null });
      expect(
        (await controller.changes({})).bindings.find((binding) => binding.id === id),
      ).toMatchObject({ state: 'UNKNOWN', validUntil: null });
    },
  );
  it('fences observations when bot removal arrives during a MAX history request', async () => {
    const max = transport();
    max.listMessages.mockImplementation(async () => {
      await db.chatBotMembership.updateMany({
        where: { chatId: entityId },
        data: { status: 'REMOVED', lifecycleEventAt: new Date() },
      });
      return [
        { body: { mid: 'late-post' }, timestamp: Date.now() - 3600_000, stat: { views: 100 } },
      ];
    });
    await new MarketplaceCollectorService(
      db as PrismaService,
      max as unknown as MaxClientService,
      state,
      statistics,
      native,
    ).tick();
    expect(max.listMessages).toHaveBeenCalledTimes(1);
    expect(await db.channelPost.count({ where: { chatId: entityId } })).toBe(0);
    expect(
      await db.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT count(*)::bigint AS count FROM marketplace_post_samples WHERE binding_id=${id}::uuid`,
    ).toEqual([{ count: 0n }]);
    expect((await state.read(id))!.generation_id).toBeNull();
  });
  it('refreshes historic native views hourly with the same elected collector', async () => {
    const first = await collect();
    const raw = first.listMessages.mock.results[0]!;
    const posts = (await raw.value) as Array<{ stat: { views: number } }>;
    posts[0]!.stat.views = 300;
    await db.$executeRaw`UPDATE marketplace_bindings SET next_collect_at=now(),native_full_checked_at=now()-interval '61 minutes' WHERE id=${id}::uuid`;
    const max = transport();
    max.listMessages.mockResolvedValue(posts);
    await new MarketplaceCollectorService(
      db as PrismaService,
      max as unknown as MaxClientService,
      state,
      statistics,
      native,
    ).tick();
    const call = max.listMessages.mock.calls[0]![1] as { to: Date };
    expect(call.to.getTime()).toBeLessThan(Date.now() - 88 * 86400_000);
    expect((await db.channelPost.findFirst({ where: { chatId: entityId } }))!.latestViews).toBe(
      300,
    );
    expect((await state.read(id))!.native_full_checked_at!.getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );
  });
});
