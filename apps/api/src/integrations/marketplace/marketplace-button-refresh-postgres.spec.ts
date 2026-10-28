import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type {
  MarketplaceBindingInput,
  MarketplaceEntryResponse,
} from '@maxim/contracts/marketplace-integration';
import { PrismaClient, createPrismaAdapter } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MarketplaceAccessService } from './marketplace-access.service';
import { MarketplaceButtonPolicyService } from './marketplace-button-policy.service';
import { MarketplaceStateService } from './marketplace-state.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);
postgres('bounded Birzhik button proof refresh on PostgreSQL', () => {
  let db: PrismaClient;
  let service: MarketplaceButtonPolicyService;
  let state: MarketplaceStateService;
  let entities: string[];
  let reads: jest.SpyInstance<Promise<MarketplaceEntryResponse>, [MarketplaceBindingInput]>;
  const moderator = 'fixture-refresh-moderator';
  const publisher = 'fixture-refresh-publisher';
  const firstActor = '922001';
  const secondActor = '922002';
  const listingId = '28000000-0000-4000-8000-000000000001';
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
    service = new MarketplaceButtonPolicyService(db as PrismaService, config, state, {
      attest: async (input: MarketplaceBindingInput) => {
        const rows = await db.$queryRaw<
          Array<{ id: string }>
        >`UPDATE marketplace_bindings SET checked_at=now(),valid_until=now()+interval '15 minutes' WHERE entity_id=${input.entityId} AND actor_user_id=${input.actorUserId} AND profile=${input.profile} RETURNING id`;
        return (await state.read(rows[0]!.id))!;
      },
    } as unknown as MarketplaceAccessService);
  });
  beforeEach(() => {
    entities = [];
    reads = jest.spyOn(service, 'readEntry').mockImplementation(async (input) => ({
      entityId: input.entityId,
      kind: input.kind,
      profile: input.profile,
      publicState: 'PUBLIC',
      listing: {
        id: listingId,
        ownershipKey: 'a'.repeat(64),
        title: 'Synthetic profile',
        profileOnly: false,
        publicUrl: `https://max.ru/id613000037577_3_bot?startapp=listing_${input.kind === 'CHANNEL' ? 'channel' : 'chat'}_${listingId}`,
      },
      isOwner: false,
      canCreate: false,
      manageUrl: null,
      connectUrl: `https://max.ru/id613000037577_3_bot?startapp=connect_${input.kind === 'CHANNEL' ? 'channel' : 'chat'}_${input.entityId}`,
      checkedAt: new Date(Date.now()).toISOString(),
      validUntil: new Date(Date.now() + 300_000).toISOString(),
    }));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    const ids = JSON.stringify(entities);
    await db.$executeRaw`DELETE FROM marketplace_button_contexts WHERE policy_id IN(SELECT id FROM marketplace_button_policies WHERE entity_id IN(SELECT jsonb_array_elements_text(${ids}::jsonb)))`;
    await db.$executeRaw`DELETE FROM marketplace_button_policies WHERE entity_id IN(SELECT jsonb_array_elements_text(${ids}::jsonb))`;
    await db.$executeRaw`DELETE FROM marketplace_bindings WHERE entity_id IN(SELECT jsonb_array_elements_text(${ids}::jsonb))`;
    await db.chat.deleteMany({ where: { id: { in: entities } } });
  });
  afterAll(async () => db?.$disconnect());

  async function seed(channels: number, chats: number) {
    const epoch = Date.now();
    const rows: Array<{ id: string; entity_id: string; kind: string; profile: string }> = [];
    const bindings: Array<{
      id: string;
      entity_id: string;
      kind: string;
      profile: string;
      actor: string;
      bot: string;
    }> = [];
    const contexts: Array<{
      policy_id: string;
      profile: string;
      context: string;
      actor: string;
      binding: string;
    }> = [];
    for (let index = 0; index < channels + chats; index++) {
      const entity = `-${epoch}${String(index).padStart(4, '0')}`;
      const kind = index < channels ? 'CHANNEL' : 'CHAT';
      entities.push(entity);
      for (const profile of ['moderation', 'publisher'] as const) {
        const policy = randomUUID();
        rows.push({ id: policy, entity_id: entity, kind, profile });
        const places =
          profile === 'publisher'
            ? ['PUBLICATIONS']
            : kind === 'CHANNEL'
              ? ['CHANNEL_POSTS']
              : ['GREETINGS', 'MODERATION_NOTICES'];
        for (const context of places) {
          const binding = randomUUID();
          const actor = context === 'MODERATION_NOTICES' ? secondActor : firstActor;
          bindings.push({
            id: binding,
            entity_id: entity,
            kind,
            profile,
            actor,
            bot: profile === 'publisher' ? publisher : moderator,
          });
          contexts.push({ policy_id: policy, profile, context, actor, binding });
        }
      }
    }
    await db.chat.createMany({
      data: entities.map((id, index) => ({
        id,
        title: 'Synthetic proof refresh capacity',
        entityType: index < channels ? ('CHANNEL' as const) : ('CHAT' as const),
      })),
    });
    await db.chatBotMembership.createMany({
      data: entities.map((chatId) => ({
        chatId,
        botId: moderator,
        status: 'ACTIVE',
        botAccessState: 'UNKNOWN',
      })),
    });
    await db.publisherEntityBinding.createMany({
      data: entities.map((chatId) => ({
        chatId,
        publisherBotId: publisher,
        status: 'ACTIVE',
        botAccessState: 'UNKNOWN',
      })),
    });
    await db.$executeRaw`INSERT INTO marketplace_bindings(id,actor_user_id,entity_id,kind,profile,bot_id,state,checked_at,valid_until,metadata,statistics_consent)
      SELECT x.id::uuid,x.actor,x.entity_id,x.kind,x.profile,x.bot,'ACTIVE',now(),now()+interval '15 minutes','{}'::jsonb,false FROM jsonb_to_recordset(${JSON.stringify(bindings)}::jsonb) AS x(id text,actor text,entity_id text,kind text,profile text,bot text)`;
    await db.$executeRaw`INSERT INTO marketplace_button_policies(id,entity_id,kind,profile)
      SELECT x.id::uuid,x.entity_id,x.kind,x.profile FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(id text,entity_id text,kind text,profile text)`;
    await db.$executeRaw`INSERT INTO marketplace_button_contexts(policy_id,profile,context,enabled,confirmed_by,confirmed_at,listing_id,ownership_key,binding_id,refresh_at)
      SELECT x.policy_id::uuid,x.profile,x.context,true,x.actor,now()-interval '1 hour',${listingId}::uuid,${'a'.repeat(64)},x.binding::uuid,now()-interval '1 day' FROM jsonb_to_recordset(${JSON.stringify(contexts)}::jsonb) AS x(policy_id text,profile text,context text,actor text,binding text)`;
  }
  async function progress() {
    return db.$queryRaw<
      Array<{ profile: string; ready: number; total: number; leases: number; bounded: boolean }>
    >`SELECT c.profile,count(*) FILTER(WHERE verified_until>now())::int ready,count(*)::int total,count(*) FILTER(WHERE c.lease_id IS NOT NULL)::int leases,bool_and(verified_until IS NULL OR verified_until<=b.checked_at+interval '5 minutes') bounded
      FROM marketplace_button_contexts c JOIN marketplace_button_policies p ON p.id=c.policy_id JOIN marketplace_bindings b ON b.id=c.binding_id WHERE p.entity_id IN(SELECT jsonb_array_elements_text(${JSON.stringify(entities)}::jsonb)) GROUP BY c.profile ORDER BY c.profile`;
  }
  it('refreshes 159 platforms and 416 independent contexts within the five-minute window without statistics consent', async () => {
    await seed(61, 98);
    const initial = Date.now();
    const counts: number[] = [];
    for (let tick = 0; tick < 4; tick++) {
      reads.mockClear();
      await service.refresh('moderation', () => false);
      counts.push(reads.mock.calls.length);
    }
    expect(counts).toEqual([80, 80, 80, 17]);
    const publisherCounts: number[] = [];
    for (let tick = 0; tick < 2; tick++) {
      reads.mockClear();
      await service.refresh('publisher', () => false);
      publisherCounts.push(reads.mock.calls.length);
    }
    expect(publisherCounts).toEqual([80, 79]);
    expect(Date.now() - initial).toBeLessThan(120_000);
    expect(await progress()).toEqual([
      { profile: 'moderation', ready: 257, total: 257, leases: 0, bounded: true },
      { profile: 'publisher', ready: 159, total: 159, leases: 0, bounded: true },
    ]);
    const statistics = await db.$queryRaw<
      Array<{ changed: number }>
    >`SELECT count(*)::int changed FROM marketplace_bindings WHERE entity_id IN(SELECT jsonb_array_elements_text(${JSON.stringify(entities)}::jsonb)) AND statistics_consent=true`;
    expect(statistics).toEqual([{ changed: 0 }]);
  });
  it('stops claiming at the wall-clock budget and preserves unstarted queue positions', async () => {
    await seed(0, 3);
    const before = await db.$queryRaw<
      Array<{ policy_id: string; context: string; refresh_at: Date }>
    >`SELECT c.policy_id,c.context,c.refresh_at FROM marketplace_button_contexts c JOIN marketplace_button_policies p ON p.id=c.policy_id WHERE p.entity_id IN(SELECT jsonb_array_elements_text(${JSON.stringify(entities)}::jsonb)) AND p.profile='moderation' ORDER BY c.policy_id,c.context`;
    let clock = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const original = reads.getMockImplementation()!;
    reads.mockImplementation(async (input) => {
      const result = await original(input);
      clock += 20_001;
      return result;
    });
    await service.refresh('moderation', () => false);
    expect(reads).toHaveBeenCalledTimes(1);
    const after = await db.$queryRaw<
      Array<{ policy_id: string; context: string; refresh_at: Date }>
    >`SELECT c.policy_id,c.context,c.refresh_at FROM marketplace_button_contexts c JOIN marketplace_button_policies p ON p.id=c.policy_id WHERE p.entity_id IN(SELECT jsonb_array_elements_text(${JSON.stringify(entities)}::jsonb)) AND p.profile='moderation' ORDER BY c.policy_id,c.context`;
    expect(
      after.filter(
        (row, index) => row.refresh_at.getTime() === before[index]!.refresh_at.getTime(),
      ),
    ).toHaveLength(5);
    expect((await progress()).every((row) => row.leases === 0)).toBe(true);
  });
  it('allows concurrent refreshers to progress without retaining sibling row locks', async () => {
    await seed(0, 12);
    await db.$executeRaw`UPDATE marketplace_button_contexts c SET confirmed_by=${firstActor},binding_id=b.id FROM marketplace_button_policies p JOIN marketplace_bindings b ON b.entity_id=p.entity_id AND b.profile=p.profile AND b.actor_user_id=${firstActor} WHERE c.policy_id=p.id AND p.entity_id IN(SELECT jsonb_array_elements_text(${JSON.stringify(entities)}::jsonb))`;
    await Promise.all([
      service.refresh('moderation', () => false),
      service.refresh('moderation', () => false),
    ]);
    expect((await progress()).find((row) => row.profile === 'moderation')).toEqual({
      profile: 'moderation',
      ready: 24,
      total: 24,
      leases: 0,
      bounded: true,
    });
  });
});
