import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type {
  StatsAuthorityOperation,
  StatsEntity,
  StatsIngestRequest,
  StatsReadContext,
  StatsReplaceDay,
  StatsReachValue,
} from '@maxim/contracts/statistics-central';
import {
  statsHistoryResultSchema,
  statsSummaryResultSchema,
} from '@maxim/contracts/statistics-central-validation';
import { PrismaClient, createPrismaAdapter } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { StatsAccessService } from './stats-access.service';
import { StatsIngestService } from './stats-ingest.service';
import { StatsReadService } from './stats-read.service';
import { StatsChangesService } from './stats-changes.service';
import { MaximNativeStatsAdapter } from './maxim-native-stats.adapter';
import { allKeys, DAY_MS } from './stats-common';

const databaseUrl =
  process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ||
  process.env.MAXIM_TEST_POSTGRES_URL?.trim() ||
  '';
const native = databaseUrl ? describe : describe.skip;
native('central statistics PostgreSQL atomicity, authority and bounded reads', () => {
  let db: PrismaClient,
    config: ConfigService,
    access: StatsAccessService,
    ingest: StatsIngestService,
    read: StatsReadService,
    feed: StatsChangesService;
  let entity: StatsEntity,
    epoch: string,
    source: StatsAuthorityOperation,
    consumer: StatsAuthorityOperation,
    context: StatsReadContext;
  let sourceEpoch: string, consumerEpoch: string;
  const now = () => new Date().toISOString();
  const day = (offset = 0) => new Date(Date.now() - offset * DAY_MS).toISOString().slice(0, 10);
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 6, statement_timeout: 15_000 }),
    });
  });
  beforeEach(async () => {
    entity = {
      kind: 'CHANNEL',
      maxId: `-${BigInt('0x' + randomUUID().replaceAll('-', '').slice(0, 15)) + 1n}`,
    };
    epoch = randomUUID();
    config = new ConfigService({
      STATISTICS_CENTRAL_ENABLED: 'true',
      STATISTICS_CENTRAL_MODE: 'CENTRAL',
      STATISTICS_CENTRAL_EXCHANGE_EPOCH: epoch,
      SVYAZKA_ANALYTICS_TOKEN: 'a'.repeat(64),
    });
    access = new StatsAccessService(db as PrismaService, config);
    ingest = new StatsIngestService(db as PrismaService, access);
    read = new StatsReadService(
      db as PrismaService,
      access,
      new MaximNativeStatsAdapter(db as PrismaService),
      config,
    );
    feed = new StatsChangesService(db as PrismaService, config);
    source = {
      id: randomUUID(),
      revision: '1',
      operation: 'ATTEST',
      entity,
      role: 'SOURCE',
      actorMaxUserId: '323459159',
      botRef: 'exchangebot',
      consumer: 'EXCHANGE',
      purpose: 'OWNER_ANALYTICS',
      scopes: allKeys,
      checkedAt: now(),
      producerEpoch: epoch,
      localAccessFence: '2026-10-24 12:00:00.123456+00',
    };
    consumer = { ...source, id: randomUUID(), role: 'CONSUMER' };
    const result = await access.attest({
      contractVersion: 1,
      requestId: randomUUID(),
      operations: [source, consumer],
    });
    sourceEpoch = result.results[0]!.epoch;
    consumerEpoch = result.results[1]!.epoch;
    context = {
      contextId: randomUUID(),
      entity,
      actorMaxUserId: source.actorMaxUserId,
      purpose: 'OWNER_ANALYTICS',
      consumerAuthority: { id: consumer.id, epoch: consumerEpoch },
    };
  });
  afterEach(async () => {
    await db.chat.deleteMany({ where: { id: entity.maxId } });
    await db.$executeRaw`DELETE FROM stats_entities WHERE kind=${entity.kind} AND max_id=${entity.maxId}`;
    await db.$executeRaw`DELETE FROM stats_ingest_requests WHERE producer_epoch=${epoch}::uuid`;
  });
  afterAll(async () => db?.$disconnect());
  const audience = (revision: string, value: number, d = day()): StatsReplaceDay => ({
    operation: 'REPLACE_DAY',
    metric: 'AUDIENCE',
    horizon: 0,
    method: { id: 'AUDIENCE_SNAPSHOT', version: 1 },
    day: d,
    sourceRevision: revision,
    authority: { id: source.id, epoch: sourceEpoch },
    value: { value, observedAt: d === day() ? now() : `${d}T12:00:00Z` },
    coverage: { state: 'COMPLETE', intervals: [], populationComplete: true },
  });
  const request = (operations: StatsIngestRequest['operations']): StatsIngestRequest => ({
    contractVersion: 1,
    requestId: randomUUID(),
    producerEpoch: epoch,
    entity,
    operations,
  });
  const summary = () =>
    read.summaries({
      contractVersion: 1,
      contexts: [context],
      periods: [7],
      metrics: ['AUDIENCE', 'REACH', 'MEMBERSHIP', 'PUBLICATION_HOUR'],
      horizons: [0, 24, 48],
      cursor: null,
    });
  it('stores EXCHANGE-only identity without native Chat and retries exactly once even after authority renewal', async () => {
    const r = request([audience('1', 10)]);
    const accepted = await ingest.ingest(r);
    expect(await ingest.ingest(r)).toEqual(accepted);
    source = { ...source, revision: '2', localAccessFence: 'new-fence' };
    const renewed = await access.attest({
      contractVersion: 1,
      requestId: randomUUID(),
      operations: [source],
    });
    sourceEpoch = renewed.results[0]!.epoch;
    expect(await ingest.ingest(r)).toEqual(accepted);
    const result = await summary();
    expect(statsSummaryResultSchema.safeParse(result).success).toBe(true);
    const item = result.results[0]!;
    expect(item.status).toBe('READY');
    if (item.status === 'READY') {
      expect(item.summary.audience.state).toBe('AVAILABLE');
      if (item.summary.audience.state === 'AVAILABLE')
        expect(item.summary.audience.value.value).toBe(10);
    }
    expect(await db.chat.findUnique({ where: { id: entity.maxId } })).toBeNull();
    source = { ...source, revision: '3', operation: 'REVOKE' };
    await access.attest({ contractVersion: 1, requestId: randomUUID(), operations: [source] });
    await expect(ingest.ingest(r)).rejects.toMatchObject({
      response: { error: { code: 'FORBIDDEN' } },
    });
  });
  it('rolls back the entire request on equal-revision conflict and preserves complete values from newer partial attempts', async () => {
    const first = audience('1', 10);
    await ingest.ingest(request([first]));
    await expect(
      ingest.ingest(
        request([
          audience('2', 20, day(1)),
          {
            ...first,
            value: { value: 99, observedAt: (first.value as { observedAt: string }).observedAt },
          } as StatsReplaceDay,
        ]),
      ),
    ).rejects.toMatchObject({ response: { error: { code: 'REVISION_CONFLICT' } } });
    const previous = await db.$queryRaw<
      Array<{ n: bigint }>
    >`SELECT count(*) AS n FROM stats_measurements WHERE entity_id IN(SELECT id FROM stats_entities WHERE max_id=${entity.maxId})`;
    expect(previous[0]!.n).toBe(1n);
    const reach: StatsReplaceDay = {
      operation: 'REPLACE_DAY',
      metric: 'REACH',
      horizon: 0,
      method: { id: 'POST_PUBLICATION_DAY', version: 1 },
      day: day(1),
      sourceRevision: '3',
      authority: { id: source.id, epoch: sourceEpoch },
      coverage: { state: 'COMPLETE', intervals: [], populationComplete: true },
      value: {
        views: '100',
        samples: 10,
        posts: 10,
        observedFrom: now(),
        observedTo: now(),
        maxDelaySeconds: null,
      },
    };
    await ingest.ingest(request([reach]));
    const partial = {
      ...reach,
      sourceRevision: '4',
      coverage: { state: 'PARTIAL' as const, intervals: [], populationComplete: false },
      value: { ...reach.value, views: '1', samples: 1, posts: 10 },
    } as StatsReplaceDay;
    expect((await ingest.ingest(request([partial]))).results[0]!.status).toBe('SKIPPED_INCOMPLETE');
    const row = (
      await db.$queryRaw<
        Array<{ seen_revision: bigint; value_revision: bigint; value: StatsReachValue }>
      >`SELECT seen_revision,value_revision,value FROM stats_measurements WHERE entity_id IN(SELECT id FROM stats_entities WHERE max_id=${entity.maxId}) AND metric='REACH'`
    )[0]!;
    expect(row.seen_revision).toBe(4n);
    expect(row.value_revision).toBe(3n);
    expect(row.value.views).toBe('100');
    expect((await ingest.ingest(request([partial]))).results[0]!.status).toBe('DUPLICATE');
  });
  it('deduplicates membership across rebatching, accepts out-of-order events, and enforces day delete capture fence', async () => {
    const event = (capturedRevision: string) => ({
      eventId: randomUUID(),
      capturedRevision,
      eventType: 'JOIN' as const,
      eventAt: new Date(Date.now() - 1000).toISOString(),
      observedAt: now(),
    });
    const a = event('10'),
      b = event('5');
    const add = (events: (typeof a)[]) => ({
      operation: 'ADD_EVENTS' as const,
      metric: 'MEMBERSHIP' as const,
      horizon: 0 as const,
      method: { id: 'OBSERVED_MEMBER_EVENTS' as const, version: 1 as const },
      authority: { id: source.id, epoch: sourceEpoch },
      events,
    });
    await ingest.ingest(request([add([a])]));
    expect((await ingest.ingest(request([add([a, b])]))).results[0]!.acceptedEvents).toBe(1);
    const deletion = {
      operation: 'DELETE_DAY' as const,
      metric: 'MEMBERSHIP' as const,
      horizon: 0 as const,
      method: { id: 'OBSERVED_MEMBER_EVENTS' as const, version: 1 as const },
      authority: { id: source.id, epoch: sourceEpoch },
      day: day(),
      sourceRevision: '20',
    };
    await ingest.ingest(request([deletion]));
    expect((await ingest.ingest(request([add([event('19')])]))).results[0]!.status).toBe(
      'SUPERSEDED',
    );
    expect((await ingest.ingest(request([add([event('21')])]))).results[0]!.acceptedEvents).toBe(1);
    const row = (
      await db.$queryRaw<
        Array<{ value: { joined: number }; delete_fence: bigint }>
      >`SELECT value,delete_fence FROM stats_measurements WHERE entity_id IN(SELECT id FROM stats_entities WHERE max_id=${entity.maxId}) AND metric='MEMBERSHIP'`
    )[0]!;
    expect(row.value.joined).toBe(1);
    expect(row.delete_fence).toBe(20n);
    await expect(
      ingest.ingest(request([add([{ ...a, eventType: 'LEAVE' as 'JOIN' }])])),
    ).rejects.toMatchObject({ response: { error: { code: 'EVENT_CONFLICT' } } });
  });
  it('requires independent current source purpose and exact actor, scope and unexpired consumer proof', async () => {
    await ingest.ingest(request([audience('1', 20)]));
    const other = { ...context, actorMaxUserId: '999999999' };
    expect(
      (
        await read.summaries({
          contractVersion: 1,
          contexts: [other],
          periods: [7],
          metrics: ['AUDIENCE'],
          horizons: [0],
          cursor: null,
        })
      ).results[0]!.status,
    ).toBe('FORBIDDEN');
    const published = { ...consumer, id: randomUUID(), purpose: 'PUBLISHED_AGGREGATE' as const };
    const ar = await access.attest({
      contractVersion: 1,
      requestId: randomUUID(),
      operations: [published],
    });
    const publicContext = {
      ...context,
      purpose: published.purpose,
      consumerAuthority: { id: published.id, epoch: ar.results[0]!.epoch },
    };
    let res = await read.summaries({
      contractVersion: 1,
      contexts: [publicContext],
      periods: [7],
      metrics: ['AUDIENCE'],
      horizons: [0],
      cursor: null,
    });
    expect(res.results[0]!.status).toBe('READY');
    if (res.results[0]!.status === 'READY')
      expect(res.results[0]!.summary.audience.state).toBe('UNAVAILABLE');
    await access.attest({
      contractVersion: 1,
      requestId: randomUUID(),
      operations: [{ ...source, id: randomUUID(), purpose: 'PUBLISHED_AGGREGATE' }],
    });
    res = await read.summaries({
      contractVersion: 1,
      contexts: [publicContext],
      periods: [7],
      metrics: ['AUDIENCE'],
      horizons: [0],
      cursor: null,
    });
    if (res.results[0]!.status === 'READY')
      expect(res.results[0]!.summary.audience.state).toBe('AVAILABLE');
    await db.$executeRaw`UPDATE stats_authorities SET peer_valid_until=now()-interval '1 second' WHERE id=${consumer.id}::uuid`;
    expect((await summary()).results[0]!.status).toBe('FORBIDDEN');
  });
  it('paginates filtered history with explicit unknowns, same revision, and restart on change', async () => {
    await ingest.ingest(request([audience('1', 10, day(2)), audience('2', 12, day(1))]));
    const req = {
      contractVersion: 1 as const,
      contexts: [context],
      periodDays: 7 as const,
      metrics: ['AUDIENCE' as const],
      horizons: [0 as const],
      methods: ['AUDIENCE_SNAPSHOT' as const],
      rowLimit: 3,
      cursor: null as string | null,
    };
    const first = await read.history(req);
    expect(statsHistoryResultSchema.safeParse(first).success).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    expect(first.results[0]!.status === 'READY' && first.results[0]!.rows).toHaveLength(3);
    const second = await read.history({ ...req, cursor: first.nextCursor });
    expect(statsHistoryResultSchema.safeParse(second).success).toBe(true);
    await ingest.ingest(request([audience('3', 13)]));
    await expect(read.history({ ...req, cursor: first.nextCursor })).rejects.toMatchObject({
      response: { error: { code: 'READ_RESTART' } },
    });
  });
  it('keeps failure-only metric health separate and feeds only committed changes after HEAD', async () => {
    const head = await feed.changes('HEAD');
    await ingest.ingest(request([audience('1', 10)]));
    const before = await feed.changes(head.nextCursor);
    expect(before.items).toEqual([]);
    const at = new Date(Date.now() - 1000).toISOString();
    await ingest.ingest(
      request([
        {
          operation: 'REPORT_HEALTH',
          metric: 'REACH',
          horizon: 24,
          method: { id: 'TIMED_POST_PUBLICATION_DAY', version: 1 },
          sourceRevision: '1',
          authority: { id: source.id, epoch: sourceEpoch },
          health: {
            state: 'ERROR',
            lastAttemptAt: at,
            lastSuccessAt: null,
            nextExpectedAt: null,
            errorCode: 'MISSED_HORIZON',
          },
        },
      ]),
    );
    await feed.relay();
    const after = await feed.changes(head.nextCursor);
    expect(after.items.some((i) => i.action === 'REFRESH' && i.entity.maxId === entity.maxId)).toBe(
      true,
    );
    const result = await summary();
    if (result.results[0]!.status === 'READY') {
      const value = result.results[0]!.summary.audience;
      expect(value.state === 'AVAILABLE' && value.value.value).toBe(10);
    }
  });
  it('aggregates 90 actual PostgreSQL int64 day sums beyond int64 without unsafe integer casts', async () => {
    for (let offset = 0; offset < 90; offset += 30) {
      const operations: StatsIngestRequest['operations'] = Array.from(
        { length: Math.min(30, 90 - offset) },
        (_, i) => ({
          operation: 'REPLACE_DAY',
          metric: 'REACH',
          horizon: 0,
          method: { id: 'POST_PUBLICATION_DAY', version: 1 },
          day: day(offset + i),
          sourceRevision: String(offset + i + 1),
          authority: { id: source.id, epoch: sourceEpoch },
          coverage: { state: 'COMPLETE', intervals: [], populationComplete: true },
          value: {
            views: '4611686014132420609',
            samples: 2147483647,
            posts: 2147483647,
            observedFrom: now(),
            observedTo: now(),
            maxDelaySeconds: null,
          },
        }),
      );
      await ingest.ingest(request(operations));
    }
    const result = await read.summaries({
      contractVersion: 1,
      contexts: [context],
      periods: [90],
      metrics: ['REACH'],
      horizons: [0],
      cursor: null,
    });
    expect(statsSummaryResultSchema.safeParse(result).success).toBe(true);
    const item = result.results[0]!;
    expect(item.status).toBe('READY');
    if (item.status === 'READY') {
      expect(item.summary.reach.current.state).toBe('AVAILABLE');
      if (item.summary.reach.current.state === 'AVAILABLE')
        expect(item.summary.reach.current.value.views).toBe(
          (4611686014132420609n * 90n).toString(),
        );
    }
  });
  it('uses current durable exact native bot grants without granting another actor or promoting imported facts', async () => {
    await db.chat.create({
      data: { id: entity.maxId, title: 'Native current source', entityType: 'CHANNEL' },
    });
    for (const bot of ['native-a', 'native-b']) {
      await db.chatBotMembership.create({
        data: {
          chatId: entity.maxId,
          botId: bot,
          status: 'ACTIVE',
          botAccessState: 'CONFIRMED_ADMIN',
        },
      });
      await db.managedEntityAccessEdge.create({
        data: {
          chatId: entity.maxId,
          userId: source.actorMaxUserId,
          botId: bot,
          entityType: 'CHANNEL',
          state: 'GRANTED',
          userRole: 'ADMIN',
          botRole: 'ADMIN',
          checkedAt: new Date(Date.now() - 86_400_000),
        },
      });
    }
    await db.channelAudienceSnapshot.create({
      data: {
        chatId: entity.maxId,
        capturedAt: new Date(Date.now() - 1000),
        participantsCount: 44,
      },
    });
    await access.attest({
      contractVersion: 1,
      requestId: randomUUID(),
      operations: [{ ...consumer, checkedAt: now() }],
    });
    const old = audience('1', 40);
    if (
      old.operation === 'REPLACE_DAY' &&
      old.metric === 'AUDIENCE' &&
      old.method.id === 'AUDIENCE_SNAPSHOT'
    )
      old.value = { value: 40, observedAt: new Date(Date.now() - 5000).toISOString() };
    await ingest.ingest(request([old]));
    let result = await summary();
    if (result.results[0]!.status === 'READY') {
      const a = result.results[0]!.summary.audience;
      expect(a.state === 'AVAILABLE' && a.value.value).toBe(44);
      expect(a.state === 'AVAILABLE' && a.provenance.map((p) => p.producer)).toEqual(['MAXIM']);
    }
    await db.managedEntityAccessEdge.updateMany({
      where: { chatId: entity.maxId, userId: source.actorMaxUserId },
      data: { state: 'USER_DENIED', userRole: 'MEMBER' },
    });
    result = await summary();
    if (result.results[0]!.status === 'READY') {
      const a = result.results[0]!.summary.audience;
      expect(a.state === 'AVAILABLE' && a.value.value).toBe(40);
      expect(a.state === 'AVAILABLE' && a.provenance.map((p) => p.producer)).toEqual(['EXCHANGE']);
    }
    const facts = await db.$queryRaw<
      Array<{ producer: string }>
    >`SELECT DISTINCT producer FROM stats_measurements WHERE entity_id IN(SELECT id FROM stats_entities WHERE max_id=${entity.maxId})`;
    expect(facts.map((f) => f.producer)).toEqual(['EXCHANGE']);
  });

  it('reads network audience in bounded batches with a true snapshot and current rights after releasing pool connections', async () => {
    await db.chat.create({
      data: { id: entity.maxId, title: 'Network audience snapshot', entityType: 'CHANNEL' },
    });
    for (const bot of ['network-a', 'network-b']) {
      await db.chatBotMembership.create({
        data: {
          chatId: entity.maxId,
          botId: bot,
          status: 'ACTIVE',
          botAccessState: 'CONFIRMED_ADMIN',
        },
      });
      await db.managedEntityAccessEdge.create({
        data: {
          chatId: entity.maxId,
          userId: source.actorMaxUserId,
          botId: bot,
          entityType: 'CHANNEL',
          state: 'GRANTED',
          userRole: 'ADMIN',
          botRole: 'ADMIN',
          checkedAt: new Date(Date.now() - DAY_MS),
        },
      });
    }
    const observed = new Date(Date.now() - 60_000);
    await db.managedEntityAudienceObservation.create({
      data: {
        chatId: entity.maxId,
        entityType: 'CHANNEL',
        participantsCount: 41,
        observedAt: observed,
        source: 'native',
      },
    });
    const older = audience('1', 99);
    if (older.method.id === 'AUDIENCE_SNAPSHOT')
      older.value = { value: 99, observedAt: new Date(observed.getTime() - 1000).toISOString() };
    await ingest.ingest(request([older]));
    expect(
      (
        await read.localAudienceCurrent([entity, entity], source.actorMaxUserId, new Date())
      ).rows.map((row) => row.value),
    ).toEqual([41]);
    const newest = audience('2', 0);
    if (newest.method.id === 'AUDIENCE_SNAPSHOT')
      newest.value = { value: 0, observedAt: new Date(observed.getTime() + 1000).toISOString() };
    await ingest.ingest(request([newest]));
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const snapshots = await Promise.all(
      Array.from({ length: 6 }, () =>
        db.$transaction(
          async (tx) => {
            const result = await read.localAudienceCurrent(
              [entity],
              source.actorMaxUserId,
              new Date(),
              tx,
            );
            if (++arrivals === 6) release();
            await barrier;
            return result;
          },
          { isolationLevel: 'RepeatableRead', timeout: 10_000 },
        ),
      ),
    );
    await Promise.all(snapshots.map((snapshot) => snapshot.verifyAccess()));
    expect(snapshots.map((snapshot) => snapshot.rows.map((row) => row.value))).toEqual(
      Array.from({ length: 6 }, () => [0]),
    );
    const retained = await db.$transaction((tx) =>
      read.localAudienceCurrent([entity], source.actorMaxUserId, new Date(), tx),
    );
    await access.attest({
      contractVersion: 1,
      requestId: randomUUID(),
      operations: [{ ...source, operation: 'REVOKE', revision: '2', checkedAt: now() }],
    });
    await expect(retained.verifyAccess()).rejects.toMatchObject({
      response: { error: { code: 'READ_RESTART' } },
    });
    expect(
      (await read.localAudienceCurrent([entity], source.actorMaxUserId, new Date())).rows[0]?.value,
    ).toBe(41);
    expect((await read.localAudienceCurrent([entity], 'another-actor', new Date())).rows).toEqual(
      [],
    );
    const proof = jest.spyOn(access, 'nativeProofBatch');
    const missing: StatsEntity[] = Array.from({ length: 101 }, (_, index) => ({
      kind: 'CHAT',
      maxId: `-${999000000 + index}`,
    }));
    expect(
      (await read.localAudienceCurrent(missing, source.actorMaxUserId, new Date())).rows,
    ).toEqual([]);
    expect(proof.mock.calls.map((call) => call[1].length)).toEqual([100, 1, 100, 1]);
    proof.mockRestore();
  });

  it('rolls back a request when its finite source lease expires before the final commit fence', async () => {
    const actualNow = Date.now();
    const initial = access.assertSource.bind(access);
    const clock = jest.spyOn(Date, 'now');
    const check = jest.spyOn(access, 'assertSource').mockImplementation(async (...args) => {
      const proof = await initial(...args);
      clock.mockReturnValue(proof.peer_valid_until.getTime() + 1);
      return proof;
    });
    try {
      await expect(ingest.ingest(request([audience('1', 101)]))).rejects.toMatchObject({
        response: { error: { code: 'FORBIDDEN' } },
      });
    } finally {
      clock.mockRestore();
      check.mockRestore();
    }
    expect(Date.now()).toBeGreaterThanOrEqual(actualNow);
    const facts = await db.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT count(*) AS count FROM stats_measurements WHERE entity_id IN(SELECT id FROM stats_entities WHERE max_id=${entity.maxId})`;
    expect(facts[0]?.count).toBe(0n);
    await expect(ingest.ingest(request([audience('1', 101)]))).resolves.toHaveProperty('results');
  });

  it('rejects retired peer consumers as well as sources and marks their feed views revoked', async () => {
    await ingest.ingest(request([audience('1', 17)]));
    await feed.relay();
    config.set('STATISTICS_CENTRAL_EXCHANGE_EPOCH', randomUUID());
    const result = await summary();
    expect(result.results[0]?.status).toBe('FORBIDDEN');
    const changes = await feed.changes(undefined);
    expect(changes.items.length).toBeGreaterThan(0);
    expect(changes.items.every((item) => item.action === 'REVOKE')).toBe(true);
    await expect(ingest.ingest(request([audience('2', 18)]))).rejects.toMatchObject({
      response: { error: { code: 'RETIRED_PRODUCER_EPOCH' } },
    });
  });

  it('keeps maximum-batch continuation cursors bounded and tied to every current consumer proof', async () => {
    await ingest.ingest(request([audience('1', 23)]));
    const body = {
      contractVersion: 1 as const,
      contexts: Array.from({ length: 100 }, () => ({ ...context, contextId: randomUUID() })),
      periods: [7 as const],
      metrics: ['AUDIENCE' as const],
      horizons: [0 as const],
      cursor: null,
    };
    const first = await read.summaries(body);
    expect(first.results.length).toBeGreaterThan(0);
    expect(first.nextCursor).not.toBeNull();
    expect(first.nextCursor!.length).toBeLessThan(1024);
    const next = await read.summaries({ ...body, cursor: first.nextCursor });
    expect(next.results[0]?.contextId).not.toBe(first.results[0]?.contextId);
    expect(statsSummaryResultSchema.safeParse(next).success).toBe(true);
    await access.attest({
      contractVersion: 1,
      requestId: randomUUID(),
      operations: [{ ...consumer, revision: '2', checkedAt: now() }],
    });
    await expect(read.summaries({ ...body, cursor: first.nextCursor })).rejects.toMatchObject({
      response: { error: { code: 'READ_RESTART' } },
    });
  });
});
