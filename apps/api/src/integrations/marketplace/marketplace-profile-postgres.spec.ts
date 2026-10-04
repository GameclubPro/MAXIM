import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, createPrismaAdapter } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import { MarketplaceStateService } from './marketplace-state.service';
import { MarketplaceIntegrationController } from './marketplace.controller';
import type { MarketplaceStatisticsService } from './marketplace-statistics.service';
import { MarketplaceProfileService } from './marketplace-profile.service';
import type { MarketplaceAccessService } from './marketplace-access.service';
import type { MarketplaceProfileRelayResponse } from '@maxim/contracts/marketplace-integration';
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
    await db.$executeRaw`DELETE FROM marketplace_policy_requests WHERE binding_id=${id}::uuid`;
    await db.$executeRaw`DELETE FROM marketplace_bindings WHERE id=${id}::uuid`;
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  const mutate = (body: unknown) =>
    service.mutate('323459159', 'CHANNEL', entityId, 'publisher', body);
  it('replays integration DELETE without revoking a later consent and rejects stale new requests', async () => {
    const controller = new MarketplaceIntegrationController(
      {} as MarketplaceAccessService,
      state,
      {} as MarketplaceStatisticsService,
      db as PrismaService,
    );
    const request = { requestId: randomUUID(), expectedRevision: 0 };
    expect(await controller.revoke(id, request)).toEqual({ revoked: true });
    await db.$executeRaw`UPDATE marketplace_bindings SET statistics_consent=true,state='ACTIVE',valid_until=now()+interval '5 minutes',revision=revision+1 WHERE id=${id}::uuid`;
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
      append_enabled: false,
      append_revision: 1,
      state: 'REVOKED',
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
});
