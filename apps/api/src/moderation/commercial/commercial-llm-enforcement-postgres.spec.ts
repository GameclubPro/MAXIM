import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  createMultibotHarness,
  type MultibotHarness,
} from '../../webhook/webhook-multibot-fullpath.spec-support';
import { ParticipantModerationImmunityService } from '../participant-moderation-immunity.service';
import { CommercialLlmEnforcementProcessor } from './commercial-llm-enforcement.processor';
import {
  CommercialLlmEnforcementMailbox,
  COMMERCIAL_LLM_ENFORCEMENT_KEYS,
  commercialLlmProofKey,
} from './commercial-llm-enforcement.mailbox';
import {
  COMMERCIAL_LLM_LEASE_KEY,
  COMMERCIAL_LLM_COOLDOWN_KEY,
} from './commercial-llm-shadow.lease';
import { CommercialLlmDeleteGuardService } from './commercial-llm-delete-guard.service';
import {
  buildCommercialLlmOffer,
  type CommercialLlmSource,
} from './commercial-llm-enforcement.protocol';
import {
  COMMERCIAL_LLM_MODEL_SHA256,
  COMMERCIAL_LLM_PROMPT_SHA256,
  COMMERCIAL_LLM_RUNTIME_VERSION,
  COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
  COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256,
  COMMERCIAL_LLM_POLICY_VERSION,
  type CommercialLlmObservationResult,
} from './commercial-llm.protocol';
import {
  COMMERCIAL_LLM_CASCADE_VERSION,
  COMMERCIAL_LLM_WORKSTATION_IDENTITY,
} from './commercial-llm-workstation.protocol';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const positive: CommercialLlmObservationResult = {
  classification: 'COMMERCIAL',
  reasonCodes: ['COMMERCIAL_OFFER'],
  modelAlias: 'qwen35-9b-commercial-shadow',
  modelSha256: COMMERCIAL_LLM_MODEL_SHA256,
  promptSha256: COMMERCIAL_LLM_PROMPT_SHA256,
  runtimeVersion: COMMERCIAL_LLM_RUNTIME_VERSION,
  runtimeImageSha256: COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
  chatTemplateSha256: COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256,
  policyVersion: COMMERCIAL_LLM_POLICY_VERSION,
  durationMs: 1,
  cascade: {
    version: COMMERCIAL_LLM_CASCADE_VERSION,
    route: 'secondary_unsure',
    primaryClassification: 'UNSURE',
    primaryModelSha256: COMMERCIAL_LLM_WORKSTATION_IDENTITY.modelSha256,
  },
};
jest.setTimeout(60_000);
(databaseUrl && redisUrl ? describe : describe.skip)(
  'commercial AI durable effect on native stores',
  () => {
    let h: MultibotHarness;
    let mailbox: CommercialLlmEnforcementMailbox;
    const proofKeys: string[] = [];
    let proofUnavailable = false;
    beforeAll(async () => {
      h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 2, mode: 'on' });
      await h.pause();
      await h.deleteQueue.pause();
      mailbox = new CommercialLlmEnforcementMailbox(h.redis);
      Object.assign(h.intents, {
        commercialLlmGuard: new CommercialLlmDeleteGuardService(
          h.prisma as never,
          h.max,
          { isKnownBotUserId: () => false } as never,
          new ParticipantModerationImmunityService(h.prisma as never),
          new ConfigService({}),
          {
            enabled: () => true,
            hasProof: async (source: CommercialLlmSource) => {
              if (proofUnavailable) throw new Error('isolated AI dependency outage');
              return mailbox.hasProof(source);
            },
          } as never,
        ),
      });
    });
    beforeEach(async () => {
      proofUnavailable = false;
      await h.redis.del(
        ...Object.values(COMMERCIAL_LLM_ENFORCEMENT_KEYS),
        COMMERCIAL_LLM_LEASE_KEY,
        COMMERCIAL_LLM_COOLDOWN_KEY,
      );
    });
    afterAll(async () => {
      if (!h) return;
      await h.redis.del(
        ...Object.values(COMMERCIAL_LLM_ENFORCEMENT_KEYS),
        COMMERCIAL_LLM_LEASE_KEY,
        COMMERCIAL_LLM_COOLDOWN_KEY,
        ...proofKeys,
      );
      await h.dispose();
    });
    async function fixture() {
      const [chatId] = await h.seedCatalog(1, {
        commercialAdsFilterEnabled: true,
        maxMessageLengthEnabled: true,
        maxMessageLength: 10,
      });
      const settings = await h.prisma.chatSettings.findUniqueOrThrow({
        where: { chatId: chatId! },
      });
      const now = Date.now(),
        messageId = randomUUID(),
        userId = `ai-user-${randomUUID()}`,
        botId = h.bots[0]!.id;
      const text = 'Мастерская принимает заказы на ремонт. Работаем по договору, запись на замер.';
      const message = {
        sender: { user_id: userId, is_bot: false },
        recipient: { chat_id: chatId!, chat_type: 'chat' },
        timestamp: now,
        body: { mid: messageId, text },
      };
      h.messages.set(messageId, message);
      const offer = buildCommercialLlmOffer({
        chatId: chatId!,
        messageId,
        userId,
        originBotId: botId,
        text,
        eventAt: new Date(now).toISOString(),
        settings,
        origin: {
          sourceWebhookEventId: randomUUID(),
          sourceReceivingBotId: botId,
          sourceExecutionBotId: botId,
          sourceEventAtMs: now,
          sourceEvidenceVersion: 1,
        },
      })!;
      proofKeys.push(commercialLlmProofKey(offer.source));
      const worker = randomUUID();
      await mailbox.heartbeat(worker);
      await mailbox.advertise(worker);
      expect(await mailbox.offer(offer)).toBe(true);
      const processor = new CommercialLlmEnforcementProcessor(
        mailbox,
        { classify: async () => positive },
        { ensureIntent: (input) => h.intents.ensureIntent(input, { enqueue: false }) },
        async () => true,
      );
      expect(await processor.run(worker, new AbortController().signal)).toMatchObject({
        outcome: 'delete_registered',
      });
      const intent = await h.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { chatId_messageId: { chatId: chatId!, messageId } },
      });
      return { chatId: chatId!, messageId, userId, botId, message, offer, intent };
    }
    it('persists exact original provenance, enforces fresh source and only deletes without sanctions', async () => {
      const s = await fixture();
      const origins = await h.prisma.$queryRaw<{ event: string; bot: string; at: Date }[]>`
      SELECT o.source_webhook_event_id AS event, o.source_execution_bot_id AS bot, o.source_event_at AS at
      FROM moderation_delete_reason_origins o JOIN moderation_delete_intent_reasons r ON r.id = o.reason_id
      WHERE r.intent_id = ${s.intent.id}`;
      expect(origins).toEqual([
        {
          event: s.offer.source.origin.sourceWebhookEventId,
          bot: s.botId,
          at: new Date(s.offer.source.eventAtMs),
        },
      ]);
      const before = h.effects.length;
      expect((await h.intents.attemptIntent(s.intent.id)).confirmed).toBe(true);
      expect(h.effects.slice(before)).toHaveLength(1);
      expect(h.effects[before]!.method).toBe('delete');
      expect(await h.prisma.violation.count({ where: { chatId: s.chatId } })).toBe(0);
      expect(
        (await h.prisma.moderationDeleteIntent.findUniqueOrThrow({ where: { id: s.intent.id } }))
          .status,
      ).toBe('SUCCEEDED');
    });
    it('refuses a changed exact message and does not revive its inference', async () => {
      const s = await fixture();
      s.message.body.text = 'Обычный разговор';
      const before = h.effects.length;
      expect((await h.intents.attemptIntent(s.intent.id)).confirmed).toBe(false);
      expect(h.effects.length).toBe(before);
      expect(await h.redis.exists(COMMERCIAL_LLM_ENFORCEMENT_KEYS.slot)).toBe(0);
    });
    it('AI dependency loss yields to an independently valid length reason on the same message', async () => {
      const s = await fixture();
      proofUnavailable = true;
      await h.intents.ensureIntent(
        {
          chatId: s.chatId,
          messageId: s.messageId,
          subjectUserId: s.userId,
          originBotId: s.botId,
          entityType: 'CHAT',
          messageAuthorKind: 'user',
          sourceMessageAt: new Date(),
          ruleCode: 'MESSAGE_TOO_LONG_DELETE',
          reasonKey: 'independent-length',
          event: { userId: s.userId, eventType: 'MESSAGE' },
        },
        { enqueue: false },
      );
      expect((await h.intents.attemptIntent(s.intent.id)).confirmed).toBe(true);
    });
    it('an unknown DELETE stays fenced on retry rather than repeating the remote action', async () => {
      const s = await fixture();
      h.ambiguousNextDelete();
      const before = h.effects.length;
      await h.intents.attemptIntent(s.intent.id);
      const first = await h.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { id: s.intent.id },
      });
      expect(first.status).toBe('AMBIGUOUS');
      const afterFirst = h.effects.length;
      await h.intents.attemptIntent(s.intent.id);
      expect(h.effects.length).toBe(afterFirst);
      expect(afterFirst - before).toBeLessThanOrEqual(1);
      expect(await h.redis.exists(COMMERCIAL_LLM_ENFORCEMENT_KEYS.slot)).toBe(0);
    });
  },
);
