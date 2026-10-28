import { MarketplaceProfileAccessService } from './marketplace-profile-access.service';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, createPrismaAdapter } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import { MarketplaceStateService } from './marketplace-state.service';
import { MarketplaceIntegrationController } from './marketplace.controller';
import type { MarketplaceStatisticsService } from './marketplace-statistics.service';
import { MarketplaceProfileService } from './marketplace-profile.service';
import { MarketplaceButtonPolicyService } from './marketplace-button-policy.service';
import type { MarketplaceAccessService } from './marketplace-access.service';
import type {
  MarketplaceBindingInput,
  MarketplaceProfileRelayResponse,
} from '@maxim/contracts/marketplace-integration';
const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);
postgres('marketplace durable owner policy changes', () => {
  let db: PrismaClient;
  let state: MarketplaceStateService;
  let service: MarketplaceProfileService;
  let id: string;
  let entityId: string;
  let remote: MarketplaceProfileRelayResponse;
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable database required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 2, statement_timeout: 10_000 }),
    });
    await db.$connect();
    const config = new ConfigService({
      SVYAZKA_ANALYTICS_TOKEN: 'a'.repeat(64),
      SVYAZKA_PROFILE_TOKEN: 'b'.repeat(64),
    });
    state = new MarketplaceStateService(db as PrismaService, config);
    service = new MarketplaceProfileService(db as PrismaService, config, state, {
      attest: () => state.read(id),
    } as unknown as MarketplaceAccessService);
  });
  beforeEach(async () => {
    id = randomUUID();
    entityId = '-' + String(Date.now());
    const listingId = randomUUID();
    await db.$executeRaw`INSERT INTO marketplace_bindings(id,actor_user_id,entity_id,kind,profile,bot_id,state,checked_at,valid_until,metadata,statistics_consent)
      VALUES(${id}::uuid,'323459159',${entityId},'CHANNEL','publisher','test','ACTIVE',now(),now()+interval '10 minutes',
      ${JSON.stringify({ title: 'Test', description: '', imageUrl: null, publicUrl: null, audience: 100, isPublic: true })}::jsonb,true)`;
    remote = {
      bindingId: id,
      entityId,
      kind: 'CHANNEL',
      revision: 1,
      listing: {
        id: listingId,
        title: 'Test',
        description: '',
        topic: 'Test',
        region: 'Test',
        status: 'PUBLISHED',
        publicUrl: `https://max.ru/id613000037577_3_bot?startapp=listing_channel_${listingId}`,
        profileOnly: true,
      },
      choices: { topics: [], regions: [] },
    };
    jest.spyOn(service, 'relay').mockResolvedValue(remote);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db.$executeRaw`DELETE FROM marketplace_policy_requests WHERE binding_id IN(SELECT id FROM marketplace_bindings WHERE entity_id=${entityId})`;
    await db.$executeRaw`DELETE FROM marketplace_button_requests WHERE policy_id IN(SELECT id FROM marketplace_button_policies WHERE entity_id=${entityId})`;
    await db.$executeRaw`DELETE FROM marketplace_button_contexts WHERE policy_id IN(SELECT id FROM marketplace_button_policies WHERE entity_id=${entityId})`;
    await db.$executeRaw`DELETE FROM marketplace_button_policies WHERE entity_id=${entityId}`;
    await db.$executeRaw`DELETE FROM marketplace_bindings WHERE entity_id=${entityId}`;
    await db.chat.deleteMany({ where: { id: entityId } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  const mutate = (body: unknown) =>
    service.mutate('323459159', 'CHANNEL', entityId, 'publisher', body);
  const readLegacy = () => service.get('323459159', 'CHANNEL', entityId, 'publisher');
  const canonicalFixture = async () => {
    await db.chat.create({ data: { id: entityId, title: 'Synthetic profile compatibility' } });
    await db.publisherEntityBinding.create({
      data: { chatId: entityId, publisherBotId: 'test', status: 'ACTIVE' },
    });
    const secondBinding = randomUUID();
    const actor: MarketplaceBindingInput = {
      actorUserId: '323459160',
      kind: 'CHANNEL',
      entityId,
      profile: 'publisher',
    };
    await db.$executeRaw`INSERT INTO marketplace_bindings(id,actor_user_id,entity_id,kind,profile,bot_id,state,checked_at,valid_until,metadata,statistics_consent)
      SELECT ${secondBinding}::uuid,${actor.actorUserId},entity_id,kind,profile,bot_id,state,checked_at,valid_until,metadata,false FROM marketplace_bindings WHERE id=${id}::uuid`;
    const policy = new MarketplaceButtonPolicyService(
      db as PrismaService,
      new ConfigService({
        SVYAZKA_ANALYTICS_TOKEN: 'a'.repeat(64),
        SVYAZKA_PROFILE_TOKEN: 'b'.repeat(64),
      }),
      state,
      { attest: () => state.read(secondBinding) } as unknown as MarketplaceAccessService,
    );
    jest.spyOn(policy, 'readEntry').mockImplementation(async () => ({
      ...actor,
      publicState: 'PUBLIC',
      listing: {
        id: remote.listing!.id,
        ownershipKey: 'a'.repeat(64),
        title: 'Synthetic profile compatibility',
        publicUrl: remote.listing!.publicUrl,
        profileOnly: true,
      },
      isOwner: false,
      canCreate: false,
      manageUrl: null,
      connectUrl: `https://max.ru/id613000037577_3_bot?startapp=connect_channel_${entityId}`,
      checkedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 300_000).toISOString(),
    }));
    return {
      get: () => policy.get(actor),
      set: (enabled: boolean, expectedRevision: number) =>
        policy.mutate(actor, {
          requestId: randomUUID(),
          expectedRevision,
          context: 'PUBLICATIONS',
          enabled,
        }),
    };
  };
  it('reads another administrator canonical PUBLICATIONS choice with a monotonic legacy token', async () => {
    const policy = await canonicalFixture();
    const before = await readLegacy();
    await policy.set(true, 0);
    const enabled = await readLegacy();
    expect(enabled.appendEnabled).toBe(true);
    expect(enabled.appendRevision).toBeGreaterThan(before.appendRevision);
    expect((await state.read(id))!.append_enabled).toBe(false);
    await policy.set(false, 1);
    await policy.set(true, 2);
    const current = await readLegacy();
    expect(current.appendEnabled).toBe(true);
    expect(current.appendRevision).toBeGreaterThan(enabled.appendRevision);
    await expect(
      mutate({
        action: 'toggle',
        requestId: randomUUID(),
        expectedRevision: enabled.appendRevision,
        appendEnabled: false,
      }),
    ).rejects.toThrow('Настройки изменились');
    expect((await policy.get()).contexts[0]!.enabled).toBe(true);
  });
  it('rejects a canonical change after the early legacy check and before its transaction lock', async () => {
    const policy = await canonicalFixture();
    await policy.set(true, 0);
    const before = await readLegacy();
    jest.spyOn(service, 'relay').mockImplementationOnce(async () => {
      await policy.set(false, 1);
      return remote;
    });
    await expect(
      mutate({
        action: 'toggle',
        requestId: randomUUID(),
        expectedRevision: before.appendRevision,
        appendEnabled: true,
      }),
    ).rejects.toThrow('Настройки изменились');
    expect((await policy.get()).contexts[0]!.enabled).toBe(false);
  });
  it('lets a current legacy off switch change canonical policy and replays its exact old receipt', async () => {
    const policy = await canonicalFixture();
    await policy.set(true, 0);
    const enabled = await readLegacy();
    const command = {
      action: 'toggle',
      requestId: randomUUID(),
      expectedRevision: enabled.appendRevision,
      appendEnabled: false,
    };
    const result = await mutate(command);
    expect(result.appendEnabled).toBe(false);
    expect(result.appendRevision).toBeGreaterThan(enabled.appendRevision);
    const disabled = await policy.get();
    expect(disabled.contexts[0]!.enabled).toBe(false);
    await policy.set(true, disabled.revision);
    expect(await mutate(command)).toEqual(result);
    expect((await policy.get()).contexts[0]!.enabled).toBe(true);
    expect((await readLegacy()).appendEnabled).toBe(true);
  });
  it('keeps canonical PUBLICATIONS visible after independent statistics withdrawal', async () => {
    const policy = await canonicalFixture();
    await policy.set(true, 0);
    const before = await readLegacy();
    const result = await mutate({
      action: 'revoke',
      requestId: randomUUID(),
      expectedRevision: before.appendRevision,
    });
    expect(result.binding.statisticsConsent).toBe(false);
    expect(result.appendEnabled).toBe(true);
    expect((await policy.get()).contexts[0]!.enabled).toBe(true);
  });
  it('replays integration DELETE without revoking a later consent and rejects stale new requests', async () => {
    const controller = new MarketplaceIntegrationController(
      {} as MarketplaceAccessService,
      state,
      {} as MarketplaceStatisticsService,
      db as PrismaService,
      {} as MarketplaceProfileAccessService,
    );
    const request = { requestId: randomUUID(), expectedRevision: 0 };
    expect(await controller.revoke(id, request)).toEqual({ revoked: true });
    expect((await state.read(id))!.statistics_revoked_at).toBeInstanceOf(Date);
    await db.$executeRaw`UPDATE marketplace_bindings SET statistics_consent=true,statistics_revoked_at=NULL,statistics_v2_consent_only=false,state='ACTIVE',valid_until=now()+interval '5 minutes',append_revision=append_revision+1,revision=revision+1 WHERE id=${id}::uuid`;
    expect(await controller.revoke(id, request)).toEqual({ revoked: true });
    expect((await state.read(id))!.statistics_consent).toBe(true);
    await expect(controller.revoke(id, { ...request, requestId: randomUUID() })).rejects.toThrow(
      'Привязка изменилась',
    );
  });
  it.each(['toggle', 'revoke'] as const)(
    'commits restrictive %s while MAX and marketplace are unavailable',
    async (action) => {
      await db.$executeRaw`UPDATE marketplace_bindings SET append_enabled=true WHERE id=${id}::uuid`;
      const access = { attest: jest.fn().mockRejectedValue(new Error('MAX unavailable')) };
      const offline = new MarketplaceProfileService(
        db as PrismaService,
        new ConfigService(),
        state,
        access as unknown as MarketplaceAccessService,
      );
      jest.spyOn(offline, 'relay').mockRejectedValue(new Error('Marketplace unavailable'));
      const result = await offline.mutate('323459159', 'CHANNEL', entityId, 'publisher', {
        action,
        requestId: randomUUID(),
        expectedRevision: 0,
        ...(action === 'toggle' ? { appendEnabled: false } : {}),
      });
      expect(result.appendEnabled).toBe(false);
      expect((await state.read(id))!.append_enabled).toBe(false);
      if (action === 'revoke') expect((await state.read(id))!.statistics_consent).toBe(false);
      expect(access.attest).not.toHaveBeenCalled();
      expect(offline.relay).not.toHaveBeenCalled();
    },
  );
  it('replays identical toggles without advancing policy twice and rejects key reuse', async () => {
    const request = {
      action: 'toggle',
      requestId: randomUUID(),
      expectedRevision: 0,
      appendEnabled: true,
    };
    const [first, second] = await Promise.all([mutate(request), mutate(request)]);
    expect(first).toEqual(second);
    expect(first.appendEnabled).toBe(true);
    const durable = await db.$queryRaw<
      Array<{ result: Record<string, unknown> }>
    >`SELECT result FROM marketplace_policy_requests WHERE request_id=${request.requestId}::uuid`;
    expect(durable[0]!.result).not.toHaveProperty('capabilities');
    expect(durable[0]!.result).not.toHaveProperty('statistics');
    expect((await state.read(id))!.append_revision).toBe(1);
    await expect(mutate({ ...request, appendEnabled: false })).rejects.toThrow(
      'Идентификатор запроса уже использован',
    );
  });
  it('revokes consent idempotently and invalidates an in-flight collector lease', async () => {
    await db.$executeRaw`UPDATE marketplace_bindings SET lease_id=${randomUUID()}::uuid,lease_until=now()+interval '2 minutes' WHERE id=${id}::uuid`;
    const request = { action: 'revoke', requestId: randomUUID(), expectedRevision: 0 };
    const first = await mutate(request);
    const repeated = await mutate(request);
    expect(repeated).toEqual(first);
    expect((await state.read(id))!).toMatchObject({
      statistics_consent: false,
      statistics_revoked_at: expect.any(Date),
      append_enabled: false,
      append_revision: 1,
      state: 'ACTIVE',
      lease_id: null,
      lease_until: null,
    });
  });
  it('does not revoke a newer owner policy from a stale request', async () => {
    await db.$executeRaw`UPDATE marketplace_bindings SET append_revision=append_revision+1,append_enabled=true WHERE id=${id}::uuid`;
    await expect(
      mutate({ action: 'revoke', requestId: randomUUID(), expectedRevision: 0 }),
    ).rejects.toThrow('Настройки изменились');
    expect((await state.read(id))!).toMatchObject({
      statistics_consent: true,
      append_enabled: true,
    });
  });
  it('hides a profile after a fresh rights check without restoring revoked statistics consent', async () => {
    await db.$executeRaw`UPDATE marketplace_bindings SET statistics_consent=false,append_enabled=false WHERE id=${id}::uuid`;
    const proof = { attest: jest.fn().mockImplementation(() => state.read(id)) };
    const service = new MarketplaceProfileService(
      db as PrismaService,
      new ConfigService(),
      state,
      proof as unknown as MarketplaceAccessService,
    );
    const relay = jest.spyOn(service, 'relay').mockResolvedValue({
      ...remote,
      listing: { ...remote.listing!, status: 'PAUSED', publicUrl: null },
    });
    const response = await service.mutate('323459159', 'CHANNEL', entityId, 'publisher', {
      action: 'pause',
      requestId: randomUUID(),
      expectedRevision: 1,
    });
    expect(proof.attest).toHaveBeenCalled();
    expect(relay).toHaveBeenCalled();
    expect(response.listing?.status).toBe('PAUSED');
    expect(response.binding.statisticsConsent).toBe(false);
    expect((await state.read(id))!.statistics_consent).toBe(false);
    expect((await state.read(id))!.append_enabled).toBe(false);
    proof.attest.mockRejectedValueOnce(new Error('Access lost'));
    await expect(
      service.mutate('323459159', 'CHANNEL', entityId, 'publisher', {
        action: 'pause',
        requestId: randomUUID(),
        expectedRevision: 1,
      }),
    ).rejects.toThrow('Access lost');
    expect(relay).toHaveBeenCalledTimes(1);
  });
  it('does not restore consent when a save finishes after local revoke', async () => {
    await db.$executeRaw`UPDATE marketplace_bindings SET statistics_consent=false WHERE id=${id}::uuid`;
    jest.spyOn(service, 'relay').mockImplementation(async () => {
      await db.$executeRaw`UPDATE marketplace_bindings SET append_revision=append_revision+1,statistics_consent=false WHERE id=${id}::uuid`;
      return remote;
    });
    await expect(
      mutate({
        action: 'save',
        requestId: randomUUID(),
        expectedRevision: 0,
        statisticsConsent: true,
        details: { title: 'Test', description: '', topic: 'Test', region: 'Test' },
      }),
    ).rejects.toThrow('Согласие изменилось');
    expect((await state.read(id))!.statistics_consent).toBe(false);
  });
  it('claims explicit legacy consent only with its policy CAS, including an already enabled automatic binding', async () => {
    await db.$executeRaw`UPDATE marketplace_bindings SET statistics_v2_consent_only=true WHERE id=${id}::uuid`;
    jest.spyOn(service, 'relay').mockImplementation(async () => {
      await db.$executeRaw`UPDATE marketplace_bindings SET append_revision=append_revision+1 WHERE id=${id}::uuid`;
      return remote;
    });
    await expect(
      mutate({
        action: 'save',
        requestId: randomUUID(),
        expectedRevision: 0,
        statisticsConsent: true,
      }),
    ).rejects.toThrow('Согласие изменилось');
    const rows = await db.$queryRaw<Array<{ statistics_v2_consent_only: boolean }>>`
      SELECT statistics_v2_consent_only FROM marketplace_bindings WHERE id=${id}::uuid`;
    expect(rows[0]!.statistics_v2_consent_only).toBe(true);
  });
  it('keeps explicit denial through access attestation and clears it only for a later explicit legacy true', async () => {
    await mutate({ action: 'revoke', requestId: randomUUID(), expectedRevision: 0 });
    const denied = (await state.read(id))!.statistics_revoked_at;
    await db.$executeRaw`UPDATE marketplace_bindings SET state='ACTIVE',checked_at=now(),valid_until=now()+interval '5 minutes' WHERE id=${id}::uuid`;
    expect((await state.read(id))!.statistics_revoked_at).toEqual(denied);
    await mutate({
      action: 'pause',
      requestId: randomUUID(),
      expectedRevision: 1,
      statisticsConsent: true,
    });
    expect((await state.read(id))!.statistics_revoked_at).toEqual(denied);
    await expect(
      mutate({ action: 'save', requestId: randomUUID(), expectedRevision: 1 }),
    ).rejects.toThrow('Профиль пока недоступен');
    const response = await mutate({
      action: 'save',
      requestId: randomUUID(),
      expectedRevision: 1,
      statisticsConsent: true,
    });
    expect(response.binding.statisticsConsent).toBe(true);
    expect((await state.read(id))!).toMatchObject({
      statistics_revoked_at: null,
      statistics_consent: true,
      append_revision: 2,
    });
  });
});
