import type { ChatSettings } from '../../prisma/prisma-client';
import { createRuleDetectionContext } from '../rule-engine-detection-context';
import { CommercialAdDetector } from './commercial-ad.detector';
import { collectCommercialSignals } from './commercial-features';
import { splitCommercialAssertions } from './commercial-local-context';
import { normalizeCommercialRawText, normalizeCommercialText } from './commercial-normalization';

const STRICT_SETTINGS = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'STRICT',
  commercialAdsWarnThreshold: 38,
  commercialAdsDeleteThreshold: 55,
} as unknown as ChatSettings;

const STRICT_PROFILE = {
  warnThreshold: 38,
  deleteThreshold: 55,
  sensitivity: 'STRICT' as const,
  strictness: 0.7,
};

const detector = new CommercialAdDetector();

function detect(text: string) {
  const context = createRuleDetectionContext({ text, settings: STRICT_SETTINGS });
  return detector.detect({
    normalizedText: context.normalizedText,
    rawLoweredText: context.rawLoweredText,
    settings: STRICT_SETTINGS,
    commercialCampaignContext: null,
  });
}

describe('commercial clause-local context', () => {
  it.each([
    'Не звоните на +7 900 123-45-67, они предлагают кредит онлайн без отказа и заявку, похоже развод',
    'Не пишите на +7 900 123-45-67: кредит онлайн без отказа, заявка, я не доверяю',
    'Мне звонили с +7 900 123-45-67 и предлагали кредит онлайн без отказа, заявку я не оставлял',
    'Проверяли +7 900 123-45-67? Кредит онлайн без отказа, заявка - это реклама или нет?',
    'Отзыв: по номеру +7 900 123-45-67 обещали кредит онлайн без отказа и заявку, но мне отказали',
    'Не открывайте 1xbet.com, этот сайт опасен',
    'Заблокируйте 1xbet.com, там казино',
    'В новости разобрали, почему 1xbet.com блокируют',
    'Ссылка 1xbet.com ведет на казино, не регистрируйтесь',
    'Как удалить рекламу 1xbet.com из браузера?',
    'Не переходите по ссылке на кредит онлайн без отказа и не оставляйте заявку, это мошенники',
    'В новости разобрали кредит онлайн без отказа. Телефон редакции +7 900 123-45-67',
    'На лекции разбирали кредит онлайн без отказа и заявки. По организационным вопросам звоните +7 900 123-45-67',
    'Мошенники пишут: получите кредит онлайн без отказа, оставьте заявку +7 900 123-45-67',
    'Мошенники пишут, получите кредит онлайн без отказа, оставьте заявку +7 900 123-45-67',
    'Осторожно, мошенники пишут, получите кредит онлайн без отказа, оставьте заявку +7 900 123-45-67',
    'Кредит онлайн без отказа обсуждали на встрече. Доставка мебели задерживается.',
    'Из личного опыта: кредит онлайн без отказа мне только обещали. Цена доставки мебели выросла.',
  ])('does not enforce a reported, negated, or editorial risk mention: %s', (text) => {
    expect(detect(text)).toBeNull();
  });

  it.each([
    'Мне отказали в кредите онлайн без отказа. Бонус сотрудникам выплатят, телефон бухгалтерии +7 900 123-45-67.',
    'В письме был кредит онлайн без отказа. Пишите отчет, вопросы по телефону +7 900 123-45-67.',
  ])('does not borrow unrelated adjacent evidence for risk escalation: %s', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain('locality:escalation-offer');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    [
      'Кредит онлайн без отказа. Оставьте заявку по номеру +7 900 123-45-67',
      'Осторожно, мошенники обманывают! А у нас кредит онлайн без отказа. Оставьте заявку по номеру +7 900 123-45-67',
    ],
    [
      'Получите займ без отказа онлайн, оставьте заявку +7 900 123-45-67',
      'Не верьте мошенникам. Получите займ без отказа онлайн, оставьте заявку +7 900 123-45-67',
    ],
    [
      'У нас честные крипто инвестиции: сигналы и доход в канале. Пишите +7 900 123-45-67',
      'Осторожно, мошенники! А у нас честные крипто инвестиции: сигналы и доход в канале. Пишите +7 900 123-45-67',
    ],
    [
      'Банк дарит бонус за оформление карты, ссылка https://example.com',
      'Осторожно, мошенники! Банк дарит бонус за оформление карты, ссылка https://example.com',
    ],
    [
      'Ремонт холодильников, звоните +7 900 123-45-67',
      'Осторожно, мошенники! Ремонт холодильников, звоните +7 900 123-45-67',
    ],
    [
      'У нас честный займ без отказа, пишите +7 900 123-45-67',
      'Кто покупал рекламу в канале? А у нас честный займ без отказа, пишите +7 900 123-45-67',
    ],
    [
      'Кредит онлайн без отказа, оставьте заявку +7 900 123-45-67',
      'Осторожно мошенники, у нас кредит онлайн без отказа, оставьте заявку +7 900 123-45-67',
    ],
    [
      'Получите кредит онлайн без отказа, оставьте заявку +7 900 123-45-67',
      'Осторожно мошенники, получите кредит онлайн без отказа, оставьте заявку +7 900 123-45-67',
    ],
    [
      'Наша компания выдаёт кредит онлайн без отказа, оставьте заявку +7 900 123-45-67',
      'Осторожно мошенники, наша компания выдаёт кредит онлайн без отказа, оставьте заявку +7 900 123-45-67',
    ],
    [
      'Я помогу получить кредит онлайн без отказа, оставьте заявку +7 900 123-45-67',
      'Осторожно мошенники, я помогу получить кредит онлайн без отказа, оставьте заявку +7 900 123-45-67',
    ],
  ])(
    'does not let an unrelated safe prefix hide an independent offer: %s -> %s',
    (baseline, prefixed) => {
      const baselineResult = detect(baseline);
      const prefixedResult = detect(prefixed);

      expect(baselineResult).not.toBeNull();
      expect(prefixedResult?.actionBand).toBe(baselineResult?.actionBand);
      expect(prefixedResult?.actionable).toBe(baselineResult?.actionable);
    },
  );

  it('does not split domains or decimal values while finding assertion boundaries', () => {
    expect(
      splitCommercialAssertions(
        'Цена 1.5 млн. Не открывайте 1xbet.com, сайт опасен. А у нас ремонт, звоните.',
      ),
    ).toEqual(['Цена 1.5 млн', 'Не открывайте 1xbet.com, сайт опасен', 'А у нас ремонт, звоните']);
  });

  it('keeps a shelter relocation narrative out of logistics moderation', () => {
    const text =
      'Приют Надежда ищет ответственную семью для своего подопечного. Ласковый, привит, готов к переезду в новый дом. Телефон волонтера +7 900 123-45-67.';
    const rawLoweredText = normalizeCommercialRawText(text);
    const state = collectCommercialSignals({
      normalizedText: normalizeCommercialText(rawLoweredText),
      rawLoweredText,
      profile: STRICT_PROFILE,
      commercialCampaignContext: null,
    });

    expect(state.negativeSignals).toContain('context:animal-adoption');
    expect(state.matchedSignals).not.toContain('service-specialty:logistics-delivery');
    expect(detect(text)).toBeNull();
  });

  it('does not treat a free logistics extra as animal adoption context', () => {
    const baseline = detect('Грузоперевозки, Газель, обращайтесь @cargo_help');
    const withFreeExtra = detect(
      'Грузоперевозки, Газель бесплатно к заказу, обращайтесь @cargo_help',
    );

    expect(baseline?.actionBand).toBe('WARN');
    expect(withFreeExtra?.actionBand).toBe(baseline?.actionBand);
    expect(withFreeExtra?.matchedSignals).toContain('service-specialty:moving-cargo-service');
  });

  it('keeps an independent service offer actionable without escalating a reported loan offer', () => {
    const serviceOffer = 'Ремонт холодильников, звоните +7 900 123-45-67';
    const mixed =
      'Не звоните мошенникам, они предлагают кредит без отказа. Отдельно: ремонт холодильников, звоните +7 900 123-45-67';
    const baseline = detect(serviceOffer);
    const result = detect(mixed);

    expect(baseline?.actionBand).toBe('WARN');
    expect(result?.actionBand).toBe(baseline?.actionBand);
    expect(result?.matchedSignals).toContain('risk:loan-leadgen');
    expect(result?.matchedSignals).not.toContain('locality:escalation-offer');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });
});
