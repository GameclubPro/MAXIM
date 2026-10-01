import type { ChatSettings } from '../../prisma/prisma-client';
import type { CommercialCampaignContext } from '../commercial-campaign.util';
import { CommercialAdDetector, type CommercialDetection } from './commercial-ad.detector';
import { CommercialDetectorDecisionCache } from './commercial-detector-cache';
import { normalizeCommercialText } from './commercial-normalization';

const SETTINGS = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'BALANCED',
  commercialAdsWarnThreshold: 45,
  commercialAdsDeleteThreshold: 65,
} as ChatSettings;
const TEXT = 'Ремонт холодильников. Выезд от 2000 рублей, звоните 8 900 000 10 42.';

function input(text = TEXT) {
  return {
    rawLoweredText: text.toLowerCase(),
    normalizedText: normalizeCommercialText(text),
    settings: { ...SETTINGS },
  };
}

function detection(): CommercialDetection {
  const result = new CommercialAdDetector().detect(input());
  expect(result).not.toBeNull();
  return result!;
}

describe('bounded commercial decision cache', () => {
  it('retains derived decisions without retaining raw or isolated message text', () => {
    const cache = new CommercialDetectorDecisionCache(2);
    const result = detection();
    const key = cache.buildKey(input());
    expect(key).toMatch(/^[a-f0-9]{64}$/u);
    cache.remember(key, result);
    const read = cache.read(key);
    expect(read.hit).toBe(true);
    if (read.hit) {
      expect(read.detection).not.toHaveProperty('rawText');
      expect(read.detection).not.toHaveProperty('analysisText');
    }
    cache.remember('isolated', { ...result, analysisText: 'Телефон 8 900 000 10 43.' });
    expect(cache.read('isolated')).toEqual({ hit: false });
    expect(cache.stats.entries).toBe(1);
  });

  it('copies nested results on both insertion and retrieval', () => {
    const cache = new CommercialDetectorDecisionCache();
    const source = detection();
    const expected = structuredClone(source);
    cache.remember('decision', source);
    source.matchedSignals.push('caller:source-mutation');
    source.appliedThresholds.deleteThreshold = 1;
    const first = cache.read('decision');
    expect(first.hit).toBe(true);
    if (!first.hit || !first.detection) throw new Error('Missing cached decision');
    expect(first.detection.matchedSignals).toEqual(expected.matchedSignals);
    expect(first.detection.appliedThresholds).toEqual(expected.appliedThresholds);
    first.detection.matchedSignals.push('caller:returned-mutation');
    first.detection.appliedThresholds.deleteThreshold = 1;
    const second = cache.read('decision');
    expect(second.hit).toBe(true);
    if (!second.hit || !second.detection) throw new Error('Missing cached decision');
    expect(second.detection.matchedSignals).toEqual(expected.matchedSignals);
    expect(second.detection.appliedThresholds).toEqual(expected.appliedThresholds);
  });

  it('bounds retained decisions with LRU eviction and caches null outcomes', () => {
    const cache = new CommercialDetectorDecisionCache(2);
    cache.remember('first', null);
    cache.remember('second', null);
    expect(cache.read('first')).toEqual({ hit: true, detection: null });
    cache.remember('third', null);
    expect(cache.read('second')).toEqual({ hit: false });
    expect(cache.read('first')).toEqual({ hit: true, detection: null });
    expect(cache.read('third')).toEqual({ hit: true, detection: null });
    expect(cache.stats).toEqual({ entries: 2, hits: 3, misses: 1, evictions: 1 });
  });

  it('does not let a cached decision contaminate changed text, layout, settings or cohort policy', () => {
    const detector = new CommercialAdDetector();
    const original = input();
    detector.detect(original);
    const variants = [
      { ...original, rawLoweredText: original.rawLoweredText.replaceAll('. ', '\n') },
      { ...original, normalizedText: `${original.normalizedText} другой текст` },
      {
        ...original,
        settings: { ...SETTINGS, commercialAdsSensitivity: 'STRICT' } as ChatSettings,
      },
      { ...original, settings: { ...SETTINGS, commercialAdsWarnThreshold: 99 } },
      { ...original, settings: { ...SETTINGS, commercialAdsDeleteThreshold: 99 } },
      { ...original, settings: { ...SETTINGS, commercialAdsFilterEnabled: false } },
      { ...original, promotedPolicyCohorts: ['owned-service-contrast-v1'] },
    ];
    for (const variant of variants) {
      const misses = detector.cacheStats.misses;
      expect(detector.detect(variant)).toEqual(new CommercialAdDetector().detect(variant));
      expect(detector.cacheStats.misses).toBe(misses + 1);
    }
    const hits = detector.cacheStats.hits;
    expect(detector.detect(original)).toEqual(new CommercialAdDetector().detect(original));
    expect(detector.cacheStats.hits).toBe(hits + 1);
  });

  it('keys every campaign count numerically and protects campaign objects from caller mutation', () => {
    const detector = new CommercialAdDetector();
    const commercialCampaignContext: CommercialCampaignContext = {
      senderDistinctChatCount: 3,
      sameTextDistinctChatCount: 2,
      repeatedPhoneDistinctChatCount: 2,
      repeatedLinkDistinctChatCount: 2,
      nearTextDistinctChatCount: 2,
      repeatedDomainDistinctChatCount: 2,
      repeatedHandleDistinctChatCount: 2,
      senderDistinctChatCount5m: 2,
      senderDistinctChatCount30m: 2,
      senderDistinctChatCount120m: 2,
      shadowSlidingSenderDistinctChatCount5m: 2,
      shadowSlidingSenderDistinctChatCount30m: 2,
      shadowSlidingSenderDistinctChatCount120m: 2,
    };
    const original = { ...input(), commercialCampaignContext };
    const expected = new CommercialAdDetector().detect(original);
    const returned = detector.detect(original);
    if (returned?.campaignContext) returned.campaignContext.senderDistinctChatCount = 999;
    expect(detector.detect(original)).toEqual(expected);
    for (const field of Object.keys(
      commercialCampaignContext,
    ) as (keyof CommercialCampaignContext)[]) {
      const variant = {
        ...original,
        commercialCampaignContext: {
          ...commercialCampaignContext,
          [field]: commercialCampaignContext[field]! + 1,
        },
      };
      const misses = detector.cacheStats.misses;
      expect(detector.detect(variant)).toEqual(new CommercialAdDetector().detect(variant));
      expect(detector.cacheStats.misses).toBe(misses + 1);
    }
  });

  it('reuses null decisions while recomputing isolated offers', () => {
    const detector = new CommercialAdDetector();
    const safe = input('Соседи, всем хорошего дня!');
    expect(detector.detect(safe)).toBeNull();
    expect(detector.detect(safe)).toBeNull();
    expect(detector.cacheStats).toMatchObject({ entries: 1, hits: 1, misses: 1 });
    const isolated = input(
      'Мастер обманул меня. Отдельно: мы ремонтируем холодильники от 2000 рублей, звоните 8 900 000 10 42.',
    );
    const first = detector.detect(isolated);
    expect(first?.analysisText).toBeDefined();
    expect(detector.detect(isolated)).toEqual(first);
    expect(detector.cacheStats).toMatchObject({ entries: 1, hits: 1, misses: 3 });
  });
});
