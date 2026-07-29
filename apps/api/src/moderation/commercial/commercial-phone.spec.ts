import type { ChatSettings } from '../../prisma/prisma-client';
import { createRuleDetectionContext } from '../rule-engine-detection-context';
import { CommercialAdDetector } from './commercial-ad.detector';
import {
  hasCommercialPhoneLikeText,
  normalizeCommercialPhoneConfusables,
  replaceCommercialPhoneLikeText,
} from './commercial-phone';

const STRICT_SETTINGS = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'STRICT',
  commercialAdsWarnThreshold: 38,
  commercialAdsDeleteThreshold: 55,
} as unknown as ChatSettings;

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

describe('commercial phone matching', () => {
  it.each([
    ['+7 900 123 45 67', '+7 900 123 45 67'],
    ['+7 9O0 123 45 67', '+7 900 123 45 67'],
    ['+7 9О0 123 45 67', '+7 900 123 45 67'],
  ])('normalizes confusable zeroes only in a full phone-like span', (input, expected) => {
    expect(normalizeCommercialPhoneConfusables(input)).toBe(expected);
  });

  it.each([
    'Телефон 999.123.45.67',
    'Связь +1 (415) 555-2671',
    'Связь +1 4O5 555 2671',
    'Телефон +44 7О11 123456',
    'По поводу заказа пишите по номеру 8️⃣9️⃣8️⃣9️⃣8️⃣8️⃣8️⃣2️⃣0️⃣8️⃣9️⃣',
    'Связь +7🟢999🟢123🟢45🟢67',
    'Тел. 8•999•123•45•67',
    'Тел. 12-34-56',
    'Иркутск, 89148907923',
  ])('recognizes a bounded contact number family: %s', (text) => {
    expect(hasCommercialPhoneLikeText(text)).toBe(true);
    expect(replaceCommercialPhoneLikeText(text)).toContain('[phone]');
  });

  it.each([
    'Ozon заказ 9O0 уже выдан',
    'Заказ 1234567890 уже выдан',
    'Заказ 71234567890 уже выдан',
    'Маркировка 999.123.45.67 относится к партии',
    'Размеры коробки 12-34-56 см',
    'Адрес сети 192.168.10.20',
    'ИНН 770 708 38 93',
    'СНИЛС 123 456 789 00',
    'Код заказа 123 456 78 90',
    'Код заказа 7 900 123 45 67, услуги уже оплачены',
    'Маркировка 8 999 123 45 67 относится к партии',
  ])('preserves an ambiguous non-contact value: %s', (text) => {
    expect(hasCommercialPhoneLikeText(text)).toBe(false);
    expect(replaceCommercialPhoneLikeText(text)).toBe(text);
    expect(normalizeCommercialPhoneConfusables(text)).toBe(text);
  });

  it('keeps service decisions stable across phone homoglyphs', () => {
    const baseline = detect('ГРУЗОПЕРЕВОЗКИ +7 900 123 45 67');

    expect(baseline).not.toBeNull();
    expect(detect('ГРУЗОПЕРЕВОЗКИ +7 9O0 123 45 67')?.actionBand).toBe(baseline?.actionBand);
    expect(detect('ГРУЗОПЕРЕВОЗКИ +7 9О0 123 45 67')?.actionBand).toBe(baseline?.actionBand);
  });

  it('feeds production phone shapes into bounded property recall', () => {
    const raw = detect('ЖК МЕЧТА 36,1м 7 этаж Вся в ДКП Цена 4 900 000 Иркутск, 89148907923 Илона');
    const placeholder = detect(
      'ЖК МЕЧТА 36,1м 7 этаж Вся в ДКП Цена 4 900 000 Телефон [phone] Илона',
    );

    expect(raw?.matchedSignals).toContain('property-agent:property-professional-spec');
    expect(raw?.actionBand).toBe(placeholder?.actionBand);
  });

  it('keeps a professional property card without a literal price label', () => {
    const result = detect('ЖК МЕЧТА 36,1м 7 этаж Вся в ДКП 4 900 000 ₽ Иркутск, 89148907923 Илона');

    expect(result?.matchedSignals).toContain('property-agent:property-professional-spec');
    expect(result?.actionBand).toBe('WARN');
  });

  it('does not promote a private shorthand property card only because its raw phone is recognized', () => {
    const result = detect(
      'КМР, ул. Лавочкина. Монолит кирпич, 7/7 эт. 1 к.кв. 35 м2, ремонт, мебель. 3 450 000 ₽, вся сумма в ДКП. Елена +7 900 000 00 67. Звоните, на смс долго отвечаю.',
    );

    expect(result).toBeNull();
  });

  it('recognizes an explicitly contextual short local service number', () => {
    const result = detect('Услуги сантехника, тел. 12-34-56');

    expect(result?.matchedSignals).toContain('contact:phone');
    expect(result?.actionBand).toBe('WARN');
  });

  it('does not turn a formatted tax identifier into commercial contact evidence', () => {
    const result = detect('ИНН 770 708 38 93, стоимость услуги указана в акте');

    expect(result).toBeNull();
  });

  it.each([
    'Код заказа 7 900 123 45 67, услуги уже оплачены',
    'Маркировка 8 999 123 45 67 относится к партии',
  ])('does not feed a formatted identifier tail into contact evidence: %s', (text) => {
    expect(detect(text)?.matchedSignals ?? []).not.toContain('contact:phone');
  });
});
