import { MarketplaceProfileAccessService } from './marketplace-profile-access.service';
import { createHash, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type {
  MarketplaceBindingInput,
  MarketplaceEntryResponse,
} from '@maxim/contracts/marketplace-integration';
import { PrismaClient, createPrismaAdapter } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import { MarketplaceIntegrationController } from './marketplace.controller';
import { MarketplaceProfileService } from './marketplace-profile.service';
import type { MarketplaceStatisticsService } from './marketplace-statistics.service';
import { MarketplaceStateService } from './marketplace-state.service';
import { MarketplaceButtonPolicyService } from './marketplace-button-policy.service';
import type { MarketplaceAccessService } from './marketplace-access.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);
postgres('platform-scoped Birzhik button policy on PostgreSQL', () => {
  let db: PrismaClient;
  let service: MarketplaceButtonPolicyService;
  let state: MarketplaceStateService;
  let input: MarketplaceBindingInput;
  let entry: MarketplaceEntryResponse;
  let firstBinding: string;
  let secondBinding: string;
  const firstActor = '911001';
  const secondActor = '911002';
  const botId = 'fixture-moderator';
  let read: jest.SpyInstance<Promise<MarketplaceEntryResponse>, [MarketplaceBindingInput]>;
  let attest: jest.MockedFunction<MarketplaceAccessService['attest']>;
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 4, statement_timeout: 10_000 }),
    });
    await db.$connect();
    const config = new ConfigService({
      SVYAZKA_ANALYTICS_TOKEN: 'a'.repeat(64),
      SVYAZKA_PROFILE_TOKEN: 'b'.repeat(64),
    });
    state = new MarketplaceStateService(db as PrismaService, config);
    attest = jest.fn(async (raw: unknown) => {
      const value = raw as MarketplaceBindingInput;
      const rows = await db.$queryRaw<
        Array<{ id: string }>
      >`UPDATE marketplace_bindings SET state='ACTIVE',checked_at=now(),valid_until=now()+interval '15 minutes' WHERE actor_user_id=${value.actorUserId} AND entity_id=${value.entityId} AND profile=${value.profile} RETURNING id`;
      return (await state.read(rows[0]!.id))!;
    });
    service = new MarketplaceButtonPolicyService(db as PrismaService, config, state, {
      attest,
    } as unknown as MarketplaceAccessService);
  });
  beforeEach(async () => {
    const entityId = '-' + String(Date.now()) + String(Math.floor(Math.random() * 10000));
    firstBinding = randomUUID();
    secondBinding = randomUUID();
    input = { actorUserId: firstActor, entityId, kind: 'CHAT', profile: 'moderation' };
    await db.chat.create({
      data: { id: entityId, title: 'Synthetic Birzhik policy chat', entityType: 'CHAT' },
    });
    await db.chatBotMembership.create({
      data: { chatId: entityId, botId, status: 'ACTIVE', botAccessState: 'UNKNOWN' },
    });
    for (const [id, actor] of [
      [firstBinding, firstActor],
      [secondBinding, secondActor],
    ]) {
      await db.$executeRaw`INSERT INTO marketplace_bindings(id,actor_user_id,entity_id,kind,profile,bot_id,state,checked_at,valid_until,metadata,statistics_consent)
        VALUES(${id}::uuid,${actor},${entityId},'CHAT','moderation',${botId},'ACTIVE',now(),now()+interval '5 minutes',${JSON.stringify({ title: 'Synthetic platform', description: '', imageUrl: null, publicUrl: null, audience: 10, isPublic: true })}::jsonb,false)`;
    }
    const listingId = randomUUID();
    entry = {
      entityId,
      kind: 'CHAT',
      profile: 'moderation',
      publicState: 'PUBLIC',
      listing: {
        id: listingId,
        ownershipKey: 'a'.repeat(64),
        title: 'Synthetic Birzhik profile',
        publicUrl: `https://max.ru/id613000037577_3_bot?startapp=listing_chat_${listingId}`,
        profileOnly: false,
      },
      isOwner: false,
      canCreate: false,
      manageUrl: null,
      connectUrl: `https://max.ru/id613000037577_3_bot?startapp=connect_chat_${entityId}`,
      checkedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 300_000).toISOString(),
    };
    read = jest.spyOn(service, 'readEntry').mockImplementation(async () => entry);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    attest.mockClear();
    await db.$executeRaw`DELETE FROM marketplace_button_requests WHERE policy_id IN(SELECT id FROM marketplace_button_policies WHERE entity_id=${input.entityId})`;
    await db.$executeRaw`DELETE FROM marketplace_button_contexts WHERE policy_id IN(SELECT id FROM marketplace_button_policies WHERE entity_id=${input.entityId})`;
    await db.$executeRaw`DELETE FROM marketplace_button_policies WHERE entity_id=${input.entityId}`;
    await db.$executeRaw`DELETE FROM marketplace_policy_requests WHERE binding_id IN(SELECT id FROM marketplace_bindings WHERE entity_id=${input.entityId})`;
    await db.$executeRaw`DELETE FROM marketplace_bindings WHERE entity_id=${input.entityId}`;
    await db.chat.delete({ where: { id: input.entityId } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  const command = (enabled = true, expectedRevision = 0) => ({
    requestId: randomUUID(),
    expectedRevision,
    context: 'MODERATION_NOTICES',
    enabled,
  });
  const resolve = () =>
    state.resolvePublicationButton({ chatId: input.entityId, botId, purpose: 'MODERATION_NOTICE' });
  async function due() {
    await db.$executeRaw`UPDATE marketplace_button_contexts SET refresh_at=now()-interval '1 day' WHERE policy_id IN(SELECT id FROM marketplace_button_policies WHERE entity_id=${input.entityId})`;
    await service.refresh('moderation', () => false);
  }
  it('shares one policy across administrators and does not turn on statistics or other contexts', async () => {
    expect((await service.get(input)).contexts.map((row) => row.enabled)).toEqual([false, false]);
    const result = await service.mutate(input, command());
    expect(result.contexts.find((row) => row.context === 'MODERATION_NOTICES')).toMatchObject({
      enabled: true,
      effective: true,
    });
    expect(await service.get({ ...input, actorUserId: secondActor })).toEqual(result);
    expect(await resolve()).toEqual({ url: entry.listing!.publicUrl, revision: 1 });
    expect(
      await state.resolvePublicationButton({ chatId: input.entityId, botId, purpose: 'GREETING' }),
    ).toBeNull();
    expect(
      await state.resolvePublicationButton({
        chatId: input.entityId,
        botId: 'unrelated-bot',
        purpose: 'MODERATION_NOTICE',
      }),
    ).toBeNull();
    expect((await state.read(firstBinding))!.statistics_consent).toBe(false);
    expect((await state.read(secondBinding))!.statistics_consent).toBe(false);
  });
  it('serializes competing admins, replays the exact request and rejects request-key reuse', async () => {
    const first = command();
    const second = command();
    const results = await Promise.allSettled([
      service.mutate(input, first),
      service.mutate({ ...input, actorUserId: secondActor }, second),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((row) => row.status === 'rejected')).toHaveLength(1);
    const winner =
      results[0]!.status === 'fulfilled' ? input : { ...input, actorUserId: secondActor };
    const request = results[0]!.status === 'fulfilled' ? first : second;
    const settled = results.find((row) => row.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<typeof service.mutate>>
    >;
    expect(await service.mutate(winner, request)).toEqual(settled.value);
    await expect(service.mutate(winner, { ...request, enabled: false })).rejects.toThrow(
      'Идентификатор запроса уже использован',
    );
    expect((await service.get(input)).revision).toBe(1);
  });
  it('lets another admin turn it off during peer outage and fences subsequent dispatch', async () => {
    await service.mutate(input, command());
    read.mockRejectedValue(new Error('peer unavailable'));
    const result = await service.mutate({ ...input, actorUserId: secondActor }, command(false, 1));
    expect(result.contexts.find((row) => row.context === 'MODERATION_NOTICES')?.enabled).toBe(
      false,
    );
    expect(await resolve()).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('fails closed after proof expiry and refreshes independently of statistics consent', async () => {
    await service.mutate(input, command());
    await db.$executeRaw`UPDATE marketplace_button_contexts SET verified_until=now()-interval '1 second' WHERE policy_id IN(SELECT id FROM marketplace_button_policies WHERE entity_id=${input.entityId})`;
    expect(await resolve()).toBeNull();
    await due();
    expect(await resolve()).not.toBeNull();
    expect((await state.read(firstBinding))!.statistics_consent).toBe(false);
  });
  it('preserves consent during a temporary profile pause but requires reconfirmation after ownership changes', async () => {
    await service.mutate(input, command());
    const published = entry;
    entry = { ...entry, publicState: 'HIDDEN', listing: null, validUntil: null };
    await due();
    expect(await resolve()).toBeNull();
    entry = published;
    await due();
    expect(await resolve()).not.toBeNull();
    entry = { ...entry, listing: { ...entry.listing!, ownershipKey: 'b'.repeat(64) } };
    await due();
    expect(await resolve()).toBeNull();
    expect(
      (await service.get(input)).contexts.find((row) => row.context === 'MODERATION_NOTICES')
        ?.status,
    ).toBe('CONFIRM_REQUIRED');
    await service.mutate({ ...input, actorUserId: secondActor }, command(true, 1));
    expect(await resolve()).not.toBeNull();
  });
  it('a removed confirmer cannot be silently restored by a newer positive access proof', async () => {
    await service.mutate(input, command());
    await db.chatMembershipActivityEvent.create({
      data: {
        chatId: input.entityId,
        userId: firstActor,
        eventType: 'user_removed',
        eventAt: new Date(Date.now() + 1000),
        dedupeKey: randomUUID(),
      },
    });
    expect(await resolve()).toBeNull();
    await due();
    await db.chatMembershipActivityEvent.deleteMany({ where: { chatId: input.entityId } });
    await db.$executeRaw`UPDATE marketplace_bindings SET checked_at=now(),valid_until=now()+interval '5 minutes' WHERE id=${firstBinding}::uuid`;
    expect(await resolve()).toBeNull();
    await service.mutate({ ...input, actorUserId: secondActor }, command(true, 1));
    expect(await resolve()).not.toBeNull();
  });
  it('does not let an in-flight refresh restore a switch disabled by another administrator', async () => {
    await service.mutate(input, command());
    let release!: (value: MarketplaceEntryResponse) => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    read.mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const refresh = due();
    await reached;
    await service.mutate({ ...input, actorUserId: secondActor }, command(false, 1));
    release(entry);
    await refresh;
    expect(await resolve()).toBeNull();
    expect((await service.get(input)).revision).toBe(2);
  });
  it('channel decoration starts at explicit activation and does not include earlier posts', async () => {
    input.kind = 'CHANNEL';
    entry.kind = 'CHANNEL';
    entry.listing!.publicUrl = entry.listing!.publicUrl!.replace(
      'listing_chat_',
      'listing_channel_',
    );
    await db.$executeRaw`UPDATE marketplace_bindings SET kind='CHANNEL' WHERE entity_id=${input.entityId}`;
    await service.mutate(input, { ...command(), context: 'CHANNEL_POSTS' });
    const activation = await state.channelPostActivation(input.entityId);
    expect(activation).toBeInstanceOf(Date);
    expect(
      await state.resolvePublicationButton({
        chatId: input.entityId,
        botId,
        purpose: 'CHANNEL_POST',
        sourceAt: new Date(activation!.getTime() - 1),
      }),
    ).toBeNull();
    expect(
      await state.resolvePublicationButton({
        chatId: input.entityId,
        botId,
        purpose: 'CHANNEL_POST',
        sourceAt: new Date(activation!.getTime() + 1),
      }),
    ).not.toBeNull();
    expect(
      await state.resolvePublicationButton({
        chatId: input.entityId,
        botId,
        purpose: 'CHANNEL_POST',
      }),
    ).toBeNull();
  });
  it('imports old opt-ins only for their original publication context', async () => {
    await db.$executeRaw`UPDATE marketplace_bindings SET statistics_consent=true,append_enabled=true,profile_snapshot=${JSON.stringify({ listing: { id: entry.listing!.id } })}::jsonb WHERE id=${firstBinding}::uuid`;
    const current = await service.get(input);
    expect(
      current.contexts
        .filter((row) => row.context !== 'PUBLICATIONS')
        .every((row) => row.enabled === false),
    ).toBe(true);
    expect(current.contexts.find((row) => row.context === 'PUBLICATIONS')?.enabled).toBe(true);
    entry.listing!.ownershipKey = createHash('sha256')
      .update(`birzhik-owner-v1:${entry.listing!.id}:${firstActor}`)
      .digest('hex');
    await due();
    expect(
      await state.resolvePublicationButton({
        chatId: input.entityId,
        botId,
        purpose: 'PUBLICATION',
      }),
    ).not.toBeNull();
    expect(await resolve()).toBeNull();
    expect(
      await state.resolvePublicationButton({ chatId: input.entityId, botId, purpose: 'GREETING' }),
    ).toBeNull();
  });
  it('keeps Publisher opt-ins and sending authority separate from moderation', async () => {
    await service.mutate(input, command());
    await db.publisherEntityBinding.create({
      data: {
        chatId: input.entityId,
        publisherBotId: 'fixture-publisher',
        status: 'ACTIVE',
        botAccessState: 'UNKNOWN',
      },
    });
    const publisherBinding = randomUUID();
    await db.$executeRaw`INSERT INTO marketplace_bindings(id,actor_user_id,entity_id,kind,profile,bot_id,state,checked_at,valid_until,metadata,statistics_consent)
      VALUES(${publisherBinding}::uuid,${firstActor},${input.entityId},'CHAT','publisher','fixture-publisher','ACTIVE',now(),now()+interval '5 minutes',${JSON.stringify({ title: 'Synthetic platform', description: '', imageUrl: null, publicUrl: null, audience: 10, isPublic: true })}::jsonb,false)`;
    const publisher = { ...input, profile: 'publisher' as const };
    expect((await service.get(publisher)).contexts).toEqual([
      expect.objectContaining({ context: 'PUBLICATIONS', enabled: false }),
    ]);
    expect(
      await state.resolvePublicationButton({
        chatId: input.entityId,
        botId: 'fixture-publisher',
        purpose: 'PUBLICATION',
      }),
    ).toBeNull();
    entry = { ...entry, profile: 'publisher' };
    await service.mutate(publisher, { ...command(), context: 'PUBLICATIONS' });
    expect(
      await state.resolvePublicationButton({
        chatId: input.entityId,
        botId: 'fixture-publisher',
        purpose: 'PUBLICATION',
      }),
    ).not.toBeNull();
    expect(
      await state.resolvePublicationButton({
        chatId: input.entityId,
        botId,
        purpose: 'PUBLICATION',
      }),
    ).toBeNull();
    await service.mutate(input, command(false, 1));
    expect(
      await state.resolvePublicationButton({
        chatId: input.entityId,
        botId: 'fixture-publisher',
        purpose: 'PUBLICATION',
      }),
    ).not.toBeNull();
  });

  it('persists known denial across a positive regrant before the next refresh', async () => {
    await service.mutate(input, command());
    await db.$executeRaw`UPDATE marketplace_bindings SET state='REVOKED',checked_at=now() WHERE id=${firstBinding}::uuid`;
    await db.$executeRaw`UPDATE marketplace_bindings SET state='ACTIVE',checked_at=now(),valid_until=now()+interval '5 minutes' WHERE id=${firstBinding}::uuid`;
    expect(await resolve()).toBeNull();
    await due();
    expect(
      (await service.get(input)).contexts.find((row) => row.context === 'MODERATION_NOTICES')
        ?.status,
    ).toBe('CONFIRM_REQUIRED');
    await service.mutate({ ...input, actorUserId: secondActor }, command(true, 1));
    expect(await resolve()).not.toBeNull();
  });
  it('requires a fresh exact actor proof when enabling despite a still-valid old binding', async () => {
    await db.$executeRaw`UPDATE marketplace_bindings SET checked_at=now()-interval '10 minutes',valid_until=now()+interval '5 minutes' WHERE id=${firstBinding}::uuid`;
    await service.mutate(input, command());
    expect(attest).toHaveBeenCalledWith(input);
    expect((await state.read(firstBinding))!.checked_at!.getTime()).toBeGreaterThan(
      Date.now() - 10_000,
    );
    const rows = await db.$queryRaw<
      Array<{ valid: boolean }>
    >`SELECT c.verified_until<=b.checked_at+interval '5 minutes' valid FROM marketplace_button_contexts c JOIN marketplace_bindings b ON b.id=c.binding_id WHERE b.id=${firstBinding}::uuid`;
    expect(rows).toEqual([{ valid: true }]);
  });
  it('refuses an enable when the returned actor proof is already older than five minutes', async () => {
    await db.$executeRaw`UPDATE marketplace_bindings SET checked_at=now()-interval '10 minutes',valid_until=now()+interval '5 minutes' WHERE id=${firstBinding}::uuid`;
    const stale = (await state.read(firstBinding))!;
    const original = attest.getMockImplementation()!;
    attest.mockImplementation(async () => stale);
    try {
      await expect(service.mutate(input, command())).rejects.toThrow('Проверка профиля истекла');
    } finally {
      attest.mockImplementation(original);
    }
    expect(await resolve()).toBeNull();
  });
  it('shares one remote proof across contexts confirmed by the same administrator', async () => {
    await service.mutate(input, command());
    await service.mutate(input, { ...command(true, 1), context: 'GREETINGS' });
    read.mockClear();
    attest.mockClear();
    await due();
    expect(read).toHaveBeenCalledTimes(1);
    expect(attest).toHaveBeenCalledTimes(1);
    expect((await service.get(input)).contexts.every((row) => row.effective)).toBe(true);
  });
  it('remembers a managed-access denial even if a positive edge replaces it before refresh', async () => {
    await service.mutate(input, command());
    await db.managedEntityAccessEdge.create({
      data: {
        chatId: input.entityId,
        userId: firstActor,
        botId,
        state: 'USER_DENIED',
        userRole: 'MEMBER',
        botRole: 'ADMIN',
        checkedAt: new Date(),
      },
    });
    await db.managedEntityAccessEdge.update({
      where: { chatId_userId_botId: { chatId: input.entityId, userId: firstActor, botId } },
      data: { state: 'GRANTED', userRole: 'ADMIN', checkedAt: new Date() },
    });
    expect(await resolve()).toBeNull();
    await due();
    expect(
      (await service.get(input)).contexts.find((row) => row.context === 'MODERATION_NOTICES')
        ?.status,
    ).toBe('CONFIRM_REQUIRED');
    await service.mutate({ ...input, actorUserId: secondActor }, command(true, 1));
    expect(await resolve()).not.toBeNull();
  });
  it.each(['integration', 'profile'] as const)(
    'keeps button authority separate from %s statistics withdrawal and renewal',
    async (source) => {
      await db.$executeRaw`UPDATE marketplace_bindings SET statistics_consent=true WHERE id=${firstBinding}::uuid`;
      await service.mutate(input, command());
      const before = (await state.read(firstBinding))!;
      const controller = new MarketplaceIntegrationController(
        {} as MarketplaceAccessService,
        state,
        {} as MarketplaceStatisticsService,
        db as PrismaService,
        new MarketplaceProfileAccessService(db as PrismaService, state, {
          attest,
        } as unknown as MarketplaceAccessService),
      );
      if (source === 'integration')
        await controller.revoke(firstBinding, {
          requestId: randomUUID(),
          expectedRevision: before.revision,
        });
      else {
        const legacy = new MarketplaceProfileService(
          db as PrismaService,
          new ConfigService(),
          state,
          { attest: () => state.read(firstBinding) } as unknown as MarketplaceAccessService,
        );
        jest.spyOn(legacy, 'relay').mockResolvedValue({
          bindingId: firstBinding,
          entityId: input.entityId,
          kind: input.kind,
          revision: 0,
          listing: null,
          choices: { topics: [], regions: [] },
        });
        const profile = await legacy.get(firstActor, input.kind, input.entityId, input.profile);
        await legacy.mutate(firstActor, input.kind, input.entityId, input.profile, {
          action: 'revoke',
          requestId: randomUUID(),
          expectedRevision: profile.appendRevision,
        });
      }
      expect(await state.read(firstBinding)).toMatchObject({
        state: 'ACTIVE',
        checked_at: before.checked_at,
        valid_until: before.valid_until,
        statistics_consent: false,
        statistics_revoked_at: expect.any(Date),
        last_button_access_loss_at: null,
      });
      expect(await resolve()).not.toBeNull();
      await due();
      expect(await resolve()).not.toBeNull();
      expect(await controller.get(firstBinding)).toMatchObject({
        state: 'REVOKED',
        validUntil: null,
        statisticsConsent: false,
      });
      expect(await controller.getAccess(firstBinding)).toMatchObject({
        state: 'ACTIVE',
        statisticsConsent: false,
      });
      await db.$executeRaw`UPDATE marketplace_bindings SET statistics_consent=true,statistics_v2_consent_only=false,statistics_revoked_at=NULL,append_revision=append_revision+1,revision=revision+1 WHERE id=${firstBinding}::uuid`;
      expect(await controller.get(firstBinding)).toMatchObject({
        state: 'ACTIVE',
        statisticsConsent: true,
      });
      expect(await resolve()).not.toBeNull();
      await db.$executeRaw`UPDATE marketplace_bindings SET state='REVOKED',checked_at=now() WHERE id=${firstBinding}::uuid`;
      await attest(input);
      expect(await resolve()).toBeNull();
      await due();
      expect(
        (await service.get(input)).contexts.find((row) => row.context === 'MODERATION_NOTICES')
          ?.status,
      ).toBe('CONFIRM_REQUIRED');
    },
  );
  async function legacyOptIn() {
    await db.$executeRaw`UPDATE marketplace_bindings SET statistics_consent=true,append_enabled=true,profile_snapshot=${JSON.stringify({ listing: { id: entry.listing!.id } })}::jsonb WHERE id=${firstBinding}::uuid`;
    await service.get(input);
  }
  function legacyOffReceipt() {
    const requestId = randomUUID();
    return {
      requestId,
      hash: createHash('sha256')
        .update(
          JSON.stringify({
            bindingId: firstBinding,
            action: 'toggle',
            requestId,
            expectedRevision: 0,
            appendEnabled: false,
          }),
        )
        .digest('hex'),
      result: JSON.stringify({
        binding: { id: firstBinding },
        appendEnabled: false,
        appendRevision: 1,
      }),
    };
  }
  it('mirrors only an exact old off receipt into PUBLICATIONS and leaves new contexts unchanged', async () => {
    await legacyOptIn();
    await service.mutate(input, { ...command(), context: 'GREETINGS' });
    const fake = legacyOffReceipt();
    await db.$executeRaw`INSERT INTO marketplace_policy_requests(request_id,binding_id,payload_hash,result) VALUES(${fake.requestId}::uuid,${firstBinding}::uuid,${'0'.repeat(64)},${fake.result}::jsonb)`;
    expect(
      (await service.get(input)).contexts.find((row) => row.context === 'PUBLICATIONS')?.enabled,
    ).toBe(true);
    const valid = legacyOffReceipt();
    await db.$executeRaw`INSERT INTO marketplace_policy_requests(request_id,binding_id,payload_hash,result) VALUES(${valid.requestId}::uuid,${firstBinding}::uuid,${valid.hash},${valid.result}::jsonb)`;
    const result = await service.get(input);
    expect(result.revision).toBe(2);
    expect(result.contexts.find((row) => row.context === 'PUBLICATIONS')?.enabled).toBe(false);
    expect(result.contexts.find((row) => row.context === 'GREETINGS')?.enabled).toBe(true);
  });
  it('serializes an old binding-first off receipt with a new platform toggle without deadlock', async () => {
    await legacyOptIn();
    let releaseRead!: (value: MarketplaceEntryResponse) => void;
    let enteredRead!: () => void;
    const reachedRead = new Promise<void>((resolve) => {
      enteredRead = resolve;
    });
    read.mockImplementationOnce(() => {
      enteredRead();
      return new Promise((resolve) => {
        releaseRead = resolve;
      });
    });
    const mutation = service.mutate(input, { ...command(), context: 'PUBLICATIONS' }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await reachedRead;
    let releaseReceipt!: () => void;
    let held!: (pid: number) => void;
    const oldHasBinding = new Promise<number>((resolve) => {
      held = resolve;
    });
    const insertReceipt = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    const receipt = legacyOffReceipt();
    const oldWriter = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM marketplace_bindings WHERE id=${firstBinding}::uuid FOR UPDATE`;
        await tx.$executeRaw`UPDATE marketplace_bindings SET append_enabled=false,append_revision=append_revision+1,revision=revision+1 WHERE id=${firstBinding}::uuid`;
        const pidRows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() pid`;
        held(pidRows[0]!.pid);
        await insertReceipt;
        await tx.$executeRaw`INSERT INTO marketplace_policy_requests(request_id,binding_id,payload_hash,result) VALUES(${receipt.requestId}::uuid,${firstBinding}::uuid,${receipt.hash},${receipt.result}::jsonb)`;
      },
      { timeout: 10_000 },
    );
    const pid = await oldHasBinding;
    releaseRead(entry);
    let blocked = false;
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rows = await db.$queryRaw<
          Array<{ blocked: boolean }>
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE ${pid}::int=ANY(pg_blocking_pids(a.pid))) blocked`;
        if (rows[0]!.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      releaseReceipt();
    }
    await oldWriter;
    const outcome = await mutation;
    expect(blocked).toBe(true);
    expect('error' in outcome && outcome.error).toMatchObject({ status: 409 });
    expect(
      (await service.get(input)).contexts.find((row) => row.context === 'PUBLICATIONS')?.enabled,
    ).toBe(false);
  });
  it('refreshes an older-than-five-minute administrator proof before disabling without reading the peer', async () => {
    await service.mutate(input, command());
    await db.$executeRaw`UPDATE marketplace_bindings SET checked_at=now()-interval '6 minutes',valid_until=now()+interval '9 minutes' WHERE id=${secondBinding}::uuid`;
    const calls = read.mock.calls.length;
    attest.mockRejectedValueOnce(new Error('Administrator access denied'));
    await expect(
      service.mutate({ ...input, actorUserId: secondActor }, command(false, 1)),
    ).rejects.toThrow('Administrator access denied');
    expect(read).toHaveBeenCalledTimes(calls);
    expect(await resolve()).not.toBeNull();
    await service.mutate({ ...input, actorUserId: secondActor }, command(false, 1));
    expect(read).toHaveBeenCalledTimes(calls);
    expect(await resolve()).toBeNull();
  });
  it('waits for an old off writer before the first standalone legacy import', async () => {
    await db.$executeRaw`UPDATE marketplace_bindings SET statistics_consent=true,append_enabled=true,profile_snapshot=${JSON.stringify({ listing: { id: entry.listing!.id } })}::jsonb WHERE id=${firstBinding}::uuid`;
    let releaseReceipt!: () => void;
    let held!: (pid: number) => void;
    const oldHasBinding = new Promise<number>((resolve) => {
      held = resolve;
    });
    const insertReceipt = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    const receipt = legacyOffReceipt();
    const oldWriter = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM marketplace_bindings WHERE id=${firstBinding}::uuid FOR UPDATE`;
        await tx.$executeRaw`UPDATE marketplace_bindings SET append_enabled=false,append_revision=append_revision+1,revision=revision+1 WHERE id=${firstBinding}::uuid`;
        const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() pid`;
        held(rows[0]!.pid);
        await insertReceipt;
        await tx.$executeRaw`INSERT INTO marketplace_policy_requests(request_id,binding_id,payload_hash,result) VALUES(${receipt.requestId}::uuid,${firstBinding}::uuid,${receipt.hash},${receipt.result}::jsonb)`;
      },
      { timeout: 10_000 },
    );
    const pid = await oldHasBinding;
    const importing = service.get(input);
    let blocked = false;
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rows = await db.$queryRaw<
          Array<{ blocked: boolean }>
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE ${pid}::int=ANY(pg_blocking_pids(a.pid))) blocked`;
        if (rows[0]!.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      releaseReceipt();
    }
    await oldWriter;
    const result = await importing;
    expect(blocked).toBe(true);
    expect(result.contexts.every((row) => row.enabled === false)).toBe(true);
    expect(
      await db.$queryRaw<
        Array<{ count: number }>
      >`SELECT count(*)::int count FROM marketplace_button_policies WHERE entity_id=${input.entityId}`,
    ).toEqual([{ count: 0 }]);
  });
  it('retains the old publication opt-in when the first operation enables a new context', async () => {
    await db.$executeRaw`UPDATE marketplace_bindings SET statistics_consent=true,append_enabled=true,profile_snapshot=${JSON.stringify({ listing: { id: entry.listing!.id } })}::jsonb WHERE id=${firstBinding}::uuid`;
    const result = await service.mutate(input, command());
    expect(result.contexts.find((row) => row.context === 'PUBLICATIONS')?.enabled).toBe(true);
    expect(result.contexts.find((row) => row.context === 'MODERATION_NOTICES')?.enabled).toBe(true);
  });
});
