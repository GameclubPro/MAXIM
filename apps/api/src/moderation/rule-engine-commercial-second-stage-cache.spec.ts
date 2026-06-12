import { CommercialSecondStageDecisionCache } from './rule-engine-commercial-second-stage-cache';
import type { CommercialSecondStageDecision } from './rule-engine-commercial-second-stage-cache';

const decision: CommercialSecondStageDecision = {
  adjustedConfidenceScore: 70,
  primarySubtype: 'GOODS_RETAIL',
  supportingSubtypes: ['GOODS'],
  reviewRecommended: false,
  reviewReasons: [],
  classifierVersion: '2026-service-private-v3',
  commercialProbability: 0.91,
  reviewProbability: 0.12,
  classifierReasons: ['boosted-structured'],
};

const baseKeyParams = {
  normalizedText: 'купить свежие цветы доставка пишите в личку',
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
