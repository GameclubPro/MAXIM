import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';
import { MessageLimitsDeleteGuardService } from './message-limits-delete-guard.service';
import { MessageDuplicateDeleteGuardService } from './message-duplicate/message-duplicate-delete-guard.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
type Proof = { messageDuplicateVerified: boolean; independentVerified: boolean };
type Authorization = {
  authorizeGuardedUserDeleteReasons(intent: unknown, botId: string): Promise<Proof>;
};

(databaseUrl ? describe : describe.skip)('mixed duplicate and independent current reasons', () => {
  let prisma: PrismaClient;
  const chats: string[] = [];
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Mixed reason checks require disposable local PostgreSQL');
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.chat.deleteMany({ where: { id: { in: chats } } });
    await prisma.$disconnect();
  });

  async function fixture() {
    const chatId = `-${BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`)}`;
    chats.push(chatId);
    await prisma.chat.create({ data: { id: chatId, title: 'Independent current reasons' } });
    await prisma.chatSettings.create({
      data: { chatId, maxMessageLengthEnabled: true, maxMessageLength: 10 },
    });
    const intent = await prisma.moderationDeleteIntent.create({
      data: {
        id: randomUUID(),
        chatId,
        messageId: 'one-message',
        subjectUserId: 'user',
        entityType: 'CHAT',
        originBotId: 'old-executor',
        messageAuthorKind: 'user',
        retryUntilAt: new Date(Date.now() + 60_000),
        reasons: {
          create: [
            {
              id: randomUUID(),
              reasonKey: 'MESSAGE_DUPLICATE:v1:1',
              ruleCode: 'DUPLICATE_DELETE',
              metadata: { duplicateSource: 'message_v1', messageDuplicate: { version: 1 } },
            },
            { id: randomUUID(), reasonKey: 'length', ruleCode: 'MESSAGE_TOO_LONG_DELETE' },
          ],
        },
      },
    });
    const message = {
      sender: { user_id: 'user' },
      recipient: { chat_id: chatId, chat_type: 'chat' },
      timestamp: Date.now(),
      body: { mid: 'one-message', text: '12345678901' },
    };
    const max = {
      getChatMemberAccess: jest.fn(async () => ({
        userId: 'user',
        isAdmin: false,
        isOwner: false,
      })),
      getExactMessageRow: jest.fn(async () => message),
    };
    const bots = { isKnownBotUserId: () => false };
    const immunity = { consumeForMessage: async () => 'not_granted' };
    const config = new ConfigService();
    const lengthGuard = new MessageLimitsDeleteGuardService(
      prisma as never,
      max as never,
      bots as never,
      immunity as never,
      config,
    );
    // FLAG: Actual SQL reasons, current-length guard and duplicate binding guard run together.
    // Invalid old binding must neither veto current length nor supply duplicate sanction authority.
    const duplicateGuard = new MessageDuplicateDeleteGuardService(
      prisma as never,
      max as never,
      bots as never,
      immunity as never,
      {} as never,
      {} as never,
      config,
      {} as never,
    );
    const service = Object.create(ModerationDeleteIntentService.prototype) as Authorization;
    Object.assign(service, {
      prisma,
      messageLimitsDeleteGuard: lengthGuard,
      messageDuplicateDeleteGuard: duplicateGuard,
    });
    return { service, intent, message, max, chatId };
  }

  it.each([false, true])(
    'terminalizes retired photo evidence while rechecking a concurrently added independent reason (%s)',
    async (addIndependent) => {
      const s = await fixture();
      await prisma.moderationDeleteIntentReason.deleteMany({ where: { intentId: s.intent.id } });
      await prisma.moderationDeleteIntentReason.create({
        data: {
          id: randomUUID(),
          intentId: s.intent.id,
          reasonKey: 'old-photo',
          ruleCode: 'DUPLICATE_DELETE',
          metadata: {
            duplicateSource: 'photo',
            matchKind: 'canonical_sha256',
            preset: 'SAME_IMAGE',
            scope: 'SAME_AUTHOR',
          },
        },
      });
      const leaseToken = randomUUID();
      await prisma.moderationDeleteIntent.update({
        where: { id: s.intent.id },
        data: {
          status: 'IN_PROGRESS',
          leaseToken,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const service = s.service as unknown as {
        loadRequiredIntent(id: string): Promise<unknown>;
        finishTerminalPreDispatchGuardRejection(
          intent: unknown,
          token: string,
          details: unknown,
        ): Promise<unknown>;
      };
      const enqueueWakeup = jest.fn().mockResolvedValue(undefined);
      Object.assign(service, { enqueueWakeup, mode: 'on', canaryChatIds: new Set() });
      const original = await service.loadRequiredIntent(s.intent.id);
      if (addIndependent)
        await prisma.moderationDeleteIntentReason.create({
          data: {
            id: randomUUID(),
            intentId: s.intent.id,
            reasonKey: 'new-length',
            ruleCode: 'MESSAGE_TOO_LONG_DELETE',
          },
        });
      await service.finishTerminalPreDispatchGuardRejection(original, leaseToken, {
        statusCode: null,
        errorCode: 'photo_duplicate_legacy_evidence_retired',
        message: 'Retired photo evidence cannot authorize a new deletion',
      });
      const actual = await prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { id: s.intent.id },
      });
      expect(actual.status).toBe(addIndependent ? 'RETRYABLE' : 'FAILED_TERMINAL');
      expect(actual.leaseToken).toBeNull();
      expect(actual.leaseExpiresAt).toBeNull();
      expect(actual.remoteDeleteSucceededAt).toBeNull();
      expect(enqueueWakeup).toHaveBeenCalledTimes(addIndependent ? 1 : 0);
      expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    },
  );

  it.each([1, 4, 9, 13])(
    'authorizes length without borrowing duplicate authority for %s receipts',
    async (bots) => {
      const s = await fixture();
      for (let bot = 0; bot < bots; bot++) {
        expect(
          await s.service.authorizeGuardedUserDeleteReasons(s.intent, 'healthy-executor'),
        ).toMatchObject({
          messageDuplicateVerified: false,
          independentVerified: true,
        });
      }
      expect(await prisma.moderationDeleteIntent.count({ where: { chatId: s.chatId } })).toBe(1);
      expect(
        await prisma.moderationDeleteIntentReason.count({ where: { intentId: s.intent.id } }),
      ).toBe(2);
      expect(s.max.getExactMessageRow).toHaveBeenCalledWith(
        s.chatId,
        'one-message',
        expect.objectContaining({ botId: 'healthy-executor', bypassCache: true }),
      );
    },
  );

  it.each(['edited', 'disabled'] as const)(
    'rejects both obsolete reasons when length is %s',
    async (change) => {
      const s = await fixture();
      if (change === 'edited') s.message.body.text = 'short';
      else
        await prisma.chatSettings.update({
          where: { chatId: s.chatId },
          data: { maxMessageLengthEnabled: false },
        });
      await expect(
        s.service.authorizeGuardedUserDeleteReasons(s.intent, 'healthy-executor'),
      ).rejects.toMatchObject({ code: 'moderation_delete_reasons_no_longer_authorized' });
    },
  );

  it('stops on unknown access even when another old reason is independently stored', async () => {
    const s = await fixture();
    const error = Object.assign(new Error('MAX unavailable'), { response: { status: 503 } });
    s.max.getChatMemberAccess.mockRejectedValue(error);
    await expect(
      s.service.authorizeGuardedUserDeleteReasons(s.intent, 'healthy-executor'),
    ).rejects.toBe(error);
  });
});
