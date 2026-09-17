import { resolveCommercialServiceSpeechAct } from './commercial-service-speech-act';
import { CommercialAdDetector } from './commercial-ad.detector';
import type { ChatSettings } from '../../prisma/prisma-client';
import {
  COMMERCIAL_INTENT_CASES,
  COMMERCIAL_INTENT_COUNTEREXAMPLES,
} from '../commercial-intent.fixture';
import { resolveCommercialLocalContext } from './commercial-local-context';

describe('commercial assertion roles', () => {
  it('handles long whitespace runs without changing near-miss words into speech acts', () => {
    expect(resolveCommercialServiceSpeechAct(`Сообщение.\n${'\n'.repeat(20_000)}кто-нибудьx`)).toBe(
      'NONE',
    );
    expect(
      resolveCommercialServiceSpeechAct(`${' '.repeat(2000)}Кто-нибудь ремонтирует холодильники?`),
    ).toBe('REQUEST');
  });
  it.each([
    ['Кто-нибудь ремонтирует стиральные машины?', 'REQUEST'],
    ['Добрый день, есть здесь сантехник?', 'REQUEST'],
    ['Не подскажете, кто может починить холодильник?', 'REQUEST'],
    ['Спасибо мастеру за ремонт!', 'TESTIMONIAL'],
    ['Вчера заказывала химчистку дивана.', 'TESTIMONIAL'],
    ['Не рекомендую мастера по ремонту.', 'TESTIMONIAL'],
    ['Я больше не ремонтирую холодильники.', 'REFUSAL'],
    ['Мы не оказываем услуги химчистки.', 'REFUSAL'],
    ['Рекомендую наши услуги ремонта.', 'NONE'],
    ['Спасибо нашим клиентам за доверие!', 'NONE'],
    ['Кто хочет заказать ремонт? Звоните нам.', 'NONE'],
  ])('classifies the speech act without attributing quoted service nouns: %s', (text, expected) => {
    expect(resolveCommercialServiceSpeechAct(text)).toBe(expected);
  });

  it('does not let repetition alone turn protected speech into an offer', () => {
    const settings = {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    } as ChatSettings;
    for (const item of [...COMMERCIAL_INTENT_CASES, ...COMMERCIAL_INTENT_COUNTEREXAMPLES].filter(
      (item) => !item.expectedDelete,
    )) {
      const result = new CommercialAdDetector().detect({
        settings,
        normalizedText: '',
        rawLoweredText: item.text.toLowerCase(),
        commercialCampaignContext: {
          senderDistinctChatCount: 20,
          sameTextDistinctChatCount: 20,
          repeatedPhoneDistinctChatCount: 20,
          repeatedLinkDistinctChatCount: 0,
        },
      });
      expect({ text: item.text, actionable: result?.actionable === true }).toEqual({
        text: item.text,
        actionable: false,
      });
    }
  });

  it('does not describe truncated local context as complete', () => {
    const result = resolveCommercialLocalContext({
      rawLoweredText: `Спасибо мастеру за ремонт! ${'Обычная фраза. '.repeat(700)}`,
      escalationRiskLabels: [],
      includeOrdinaryProtectedContext: true,
    });
    expect(result.fullyInspected).toBe(false);
  });

  it('keeps the assertion-count limit explicit even when the text is short', () => {
    const text = `Спасибо мастеру за ремонт! ${'Коротко. '.repeat(65)}`;
    expect(text.length).toBeLessThan(8000);
    expect(
      resolveCommercialLocalContext({
        rawLoweredText: text,
        escalationRiskLabels: [],
        includeOrdinaryProtectedContext: true,
      }).fullyInspected,
    ).toBe(false);
  });

  it.each(['. Но мы', ', но мы', '. Отдельно: мы'])(
    'retains an independent offer after a refusal: %s',
    (separator) => {
      const text = `Не занимаюсь ремонтом телефонов${separator} ремонтируем холодильники, выезд 500 рублей. Звоните +7 900 000 10 42.`;
      const result = new CommercialAdDetector().detect({
        rawLoweredText: text.toLowerCase(),
        normalizedText: '',
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 45,
          commercialAdsDeleteThreshold: 65,
        } as ChatSettings,
      });
      expect(result?.actionable).toBe(true);
    },
  );
});
