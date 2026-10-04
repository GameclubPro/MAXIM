import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { createPrismaClient } from '../../src/prisma/prisma-client';
import { RedisCounterService } from '../../src/moderation/redis-counter.service';
import { ModerationDeleteIntentService } from '../../src/moderation/moderation-delete-intent.service';
import { buildMessageScopedModerationActionClaimKey } from '../../src/moderation/moderation-message-action-claim';
import { MessageDuplicateAdmissionService } from '../../src/moderation/message-duplicate/message-duplicate-admission.service';
import { MessageDuplicateAuthorizationService } from '../../src/moderation/message-duplicate/message-duplicate-authorization.service';
import { MessageDuplicateDeleteGuardService } from '../../src/moderation/message-duplicate/message-duplicate-delete-guard.service';
import { MessageDuplicateHistoryService } from '../../src/moderation/message-duplicate/message-duplicate-history.service';
import {
  MessageDuplicatePolicyService,
  MESSAGE_DUPLICATE_CONTROL_KEY,
} from '../../src/moderation/message-duplicate/message-duplicate-policy.service';
import {
  MessageDuplicateOrderingStore,
  buildMessageDuplicateJobId,
} from '../../src/moderation/message-duplicate/message-duplicate.queue';
import {
  digestDuplicateContent,
  extractDuplicateMessageContent,
} from '../../src/moderation/message-duplicate/message-duplicate-content';
import {
  MESSAGE_DUPLICATE_CLAIM_PREFIX,
  MESSAGE_DUPLICATE_SOURCE,
  type MessageDuplicateBinding,
} from '../../src/moderation/message-duplicate/message-duplicate-state';

export type CrashInput = { chatId: string; redisUrl: string; eventTimestampMs: number };
export type CrashStage = 'admission' | 'revocation' | 'qualification' | 'intent' | 'completion';

export function createDuplicateCrashFixture(
  input: CrashInput,
  beforeRedisRevoke?: () => Promise<void>,
) {
  const { chatId, redisUrl, eventTimestampMs } = input;
  const prisma = createPrismaClient(process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL, {
    max: 2,
  });
  const config = new ConfigService({ REDIS_URL: redisUrl, MODERATION_DELETE_INTENT_MODE: 'on' });
  const counters = new RedisCounterService(config);
  const ordering = new MessageDuplicateOrderingStore(config);
  if (beforeRedisRevoke) {
    const revoke = ordering.revokeActionEligibility.bind(ordering);
    ordering.revokeActionEligibility = async (identity) => {
      await beforeRedisRevoke();
      return revoke(identity);
    };
  }
  const history = new MessageDuplicateHistoryService(counters);
  const policy = new MessageDuplicatePolicyService(counters, config);
  const admission = new MessageDuplicateAdmissionService(prisma as never);
  const authorization = new MessageDuplicateAuthorizationService(prisma as never, ordering);
  const jobId = buildMessageDuplicateJobId(chatId, 'duplicate', eventTimestampMs);
  const identity = {
    chatId,
    jobId,
    sourceCreatedAt: new Date(eventTimestampMs).toISOString(),
    deadlineAtMs: eventTimestampMs + 600_000,
  };
  const claim = {
    chatId,
    userId: '123',
    messageId: 'duplicate',
    ruleCode: 'DUPLICATE_MESSAGE_ACTION',
    updateType: 'message_action' as const,
    dedupeKey: `${MESSAGE_DUPLICATE_CLAIM_PREFIX}${digestDuplicateContent([chatId, '123', 'duplicate'])}`,
    messageActionKey: buildMessageScopedModerationActionClaimKey(chatId, 'duplicate'),
  };
  let remoteReads = 0;
  // FLAG: Only the remote MAX boundary is replaced. All admission, history, policy,
  // authority, claim, cleanup and intent operations below use the real local stores.
  const max = {
    getChatMemberAccess: async () => {
      remoteReads++;
      return { userId: '123', isAdmin: false, isOwner: false };
    },
    getExactMessageRow: async (_chat: string, messageId: string) => {
      remoteReads++;
      return {
        sender: { user_id: 123 },
        recipient: { chat_id: Number(chatId), chat_type: 'chat' },
        timestamp: eventTimestampMs - (messageId === 'original' ? 1000 : 0),
        body: { mid: messageId, text: 'Process crash duplicate fixture' },
      };
    },
  };
  const bots = { isKnownBotUserId: () => false, getDefaultBotId: () => 'fixture-bot' };
  const immunity = { consumeForMessage: async () => 'not_granted' };
  const guard = new MessageDuplicateDeleteGuardService(
    prisma as never,
    max as never,
    bots as never,
    immunity as never,
    policy,
    history,
    config,
    authorization,
  );
  const queue = new Queue(`duplicate-crash-${chatId.slice(1)}`, { connection: { url: redisUrl } });
  const intents = new ModerationDeleteIntentService(
    prisma as never,
    max as never,
    bots as never,
    queue as never,
    config,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    immunity as never,
    guard,
  );
  const target = (binding: MessageDuplicateBinding) => ({
    chatId,
    messageId: 'duplicate',
    subjectUserId: '123',
    botId: 'fixture-bot',
    binding,
  });
  const handoff = (binding: MessageDuplicateBinding) =>
    intents.ensureIntentWithMessageActionClaim({
      claim,
      intent: {
        chatId,
        messageId: 'duplicate',
        subjectUserId: '123',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: 'fixture-bot',
        sourceMessageAt: identity.sourceCreatedAt,
        ruleCode: 'DUPLICATE_DELETE',
        reasonKey: `MESSAGE_DUPLICATE:v1:${eventTimestampMs}`,
        retryUntilAt: new Date(identity.deadlineAtMs),
        event: {
          userId: '123',
          eventType: 'MESSAGE',
          metadata: {
            duplicateSource: MESSAGE_DUPLICATE_SOURCE,
            enforcementScope: binding.enforcementScope,
            messageDuplicate: binding,
          },
        },
      },
    });
  return {
    prisma,
    ordering,
    admission,
    authorization,
    history,
    guard,
    intents,
    identity,
    claim,
    target,
    handoff,
    remoteReads: () => remoteReads,
    async seed(): Promise<MessageDuplicateBinding> {
      const settings = await prisma.chatSettings.findUniqueOrThrow({ where: { chatId } });
      await counters.setStringWithTtl(
        MESSAGE_DUPLICATE_CONTROL_KEY,
        JSON.stringify({
          version: 2,
          revision: 1,
          mode: 'delete_only',
          scope: 'chats',
          chatIds: [chatId],
          effectiveAt: new Date(eventTimestampMs - 10_000).toISOString(),
          expiresAt: null,
        }),
        600,
      );
      const base = {
        chatId,
        userId: '123',
        settings,
        controlRevision: 1,
        content: extractDuplicateMessageContent({
          message: { body: { text: 'Process crash duplicate fixture' } },
        }),
      };
      await history.observe({
        ...base,
        messageId: 'original',
        eventTimestampMs: eventTimestampMs - 1000,
      });
      const match = await history.observe({ ...base, messageId: 'duplicate', eventTimestampMs });
      if (!match) throw new Error('Fixture must produce a real duplicate match');
      const registered = await admission.register({ chatId, messageId: 'duplicate', jobId });
      const announced = await ordering.announce(identity, true, registered.registration);
      if (announced.kind !== 'registered' || !announced.actionEligible)
        throw new Error('Fixture admission failed');
      return {
        ...match.binding,
        authorization: { jobId, eventTimestampMs, deadlineAtMs: identity.deadlineAtMs },
      };
    },
    async close() {
      await queue.close();
      await ordering.onModuleDestroy();
      await counters.onModuleDestroy();
      await prisma.$disconnect();
    },
  };
}
