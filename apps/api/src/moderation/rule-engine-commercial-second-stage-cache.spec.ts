import { CommercialSecondStageDecisionCache } from './rule-engine-commercial-second-stage-cache';
import type { CommercialSecondStageDecision } from './rule-engine-commercial-second-stage-cache';
import { collectCommercialSignals } from './commercial/commercial-features';

const decision: CommercialSecondStageDecision = {
  adjustedConfidenceScore: 70,
  primarySubtype: 'GOODS_RETAIL',
  supportingSubtypes: ['GOODS'],
  reviewRecommended: false,
  reviewReasons: [],
  classifierVersion: '2026-service-private-v4',
  commercialProbability: 0.91,
  reviewProbability: 0.12,
  classifierReasons: ['boosted-structured'],
};

const baseKeyParams = {
  normalizedText: 'купить свежие цветы доставка пишите в личку',
  rawLoweredText: 'купить свежие цветы доставка пишите в личку',
  state: collectCommercialSignals({
    normalizedText: 'купить свежие цветы доставка пишите в личку',
    rawLoweredText: 'купить свежие цветы доставка пишите в личку',
    profile: { warnThreshold: 45, deleteThreshold: 65, sensitivity: 'BALANCED', strictness: 0.5 },
  }),
  confidenceScore: 70,
  decisionBand: 'MEDIUM' as const,
  appliedThresholds: {
    warnThreshold: 45,
    deleteThreshold: 65,
    sensitivity: 'BALANCED' as const,
    strictness: 0.5,
  },
  classification: {
    primarySubtype: 'GOODS_RETAIL' as const,
    supportingSubtypes: [],
    evidenceStrength: 'DIRECT' as const,
    reviewRecommended: false,
    reviewReasons: [],
  },
};

describe('CommercialSecondStageDecisionCache', () => {
  it('builds stable keys for equivalent classifier inputs', () => {
    const cache = new CommercialSecondStageDecisionCache();

    expect(cache.buildKey(baseKeyParams)).toBe(cache.buildKey({ ...baseKeyParams }));
  });

  it('includes campaign counters in the key', () => {
    const cache = new CommercialSecondStageDecisionCache();
    const withoutCampaign = cache.buildKey(baseKeyParams);
    const withCampaign = cache.buildKey({
      ...baseKeyParams,
      commercialCampaignContext: {
        sameTextDistinctChatCount: 3,
        repeatedPhoneDistinctChatCount: 0,
        repeatedLinkDistinctChatCount: 1,
        senderDistinctChatCount: 2,
      },
    });

    expect(withCampaign).not.toBe(withoutCampaign);
  });

  it('includes sensitivity and strictness in the key', () => {
    const cache = new CommercialSecondStageDecisionCache();
    const balanced = cache.buildKey(baseKeyParams);
    const strict = cache.buildKey({
      ...baseKeyParams,
      appliedThresholds: {
        ...baseKeyParams.appliedThresholds,
        sensitivity: 'STRICT',
        strictness: 0.56,
      },
    });

    expect(strict).not.toBe(balanced);
  });

  it.each([
    { rawLoweredText: 'купить свежие цветы\nдоставка пишите в личку' },
    { state: { ...baseKeyParams.state, hasStrongNegativeContext: true } },
    { state: { ...baseKeyParams.state, matchedSignals: ['contact:phone'] } },
    { state: { ...baseKeyParams.state, negativeSignals: ['private:one-off'] } },
    { classification: { ...baseKeyParams.classification, reviewReasons: ['campaign-dependent'] } },
    { classification: { ...baseKeyParams.classification, reviewRecommended: true } },
    {
      classification: {
        ...baseKeyParams.classification,
        supportingSubtypes: ['SERVICES' as const],
      },
    },
    {
      classification: { ...baseKeyParams.classification, evidenceStrength: 'BORDERLINE' as const },
    },
    { confidenceScore: 70.1 },
    { appliedThresholds: { ...baseKeyParams.appliedThresholds, strictness: 0.5001 } },
  ])('separates every scoring input from its cached predecessor: %j', (changed) => {
    const cache = new CommercialSecondStageDecisionCache();
    expect(cache.buildKey({ ...baseKeyParams, ...changed })).not.toBe(
      cache.buildKey(baseKeyParams),
    );
  });

  it('does not let caller mutations change stored decisions', () => {
    const cache = new CommercialSecondStageDecisionCache();
    const key = cache.buildKey(baseKeyParams);
    const original = structuredClone(decision);
    cache.remember(key, original);
    original.reviewReasons.push('changed-after-write');
    original.supportingSubtypes.push('SERVICES');
    const first = cache.read(key)!;
    first.adjustedConfidenceScore = 0;
    first.reviewReasons.push('changed-after-read');
    first.classifierReasons.push('changed-after-read');
    first.supportingSubtypes.push('SERVICES');
    expect(cache.read(key)).toEqual(decision);
  });

  it('refreshes read entries before evicting the oldest decision', () => {
    const cache = new CommercialSecondStageDecisionCache(2);
    const firstKey = cache.buildKey(baseKeyParams);
    const secondKey = cache.buildKey({
      ...baseKeyParams,
      normalizedText: 'аренда помещения под склад',
    });
    const thirdKey = cache.buildKey({
      ...baseKeyParams,
      normalizedText: 'услуги грузчиков сегодня',
    });

    cache.remember(firstKey, decision);
    cache.remember(secondKey, { ...decision, primarySubtype: 'PROPERTY_COMMERCIAL' });
    expect(cache.read(firstKey)).toEqual(decision);

    cache.remember(thirdKey, { ...decision, primarySubtype: 'SERVICES' });

    expect(cache.size).toBe(2);
    expect(cache.read(firstKey)).toEqual(decision);
    expect(cache.read(secondKey)).toBeNull();
    expect(cache.read(thirdKey)).toEqual({ ...decision, primarySubtype: 'SERVICES' });
  });
});
