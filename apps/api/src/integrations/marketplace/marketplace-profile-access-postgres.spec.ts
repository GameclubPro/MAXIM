import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, createPrismaAdapter } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ManagedEntitiesService } from '../../admin/managed-entities.service';
import type { MaxClientService } from '../../max/max-client.service';
import type { PublisherIdentityAttestationService } from '../../publisher/publisher-identity-attestation.service';
import type { BackgroundRuntimeGovernorService } from '../../system/background-runtime-governor.service';
import { MarketplaceAccessService } from './marketplace-access.service';
import { MarketplaceProfileAccessService } from './marketplace-profile-access.service';
import { MarketplaceStateService } from './marketplace-state.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);
postgres.each(['moderation', 'publisher'] as const)(
  'independent %s profile access on PostgreSQL',
  (profile) => {
    let db: PrismaClient;
    let state: MarketplaceStateService;
    let service: MarketplaceProfileAccessService;
    let id: string;
    let entityId: string;
    let max: {
      getChatSnapshot: jest.Mock;
      getCurrentChatMemberAccess: jest.Mock;
      getChatMemberAccess: jest.Mock;
    };
    let governor: { decide: jest.MockedFunction<BackgroundRuntimeGovernorService['decide']> };
    const botId = 'fixture-profile-proof';
    const actor = '933001';
    const kind = profile === 'moderation' ? 'CHAT' : 'CHANNEL';
    const previousRole = process.env.APP_ROLE;
    const previousService = process.env.APP_SERVICE_NAME;
    const config = new ConfigService({
      SVYAZKA_ANALYTICS_TOKEN: 'a'.repeat(64),
      SVYAZKA_PROFILE_TOKEN: 'b'.repeat(64),
    });
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
      state = new MarketplaceStateService(db as PrismaService, config);
    });
    beforeEach(async () => {
      process.env.APP_ROLE = profile === 'publisher' ? 'publisher' : 'admin';
      process.env.APP_SERVICE_NAME = profile === 'publisher' ? 'api-publisher' : 'api-admin';
      id = randomUUID();
      entityId = '-' + Date.now() + String(Math.floor(Math.random() * 10_000));
      await db.chat.create({
        data: { id: entityId, title: 'Synthetic profile access', entityType: kind },
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
      await db.$executeRaw`INSERT INTO marketplace_bindings(id,actor_user_id,entity_id,kind,profile,bot_id,state,checked_at,valid_until,metadata,statistics_consent,statistics_revoked_at)
      VALUES(${id}::uuid,${actor},${entityId},${kind},${profile},${botId},'ACTIVE',now()-interval '3 minutes',now()+interval '2 minutes',${JSON.stringify({ title: 'Synthetic profile', description: '', imageUrl: null, publicUrl: null, audience: 10, isPublic: true })}::jsonb,false,now()-interval '1 day')`;
      max = {
        getChatSnapshot: jest
          .fn()
          .mockImplementation(async () => ({
            chatId: entityId,
            entityType: kind === 'CHAT' ? 'chat' : 'channel',
            title: 'Synthetic profile',
            description: '',
            avatarUrl: null,
            link: null,
            participantsCount: 10,
            isPublic: true,
          })),
        getCurrentChatMemberAccess: jest
          .fn()
          .mockResolvedValue({ userId: botId, isAdmin: true, isOwner: false, isBot: true }),
        getChatMemberAccess: jest
          .fn()
          .mockResolvedValue({ userId: actor, isAdmin: true, isOwner: false, isBot: false }),
      };
      governor = {
        decide: jest
          .fn<
            ReturnType<BackgroundRuntimeGovernorService['decide']>,
            Parameters<BackgroundRuntimeGovernorService['decide']>
          >()
          .mockResolvedValue({ action: 'run', retryAfterMs: 0, reason: 'healthy' }),
      };
      const access = new MarketplaceAccessService(
        db as PrismaService,
        {
          assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
          resolveManagedEntityReadBotId: jest.fn().mockResolvedValue(botId),
        } as unknown as ManagedEntitiesService,
        max as unknown as MaxClientService,
        state,
        undefined,
        {
          assertAttested: jest.fn().mockResolvedValue(undefined),
        } as unknown as PublisherIdentityAttestationService,
        config,
        governor,
      );
      service = new MarketplaceProfileAccessService(db as PrismaService, state, access);
    });
    afterEach(async () => {
      await db.$executeRaw`DELETE FROM marketplace_bindings WHERE id=${id}::uuid`;
      await db.chat.delete({ where: { id: entityId } });
      if (previousRole === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = previousRole;
      if (previousService === undefined) delete process.env.APP_SERVICE_NAME;
      else process.env.APP_SERVICE_NAME = previousService;
      jest.restoreAllMocks();
    });
    afterAll(async () => db?.$disconnect());
    async function loseBot(at = new Date()) {
      const data = { botAccessState: 'LOST' as const, botAccessCheckedAt: at };
      if (profile === 'publisher')
        await db.publisherEntityBinding.update({ where: { chatId: entityId }, data });
      else
        await db.chatBotMembership.update({
          where: { chatId_botId: { chatId: entityId, botId } },
          data,
        });
    }
    it('reuses a fresh proof without MAX and caps its public deadline to five minutes', async () => {
      await db.$executeRaw`UPDATE marketplace_bindings SET checked_at=now(),valid_until=now()+interval '15 minutes' WHERE id=${id}::uuid`;
      const before = (await state.read(id))!;
      const proof = await service.read(id);
      expect(proof.state).toBe('ACTIVE');
      expect(Date.parse(proof.validUntil!)).toBe(before.checked_at!.getTime() + 300_000);
      expect(max.getChatSnapshot).not.toHaveBeenCalled();
      expect(governor.decide).not.toHaveBeenCalled();
    });
    it.each([false, true])(
      'refreshes a %s-expired proof without statistics consent or enabled buttons',
      async (expired) => {
        if (expired)
          await db.$executeRaw`UPDATE marketplace_bindings SET checked_at=now()-interval '10 minutes',valid_until=now()-interval '5 minutes' WHERE id=${id}::uuid`;
        const before = (await state.read(id))!;
        const proof = await service.read(id);
        const current = (await state.read(id))!;
        expect(proof.state).toBe('ACTIVE');
        expect(current.checked_at!.getTime()).toBeGreaterThan(before.checked_at!.getTime());
        expect(Date.parse(proof.validUntil!) - Date.parse(proof.checkedAt!)).toBeLessThanOrEqual(
          300_000,
        );
        expect(current).toMatchObject({
          statistics_consent: false,
          statistics_revoked_at: before.statistics_revoked_at,
          append_enabled: false,
        });
        expect(state.present(current)).toMatchObject({
          state: 'REVOKED',
          validUntil: null,
          statisticsConsent: false,
        });
        expect(max.getChatMemberAccess).toHaveBeenCalledWith(
          entityId,
          actor,
          expect.objectContaining({ botId, bypassCache: true, trafficClass: 'background' }),
        );
        expect(governor.decide).toHaveBeenCalledTimes(1);
        expect(
          await db.$queryRaw<
            Array<{ count: number }>
          >`SELECT count(*)::int count FROM marketplace_button_policies WHERE entity_id=${entityId}`,
        ).toEqual([{ count: 0 }]);
      },
    );
    it('does not passively probe or revive an explicitly revoked binding', async () => {
      await db.$executeRaw`UPDATE marketplace_bindings SET state='REVOKED',checked_at=now() WHERE id=${id}::uuid`;
      expect(await service.read(id)).toMatchObject({ state: 'REVOKED', validUntil: null });
      expect(max.getChatSnapshot).not.toHaveBeenCalled();
    });
    it('rejects a known dormant bot even when its cached actor proof is fresh', async () => {
      await loseBot(new Date(Date.now() - 60_000));
      await db.$executeRaw`UPDATE marketplace_bindings SET checked_at=now(),valid_until=now()+interval '5 minutes' WHERE id=${id}::uuid`;
      expect(await service.read(id)).toMatchObject({ state: 'REVOKED', validUntil: null });
      expect(max.getChatSnapshot).not.toHaveBeenCalled();
    });
    it('blocks a known actor removal before issuing any remote check', async () => {
      await db.chatMembershipActivityEvent.create({
        data: {
          chatId: entityId,
          userId: actor,
          eventType: 'user_removed',
          eventAt: new Date(),
          dedupeKey: randomUUID(),
        },
      });
      expect(await service.read(id)).toMatchObject({ state: 'REVOKED', validUntil: null });
      expect(max.getChatSnapshot).not.toHaveBeenCalled();
    });
    it('never replaces the old proof when a bot becomes dormant during background admission', async () => {
      const before = (await state.read(id))!;
      governor.decide.mockImplementationOnce(async () => {
        await loseBot(new Date(Date.now() - 60_000));
        return { action: 'run', retryAfterMs: 0, reason: 'healthy' };
      });
      expect(await service.read(id)).toMatchObject({ state: 'REVOKED', validUntil: null });
      expect((await state.read(id))!.checked_at).toEqual(before.checked_at);
    });
    it('records an actual fresh actor denial instead of returning an expired proof as active', async () => {
      max.getChatMemberAccess.mockResolvedValue({
        userId: actor,
        isAdmin: false,
        isOwner: false,
        isBot: false,
      });
      expect(await service.read(id)).toMatchObject({ state: 'REVOKED', validUntil: null });
      expect((await state.read(id))!.state).toBe('REVOKED');
    });
    it.each(['outage', 'unknown', 'governor'] as const)(
      'preserves the previous proof deadline on %s',
      async (failure) => {
        const before = (await state.read(id))!;
        if (failure === 'outage')
          max.getChatSnapshot.mockRejectedValue(new Error('peer unavailable'));
        if (failure === 'unknown') max.getChatMemberAccess.mockResolvedValue(null);
        if (failure === 'governor')
          governor.decide.mockResolvedValue({
            action: 'pause',
            retryAfterMs: 30_000,
            reason: 'pressure',
          });
        await expect(service.read(id)).rejects.toMatchObject({ status: 503 });
        expect(await state.read(id)).toMatchObject({
          state: 'ACTIVE',
          checked_at: before.checked_at,
          valid_until: before.valid_until,
          statistics_consent: false,
          last_button_access_loss_at: null,
        });
      },
    );
    it('does not create a binding for an unknown identifier', async () => {
      await expect(service.read(randomUUID())).rejects.toMatchObject({ status: 404 });
      expect(max.getChatSnapshot).not.toHaveBeenCalled();
    });
  },
);
