import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  type ExchangeGrantInput,
  type ExchangeMeasurement,
  type ExchangeStatisticsPage,
  exchangeManifestSchema,
} from '@maxim/contracts';
import { PrismaClient, createPrismaAdapter } from '../../prisma/prisma-client';
import { type PrismaService } from '../../prisma/prisma.service';
import { MarketplaceStateService } from './marketplace-state.service';
import { MarketplaceStatisticsService } from './marketplace-statistics.service';
import { type MarketplaceAccessService } from './marketplace-access.service';
import { exchangeRetentionFrom } from './statistics-exchange-values';
import { StatisticsExchangeGrantsService } from './statistics-exchange-grants.service';
import { StatisticsExchangeStatisticsService } from './statistics-exchange-statistics.service';
import { StatisticsExchangeAudienceService } from './statistics-exchange-audience.service';
import { StatisticsExchangeRuntimeService } from './statistics-exchange-runtime.service';
import { MarketplaceIntegrationController } from './marketplace.controller';
import {
  canonicalExchangeMeasurements,
  exchangeMeasurementsHash,
} from './statistics-exchange-values';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);
postgres('statistics exchange PostgreSQL consent and immutable observations', () => {
  let db: PrismaClient,
    state: MarketplaceStateService,
    grants: StatisticsExchangeGrantsService,
    statistics: StatisticsExchangeStatisticsService;
  let grantId: string, bindingId: string, entityId: string, actor: string;
  let attest: jest.MockedFunction<MarketplaceAccessService['attest']>;
  const config = new ConfigService({
    SVYAZKA_ANALYTICS_TOKEN: 'a'.repeat(64),
    SVYAZKA_PROFILE_TOKEN: 'b'.repeat(64),
    SVYAZKA_STATISTICS_EXPORT_TOKEN: 'c'.repeat(64),
    SVYAZKA_STATISTICS_V2_USERS: '*',
  });
  const input = (
    revision = 1,
    stateInput: 'ACTIVE' | 'REVOKED' = 'ACTIVE',
  ): ExchangeGrantInput => ({
    grantId,
    actorUserId: actor,
    revision,
    state: stateInput,
    entities: stateInput === 'ACTIVE' ? [{ entityId, kind: 'CHANNEL', profile: 'moderation' }] : [],
  });
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable race_test database required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 3, statement_timeout: 10_000 }),
    });
    await db.$connect();
    state = new MarketplaceStateService(db as PrismaService, config);
    attest = jest.fn<
      ReturnType<MarketplaceAccessService['attest']>,
      Parameters<MarketplaceAccessService['attest']>
    >(async () => {
      const binding = await state.read(bindingId);
      if (!binding) throw new Error('Synthetic binding absent');
      return binding;
    });
    grants = new StatisticsExchangeGrantsService(
      db as PrismaService,
      config,
      { attest } as unknown as MarketplaceAccessService,
      state,
    );
    statistics = new StatisticsExchangeStatisticsService(
      db as PrismaService,
      config,
      grants,
      new MarketplaceStatisticsService(db as PrismaService, state),
    );
  });
  beforeEach(async () => {
    attest.mockClear();
    grantId = randomUUID();
    bindingId = randomUUID();
    actor = String(Date.now()) + String(Math.floor(Math.random() * 1000));
    entityId = '-' + actor;
    await db.chat.create({
      data: { id: entityId, title: 'Synthetic statistics channel', entityType: 'CHANNEL' },
    });
    await db.chatBotMembership.create({
      data: {
        chatId: entityId,
        botId: 'synthetic-v2-bot',
        status: 'ACTIVE',
        botAccessState: 'CONFIRMED_ADMIN',
      },
    });
    const now = new Date(),
      from = new Date(now);
    from.setUTCHours(0, 0, 0, 0);
    from.setUTCDate(from.getUTCDate() - 89);
    const metadata = {
      title: 'Synthetic statistics channel',
      description: '',
      imageUrl: null,
      publicUrl: null,
      audience: 100,
      isPublic: true,
    };
    await db.$executeRaw`INSERT INTO marketplace_bindings(id,actor_user_id,entity_id,kind,profile,bot_id,state,checked_at,valid_until,metadata,history_complete,history_from,history_to)
      VALUES(${bindingId}::uuid,${actor},${entityId},'CHANNEL','moderation','synthetic-v2-bot','ACTIVE',${now},${new Date(now.getTime() + 300_000)},${JSON.stringify(metadata)}::jsonb,true,${from},${now})`;
    const published = new Date(now.getTime() - 3 * 86400_000);
    published.setUTCHours(8, 0, 0, 0);
    await db.channelPost.create({
      data: {
        chatId: entityId,
        messageId: 'synthetic-post',
        publishedAt: published,
        latestViews: 10,
        latestSnapshotAt: now,
        viewsAt24h: 5,
        viewsAt24hCapturedAt: new Date(published.getTime() + 86400_000 + 300_000),
      },
    });
    await db.$executeRaw`INSERT INTO marketplace_audience_observations(binding_id,bucket,audience,observed_at) VALUES(${bindingId}::uuid,date_trunc('hour',now()),100,now())`;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
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
  async function nativeAll() {
    let page = await statistics.page(grantId, { entityId, kind: 'CHANNEL' });
    const rows = [...page.rows],
      manifest = page.manifest;
    while (page.nextCursor) {
      page = await statistics.page(grantId, {
        entityId,
        kind: 'CHANNEL',
        generationId: manifest.generationId,
        cursor: page.nextCursor,
      });
      rows.push(...page.rows);
    }
    return { manifest, rows };
  }
  async function remoteFixture(): Promise<ExchangeStatisticsPage> {
    const own = await nativeAll();
    const data = own.rows.find((row) => row.data.metric === 'AUDIENCE')!.data;
    const rows: ExchangeMeasurement[] = canonicalExchangeMeasurements([
      {
        origin: 'EXCHANGE',
        method: 'utc-buckets-v1',
        revision: 1,
        data: { ...data, metric: 'AUDIENCE', value: 777 },
      },
    ]);
    const manifest = exchangeManifestSchema.parse({
      ...own.manifest,
      generationId: randomUUID(),
      bindingId,
      origin: 'EXCHANGE',
      producerRevision: 1,
      rowCount: rows.length,
      sha256: exchangeMeasurementsHash(rows),
      metrics: own.manifest.metrics.filter((metric) => metric.metric === 'AUDIENCE'),
    });
    return { manifest, rows, nextCursor: null };
  }
  function mockRemote(page: ExchangeStatisticsPage) {
    return jest.spyOn(globalThis, 'fetch').mockImplementation(async (raw) => {
      const url = String(raw);
      return new Response(
        JSON.stringify(url.includes('/statistics?') ? page : await grants.read(grantId)),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
  }
  it('mirrors monotonic consent idempotently and fences revocation without resurrecting a prior revision', async () => {
    expect((await grants.put(grantId, input())).entities[0]?.status).toBe('ACTIVE');
    const revision = (await state.read(bindingId))!.revision;
    await grants.put(grantId, input());
    expect((await state.read(bindingId))!.revision).toBe(revision);
    await expect(grants.put(grantId, { ...input(), entities: [] })).rejects.toThrow(
      'Версия согласия уже использована',
    );
    expect((await grants.put(grantId, input(2, 'REVOKED'))).entities).toEqual([]);
    expect((await state.read(bindingId))!.statistics_consent).toBe(false);
    await expect(grants.put(grantId, input())).rejects.toThrow('Версия согласия устарела');
    await expect(statistics.page(grantId, { entityId, kind: 'CHANNEL' })).rejects.toThrow(
      'Обмен отключён',
    );
  });
  it('preserves independent v1 consent when v2 is revoked', async () => {
    await db.$executeRaw`UPDATE marketplace_bindings SET statistics_consent=true WHERE id=${bindingId}::uuid`;
    await grants.put(grantId, input());
    await grants.put(grantId, input(2, 'REVOKED'));
    expect((await state.read(bindingId))!.statistics_consent).toBe(true);
  });
  it('does not reenable an explicit legacy revoke through new selections, attestation, or unavailable recovery', async () => {
    await grants.put(grantId, input());
    const controller = new MarketplaceIntegrationController(
      {} as MarketplaceAccessService,
      state,
      {} as MarketplaceStatisticsService,
      db as PrismaService,
    );
    await controller.revoke(bindingId, {
      requestId: randomUUID(),
      expectedRevision: (await state.read(bindingId))!.revision,
    });
    const denied = (await state.read(bindingId))!.statistics_revoked_at;
    expect(denied).toBeInstanceOf(Date);
    await db.$executeRaw`UPDATE marketplace_bindings SET state='ACTIVE',checked_at=now(),valid_until=now()+interval '5 minutes' WHERE id=${bindingId}::uuid`;
    expect(await state.hasActiveAccess(bindingId)).toBe(true);
    expect((await grants.put(grantId, input(2))).entities[0]?.status).toBe('UNAVAILABLE');
    expect((await state.read(bindingId))!).toMatchObject({
      statistics_consent: false,
      statistics_revoked_at: denied,
    });
    await db.$executeRaw`UPDATE statistics_exchange_entities SET binding_id=NULL,next_check_at=now() WHERE grant_id=${grantId}::uuid`;
    expect(await grants.recoverUnavailable(grantId)).toBe(true);
    expect((await grants.read(grantId)).entities[0]?.binding).toBeNull();
    expect((await state.read(bindingId))!).toMatchObject({
      statistics_consent: false,
      statistics_revoked_at: denied,
    });
    expect(await state.hasActiveGrant(bindingId)).toBe(false);
    await expect(nativeAll()).rejects.toThrow('Доступ');
  });
  it('bounds initial handshake, isolates peer expiry from native access and invalidates proven remote loss', async () => {
    await grants.put(grantId, input());
    expect((await nativeAll()).rows.length).toBeGreaterThan(0);
    const fixture = await remoteFixture(),
      remote = mockRemote(fixture);
    await statistics.pull(grantId, 1);
    const audience = new StatisticsExchangeAudienceService(db as PrismaService, config, state);
    expect(await audience.importedAudience(actor, entityId, 'CHANNEL')).toHaveLength(1);
    const expire = async () => {
      await db.$executeRaw`UPDATE statistics_exchange_entities SET remote_valid_until=now()-interval '1 second' WHERE grant_id=${grantId}::uuid`;
      await db.$executeRaw`UPDATE statistics_exchange_imports SET remote_valid_until=now()-interval '1 second' WHERE grant_id=${grantId}::uuid`;
      await db.$executeRaw`UPDATE marketplace_bindings SET checked_at=now(),valid_until=now()+interval '5 minutes' WHERE id=${bindingId}::uuid`;
    };
    await expire();
    await grants.put(grantId, input()); // An idempotent retry cannot extend the initial peer proof.
    expect(await audience.importedAudience(actor, entityId, 'CHANNEL')).toEqual([]);
    expect((await grants.read(grantId)).entities[0]?.status).toBe('ACTIVE'); // Own rights stay readable for mutual expiry recovery.
    await expect(statistics.page(grantId, { entityId, kind: 'CHANNEL' })).rejects.toThrow('Доступ');
    await expect(statistics.selected(grantId, entityId, 'CHANNEL')).rejects.toThrow('Доступ');
    expect(await state.hasActiveGrant(bindingId)).toBe(true);
    expect(
      await new MarketplaceStatisticsService(db as PrismaService, state).createGeneration(
        (await state.read(bindingId))!,
      ),
    ).toEqual(expect.any(String));
    await statistics.refreshRemoteAccess(grantId, 1); // Recovery requires a fresh peer GET, with no new PUT revision.
    expect((await grants.row(grantId))!.revision).toBe(1n);
    expect(await audience.importedAudience(actor, entityId, 'CHANNEL')).toHaveLength(1);
    expect((await nativeAll()).rows.length).toBeGreaterThan(0);
    await expire();
    remote.mockRejectedValueOnce(new Error('synthetic peer outage'));
    await expect(statistics.refreshRemoteAccess(grantId, 1)).rejects.toThrow(
      'synthetic peer outage',
    );
    expect(await audience.importedAudience(actor, entityId, 'CHANNEL')).toEqual([]);
    await expect(statistics.page(grantId, { entityId, kind: 'CHANNEL' })).rejects.toThrow('Доступ');
    await statistics.refreshRemoteAccess(grantId, 1);
    remote.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ ...(await grants.read(grantId)), state: 'REVOKED' })),
    );
    await expect(statistics.refreshRemoteAccess(grantId, 1)).rejects.toThrow('второй стороны');
    expect(await audience.importedAudience(actor, entityId, 'CHANNEL')).toEqual([]);
    await expect(statistics.page(grantId, { entityId, kind: 'CHANNEL' })).rejects.toThrow('Доступ');
    expect(await state.hasActiveGrant(bindingId)).toBe(true);
  });

  it('keeps partial peer permission and revision/binding proof scoped to one selected entity', async () => {
    const otherId = '-' + (BigInt(actor) + 1n).toString();
    await grants.put(grantId, {
      ...input(),
      entities: [
        { entityId, kind: 'CHANNEL', profile: 'moderation' },
        { entityId: otherId, kind: 'CHANNEL', profile: 'moderation' },
      ],
    });
    const fixture = await remoteFixture();
    mockRemote(fixture);
    await statistics.refreshRemoteAccess(grantId, 1);
    const proof = await db.$queryRaw<
      Array<{ entity_id: string; valid: boolean }>
    >`SELECT entity_id,remote_valid_until>now() AS valid FROM statistics_exchange_entities WHERE grant_id=${grantId}::uuid ORDER BY entity_id`;
    expect(proof.find((row) => row.entity_id === entityId)?.valid).toBe(true);
    expect(proof.find((row) => row.entity_id === otherId)?.valid).toBe(false);
    const remote = jest.mocked(globalThis.fetch);
    remote.mockImplementationOnce(
      async () => new Response(JSON.stringify({ ...(await grants.read(grantId)), revision: 2 })),
    );
    await expect(statistics.refreshRemoteAccess(grantId, 1)).rejects.toThrow('второй стороны');
    await expect(statistics.page(grantId, { entityId, kind: 'CHANNEL' })).rejects.toThrow('Доступ');
  });
  it('rejects an older active peer response after a newer denial at the same grant revision', async () => {
    await grants.put(grantId, input());
    const active = await grants.read(grantId);
    let started!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remote = jest.spyOn(globalThis, 'fetch');
    remote.mockImplementationOnce(async () => {
      started();
      await held;
      return new Response(JSON.stringify(active));
    });
    const delayed = statistics.refreshRemoteAccess(grantId, 1);
    await waiting;
    remote.mockImplementationOnce(
      async () => new Response(JSON.stringify({ ...active, state: 'REVOKED' })),
    );
    try {
      await expect(statistics.refreshRemoteAccess(grantId, 1)).rejects.toThrow('второй стороны');
      release();
      await expect(delayed).rejects.toThrow('проверка доступа');
      await expect(statistics.page(grantId, { entityId, kind: 'CHANNEL' })).rejects.toThrow(
        'Доступ',
      );
      const proof = await db.$queryRaw<
        Array<{ valid: boolean }>
      >`SELECT remote_valid_until>now() AS valid FROM statistics_exchange_entities WHERE grant_id=${grantId}::uuid`;
      expect(proof[0]!.valid).toBe(false);
    } finally {
      release();
      await delayed.catch(() => undefined);
    }
  });
  it('never transfers imported authority to a changed peer binding and honors its shorter expiry', async () => {
    await grants.put(grantId, input());
    const fixture = await remoteFixture(),
      remote = mockRemote(fixture);
    await statistics.pull(grantId, 1);
    const active = await grants.read(grantId),
      changedId = randomUUID(),
      until = new Date(Date.now() + 30_000).toISOString();
    active.entities[0]!.binding = {
      ...active.entities[0]!.binding!,
      id: changedId,
      validUntil: until,
    };
    remote.mockImplementationOnce(async () => new Response(JSON.stringify(active)));
    await statistics.refreshRemoteAccess(grantId, 1);
    const audience = new StatisticsExchangeAudienceService(db as PrismaService, config, state);
    expect(await audience.importedAudience(actor, entityId, 'CHANNEL')).toEqual([]);
    expect((await nativeAll()).rows.length).toBeGreaterThan(0);
    const proof = await db.$queryRaw<
      Array<{ remote_binding_id: string; remote_valid_until: Date }>
    >`SELECT remote_binding_id,remote_valid_until FROM statistics_exchange_entities WHERE grant_id=${grantId}::uuid`;
    expect(proof[0]!.remote_binding_id).toBe(changedId);
    expect(proof[0]!.remote_valid_until.toISOString()).toBe(until);
  });
  it('rechecks the complete grant at final selected read even when independent native consent survives', async () => {
    await db.$executeRaw`UPDATE marketplace_bindings SET statistics_consent=true WHERE id=${bindingId}::uuid`;
    await grants.put(grantId, input());
    const binding = grants.binding.bind(grants);
    let calls = 0;
    jest.spyOn(grants, 'binding').mockImplementation(async (...args) => {
      const result = await binding(...args);
      calls++;
      if (calls === 3) await grants.put(grantId, input(2, 'REVOKED'));
      return result;
    });
    await expect(statistics.selected(grantId, entityId, 'CHANNEL')).rejects.toThrow(
      'Доступ изменился',
    );
    expect(await state.hasActiveGrant(bindingId)).toBe(true);
  });
  it('exports immutable complete generations with native origin and bound cursors', async () => {
    await grants.put(grantId, input());
    const first = await nativeAll();
    expect(first.rows.length).toBe(first.manifest.rowCount);
    expect(exchangeMeasurementsHash(first.rows)).toBe(first.manifest.sha256);
    expect(first.rows.every((row) => row.origin === 'MAXIM')).toBe(true);
    await db.channelPost.updateMany({ where: { chatId: entityId }, data: { latestViews: 900 } });
    const second = await nativeAll();
    expect(second.manifest.generationId).not.toBe(first.manifest.generationId);
    const frozen = await statistics.page(grantId, {
      entityId,
      kind: 'CHANNEL',
      generationId: first.manifest.generationId,
    });
    expect(frozen.manifest.sha256).toBe(first.manifest.sha256);
  });
  it('imports only original EXCHANGE generations without native overwrite or export echo', async () => {
    await grants.put(grantId, input());
    const page = await remoteFixture();
    mockRemote(page);
    await statistics.pull(grantId, 1);
    await statistics.pull(grantId, 1);
    const imported = await db.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT count(*) AS count FROM statistics_exchange_generations WHERE grant_id=${grantId}::uuid AND origin='EXCHANGE'`;
    expect(imported[0]!.count).toBe(1n);
    expect((await nativeAll()).rows.some((row) => row.origin !== 'MAXIM')).toBe(false);
    expect((await db.channelPost.findFirst({ where: { chatId: entityId } }))!.latestViews).toBe(10);
    const own = await state.read(bindingId);
    expect(own!.collection_owner).toBe('SHADOW');
    const projection = await db.$queryRaw<
      Array<{ rows: ExchangeMeasurement[] }>
    >`SELECT rows FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`;
    expect(projection[0]!.rows).toEqual(page.rows);
  });
  it('omits post capabilities for private channels and refuses old public generations after visibility changes', async () => {
    await grants.put(grantId, input());
    const publicPage = await nativeAll();
    expect(publicPage.rows.some((row) => row.data.metric === 'REACH')).toBe(true);
    await db.$executeRaw`UPDATE marketplace_bindings SET metadata=jsonb_set(metadata,'{isPublic}','false') WHERE id=${bindingId}::uuid`;
    const privatePage = await nativeAll();
    expect(
      privatePage.rows.every(
        (row) => row.data.metric === 'AUDIENCE' || row.data.metric === 'MEMBERSHIP',
      ),
    ).toBe(true);
    expect(privatePage.manifest.metrics.map((row) => row.metric)).toEqual([
      'AUDIENCE',
      'MEMBERSHIP',
    ]);
    await expect(
      statistics.page(grantId, {
        entityId,
        kind: 'CHANNEL',
        generationId: publicPage.manifest.generationId,
      }),
    ).rejects.toThrow('Показатели недоступны');
  });

  it('does not hide a recorded collector failure behind an unchanged export generation', async () => {
    await grants.put(grantId, input());
    const success = await nativeAll();
    expect(success.manifest.metrics.every((metric) => !metric.error)).toBe(true);
    await db.$executeRaw`UPDATE marketplace_bindings SET collection_error='COLLECTION_UNAVAILABLE' WHERE id=${bindingId}::uuid`;
    const failed = await nativeAll();
    expect(failed.manifest.generationId).not.toBe(success.manifest.generationId);
    expect(
      failed.manifest.metrics.filter((metric) => metric.error).map((metric) => metric.metric),
    ).toEqual(['AUDIENCE', 'REACH', 'PUBLICATION_HOUR']);
    expect(failed.manifest.metrics.map((metric) => metric.checkedAt)).toEqual(
      success.manifest.metrics.map((metric) => metric.checkedAt),
    );
    await db.$executeRaw`UPDATE marketplace_bindings SET collection_error='POST_STATISTICS_UNAVAILABLE' WHERE id=${bindingId}::uuid`;
    const partial = await nativeAll();
    expect(
      partial.manifest.metrics.filter((metric) => metric.error).map((metric) => metric.metric),
    ).toEqual(['REACH', 'PUBLICATION_HOUR']);
    expect(partial.manifest.metrics.find((metric) => metric.metric === 'AUDIENCE')?.checkedAt).toBe(
      success.manifest.metrics.find((metric) => metric.metric === 'AUDIENCE')?.checkedAt,
    );
  });
  it('rejects checksum corruption and prevents import after revoke during an external read', async () => {
    await grants.put(grantId, input());
    const page = await remoteFixture();
    const mock = mockRemote({ ...page, manifest: { ...page.manifest, sha256: '0'.repeat(64) } });
    await expect(statistics.pull(grantId, 1)).rejects.toThrow('EXCHANGE_CHECKSUM_MISMATCH');
    mock.mockImplementation(async (raw) => {
      if (String(raw).includes('/statistics?')) {
        await grants.put(grantId, input(2, 'REVOKED'));
        return new Response(JSON.stringify(page));
      }
      return new Response(JSON.stringify(await grants.read(grantId)));
    });
    await expect(statistics.pull(grantId, 1)).rejects.toThrow('Согласие изменилось');
    const imported = await db.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT count(*) AS count FROM statistics_exchange_generations WHERE grant_id=${grantId}::uuid AND origin='EXCHANGE'`;
    expect(imported[0]!.count).toBe(0n);
  });
  function remoteGeneration(
    page: ExchangeStatisticsPage,
    rows: ExchangeMeasurement[],
    revision: number,
    from = page.manifest.from,
  ): ExchangeStatisticsPage {
    const canonical = canonicalExchangeMeasurements(rows.map((row) => ({ ...row, revision })));
    return {
      manifest: exchangeManifestSchema.parse({
        ...page.manifest,
        generationId: randomUUID(),
        producerRevision: revision,
        from,
        rowCount: canonical.length,
        sha256: exchangeMeasurementsHash(canonical),
      }),
      rows: canonical,
      nextCursor: null,
    };
  }
  it('replaces only the declared interval, preserves prior buckets and ignores delayed lower producer versions', async () => {
    await grants.put(grantId, input());
    const fixture = await remoteFixture(),
      today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const yesterday = new Date(today.getTime() - 86400_000).toISOString(),
      bucket = today.toISOString();
    const observation = (at: string, value: number): ExchangeMeasurement => ({
      origin: 'EXCHANGE',
      method: 'utc-buckets-v1',
      revision: 1,
      data: { metric: 'AUDIENCE', bucket: at, observedAt: at, value },
    });
    const first = remoteGeneration(
      fixture,
      [
        observation(yesterday, 701),
        observation(bucket, 702),
        {
          origin: 'EXCHANGE',
          method: 'utc-buckets-v1',
          revision: 1,
          data: {
            metric: 'MEMBERSHIP',
            bucket,
            observedAt: bucket,
            joined: 3,
            left: 1,
            complete: false,
          },
        },
      ],
      1,
      yesterday,
    );
    first.manifest.metrics.push({
      metric: 'MEMBERSHIP',
      checkedAt: bucket,
      nextExpectedAt: bucket,
      complete: false,
      error: false,
    });
    const remote = mockRemote(first);
    await statistics.pull(grantId, 1);
    const corrected = remoteGeneration(fixture, [observation(bucket, 999)], 2, bucket);
    remote.mockImplementation(
      async (raw) =>
        new Response(
          JSON.stringify(
            String(raw).includes('/statistics?') ? corrected : await grants.read(grantId),
          ),
        ),
    );
    await statistics.pull(grantId, 1);
    const readProjection = async () =>
      (
        await db.$queryRaw<
          Array<{ rows: ExchangeMeasurement[] }>
        >`SELECT rows FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`
      )[0]!.rows;
    expect(
      (await readProjection()).map((row) =>
        row.data.metric === 'AUDIENCE' ? [row.data.bucket, row.data.value, row.revision] : null,
      ),
    ).toEqual([
      [yesterday, 701, 1],
      [bucket, 999, 2],
    ]);
    remote.mockImplementation(
      async (raw) =>
        new Response(
          JSON.stringify(String(raw).includes('/statistics?') ? first : await grants.read(grantId)),
        ),
    );
    await statistics.pull(grantId, 1);
    expect(
      (await readProjection()).map((row) =>
        row.data.metric === 'AUDIENCE' ? row.data.value : null,
      ),
    ).toEqual([701, 999]);
    const immutable = await db.$queryRaw<
      Array<{ manifest: ExchangeStatisticsPage['manifest']; rows: ExchangeMeasurement[] }>
    >`SELECT manifest,rows FROM statistics_exchange_generations WHERE id=${corrected.manifest.generationId}::uuid`;
    expect(immutable[0]!.rows).toEqual(corrected.rows);
    expect(exchangeMeasurementsHash(immutable[0]!.rows)).toBe(immutable[0]!.manifest.sha256);
    // Transport expiry must not let an old original overwrite the materialized producer fence.
    await db.$executeRaw`DELETE FROM statistics_exchange_generations WHERE grant_id=${grantId}::uuid AND origin='EXCHANGE'`;
    await statistics.pull(grantId, 1);
    expect(
      (await readProjection()).map((row) =>
        row.data.metric === 'AUDIENCE' ? row.data.value : null,
      ),
    ).toEqual([701, 999]);
  });

  it('keeps100actor rights and reverse work bounded and independent under archive latency', async () => {
    const seed = randomUUID(),
      previousRole = process.env.APP_ROLE;
    process.env.APP_ROLE = 'action';
    const prefix = actor + 'x';
    let releaseReverse!: () => void;
    const slowReverse = new Promise<void>((resolve) => {
      releaseReverse = resolve;
    });
    const refreshed = new Set<string>(),
      pulled = new Set<string>(),
      remoteChecked = new Set<string>();
    let remoteInFlight = 0,
      remoteMaximum = 0;
    const refreshRemoteAccess = jest.fn<
      ReturnType<StatisticsExchangeStatisticsService['refreshRemoteAccess']>,
      Parameters<StatisticsExchangeStatisticsService['refreshRemoteAccess']>
    >(async (id) => {
      remoteInFlight++;
      remoteMaximum = Math.max(remoteMaximum, remoteInFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      remoteChecked.add(id);
      remoteInFlight--;
    });
    let inFlight = 0,
      maximum = 0;
    const refresh = jest.fn<
      ReturnType<MarketplaceAccessService['refresh']>,
      Parameters<MarketplaceAccessService['refresh']>
    >(async (row) => {
      inFlight++;
      maximum = Math.max(maximum, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      refreshed.add(row.id);
      inFlight--;
    });
    const pull = jest.fn<
      ReturnType<StatisticsExchangeStatisticsService['pull']>,
      Parameters<StatisticsExchangeStatisticsService['pull']>
    >(async (id) => {
      pulled.add(id);
      if (pulled.size <= 4) await slowReverse;
      return { failures: 0, nextCursor: null };
    });
    const recoverUnavailable = jest
      .fn<
        ReturnType<StatisticsExchangeGrantsService['recoverUnavailable']>,
        Parameters<StatisticsExchangeGrantsService['recoverUnavailable']>
      >()
      .mockResolvedValue(false);
    const runtime = new StatisticsExchangeRuntimeService(
      db as PrismaService,
      config,
      { pull, refreshRemoteAccess } as unknown as StatisticsExchangeStatisticsService,
      { recoverUnavailable } as unknown as StatisticsExchangeGrantsService,
      { refresh } as unknown as MarketplaceAccessService,
    );
    try {
      await db.$executeRaw`INSERT INTO marketplace_bindings(id,actor_user_id,entity_id,kind,profile,bot_id,state,checked_at,valid_until,metadata,statistics_consent,next_access_at)
        SELECT md5(${seed}||'binding'||n)::uuid,${prefix}||n,'-'||n,'CHANNEL','moderation','synthetic-v2-bot','ACTIVE',now(),now()+interval '5 minutes','{}'::jsonb,true,now()-interval '1 minute' FROM generate_series(1,100)n`;
      await db.$executeRaw`INSERT INTO statistics_exchange_grants(id,actor_user_id,revision,state,input_hash)
        SELECT md5(${seed}||'grant'||n)::uuid,${prefix}||n,1,'ACTIVE','synthetic' FROM generate_series(1,100)n`;
      await db.$executeRaw`INSERT INTO statistics_exchange_entities(grant_id,entity_id,kind,profile,binding_id)
        SELECT md5(${seed}||'grant'||n)::uuid,'-'||n,'CHANNEL','moderation',md5(${seed}||'binding'||n)::uuid FROM generate_series(1,100)n`;
      const stalled = runtime.tick();
      const start = Date.now();
      for (let batch = 0; batch < 5; batch++) await runtime.refreshAccessBatch();
      for (let batch = 0; batch < 25; batch++) await runtime.refreshRemoteAccessBatch();
      expect(remoteChecked.size).toBe(100);
      expect(remoteMaximum).toBe(4);
      expect(pulled.size).toBe(4);
      expect(refreshed.size).toBe(100);
      expect(maximum).toBe(4);
      expect(Date.now() - start).toBeLessThan(10_000);
      releaseReverse();
      await stalled;
      for (let batch = 0; batch < 24; batch++) await runtime.tick();
      expect(pulled.size).toBe(100);
      expect(refresh.mock.calls.every(([, exchangeV2]) => exchangeV2 === true)).toBe(true);
    } finally {
      releaseReverse();
      if (previousRole === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = previousRole;
      await db.$executeRaw`DELETE FROM statistics_exchange_entities WHERE grant_id IN(SELECT id FROM statistics_exchange_grants WHERE actor_user_id LIKE ${prefix + '%'})`;
      await db.$executeRaw`DELETE FROM statistics_exchange_grants WHERE actor_user_id LIKE ${prefix + '%'}`;
      await db.$executeRaw`DELETE FROM marketplace_bindings WHERE actor_user_id LIKE ${prefix + '%'}`;
    }
  });

  it('serves100entity discovery and grant acknowledgement without synchronous MAX probes', async () => {
    const prefix = entityId + '9';
    try {
      await db.$executeRaw`INSERT INTO chats(id,title,entity_type,updated_at) SELECT ${prefix}||lpad(n::text,3,'0'),'Synthetic entity','CHANNEL',now() FROM generate_series(1,100)n`;
      await db.$executeRaw`INSERT INTO chat_bot_memberships(id,chat_id,bot_id,status,updated_at) SELECT ${prefix}||lpad(n::text,3,'0'),${prefix}||lpad(n::text,3,'0'),'synthetic-v2-bot','ACTIVE',now() FROM generate_series(1,100)n`;
      await db.$executeRaw`INSERT INTO managed_entity_access_edges(chat_id,user_id,bot_id,state,user_role,bot_role,updated_at) SELECT ${prefix}||lpad(n::text,3,'0'),${actor},'synthetic-v2-bot','GRANTED','ADMIN','ADMIN',now() FROM generate_series(1,100)n`;
      const start = Date.now();
      const discovered = await grants.discover({ actorUserId: actor });
      expect(discovered.entities).toHaveLength(100);
      const result = await grants.put(grantId, {
        ...input(),
        entities: discovered.entities.map(({ entityId, kind, profile }) => ({
          entityId,
          kind,
          profile,
        })),
      });
      expect(result.entities).toHaveLength(100);
      expect(result.entities.every((entity) => entity.status === 'UNAVAILABLE')).toBe(true);
      expect(attest).not.toHaveBeenCalled();
      expect(Date.now() - start).toBeLessThan(5000);
    } finally {
      await db.$executeRaw`DELETE FROM statistics_exchange_entities WHERE grant_id=${grantId}::uuid`;
      await db.chat.deleteMany({ where: { id: { startsWith: prefix } } });
    }
  });

  it('filters and prunes expired imported observations while retaining the producer fence', async () => {
    await grants.put(grantId, input());
    const page = await remoteFixture();
    mockRemote(page);
    await statistics.pull(grantId, 1);
    const expired = {
      ...page.rows[0]!,
      data: {
        ...page.rows[0]!.data,
        bucket: '2020-01-01T00:00:00.000Z',
        observedAt: '2020-01-01T00:00:00.000Z',
      },
    };
    await db.$executeRaw`UPDATE statistics_exchange_imports SET rows=${JSON.stringify([expired, ...page.rows])}::jsonb WHERE grant_id=${grantId}::uuid`;
    expect(
      await new StatisticsExchangeAudienceService(
        db as PrismaService,
        config,
        state,
      ).importedAudience(actor, entityId, 'CHANNEL'),
    ).toHaveLength(1);
    const lease = randomUUID();
    await db.$executeRaw`UPDATE statistics_exchange_grants SET lease_id=${lease}::uuid,lease_until=now()+interval '2 minutes' WHERE id=${grantId}::uuid`;
    const runtime = new StatisticsExchangeRuntimeService(
      db as PrismaService,
      config,
      statistics,
      grants,
    );
    await runtime.prune(grantId, lease);
    const current = await db.$queryRaw<
      Array<{ rows: ExchangeMeasurement[]; producer_revision: bigint }>
    >`SELECT rows,producer_revision FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`;
    expect(current[0]!.rows.every((row) => row.data.bucket >= exchangeRetentionFrom())).toBe(true);
    expect(current[0]!.producer_revision).toBe(1n);
  });

  it('does not let one denied recovery head starve another selected entity', async () => {
    const secondId = '-' + (BigInt(actor) + 1n).toString();
    await grants.put(grantId, {
      ...input(),
      entities: [
        { entityId, kind: 'CHANNEL', profile: 'moderation' },
        { entityId: secondId, kind: 'CHANNEL', profile: 'moderation' },
      ],
    });
    await db.$executeRaw`UPDATE statistics_exchange_entities SET binding_id=NULL WHERE grant_id=${grantId}::uuid`;
    attest
      .mockRejectedValueOnce(new Error('synthetic unavailable'))
      .mockRejectedValueOnce(new Error('synthetic unavailable'));
    await expect(grants.recoverUnavailable(grantId)).rejects.toThrow('synthetic unavailable');
    await expect(grants.recoverUnavailable(grantId)).rejects.toThrow('synthetic unavailable');
    expect(
      new Set(attest.mock.calls.map(([raw]) => (raw as { entityId: string }).entityId)).size,
    ).toBe(2);
  });
  it('refuses mismatched remote binding identity and generation publication after lease loss', async () => {
    await grants.put(grantId, input());
    const fixture = await remoteFixture();
    const remote = mockRemote({
      ...fixture,
      manifest: { ...fixture.manifest, bindingId: randomUUID() },
    });
    await expect(statistics.pull(grantId, 1)).rejects.toThrow('EXCHANGE_IDENTITY_MISMATCH');
    const lease = randomUUID();
    await db.$executeRaw`UPDATE statistics_exchange_grants SET lease_id=${lease}::uuid,lease_until=now()+interval '2 minutes' WHERE id=${grantId}::uuid`;
    remote.mockImplementation(async (raw) => {
      if (String(raw).includes('/statistics?')) {
        await db.$executeRaw`UPDATE statistics_exchange_grants SET lease_id=NULL,lease_until=NULL WHERE id=${grantId}::uuid`;
        return new Response(JSON.stringify(fixture));
      }
      return new Response(JSON.stringify(await grants.read(grantId)));
    });
    expect(
      await statistics.pull(grantId, 1, {
        leaseId: lease,
        afterEntityKey: null,
        maxEntities: 3,
        deadline: Date.now() + 10_000,
      }),
    ).toEqual({ failures: 1, nextCursor: null });
    expect(
      await db.$queryRaw`SELECT 1 FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`,
    ).toEqual([]);
  });
  it('advances bounded cleanup past retained generations before deleting a superseded generation', async () => {
    await grants.put(grantId, input());
    const lease = randomUUID();
    await db.$executeRaw`UPDATE statistics_exchange_grants SET lease_id=${lease}::uuid,lease_until=now()+interval '2 minutes' WHERE id=${grantId}::uuid`;
    await db.$executeRaw`INSERT INTO statistics_exchange_generations(id,grant_id,grant_revision,entity_id,kind,origin,producer_revision,manifest,rows,created_at)
      SELECT md5(${grantId}||n::text)::uuid,${grantId}::uuid,1,'-'||n::text,'CHANNEL','MAXIM',1,'{}'::jsonb,'[]'::jsonb,now()-interval '2 days'+n*interval '1 second' FROM generate_series(1,1001)n`;
    const supersededId = (
      await db.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM statistics_exchange_generations WHERE grant_id=${grantId}::uuid AND entity_id='-1001'`
    )[0]!.id;
    await db.$executeRaw`INSERT INTO statistics_exchange_generations(id,grant_id,grant_revision,entity_id,kind,origin,producer_revision,manifest,rows)
      VALUES(${randomUUID()}::uuid,${grantId}::uuid,1,'-1001','CHANNEL','MAXIM',2,'{}'::jsonb,'[]'::jsonb)`;
    const runtime = new StatisticsExchangeRuntimeService(
      db as PrismaService,
      config,
      statistics,
      grants,
    );
    await runtime.prune(grantId, lease);
    expect(
      (
        await db.$queryRaw<
          Array<{ prune_after_id: string | null }>
        >`SELECT prune_after_id FROM statistics_exchange_grants WHERE id=${grantId}::uuid`
      )[0]!.prune_after_id,
    ).not.toBeNull();
    for (let page = 0; page < 10; page++) await runtime.prune(grantId, lease);
    expect(
      await db.$queryRaw`SELECT 1 FROM statistics_exchange_generations WHERE id=${supersededId}::uuid`,
    ).toEqual([]);
    expect(
      (
        await db.$queryRaw<
          Array<{ count: bigint }>
        >`SELECT count(*) AS count FROM statistics_exchange_generations WHERE grant_id=${grantId}::uuid`
      )[0]!.count,
    ).toBe(1001n);
    const plan = await db.$queryRaw<
      Array<{ 'QUERY PLAN': unknown }>
    >`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id,created_at FROM statistics_exchange_generations WHERE grant_id=${grantId}::uuid AND created_at<now()-interval '1 day' ORDER BY created_at,id LIMIT 100`;
    expect(JSON.stringify(plan)).toContain('statistics_exchange_generations_grant_expiry_idx');
  });
  it('reads only exact-actor imported audience without native generation writes and fences revocation', async () => {
    await grants.put(grantId, input());
    const page = await remoteFixture();
    mockRemote(page);
    await statistics.pull(grantId, 1);
    const generationsBefore = await db.statisticsExchangeGeneration.count();
    expect(
      await new StatisticsExchangeAudienceService(
        db as PrismaService,
        config,
        state,
      ).importedAudience('999999999', entityId, 'CHANNEL'),
    ).toEqual([]);
    expect(
      await new StatisticsExchangeAudienceService(
        db as PrismaService,
        config,
        state,
      ).importedAudience(actor, '-999999999', 'CHANNEL'),
    ).toEqual([]);
    expect(
      await new StatisticsExchangeAudienceService(
        db as PrismaService,
        config,
        state,
      ).importedAudience(actor, entityId, 'CHANNEL'),
    ).toEqual([{ capturedAt: expect.any(Date), participantsCount: 777 }]);
    expect(await db.statisticsExchangeGeneration.count()).toBe(generationsBefore);
    const original = state.hasActiveGrant.bind(state);
    jest.spyOn(state, 'hasActiveGrant').mockImplementationOnce(async (...args) => {
      await grants.put(grantId, input(2, 'REVOKED'));
      return original(...args);
    });
    await expect(
      new StatisticsExchangeAudienceService(db as PrismaService, config, state).importedAudience(
        actor,
        entityId,
        'CHANNEL',
      ),
    ).rejects.toThrow('Доступ изменился');
  });

  it('limits owner reads to the exact actor/entity and refuses a changed consent revision before returning a page', async () => {
    await grants.put(grantId, input());
    expect(await statistics.owner('999999999', entityId, 'CHANNEL')).toBeNull();
    expect(await statistics.owner(actor, '-999999999', 'CHANNEL')).toBeNull();
    expect((await statistics.owner(actor, entityId, 'CHANNEL'))!.entityId).toBe(entityId);
    const original = grants.binding.bind(grants);
    let calls = 0;
    jest.spyOn(grants, 'binding').mockImplementation(async (...args) => {
      calls++;
      if (calls === 2) await grants.put(grantId, input(2));
      return original(...args);
    });
    await expect(statistics.page(grantId, { entityId, kind: 'CHANNEL' })).rejects.toThrow(
      'Согласие изменилось',
    );
  });
});
