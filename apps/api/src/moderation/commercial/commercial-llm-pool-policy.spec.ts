import { ConfigService } from '@nestjs/config';
import {
  buildCommercialLlmOffer,
  commercialLlmMayDelete,
  commercialLlmSourceKey,
  commercialLlmSourceSchema,
  type CommercialLlmPoolPolicy,
} from './commercial-llm-enforcement.protocol';
import { CommercialLlmEnforcementService } from './commercial-llm-enforcement.service';
import { CommercialLlmEnforcementMailbox } from './commercial-llm-enforcement.mailbox';
import {
  COMMERCIAL_LLM_POOL_PROFILES,
  type CommercialLlmPoolNodeId,
} from './commercial-llm-pool.protocol';
import {
  COMMERCIAL_LLM_POLICY_VERSION,
  type CommercialLlmObservationResult,
} from './commercial-llm.protocol';
import { createCommercialLlmRedis } from './commercial-llm-shadow.lease';

function source(policy?: CommercialLlmPoolPolicy) {
  const now = Date.now();
  return buildCommercialLlmOffer(
    {
      chatId: 'chat',
      messageId: 'message',
      userId: 'author',
      originBotId: 'bot',
      text: 'Мастерская принимает заказы на ремонт.',
      eventAt: new Date(now).toISOString(),
      origin: {
        sourceWebhookEventId: 'receipt',
        sourceReceivingBotId: 'bot',
        sourceExecutionBotId: 'bot',
        sourceEventAtMs: now,
        sourceEvidenceVersion: 1,
      },
      settings: {
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 45,
        commercialAdsDeleteThreshold: 65,
        nightModeTimezone: 'Europe/Moscow',
        textFiltersWarnEnabled: true,
        textFiltersMuteEnabled: true,
        textFiltersBanEnabled: true,
        textFiltersMuteDurationHours: 1,
        textFiltersBotMessageEnabled: true,
      },
    },
    now,
    policy,
  )!.source;
}
function positive(
  nodeId: CommercialLlmPoolNodeId,
  policy: CommercialLlmPoolPolicy,
): CommercialLlmObservationResult {
  return {
    ...COMMERCIAL_LLM_POOL_PROFILES[nodeId].identity,
    classification: 'COMMERCIAL',
    reasonCodes: ['COMMERCIAL_OFFER'],
    durationMs: 10,
    policyVersion: COMMERCIAL_LLM_POLICY_VERSION,
    pool: { version: 'commercial-pool-v2', nodeId, policy, route: 'direct', attempts: 1 },
  };
}

describe('commercial pool DELETE authority', () => {
  afterEach(() => jest.restoreAllMocks());
  it('preserves v1 serialized proofs and rejects mutated v2 policy identities', () => {
    const legacy = source();
    expect(legacy.version).toBe(1);
    expect(Object.keys(legacy)).toEqual([
      'version',
      'classifierSha256',
      'origin',
      'nonce',
      'chatId',
      'messageId',
      'userId',
      'originBotId',
      'eventAtMs',
      'deadlineAtMs',
      'sourceSha256',
      'settingsSha256',
    ]);
    expect(
      commercialLlmSourceKey(commercialLlmSourceSchema.parse(JSON.parse(JSON.stringify(legacy)))),
    ).toBe(commercialLlmSourceKey(legacy));
    const pool = source('confirm-positive');
    expect(pool.version).toBe(2);
    expect(commercialLlmSourceSchema.safeParse({ ...pool, poolPolicy: 'direct-4b' }).success).toBe(
      false,
    );
    expect(commercialLlmSourceSchema.safeParse({ ...pool, extra: true }).success).toBe(false);
  });
  it.each(['server-9b', 'pc-b-9b'] as const)(
    'accepts exact direct9B provenance from %s only for its v2 source',
    (nodeId) => {
      const result = positive(nodeId, 'confirm-positive');
      expect(commercialLlmMayDelete(result, source('confirm-positive'))).toBe(true);
      expect(commercialLlmMayDelete(result, source())).toBe(false);
      expect(commercialLlmMayDelete(result)).toBe(false);
      for (const key of [
        'modelAlias',
        'modelSha256',
        'promptSha256',
        'chatTemplateSha256',
        'runtimeVersion',
        'runtimeImageSha256',
        'runtimeArtifactSha256',
        'runtimeSupportSha256',
        'policyVersion',
      ] as const)
        expect(
          commercialLlmMayDelete({ ...result, [key]: 'tampered' }, source('confirm-positive')),
        ).toBe(false);
    },
  );
  it('requires explicit direct4B authority and completed idle9B confirmation under conservative policy', () => {
    expect(
      commercialLlmMayDelete(positive('pc-a-4b', 'confirm-positive'), source('confirm-positive')),
    ).toBe(false);
    expect(commercialLlmMayDelete(positive('pc-a-4b', 'direct-4b'), source('direct-4b'))).toBe(
      true,
    );
    const result = positive('pc-b-9b', 'confirm-positive');
    result.pool = {
      ...result.pool!,
      route: 'consulted',
      primaryNodeId: 'pc-a-4b',
      primaryClassification: 'COMMERCIAL',
      consultationOutcome: 'completed',
    };
    expect(commercialLlmMayDelete(result, source('confirm-positive'))).toBe(true);
    for (const outcome of ['no_capacity', 'budget_exhausted'] as const)
      expect(
        commercialLlmMayDelete(
          { ...result, pool: { ...result.pool, consultationOutcome: outcome } },
          source('confirm-positive'),
        ),
      ).toBe(false);
    expect(
      commercialLlmMayDelete(
        { ...result, pool: { ...result.pool, primaryClassification: 'NOT_COMMERCIAL' } },
        source('confirm-positive'),
      ),
    ).toBe(false);
  });
  it('revokes retained v2 proofs immediately when routing is disabled or 4B policy changes', async () => {
    const config = new ConfigService({
      COMMERCIAL_LLM_ENFORCEMENT_ENABLED: true,
      COMMERCIAL_LLM_POOL_WORKERS_ENABLED: true,
      COMMERCIAL_LLM_POOL_ENABLED: true,
      COMMERCIAL_LLM_POOL_4B_POLICY: 'confirm-positive',
    });
    const service = new CommercialLlmEnforcementService(config);
    const redis = createCommercialLlmRedis('redis://127.0.0.1:1');
    const mailbox = new CommercialLlmEnforcementMailbox(redis);
    const proof = jest.spyOn(mailbox, 'hasProof').mockResolvedValue(true);
    jest.spyOn(service, 'mailbox').mockResolvedValue(mailbox);
    const original = source('confirm-positive');
    expect(await service.hasProof(original)).toBe(true);
    config.set('COMMERCIAL_LLM_POOL_4B_POLICY', 'direct-4b');
    expect(await service.hasProof(original)).toBe(false);
    config.set('COMMERCIAL_LLM_POOL_ENABLED', false);
    expect(await service.hasProof(source('direct-4b'))).toBe(false);
    expect(await service.hasProof(source())).toBe(true);
    expect(proof).toHaveBeenCalledTimes(2);
    redis.disconnect();
  });
});
