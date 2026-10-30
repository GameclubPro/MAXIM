import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type {
  StatsEntity,
  StatsMetricKey,
  StatsReachValue,
} from '@maxim/contracts/statistics-central';
import { PrismaClient, createPrismaAdapter, type Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { NetworkStatisticsObservationService } from '../admin/network-statistics-observation.service';
import { MarketplaceNativeProjectionService } from '../integrations/marketplace/marketplace-native-projection.service';
import { WebhookService } from '../webhook/webhook.service';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import { selectChannelStatsContentBucketRows } from '../admin/stats-read-model-selectors';
import { toSafeInteger } from '../admin/admin-statistics-values';
import { historyRow, selectStats, summarizeStats } from './stats-selector';
import { MaximNativeStatsAdapter } from './maxim-native-stats.adapter';
import type { StatsCandidate } from './stats-types';

const databaseUrl =
  process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ||
  process.env.MAXIM_TEST_POSTGRES_URL?.trim() ||
  '';
const native = databaseUrl ? describe : describe.skip;
const DAY_MS = 86_400_000;
const scopes: StatsMetricKey[] = [
  { metric: 'AUDIENCE', horizon: 0, method: { id: 'AUDIENCE_SNAPSHOT', version: 1 } },
  { metric: 'REACH', horizon: 0, method: { id: 'POST_PUBLICATION_DAY', version: 1 } },
  { metric: 'REACH', horizon: 24, method: { id: 'TIMED_POST_PUBLICATION_DAY', version: 1 } },
  { metric: 'REACH', horizon: 48, method: { id: 'TIMED_POST_PUBLICATION_DAY', version: 1 } },
  { metric: 'PUBLICATION_HOUR', horizon: 0, method: { id: 'PUBLICATION_DAY_HOURS', version: 1 } },
];
const day = (at: Date) => at.toISOString().slice(0, 10);

native('central statistics native adapters and transactional hooks with PostgreSQL', () => {
  let db: PrismaClient;
  let adapter: MaximNativeStatsAdapter;
  let observation: NetworkStatisticsObservationService;
  let entity: StatsEntity;
  let publishedAt: Date;
  let previousEnabled: string | undefined;
  let previousMode: string | undefined;
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 4, statement_timeout: 15_000 }),
    });
    adapter = new MaximNativeStatsAdapter(db as PrismaService);
    observation = new NetworkStatisticsObservationService(db as PrismaService);
  });
  beforeEach(async () => {
    previousEnabled = process.env.STATISTICS_CENTRAL_ENABLED;
    previousMode = process.env.STATISTICS_CENTRAL_MODE;
    process.env.STATISTICS_CENTRAL_ENABLED = 'true';
    process.env.STATISTICS_CENTRAL_MODE = 'CENTRAL';
    entity = {
      kind: 'CHANNEL',
      maxId: `-${BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 15)}`) + 1n}`,
    };
    publishedAt = new Date(Date.now() - 3 * DAY_MS);
    publishedAt.setUTCHours(12, 0, 0, 0);
    await db.chat.create({
      data: { id: entity.maxId, title: 'Native adapter', entityType: 'CHANNEL' },
    });
  });
  afterEach(async () => {
    if (previousEnabled === undefined) delete process.env.STATISTICS_CENTRAL_ENABLED;
    else process.env.STATISTICS_CENTRAL_ENABLED = previousEnabled;
    if (previousMode === undefined) delete process.env.STATISTICS_CENTRAL_MODE;
    else process.env.STATISTICS_CENTRAL_MODE = previousMode;
    await db.$executeRaw`DELETE FROM stats_changes WHERE entity_id IN
      (SELECT id FROM stats_entities WHERE kind=${entity.kind} AND max_id=${entity.maxId})`;
    await db.$executeRaw`DELETE FROM stats_measurements WHERE entity_id IN
      (SELECT id FROM stats_entities WHERE kind=${entity.kind} AND max_id=${entity.maxId})`;
    await db.$executeRaw`DELETE FROM stats_entities WHERE kind=${entity.kind} AND max_id=${entity.maxId}`;
    await db.$executeRaw`DELETE FROM marketplace_post_samples WHERE binding_id IN
      (SELECT id FROM marketplace_bindings WHERE entity_id=${entity.maxId})`;
    await db.$executeRaw`DELETE FROM marketplace_bindings WHERE entity_id=${entity.maxId}`;
    await db.chatMembershipActivityFeedItem.deleteMany({ where: { chatId: entity.maxId } });
    await db.chatMembershipActivityRollup.deleteMany({ where: { chatId: entity.maxId } });
    await db.chatMembershipActivityEvent.deleteMany({ where: { chatId: entity.maxId } });
    await db.chat.delete({ where: { id: entity.maxId } });
  });
  afterAll(async () => db?.$disconnect());

  const read = () => adapter.read(entity, scopes, day(publishedAt), day(publishedAt));
  const reach = (rows: StatsCandidate[], horizon: number) =>
    rows.find((row) => row.scope.metric === 'REACH' && row.scope.horizon === horizon)!;
  const completeArchive = async () => {
    const at = new Date(Date.now() - 1000);
    await db.channelViewArchiveState.create({
      data: { chatId: entity.maxId, discoveryCompleteAt: at, fullRefreshAt: at, lastSuccessAt: at },
    });
  };

  it('keeps measured zero, missing counters and actual 24/48 observations independent in UTC', async () => {
    await db.channelPost.create({
      data: {
        chatId: entity.maxId,
        messageId: 'missing-current',
        publishedAt,
        viewsAt24h: 10,
        viewsAt24hCapturedAt: new Date(publishedAt.getTime() + DAY_MS + 5 * 60_000),
        viewsAt48h: 999,
        viewsAt48hCapturedAt: new Date(publishedAt.getTime() + 2 * DAY_MS + 16 * 60_000),
      },
    });
    const second = new Date(publishedAt.getTime() + 3_600_000);
    await db.channelPost.create({
      data: {
        chatId: entity.maxId,
        messageId: 'measured-zero',
        publishedAt: second,
        latestViews: 0,
        latestSnapshotAt: new Date(Date.now() - 1000),
        viewsAt24h: 0,
        viewsAt24hCapturedAt: new Date(second.getTime() + DAY_MS),
      },
    });
    await db.channelAudienceSnapshot.create({
      data: { chatId: entity.maxId, participantsCount: 0, capturedAt: publishedAt },
    });
    await completeArchive();
    const rows = await read();
    expect(reach(rows, 0).value).toMatchObject({ views: '0', samples: 1, posts: 2 });
    expect(reach(rows, 0).coverage.state).toBe('PARTIAL');
    expect(reach(rows, 24).value).toMatchObject({ views: '10', samples: 2, posts: 2 });
    expect(reach(rows, 24).coverage.state).toBe('COMPLETE');
    expect(reach(rows, 24).health.lastSuccessAt).toBe(
      new Date(second.getTime() + DAY_MS).toISOString(),
    );
    expect(reach(rows, 48).value).toMatchObject({ views: null, samples: 0, posts: 2 });
    expect(reach(rows, 48).health).toMatchObject({ state: 'ERROR', errorCode: 'MISSED_HORIZON' });
    expect(rows.find((row) => row.scope.metric === 'AUDIENCE')?.value).toMatchObject({ value: 0 });
    const publication = rows.find((row) => row.scope.metric === 'PUBLICATION_HOUR')!;
    expect(publication.value).toMatchObject({
      hours: Array.from({ length: 24 }, (_, hour) => (hour === 12 || hour === 13 ? 1 : 0)),
    });
    expect(rows.every((row) => row.producer === 'MAXIM')).toBe(true);
  });

  it('deduplicates several native bots and keeps exact bigint numerators', async () => {
    for (const actor of ['actor-a', 'actor-b']) {
      const id = randomUUID();
      await db.$executeRaw`INSERT INTO marketplace_bindings
        (id,actor_user_id,entity_id,kind,profile,bot_id,state,metadata)
        VALUES(${id}::uuid,${actor},${entity.maxId},'CHANNEL','moderation',${actor},'UNKNOWN','{}'::jsonb)`;
      await db.$executeRaw`INSERT INTO marketplace_post_samples(binding_id,message_id,published_at,views,observed_at)
        VALUES(${id}::uuid,'same-post',${publishedAt},2147483647,${new Date(Date.now() - 1000)})`;
    }
    const first = await db.channelPost.create({
      data: {
        chatId: entity.maxId,
        messageId: 'same-post',
        publishedAt,
        latestViews: 2147483647,
        latestSnapshotAt: new Date(Date.now() - 2000),
      },
    });
    const second = await db.channelPost.create({
      data: {
        chatId: entity.maxId,
        messageId: 'different-post',
        publishedAt,
        latestViews: 2147483647,
        latestSnapshotAt: new Date(Date.now() - 2000),
      },
    });
    const current = reach(await read(), 0).value as StatsReachValue;
    expect(current).toMatchObject({ views: '4294967294', samples: 2, posts: 2 });
    for (const post of [first, second]) {
      await db.channelPostViewSnapshot.create({
        data: { channelPostId: post.id, views: 0, capturedAt: publishedAt },
      });
      await db.channelPostViewSnapshot.create({
        data: {
          channelPostId: post.id,
          views: 2147483647,
          capturedAt: new Date(publishedAt.getTime() + 1000),
        },
      });
    }
    const buckets = await db.$queryRaw<
      Array<{
        views_total: number;
        views_delta: number;
        views_total_exact: bigint;
        views_delta_exact: bigint;
      }>
    >`
      SELECT views_total,views_delta,views_total_exact,views_delta_exact FROM channel_stats_bucket_rollups WHERE chat_id=${entity.maxId}`;
    expect(buckets).toEqual([
      {
        views_total: 2147483647,
        views_delta: 2147483647,
        views_total_exact: 4294967294n,
        views_delta_exact: 4294967294n,
      },
    ]);
    const start = new Date(`${day(publishedAt)}T00:00:00.000Z`);
    const selected = await selectChannelStatsContentBucketRows(db as PrismaService, {
      chatId: entity.maxId,
      from: start,
      to: new Date(start.getTime() + DAY_MS),
      bucket: 'day',
    });
    expect(selected).toHaveLength(1);
    expect(toSafeInteger(selected[0].views_delta)).toBe(4294967294);
  });

  it('includes latest-only observations advanced between transaction start and its snapshot', async () => {
    const old = new Date(Date.now() - 1000);
    await db.managedEntityAudienceObservation.create({
      data: {
        chatId: entity.maxId,
        entityType: 'CHANNEL',
        participantsCount: 10,
        observedAt: old,
        source: 'major',
      },
    });
    await db.channelPost.create({
      data: {
        chatId: entity.maxId,
        messageId: 'snapshot-race',
        publishedAt,
        latestViews: 5,
        latestSnapshotAt: old,
      },
    });
    let advancedAt: Date | undefined;
    const racingAdapter = new MaximNativeStatsAdapter({
      $transaction: (
        work: (tx: Prisma.TransactionClient) => Promise<StatsCandidate[]>,
        options: { isolationLevel: 'RepeatableRead'; timeout: number },
      ) =>
        db.$transaction(async (tx) => {
          // The transaction has begun, but its RepeatableRead snapshot has not.
          await db.$queryRaw`SELECT 1 AS waited FROM pg_sleep(0.02)`;
          advancedAt = new Date();
          await db.managedEntityAudienceObservation.update({
            where: { chatId_entityType: { chatId: entity.maxId, entityType: 'CHANNEL' } },
            data: { participantsCount: 34, observedAt: advancedAt },
          });
          await db.channelPost.update({
            where: { chatId_messageId: { chatId: entity.maxId, messageId: 'snapshot-race' } },
            data: { latestViews: 17, latestSnapshotAt: advancedAt },
          });
          return work(tx);
        }, options),
    } as unknown as PrismaService);
    const rows = await racingAdapter.read(entity, scopes, day(publishedAt), day(new Date()));
    expect(rows.find((row) => row.scope.metric === 'AUDIENCE')?.value).toEqual({
      value: 34,
      observedAt: advancedAt!.toISOString(),
    });
    expect(reach(rows, 0).value).toMatchObject({ views: '17', samples: 1, posts: 1 });
  });

  it('isolates an unrepresentable native day to its metric and permits a valid alternate source', async () => {
    const observedAt = new Date(Date.now() - 1000);
    const earlier = new Date(publishedAt.getTime() - DAY_MS);
    for (const [bucketStart, joinedUsers] of [
      [publishedAt, 2147483647],
      [new Date(publishedAt.getTime() + 3_600_000), 2147483647],
      [earlier, 3],
    ] as const) {
      await db.chatMembershipActivityRollup.create({
        data: {
          chatId: entity.maxId,
          bucketStart,
          joinedUsers,
          leftUsers: 1,
          updatedAt: observedAt,
        },
      });
    }
    await db.channelAudienceSnapshot.create({
      data: { chatId: entity.maxId, participantsCount: 42, capturedAt: publishedAt },
    });
    await db.channelPost.create({
      data: {
        chatId: entity.maxId,
        messageId: 'numeric-isolation',
        publishedAt,
        latestViews: 5,
        latestSnapshotAt: observedAt,
        viewsAt24h: 4,
        viewsAt24hCapturedAt: new Date(publishedAt.getTime() + DAY_MS),
        viewsAt48h: 5,
        viewsAt48hCapturedAt: new Date(publishedAt.getTime() + 2 * DAY_MS),
      },
    });
    await completeArchive();
    const rows = await adapter.read(
      entity,
      [
        ...scopes,
        { metric: 'MEMBERSHIP', horizon: 0, method: { id: 'OBSERVED_MEMBER_EVENTS', version: 1 } },
        { metric: 'REACH', horizon: 0, method: { id: 'RECENT_POST_SAMPLE_20', version: 1 } },
      ],
      day(earlier),
      day(new Date()),
    );
    const failed = rows.find(
      (row) => row.scope.metric === 'MEMBERSHIP' && row.scope.day === day(publishedAt),
    )!;
    expect(failed.unavailableReason).toBe('NUMERIC_LIMIT');
    expect(historyRow(failed.scope, failed)).toMatchObject({
      state: 'UNKNOWN',
      reason: 'NUMERIC_LIMIT',
    });
    const summary = summarizeStats(
      selectStats(rows),
      7,
      'CHANNEL',
      ['AUDIENCE', 'MEMBERSHIP', 'REACH', 'PUBLICATION_HOUR'],
      [0, 24, 48],
    );
    expect(summary.membership).toMatchObject({ state: 'UNAVAILABLE', reason: 'NUMERIC_LIMIT' });
    expect(summary.audience).toMatchObject({ state: 'AVAILABLE', value: { value: 42 } });
    expect(summary.reach.current).toMatchObject({ state: 'AVAILABLE', value: { views: '5' } });
    expect(summary.reach.at24h).toMatchObject({ state: 'AVAILABLE', value: { views: '4' } });
    expect(summary.reach.at48h).toMatchObject({ state: 'AVAILABLE', value: { views: '5' } });
    expect(summary.recentPostSample).toMatchObject({
      state: 'AVAILABLE',
      value: { views: '5', samples: 1 },
    });
    expect(summary.publications.state).toBe('AVAILABLE');
    const fallback: StatsCandidate = {
      ...failed,
      unavailableReason: undefined,
      producer: 'EXCHANGE',
      value: {
        joined: 10,
        left: 2,
        observedFrom: observedAt.toISOString(),
        observedTo: observedAt.toISOString(),
      },
      coverage: { state: 'PARTIAL', intervals: [], populationComplete: false },
    };
    const replaced = summarizeStats(
      selectStats([...rows, fallback]),
      7,
      'CHANNEL',
      ['MEMBERSHIP'],
      [0],
    );
    expect(replaced.membership).toMatchObject({
      state: 'AVAILABLE',
      value: { joined: 13, left: 3 },
    });
  });

  it('preserves a microsecond gap in native SQL discovery proofs instead of proving empty population', async () => {
    const first = randomUUID(),
      second = randomUUID();
    const d = day(publishedAt);
    const end = new Date(Date.parse(`${d}T00:00:00Z`) + DAY_MS).toISOString();
    await db.$executeRaw`INSERT INTO marketplace_bindings
      (id,actor_user_id,entity_id,kind,profile,bot_id,state,metadata,history_complete,history_from,history_to)
      VALUES(${first}::uuid,'micro-a',${entity.maxId},'CHANNEL','moderation','micro-a','UNKNOWN','{}'::jsonb,true,${`${d}T00:00:00Z`}::timestamptz,${`${d}T12:00:00Z`}::timestamptz),
      (${second}::uuid,'micro-b',${entity.maxId},'CHANNEL','moderation','micro-b','UNKNOWN','{}'::jsonb,true,${`${d}T12:00:00.000001Z`}::timestamptz,${end}::timestamptz)`;
    expect(
      await adapter.read(
        entity,
        scopes.filter((scope) => scope.metric === 'PUBLICATION_HOUR'),
        d,
        d,
      ),
    ).toEqual([]);
    await db.$executeRaw`UPDATE marketplace_bindings SET history_from=${`${d}T12:00:00Z`}::timestamptz WHERE id=${second}::uuid`;
    const complete = await adapter.read(
      entity,
      scopes.filter((scope) => scope.metric === 'PUBLICATION_HOUR'),
      d,
      d,
    );
    expect(complete).toHaveLength(1);
    expect(complete[0]!.coverage).toMatchObject({ state: 'COMPLETE', populationComplete: true });
    expect(complete[0]!.value).toMatchObject({ hours: Array(24).fill(0) });
  });
  it('requires complete scan proof before filling an absent day or hour with zero', async () => {
    expect(await read()).toEqual([]);
    await db.channelPost.create({
      data: { chatId: entity.maxId, messageId: 'unknown-views', publishedAt },
    });
    const partial = await read();
    expect(reach(partial, 0).value).toMatchObject({ views: null, samples: 0, posts: 1 });
    expect(partial.find((row) => row.scope.metric === 'PUBLICATION_HOUR')?.value).toMatchObject({
      hours: Array.from({ length: 24 }, (_, hour) => (hour === 12 ? 1 : null)),
    });
    await db.channelPost.deleteMany({ where: { chatId: entity.maxId } });
    await completeArchive();
    const empty = await read();
    expect(reach(empty, 24).value).toMatchObject({ views: '0', samples: 0, posts: 0 });
    expect(empty.find((row) => row.scope.metric === 'PUBLICATION_HOUR')?.value).toMatchObject({
      hours: Array(24).fill(0),
    });
  });

  it('rejects conflicting publication identities beyond the requested day without proving a zero', async () => {
    const bindingId = randomUUID();
    await db.$executeRaw`INSERT INTO marketplace_bindings
      (id,actor_user_id,entity_id,kind,profile,bot_id,state,metadata)
      VALUES(${bindingId}::uuid,'native-conflict',${entity.maxId},'CHANNEL','moderation','native','UNKNOWN','{}'::jsonb)`;
    await db.channelPost.create({
      data: {
        chatId: entity.maxId,
        messageId: 'cross-range',
        publishedAt,
        latestViews: 12,
        latestSnapshotAt: new Date(),
      },
    });
    await db.$executeRaw`INSERT INTO marketplace_post_samples(binding_id,message_id,published_at,views,observed_at)
      VALUES(${bindingId}::uuid,'cross-range',${new Date(publishedAt.getTime() - DAY_MS)},25,${new Date()})`;
    await completeArchive();
    expect(await read()).toEqual([]);
    const otherDay = new Date(publishedAt.getTime() - DAY_MS);
    expect(await adapter.read(entity, scopes, day(otherDay), day(otherDay))).toEqual([]);
  });

  it('invalidates a canonical membership source atomically once and rolls back its native rollup', async () => {
    const source = new WebhookService(
      db as PrismaService,
      new ConfigService(),
      {} as MaxBotLinkService,
    );
    const projection = {
      id: randomUUID(),
      dedupeKey: randomUUID(),
      chatId: entity.maxId,
      botId: 'native-member-source',
      eventType: 'user_added',
      userId: 'fixture-member',
      senderName: null,
      eventAt: publishedAt,
      createdAt: publishedAt,
    };
    try {
      await db.$transaction((tx) =>
        source['upsertMembershipActivityProjections'](tx, [projection]),
      );
      await db.$transaction((tx) =>
        source['upsertMembershipActivityProjections'](tx, [{ ...projection, id: randomUUID() }]),
      );
      const revision = () => db.$queryRaw<Array<{ data_revision: bigint }>>`
        SELECT data_revision FROM stats_entities WHERE kind=${entity.kind} AND max_id=${entity.maxId}`;
      expect((await revision())[0].data_revision).toBe(1n);
      const rows = await adapter.read(
        entity,
        [
          {
            metric: 'MEMBERSHIP',
            horizon: 0,
            method: { id: 'OBSERVED_MEMBER_EVENTS', version: 1 },
          },
        ],
        day(publishedAt),
        day(publishedAt),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toMatchObject({ joined: 1, left: 0 });
      const rolledBack = {
        ...projection,
        id: randomUUID(),
        dedupeKey: randomUUID(),
        eventType: 'user_removed',
      };
      await expect(
        db.$transaction(async (tx) => {
          await source['upsertMembershipActivityProjections'](tx, [rolledBack]);
          throw new Error('rollback membership source');
        }),
      ).rejects.toThrow('rollback membership source');
      expect((await revision())[0].data_revision).toBe(1n);
      expect(await db.chatMembershipActivityEvent.count({ where: { chatId: entity.maxId } })).toBe(
        1,
      );
      expect(
        await db.chatMembershipActivityFeedItem.count({ where: { chatId: entity.maxId } }),
      ).toBe(1);
      expect(
        await db.chatMembershipActivityRollup.findMany({ where: { chatId: entity.maxId } }),
      ).toEqual([expect.objectContaining({ joinedUsers: 1, leftUsers: 0 })]);
      const changes = await db.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS count FROM stats_changes WHERE entity_id IN
          (SELECT id FROM stats_entities WHERE kind=${entity.kind} AND max_id=${entity.maxId})`;
      expect(changes[0].count).toBe(1n);
    } finally {
      await source.onModuleDestroy();
    }
  });

  it('keeps new chat daily observations and invalidation atomic without creating bot bindings', async () => {
    entity.kind = 'CHAT';
    await db.chat.update({ where: { id: entity.maxId }, data: { entityType: 'CHAT' } });
    const yesterday = new Date(Date.now() - DAY_MS);
    const now = new Date(Date.now() - 1000);
    await observation.audience(entity.maxId, 'chat', 12, yesterday, 'presentation');
    await observation.audience(entity.maxId, 'chat', 0, now, 'presentation');
    await observation.audience(entity.maxId, 'chat', 0, now, 'presentation');
    await observation.audience(
      entity.maxId,
      'chat',
      99,
      new Date(now.getTime() - 1),
      'presentation',
    );
    const points = await db.$queryRaw<Array<{ day: Date; value: unknown }>>`
      SELECT day,value FROM stats_measurements WHERE entity_id IN
        (SELECT id FROM stats_entities WHERE kind='CHAT' AND max_id=${entity.maxId}) ORDER BY day`;
    expect(points).toHaveLength(2);
    expect(points.map((point) => point.value)).toEqual([
      { value: 12, observedAt: yesterday.toISOString() },
      { value: 0, observedAt: now.toISOString() },
    ]);
    const revision = await db.$queryRaw<Array<{ data_revision: bigint }>>`
      SELECT data_revision FROM stats_entities WHERE kind='CHAT' AND max_id=${entity.maxId}`;
    expect(revision[0].data_revision).toBe(2n);
    await expect(
      db.$transaction(async (tx) => {
        await observation.audience(
          entity.maxId,
          'chat',
          100,
          new Date(now.getTime() + 1),
          'presentation',
          tx,
        );
        throw new Error('rollback source transaction');
      }),
    ).rejects.toThrow('rollback source transaction');
    expect(
      (
        await db.managedEntityAudienceObservation.findUniqueOrThrow({
          where: { chatId_entityType: { chatId: entity.maxId, entityType: 'CHAT' } },
        })
      ).participantsCount,
    ).toBe(0);
    const changes = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM stats_changes WHERE entity_id IN
        (SELECT id FROM stats_entities WHERE kind='CHAT' AND max_id=${entity.maxId})`;
    expect(changes[0].count).toBe(2n);
    expect(await db.chatBotMembership.count({ where: { chatId: entity.maxId } })).toBe(0);
    expect(await db.marketplaceBinding.count({ where: { entityId: entity.maxId } })).toBe(0);
    expect(
      (await adapter.read(entity, scopes, day(yesterday), day(now))).every(
        (row) => row.scope.metric === 'AUDIENCE',
      ),
    ).toBe(true);
  });

  it('keeps hooks off before CENTRAL cutover and does not expose native history older than 90 UTC days', async () => {
    process.env.STATISTICS_CENTRAL_MODE = 'LEGACY';
    await observation.audience(entity.maxId, 'channel', 1, new Date(Date.now() - 1000), 'major');
    const central = await db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM stats_entities WHERE kind=${entity.kind} AND max_id=${entity.maxId}`;
    expect(central).toEqual([]);
    const old = new Date(Date.now() - 100 * DAY_MS);
    await db.channelAudienceSnapshot.create({
      data: { chatId: entity.maxId, capturedAt: old, participantsCount: 999 },
    });
    expect(await adapter.read(entity, scopes, day(old), day(old))).toEqual([]);
  });

  it('invalidates publication-only native writes without turning unknown views into measured zero', async () => {
    const binding = randomUUID();
    const lease = randomUUID();
    const checkedAt = new Date();
    await db.chatBotMembership.create({
      data: { chatId: entity.maxId, botId: 'native-central-bot', status: 'ACTIVE' },
    });
    await db.$executeRaw`INSERT INTO marketplace_bindings
      (id,actor_user_id,entity_id,kind,profile,bot_id,state,checked_at,valid_until,metadata,
        statistics_consent,lease_id,lease_until)
      VALUES(${binding}::uuid,'native-central-actor',${entity.maxId},'CHANNEL','moderation','native-central-bot',
        'ACTIVE',${checkedAt},now()+interval '5 minutes','{}'::jsonb,true,${lease}::uuid,now()+interval '2 minutes')`;
    await new MarketplaceNativeProjectionService(db as PrismaService).post(
      binding,
      lease,
      {
        chatId: entity.maxId,
        messageId: 'publication-only',
        publishedAt: publishedAt.toISOString(),
        publishedAtMs: publishedAt.getTime(),
        views: null,
        reactions: [],
        reactionsTotal: null,
        url: null,
        previewUrl: null,
      },
      checkedAt,
    );
    const changes = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM stats_changes WHERE entity_id IN
        (SELECT id FROM stats_entities WHERE kind=${entity.kind} AND max_id=${entity.maxId})`;
    expect(changes[0].count).toBe(1n);
    const rows = await read();
    expect(reach(rows, 0).value).toMatchObject({ views: null, samples: 0, posts: 1 });
    expect(rows.find((row) => row.scope.metric === 'PUBLICATION_HOUR')?.value).toMatchObject({
      hours: Array.from({ length: 24 }, (_, hour) => (hour === 12 ? 1 : null)),
    });
  });
});
