import { randomInt, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { createPrismaClient, Prisma, type PrismaClient } from '../../prisma/prisma-client';
import { resolveDuplicateFlowConfig } from '../duplicate-flow-policy';
import {
  buildMessageDuplicateIdentity,
  digestDuplicateContent,
  extractDuplicateMessageContent,
} from './message-duplicate-content';
import { MessageDuplicateDeleteGuardService } from './message-duplicate-delete-guard.service';
import {
  MESSAGE_DUPLICATE_MEDIA_VERSION,
  MESSAGE_DUPLICATE_SOURCE,
  messageDuplicateSanctionSettingsDigest,
  messageDuplicateSettingsDigest,
  parseMessageDuplicateBinding,
  type MessageDuplicateBinding,
} from './message-duplicate-state';
import { duplicateUpdate } from './message-duplicate-test-fixtures';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';

(databaseUrl ? describe : describe.skip)(
  'duplicate sanction DELETE receipt PostgreSQL proof',
  () => {
    let prisma: PrismaClient;
    const chats = new Set<string>();

    beforeAll(async () => {
      const url = new URL(databaseUrl);
      if (
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        !url.pathname.includes('race_test')
      )
        throw new Error('Duplicate receipt checks require a disposable local race_test database');
      prisma = createPrismaClient(databaseUrl, { max: 2 });
      await prisma.$connect();
      expect(new Date('2026-01-01T00:00:00').getTimezoneOffset()).toBe(0);
      const [clock] = await prisma.$queryRaw<Array<{ timezone: string }>>`
      SELECT current_setting('TimeZone') AS timezone`;
      expect(clock?.timezone).toBe('UTC');
    });

    afterEach(async () => {
      if (!prisma) return;
      const chatIds = [...chats];
      await prisma.maxActionLedgerEntry.deleteMany({ where: { chatId: { in: chatIds } } });
      await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
      chats.clear();
    });

    afterAll(async () => {
      await prisma?.$disconnect();
    });

    async function createChat() {
      const chatId = `-900${randomInt(100_000_000, 1_000_000_000)}`;
      await prisma.chat.create({ data: { id: chatId, title: 'Duplicate receipt fixture' } });
      chats.add(chatId);
      return chatId;
    }

    async function fixture() {
      const chatId = await createChat();
      const settings = await prisma.chatSettings.create({
        data: {
          chatId,
          antiDuplicateEnabled: true,
          duplicateDetectionPreset: 'STANDARD',
          duplicateCompareMode: 'MESSAGE',
          duplicatePhotoEnabled: false,
          duplicateBotMessageEnabled: false,
          duplicateWarnEnabled: false,
          duplicateMuteEnabled: false,
          duplicateBanEnabled: true,
          duplicateBanMaxCount: 1,
        },
      });
      const eventTimestampMs = Date.now() - 2_000;
      const update = duplicateUpdate('duplicate', eventTimestampMs);
      const content = extractDuplicateMessageContent(update.raw);
      const flow = resolveDuplicateFlowConfig(settings);
      const binding: MessageDuplicateBinding = {
        version: 3,
        enforcementScope: 'full',
        lifecycleRevision: 'd'.repeat(64),
        policyRevision: settings.duplicatePolicyRevision,
        authorization: { eventTimestampMs, deadlineAtMs: eventTimestampMs + 600_000 },
        senderId: '123',
        messageId: 'duplicate',
        eventTimestampMs,
        controlRevision: 1,
        settingsDigest: messageDuplicateSettingsDigest(settings),
        sourceDigest: content.sourceDigest,
        contentDigest: buildMessageDuplicateIdentity(content, 'MESSAGE')!,
        fingerprint: 'b'.repeat(64),
        compareMode: 'MESSAGE',
        mediaHashes: [],
        mediaVersion: MESSAGE_DUPLICATE_MEDIA_VERSION,
        hasPhotos: false,
        photoControlRevision: null,
        windowSeconds: flow.windowSec,
        requiredCount: flow.allowedCount + 2,
        sanction: {
          action: 'BAN',
          repeatCount: 1,
          threshold: 1,
          settingsDigest: messageDuplicateSanctionSettingsDigest(settings),
        },
      };
      binding.original = {
        member: digestDuplicateContent('original'),
        author: digestDuplicateContent(binding.senderId),
        messageId: 'original',
        senderId: binding.senderId,
        publishedAtMs: eventTimestampMs - 1_000,
        observedAtMs: eventTimestampMs - 1_000,
        expiresAtMs: eventTimestampMs + 600_000,
        sourceDigest: binding.sourceDigest,
        contentDigest: binding.contentDigest,
        mediaHashes: [],
        epoch: 0,
        revision: 'e'.repeat(64),
        originalId: 'f'.repeat(64),
      };
      const metadata = {
        duplicateSource: MESSAGE_DUPLICATE_SOURCE,
        messageDuplicate: binding,
        moderationDeleteVerified: true,
      };
      expect(parseMessageDuplicateBinding(metadata)).toEqual(binding);
      const intentId = randomUUID();
      const reasonId = randomUUID();
      const reasonKey = `MESSAGE_DUPLICATE:v1:${eventTimestampMs}`;
      const receiptBot = 'receipt-peer';
      await prisma.moderationDeleteIntent.create({
        data: {
          id: intentId,
          chatId,
          messageId: binding.messageId,
          subjectUserId: binding.senderId,
          sourceMessageAt: new Date(eventTimestampMs),
          status: 'SUCCEEDED',
          succeededBotId: receiptBot,
          remoteDeleteSucceededBotId: receiptBot,
          remoteDeleteSucceededAt: new Date(eventTimestampMs + 1_000),
          completedAt: new Date(eventTimestampMs + 1_000),
          retryUntilAt: new Date(binding.authorization!.deadlineAtMs),
          reasons: {
            create: {
              id: reasonId,
              reasonKey,
              ruleCode: 'DUPLICATE_DELETE',
              userId: binding.senderId,
              eventType: 'MESSAGE',
              createdAt: new Date(eventTimestampMs),
              metadata: metadata as Prisma.InputJsonValue,
            },
          },
        },
      });
      const originalUpdate = duplicateUpdate('original', binding.original.publishedAtMs);
      const originalRaw = (originalUpdate.raw as { message: Record<string, unknown> }).message;
      originalRaw.recipient = { chat_id: chatId, chat_type: 'chat' };
      const sourceError = { response: { status: 404, data: {} } };
      const currentLookup = jest.fn(async () => {
        throw sourceError;
      });
      const originalLookup = jest.fn(async () => originalRaw);
      const max = {
        getChatMemberAccess: jest.fn().mockResolvedValue({
          userId: binding.senderId,
          isAdmin: false,
          isOwner: false,
        }),
        getExactMessageRow: jest.fn(async (_chat: string, messageId: string) =>
          messageId === binding.messageId ? currentLookup() : originalLookup(),
        ),
        deleteMessage: jest.fn(),
        banUser: jest.fn(),
        sendMessage: jest.fn(),
      };
      const bots = {
        isKnownBotUserId: jest.fn().mockReturnValue(false),
        isRegisteredModerationBotId: jest.fn((botId: string) =>
          ['current-bot', receiptBot].includes(botId),
        ),
      };
      const immunity = { consumeForMessage: jest.fn().mockResolvedValue('not_granted') };
      const policy = {
        resolve: jest.fn().mockResolvedValue({
          mode: 'full',
          revision: 1,
          effectiveAtMs: eventTimestampMs - 1_000,
          expiresAtMs: eventTimestampMs + 600_000,
        }),
      };
      const history = {
        stillMatches: jest.fn().mockResolvedValue(true),
        remove: jest.fn(),
        invalidateLifecycle: jest.fn(),
      };
      const authorization = { isAllowed: jest.fn().mockResolvedValue(true) };
      const legacyHolds = { isAnyMessageSourceHeld: jest.fn().mockResolvedValue(false) };
      const metrics = { record: jest.fn(), recordGuardRejection: jest.fn() };
      const beforeFinalAuthority = jest.fn(async () => undefined);
      const service = new MessageDuplicateDeleteGuardService(
        prisma as never,
        max as never,
        bots as never,
        immunity as never,
        policy as never,
        history as never,
        new ConfigService(),
        authorization as never,
        metrics as never,
        legacyHolds as never,
      );
      const request = {
        chatId,
        messageId: binding.messageId,
        subjectUserId: binding.senderId,
        botId: 'current-bot',
        binding,
        sanctionIntentId: intentId,
        beforeFinalAuthority,
      };
      return {
        service,
        request,
        intentId,
        reasonId,
        metadata,
        binding,
        sourceError,
        currentLookup,
        originalLookup,
        max,
        bots,
        immunity,
        policy,
        history,
        authorization,
        legacyHolds,
        metrics,
        beforeFinalAuthority,
      };
    }

    async function snapshot() {
      const where = { chatId: { in: [...chats] } };
      return {
        intents: await prisma.moderationDeleteIntent.findMany({
          where,
          orderBy: { id: 'asc' },
          include: { reasons: { orderBy: { id: 'asc' } } },
        }),
        settings: await prisma.chatSettings.findMany({ where, orderBy: { chatId: 'asc' } }),
        claims: await prisma.moderationViolationMessageClaim.findMany({ where }),
        events: await prisma.moderationEvent.findMany({ where }),
        actions: await prisma.maxActionLedgerEntry.findMany({ where }),
      };
    }

    function expectNoEffects(s: Awaited<ReturnType<typeof fixture>>) {
      expect(s.max.deleteMessage).not.toHaveBeenCalled();
      expect(s.max.banUser).not.toHaveBeenCalled();
      expect(s.max.sendMessage).not.toHaveBeenCalled();
      expect(s.history.remove).not.toHaveBeenCalled();
      expect(s.history.invalidateLifecycle).not.toHaveBeenCalled();
    }

    it('uses the exact durable peer DELETE receipt after bare 404 and retains every fresh sanction check', async () => {
      const s = await fixture();
      const before = await snapshot();
      await expect(s.service.assertMessageStillActionable(s.request)).resolves.toBe('allowed');
      expect(s.currentLookup).toHaveBeenCalledTimes(1);
      expect(s.originalLookup).toHaveBeenCalledTimes(1);
      expect(s.max.getChatMemberAccess).toHaveBeenCalledWith(
        s.request.chatId,
        s.binding.senderId,
        expect.objectContaining({ botId: s.request.botId, bypassCache: true }),
      );
      expect(s.history.stillMatches).toHaveBeenCalledWith(s.request.chatId, s.binding, true);
      expect(s.immunity.consumeForMessage).toHaveBeenCalledTimes(1);
      expect(s.beforeFinalAuthority).toHaveBeenCalledTimes(1);
      expect(s.policy.resolve).toHaveBeenCalledTimes(2);
      expect(s.authorization.isAllowed).toHaveBeenCalledTimes(2);
      expect(s.legacyHolds.isAnyMessageSourceHeld).toHaveBeenCalled();
      expect(s.metrics.record).not.toHaveBeenCalledWith('guard.current_lookup_confirmed_absent');
      expectNoEffects(s);
      expect(await snapshot()).toEqual(before);
    });

    it.each(['missing success', 'unfinished receipt'] as const)(
      'declines initial sanction on %s without rewriting durable evidence or permitting a late recheck',
      async (kind) => {
        const s = await fixture();
        await prisma.moderationDeleteIntent.update({
          where: { id: s.intentId },
          data:
            kind === 'missing success'
              ? { remoteDeleteSucceededAt: null, remoteDeleteSucceededBotId: null }
              : { status: 'AMBIGUOUS' },
        });
        const before = await snapshot();
        await expect(
          s.service.assertMessageStillActionable({
            ...s.request,
            sanctionPhase: 'initial_unattempted',
          }),
        ).rejects.toMatchObject({
          name: 'MessageDuplicateGuardRejectedError',
          code: 'message_duplicate_sanction_source_unavailable',
        });
        expect(s.originalLookup).not.toHaveBeenCalled();
        expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
        expect(s.beforeFinalAuthority).not.toHaveBeenCalled();
        expect(s.metrics.record).not.toHaveBeenCalledWith('guard.current_lookup_confirmed_absent');
        expectNoEffects(s);
        expect(await snapshot()).toEqual(before);
        await expect(s.service.assertMessageStillActionable(s.request)).rejects.toBe(s.sourceError);
        expect(await snapshot()).toEqual(before);
      },
    );

    it.each([
      'missing intent',
      'wrong chat',
      'wrong message',
      'wrong subject',
      'unfinished status',
      'missing remote success',
      'mismatched receipt bots',
      'unknown receipt bot',
      'different reason key',
      'different rule',
      'different reason user',
      'unverified reason',
      'reason after remote success',
      'changed canonical fingerprint',
    ] as const)(
      'preserves the original bare 404 and all stored evidence for %s',
      async (change) => {
        const s = await fixture();
        const intentData: Prisma.ModerationDeleteIntentUncheckedUpdateInput = {};
        const reasonData: Prisma.ModerationDeleteIntentReasonUpdateInput = {};
        switch (change) {
          case 'missing intent':
            s.request.sanctionIntentId = randomUUID();
            break;
          case 'wrong chat':
            intentData.chatId = await createChat();
            break;
          case 'wrong message':
            intentData.messageId = 'other-message';
            break;
          case 'wrong subject':
            intentData.subjectUserId = 'other-user';
            break;
          case 'unfinished status':
            intentData.status = 'PENDING';
            break;
          case 'missing remote success':
            intentData.remoteDeleteSucceededAt = null;
            intentData.remoteDeleteSucceededBotId = null;
            break;
          case 'mismatched receipt bots':
            intentData.succeededBotId = 'current-bot';
            break;
          case 'unknown receipt bot':
            intentData.succeededBotId = 'unknown-bot';
            intentData.remoteDeleteSucceededBotId = 'unknown-bot';
            break;
          case 'different reason key':
            reasonData.reasonKey = `MESSAGE_DUPLICATE:v1:${s.binding.eventTimestampMs - 1}`;
            break;
          case 'different rule':
            reasonData.ruleCode = 'STOP_WORD_DELETE';
            break;
          case 'different reason user':
            reasonData.userId = 'other-user';
            break;
          case 'unverified reason':
            reasonData.metadata = { ...s.metadata, moderationDeleteVerified: false };
            break;
          case 'reason after remote success':
            reasonData.createdAt = new Date(s.binding.eventTimestampMs + 1_001);
            break;
          case 'changed canonical fingerprint':
            reasonData.metadata = {
              ...s.metadata,
              messageDuplicate: { ...s.binding, fingerprint: 'a'.repeat(64) },
            };
            break;
        }
        if (Object.keys(intentData).length)
          await prisma.moderationDeleteIntent.update({
            where: { id: s.intentId },
            data: intentData,
          });
        if (Object.keys(reasonData).length)
          await prisma.moderationDeleteIntentReason.update({
            where: { id: s.reasonId },
            data: reasonData,
          });
        const before = await snapshot();
        await expect(s.service.assertMessageStillActionable(s.request)).rejects.toBe(s.sourceError);
        expect(s.currentLookup).toHaveBeenCalledTimes(1);
        expect(s.originalLookup).not.toHaveBeenCalled();
        expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
        expect(s.beforeFinalAuthority).not.toHaveBeenCalled();
        expectNoEffects(s);
        expect(await snapshot()).toEqual(before);
      },
    );
  },
);
