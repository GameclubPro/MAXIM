import {
  CommercialLlmEnforcementService,
  routeCommercialAiViolations,
} from './commercial-llm-enforcement.service';
import { withCanonicalWebhookOrigin } from '../webhook-effect-origin-context';
import {
  withCommercialLlmEffectOrigin,
  readCommercialLlmEffectOrigin,
} from './commercial-llm-effect-origin';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import {
  createCommercialLlmRedis,
  CommercialLlmShadowLease,
  COMMERCIAL_LLM_LEASE_KEY,
  COMMERCIAL_LLM_COOLDOWN_KEY,
} from './commercial-llm-shadow.lease';
import {
  CommercialLlmEnforcementMailbox,
  COMMERCIAL_LLM_ENFORCEMENT_KEYS as keys,
  commercialLlmProofKey,
} from './commercial-llm-enforcement.mailbox';
import { CommercialLlmEnforcementProcessor } from './commercial-llm-enforcement.processor';
import {
  buildCommercialLlmOffer,
  commercialLlmMayDelete,
  commercialLlmSourceKey,
  COMMERCIAL_LLM_DELETE_RULE_CODE,
  type CommercialLlmSource,
} from './commercial-llm-enforcement.protocol';
import { CommercialLlmDeleteGuardService } from './commercial-llm-delete-guard.service';
import {
  COMMERCIAL_LLM_MODEL_SHA256,
  COMMERCIAL_LLM_PROMPT_SHA256,
  COMMERCIAL_LLM_RUNTIME_VERSION,
  COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
  COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256,
  COMMERCIAL_LLM_POLICY_VERSION,
  type CommercialLlmObservationResult,
  type CommercialLlmClassifier,
} from './commercial-llm.protocol';
import {
  COMMERCIAL_LLM_CASCADE_VERSION,
  COMMERCIAL_LLM_WORKSTATION_IDENTITY,
} from './commercial-llm-workstation.protocol';
import type { ModerationDeleteIntentService } from '../moderation-delete-intent.service';

const settings = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'BALANCED' as const,
  commercialAdsWarnThreshold: 45,
  commercialAdsDeleteThreshold: 65,
  nightModeTimezone: 'Europe/Moscow',
  textFiltersWarnEnabled: true,
  textFiltersMuteEnabled: true,
  textFiltersBanEnabled: true,
  textFiltersMuteDurationHours: 1,
  textFiltersBotMessageEnabled: true,
};
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
  durationMs: 25,
  cascade: {
    version: COMMERCIAL_LLM_CASCADE_VERSION,
    route: 'secondary_unsure',
    primaryClassification: 'UNSURE',
    primaryModelSha256: COMMERCIAL_LLM_WORKSTATION_IDENTITY.modelSha256,
  },
};
const text =
  'Мастерская принимает заказы на ремонт квартир. Работаем по договору, запись на замер.';
const origin = (eventAtMs: number, bot = 'bot') => ({
  sourceWebhookEventId: randomUUID(),
  sourceReceivingBotId: bot,
  sourceExecutionBotId: bot,
  sourceEventAtMs: eventAtMs,
  sourceEvidenceVersion: 1 as const,
});
const offer = () => {
  const now = Date.now();
  return buildCommercialLlmOffer({
    chatId: 'chat',
    messageId: randomUUID(),
    userId: 'user',
    originBotId: 'bot',
    text,
    eventAt: new Date(now).toISOString(),
    origin: origin(now),
    settings,
  })!;
};
const url = process.env.MAXIM_TEST_REDIS_URL ?? '';
(url ? describe : describe.skip)(
  'commercial AI single-slot admission and fresh deletion on real Redis',
  () => {
    let redis: Redis;
    let mailbox: CommercialLlmEnforcementMailbox;
    let worker: string;
    const proofs: string[] = [];
    beforeAll(async () => {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
        throw new Error('Disposable loopback Redis required');
      redis = createCommercialLlmRedis(url);
      await redis.connect();
      mailbox = new CommercialLlmEnforcementMailbox(redis);
    });
    beforeEach(async () => {
      await redis.del(
        ...Object.values(keys),
        COMMERCIAL_LLM_LEASE_KEY,
        COMMERCIAL_LLM_COOLDOWN_KEY,
        ...proofs,
      );
      worker = randomUUID();
    });
    afterAll(async () => {
      await redis.del(
        ...Object.values(keys),
        COMMERCIAL_LLM_LEASE_KEY,
        COMMERCIAL_LLM_COOLDOWN_KEY,
        ...proofs,
      );
      redis.disconnect();
    });
    async function ready() {
      expect(await mailbox.heartbeat(worker)).toBe(true);
      expect(await mailbox.advertise(worker)).toBe(true);
    }
    function processor(
      classify: CommercialLlmClassifier['classify'] = async () => positive,
      mayRun = async () => true,
    ) {
      const ensureIntent = jest
        .fn<
          ReturnType<ModerationDeleteIntentService['ensureIntent']>,
          Parameters<ModerationDeleteIntentService['ensureIntent']>
        >()
        .mockResolvedValue({ intentId: 'intent', rollout: 'execute', status: 'PENDING' });
      return {
        ensureIntent,
        process: new CommercialLlmEnforcementProcessor(
          mailbox,
          new CommercialLlmShadowLease(redis),
          { classify },
          { ensureIntent },
          mayRun,
        ),
      };
    }
    it('offline refuses, simultaneous offers admit exactly one and never build a waiting list', async () => {
      expect(await mailbox.offer(offer())).toBe(false);
      await ready();
      expect(
        (await Promise.all(Array.from({ length: 50 }, () => mailbox.offer(offer())))).filter(
          Boolean,
        ),
      ).toHaveLength(1);
      expect(await mailbox.advertise(worker)).toBe(false);
      expect(await mailbox.heartbeat(randomUUID())).toBe(false);
      expect(await mailbox.take(randomUUID())).toBeNull();
      expect(await redis.exists(keys.slot)).toBe(1);
    });
    it('server confirmation registers exactly one bound delete; no model work is retried', async () => {
      await ready();
      const input = offer();
      proofs.push(commercialLlmProofKey(input.source));
      expect(await mailbox.offer(input)).toBe(true);
      const h = processor();
      expect(await h.process.run(worker, new AbortController().signal)).toMatchObject({
        outcome: 'delete_registered',
      });
      expect(h.ensureIntent).toHaveBeenCalledTimes(1);
      expect(h.ensureIntent.mock.calls[0]![0]).toMatchObject({
        ruleCode: COMMERCIAL_LLM_DELETE_RULE_CODE,
        chatId: input.source.chatId,
        messageId: input.source.messageId,
        retryUntilAt: new Date(input.source.deadlineAtMs),
        event: { metadata: { commercialLlmSource: input.source } },
      });
      expect(await mailbox.hasProof(input.source)).toBe(true);
      expect(await redis.exists(keys.slot)).toBe(0);
      await h.process.run(worker, new AbortController().signal);
      expect(h.ensureIntent).toHaveBeenCalledTimes(1);
    });
    it.each([
      'negative',
      'unsure',
      'failure',
      'pressure',
      'aborted',
      'wrong-model',
      'disagreement',
    ])('%s leaves the message and frees the slot', async (mode) => {
      await ready();
      const input = offer();
      proofs.push(commercialLlmProofKey(input.source));
      await mailbox.offer(input);
      const controller = new AbortController();
      if (mode === 'aborted') controller.abort();
      const h = processor(
        async () => {
          if (mode === 'failure') throw new Error('synthetic failure');
          if (mode === 'negative')
            return {
              ...positive,
              classification: 'NOT_COMMERCIAL',
              reasonCodes: ['PERSONAL_SALE'],
            };
          if (mode === 'unsure')
            return { ...positive, classification: 'UNSURE', reasonCodes: ['INSUFFICIENT_CONTEXT'] };
          if (mode === 'wrong-model') return { ...positive, modelSha256: '0'.repeat(64) };
          if (mode === 'disagreement')
            return {
              ...positive,
              cascade: { ...positive.cascade!, primaryClassification: 'NOT_COMMERCIAL' },
            };
          return positive;
        },
        async () => mode !== 'pressure',
      );
      await h.process.run(worker, controller.signal);
      expect(h.ensureIntent).not.toHaveBeenCalled();
      expect(await mailbox.hasProof(input.source)).toBe(false);
      expect(await redis.exists(keys.slot)).toBe(0);
    });
    it('lost ownership and a late old answer cannot authorize a new request', async () => {
      await ready();
      const input = offer();
      proofs.push(commercialLlmProofKey(input.source));
      await mailbox.offer(input);
      const h = processor(async () => {
        await redis.set(keys.worker, randomUUID(), 'PX', 5000);
        return positive;
      });
      expect(await h.process.run(worker, new AbortController().signal)).toMatchObject({
        outcome: 'source_expired',
      });
      expect(h.ensureIntent).not.toHaveBeenCalled();
      expect(await mailbox.hasProof(input.source)).toBe(false);
    });
    it('a reader that loses ownership cannot discard the successor slot', async () => {
      await ready();
      const successor = randomUUID();
      const input = offer();
      const raw = JSON.stringify({ ...input, worker: successor, submittedAtMs: Date.now() });
      const owns = jest.spyOn(mailbox, 'ownsWorker').mockImplementationOnce(async () => {
        await redis.set(keys.worker, successor, 'PX', 5000);
        await redis.set(keys.slot, raw, 'PX', 5000);
        return true;
      });
      try {
        expect(await mailbox.take(worker)).toBeNull();
      } finally {
        owns.mockRestore();
      }
      expect(await redis.get(keys.slot)).toBe(raw);
      expect(await mailbox.take(successor)).toMatchObject({ raw });
    });
    it('late admission preserves readiness and does not renew an old event', async () => {
      await ready();
      const input = offer();
      input.source.eventAtMs -= 11_000;
      input.source.origin.sourceEventAtMs -= 11_000;
      input.source.deadlineAtMs -= 11_000;
      expect(await mailbox.offer(input)).toBe(false);
      expect(await redis.get(keys.ready)).toBe(worker);
      expect(await redis.exists(keys.slot)).toBe(0);
    });
    it('a new worker discards an unstarted stale slot instead of replaying it', async () => {
      await ready();
      await mailbox.offer(offer());
      await redis.del(keys.worker);
      worker = randomUUID();
      expect(await mailbox.heartbeat(worker)).toBe(true);
      const h = processor();
      await h.process.run(worker, new AbortController().signal);
      expect(h.ensureIntent).not.toHaveBeenCalled();
      expect(await redis.exists(keys.slot)).toBe(0);
    });
    it('an expired inference source has no proof or delete even if the model returns positive', async () => {
      await ready();
      const input = offer();
      proofs.push(commercialLlmProofKey(input.source));
      await mailbox.offer(input);
      const h = processor(async () => {
        await redis.del(keys.slot);
        return positive;
      });
      await h.process.run(worker, new AbortController().signal);
      expect(h.ensureIntent).not.toHaveBeenCalled();
      expect(await mailbox.hasProof(input.source)).toBe(false);
    });
    it('rechecks actual source, settings and immunity against the real stored proof', async () => {
      await ready();
      const input = offer();
      proofs.push(commercialLlmProofKey(input.source));
      await mailbox.offer(input);
      await processor().process.run(worker, new AbortController().signal);
      let currentText = text;
      let enabled = true;
      let immune = false;
      const currentSettings = {
        ...settings,
        chat: { entityType: 'CHAT', admins: [] as { userId: string }[] },
      };
      const max = {
        getChatMemberAccess: jest
          .fn()
          .mockResolvedValue({ userId: 'user', isAdmin: false, isOwner: false }),
        getExactMessageRow: jest.fn().mockImplementation(async () => ({
          body: { mid: input.source.messageId, text: currentText },
          sender: { user_id: 'user' },
          recipient: { chat_id: 'chat', chat_type: 'chat' },
          timestamp: Date.now(),
        })),
      };
      const guard = new CommercialLlmDeleteGuardService(
        {
          chatSettings: { findUnique: jest.fn().mockImplementation(async () => currentSettings) },
        } as never,
        max as never,
        { isKnownBotUserId: () => false } as never,
        { consumeForMessage: async () => (immune ? 'granted' : 'not_granted') } as never,
        new ConfigService({}),
        {
          enabled: () => enabled,
          hasProof: (source: CommercialLlmSource) => mailbox.hasProof(source),
        } as never,
      );
      const params = {
        chatId: 'chat',
        messageId: input.source.messageId,
        subjectUserId: 'user',
        botId: 'bot',
        reasons: [
          {
            ruleCode: COMMERCIAL_LLM_DELETE_RULE_CODE,
            reasonKey: `${COMMERCIAL_LLM_DELETE_RULE_CODE}:${commercialLlmSourceKey(input.source)}`,
            metadata: { commercialLlmSource: input.source },
          },
        ],
      };
      await expect(guard.authorize(params)).resolves.toMatchObject({
        deadlineAtMs: input.source.deadlineAtMs,
      });
      for (const change of [
        () => {
          currentText = 'Обычный разговор';
        },
        () => {
          currentText = text;
          enabled = false;
        },
        () => {
          enabled = true;
          immune = true;
        },
        () => {
          immune = false;
          currentSettings.commercialAdsFilterEnabled = false;
        },
      ]) {
        change();
        await expect(guard.authorize(params)).rejects.toMatchObject({
          code: 'commercial_ai_delete_no_longer_authorized',
        });
      }
      currentSettings.commercialAdsFilterEnabled = true;
      max.getExactMessageRow.mockImplementation(async () => {
        currentSettings.textFiltersBanEnabled = false;
        return {
          body: { mid: input.source.messageId, text },
          sender: { user_id: 'user' },
          recipient: { chat_id: 'chat', chat_type: 'chat' },
          timestamp: Date.now(),
        };
      });
      await expect(guard.authorize(params)).rejects.toMatchObject({
        code: 'commercial_ai_delete_no_longer_authorized',
      });
    });
  },
);

describe('commercial AI source/protocol admission', () => {
  it('accepts only a fresh complete enabled source', () => {
    const now = Date.now();
    const input = {
      chatId: 'c',
      messageId: 'm',
      userId: 'u',
      originBotId: 'b',
      text,
      eventAt: new Date(now).toISOString(),
      origin: origin(now, 'b'),
      settings,
    };
    expect(buildCommercialLlmOffer(input)).not.toBeNull();
    expect(buildCommercialLlmOffer({ ...input, text: 'x'.repeat(2501) })).toBeNull();
    expect(
      buildCommercialLlmOffer({ ...input, eventAt: new Date(Date.now() - 11_000).toISOString() }),
    ).toBeNull();
    expect(buildCommercialLlmOffer({ ...input, originBotId: undefined })).toBeNull();
    expect(
      buildCommercialLlmOffer({
        ...input,
        settings: { ...settings, commercialAdsFilterEnabled: false },
      }),
    ).toBeNull();
  });
  it('does not admit mismatched origin or attribute another rule, target or settled child', async () => {
    const input = offer();
    expect(
      buildCommercialLlmOffer({
        chatId: 'chat',
        messageId: 'm',
        userId: 'user',
        originBotId: 'wrong',
        text,
        eventAt: new Date(input.source.eventAtMs).toISOString(),
        settings,
        origin: input.source.origin,
      }),
    ).toBeNull();
    let after!: () => ReturnType<typeof readCommercialLlmEffectOrigin>;
    await withCommercialLlmEffectOrigin(
      input.source,
      async () => true,
      async () => {
        expect(
          readCommercialLlmEffectOrigin(
            input.source.chatId,
            input.source.messageId,
            COMMERCIAL_LLM_DELETE_RULE_CODE,
          )?.sourceWebhookEventId,
        ).toBe(input.source.origin.sourceWebhookEventId);
        expect(
          readCommercialLlmEffectOrigin(
            input.source.chatId,
            input.source.messageId,
            'COMMERCIAL_AD_DELETE',
          ),
        ).toBeNull();
        expect(
          readCommercialLlmEffectOrigin(
            'another',
            input.source.messageId,
            COMMERCIAL_LLM_DELETE_RULE_CODE,
          ),
        ).toBeNull();
        // Async resource captures the actual child context and runs after its settlement.
        const resource = new (await import('node:async_hooks')).AsyncResource('late-ai-child');
        after = () =>
          resource.runInAsyncScope(() =>
            readCommercialLlmEffectOrigin(
              input.source.chatId,
              input.source.messageId,
              COMMERCIAL_LLM_DELETE_RULE_CODE,
            ),
          );
      },
    );
    expect(after()).toBeNull();
    await expect(
      withCommercialLlmEffectOrigin(
        input.source,
        async () => false,
        async () => undefined,
      ),
    ).rejects.toThrow();
  });
  it('captures only active canonical authority and returns without awaiting admission', async () => {
    const service = new CommercialLlmEnforcementService(
      new ConfigService({ COMMERCIAL_LLM_ENFORCEMENT_ENABLED: true }),
    );
    let release!: (accepted: boolean) => void;
    const admission = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const submit = jest.fn().mockReturnValue(admission);
    jest.spyOn(service, 'mailbox').mockResolvedValue({ offer: submit } as never);
    const now = Date.now();
    const input = {
      chatId: 'chat',
      messageId: 'message',
      userId: 'user',
      originBotId: 'bot',
      text,
      eventAt: new Date(now).toISOString(),
      settings,
    };
    service.offer(input);
    await Promise.resolve();
    expect(submit).not.toHaveBeenCalled();
    await withCanonicalWebhookOrigin(
      {
        webhookEvent: { id: 'receipt', botId: 'bot' },
        activeBotId: 'executor',
        update: {
          updateId: 'u',
          botId: 'bot',
          type: 'message_created',
          eventTimestampSource: 'payload',
          raw: { timestamp: now },
          message: {
            chatId: 'chat',
            messageId: 'message',
            senderId: 'user',
            text,
            createdAt: new Date(now).toISOString(),
          },
        },
      },
      async () => {
        service.offer(input);
        service.offer(input);
      },
    );
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]![0].source).toMatchObject({
      originBotId: 'executor',
      origin: { sourceWebhookEventId: 'receipt' },
    });
    release(false);
    const violations = [
      { ruleCode: 'LINK_BLOCKED' },
      { ruleCode: 'COMMERCIAL_AD' },
      { ruleCode: 'PROFANITY' },
    ] as never;
    expect(routeCommercialAiViolations(violations, true).map((v) => v.ruleCode)).toEqual([
      'LINK_BLOCKED',
      'PROFANITY',
    ]);
    service.onModuleDestroy();
  });
  it('neither primary-only positives nor changed protocol identities grant delete authority', () => {
    expect(commercialLlmMayDelete(positive)).toBe(true);
    expect(
      commercialLlmMayDelete({ ...positive, cascade: { ...positive.cascade!, route: 'primary' } }),
    ).toBe(false);
    expect(commercialLlmMayDelete({ ...positive, promptSha256: '0'.repeat(64) })).toBe(false);
  });
});
