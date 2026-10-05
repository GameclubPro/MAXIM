import { randomUUID } from 'node:crypto';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import { ModerationService } from './moderation.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
type Counters = {
  countRecentPhoneNumberViolations(chatId: string, userId: string, hours: number): Promise<number>;
  getActiveMute(chatId: string, userId: string, hours: number): Promise<{ eventId: string } | null>;
  claimMessageViolationProcessing(params: {
    chatId: string;
    userId: string;
    messageId: string;
    ruleCode: string;
    updateType: string;
  }): Promise<boolean>;
};

(databaseUrl ? describe : describe.skip)(
  'SQL sliding escalation with mirrored bot receipts',
  () => {
    let prisma: PrismaClient;
    const chats: string[] = [];
    const hour = 3_600_000;
    let now: number;
    let clock: jest.SpyInstance;

    beforeAll(async () => {
      const url = new URL(databaseUrl);
      if (
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        !url.pathname.includes('race_test')
      )
        throw new Error('Escalation SQL checks require disposable local PostgreSQL');
      prisma = createPrismaClient(databaseUrl);
      await prisma.$connect();
    });
    beforeEach(() => {
      now = Date.now();
      clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    });
    afterEach(() => clock.mockRestore());
    afterAll(async () => {
      if (!prisma) return;
      await prisma.chat.deleteMany({ where: { id: { in: chats } } });
      await prisma.$disconnect();
    }, 60_000);

    async function fixture() {
      const chatId = `-${BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`)}`;
      chats.push(chatId);
      await prisma.chat.create({ data: { id: chatId, title: 'Isolated sliding-window fixture' } });
      const redis = {
        getString: jest.fn(async () => '999'),
        incrementWithTtl: jest.fn(async () => 1000),
        incrementOncePerMemberWithTtl: jest.fn(async () => ({ count: 1000 })),
        setStringWithTtl: jest.fn(),
      };
      const service = Object.create(ModerationService.prototype) as Counters;
      Object.assign(service, {
        prisma,
        redisCounter: redis,
        logger: { debug: jest.fn(), warn: jest.fn() },
      });
      const insert = async (at: number, userId = 'user', ruleCode = 'PHONE_NUMBER_BLOCKED') =>
        prisma.violation.create({ data: { chatId, userId, ruleCode, createdAt: new Date(at) } });
      return { chatId, service, redis, insert };
    }

    it('expires each old row instead of extending its lifetime when Redis is warm', async () => {
      const s = await fixture();
      await Promise.all([s.insert(now - 11 * hour), s.insert(now - 10 * hour), s.insert(now)]);
      expect(await s.service.countRecentPhoneNumberViolations(s.chatId, 'user', 12)).toBe(3);
      now += 3 * hour;
      await s.insert(now);
      expect(await s.service.countRecentPhoneNumberViolations(s.chatId, 'user', 12)).toBe(2);
      expect(s.redis.getString).not.toHaveBeenCalled();
      expect(s.redis.incrementWithTtl).not.toHaveBeenCalled();
    });

    it('includes the exact lower boundary and excludes old, future, other-user and other-rule rows', async () => {
      const s = await fixture();
      await Promise.all([
        s.insert(now - 12 * hour),
        s.insert(now),
        s.insert(now - 12 * hour - 1),
        s.insert(now + 1),
        s.insert(now, 'other'),
        s.insert(now, 'user', 'PROFANITY'),
      ]);
      expect(await s.service.countRecentPhoneNumberViolations(s.chatId, 'user', 12)).toBe(2);
    });

    it('uses the latest completed manual release and ignores future releases', async () => {
      const s = await fixture();
      await Promise.all([s.insert(now - hour), s.insert(now - 10_000), s.insert(now)]);
      await prisma.moderationEvent.createMany({
        data: [
          {
            chatId: s.chatId,
            userId: 'user',
            ruleCode: 'MANUAL_UNMUTE',
            eventType: 'MEMBER_ACTION',
            action: 'NONE',
            operator: 'ADMIN',
            createdAt: new Date(now - 10_000),
          },
          {
            chatId: s.chatId,
            userId: 'user',
            ruleCode: 'MANUAL_UNBAN',
            eventType: 'MEMBER_ACTION',
            action: 'NONE',
            operator: 'ADMIN',
            createdAt: new Date(now + hour),
          },
        ],
      });
      expect(await s.service.countRecentPhoneNumberViolations(s.chatId, 'user', 12)).toBe(2);
    });

    it.each([1, 4, 9, 17])('persists one violation for %s bot receipts', async (bots) => {
      const s = await fixture();
      const input = {
        chatId: s.chatId,
        userId: 'user',
        messageId: 'one-real-message',
        ruleCode: 'PHONE_NUMBER_BLOCKED',
        updateType: 'message_created',
      };
      const claimed = await Promise.all(
        Array.from({ length: bots }, () => s.service.claimMessageViolationProcessing(input)),
      );
      expect(claimed.filter(Boolean)).toHaveLength(1);
      await s.insert(now);
      expect(
        await prisma.moderationViolationMessageClaim.count({ where: { chatId: s.chatId } }),
      ).toBe(1);
      expect(await s.service.countRecentPhoneNumberViolations(s.chatId, 'user', 12)).toBe(1);
    });

    it('ignores future manual releases and future sanctions when restoring an active mute', async () => {
      const s = await fixture();
      const current = await prisma.moderationEvent.create({
        data: {
          chatId: s.chatId,
          userId: 'user',
          ruleCode: 'PHONE_NUMBER_BLOCKED',
          eventType: 'MEMBER_ACTION',
          action: 'MUTE',
          operator: 'BOT',
          metadata: { muteDurationHours: 6 },
          createdAt: new Date(now - hour),
        },
      });
      await prisma.moderationEvent.createMany({
        data: [
          {
            chatId: s.chatId,
            userId: 'user',
            ruleCode: 'MANUAL_UNMUTE',
            eventType: 'MEMBER_ACTION',
            action: 'NONE',
            operator: 'ADMIN',
            createdAt: new Date(now + hour),
          },
          {
            chatId: s.chatId,
            userId: 'user',
            ruleCode: 'FUTURE_SANCTION',
            eventType: 'MEMBER_ACTION',
            action: 'MUTE',
            operator: 'BOT',
            metadata: { mutePermanent: true },
            createdAt: new Date(now + hour),
          },
        ],
      });
      await expect(s.service.getActiveMute(s.chatId, 'user', 6)).resolves.toMatchObject({
        eventId: current.id,
      });
      await prisma.moderationEvent.create({
        data: {
          chatId: s.chatId,
          userId: 'user',
          ruleCode: 'MANUAL_UNBAN',
          eventType: 'MEMBER_ACTION',
          action: 'NONE',
          operator: 'ADMIN',
          createdAt: new Date(now),
        },
      });
      await expect(s.service.getActiveMute(s.chatId, 'user', 6)).resolves.toBeNull();
    });

    it('keeps the count probe bounded with retained history and unrelated skew', async () => {
      const s = await fixture();
      await prisma.violation.createMany({
        data: Array.from({ length: 6000 }, (_, index) => ({
          chatId: s.chatId,
          userId: index % 2 ? 'other' : 'user',
          ruleCode: 'PHONE_NUMBER_BLOCKED',
          createdAt: new Date(now - (24 + index) * hour),
        })),
      });
      // Model an active 12,000-chat fleet: an almost empty global time range would
      // favor the general time index instead of exercising the per-chat count path.
      const recentChatIds = Array.from({ length: 12_000 }, (_, index) =>
        (BigInt(s.chatId) - BigInt(index + 1)).toString(),
      );
      chats.push(...recentChatIds);
      const ruleCodes = [
        'PHONE_NUMBER_BLOCKED',
        'PROFANITY',
        'DUPLICATE_DELETE',
        'MESSAGE_TOO_LONG',
      ];
      for (let offset = 0; offset < recentChatIds.length; offset += 1000) {
        const batch = recentChatIds.slice(offset, offset + 1000);
        await prisma.chat.createMany({
          data: batch.map((id) => ({ id, title: 'Isolated current fleet traffic' })),
        });
        await prisma.violation.createMany({
          data: batch.flatMap((chatId, index) =>
            ruleCodes.map((ruleCode, ruleIndex) => ({
              chatId,
              userId: ruleIndex === 0 ? 'user' : `fleet-user-${(offset + index + ruleIndex) % 64}`,
              ruleCode,
              createdAt: new Date(now - (((offset + index) * 4 + ruleIndex) % 720) * 60_000),
            })),
          ),
        });
      }
      await prisma.violation.createMany({
        data: Array.from({ length: 32 }, (_, index) => ({
          chatId: s.chatId,
          userId: index % 2 ? 'other' : 'user',
          ruleCode: index % 2 ? 'PHONE_NUMBER_BLOCKED' : 'PROFANITY',
          createdAt: new Date(now - hour),
        })),
      });
      await Promise.all([s.insert(now - hour), s.insert(now)]);
      await prisma.$executeRaw`ANALYZE violations`;
      const rows = await prisma.$queryRaw<
        Array<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>
      >(Prisma.sql`
      EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT COUNT(*) FROM "violations"
      WHERE "chat_id" = ${s.chatId} AND "user_id" = 'user'
        AND "rule_code" = 'PHONE_NUMBER_BLOCKED'
        AND "created_at" >= ${new Date(now - 12 * hour)} AND "created_at" <= ${new Date(now)}
    `);
      const visit = (plan: Record<string, unknown>): Array<Record<string, unknown>> => [
        plan,
        ...((plan.Plans as Array<Record<string, unknown>> | undefined) ?? []).flatMap(visit),
      ];
      const scans = visit(rows[0]!['QUERY PLAN'][0]!.Plan).filter(
        (plan) => plan['Relation Name'] === 'violations',
      );
      try {
        expect(scans.length).toBeGreaterThan(0);
        expect(
          scans.every(
            (plan) =>
              Number(plan['Actual Rows']) <= 2 && Number(plan['Rows Removed by Filter'] ?? 0) <= 2,
          ),
        ).toBe(true);
      } catch (cause) {
        throw new Error(
          `Violation count probe exceeded its work bounds: ${JSON.stringify(scans)}`,
          {
            cause,
          },
        );
      }
      expect(await s.service.countRecentPhoneNumberViolations(s.chatId, 'user', 12)).toBe(2);
    }, 60_000);
  },
);
