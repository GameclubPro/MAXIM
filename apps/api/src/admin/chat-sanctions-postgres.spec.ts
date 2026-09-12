import { randomUUID } from 'node:crypto';
import {
  createPrismaClient,
  Prisma,
  type PrismaClient,
  SanctionAction,
  EventType,
} from '../prisma/prisma-client';
import { ChatSanctionsService } from './chat-sanctions.service';
import { ModerationSanctionStateFenceService } from '../moderation/moderation-sanction-state-fence.service';
import { SanctionHistoryRetention } from '../moderation/sanction-history-retention';
import { WebhookOutboxService } from '../webhook/webhook-outbox.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('PostgreSQL sanctions registry and retention', () => {
  let prisma: PrismaClient;
  let service: ChatSanctionsService;
  let fence: ModerationSanctionStateFenceService;
  const chatId = `sanctions-race-${randomUUID()}`;
  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const parsed = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
      !parsed.pathname.includes('race_test')
    )
      throw new Error('Sanctions PostgreSQL tests require a disposable local race_test database');
    prisma = createPrismaClient(databaseUrl, { max: 2 });
    await prisma.$connect();
    await prisma.chat.create({ data: { id: chatId, title: 'Sanctions integration test' } });
    fence = new ModerationSanctionStateFenceService(prisma as never);
    service = new ChatSanctionsService(prisma as never, fence);
    for (const [key, userId, action, ruleCode, days, metadata] of [
      ['active-ban', 'banned', SanctionAction.BAN, 'MANUAL_BAN', 500, {}],
      ['active-mute', 'muted', SanctionAction.MUTE, 'MANUAL_MUTE', 600, { mutePermanent: true }],
      ['old-ban', 'released', SanctionAction.BAN, 'MANUAL_BAN', 700, {}],
      ['release', 'released', SanctionAction.NONE, 'MANUAL_UNBAN', 500, {}],
      [
        'recent-archive',
        'archived',
        SanctionAction.MUTE,
        'MANUAL_MUTE',
        50,
        { muteDurationHours: 1, muteExpiresAt: ago(49).toISOString() },
      ],
      ['ordinary', 'ordinary', SanctionAction.WARN, 'PROFANITY', 400, {}],
    ] as const) {
      const id = randomUUID();
      ids[key] = id;
      await prisma.moderationEvent.create({
        data: {
          id,
          chatId,
          userId,
          action,
          ruleCode,
          eventType: EventType.SYSTEM,
          createdAt: ago(days),
          metadata,
        },
      });
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.chatModerationFeedItem.deleteMany({ where: { chatId } });
    await prisma.chat.deleteMany({ where: { id: chatId } });
    await prisma.$disconnect();
  });

  it('reads old active bans and permanent mutes from maintained feed rows', async () => {
    const page = await service.getPage(chatId, 'admin', {});
    expect(page.items.map((item) => item.userId).sort()).toEqual(['banned', 'muted']);
    expect(page.items.every((item) => item.releaseAction !== null)).toBe(true);
    const archive = await service.getPage(chatId, 'admin', { status: 'archive' });
    expect(archive.items.map((item) => item.userId)).toEqual(['archived']);
    const filtered = await service.getPage(chatId, 'admin', { action: 'BAN', userId: 'banned' });
    expect(filtered.items[0]?.id).toBe(ids['active-ban']);
  });

  it('does not remove active state or latest release tombstones with ordinary retention', async () => {
    const outbox = Object.create(WebhookOutboxService.prototype) as {
      prisma: PrismaClient;
      deleteModerationEventBatch: (cutoff: Date) => Promise<number>;
    };
    outbox.prisma = prisma;
    await outbox.deleteModerationEventBatch(ago(90));
    expect(await prisma.moderationEvent.findUnique({ where: { id: ids.ordinary! } })).toBeNull();
    expect(
      await prisma.moderationEvent.findUnique({ where: { id: ids['active-ban']! } }),
    ).not.toBeNull();
    expect(
      await prisma.moderationEvent.findUnique({ where: { id: ids['active-mute']! } }),
    ).not.toBeNull();
    expect(await prisma.moderationEvent.findUnique({ where: { id: ids.release! } })).not.toBeNull();
  });

  it('prunes completed history after a year but preserves a state checkpoint', async () => {
    await new SanctionHistoryRetention().cleanup(prisma as never, now);
    expect(await prisma.moderationEvent.findUnique({ where: { id: ids['old-ban']! } })).toBeNull();
    expect(
      await prisma.chatModerationFeedItem.findUnique({ where: { id: ids['old-ban']! } }),
    ).toBeNull();
    expect(await prisma.moderationEvent.findUnique({ where: { id: ids.release! } })).not.toBeNull();
    expect(
      (await service.getPage(chatId, 'admin', {})).items.map((item) => item.userId).sort(),
    ).toEqual(['banned', 'muted']);
  });

  it('shows an interrupted transition for review and restores an explicitly aborted transition', async () => {
    const transition = await fence.prepare({
      chatId,
      userId: 'banned',
      intendedAction: 'UNBAN',
      operator: 'ADMIN',
    });
    expect((await service.getPage(chatId, 'admin', { status: 'review' })).items[0]).toMatchObject({
      id: ids['active-ban'],
      releaseAction: null,
    });
    await fence.abort(transition);
    expect((await service.getPage(chatId, 'admin', { userId: 'banned' })).items[0]?.status).toBe(
      'active',
    );
  });

  it('keeps the candidate plan indexed with a much larger ordinary event history', async () => {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO chat_moderation_feed_items (id, chat_id, user_id, event_type, rule_code, action, created_at, updated_at)
      SELECT ${chatId} || '-noise-' || n, ${chatId}, 'noise', 'SYSTEM'::"EventType", 'PROFANITY', 'WARN'::"SanctionAction", NOW(), NOW()
      FROM generate_series(1, 20000) n
    `);
    await prisma.$executeRawUnsafe('ANALYZE chat_moderation_feed_items');
    let statement: Prisma.Sql | undefined;
    const reader = {
      $queryRaw: (query: Prisma.Sql) => {
        statement = query;
        return prisma.$queryRaw(query);
      },
    };
    await new ChatSanctionsService(reader as never, fence).getPage(chatId, 'admin', {});
    expect(statement).toBeDefined();
    const plan = await prisma.$queryRaw(Prisma.sql`EXPLAIN (FORMAT JSON) ${statement!}`);
    expect(JSON.stringify(plan)).toContain('chat_moderation_feed_sanctions_idx');
    expect(JSON.stringify(plan)).toContain('chat_moderation_feed_sanction_user_state_idx');
  });
});
