import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma, PrismaClient, createPrismaAdapter } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { ManagedEntitiesService } from './managed-entities.service';
import type { ManagedEntityNetworksService } from './managed-entity-networks.service';
import { NetworkStatisticsObservationService } from './network-statistics-observation.service';
import { NetworkStatisticsService, networkViewIntervalsSql } from './network-statistics.service';
import { MaxClientService } from '../max/max-client.service';

const databaseUrl =
  process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ||
  process.env.MAXIM_TEST_POSTGRES_URL?.trim() ||
  '';
const native = databaseUrl ? describe : describe.skip;
native('network statistics native PostgreSQL observation and read boundaries', () => {
  let db: PrismaClient;
  let observations: NetworkStatisticsObservationService;
  let statistics: NetworkStatisticsService;
  let chatId: string;
  let postId: string;
  let version: string;
  const actor = { userId: 'network-statistics-native-actor', username: null, displayName: null };
  const authorize: jest.MockedFunction<ManagedEntitiesService['assertManagedEntityReadAccess']> =
    jest.fn();
  const resolveSelection: jest.MockedFunction<ManagedEntityNetworksService['resolveSelection']> =
    jest.fn();
  const base = () => new Date(Date.now() - 2 * 3600_000);
  const write = (views: number, at: Date) =>
    db.$transaction((tx) => observations.views(tx, postId, views, at, 'native'));
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 5, statement_timeout: 15000 }),
    });
    observations = new NetworkStatisticsObservationService(db as PrismaService);
    statistics = new NetworkStatisticsService(
      db as PrismaService,
      { assertManagedEntityReadAccess: authorize } as unknown as ManagedEntitiesService,
      { resolveSelection } as unknown as ManagedEntityNetworksService,
    );
  });
  beforeEach(async () => {
    chatId = `network-stats-${randomUUID()}`;
    version = randomUUID();
    await db.chat.create({ data: { id: chatId, title: 'Native channel', entityType: 'CHANNEL' } });
    const post = await db.channelPost.create({
      data: { chatId, messageId: 'old-post', publishedAt: new Date(Date.now() - 120 * 86400_000) },
    });
    postId = post.id;
    authorize.mockReset();
    authorize.mockImplementation(async (entityId, user, entityType) => {
      const userId = user.userId;
      const data = {
        entityType: entityType === 'chat' ? ('CHAT' as const) : ('CHANNEL' as const),
        state: 'GRANTED' as const,
        userRole: 'ADMIN' as const,
        botRole: 'ADMIN' as const,
        source: 'remote_admin_access',
        checkedAt: new Date(),
      };
      await db.managedEntityAccessEdge.upsert({
        where: { chatId_userId_botId: { chatId: entityId, userId, botId: 'native-major' } },
        create: { chatId: entityId, userId, botId: 'native-major', ...data },
        update: data,
      });
    });
    resolveSelection.mockReset();
    resolveSelection.mockImplementation(async () => ({
      entityIds: [chatId],
      compositionVersion: version,
      label: 'Важные',
    }));
  });
  afterEach(async () => {
    await db.chatMembershipActivityFeedItem.deleteMany({ where: { chatId } });
    await db.chatMembershipActivityRollup.deleteMany({ where: { chatId } });
    await db.chat.delete({ where: { id: chatId } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  it('baselines old posts, records unchanged coverage and serializes duplicate/reordered sources', async () => {
    const at = base();
    await write(500, at);
    const later = new Date(at.getTime() + 60_000);
    await Promise.all([write(520, later), write(520, later)]);
    await write(900, new Date(at.getTime() + 30_000));
    await write(520, new Date(later.getTime() + 60_000));
    const rows = await db.$queryRaw<
      Array<{ delta: bigint }>
    >`SELECT delta FROM channel_view_observed_intervals WHERE channel_post_id=${postId} ORDER BY to_at`;
    expect(rows.map((row) => Number(row.delta))).toEqual([20, 0]);
    await observations.audience(chatId, 'channel', 100, later, 'native');
    await observations.audience(chatId, 'channel', 900, at, 'native');
    const response = await statistics.read(actor, 'channel', {
      favoriteType: 'important',
      range: '7d',
    });
    expect(response.viewsGained?.value).toBe(20);
    expect(response.audience.value).toBe(100);
    expect(response.viewsGained?.coverage.status).toBe('partial');
    expect(response.viewsGained?.coverage.asOf).not.toBeNull();
    expect(authorize).toHaveBeenCalledWith(chatId, actor, 'channel', { timeoutMs: 2500 });
  });

  it('keeps absent membership observations null and only graphs retained observed net growth', async () => {
    await db.chat.update({ where: { id: chatId }, data: { entityType: 'CHAT' } });
    const missing = await statistics.read(actor, 'chat', {
      favoriteType: 'important',
      range: '30d',
    });
    expect(missing.items[0]?.netGrowth).toBeNull();
    expect(missing.netGrowth.value).toBeNull();
    expect(missing.netGrowth.coverage).toMatchObject({
      status: 'unavailable',
      includedEntities: 0,
      asOf: null,
      observedFrom: null,
    });
    expect(missing.series.every((point) => point.netGrowth === null)).toBe(true);
    const hour = Math.floor(Date.now() / 3600_000) * 3600_000;
    const first = new Date(hour - 2 * 86400_000);
    const last = new Date(hour - 86400_000);
    await db.chatMembershipActivityRollup.createMany({
      data: [
        { chatId, bucketStart: first, joinedUsers: 5, leftUsers: 2 },
        { chatId, bucketStart: last, joinedUsers: 1, leftUsers: 4 },
      ],
    });
    const observed = await statistics.read(actor, 'chat', {
      favoriteType: 'important',
      range: '30d',
    });
    expect(observed.items[0]?.netGrowth).toBe(0);
    expect(observed.netGrowth.value).toBe(0);
    expect(observed.netGrowth.coverage).toMatchObject({
      status: 'partial',
      includedEntities: 1,
      observedFrom: first.toISOString(),
      asOf: last.toISOString(),
    });
    expect(observed.series.some((point) => point.netGrowth === 3)).toBe(true);
    expect(observed.series.some((point) => point.netGrowth === -3)).toBe(true);
    expect(observed.series[0]?.netGrowth).toBeNull();
    expect(observed.series.at(-1)?.netGrowth).toBeNull();
    expect(observed.viewsGained).toBeNull();
  });

  it('keeps a first baseline unavailable and distinguishes an explicit unchanged successful interval', async () => {
    const at = new Date(
      Math.floor((Date.now() - 2 * 3600_000) / 3600_000) * 3600_000 + 10 * 60_000,
    );
    await write(500, at);
    const baseline = await statistics.read(actor, 'channel', { favoriteType: 'important' });
    expect(baseline.viewsGained?.value).toBeNull();
    expect(baseline.items[0]?.viewsGained).toBeNull();
    expect(baseline.viewsGained?.coverage).toMatchObject({
      status: 'unavailable',
      includedEntities: 0,
    });
    expect(baseline.series.every((point) => point.viewsGained === null)).toBe(true);
    await write(500, new Date(at.getTime() + 60_000));
    const unchanged = await statistics.read(actor, 'channel', { favoriteType: 'important' });
    expect(unchanged.viewsGained?.value).toBe(0);
    expect(unchanged.items[0]?.viewsGained).toBe(0);
    expect(unchanged.viewsGained?.coverage).toMatchObject({
      status: 'partial',
      includedEntities: 1,
    });
    expect(unchanged.series.some((point) => point.viewsGained === 0)).toBe(true);
  });

  it('does not turn a denial between a successful strict guard and proof capture into a grant', async () => {
    authorize.mockImplementation(async () => {
      await db.managedEntityAccessEdge.create({
        data: {
          chatId,
          userId: actor.userId,
          botId: 'native-major',
          entityType: 'CHANNEL',
          state: 'USER_DENIED',
          checkedAt: new Date(),
          source: 'remote_admin_access',
        },
      });
    });
    const response = await statistics.read(actor, 'channel', { favoriteType: 'important' });
    expect(response.authorization).toMatchObject({ allowed: 0, unavailable: 1 });
    expect(response.items).toEqual([]);
  });

  it('retains corrections and gaps without negative or repeated rebound views', async () => {
    const at = new Date(Date.now() - 5 * 3600_000);
    for (const [minutes, views] of [
      [0, 100],
      [1, 80],
      [2, 100],
      [3, 110],
      [185, 130],
    ])
      await write(views, new Date(at.getTime() + minutes * 60_000));
    const rows = await db.$queryRaw<
      Array<{ delta: bigint; quality: string }>
    >`SELECT delta,quality FROM channel_view_observed_intervals WHERE channel_post_id=${postId} ORDER BY to_at`;
    expect(rows.map((row) => Number(row.delta))).toEqual([0, 0, 10, 20]);
    expect(rows.map((row) => row.quality)).toEqual(['correction', 'correction', 'ready', 'gap']);
    const response = await statistics.read(actor, 'channel', {
      favoriteType: 'important',
      range: '7d',
    });
    expect(response.viewsGained?.value).toBe(30);
    expect(response.unallocatedViews).toBeGreaterThanOrEqual(20);
    expect(response.series.some((point) => point.viewsGained === null)).toBe(true);
  });

  it('does not expose denied entities or let a cursor cross actor/type/composition', async () => {
    authorize.mockRejectedValue(new ForbiddenException());
    const response = await statistics.read(actor, 'channel', { favoriteType: 'important' });
    expect(response.items).toEqual([]);
    expect(response.audience.value).toBeNull();
    expect(response.authorization.denied).toBe(1);
    await expect(
      statistics.read(actor, 'chat', { favoriteType: 'important', cursor: randomUUID() }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('runs no more than two strict checks at a time and discards changed composition before data', async () => {
    let active = 0;
    let maximum = 0;
    resolveSelection.mockResolvedValue({
      entityIds: Array.from({ length: 10 }, (_, index) => `${chatId}-${index}`),
      compositionVersion: version,
      label: 'Важные',
    });
    authorize.mockImplementation(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((done) => setImmediate(done));
      active -= 1;
      throw new ForbiddenException();
    });
    const first = await statistics.read(actor, 'channel', { favoriteType: 'important' });
    expect(maximum).toBe(2);
    expect(first.authorization.checked).toBe(8);
    expect(first.nextCursor).not.toBeNull();
    await expect(
      statistics.read({ ...actor, userId: 'another' }, 'channel', {
        favoriteType: 'important',
        cursor: first.nextCursor,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    version = randomUUID();
    resolveSelection.mockResolvedValue({
      entityIds: Array.from({ length: 10 }, (_, index) => `${chatId}-${index}`),
      compositionVersion: version,
      label: 'Важные',
    });
    await expect(
      statistics.read(actor, 'channel', { favoriteType: 'important', cursor: first.nextCursor }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('advances a bounded archive page without a publication-age cutoff and keeps first observations baseline-only', async () => {
    const parser = Object.create(MaxClientService.prototype) as MaxClientService;
    const raw = {
      body: { mid: 'old-post' },
      timestamp: new Date(Date.now() - 120 * 86400_000).toISOString(),
      stat: { views: 700 },
    };
    const listMessages: jest.MockedFunction<MaxClientService['listMessages']> = jest
      .fn()
      .mockResolvedValue([raw]);
    const max: Pick<MaxClientService, 'listMessages' | 'parseChannelMessageSnapshot'> = {
      listMessages,
      parseChannelMessageSnapshot: parser.parseChannelMessageSnapshot.bind(parser),
    };
    await observations.archivePage(chatId, 'native', max as unknown as MaxClientService, {
      store: async (snapshot, at) => {
        await write(snapshot.views!, at);
      },
    });
    const state = await db.$queryRaw<
      Array<{ discovery_complete_at: Date | null; cursor_at: Date | null }>
    >`SELECT discovery_complete_at,cursor_at FROM channel_view_archive_states WHERE chat_id=${chatId}`;
    expect(state[0].discovery_complete_at).not.toBeNull();
    expect(state[0].cursor_at).toBeNull();
    expect(
      await db.$queryRaw<
        Array<{ delta: bigint }>
      >`SELECT delta FROM channel_view_observed_intervals WHERE channel_post_id=${postId}`,
    ).toEqual([]);
    expect(listMessages.mock.calls[0][1]).toMatchObject({ count: 100, to: new Date(0) });
  });

  it('shares the two strict authorization slots across six concurrent category generations', async () => {
    const favorites = ['important', 'watch', 'broadcast', 'test', 'partner', 'service'] as const;
    const idsByFavorite = new Map(
      favorites.map((favorite) => [
        favorite,
        Array.from({ length: 2 }, (_, index) => `${chatId}-${favorite}-${index}`),
      ]),
    );
    const ids = [...idsByFavorite.values()].flat();
    await db.chat.createMany({
      data: ids.map((id) => ({ id, title: 'Concurrent category', entityType: 'CHANNEL' as const })),
    });
    const original = authorize.getMockImplementation()!;
    let active = 0;
    let maximum = 0;
    authorize.mockImplementation(async (...args) => {
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        await new Promise<void>((done) => setImmediate(done));
        await original(...args);
      } finally {
        active -= 1;
      }
    });
    resolveSelection.mockImplementation(async (_user, _entityType, favoriteType) => ({
      entityIds: idsByFavorite.get(favoriteType) ?? [],
      compositionVersion: version,
      label: favoriteType,
    }));
    try {
      const responses = await Promise.all(
        favorites.map((favoriteType) => statistics.read(actor, 'channel', { favoriteType })),
      );
      expect(maximum).toBe(2);
      expect(active).toBe(0);
      expect(responses).toHaveLength(6);
      expect(
        responses.every(
          (response) =>
            response.authorization.checked === 2 &&
            response.authorization.allowed === 2 &&
            response.authorization.denied === 0 &&
            response.authorization.unavailable === 0,
        ),
      ).toBe(true);
    } finally {
      await db.chat.deleteMany({ where: { id: { in: ids } } });
    }
  });

  it('rejects a previous strict proof after a bot/actor denial before another progressive response', async () => {
    const ids = [chatId, ...Array.from({ length: 8 }, (_, index) => `${chatId}-${index}`)];
    await db.chat.createMany({
      data: ids
        .slice(1)
        .map((id) => ({ id, title: 'Sibling native', entityType: 'CHANNEL' as const })),
    });
    try {
      await db.managedEntityAccessEdge.create({
        data: {
          chatId,
          userId: actor.userId,
          botId: 'native-major',
          entityType: 'CHANNEL',
          state: 'GRANTED',
          userRole: 'ADMIN',
          botRole: 'ADMIN',
        },
      });
      resolveSelection.mockResolvedValue({
        entityIds: ids,
        compositionVersion: version,
        label: 'Важные',
      });
      const first = await statistics.read(actor, 'channel', { favoriteType: 'important' });
      expect(first.nextCursor).not.toBeNull();
      await db.managedEntityAccessEdge.update({
        where: { chatId_userId_botId: { chatId, userId: actor.userId, botId: 'native-major' } },
        data: { state: 'USER_DENIED' },
      });
      await expect(
        statistics.read(actor, 'channel', { favoriteType: 'important', cursor: first.nextCursor }),
      ).rejects.toBeInstanceOf(ConflictException);
    } finally {
      await db.chat.deleteMany({ where: { id: { in: ids.slice(1) } } });
    }
  });

  it('keeps current audience available when a collector advances it between progressive batches', async () => {
    const ids = [chatId, ...Array.from({ length: 8 }, (_, index) => `${chatId}-${index}`)];
    await db.chat.createMany({
      data: ids
        .slice(1)
        .map((id) => ({ id, title: 'Sibling native', entityType: 'CHANNEL' as const })),
    });
    try {
      resolveSelection.mockResolvedValue({
        entityIds: ids,
        compositionVersion: version,
        label: 'Важные',
      });
      await observations.audience(chatId, 'channel', 100, new Date(Date.now() - 60_000), 'native');
      const first = await statistics.read(actor, 'channel', { favoriteType: 'important' });
      expect(first.audience.value).toBe(100);
      const updatedAt = new Date();
      await observations.audience(chatId, 'channel', 125, updatedAt, 'native');
      const next = await statistics.read(actor, 'channel', {
        favoriteType: 'important',
        cursor: first.nextCursor,
      });
      expect(next.audience.value).toBe(125);
      expect(next.items.find((item) => item.entityId === chatId)?.audience).toBe(125);
      expect(new Date(next.period.to).getTime()).toBeGreaterThanOrEqual(updatedAt.getTime());
    } finally {
      await db.chat.deleteMany({ where: { id: { in: ids.slice(1) } } });
    }
  });

  it('bounds a thirty-day interval query with a year of history and a much larger unrelated channel', async () => {
    const otherChatId = `${chatId}-history-skew`;
    const anchor = new Date(Math.floor(Date.now() / 3600_000) * 3600_000);
    await db.chat.create({
      data: { id: otherChatId, title: 'History skew', entityType: 'CHANNEL' },
    });
    try {
      const otherPost = await db.channelPost.create({
        data: {
          chatId: otherChatId,
          messageId: 'history-skew',
          publishedAt: new Date(anchor.getTime() - 400 * 86400_000),
        },
      });
      await db.channelPost.update({
        where: { id: postId },
        data: { publishedAt: new Date(anchor.getTime() - 400 * 86400_000) },
      });
      await db.$executeRaw`
        INSERT INTO channel_view_observed_intervals(channel_post_id,chat_id,from_at,to_at,delta,quality,source)
        SELECT ${postId},${chatId},${anchor}::timestamptz-(n+1)*interval '1 hour',
          ${anchor}::timestamptz-n*interval '1 hour',1,'ready','native-load'
        FROM generate_series(1,365*24) AS n
      `;
      await db.$executeRaw`
        INSERT INTO channel_view_observed_intervals(channel_post_id,chat_id,from_at,to_at,delta,quality,source)
        SELECT ${otherPost.id},${otherChatId},${anchor}::timestamptz-(n+1)*interval '1 minute',
          ${anchor}::timestamptz-n*interval '1 minute',1000,'ready','native-load'
        FROM generate_series(1,120000) AS n
      `;
      await db.$executeRaw`ANALYZE channel_view_observed_intervals`;
      const from = new Date(anchor.getTime() - 30 * 86400_000);
      const query = networkViewIntervalsSql([chatId], from, anchor, 'day');
      const rows = await db.$queryRaw<Array<{ value: bigint }>>(query);
      expect(rows.reduce((sum, row) => sum + Number(row.value), 0)).toBe(719);
      type PlanNode = {
        'Node Type': string;
        'Relation Name'?: string;
        'Index Name'?: string;
        'Actual Rows'?: number;
        'Actual Loops'?: number;
        'Rows Removed by Filter'?: number;
        'Index Cond'?: string;
        Plans?: PlanNode[];
      };
      const explain = await db.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>>(
        Prisma.sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query}`,
      );
      const flatten = (node: PlanNode): PlanNode[] => [
        node,
        ...(node.Plans ?? []).flatMap(flatten),
      ];
      const nodes = flatten(explain[0]['QUERY PLAN'][0].Plan);
      const scans = nodes.filter(
        (node) => node['Relation Name'] === 'channel_view_observed_intervals',
      );
      expect(scans.length).toBeGreaterThan(0);
      expect(scans.every((node) => node['Node Type'] !== 'Seq Scan')).toBe(true);
      expect(
        nodes.some(
          (node) =>
            node['Index Name'] === 'channel_view_observed_intervals_chat_to_post_idx' &&
            node['Index Cond']?.includes('chat_id') &&
            node['Index Cond']?.includes('to_at'),
        ),
      ).toBe(true);
      expect(
        scans.reduce(
          (sum, node) =>
            sum +
            ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) *
              (node['Actual Loops'] ?? 1),
          0,
        ),
      ).toBeLessThanOrEqual(750);
      expect(nodes.some((node) => node['Relation Name'] === 'channel_posts')).toBe(false);
    } finally {
      await db.chat.delete({ where: { id: otherChatId } });
    }
  }, 30_000);
});
