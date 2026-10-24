import { createHash, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  EXCHANGE_V3_COMPACT_PAGE_BYTES,
  exchangeV3EnvelopeBytes,
  exchangeV3MembershipCanonical,
  type ExchangeV3GrantInput,
  type ExchangeV3MembershipManifest,
} from '@maxim/contracts/statistics-exchange-v3';
import { type ExchangeEntityKey } from '@maxim/contracts';
import { PrismaClient, createPrismaAdapter } from '../../prisma/prisma-client';
import { type PrismaService } from '../../prisma/prisma.service';
import { type MarketplaceAccessService } from './marketplace-access.service';
import { MarketplaceStateService } from './marketplace-state.service';
import { StatisticsExchangeGrantsService } from './statistics-exchange-grants.service';
import { StatisticsExchangeV3MembershipService } from './statistics-exchange-v3-membership.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);
postgres('v3 immutable membership and compact access on PostgreSQL', () => {
  let db: PrismaClient,
    grants: StatisticsExchangeGrantsService,
    service: StatisticsExchangeV3MembershipService,
    actor: string,
    grantId: string;
  let entities: Array<ExchangeEntityKey & { bindingId: string }>;
  const config = new ConfigService({
    SVYAZKA_ANALYTICS_TOKEN: 'a'.repeat(64),
    SVYAZKA_PROFILE_TOKEN: 'b'.repeat(64),
    SVYAZKA_STATISTICS_V2_USERS: '*',
    STATISTICS_EXCHANGE_V3_ENABLED: true,
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
    grants = new StatisticsExchangeGrantsService(
      db as PrismaService,
      config,
      {} as MarketplaceAccessService,
      new MarketplaceStateService(db as PrismaService, config),
    );
    service = new StatisticsExchangeV3MembershipService(db as PrismaService, config, grants);
  });
  beforeEach(() => {
    actor = String(800_000_000 + Math.floor(Math.random() * 100_000_000));
    grantId = randomUUID();
    entities = [];
  });
  afterEach(async () => {
    await db.$executeRaw`DELETE FROM statistics_exchange_entities WHERE grant_id IN(SELECT id FROM statistics_exchange_grants WHERE actor_user_id=${actor})`;
    await db.$executeRaw`DELETE FROM statistics_exchange_grants WHERE actor_user_id=${actor}`;
    await db.$executeRaw`DELETE FROM statistics_exchange_membership_snapshots WHERE actor_user_id=${actor}`;
    await db.$executeRaw`DELETE FROM statistics_exchange_membership_actors WHERE actor_user_id=${actor}`;
    await db.$executeRaw`DELETE FROM marketplace_bindings WHERE actor_user_id=${actor}`;
    await db.$executeRaw`DELETE FROM managed_entity_access_edges WHERE user_id=${actor}`;
    if (entities.length)
      await db.chat.deleteMany({ where: { id: { in: entities.map((e) => e.entityId) } } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  async function seed(count: number, longMetadata = false) {
    entities = Array.from({ length: count }, (_, n) => ({
      entityId: `-${actor}${String(n).padStart(4, '0')}`,
      kind: 'CHANNEL' as const,
      profile: 'moderation' as const,
      bindingId: randomUUID(),
    }));
    if (!count) return;
    await db.chat.createMany({
      data: entities.map((e) => ({
        id: e.entityId,
        title: 'V3 synthetic',
        entityType: 'CHANNEL' as const,
      })),
    });
    await db.chatBotMembership.createMany({
      data: entities.map((e) => ({
        chatId: e.entityId,
        botId: `v3-${actor}`,
        status: 'ACTIVE' as const,
        botAccessState: 'CONFIRMED_ADMIN' as const,
      })),
    });
    await db.$executeRaw`INSERT INTO managed_entity_access_edges(chat_id,user_id,bot_id,state,user_role,bot_role,checked_at,updated_at)
      SELECT e."entityId",${actor},${'v3-' + actor},'GRANTED','ADMIN','ADMIN',now(),now() FROM jsonb_to_recordset(${JSON.stringify(entities)}::jsonb)e("entityId" text)`;
    const metadata = {
      title: 'Канал 😀',
      description: longMetadata ? '😀'.repeat(2000) : '',
      imageUrl: longMetadata ? `https://example.com/${'i'.repeat(3000)}` : null,
      publicUrl: null,
      audience: 100,
      isPublic: true,
    };
    await db.$executeRaw`INSERT INTO marketplace_bindings(id,actor_user_id,entity_id,kind,profile,bot_id,state,checked_at,valid_until,metadata)
      SELECT e."bindingId"::uuid,${actor},e."entityId",e.kind,e.profile,${'v3-' + actor},'ACTIVE',now(),now()+interval '5 minutes',${JSON.stringify(metadata)}::jsonb
      FROM jsonb_to_recordset(${JSON.stringify(entities)}::jsonb)e("bindingId" text,"entityId" text,kind text,profile text)`;
  }
  async function snapshot() {
    const status = await service.snapshot({ requestId: randomUUID(), actorUserId: actor });
    if (status.state !== 'READY') throw new Error('Expected locally frozen snapshot');
    return status.manifest;
  }
  function input(
    manifest: ExchangeV3MembershipManifest | null,
    revision = 1,
  ): ExchangeV3GrantInput {
    return {
      version: 3,
      requestId: randomUUID(),
      grantId,
      actorUserId: actor,
      expectedRevision: revision - 1,
      revision,
      state: manifest ? 'ACTIVE' : 'REVOKED',
      membershipSnapshot: manifest
        ? {
            snapshotId: manifest.snapshotId,
            membershipRevision: manifest.membershipRevision,
            sha256: manifest.sha256,
          }
        : null,
    };
  }
  async function allAccess() {
    let cursor: string | null = null;
    const result = [];
    do {
      const page = await service.access(grantId, cursor === null ? {} : { cursor });
      expect(exchangeV3EnvelopeBytes(page)).toBeLessThanOrEqual(EXCHANGE_V3_COMPACT_PAGE_BYTES);
      result.push(...page.entities);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return result;
  }

  it('keeps every v3 route closed before explicit feature activation', async () => {
    const off = new StatisticsExchangeV3MembershipService(
      db as PrismaService,
      new ConfigService({ STATISTICS_EXCHANGE_V3_ENABLED: false }),
      grants,
    );
    expect(() => off.capabilities()).toThrow('EXCHANGE_VERSION_UNSUPPORTED');
    await expect(off.snapshot({ requestId: randomUUID(), actorUserId: actor })).rejects.toThrow(
      'EXCHANGE_VERSION_UNSUPPORTED',
    );
  });
  it.each([0, 1, 100, 101, 200])(
    'freezes and applies the complete %i-platform roster without truncation',
    async (count) => {
      await seed(count, true);
      const manifest = await snapshot();
      expect(manifest.entityCount).toBe(count);
      const received: ExchangeEntityKey[] = [];
      for (let index = 0; index < manifest.pageCount; index++) {
        const page = await service.snapshotPage(manifest.snapshotId, index);
        expect(page.pageIndex).toBe(index);
        expect(page.entities.length).toBeLessThanOrEqual(100);
        expect(exchangeV3EnvelopeBytes(page)).toBeLessThanOrEqual(EXCHANGE_V3_COMPACT_PAGE_BYTES);
        expect(JSON.stringify(page)).not.toContain('description');
        received.push(...page.entities);
      }
      expect(
        createHash('sha256').update(exchangeV3MembershipCanonical(received)).digest('hex'),
      ).toBe(manifest.sha256);
      const header = await service.put(grantId, input(manifest));
      expect(header.membership?.entityCount).toBe(count);
      const access = await allAccess();
      expect(access).toHaveLength(count);
      expect(access.every((e) => e.status === 'ACTIVE')).toBe(true);
      expect(JSON.stringify(access)).not.toContain('description');
      expect(JSON.stringify(access)).not.toContain('botId');
      if (count > 100) await expect(grants.read(grantId)).rejects.toThrow('ROSTER_REQUIRES_V3');
    },
  );
  it('keeps a complete roster above100 usable in central mode with current per-platform denial', async () => {
    config.set('STATISTICS_CENTRAL_ENABLED', true);
    config.set('STATISTICS_CENTRAL_MODE', 'CENTRAL');
    try {
      await seed(101, true);
      const manifest = await snapshot();
      expect(manifest.entityCount).toBe(101);
      await service.put(grantId, input(manifest));
      const first = await allAccess();
      expect(first).toHaveLength(101);
      expect(first.every((entity) => entity.status === 'ACTIVE')).toBe(true);
      await db.$executeRaw`UPDATE marketplace_bindings SET state='REVOKED',valid_until=NULL WHERE id=${entities[0]!.bindingId}::uuid`;
      const denied = await allAccess();
      expect(denied.filter((entity) => entity.status === 'ACTIVE')).toHaveLength(100);
      expect(denied.find((entity) => entity.entityId === entities[0]!.entityId)?.status).toBe(
        'UNAVAILABLE',
      );
      await expect(grants.read(grantId)).rejects.toThrow('ROSTER_REQUIRES_V3');
    } finally {
      config.set('STATISTICS_CENTRAL_ENABLED', false);
      config.set('STATISTICS_CENTRAL_MODE', 'LEGACY');
    }
  });
  it('keeps immutable pages and stable composition hash across health-only checks and duplicate bots', async () => {
    await seed(1);
    const requestId = randomUUID();
    const first = await service.snapshot({ requestId, actorUserId: actor });
    await db.chatBotMembership.create({
      data: {
        chatId: entities[0]!.entityId,
        botId: `v3-peer-${actor}`,
        status: 'ACTIVE',
        botAccessState: 'CONFIRMED_ADMIN',
      },
    });
    await db.$executeRaw`INSERT INTO managed_entity_access_edges(chat_id,user_id,bot_id,state,user_role,bot_role,checked_at,updated_at) VALUES(${entities[0]!.entityId},${actor},${'v3-peer-' + actor},'GRANTED','ADMIN','ADMIN',now(),now())`;
    await db.$executeRaw`UPDATE managed_entity_access_edges SET checked_at=now() WHERE user_id=${actor}`;
    expect(await service.snapshot({ requestId, actorUserId: actor })).toEqual(first);
    const second = await snapshot();
    if (first.state !== 'READY') throw new Error('Expected READY');
    expect(second.sha256).toBe(first.manifest.sha256);
    expect(second.membershipRevision).toBe(first.manifest.membershipRevision);
    expect(second.entityCount).toBe(1);
    expect((await service.snapshotPage(second.snapshotId, 0)).entities[0]!.profile).toBe(
      'moderation',
    );
  });
  it('rejects composition changes during paging without removing the active roster', async () => {
    await seed(101);
    const active = await snapshot();
    await service.put(grantId, input(active));
    const pending = await snapshot();
    await service.snapshotPage(pending.snapshotId, 0);
    await db.$executeRaw`UPDATE managed_entity_access_edges SET state='USER_DENIED',checked_at=now() WHERE user_id=${actor} AND chat_id=${entities[0]!.entityId}`;
    expect((await service.snapshotPage(pending.snapshotId, 1)).entities).toHaveLength(1);
    await expect(service.put(grantId, input(pending, 2))).rejects.toThrow(
      'EXCHANGE_REVISION_CONFLICT',
    );
    expect((await service.read(grantId)).revision).toBe(1);
    expect((await service.read(grantId)).membership?.entityCount).toBe(101);
    expect((await service.exactAccess(grantId, 'CHANNEL', entities[0]!.entityId))!.status).toBe(
      'UNAVAILABLE',
    );
  });
  it('replays the same grant without renewing peer proof or overwriting a later revision', async () => {
    await seed(1);
    const manifest = await snapshot(),
      request = input(manifest);
    await service.put(grantId, request);
    const before = await db.$queryRaw<
      Array<{ remote_valid_until: Date }>
    >`SELECT remote_valid_until FROM statistics_exchange_entities WHERE grant_id=${grantId}::uuid`;
    await service.put(grantId, request);
    const after = await db.$queryRaw<
      Array<{ remote_valid_until: Date }>
    >`SELECT remote_valid_until FROM statistics_exchange_entities WHERE grant_id=${grantId}::uuid`;
    expect(after[0]!.remote_valid_until).toEqual(before[0]!.remote_valid_until);
    await expect(service.put(grantId, { ...request, requestId: randomUUID() })).rejects.toThrow(
      'EXCHANGE_REVISION_CONFLICT',
    );
    await service.put(grantId, input(null, 2));
    await expect(service.put(grantId, request)).rejects.toThrow('EXCHANGE_REVISION_CONFLICT');
  });
  it('rejects expired or forged snapshots before grant activation', async () => {
    await seed(1);
    const manifest = await snapshot();
    await expect(
      service.put(grantId, {
        ...input(manifest),
        membershipSnapshot: {
          snapshotId: manifest.snapshotId,
          membershipRevision: manifest.membershipRevision,
          sha256: '0'.repeat(64),
        },
      }),
    ).rejects.toThrow('EXCHANGE_IDENTITY_MISMATCH');
    await db.$executeRaw`UPDATE statistics_exchange_membership_snapshots SET expires_at=now()-interval '1 second' WHERE id=${manifest.snapshotId}::uuid`;
    await expect(service.put(grantId, input(manifest))).rejects.toThrow(
      'EXCHANGE_SNAPSHOT_EXPIRED',
    );
    expect(
      await db.$queryRaw`SELECT id FROM statistics_exchange_grants WHERE id=${grantId}::uuid`,
    ).toEqual([]);
  });
  it('fences foreign cursors and changes only the affected exact access proof on denial', async () => {
    await seed(101);
    await service.put(grantId, input(await snapshot()));
    const first = await service.access(grantId, {});
    expect(first.nextCursor).not.toBeNull();
    const foreign = Buffer.from(
      JSON.stringify({
        grantId: randomUUID(),
        revision: 1,
        accessRevision: first.accessRevision,
        after: '',
      }),
    ).toString('base64url');
    await expect(service.access(grantId, { cursor: foreign })).rejects.toThrow(
      'EXCHANGE_REVISION_CONFLICT',
    );
    const last = entities[100]!;
    await service.exactAccess(grantId, 'CHANNEL', last.entityId);
    await db.$executeRaw`UPDATE marketplace_bindings SET state='REVOKED',revision=revision+1 WHERE id=${last.bindingId}::uuid`;
    const denied = await service.exactAccess(grantId, 'CHANNEL', last.entityId);
    expect(denied!.status).toBe('UNAVAILABLE');
    expect((await service.read(grantId)).accessRevision).toBeGreaterThan(first.accessRevision);
    await expect(service.access(grantId, { cursor: first.nextCursor })).rejects.toThrow(
      'EXCHANGE_REVISION_CONFLICT',
    );
    expect((await service.exactAccess(grantId, 'CHANNEL', entities[0]!.entityId))!.status).toBe(
      'ACTIVE',
    );
  });
  it('does not change structural access revision on a successful health-only renewal', async () => {
    await seed(1);
    await service.put(grantId, input(await snapshot()));
    const first = await service.access(grantId, {});
    await db.$executeRaw`UPDATE marketplace_bindings SET checked_at=now(),valid_until=now()+interval '5 minutes',revision=revision+1 WHERE id=${entities[0]!.bindingId}::uuid`;
    const second = await service.access(grantId, {});
    expect(second.accessRevision).toBe(first.accessRevision);
    expect(second.entities[0]!.bindingRevision).toBe(first.entities[0]!.bindingRevision);
    expect(second.entities[0]!.status).toBe('ACTIVE');
  });
  it('separates valid data permission from invalid metadata and blocks metadata on actual revoke', async () => {
    await seed(1, true);
    await service.put(grantId, input(await snapshot()));
    const entity = entities[0]!;
    const first = await service.metadata(grantId, 'CHANNEL', entity.entityId, {});
    expect(first.changed).toBe(true);
    expect(
      (
        await service.metadata(grantId, 'CHANNEL', entity.entityId, {
          knownVersion: first.metadataVersion,
        })
      ).metadata,
    ).toBeNull();
    await db.$executeRaw`UPDATE marketplace_bindings SET metadata=jsonb_set(metadata,'{imageUrl}',to_jsonb(${'https://example.com/' + 'я'.repeat(3000)}::text)) WHERE id=${entity.bindingId}::uuid`;
    const current = await service.exactAccess(grantId, 'CHANNEL', entity.entityId);
    expect(current!.status).toBe('ACTIVE');
    expect(current!.permittedScopes).toContainEqual({ metric: 'REACH', horizon: 24 });
    expect(current!.metadataVersion).toBeNull();
    await expect(service.metadata(grantId, 'CHANNEL', entity.entityId, {})).rejects.toThrow();
    await db.$executeRaw`UPDATE marketplace_bindings SET statistics_consent=false,statistics_revoked_at=now(),revision=revision+1 WHERE id=${entity.bindingId}::uuid`;
    await expect(
      service.metadata(grantId, 'CHANNEL', entity.entityId, {
        knownVersion: first.metadataVersion,
      }),
    ).rejects.toThrow('EXCHANGE_ACCESS_DENIED');
  });
  it('retains the compact active membership header after expired snapshot storage is removed', async () => {
    await seed(1);
    const manifest = await snapshot();
    await service.put(grantId, input(manifest));
    await db.$executeRaw`DELETE FROM statistics_exchange_membership_snapshots WHERE id=${manifest.snapshotId}::uuid`;
    expect((await service.read(grantId)).membership).toEqual({
      snapshotId: manifest.snapshotId,
      membershipRevision: manifest.membershipRevision,
      sha256: manifest.sha256,
      entityCount: 1,
    });
  });
  it('preserves earlier explicit statistics refusal during automatic snapshot application', async () => {
    await seed(1);
    await db.$executeRaw`UPDATE marketplace_bindings SET statistics_revoked_at=now(),statistics_consent=false WHERE id=${entities[0]!.bindingId}::uuid`;
    await service.put(grantId, input(await snapshot()));
    expect((await service.exactAccess(grantId, 'CHANNEL', entities[0]!.entityId))!.status).toBe(
      'UNAVAILABLE',
    );
    const rows = await db.$queryRaw<
      Array<{ statistics_consent: boolean }>
    >`SELECT statistics_consent FROM marketplace_bindings WHERE id=${entities[0]!.bindingId}::uuid`;
    expect(rows[0]!.statistics_consent).toBe(false);
  });
  it('bounds complete legacy grant reads independently of the number of active bindings', async () => {
    await seed(100);
    await service.put(grantId, input(await snapshot()));
    const queries = jest.spyOn(db, '$queryRaw');
    const started = performance.now();
    const result = await grants.read(grantId);
    const queryCount = queries.mock.calls.length;
    queries.mockRestore();
    process.stderr.write(
      'legacy-grant-read-measurement ' +
        JSON.stringify({
          platforms: result.entities.length,
          queryCount,
          elapsedMs: performance.now() - started,
          bytes: Buffer.byteLength(JSON.stringify(result)),
        }) +
        '\n',
    );
    expect(queryCount).toBe(2);
    expect(result.entities).toHaveLength(100);
    expect(result.entities.every((e) => e.status === 'ACTIVE')).toBe(true);
  });

  it('keeps exact negative authority and binding presentation equivalent in the batched legacy reader', async () => {
    await seed(5);
    await service.put(grantId, input(await snapshot()));
    await db.$executeRaw`UPDATE marketplace_bindings SET valid_until=now()-interval '1 second' WHERE id=${entities[0]!.bindingId}::uuid`;
    await db.$executeRaw`UPDATE marketplace_bindings SET statistics_revoked_at=now() WHERE id=${entities[1]!.bindingId}::uuid`;
    await db.$executeRaw`UPDATE chat_bot_memberships SET status='REMOVED' WHERE chat_id=${entities[2]!.entityId}`;
    await db.$executeRaw`UPDATE managed_entity_access_edges SET state='USER_DENIED',checked_at=now()+interval '1 second' WHERE chat_id=${entities[3]!.entityId} AND user_id=${actor}`;
    const actual = await grants.read(grantId);
    const reference = new MarketplaceStateService(db as PrismaService, config);
    for (const entity of entities) {
      const binding = (await reference.read(entity.bindingId))!;
      const point = actual.entities.find((p) => p.entityId === entity.entityId)!;
      expect(point.binding).toEqual(reference.present(binding));
      expect(point.status).toBe(
        (await reference.hasActiveGrant(entity.bindingId)) ? 'ACTIVE' : 'UNAVAILABLE',
      );
    }
    expect(actual.entities.filter((p) => p.status === 'ACTIVE')).toHaveLength(1);
  });
});
