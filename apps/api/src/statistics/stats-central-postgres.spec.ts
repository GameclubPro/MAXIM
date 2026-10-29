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
  statsAuthorityResultSchema,
  statsAuthorityResolveResultSchema,
} from '@maxim/contracts/statistics-central-validation';
import { Prisma, PrismaClient, createPrismaAdapter } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { StatsAccessService } from './stats-access.service';
import { StatsIngestService } from './stats-ingest.service';
import { StatsReadService } from './stats-read.service';
import { StatsChangesService } from './stats-changes.service';
import { decodeCursor, encodeCursor } from './stats-cursor';
import { MaximNativeStatsAdapter } from './maxim-native-stats.adapter';
import { allKeys, DAY_MS, StatsFailure } from './stats-common';

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
  it('reconnects an explicitly revoked authority through a new identity without losing measurements', async () => {
    await ingest.ingest(request([audience('1', 20)]));
    const revoked = await access.attest({
      contractVersion: 1,
      requestId: randomUUID(),
      operations: [{ ...consumer, revision: '2', operation: 'REVOKE' }],
    });
    const successor = {
      ...consumer,
      id: randomUUID(),
      localAccessFence: '2026-10-29 19:30:00.654321+00',
      checkedAt: now(),
      supersedes: { id: consumer.id, revision: '2', epoch: revoked.results[0]!.epoch },
    };
    const result = await access.attest({
      contractVersion: 1,
      requestId: randomUUID(),
      operations: [successor],
    });
    expect(result.results[0]).toMatchObject({
      id: successor.id,
      status: 'APPLIED',
      state: 'ACTIVE',
    });
    context.consumerAuthority = { id: successor.id, epoch: result.results[0]!.epoch };
    const item = (await summary()).results[0]!;
    expect(item.status).toBe('READY');
    if (item.status === 'READY' && item.summary.audience.state === 'AVAILABLE')
      expect(item.summary.audience.value.value).toBe(20);
    else throw new Error('Recovered authority must retain its measured audience');
    const replay = await access.attest({
      contractVersion: 1,
      requestId: randomUUID(),
      operations: [successor],
    });
    expect(replay.results[0]).toMatchObject({ epoch: result.results[0]!.epoch, status: 'RENEWED' });
    const head = await access.resolve({
      contractVersion: 1,
      producerEpoch: epoch,
      entity,
      role: consumer.role,
      actorMaxUserId: consumer.actorMaxUserId,
      botRef: consumer.botRef,
      consumer: consumer.consumer,
      purpose: consumer.purpose,
    });
    expect(statsAuthorityResolveResultSchema.parse(head).head).toMatchObject({
      id: successor.id,
      state: 'ACTIVE',
    });
    for (const operation of ['ATTEST', 'REVOKE'] as const) {
      const delayed = await access.attest({
        contractVersion: 1,
        requestId: randomUUID(),
        operations: [{ ...consumer, operation, revision: '999', checkedAt: now() }],
      });
      expect(delayed.results[0]).toMatchObject({
        id: consumer.id,
        status: 'SUPERSEDED',
        state: 'REVOKED',
        peerValidUntil: null,
      });
    }
    await expect(
      db.$executeRaw`UPDATE stats_authorities SET state='ACTIVE' WHERE id=${consumer.id}::uuid`,
    ).rejects.toThrow('Superseded statistics authority is immutable');
    await expect(
      db.$executeRaw`UPDATE stats_authorities SET superseded_by=NULL,superseded_at=NULL WHERE id=${consumer.id}::uuid`,
    ).rejects.toThrow('Superseded statistics authority is immutable');
  });
  it('replaces a disabled source with a revoked successor while renewing its consumer and an independent entity', async () => {
    await ingest.ingest(request([audience('1', 29)]));
    const retired = await access.attest({
      contractVersion: 1,
      requestId: randomUUID(),
      operations: [source, consumer].map((op) => ({
        ...op,
        revision: '2',
        operation: 'REVOKE',
      })),
    });
    const nextSource: StatsAuthorityOperation = {
      ...source,
      id: randomUUID(),
      operation: 'REVOKE',
      supersedes: { id: source.id, revision: '2', epoch: retired.results[0]!.epoch },
    };
    const nextConsumer: StatsAuthorityOperation = {
      ...consumer,
      id: randomUUID(),
      supersedes: { id: consumer.id, revision: '2', epoch: retired.results[1]!.epoch },
    };
    const other = { ...entity, maxId: `${entity.maxId}1` };
    const healthy = { ...consumer, id: randomUUID(), entity: other };
    try {
      const batch = {
        contractVersion: 1 as const,
        requestId: randomUUID(),
        operations: [nextSource, nextConsumer, healthy],
      };
      const accepted = await access.attest(batch);
      expect(accepted.results).toMatchObject([
        { id: nextSource.id, status: 'APPLIED', state: 'REVOKED', peerValidUntil: null },
        { id: nextConsumer.id, status: 'APPLIED', state: 'ACTIVE' },
        { id: healthy.id, status: 'APPLIED', state: 'ACTIVE' },
      ]);
      const replay = await access.attest(batch);
      expect(replay.results.map((r) => r.epoch)).toEqual(accepted.results.map((r) => r.epoch));
      expect(replay.results.map((r) => r.status)).toEqual(['DUPLICATE', 'RENEWED', 'RENEWED']);
      context.consumerAuthority = { id: nextConsumer.id, epoch: accepted.results[1]!.epoch };
      expect((await summary()).results[0]).toMatchObject({
        status: 'READY',
        summary: { audience: { state: 'UNAVAILABLE' } },
      });
      const delayed = await access.attest({
        contractVersion: 1,
        requestId: randomUUID(),
        operations: [{ ...source, revision: '999', checkedAt: now() }],
      });
      expect(delayed.results[0]).toMatchObject({ status: 'SUPERSEDED', state: 'REVOKED' });
      // An independently authorized source can still read the retained measurement.
      await access.attest({
        contractVersion: 1,
        requestId: randomUUID(),
        operations: [{ ...source, id: randomUUID(), botRef: 'independent-native-proof' }],
      });
      expect((await summary()).results[0]).toMatchObject({
        status: 'READY',
        summary: { audience: { state: 'AVAILABLE', value: { value: 29 } } },
      });
    } finally {
      await db.$executeRaw`DELETE FROM stats_entities WHERE kind=${other.kind} AND max_id=${other.maxId}`;
    }
  });
  it('admits only one concurrent successor and retains the exact revoked predecessor', async () => {
    const retired = await access.attest({
      contractVersion: 1,
      requestId: randomUUID(),
      operations: [{ ...consumer, revision: '2', operation: 'REVOKE' }],
    });
    const successors = [randomUUID(), randomUUID()].map((id) => ({
      ...consumer,
      id,
      localAccessFence: 'a-new-exact-fence',
      checkedAt: now(),
      supersedes: { id: consumer.id, revision: '2', epoch: retired.results[0]!.epoch },
    }));
    const results = await Promise.all(
      successors.map((operation) =>
        access.attest({ contractVersion: 1, requestId: randomUUID(), operations: [operation] }),
      ),
    );
    const items = results.flatMap((result) => result.results);
    expect(items.filter((item) => item.state === 'ACTIVE')).toHaveLength(1);
    expect(items.filter((item) => item.status === 'DENIED')).toHaveLength(1);
    const rows = await db.$queryRaw<
      Array<{ id: string; state: string; superseded_by: string | null }>
    >`
      SELECT id,state,superseded_by FROM stats_authorities WHERE id IN (${consumer.id}::uuid,${successors[0]!.id}::uuid,${successors[1]!.id}::uuid)`;
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === consumer.id)).toMatchObject({
      state: 'REVOKED',
      superseded_by: items.find((item) => item.state === 'ACTIVE')!.id,
    });
  });
  it('requires the exact revoked scope and never replaces an expired active head', async () => {
    const attempt = (operation: StatsAuthorityOperation) =>
      access.attest({ contractVersion: 1, requestId: randomUUID(), operations: [operation] });
    await db.$executeRaw`UPDATE stats_authorities SET peer_valid_until=now()-interval '1 second' WHERE id=${consumer.id}::uuid`;
    const fresh = {
      ...consumer,
      id: randomUUID(),
      checkedAt: now(),
      supersedes: { id: consumer.id, revision: '1', epoch: consumerEpoch },
    };
    expect((await attempt(fresh)).results[0]).toMatchObject({
      status: 'DENIED',
      state: 'UNAVAILABLE',
      errorCode: 'STALE_LOCAL_FENCE',
    });
    const retired = await attempt({ ...consumer, operation: 'REVOKE', revision: '2' });
    const successor = {
      ...fresh,
      supersedes: { id: consumer.id, revision: '2', epoch: retired.results[0]!.epoch },
    };
    for (const operation of [
      { ...successor, actorMaxUserId: '777777' },
      { ...successor, botRef: 'other-bot' },
      { ...successor, role: 'SOURCE' as const },
      { ...successor, purpose: 'PUBLISHED_AGGREGATE' as const },
      { ...successor, supersedes: { ...successor.supersedes, epoch: '999' } },
      { ...successor, supersedes: { ...successor.supersedes, revision: '999' } },
      { ...successor, supersedes: undefined },
    ])
      expect((await attempt(operation)).results[0]).toMatchObject({
        status: 'DENIED',
        state: 'UNAVAILABLE',
      });
    expect((await attempt(successor)).results[0]!.state).toBe('ACTIVE');
  });
  it('rebinds an existing identity to a bot scope only after explicitly retiring that scope head', async () => {
    const attempt = (operation: StatsAuthorityOperation) =>
      access.attest({ contractVersion: 1, requestId: randomUUID(), operations: [operation] });
    const target = { ...consumer, id: randomUUID(), botRef: 'previous-binding' };
    await attempt(target);
    const retired = await attempt({ ...target, revision: '2', operation: 'REVOKE' });
    const rebound = { ...consumer, revision: '2', botRef: target.botRef, checkedAt: now() };
    expect((await attempt(rebound)).results[0]!.status).toBe('DENIED');
    const result = await attempt({
      ...rebound,
      supersedes: { id: target.id, revision: '2', epoch: retired.results[0]!.epoch },
    });
    expect(result.results[0]).toMatchObject({ id: consumer.id, state: 'ACTIVE', epoch: '2' });
    const delayed = await attempt({ ...target, revision: '500', checkedAt: now() });
    expect(delayed.results[0]).toMatchObject({ state: 'REVOKED', status: 'SUPERSEDED' });
    expect(
      (await attempt({ ...consumer, revision: '3', checkedAt: now() })).results[0]!.state,
    ).toBe('ACTIVE');
  });
  it('commits healthy platforms independently from denied identities and validates input before any mutation', async () => {
    const other = { kind: 'CHAT' as const, maxId: `${entity.maxId}1` };
    const healthy = {
      ...source,
      entity: other,
      id: randomUUID(),
      scopes: allKeys.filter((key) => key.metric === 'AUDIENCE'),
    };
    try {
      const bad = { ...consumer, actorMaxUserId: '777777', revision: '2' };
      const result = await access.attest({
        contractVersion: 1,
        requestId: randomUUID(),
        operations: [bad, healthy],
      });
      expect(statsAuthorityResultSchema.parse(result).results).toMatchObject([
        {
          index: 0,
          id: consumer.id,
          epoch: '0',
          status: 'DENIED',
          state: 'UNAVAILABLE',
          errorCode: 'FORBIDDEN',
        },
        { index: 1, id: healthy.id, status: 'APPLIED', state: 'ACTIVE' },
      ]);
      await expect(
        access.attest({
          contractVersion: 1,
          requestId: randomUUID(),
          operations: [
            { ...healthy, revision: '2' },
            { ...bad, revision: '-1' },
          ],
        }),
      ).rejects.toMatchObject({ response: { error: { code: 'INVALID_REQUEST' } } });
      const rows = await db.$queryRaw<
        Array<{ revision: bigint }>
      >`SELECT revision FROM stats_authorities WHERE id=${healthy.id}::uuid`;
      expect(rows[0]!.revision).toBe(1n);
    } finally {
      await db.$executeRaw`DELETE FROM stats_entities WHERE kind=${other.kind} AND max_id=${other.maxId}`;
    }
  });
  it('resolves only an exact current EXCHANGE scope and preserves an absent identity as null', async () => {
    const scope = {
      contractVersion: 1 as const,
      producerEpoch: epoch,
      entity,
      role: consumer.role,
      actorMaxUserId: consumer.actorMaxUserId,
      botRef: consumer.botRef,
      consumer: consumer.consumer,
      purpose: consumer.purpose,
    };
    expect((await access.resolve(scope)).head).toMatchObject({ id: consumer.id, state: 'ACTIVE' });
    for (const request of [
      { ...scope, actorMaxUserId: '777777' },
      { ...scope, botRef: 'other' },
      { ...scope, purpose: 'PUBLISHED_AGGREGATE' as const },
      { ...scope, consumer: 'MAXIM' as const },
      { ...scope, entity: { ...entity, kind: 'CHAT' as const } },
    ])
      expect((await access.resolve(request)).head).toBeNull();
    await expect(access.resolve({ ...scope, producerEpoch: randomUUID() })).rejects.toMatchObject({
      response: { error: { code: 'RETIRED_PRODUCER_EPOCH' } },
    });
  });
  it('does not fan out retained successor chains on unrelated later changes', async () => {
    const retired = await access.attest({
      contractVersion: 1,
      requestId: randomUUID(),
      operations: [{ ...consumer, revision: '2', operation: 'REVOKE' }],
    });
    const successor = {
      ...consumer,
      id: randomUUID(),
      supersedes: { id: consumer.id, revision: '2', epoch: retired.results[0]!.epoch },
    };
    await access.attest({ contractVersion: 1, requestId: randomUUID(), operations: [successor] });
    await feed.relay();
    const head = await feed.changes('HEAD');
    // HEAD starts at the first view of the latest published slot. Consume that
    // already-published authority slot before testing a subsequent DATA change.
    const tail = await feed.changes(head.nextCursor);
    await ingest.ingest(request([audience('1', 77)]));
    await feed.relay();
    const changes = await feed.changes(tail.nextCursor);
    expect(changes.items.some((item) => item.viewId === consumer.id)).toBe(false);
    expect(
      changes.items.filter((item) => item.viewId === successor.id && item.action === 'REFRESH'),
    ).toHaveLength(1);
  });
  it('bounds feed authority probes with retained tombstones and preserves exact paged revocations', async () => {
    const background = { ...entity, maxId: `${entity.maxId}2` };
    const [other] = await db.$queryRaw<Array<{ id: string }>>`
      INSERT INTO stats_entities(kind,max_id) VALUES(${background.kind},${background.maxId}) RETURNING id`;
    try {
      await db.$executeRaw`
        INSERT INTO stats_authorities(id,entity_id,issuer,role,producer,consumer,actor_max_id,bot_ref,purpose,
          scopes,revision,epoch,producer_epoch,local_access_fence,state,peer_valid_until,checked_at,superseded_by,superseded_at)
        SELECT gen_random_uuid(),entity_id,issuer,role,producer,consumer,actor_max_id,bot_ref,purpose,
          scopes,revision,epoch,producer_epoch,local_access_fence,'REVOKED',now(),now(),id,now()
        FROM stats_authorities CROSS JOIN generate_series(1,5000) g WHERE id=${consumer.id}::uuid`;
      await db.$executeRaw`
        INSERT INTO stats_authorities(id,entity_id,issuer,role,producer,consumer,actor_max_id,bot_ref,purpose,
          scopes,revision,epoch,producer_epoch,local_access_fence,state,peer_valid_until,checked_at)
        SELECT gen_random_uuid(),${other!.id}::uuid,issuer,role,producer,consumer,actor_max_id,bot_ref||g,purpose,
          scopes,revision,epoch,producer_epoch,local_access_fence,state,peer_valid_until,checked_at
        FROM stats_authorities CROSS JOIN generate_series(1,5000) g WHERE id=${consumer.id}::uuid`;
      const [predecessor] = await db.$queryRaw<Array<{ id: string; entity_id: string }>>`
        SELECT id,entity_id FROM stats_authorities WHERE superseded_by=${consumer.id}::uuid LIMIT 1`;
      const [existing] = await db.$queryRaw<Array<{ seq: bigint }>>`
        SELECT COALESCE(max(published_seq),0)::bigint AS seq FROM stats_changes`;
      const cursorSeq = existing!.seq + 5000n;
      await db.$executeRaw`
        INSERT INTO stats_changes(entity_id,entity_revision,cause,published_seq,published_at)
        SELECT ${other!.id}::uuid,g,'DATA',${existing!.seq}+g,now() FROM generate_series(1,5000) g`;
      await db.$executeRaw`
        INSERT INTO stats_changes(entity_id,entity_revision,cause,authority_id,published_seq,published_at)
        VALUES(${predecessor!.entity_id}::uuid,1,'AUTHORITY',${predecessor!.id}::uuid,${cursorSeq + 1n},now()),
          (${predecessor!.entity_id}::uuid,2,'DATA',NULL,${cursorSeq + 2n},now())`;
      await db.$executeRaw`ANALYZE stats_authorities`;
      await db.$executeRaw`ANALYZE stats_changes`;
      await db.$executeRaw`ANALYZE stats_entities`;
      const cursor = encodeCursor(
        {
          type: 'changes',
          seq: cursorSeq.toString(),
          view: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
          expires: Date.now() + 60_000,
        },
        'a'.repeat(64),
      );
      await expect(
        feed.changes(
          encodeCursor(
            {
              type: 'changes',
              seq: cursorSeq.toString(),
              view: '-'.repeat(36),
              expires: Date.now() + 60_000,
            },
            'a'.repeat(64),
          ),
        ),
      ).rejects.toMatchObject({ response: { error: { code: 'INVALID_REQUEST' } } });
      const query = jest.spyOn(db, '$queryRaw');
      let page: Awaited<ReturnType<StatsChangesService['changes']>>;
      let captured: Prisma.Sql;
      try {
        page = await feed.changes(cursor, 1);
        const call = query.mock.calls.find(
          ([strings]) =>
            Array.isArray(strings) && strings.join('').includes('SELECT ch.published_seq'),
        );
        expect(call).toBeDefined();
        captured = Prisma.sql(call![0] as TemplateStringsArray, ...call!.slice(1));
      } finally {
        query.mockRestore();
      }
      type Plan = {
        'Node Type': string;
        'Relation Name'?: string;
        'Index Name'?: string;
        'Actual Rows': number;
        'Actual Loops': number;
        'Rows Removed by Filter'?: number;
        Plans?: Plan[];
      };
      const [explained] = await db.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: Plan }> }>>`
        EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${captured!}`;
      const flatten = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(flatten)];
      const probes = flatten(explained!['QUERY PLAN'][0]!.Plan).filter(
        (node) => node['Relation Name'] === 'stats_authorities',
      );
      expect(
        probes.some((node) => node['Index Name'] === 'stats_authorities_current_consumers_idx'),
      ).toBe(true);
      expect(probes.some((node) => node['Index Name'] === 'stats_authorities_pkey')).toBe(true);
      expect(
        probes.reduce(
          (count, node) =>
            count +
            (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops'],
          0,
        ),
      ).toBeLessThanOrEqual(8);
      const items = [...page!.items];
      const positions = new Set<string>();
      for (let index = 0; ; index++) {
        const position = decodeCursor<{ seq: string; view: string }>(
          page!.nextCursor,
          'a'.repeat(64),
        );
        const key = `${position.seq}/${position.view}`;
        expect(positions.has(key)).toBe(false);
        positions.add(key);
        if (!page!.hasMore) break;
        expect(index).toBeLessThan(4);
        page = await feed.changes(page!.nextCursor, 1);
        items.push(...page.items);
      }
      expect(items.filter((item) => item.viewId === predecessor!.id)).toEqual([
        expect.objectContaining({ action: 'REVOKE', authorityId: predecessor!.id }),
      ]);
      expect(
        items.filter((item) => item.viewId === consumer.id && item.action === 'REFRESH'),
      ).toHaveLength(2);
      expect(items).toHaveLength(3);
      await db.$executeRaw`
        INSERT INTO stats_authorities(id,entity_id,issuer,role,producer,consumer,actor_max_id,bot_ref,purpose,
          scopes,revision,epoch,producer_epoch,local_access_fence,state,peer_valid_until,checked_at)
        SELECT '00000000-0000-0000-0000-000000000000'::uuid,${other!.id}::uuid,issuer,role,producer,consumer,
          actor_max_id,'nil-uuid-current-head',purpose,scopes,revision,epoch,producer_epoch,local_access_fence,
          state,peer_valid_until,checked_at FROM stats_authorities WHERE id=${consumer.id}::uuid`;
      await db.$executeRaw`
        INSERT INTO stats_changes(entity_id,entity_revision,cause,published_seq,published_at)
        VALUES(${other!.id}::uuid,5001,'DATA',${cursorSeq + 3n},now())`;
      const seen = new Set<string>();
      let continuation = page!.nextCursor;
      for (let index = 0; ; index++) {
        const next = await feed.changes(continuation, 250);
        for (const item of next.items) {
          expect(item.action).toBe('REFRESH');
          expect(seen.has(item.viewId)).toBe(false);
          seen.add(item.viewId);
        }
        if (!next.hasMore) break;
        expect(index).toBeLessThan(22);
        continuation = next.nextCursor;
      }
      expect(seen.size).toBe(5001);
      expect(seen.has('00000000-0000-0000-0000-000000000000')).toBe(true);
    } finally {
      await db.$executeRaw`DELETE FROM stats_entities WHERE id=${other!.id}::uuid`;
    }
  });
  it('retries a nested PostgreSQL deadlock once without masking it behind Prisma P2010', async () => {
    const transaction = jest
      .spyOn(db, '$transaction')
      .mockRejectedValueOnce({ code: 'P2010', meta: { code: '40P01' } });
    try {
      const result = await access.attest({
        contractVersion: 1,
        requestId: randomUUID(),
        operations: [{ ...consumer, checkedAt: now() }],
      });
      expect(result.results[0]).toMatchObject({ state: 'ACTIVE', status: 'RENEWED' });
      expect(transaction).toHaveBeenCalledTimes(2);
    } finally {
      transaction.mockRestore();
    }
  });
  it('returns temporary storage failure separately while committing an independent platform', async () => {
    const other = { kind: 'CHAT' as const, maxId: `${entity.maxId}1` };
    const healthy = {
      ...source,
      entity: other,
      id: randomUUID(),
      scopes: allKeys.filter((key) => key.metric === 'AUDIENCE'),
    };
    const transaction = jest
      .spyOn(db, '$transaction')
      .mockRejectedValueOnce({ code: 'P2010', meta: { code: '57014' } });
    try {
      const result = await access.attest({
        contractVersion: 1,
        requestId: randomUUID(),
        operations: [consumer, healthy],
      });
      expect(statsAuthorityResultSchema.parse(result).results).toMatchObject([
        { id: consumer.id, status: 'DENIED', state: 'UNAVAILABLE', epoch: '0', errorCode: null },
        { id: healthy.id, status: 'APPLIED', state: 'ACTIVE' },
      ]);
      expect(transaction).toHaveBeenCalledTimes(2);
    } finally {
      transaction.mockRestore();
      await db.$executeRaw`DELETE FROM stats_entities WHERE kind=${other.kind} AND max_id=${other.maxId}`;
    }
  });
  it('serializes readers, source-first renewals and ingestion through the entity lock', async () => {
    for (let round = 0; round < 6; round++) {
      const [snapshot, sourceFirst, consumerFirst, recorded] = await Promise.all([
        summary().catch((error: unknown) => {
          // A concurrent data revision may invalidate a snapshot, but lock errors must escape.
          expect(error).toBeInstanceOf(StatsFailure);
          expect((error as StatsFailure).getResponse()).toMatchObject({
            error: { code: 'READ_RESTART' },
          });
          return null;
        }),
        access.attest({
          contractVersion: 1,
          requestId: randomUUID(),
          operations: [
            { ...source, checkedAt: now() },
            { ...consumer, checkedAt: now() },
          ],
        }),
        access.attest({
          contractVersion: 1,
          requestId: randomUUID(),
          operations: [
            { ...consumer, checkedAt: now() },
            { ...source, checkedAt: now() },
          ],
        }),
        ingest.ingest(request([audience(String(round + 1), round + 1)])),
      ]);
      if (snapshot) expect(snapshot.results[0]!.status).toBe('READY');
      for (const result of [sourceFirst, consumerFirst])
        expect(result.results.every((item) => item.status === 'RENEWED')).toBe(true);
      expect(recorded.results[0]!.status).toBe('APPLIED');
      expect((await summary()).results[0]).toMatchObject({
        status: 'READY',
        summary: { audience: { state: 'AVAILABLE', value: { value: round + 1 } } },
      });
    }
  });
  it('keeps validated entity foreign keys aligned with Prisma update and delete actions', async () => {
    const constraints = await db.$queryRaw<
      Array<{ conname: string; confupdtype: string; confdeltype: string; convalidated: boolean }>
    >`SELECT conname, confupdtype::text, confdeltype::text, convalidated
      FROM pg_constraint
      WHERE conrelid IN ('stats_authorities'::regclass, 'stats_measurements'::regclass, 'stats_changes'::regclass)
        AND confrelid = 'stats_entities'::regclass AND contype = 'f'
      ORDER BY conname`;
    expect(constraints).toEqual(
      [
        'stats_authorities_entity_id_fkey',
        'stats_changes_entity_id_fkey',
        'stats_measurements_entity_id_fkey',
      ].map((conname) => ({ conname, confupdtype: 'c', confdeltype: 'c', convalidated: true })),
    );
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
  for (const role of ['SOURCE', 'CONSUMER'] as const)
    it(`renews a ${role} bot binding only at a newer revision and fences its old epoch`, async () => {
      await ingest.ingest(request([audience('1', 20)]));
      const original = role === 'SOURCE' ? source : consumer;
      const attest = (operation: StatsAuthorityOperation) =>
        access.attest({ contractVersion: 1, requestId: randomUUID(), operations: [operation] });
      await attest({ ...original, revision: '2', operation: 'REVOKE' });
      const rebound = {
        ...original,
        revision: '3',
        botRef: `MAXIM_BINDING:${randomUUID()}`,
        checkedAt: now(),
      };
      const result = await attest(rebound);
      expect(result.results[0]).toMatchObject({ id: original.id, epoch: '3', state: 'ACTIVE' });
      const stored = await db.$queryRaw<
        Array<{ bot_ref: string; revision: bigint; epoch: bigint }>
      >`
        SELECT bot_ref,revision,epoch FROM stats_authorities WHERE id=${original.id}::uuid`;
      expect(stored).toEqual([{ bot_ref: rebound.botRef, revision: 3n, epoch: 3n }]);
      if (role === 'SOURCE') {
        await expect(ingest.ingest(request([audience('2', 21)]))).rejects.toMatchObject({
          response: { error: { code: 'FORBIDDEN' } },
        });
        sourceEpoch = '3';
        await ingest.ingest(request([audience('2', 21)]));
      } else {
        expect((await summary()).results[0]!.status).toBe('FORBIDDEN');
        context.consumerAuthority.epoch = '3';
      }
      expect((await summary()).results[0]!.status).toBe('READY');
      expect((await attest({ ...rebound, botRef: original.botRef })).results[0]).toMatchObject({
        status: 'DENIED',
        state: 'UNAVAILABLE',
        errorCode: 'STALE_LOCAL_FENCE',
      });
      expect((await attest({ ...original, revision: '2' })).results[0]).toMatchObject({
        status: 'SUPERSEDED',
        epoch: '3',
      });
      expect(
        (await attest({ ...rebound, revision: '4', actorMaxUserId: '999999999' })).results[0],
      ).toMatchObject({
        status: 'DENIED',
        state: 'UNAVAILABLE',
        errorCode: 'FORBIDDEN',
      });
      const final = await db.$queryRaw<Array<{ bot_ref: string; revision: bigint; epoch: bigint }>>`
        SELECT bot_ref,revision,epoch FROM stats_authorities WHERE id=${original.id}::uuid`;
      expect(final).toEqual(stored);
      expect(
        (await attest({ ...original, revision: '4', checkedAt: now() })).results[0],
      ).toMatchObject({
        id: original.id,
        epoch: '4',
        state: 'ACTIVE',
        status: 'APPLIED',
      });
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

  it('keeps native history and authority epochs stable across unchanged grant checks while fencing real access changes', async () => {
    await db.chat.create({
      data: { id: entity.maxId, title: 'Native renewed proof', entityType: 'CHANNEL' },
    });
    await db.chatBotMembership.create({
      data: {
        chatId: entity.maxId,
        botId: 'native-renewal',
        status: 'ACTIVE',
        botAccessState: 'CONFIRMED_ADMIN',
      },
    });
    await db.managedEntityAccessEdge.create({
      data: {
        chatId: entity.maxId,
        userId: source.actorMaxUserId,
        botId: 'native-renewal',
        entityType: 'CHANNEL',
        state: 'GRANTED',
        userRole: 'ADMIN',
        botRole: 'ADMIN',
        checkedAt: new Date(Date.now() - DAY_MS),
      },
    });
    await db.channelAudienceSnapshot.create({
      data: {
        chatId: entity.maxId,
        capturedAt: new Date(Date.now() - 1000),
        participantsCount: 44,
      },
    });
    const renew = () =>
      access.attest({
        contractVersion: 1,
        requestId: randomUUID(),
        operations: [{ ...consumer, checkedAt: now() }],
      });
    await renew();
    const before = (await summary()).results[0]!;
    expect(before).toMatchObject({
      status: 'READY',
      summary: { audience: { state: 'AVAILABLE', value: { value: 44 } } },
    });
    const local = await access.localContext(
      entity,
      source.actorMaxUserId,
      'native-renewal',
      allKeys,
    );
    for (let round = 0; round < 4; round++) {
      const [renewed, localRenewed, peerRead, localRead] = await Promise.all([
        renew(),
        access.localContext(entity, source.actorMaxUserId, 'native-renewal', allKeys),
        summary(),
        read.summaries(
          {
            contractVersion: 1,
            contexts: [local],
            periods: [7],
            metrics: ['AUDIENCE'],
            horizons: [0],
            cursor: null,
          },
          'MAXIM',
        ),
      ]);
      expect(renewed.results[0]!.status).toBe('RENEWED');
      expect(localRenewed.consumerAuthority).toEqual(local.consumerAuthority);
      for (const result of [peerRead, localRead])
        expect(result.results[0]).toMatchObject({
          status: 'READY',
          summary: { audience: { state: 'AVAILABLE', value: { value: 44 } } },
        });
    }
    const grants = () => db.$queryRaw<Array<{ id: string; epoch: bigint }>>`
      SELECT id,epoch FROM stats_authorities WHERE actor_max_id=${source.actorMaxUserId}
      AND bot_ref='native-renewal' AND role='SOURCE' AND consumer='EXCHANGE'
      AND entity_id IN(SELECT id FROM stats_entities WHERE max_id=${entity.maxId}) ORDER BY id`;
    const original = await grants();
    const update = (data: {
      checkedAt?: Date;
      state?: 'GRANTED' | 'USER_DENIED';
      userRole?: 'ADMIN' | 'MEMBER';
    }) =>
      db.managedEntityAccessEdge.updateMany({
        where: { chatId: entity.maxId, userId: source.actorMaxUserId },
        data,
      });
    await update({ checkedAt: new Date() });
    // The reader must retain an independently authorized observation before the next peer renewal.
    expect((await summary()).results[0]).toMatchObject({
      status: 'READY',
      summary: { audience: { state: 'AVAILABLE', value: { value: 44 } } },
    });
    const nativeProof = access.nativeProof.bind(access);
    const duringRead = jest.spyOn(access, 'nativeProof').mockImplementationOnce(async (...args) => {
      const proof = await nativeProof(...args);
      await update({ checkedAt: new Date(Date.now() + 1) });
      return proof;
    });
    try {
      expect((await summary()).results[0]).toMatchObject({
        status: 'READY',
        summary: { audience: { state: 'AVAILABLE', value: { value: 44 } } },
      });
    } finally {
      duringRead.mockRestore();
    }
    await renew();
    expect(await grants()).toEqual(original);
    await update({ state: 'USER_DENIED', userRole: 'MEMBER' });
    expect((await summary()).results[0]).toMatchObject({
      status: 'READY',
      summary: { audience: { state: 'UNAVAILABLE' } },
    });
    await update({ state: 'GRANTED', userRole: 'ADMIN', checkedAt: new Date() });
    await renew();
    await db.chatBotMembership.updateMany({
      where: { chatId: entity.maxId },
      data: { lifecycleEventAt: new Date() },
    });
    expect((await summary()).results[0]).toMatchObject({
      status: 'READY',
      summary: { audience: { state: 'UNAVAILABLE' } },
    });
    await renew();
    expect((await grants())[0]!.epoch).toBeGreaterThan(original[0]!.epoch);
    await db.chatBotMembership.updateMany({
      where: { chatId: entity.maxId },
      data: { botAccessState: 'DENIED', botAccessCheckedAt: new Date(Date.now() + 1000) },
    });
    expect((await summary()).results[0]).toMatchObject({
      status: 'READY',
      summary: { audience: { state: 'UNAVAILABLE' } },
    });
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
    const observed = new Date(`${day()}T00:00:00Z`);
    observed.setUTCMinutes(-1);
    await db.managedEntityAudienceObservation.create({
      data: {
        chatId: entity.maxId,
        entityType: 'CHANNEL',
        participantsCount: 41,
        observedAt: observed,
        source: 'native',
      },
    });
    const olderAt = new Date(observed.getTime() - 1000).toISOString();
    const older = audience('1', 99, olderAt.slice(0, 10));
    if (older.method.id === 'AUDIENCE_SNAPSHOT') older.value = { value: 99, observedAt: olderAt };
    await ingest.ingest(request([older]));
    expect(
      (
        await read.localAudienceCurrent([entity, entity], source.actorMaxUserId, new Date())
      ).rows.map((row) => row.value),
    ).toEqual([41]);
    const newestAt = new Date(observed.getTime() + 1000).toISOString();
    const newest = audience('2', 0, newestAt.slice(0, 10));
    if (newest.method.id === 'AUDIENCE_SNAPSHOT') newest.value = { value: 0, observedAt: newestAt };
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
