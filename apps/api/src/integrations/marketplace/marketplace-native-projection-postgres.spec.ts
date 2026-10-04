import { randomUUID } from 'node:crypto';
import { PrismaClient, createPrismaAdapter } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import { MaxClientService, type MaxChannelMessageSnapshot } from '../../max/max-client.service';
import { MarketplaceNativeProjectionService } from './marketplace-native-projection.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
const metadata = {
  title: 'Synthetic native channel',
  description: '',
  imageUrl: null,
  publicUrl: 'https://max.ru/test',
  audience: 100,
  isPublic: true,
};
const parser = Object.create(MaxClientService.prototype) as MaxClientService;

describe('marketplace native snapshot parser', () => {
  it('keeps measured reactions and metadata without returning message bodies', () => {
    const snapshot = parser.parseChannelMessageSnapshot('-1', {
      body: { mid: 'post', text: 'private message body' },
      timestamp: '2026-10-01T12:00:00.000Z',
      url: 'https://max.ru/test/1',
      stat: { views: 123, reactions: [{ emoji: '👍', count: 5 }] },
    });
    expect(snapshot).toMatchObject({
      chatId: '-1',
      messageId: 'post',
      views: 123,
      reactionsTotal: 5,
    });
    expect(snapshot?.reactions).toEqual([{ emoji: '👍', count: 5 }]);
    expect(JSON.stringify(snapshot)).not.toContain('private message body');
    expect(
      parser.parseChannelMessageSnapshot('-1', { body: { mid: 'post' }, timestamp: 1230000000000 }),
    ).toMatchObject({ views: null, reactionsTotal: null, reactions: [] });
    expect(parser.parseChannelMessageSnapshot('-1', null)).toBeNull();
  });
});

jest.setTimeout(30_000);
postgres('marketplace compact native projection with PostgreSQL', () => {
  let db: PrismaClient;
  let service: MarketplaceNativeProjectionService;
  let bindingId: string;
  let entityId: string;
  let lease: string;
  let observedAt: Date;
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 3, statement_timeout: 10000 }),
    });
    await db.$connect();
    service = new MarketplaceNativeProjectionService(db as PrismaService);
  });
  beforeEach(async () => {
    bindingId = randomUUID();
    lease = randomUUID();
    entityId = '-' + String(Date.now()) + String(Math.floor(Math.random() * 10000));
    observedAt = new Date();
    await db.chat.create({ data: { id: entityId, title: metadata.title, entityType: 'CHANNEL' } });
    await db.chatBotMembership.create({
      data: { chatId: entityId, botId: 'test-bot', status: 'ACTIVE' },
    });
    await db.$executeRaw`INSERT INTO marketplace_bindings
      (id,actor_user_id,entity_id,kind,profile,bot_id,state,checked_at,valid_until,metadata,
        statistics_consent,history_complete,history_from,history_to,lease_id,lease_until)
      VALUES(${bindingId}::uuid,'323459159',${entityId},'CHANNEL','moderation','test-bot','ACTIVE',${observedAt},
        now()+interval '5 minutes',${JSON.stringify(metadata)}::jsonb,true,true,now()-interval '89 days',now(),${lease}::uuid,now()+interval '2 minutes')`;
  });
  afterEach(async () => {
    await db.$executeRaw`DELETE FROM marketplace_bindings WHERE entity_id=${entityId}`;
    await db.chat.delete({ where: { id: entityId } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  const snapshot = (
    overrides: Partial<MaxChannelMessageSnapshot> = {},
  ): MaxChannelMessageSnapshot => {
    const publishedAt = new Date(observedAt.getTime() - 24 * 3600_000);
    return {
      chatId: entityId,
      messageId: 'post',
      publishedAt: publishedAt.toISOString(),
      publishedAtMs: publishedAt.getTime(),
      url: 'https://max.ru/test/1',
      previewUrl: 'https://example.com/preview.jpg',
      views: 100,
      reactionsTotal: 7,
      reactions: [{ emoji: '👍', count: 7 }],
      ...overrides,
    };
  };
  const readPost = (messageId = 'post') =>
    db.channelPost.findUniqueOrThrow({
      where: { chatId_messageId: { chatId: entityId, messageId } },
      include: { viewSnapshots: true },
    });

  it('projects native metadata and deduplicates view snapshots and their rollup delta', async () => {
    await service.post(bindingId, lease, snapshot(), observedAt);
    await service.post(bindingId, lease, snapshot(), observedAt);
    const later = new Date(observedAt.getTime() + 1000);
    await service.post(bindingId, lease, snapshot({ views: 140 }), later);
    await service.post(bindingId, lease, snapshot({ views: 140 }), later);
    const post = await readPost();
    expect(post).toMatchObject({
      latestViews: 140,
      latestReactionsTotal: 7,
      url: 'https://max.ru/test/1',
      previewUrl: 'https://example.com/preview.jpg',
      viewsAt24h: 100,
    });
    expect(post.latestReactions).toEqual([{ emoji: '👍', count: 7 }]);
    expect(post.viewSnapshots).toHaveLength(2);
    const totals = await db.$queryRaw<Array<{ posts: bigint; views: bigint }>>`
      SELECT sum(posts)::bigint AS posts,sum(views_delta)::bigint AS views
        FROM channel_stats_bucket_rollups WHERE chat_id=${entityId}`;
    expect(Number(totals[0]?.posts)).toBe(1);
    expect(Number(totals[0]?.views)).toBe(40);
  });

  it('preserves known values when absent and accepts a measured zero', async () => {
    await service.post(bindingId, lease, snapshot(), observedAt);
    await service.post(
      bindingId,
      lease,
      snapshot({ views: null, reactionsTotal: null, reactions: [], url: null, previewUrl: null }),
      new Date(observedAt.getTime() + 1000),
    );
    expect(await readPost()).toMatchObject({
      latestViews: 100,
      latestReactionsTotal: 7,
      latestReactions: [{ emoji: '👍', count: 7 }],
      url: 'https://max.ru/test/1',
      previewUrl: 'https://example.com/preview.jpg',
    });
    await service.post(
      bindingId,
      lease,
      snapshot({ views: 0, reactionsTotal: 0, reactions: [] }),
      new Date(observedAt.getTime() + 2000),
    );
    expect(await readPost()).toMatchObject({
      latestViews: 0,
      latestReactionsTotal: 0,
      latestReactions: null,
    });
  });

  it('does not manufacture an observation for a post without views or reactions', async () => {
    await service.post(
      bindingId,
      lease,
      snapshot({ views: null, reactionsTotal: null, reactions: [] }),
      observedAt,
    );
    expect(await readPost()).toMatchObject({
      latestSnapshotAt: null,
      latestReactions: null,
      viewsAt24h: null,
      viewsAt48h: null,
      viewSnapshots: [],
    });
  });

  it('does not replace newer native measurements or metadata with an older page', async () => {
    await service.post(bindingId, lease, snapshot(), observedAt);
    await service.post(
      bindingId,
      lease,
      snapshot({
        views: 50,
        reactionsTotal: 2,
        reactions: [{ emoji: '👍', count: 2 }],
        url: 'https://max.ru/old',
        previewUrl: 'https://example.com/old.jpg',
      }),
      new Date(observedAt.getTime() - 1000),
    );
    expect(await readPost()).toMatchObject({
      latestViews: 100,
      latestReactionsTotal: 7,
      url: 'https://max.ru/test/1',
      previewUrl: 'https://example.com/preview.jpg',
    });
    expect((await readPost()).viewSnapshots).toHaveLength(1);
  });

  it.each([24, 48])(
    'accepts the strict %ih boundary and excludes 901-second delayed samples',
    async (horizon) => {
      for (const delay of [900, 901]) {
        const publishedAt = new Date(observedAt.getTime() - horizon * 3600_000 - delay * 1000);
        await service.post(
          bindingId,
          lease,
          snapshot({ messageId: String(delay), publishedAt: publishedAt.toISOString() }),
          observedAt,
        );
      }
      expect((await readPost('900'))[horizon === 24 ? 'viewsAt24h' : 'viewsAt48h']).toBe(100);
      expect((await readPost('901'))[horizon === 24 ? 'viewsAt24h' : 'viewsAt48h']).toBeNull();
    },
  );

  it('preserves immutable publication time and rejects coverage after a conflicting date', async () => {
    await service.post(bindingId, lease, snapshot(), observedAt);
    await service.post(
      bindingId,
      lease,
      snapshot({ publishedAt: new Date(observedAt.getTime() - 3600_000).toISOString() }),
      observedAt,
    );
    await service.completeHistory(bindingId, lease, observedAt, { full: true });
    expect((await readPost()).publishedAt.toISOString()).toBe(snapshot().publishedAt);
    const bindings = await db.$queryRaw<
      Array<{ history_anomaly: boolean; native_history_checked_at: Date | null }>
    >`
      SELECT history_anomaly,native_history_checked_at FROM marketplace_bindings WHERE id=${bindingId}::uuid`;
    expect(bindings[0]).toEqual({ history_anomaly: true, native_history_checked_at: null });
  });

  it.each([false, true])(
    'improves late milestones without replacing a newer latest observation (%s)',
    async (newerLatest) => {
      const publishedAt = new Date(observedAt.getTime() - 27 * 3600_000);
      const strictAt = new Date(publishedAt.getTime() + 24 * 3600_000 + 5 * 60_000);
      await db.channelPost.create({
        data: {
          chatId: entityId,
          messageId: 'post',
          publishedAt,
          latestViews: 900,
          latestSnapshotAt: newerLatest ? observedAt : null,
          viewsAt24h: 800,
          viewsAt24hCapturedAt: observedAt,
        },
      });
      await service.post(
        bindingId,
        lease,
        snapshot({ publishedAt: publishedAt.toISOString(), views: 700 }),
        strictAt,
      );
      let post = await readPost();
      expect(post).toMatchObject({
        viewsAt24h: 700,
        viewsAt24hCapturedAt: strictAt,
        latestViews: newerLatest ? 900 : 700,
        latestSnapshotAt: newerLatest ? observedAt : strictAt,
      });
      expect(post.viewSnapshots).toHaveLength(newerLatest ? 0 : 1);
      await service.post(
        bindingId,
        lease,
        snapshot({ publishedAt: publishedAt.toISOString(), views: 710 }),
        new Date(strictAt.getTime() + 1000),
      );
      post = await readPost();
      expect(post).toMatchObject({ viewsAt24h: 700, viewsAt24hCapturedAt: strictAt });
    },
  );

  it.each([
    'consent',
    'revoked',
    'expired-grant',
    'expired-lease',
    'replaced-lease',
    'wrong-entity',
  ])('does not write after %s invalidates its authority', async (failure) => {
    if (failure === 'consent')
      await db.$executeRaw`UPDATE marketplace_bindings SET statistics_consent=false WHERE id=${bindingId}::uuid`;
    if (failure === 'revoked')
      await db.$executeRaw`UPDATE marketplace_bindings SET state='REVOKED' WHERE id=${bindingId}::uuid`;
    if (failure === 'expired-grant')
      await db.$executeRaw`UPDATE marketplace_bindings SET valid_until=now()-interval '1 second' WHERE id=${bindingId}::uuid`;
    if (failure === 'expired-lease')
      await db.$executeRaw`UPDATE marketplace_bindings SET lease_until=now()-interval '1 second' WHERE id=${bindingId}::uuid`;
    if (failure === 'replaced-lease') lease = randomUUID();
    await service.post(
      bindingId,
      lease,
      snapshot(failure === 'wrong-entity' ? { chatId: '-2' } : {}),
      observedAt,
    );
    if (failure !== 'wrong-entity') {
      await service.audience(bindingId, lease, observedAt, metadata);
      await service.completeHistory(bindingId, lease, observedAt, { full: true });
    }
    expect(await db.channelPost.count({ where: { chatId: entityId } })).toBe(0);
    expect(await db.channelAudienceSnapshot.count({ where: { chatId: entityId } })).toBe(0);
    expect(await db.channelStatsSyncState.findUnique({ where: { chatId: entityId } })).toBeNull();
  });

  it('deduplicates audience and advances freshness only for the actual measured grant', async () => {
    await service.audience(bindingId, lease, observedAt, { ...metadata, audience: null });
    await service.audience(bindingId, lease, new Date(observedAt.getTime() - 1), metadata);
    expect(await db.channelAudienceSnapshot.count({ where: { chatId: entityId } })).toBe(0);
    await service.audience(bindingId, lease, observedAt, metadata);
    await service.audience(bindingId, lease, observedAt, metadata);
    expect(await db.channelAudienceSnapshot.findMany({ where: { chatId: entityId } })).toEqual([
      expect.objectContaining({ participantsCount: 100, capturedAt: observedAt }),
    ]);
    expect(
      await db.channelStatsSyncState.findUnique({ where: { chatId: entityId } }),
    ).toMatchObject({ lastAudienceSyncAt: observedAt, lastViewsSyncAt: null });
  });

  it('retains known native audience metadata absent from the shared wire', async () => {
    const lastEventAt = new Date(observedAt.getTime() - 5000);
    await db.channelAudienceSnapshot.create({
      data: {
        chatId: entityId,
        participantsCount: 90,
        status: 'active',
        lastEventAt,
        capturedAt: new Date(observedAt.getTime() - 1000),
      },
    });
    await service.audience(bindingId, lease, observedAt, metadata);
    const latest = await db.channelAudienceSnapshot.findFirstOrThrow({
      where: { chatId: entityId },
      orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
    });
    expect(latest).toMatchObject({
      capturedAt: observedAt,
      participantsCount: 100,
      status: 'active',
      lastEventAt,
    });
  });

  it('does not replace a newer native title with older access metadata', async () => {
    await db.chat.update({ where: { id: entityId }, data: { title: 'Newer native title' } });
    await db.channelAudienceSnapshot.create({
      data: {
        chatId: entityId,
        participantsCount: 101,
        capturedAt: new Date(observedAt.getTime() + 1000),
      },
    });
    await service.audience(bindingId, lease, observedAt, metadata);
    expect((await db.chat.findUniqueOrThrow({ where: { id: entityId } })).title).toBe(
      'Newer native title',
    );
    const freshAt = new Date(observedAt.getTime() + 2000);
    await db.$executeRaw`UPDATE marketplace_bindings SET checked_at=${freshAt} WHERE id=${bindingId}::uuid`;
    await service.audience(bindingId, lease, freshAt, { ...metadata, title: 'Freshest title' });
    expect((await db.chat.findUniqueOrThrow({ where: { id: entityId } })).title).toBe(
      'Freshest title',
    );
  });

  it.each(['bot-removed', 'bot-denied', 'actor-removed'])(
    'rejects native projection after known %s without waiting for grant expiry',
    async (cause) => {
      if (cause === 'bot-removed')
        await db.chatBotMembership.update({
          where: { chatId_botId: { chatId: entityId, botId: 'test-bot' } },
          data: { status: 'REMOVED' },
        });
      if (cause === 'bot-denied')
        await db.chatBotMembership.update({
          where: { chatId_botId: { chatId: entityId, botId: 'test-bot' } },
          data: {
            botAccessState: 'DENIED',
            botAccessCheckedAt: new Date(observedAt.getTime() + 1),
          },
        });
      if (cause === 'actor-removed')
        await db.chatMembershipActivityEvent.create({
          data: {
            chatId: entityId,
            userId: '323459159',
            eventType: 'user_removed',
            eventAt: new Date(observedAt.getTime() + 1),
            dedupeKey: randomUUID(),
          },
        });
      await service.post(bindingId, lease, snapshot(), observedAt);
      await service.audience(bindingId, lease, observedAt, metadata);
      await service.completeHistory(bindingId, lease, observedAt, { full: true });
      expect(await db.channelPost.count({ where: { chatId: entityId } })).toBe(0);
      expect(await db.channelAudienceSnapshot.count({ where: { chatId: entityId } })).toBe(0);
      expect(await db.channelStatsSyncState.findUnique({ where: { chatId: entityId } })).toBeNull();
    },
  );

  it('does not advance native history after a partial page and separates discovery from full scan', async () => {
    await db.$executeRaw`UPDATE marketplace_bindings SET history_cursor=now() WHERE id=${bindingId}::uuid`;
    await service.post(bindingId, lease, snapshot(), observedAt);
    await service.completeHistory(bindingId, lease, observedAt, { full: true });
    expect(await db.channelStatsSyncState.findUnique({ where: { chatId: entityId } })).toBeNull();
    await db.$executeRaw`UPDATE marketplace_bindings SET history_cursor=NULL WHERE id=${bindingId}::uuid`;
    await service.completeHistory(bindingId, lease, observedAt, { full: false });
    expect(
      await db.channelStatsSyncState.findUnique({ where: { chatId: entityId } }),
    ).toMatchObject({ lastViewsSyncAt: null, lastViewsDiscoveryAt: observedAt });
    await service.completeHistory(bindingId, lease, observedAt, { full: true });
    expect(
      await db.channelStatsSyncState.findUnique({ where: { chatId: entityId } }),
    ).toMatchObject({ lastViewsSyncAt: observedAt, lastViewsDiscoveryAt: observedAt });
  });

  it('uses UTC native rows and rollups even with a Tokyo database session', async () => {
    const otherUrl = new URL(databaseUrl);
    otherUrl.searchParams.set('options', '-c timezone=Asia/Tokyo');
    const other = new PrismaClient({
      adapter: createPrismaAdapter(otherUrl.toString(), { max: 1, statement_timeout: 10000 }),
    });
    try {
      await other.$connect();
      const projector = new MarketplaceNativeProjectionService(other as PrismaService);
      await projector.post(bindingId, lease, snapshot(), observedAt);
      await projector.audience(bindingId, lease, observedAt, metadata);
      expect((await readPost()).publishedAt.toISOString()).toBe(snapshot().publishedAt);
      expect((await readPost()).latestSnapshotAt).toEqual(observedAt);
      expect(
        (await db.channelAudienceSnapshot.findFirstOrThrow({ where: { chatId: entityId } }))
          .capturedAt,
      ).toEqual(observedAt);
    } finally {
      await other.$disconnect();
    }
  });
});
