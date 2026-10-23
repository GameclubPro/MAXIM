import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import {
  EXCHANGE_V3_CAPABILITIES,
  exchangeV3ContentCanonical,
  exchangeV3ContentSchema,
  type ExchangeV3AccessEntity,
  type ExchangeV3GrantHeader,
  type ExchangeV3Head,
  type ExchangeMeasurement,
} from '@maxim/contracts';
import { PrismaClient, createPrismaAdapter } from '../../prisma/prisma-client';
import { type PrismaService } from '../../prisma/prisma.service';
import { MarketplaceStateService } from './marketplace-state.service';
import { type MarketplaceAccessService } from './marketplace-access.service';
import { MarketplaceStatisticsService } from './marketplace-statistics.service';
import { StatisticsExchangeGrantsService } from './statistics-exchange-grants.service';
import { StatisticsExchangeStatisticsService } from './statistics-exchange-statistics.service';
import { StatisticsExchangeDownloadsService } from './statistics-exchange-downloads.service';
import { StatisticsExchangeV3Service } from './statistics-exchange-v3.service';
import {
  StatisticsExchangeV3ConsumerService,
  type ExchangeV3Remote,
  type ExchangeV3Activate,
} from './statistics-exchange-v3-consumer.service';
import { exchangeMeasurementsHash } from './statistics-exchange-values';
import { ExchangeResponseError } from './statistics-exchange-errors';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
jest.setTimeout(30000);
postgres('bounded v3 native statistics and reverse transport PostgreSQL', () => {
  let db: PrismaClient,
    state: MarketplaceStateService,
    grants: StatisticsExchangeGrantsService,
    native: MarketplaceStatisticsService,
    producer: StatisticsExchangeV3Service,
    consumer: StatisticsExchangeV3ConsumerService;
  let grantId: string, bindingId: string, entityId: string, actor: string;
  const config = new ConfigService({
    SVYAZKA_ANALYTICS_TOKEN: 'a'.repeat(64),
    SVYAZKA_PROFILE_TOKEN: 'b'.repeat(64),
    SVYAZKA_STATISTICS_EXPORT_TOKEN: 'c'.repeat(64),
    SVYAZKA_STATISTICS_V2_USERS: '*',
    STATISTICS_EXCHANGE_V3_ENABLED: true,
  });
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable native database required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 4, statement_timeout: 10000 }),
    });
    await db.$connect();
    state = new MarketplaceStateService(db as PrismaService, config);
    grants = new StatisticsExchangeGrantsService(
      db as PrismaService,
      config,
      { attest: async () => (await state.read(bindingId))! } as unknown as MarketplaceAccessService,
      state,
    );
    native = new MarketplaceStatisticsService(db as PrismaService, state);
    producer = new StatisticsExchangeV3Service(db as PrismaService, grants, native);
    consumer = new StatisticsExchangeV3ConsumerService(
      db as PrismaService,
      config,
      grants,
      new StatisticsExchangeDownloadsService(db as PrismaService),
    );
  });
  beforeEach(async () => {
    grantId = randomUUID();
    bindingId = randomUUID();
    actor = String(Date.now()) + String(Math.floor(Math.random() * 10000));
    entityId = '-' + actor;
    const now = new Date(),
      from = new Date(now);
    from.setUTCHours(0, 0, 0, 0);
    from.setUTCDate(from.getUTCDate() - 89);
    await db.chat.create({ data: { id: entityId, title: 'Synthetic v3', entityType: 'CHANNEL' } });
    await db.chatBotMembership.create({
      data: {
        chatId: entityId,
        botId: 'synthetic-v3-bot',
        status: 'ACTIVE',
        botAccessState: 'CONFIRMED_ADMIN',
      },
    });
    await db.$executeRaw`INSERT INTO marketplace_bindings(id,actor_user_id,entity_id,kind,profile,bot_id,state,checked_at,valid_until,metadata,history_complete,history_from,history_to,native_full_checked_at,native_history_checked_at,native_audience_checked_at) VALUES(${bindingId}::uuid,${actor},${entityId},'CHANNEL','moderation','synthetic-v3-bot','ACTIVE',${now},${new Date(now.getTime() + 300000)},${JSON.stringify({ title: 'Synthetic v3', description: '', imageUrl: null, publicUrl: null, audience: 100, isPublic: true })}::jsonb,true,${from},${now},${now},${now},${now})`;
    const published = new Date(now.getTime() - 3 * 86400000);
    published.setUTCHours(8, 0, 0, 0);
    await db.channelPost.create({
      data: {
        chatId: entityId,
        messageId: 'v3-native',
        publishedAt: published,
        latestViews: 10,
        latestSnapshotAt: now,
        viewsAt24h: 5,
        viewsAt24hCapturedAt: new Date(published.getTime() + 86400000 + 300000),
      },
    });
    await db.$executeRaw`INSERT INTO marketplace_audience_observations(binding_id,bucket,audience,observed_at) VALUES(${bindingId}::uuid,date_trunc('hour',now()),100,now())`;
    await grants.put(grantId, {
      grantId,
      actorUserId: actor,
      revision: 1,
      state: 'ACTIVE',
      entities: [{ entityId, kind: 'CHANNEL', profile: 'moderation' }],
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db.$executeRaw`DELETE FROM statistics_exchange_v3_generations WHERE grant_id=${grantId}::uuid`;
    await db.$executeRaw`DELETE FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`;
    await db.$executeRaw`DELETE FROM statistics_exchange_generations WHERE grant_id=${grantId}::uuid`;
    await db.$executeRaw`DELETE FROM statistics_exchange_entities WHERE grant_id=${grantId}::uuid`;
    await db.$executeRaw`DELETE FROM statistics_exchange_grants WHERE id=${grantId}::uuid`;
    await db.$executeRaw`DELETE FROM marketplace_statistics_generations WHERE binding_id=${bindingId}::uuid`;
    await db.$executeRaw`DELETE FROM marketplace_audience_observations WHERE binding_id=${bindingId}::uuid`;
    await db.$executeRaw`DELETE FROM marketplace_policy_requests WHERE binding_id=${bindingId}::uuid`;
    await db.$executeRaw`DELETE FROM marketplace_bindings WHERE id=${bindingId}::uuid`;
    await db.chat.delete({ where: { id: entityId } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  const query = () => ({ entityId, kind: 'CHANNEL' as const });
  async function access(): Promise<ExchangeV3AccessEntity> {
    const binding = (await state.read(bindingId))!;
    return {
      entityId,
      kind: 'CHANNEL',
      profile: 'moderation',
      bindingId,
      bindingRevision: binding.revision,
      status: 'ACTIVE',
      checkedAt: binding.checked_at!.toISOString(),
      validUntil: binding.valid_until!.toISOString(),
      permittedScopes: [{ metric: 'AUDIENCE' }],
      isPublic: true,
      errorCode: null,
      metadataVersion: null,
    };
  }
  function header(accessRevision = 1): ExchangeV3GrantHeader {
    return {
      version: 3,
      grantId,
      actorUserId: actor,
      revision: 1,
      state: 'ACTIVE',
      membership: null,
      accessRevision,
    };
  }
  const page = (
    entities: ExchangeV3AccessEntity[],
    nextCursor: string | null = null,
    accessRevision = 1,
  ) => ({ version: 3, grantId, grantRevision: 1, accessRevision, entities, nextCursor });
  async function reverseFixture(): Promise<{ head: ExchangeV3Head; rows: ExchangeMeasurement[] }> {
    const own = await producer.head(grantId, query());
    const b = await access();
    const row: ExchangeMeasurement = {
      origin: 'EXCHANGE',
      method: 'utc-buckets-v1',
      revision: 1,
      data: {
        metric: 'AUDIENCE',
        bucket: new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString(),
        value: 777,
        observedAt: own.content!.to,
      },
    };
    const content = exchangeV3ContentSchema.parse({
      ...own.content!,
      generationId: randomUUID(),
      origin: 'EXCHANGE',
      producerRevision: 1,
      rowCount: 1,
      pageCount: 1,
      sha256: exchangeMeasurementsHash([row]),
      scopes: [
        {
          metric: 'AUDIENCE',
          coverageFrom: null,
          coverageUntil: null,
          complete: false,
          population: 'NONEMPTY',
          proofObservedAt: row.data.observedAt,
        },
      ],
    });
    // Keep observedAt within the frozen producer interval.
    row.data.observedAt = content.to;
    content.sha256 = exchangeMeasurementsHash([row]);
    content.scopes[0]!.proofObservedAt = content.to;
    content.contentHash = createHash('sha256')
      .update(exchangeV3ContentCanonical(content))
      .digest('hex');
    return {
      head: {
        ...own,
        bindingRevision: b.bindingRevision,
        content,
        health: own.health.filter((s) => s.metric === 'AUDIENCE'),
        unchanged: false,
      },
      rows: [row],
    };
  }
  function reverseRemote(
    fixture: { head: ExchangeV3Head; rows: ExchangeMeasurement[] },
    record: ExchangeV3AccessEntity,
  ): jest.MockedFunction<ExchangeV3Remote> {
    return jest.fn(async (path: string) => {
      if (path === '/capabilities') return EXCHANGE_V3_CAPABILITIES;
      if (path === `/grants/${grantId}`) return header();
      if (path.includes('/access')) return page([record]);
      if (path.includes('/statistics/head'))
        return {
          ...fixture.head,
          unchanged: path.includes('knownContentHash=' + fixture.head.content!.contentHash),
        };
      if (path.includes('/pages/'))
        return {
          version: 3,
          generationId: fixture.head.content!.generationId,
          contentHash: fixture.head.content!.contentHash,
          pageIndex: 0,
          rows: fixture.rows,
          nextPageIndex: null,
        };
      throw new Error('Unexpected synthetic remote path');
    });
  }

  it('reuses exact immutable content on health-only polls without rebuilding native rows', async () => {
    const first = await producer.head(grantId, query());
    const rebuild = jest.spyOn(native, 'createGeneration');
    await db.$executeRaw`UPDATE marketplace_bindings SET native_audience_checked_at=now()+interval '1 second' WHERE id=${bindingId}::uuid`;
    const second = await producer.head(grantId, {
      ...query(),
      knownContentHash: first.content!.contentHash,
    });
    expect(second.unchanged).toBe(true);
    expect(second.content).toEqual(first.content);
    expect(rebuild).not.toHaveBeenCalled();
    expect(second.health.find((s) => s.metric === 'AUDIENCE')!.checkedAt).not.toBe(
      first.health.find((s) => s.metric === 'AUDIENCE')!.checkedAt,
    );
  });
  it('stores each page once and reads one indexed page without parsing the native blob', async () => {
    const head = await producer.head(grantId, query());
    const queries: string[] = [];
    const original = db.$queryRaw.bind(db);
    const spy = jest.spyOn(db, '$queryRaw').mockImplementation(((
      ...args: Parameters<typeof db.$queryRaw>
    ) => {
      queries.push(String(args[0]));
      return original(...args);
    }) as typeof db.$queryRaw);
    const result = await producer.page(grantId, head.content!.generationId, 0, query());
    expect(result.rows.length).toBeLessThanOrEqual(200);
    expect(queries.some((q) => q.includes('marketplace_statistics_generations'))).toBe(false);
    expect(
      queries.filter((q) => q.includes('statistics_exchange_v3_generation_pages')),
    ).toHaveLength(1);
    spy.mockRestore();
    const count = await db.$queryRaw<
      Array<{ n: bigint }>
    >`SELECT count(*) AS n FROM statistics_exchange_v3_generation_pages WHERE generation_id=${head.content!.generationId}::uuid`;
    expect(Number(count[0]!.n)).toBe(head.content!.pageCount);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(131072);
  });
  it('publishes corrections/deletions and keeps timed health independent from live views', async () => {
    const first = await producer.head(grantId, query());
    expect(
      first.health.find((s) => s.metric === 'REACH' && s.horizon === 24)!.lastObservationAt,
    ).not.toBeNull();
    expect(
      first.health.find((s) => s.metric === 'REACH' && s.horizon === 48)!.lastObservationAt,
    ).toBeNull();
    await db.channelPost.update({
      where: { chatId_messageId: { chatId: entityId, messageId: 'v3-native' } },
      data: { latestViews: 99 },
    });
    await native.createGeneration((await state.read(bindingId))!);
    const corrected = await producer.head(grantId, query());
    expect(corrected.content!.contentHash).not.toBe(first.content!.contentHash);
    await db.channelPost.delete({
      where: { chatId_messageId: { chatId: entityId, messageId: 'v3-native' } },
    });
    await native.createGeneration((await state.read(bindingId))!);
    const deleted = await producer.head(grantId, query());
    expect(deleted.content!.contentHash).not.toBe(corrected.content!.contentHash);
    expect(
      deleted.content!.scopes.find((s) => s.metric === 'REACH' && s.horizon === 24)!.population,
    ).toBe('EMPTY');
    expect(deleted.content!.scopes.find((s) => s.metric === 'MEMBERSHIP')!.complete).toBe(false);
  });
  it('does not export imported-origin rows and denies a formerly unchanged head after revocation', async () => {
    const head = await producer.head(grantId, query());
    await db.$executeRaw`UPDATE statistics_exchange_entities SET remote_statistics_health='[]'::jsonb WHERE grant_id=${grantId}::uuid`;
    const nativePage = await producer.page(grantId, head.content!.generationId, 0, query());
    expect(nativePage.rows.every((r) => r.origin === 'MAXIM')).toBe(true);
    await db.$executeRaw`UPDATE statistics_exchange_grants SET state='REVOKED' WHERE id=${grantId}::uuid`;
    await expect(
      producer.head(grantId, { ...query(), knownContentHash: head.content!.contentHash }),
    ).rejects.toThrow();
  });
  it('resumes compact access after restart and does not revoke an entity absent from a partial page', async () => {
    const record = await access();
    const remote = jest.fn<ReturnType<ExchangeV3Remote>, Parameters<ExchangeV3Remote>>(
      async (path) =>
        path === `/grants/${grantId}`
          ? header()
          : path.includes('cursor=next')
            ? page([record])
            : page([{ ...record, entityId: '-999999' }], 'next'),
    );
    await consumer.refreshAccess(grantId, 1, remote);
    const afterPartial = (
      await db.$queryRaw<
        Array<{ remote_valid_until: Date; remote_access_cursor: string }>
      >`SELECT e.remote_valid_until,g.remote_access_cursor FROM statistics_exchange_entities e JOIN statistics_exchange_grants g ON g.id=e.grant_id WHERE g.id=${grantId}::uuid`
    )[0]!;
    expect(afterPartial.remote_valid_until.getTime()).toBeGreaterThan(Date.now());
    expect(afterPartial.remote_access_cursor).toBe('next');
    const restarted = new StatisticsExchangeV3ConsumerService(
      db as PrismaService,
      config,
      grants,
      new StatisticsExchangeDownloadsService(db as PrismaService),
    );
    await restarted.refreshAccess(grantId, 1, remote);
    expect(remote.mock.calls.some(([path]) => path.includes('cursor=next'))).toBe(true);
    expect((await grants.binding(grantId, entityId, 'CHANNEL')).binding.id).toBe(bindingId);
  });
  it('applies known access denial before the complete sweep and blocks a late exact proof', async () => {
    const record = await access();
    const remote: ExchangeV3Remote = async (path) =>
      path === `/grants/${grantId}`
        ? header()
        : page([{ ...record, status: 'REVOKED', bindingId: null, validUntil: null }], 'later');
    await consumer.refreshAccess(grantId, 1, remote);
    await expect(grants.binding(grantId, entityId, 'CHANNEL')).rejects.toThrow();
    await expect(consumer.exactAccess(grantId, 1, entityId, 'CHANNEL', remote)).rejects.toThrow();
  });
  it('falls back only on explicitly unsupported capabilities and never on malformed/auth failures', async () => {
    await expect(
      consumer.supported(grantId, async () => {
        throw new ExchangeResponseError(401);
      }),
    ).rejects.toThrow();
    await expect(
      consumer.supported(grantId, async () => ({ supportedVersions: [2] })),
    ).rejects.toThrow();
    await expect(
      consumer.supported(grantId, async () => {
        throw new ExchangeResponseError(404);
      }),
    ).resolves.toBe(false);
  });
  it('imports v3 once and polls unchanged content with zero page fetches and unchanged projection timestamp', async () => {
    const fixture = await reverseFixture(),
      record = await access(),
      remote = reverseRemote(fixture, record);
    const statistics = new StatisticsExchangeStatisticsService(
      db as PrismaService,
      config,
      grants,
      native,
    );
    const activate = (statistics as unknown as { store: ExchangeV3Activate }).store.bind(
      statistics,
    );
    const first = await consumer.pull(grantId, 1, undefined, remote, activate);
    expect(first.completedEntities).toBe(1);
    const prior = (
      await db.$queryRaw<
        Array<{ updated_at: Date; rows: unknown }>
      >`SELECT updated_at,rows FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`
    )[0]!;
    remote.mockClear();
    const second = await consumer.pull(grantId, 1, undefined, remote, activate);
    const after = (
      await db.$queryRaw<
        Array<{ updated_at: Date; rows: unknown }>
      >`SELECT updated_at,rows FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`
    )[0]!;
    expect(second.completedEntities).toBe(0);
    expect(remote.mock.calls.some(([path]) => path.includes('/pages/'))).toBe(false);
    expect(after.updated_at).toEqual(prior.updated_at);
    expect(after.rows).toEqual(prior.rows);
  });
  it('resumes a genuine multi-page v3 generation at page eight after a service restart', async () => {
    const own = await producer.head(grantId, query());
    const rows: ExchangeMeasurement[] = [];
    for (let i = 0; i < own.content!.pageCount; i++)
      rows.push(
        ...(await producer.page(grantId, own.content!.generationId, i, query())).rows.map((r) => ({
          ...r,
          origin: 'EXCHANGE' as const,
          revision: 1,
        })),
      );
    expect(rows.length).toBeGreaterThan(2000);
    const content = exchangeV3ContentSchema.parse({
      ...own.content!,
      generationId: randomUUID(),
      origin: 'EXCHANGE',
      producerRevision: 1,
      sha256: exchangeMeasurementsHash(rows),
      pageCount: Math.ceil(rows.length / 200),
    });
    content.contentHash = createHash('sha256')
      .update(exchangeV3ContentCanonical(content))
      .digest('hex');
    const record = {
      ...(await access()),
      permittedScopes: content.scopes.map((v) =>
        v.metric === 'REACH' ? { metric: v.metric, horizon: v.horizon } : { metric: v.metric },
      ),
    };
    const head: ExchangeV3Head = { ...own, content, bindingRevision: record.bindingRevision };
    let failPageEight = true;
    const indices: number[] = [];
    const remote: ExchangeV3Remote = async (path) => {
      if (path === `/grants/${grantId}`) return header();
      if (path.includes('/access')) return page([record]);
      if (path.includes('/statistics/head')) return head;
      const index = Number(/\/pages\/(\d+)/u.exec(path)?.[1]);
      indices.push(index);
      if (index === 7 && failPageEight) throw new ExchangeResponseError(503);
      return {
        version: 3,
        generationId: content.generationId,
        contentHash: content.contentHash,
        pageIndex: index,
        rows: rows.slice(index * 200, index * 200 + 200),
        nextPageIndex: index + 1 < content.pageCount ? index + 1 : null,
      };
    };
    const statistics = new StatisticsExchangeStatisticsService(
      db as PrismaService,
      config,
      grants,
      native,
    );
    const activate = (statistics as unknown as { store: ExchangeV3Activate }).store.bind(
      statistics,
    );
    for (let i = 0; i < 7; i++) await consumer.pull(grantId, 1, undefined, remote, activate);
    await expect(consumer.pull(grantId, 1, undefined, remote, activate)).rejects.toThrow(
      'EXCHANGE_HTTP_503',
    );
    expect(
      (
        await db.$queryRaw<
          Array<{ page_count: number }>
        >`SELECT page_count FROM statistics_exchange_downloads WHERE grant_id=${grantId}::uuid`
      )[0]!.page_count,
    ).toBe(7);
    expect(
      (
        await db.$queryRaw<
          Array<{ n: bigint }>
        >`SELECT count(*) AS n FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`
      )[0]!.n,
    ).toBe(0n);
    failPageEight = false;
    const restarted = new StatisticsExchangeV3ConsumerService(
      db as PrismaService,
      config,
      grants,
      new StatisticsExchangeDownloadsService(db as PrismaService),
    );
    let completed = 0;
    for (let i = 7; i < content.pageCount; i++)
      completed += (await restarted.pull(grantId, 1, undefined, remote, activate))
        .completedEntities;
    expect(completed).toBe(1);
    expect(indices.filter((i) => i === 0)).toHaveLength(1);
    expect(
      (
        await db.$queryRaw<
          Array<{ n: bigint }>
        >`SELECT count(*) AS n FROM statistics_exchange_downloads WHERE grant_id=${grantId}::uuid`
      )[0]!.n,
    ).toBe(0n);
    const after = await producer.head(grantId, {
      ...query(),
      knownContentHash: own.content!.contentHash,
    });
    expect(after.unchanged).toBe(true);
    expect(after.content).toEqual(own.content);
  });
  it('atomically imports an empty deletion generation and never presents it as measured zero', async () => {
    const fixture = await reverseFixture(),
      record = await access();
    fixture.rows = [];
    fixture.head.content = exchangeV3ContentSchema.parse({
      ...fixture.head.content!,
      rowCount: 0,
      pageCount: 0,
      sha256: exchangeMeasurementsHash([]),
      scopes: [
        {
          metric: 'AUDIENCE',
          coverageFrom: null,
          coverageUntil: null,
          complete: false,
          population: 'UNKNOWN',
          proofObservedAt: null,
        },
      ],
    });
    fixture.head.content.contentHash = createHash('sha256')
      .update(exchangeV3ContentCanonical(fixture.head.content))
      .digest('hex');
    const remote = reverseRemote(fixture, record);
    const statistics = new StatisticsExchangeStatisticsService(
      db as PrismaService,
      config,
      grants,
      native,
    );
    const result = await consumer.pull(
      grantId,
      1,
      undefined,
      remote,
      (statistics as unknown as { store: ExchangeV3Activate }).store.bind(statistics),
    );
    expect(result.completedEntities).toBe(1);
    expect(remote.mock.calls.some(([path]) => path.includes('/pages/'))).toBe(false);
    const stored = (
      await db.$queryRaw<
        Array<{ rows: unknown; v3_content: unknown }>
      >`SELECT rows,v3_content FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`
    )[0]!;
    expect(stored.rows).toEqual([]);
    expect(exchangeV3ContentSchema.parse(stored.v3_content).scopes[0]!.population).toBe('UNKNOWN');
  });
  it('rejects a final access revoke after page delivery without exposing staged content', async () => {
    const fixture = await reverseFixture(),
      record = await access();
    const original = reverseRemote(fixture, record);
    let exactChecks = 0;
    const remote: ExchangeV3Remote = async (path, deadline) => {
      if (path.includes('/access') && ++exactChecks > 1)
        return page([{ ...record, status: 'REVOKED', bindingId: null, validUntil: null }]);
      return original(path, deadline);
    };
    const statistics = new StatisticsExchangeStatisticsService(
      db as PrismaService,
      config,
      grants,
      native,
    );
    await expect(
      consumer.pull(
        grantId,
        1,
        undefined,
        remote,
        (statistics as unknown as { store: ExchangeV3Activate }).store.bind(statistics),
      ),
    ).rejects.toThrow();
    expect(
      (
        await db.$queryRaw<
          Array<{ n: bigint }>
        >`SELECT count(*) AS n FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`
      )[0]!.n,
    ).toBe(0n);
  });
  it('uses the immutable page primary index with representative skewed native history', async () => {
    const head = await producer.head(grantId, query());
    await db.$executeRaw`INSERT INTO statistics_exchange_v3_generations(id,grant_id,grant_revision,entity_id,kind,binding_id,native_generation_id,content_hash,material_hash,context_hash,content,scope_observations,retention_from)
      SELECT gen_random_uuid(),grant_id,grant_revision,entity_id,kind,binding_id,native_generation_id,content_hash,material_hash,context_hash,content,scope_observations,retention_from FROM statistics_exchange_v3_generations CROSS JOIN generate_series(1,1000) s WHERE id=${head.content!.generationId}::uuid`;
    await db.$executeRaw`INSERT INTO statistics_exchange_v3_generation_pages(generation_id,page_index,rows_text,row_count,byte_length,sha256)
      SELECT g.id,p.page_index,p.rows_text,p.row_count,p.byte_length,p.sha256 FROM statistics_exchange_v3_generations g CROSS JOIN statistics_exchange_v3_generation_pages p WHERE g.grant_id=${grantId}::uuid AND g.id<>${head.content!.generationId}::uuid AND p.generation_id=${head.content!.generationId}::uuid`;
    await db.$executeRaw`ANALYZE statistics_exchange_v3_generation_pages`;
    const result = await db.$queryRaw<
      Array<{ 'QUERY PLAN': unknown }>
    >`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT rows_text FROM statistics_exchange_v3_generation_pages WHERE generation_id=${head.content!.generationId}::uuid AND page_index=0`;
    const plan = JSON.stringify(result);
    expect(plan).toContain('Index Scan');
    expect(plan).toContain('statistics_exchange_v3_generation_pages_pkey');
    expect(plan).not.toContain('Seq Scan');
  });
  it('withdraws incompatible imported scopes immediately even when the remote binding stays active', async () => {
    const fixture = await reverseFixture(),
      record = await access(),
      remote = reverseRemote(fixture, record);
    const statistics = new StatisticsExchangeStatisticsService(
      db as PrismaService,
      config,
      grants,
      native,
    );
    await consumer.pull(
      grantId,
      1,
      undefined,
      remote,
      (statistics as unknown as { store: ExchangeV3Activate }).store.bind(statistics),
    );
    const restricted: ExchangeV3Remote = async (path) =>
      path === `/grants/${grantId}`
        ? header(2)
        : page([{ ...record, permittedScopes: [] }], null, 2);
    await consumer.exactAccess(grantId, 1, entityId, 'CHANNEL', restricted);
    const stored = (
      await db.$queryRaw<
        Array<{ visible: boolean; remote_valid_until: Date }>
      >`SELECT p.remote_valid_until>now() AS visible,e.remote_valid_until FROM statistics_exchange_imports p JOIN statistics_exchange_entities e ON e.grant_id=p.grant_id AND e.kind=p.kind AND e.entity_id=p.entity_id WHERE p.grant_id=${grantId}::uuid`
    )[0]!;
    expect(stored.visible).toBe(false);
    expect(stored.remote_valid_until.getTime()).toBeGreaterThan(Date.now());
  });
  it('invalidates a mismatched remote profile instead of retaining an earlier permission', async () => {
    const record = await access();
    const remote: ExchangeV3Remote = async (path) =>
      path === `/grants/${grantId}` ? header() : page([{ ...record, profile: 'publisher' }]);
    await consumer.exactAccess(grantId, 1, entityId, 'CHANNEL', remote);
    await expect(grants.binding(grantId, entityId, 'CHANNEL')).rejects.toThrow();
  });
  it('retains a pinned archive when only the peer binding check revision changes between pages', async () => {
    const fixture = await reverseFixture(),
      record = await access();
    const original = reverseRemote(fixture, record);
    let checks = 0;
    const remote: ExchangeV3Remote = async (path, deadline) => {
      if (path.includes('/access'))
        return page([{ ...record, bindingRevision: record.bindingRevision + checks++ }]);
      return original(path, deadline);
    };
    const statistics = new StatisticsExchangeStatisticsService(
      db as PrismaService,
      config,
      grants,
      native,
    );
    const result = await consumer.pull(
      grantId,
      1,
      undefined,
      remote,
      (statistics as unknown as { store: ExchangeV3Activate }).store.bind(statistics),
    );
    expect(result.completedEntities).toBe(1);
  });
});
