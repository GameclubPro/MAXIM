import type { ChatSettings } from '../../prisma/prisma-client';
import type { CommercialCampaignContext } from '../commercial-campaign.util';
import { createRuleDetectionContext } from '../rule-engine-detection-context';
import { CommercialAdDetector } from './commercial-ad.detector';

const BASE_SETTINGS = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'STRICT',
  commercialAdsWarnThreshold: 38,
  commercialAdsDeleteThreshold: 55,
} as unknown as ChatSettings;

const detector = new CommercialAdDetector();

function detect(
  text: string,
  options: {
    settings?: Partial<ChatSettings>;
    commercialCampaignContext?: CommercialCampaignContext | null;
  } = {},
) {
  const settings = {
    ...BASE_SETTINGS,
    ...options.settings,
  } as ChatSettings;
  const context = createRuleDetectionContext({ text, settings });

  return detector.detect({
    normalizedText: context.normalizedText,
    rawLoweredText: context.rawLoweredText,
    settings,
    commercialCampaignContext: options.commercialCampaignContext ?? null,
  });
}

describe('commercial gold policy regressions', () => {
  it('keeps local private-like retail listings out of auto-delete', () => {
    const result = detect(
      'Продам рассаду томатов и перцев, сортовая, 60 руб за штуку. Самовывоз, звоните +7 900 000 00 00',
      {
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 57,
          commercialAdsDeleteThreshold: 77,
        },
      },
    );

    expect(result?.primarySubtype).toBe('GOODS_RETAIL');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
    expect(result?.safeContextBucket).toBe('private_one_off_sale');
    expect(result?.deleteSuppressed).toBe(true);
    expect(result?.reasonCodes).toContain('safe-context:private_one_off_sale');
  });

  it('keeps campaign-only repeats out of auto-delete even at strong campaign confidence', () => {
    const result = detect('В наличии свежая партия, доставка по городу. Подробности в личку.', {
      commercialCampaignContext: {
        senderDistinctChatCount: 5,
        sameTextDistinctChatCount: 3,
        repeatedPhoneDistinctChatCount: 0,
        repeatedLinkDistinctChatCount: 0,
        nearTextDistinctChatCount: 3,
        repeatedDomainDistinctChatCount: 0,
        repeatedHandleDistinctChatCount: 0,
        senderDistinctChatCount5m: 4,
        senderDistinctChatCount30m: 5,
        senderDistinctChatCount120m: 5,
      },
    });

    expect(result).toBeDefined();
    expect(result?.campaignStrength).toBe('STRONG');
    expect(result?.actionBand).not.toBe('DELETE');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
    expect(result?.reasonCodes).toContain('suppressed:campaign-only');
  });

  it('deletes linked structured retail ads with direct evidence', () => {
    const result = detect(
      'Домашняя молочка с доставкой: творог, сметана, сыр. Цена от 150 руб, заказ через каталог https://example.com/milk, телефон +7 900 000 00 00',
      {
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 57,
          commercialAdsDeleteThreshold: 77,
        },
      },
    );

    expect(result?.primarySubtype).toBe('GOODS_RETAIL');
    expect(result?.actionBand).toBe('DELETE');
    expect(result?.reasonCodes).toContain('evidence:action-direct');
  });

  it('escalates scam-grade commercial risk only with direct risk evidence', () => {
    const result = detect(
      'Деньги до зарплаты онлайн, одобрим без отказа. Заявка по ссылке https://credit.example',
    );

    expect(result?.matchedSignals).toContain('risk:loan-leadgen');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
    expect(result?.reviewPriority).toBe('URGENT');
    expect(result?.reasonCodes).toContain('risk:escalation-grade');
  });

  it('keeps ordinary private goods sales reviewable instead of deleting them', () => {
    const result = detect(
      'Полный комплект ПК для работы и учебы. Возможна доставка. Цена 10500 +7 900 000 10 13. Звоните, тут не могу ответить.',
    );

    expect(result?.primarySubtype).toBe('GOODS');
    expect(['WARN', 'REVIEW_ONLY']).toContain(result?.actionBand);
    expect(result?.actionBand).not.toBe('DELETE');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });
});
