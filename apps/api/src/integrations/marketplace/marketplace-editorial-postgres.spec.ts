import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, createPrismaAdapter } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ManagedEntitiesService } from '../../admin/managed-entities.service';
import type { MaxClientService } from '../../max/max-client.service';
import type { PublisherIdentityAttestationService } from '../../publisher/publisher-identity-attestation.service';
import { MarketplaceAccessService } from './marketplace-access.service';
import { MarketplaceProfileAccessService } from './marketplace-profile-access.service';
import { MarketplaceStateService } from './marketplace-state.service';
import { MarketplaceEditorialAccessService } from './marketplace-editorial-access.service';
import { MarketplaceEditorialService } from './marketplace-editorial.service';
import type { MarketplaceEditorialState } from '@maxim/contracts/marketplace-integration';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const native = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);
native.each(['moderation', 'publisher'] as const)(
  'editorial %s rights with native PostgreSQL',
  (profile) => {
    let db: PrismaClient, state: MarketplaceStateService, access: MarketplaceAccessService;
    let proof: MarketplaceEditorialAccessService, editorial: MarketplaceEditorialService;
    let entityId: string, id: string, otherId: string;
    const actor = '933001',
      otherActor = '933002',
      botId = 'fixture-editorial-bot';
    const kind = profile === 'moderation' ? 'CHAT' : 'CHANNEL';
    const config = new ConfigService({
      SVYAZKA_ANALYTICS_TOKEN: 'synthetic-analytics',
      SVYAZKA_PROFILE_TOKEN: 'synthetic-editorial',
    });
    const oldRole = process.env.APP_ROLE,
      oldService = process.env.APP_SERVICE_NAME;
    let max: jest.Mocked<
      Pick<
        MaxClientService,
        'getChatSnapshot' | 'getCurrentChatMemberAccess' | 'getChatMemberAccess'
      >
    >;
    beforeAll(async () => {
      const url = new URL(databaseUrl);
      if (
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        !/^\/(?:race_test|maxim_race_test_[a-zA-Z0-9_]+)$/.test(url.pathname)
      )
        throw new Error('Disposable local race_test database required');
      db = new PrismaClient({
        adapter: createPrismaAdapter(databaseUrl, { max: 4, statement_timeout: 10_000 }),
      });
      await db.$connect();
      state = new MarketplaceStateService(db as PrismaService, config);
    });
    beforeEach(async () => {
      process.env.APP_ROLE = profile === 'publisher' ? 'publisher' : 'admin';
      process.env.APP_SERVICE_NAME = profile === 'publisher' ? 'api-publisher' : 'api-admin';
      id = randomUUID();
      otherId = randomUUID();
      entityId = '-' + Date.now() + String(Math.floor(Math.random() * 10000));
      await db.chat.create({
        data: { id: entityId, title: 'Synthetic editorial', entityType: kind },
      });
      if (profile === 'publisher')
        await db.publisherEntityBinding.create({
          data: {
            chatId: entityId,
            publisherBotId: botId,
            status: 'ACTIVE',
            botAccessState: 'UNKNOWN',
          },
        });
      else
        await db.chatBotMembership.create({
          data: { chatId: entityId, botId, status: 'ACTIVE', botAccessState: 'UNKNOWN' },
        });
      const metadata = JSON.stringify({
        title: 'Synthetic editorial',
        description: '',
        imageUrl: null,
        publicUrl: null,
        audience: 10,
        isPublic: true,
      });
      for (const [bindingId, user] of [
        [id, actor],
        [otherId, otherActor],
      ])
        await db.$executeRaw`INSERT INTO marketplace_bindings(id,actor_user_id,entity_id,kind,profile,bot_id,state,checked_at,valid_until,metadata,statistics_consent,statistics_revoked_at)
        VALUES(${bindingId}::uuid,${user},${entityId},${kind},${profile},${botId},'ACTIVE',now()-interval '3 minutes',now()+interval '2 minutes',${metadata}::jsonb,false,now()-interval '1 day')`;
      max = {
        getChatSnapshot: jest
          .fn<
            ReturnType<MaxClientService['getChatSnapshot']>,
            Parameters<MaxClientService['getChatSnapshot']>
          >()
          .mockImplementation(async () => ({
            chatId: entityId,
            entityType: kind === 'CHAT' ? 'chat' : 'channel',
            title: 'Synthetic editorial',
            description: '',
            avatarUrl: null,
            link: null,
            participantsCount: 10,
            isPublic: true,
            status: 'active',
            lastEventAt: null,
          })),
        getCurrentChatMemberAccess: jest
          .fn<
            ReturnType<MaxClientService['getCurrentChatMemberAccess']>,
            Parameters<MaxClientService['getCurrentChatMemberAccess']>
          >()
          .mockResolvedValue({
            userId: botId,
            isAdmin: true,
            isOwner: false,
            isBot: true,
            permissions: [],
          }),
        getChatMemberAccess: jest
          .fn<
            ReturnType<MaxClientService['getChatMemberAccess']>,
            Parameters<MaxClientService['getChatMemberAccess']>
          >()
          .mockImplementation(async (_entity, userId) => ({
            userId,
            isAdmin: true,
            isOwner: false,
            isBot: false,
            permissions: [],
          })),
      };
      const entities = {
        assertManagedEntityAdminAccess: jest
          .fn<
            ReturnType<ManagedEntitiesService['assertManagedEntityAdminAccess']>,
            Parameters<ManagedEntitiesService['assertManagedEntityAdminAccess']>
          >()
          .mockResolvedValue(undefined),
        resolveManagedEntityReadBotId: jest
          .fn<
            ReturnType<ManagedEntitiesService['resolveManagedEntityReadBotId']>,
            Parameters<ManagedEntitiesService['resolveManagedEntityReadBotId']>
          >()
          .mockResolvedValue(botId),
      } satisfies Pick<
        ManagedEntitiesService,
        'assertManagedEntityAdminAccess' | 'resolveManagedEntityReadBotId'
      >;
      const publisher = {
        assertAttested: jest
          .fn<
            ReturnType<PublisherIdentityAttestationService['assertAttested']>,
            Parameters<PublisherIdentityAttestationService['assertAttested']>
          >()
          .mockResolvedValue(undefined),
      } satisfies Pick<PublisherIdentityAttestationService, 'assertAttested'>;
      access = new MarketplaceAccessService(
        db as PrismaService,
        entities as unknown as ManagedEntitiesService,
        max as unknown as MaxClientService,
        state,
        undefined,
        publisher as unknown as PublisherIdentityAttestationService,
        config,
      );
      proof = new MarketplaceEditorialAccessService(
        state,
        access,
        new MarketplaceProfileAccessService(db as PrismaService, state, access),
      );
      editorial = new MarketplaceEditorialService(db as PrismaService, config, state, access);
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      await db.$executeRaw`DELETE FROM marketplace_bindings WHERE entity_id=${entityId}`;
      await db.chat.delete({ where: { id: entityId } });
      if (oldRole === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = oldRole;
      if (oldService === undefined) delete process.env.APP_SERVICE_NAME;
      else process.env.APP_SERVICE_NAME = oldService;
    });
    afterAll(async () => db?.$disconnect());
    const request = () => ({
      version: 1 as const,
      scope: 'PROFILE_DESCRIPTION' as const,
      requestId: randomUUID(),
      actorUserId: actor,
      entityId,
      kind,
      profile,
      bindingId: id,
    });
    it('proves two independent administrators while preserving revoked statistics and disabled buttons', async () => {
      const before = (await state.read(id))!;
      const [first, second] = await Promise.all([
        proof.prove(request()),
        proof.prove({ ...request(), actorUserId: otherActor, bindingId: otherId }),
      ]);
      expect(first.state).toBe('ACTIVE');
      expect(second.state).toBe('ACTIVE');
      for (const result of [first, second])
        expect(Date.parse(result.validUntil!) - Date.parse(result.checkedAt!)).toBe(30_000);
      expect(await state.read(id)).toMatchObject({
        statistics_consent: false,
        statistics_revoked_at: before.statistics_revoked_at,
        append_enabled: false,
        append_revision: before.append_revision,
        profile_revision: before.profile_revision,
      });
      expect(await state.hasActiveGrant(id)).toBe(false);
      expect(max.getChatMemberAccess).toHaveBeenCalledWith(
        entityId,
        actor,
        expect.objectContaining({ botId, bypassCache: true, trafficClass: 'interactive' }),
      );
      expect(
        await db.$queryRaw`SELECT count(*)::int count FROM marketplace_button_policies WHERE entity_id=${entityId}`,
      ).toEqual([{ count: 0 }]);
    });
    it('fails closed for a removal during MAX attestation without overwriting the older proof', async () => {
      const before = (await state.read(id))!;
      max.getChatSnapshot.mockImplementationOnce(async () => {
        await db.chatMembershipActivityEvent.create({
          data: {
            chatId: entityId,
            userId: actor,
            eventType: 'user_removed',
            eventAt: new Date(Date.now() + 1000),
            dedupeKey: randomUUID(),
          },
        });
        return {
          chatId: entityId,
          entityType: kind === 'CHAT' ? 'chat' : 'channel',
          title: '',
          avatarUrl: null,
          link: null,
          participantsCount: 10,
          isPublic: true,
          status: 'active',
          lastEventAt: null,
        };
      });
      expect(await proof.prove(request())).toMatchObject({ state: 'REVOKED', validUntil: null });
      expect((await state.read(id))!.checked_at).toEqual(before.checked_at);
    });
    it('sees a binding revocation after the SQL access gate in its final read', async () => {
      const original = state.hasActiveAccess.bind(state);
      jest.spyOn(state, 'hasActiveAccess').mockImplementationOnce(async (bindingId) => {
        const active = await original(bindingId);
        await db.$executeRaw`UPDATE marketplace_bindings SET state='REVOKED',checked_at=now(),valid_until=NULL,revision=revision+1 WHERE id=${id}::uuid`;
        return active;
      });
      const result = await proof.prove(request());
      expect(result).toMatchObject({
        state: 'REVOKED',
        validUntil: null,
        bindingRevision: (await state.read(id))!.revision,
      });
    });
    it('keeps a failed fresh attempt unknown even if the old stored proof is still recent', async () => {
      await db.$executeRaw`UPDATE marketplace_bindings SET checked_at=now()-interval '10 seconds' WHERE id=${id}::uuid`;
      const before = (await state.read(id))!;
      max.getChatSnapshot.mockRejectedValue(new Error('synthetic outage'));
      expect(await proof.prove(request())).toMatchObject({
        state: 'UNKNOWN',
        checkedAt: null,
        validUntil: null,
      });
      expect(await state.read(id)).toMatchObject({
        state: before.state,
        checked_at: before.checked_at,
        valid_until: before.valid_until,
      });
    });
    it.each(['actor', 'entity', 'kind', 'profile', 'binding'] as const)(
      'rejects a substituted %s before MAX',
      async (field) => {
        const input = request();
        if (field === 'actor') input.actorUserId = otherActor;
        if (field === 'entity') input.entityId = '-999';
        if (field === 'kind') Object.assign(input, { kind: kind === 'CHAT' ? 'CHANNEL' : 'CHAT' });
        if (field === 'profile')
          Object.assign(input, { profile: profile === 'publisher' ? 'moderation' : 'publisher' });
        if (field === 'binding') input.bindingId = randomUUID();
        await expect(proof.prove(input)).rejects.toMatchObject({ status: 404 });
        expect(max.getChatSnapshot).not.toHaveBeenCalled();
      },
    );
    it.each(['ownership', 'listing', 'deadline'] as const)(
      'rejects an unrelated relay %s without changing profile state',
      async (changed) => {
        const before = await state.read(id);
        const listingId = randomUUID(),
          ownershipKey = 'a'.repeat(64);
        const result: MarketplaceEditorialState = {
          version: 1,
          entityId,
          kind,
          revision: 8,
          listing: {
            id: listingId,
            title: 'Synthetic',
            description: 'Description',
            profileOnly: false,
            publicUrl: null,
          },
          ownershipKey,
          role: 'EDITOR',
          responsible: { displayName: 'Responsible', profileId: null },
          capabilities: { canEditDescription: true, canManageCommercial: false },
          validUntil: new Date(Date.now() + 30_000).toISOString(),
        };
        if (changed === 'ownership') result.ownershipKey = 'b'.repeat(64);
        if (changed === 'listing') result.listing.id = randomUUID();
        if (changed === 'deadline') result.validUntil = new Date(Date.now() - 1000).toISOString();
        jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(result)));
        await expect(
          editorial.mutate(actor, kind, entityId, profile, {
            requestId: randomUUID(),
            listingId,
            ownershipKey,
            expectedRevision: 7,
            description: 'Updated existing description',
          }),
        ).rejects.toMatchObject({ status: 503 });
        expect(await state.read(id)).toEqual(before);
      },
    );
    it('relays only description/CAS and derives actor and binding independently of owner profile state', async () => {
      const before = (await state.read(id))!,
        otherBefore = await state.read(otherId);
      const listingId = randomUUID(),
        ownershipKey = 'a'.repeat(64);
      const mutation = {
        requestId: randomUUID(),
        listingId,
        ownershipKey,
        expectedRevision: 7,
        description: 'Обновлённое описание существующей площадки',
      };
      const fetch = jest.spyOn(global, 'fetch').mockImplementation(async (_url, options) => {
        const body = JSON.parse(String(options!.body));
        expect(body).toEqual({
          ...mutation,
          actorUserId: actor,
          entityId,
          kind,
          profile,
          bindingId: id,
        });
        const verified = await proof.prove(request());
        expect(verified.state).toBe('ACTIVE');
        const result: MarketplaceEditorialState = {
          version: 1,
          entityId,
          kind,
          revision: 8,
          listing: {
            id: listingId,
            title: 'Synthetic editorial',
            description: mutation.description,
            profileOnly: false,
            publicUrl: null,
          },
          ownershipKey,
          role: 'EDITOR',
          responsible: { displayName: 'Responsible fixture', profileId: null },
          capabilities: { canEditDescription: true, canManageCommercial: false },
          validUntil: verified.validUntil!,
        };
        return new Response(JSON.stringify(result));
      });
      expect(await editorial.mutate(actor, kind, entityId, profile, mutation)).toMatchObject({
        role: 'EDITOR',
        revision: 8,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await state.read(id)).toMatchObject({
        statistics_consent: false,
        statistics_revoked_at: before.statistics_revoked_at,
        append_enabled: false,
        profile_revision: before.profile_revision,
        profile_snapshot: before.profile_snapshot,
      });
      expect(await state.read(otherId)).toEqual(otherBefore);
      await expect(
        editorial.mutate(actor, kind, entityId, profile, { ...mutation, ownerId: otherActor }),
      ).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  },
);
