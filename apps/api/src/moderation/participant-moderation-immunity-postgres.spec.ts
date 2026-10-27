import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import type { MaxClientService } from '../max/max-client.service';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import type { GlobalSpammerIntelligenceService } from './global-spammer-intelligence.service';
import { ModerationSanctionStateFenceService } from './moderation-sanction-state-fence.service';
import { ModerationStateDeleteGuardService } from './moderation-state-delete-guard.service';
import { ParticipantModerationImmunityService } from './participant-moderation-immunity.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
(databaseUrl ? describe : describe.skip)('logical message immunity PostgreSQL races', () => {
  let prisma: PrismaClient;
  let service: ParticipantModerationImmunityService;
  const chatId = `commercial-immunity-${randomUUID()}`;
  const input = {
    chatId,
    userId: 'test-user',
    messageId: 'race-message',
    scope: 'text',
    nightModeTimezone: 'Europe/Moscow',
  };
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Immunity races require a disposable local race_test database');
    prisma = createPrismaClient(databaseUrl, { max: 8 });
    await prisma.$connect();
    await prisma.chat.create({ data: { id: chatId, title: 'Commercial immunity race test' } });
    service = new ParticipantModerationImmunityService(prisma as never);
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.chat.deleteMany({ where: { id: chatId } });
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await prisma.moderationViolationMessageClaim.deleteMany({ where: { chatId } });
    await prisma.chatParticipantModerationImmunity.deleteMany({ where: { chatId } });
    await prisma.chatParticipantModerationImmunity.create({
      data: {
        chatId,
        userId: input.userId,
        dailyViolationLimit: 1,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
  });
  it('uses one quota unit for parallel rules, OCR, mirrors and subsequent edits', async () => {
    const results = await Promise.all(
      ['text', 'OCR', 'mirror', 'other-rule'].map((scope) =>
        service.consumeForMessage({ ...input, scope }),
      ),
    );
    expect(results).toEqual(['granted', 'granted', 'granted', 'granted']);
    await expect(service.consumeForMessage({ ...input, scope: 'edit' })).resolves.toBe('granted');
    const grant = await prisma.chatParticipantModerationImmunity.findUniqueOrThrow({
      where: { chatId_userId: { chatId, userId: input.userId } },
    });
    expect(grant.dailyViolationUsage).toBe(1);
    expect(await prisma.moderationViolationMessageClaim.count({ where: { chatId } })).toBe(1);
  });
  it('does not overspend the daily limit when distinct messages race', async () => {
    const results = await Promise.all(
      ['first', 'second', 'third'].map((messageId) =>
        service.consumeForMessage({ ...input, messageId }),
      ),
    );
    expect(results.filter((result) => result === 'granted')).toHaveLength(1);
    expect(await prisma.moderationViolationMessageClaim.count({ where: { chatId } })).toBe(1);
  });

  it.each(['released', 'expired'] as const)(
    'preserves quota after a queued %s mute deletion for the next actionable message',
    async (state) => {
      const sourceAtMs = Date.now();
      await prisma.chatSettings.upsert({
        where: { chatId },
        create: { chatId, nightModeTimezone: input.nightModeTimezone },
        update: { nightModeTimezone: input.nightModeTimezone },
      });
      const mute = await prisma.moderationEvent.create({
        data: {
          chatId,
          userId: input.userId,
          eventType: 'MEMBER_ACTION',
          ruleCode: 'TEST_MUTE',
          action: 'MUTE',
          createdAt: new Date(sourceAtMs - 2_000),
          metadata: {
            muteExpiresAt: new Date(
              sourceAtMs + (state === 'expired' ? -1_000 : 3_600_000),
            ).toISOString(),
          },
        },
      });
      try {
        if (state === 'released') {
          await prisma.moderationEvent.create({
            data: {
              chatId,
              userId: input.userId,
              eventType: 'MEMBER_ACTION',
              ruleCode: 'MANUAL_UNMUTE',
              action: 'NONE',
              operator: 'ADMIN',
              createdAt: new Date(sourceAtMs - 1_000),
            },
          });
        }
        let currentSourceAtMs = sourceAtMs;
        const max = {
          getChatMemberAccess: jest.fn(async () => ({
            userId: input.userId,
            isAdmin: false,
            isOwner: false,
            permissions: [],
          })),
          getExactMessageRow: jest.fn(async (_chatId: string, messageId: string) => ({
            sender: { user_id: input.userId, is_bot: false },
            recipient: { chat_id: chatId, chat_type: 'chat' },
            timestamp: currentSourceAtMs,
            body: { mid: messageId, text: 'hello' },
          })),
        } satisfies Pick<MaxClientService, 'getChatMemberAccess' | 'getExactMessageRow'>;
        const bots = {
          isKnownBotUserId: jest.fn(() => false),
        } satisfies Pick<MaxBotLinkService, 'isKnownBotUserId'>;
        const policy = {
          evaluatePolicy: jest.fn(async () => {
            throw new Error('Mute authorization must not evaluate spammer policy');
          }),
        } satisfies Pick<GlobalSpammerIntelligenceService, 'evaluatePolicy'>;
        const guard = new ModerationStateDeleteGuardService(
          prisma as never,
          max as never,
          bots as never,
          service,
          new ModerationSanctionStateFenceService(prisma as never),
          policy as never,
          new ConfigService(),
        );
        const pending = {
          chatId,
          messageId: 'stale-muted-message',
          subjectUserId: input.userId,
          botId: 'test-bot',
          sourceMessageAt: new Date(sourceAtMs),
          reasons: [
            {
              ruleCode: 'MUTE_ACTIVE_DELETE',
              reasonKey: 'mute',
              metadata: { muteEventId: mute.id },
            },
          ],
        };
        await expect(guard.authorize(pending)).rejects.toMatchObject({
          code: 'moderation_state_delete_no_longer_authorized',
        });
        const readGrant = () =>
          prisma.chatParticipantModerationImmunity.findUniqueOrThrow({
            where: { chatId_userId: { chatId, userId: input.userId } },
          });
        expect((await readGrant()).dailyViolationUsage).toBe(0);
        expect(await prisma.moderationViolationMessageClaim.count({ where: { chatId } })).toBe(0);

        const active = await prisma.moderationEvent.create({
          data: {
            chatId,
            userId: input.userId,
            eventType: 'MEMBER_ACTION',
            ruleCode: 'TEST_MUTE',
            action: 'MUTE',
            metadata: { muteExpiresAt: new Date(Date.now() + 3_600_000).toISOString() },
          },
        });
        currentSourceAtMs = Date.now();
        const messageId = 'next-actionable-message';
        await expect(
          guard.authorize({
            ...pending,
            messageId,
            sourceMessageAt: new Date(currentSourceAtMs),
            reasons: [{ ...pending.reasons[0]!, metadata: { muteEventId: active.id } }],
          }),
        ).rejects.toMatchObject({ code: 'moderation_state_delete_no_longer_authorized' });
        expect((await readGrant()).dailyViolationUsage).toBe(1);
        expect(await prisma.moderationViolationMessageClaim.count({ where: { chatId } })).toBe(1);
        expect(
          await prisma.moderationViolationMessageClaim.count({ where: { chatId, messageId } }),
        ).toBe(1);
        await expect(service.consumeForMessage({ ...input, messageId })).resolves.toBe('granted');
        expect((await readGrant()).dailyViolationUsage).toBe(1);
      } finally {
        await prisma.moderationEvent.deleteMany({ where: { chatId } });
      }
    },
  );

  it('does not treat an old receipt as authority after expiry or revocation', async () => {
    await expect(service.consumeForMessage(input)).resolves.toBe('granted');
    await prisma.chatParticipantModerationImmunity.updateMany({
      where: { chatId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(service.consumeForMessage(input)).resolves.toBe('not_granted');
    await prisma.chatParticipantModerationImmunity.deleteMany({ where: { chatId } });
    await expect(service.consumeForMessage(input)).resolves.toBe('not_granted');
  });

  it('skips empty transactions without caching absence across a new grant', async () => {
    await prisma.chatParticipantModerationImmunity.deleteMany({ where: { chatId } });
    const transaction = jest.spyOn(prisma, '$transaction');
    try {
      await expect(service.consumeForMessage(input)).resolves.toBe('not_granted');
      expect(transaction).not.toHaveBeenCalled();
      await prisma.chatParticipantModerationImmunity.create({
        data: {
          chatId,
          userId: input.userId,
          dailyViolationLimit: 1,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      await expect(service.consumeForMessage(input)).resolves.toBe('granted');
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(await prisma.moderationViolationMessageClaim.count({ where: { chatId } })).toBe(1);
    } finally {
      transaction.mockRestore();
    }
  });

  it('still rejects conflicting historical receipts when no grant remains', async () => {
    await expect(service.consumeForMessage(input)).resolves.toBe('granted');
    await prisma.chatParticipantModerationImmunity.deleteMany({ where: { chatId } });
    await prisma.moderationViolationMessageClaim.updateMany({
      where: { chatId },
      data: { userId: 'foreign-user' },
    });
    await expect(service.consumeForMessage(input)).rejects.toThrow(
      'Participant moderation immunity claim ownership mismatch',
    );
  });

  it('uses exact unique-index probes with a large retained grant and receipt history', async () => {
    await prisma.chatParticipantModerationImmunity.deleteMany({ where: { chatId } });
    // FLAG: Seed the same 20,000-row histories inside disposable PostgreSQL. Avoid
    // measuring ORM serialization and forty ingestion round trips as query-plan work.
    await prisma.$executeRaw`
      INSERT INTO chat_participant_moderation_immunities (id, chat_id, user_id, updated_at)
      SELECT ${chatId} || ':grant-' || n, ${chatId}, 'history-' || n, CURRENT_TIMESTAMP
      FROM generate_series(0, 19999) AS n
    `;
    await prisma.$executeRaw`
      INSERT INTO moderation_violation_message_claims
        (id, dedupe_key, chat_id, user_id, message_id, rule_code, update_type)
      SELECT ${chatId} || ':receipt-' || n, ${chatId} || ':history-' || n,
        ${chatId}, 'history-' || n, 'history-' || n, 'TEST', 'message_created'
      FROM generate_series(0, 19999) AS n
    `;
    await prisma.$executeRaw`ANALYZE chat_participant_moderation_immunities`;
    await prisma.$executeRaw`ANALYZE moderation_violation_message_claims`;
    const read = jest.spyOn(prisma, '$queryRaw');
    let admission: Prisma.Sql;
    try {
      await expect(service.consumeForMessage(input)).resolves.toBe('not_granted');
      admission = read.mock.calls[0][0] as Prisma.Sql;
    } finally {
      read.mockRestore();
    }
    const plans = await prisma.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
      Prisma.sql`EXPLAIN (FORMAT JSON) ${admission!}`,
    );
    const plan = JSON.stringify(plans);
    expect(plan).toContain('chat_participant_moderation_immunities_chat_id_user_id_key');
    expect(plan).toContain('moderation_violation_message_claims_dedupe_key_key');
    expect(plan).not.toContain('Seq Scan');
    expect(plan).not.toContain('Sort');
  }, 30_000);
});
