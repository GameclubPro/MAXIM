import type { ChatSettings } from '../../prisma/prisma-client';
import { createRuleDetectionContext } from '../rule-engine-detection-context';
import { CommercialAdDetector } from './commercial-ad.detector';
import { isCommercialMessageDeleteEligible } from './commercial-action-policy';
import { hasCommercialSpamMarkers } from './commercial-features';
import { COMMERCIAL_OWNED_SERVICE_CONTRAST_COHORT } from './commercial-service-speech-act';

const PROFILES = [
  {
    commercialAdsSensitivity: 'BALANCED',
    commercialAdsWarnThreshold: 45,
    commercialAdsDeleteThreshold: 65,
  },
  {
    commercialAdsSensitivity: 'STRICT',
    commercialAdsWarnThreshold: 38,
    commercialAdsDeleteThreshold: 55,
  },
] as const;
const detector = new CommercialAdDetector();

function detect(
  text: string,
  profile: (typeof PROFILES)[number],
  promotedPolicyCohorts: readonly string[] = [],
) {
  const settings = { commercialAdsFilterEnabled: true, ...profile } as ChatSettings;
  return detector.detect({
    ...createRuleDetectionContext({ text, settings }),
    settings,
    promotedPolicyCohorts,
  });
}

function canCleanup(result: ReturnType<typeof detect>): boolean {
  return (
    !!result &&
    isCommercialMessageDeleteEligible(
      result.actionBand ?? null,
      result.actionable === true,
      result.messageDisposition,
    )
  );
}

describe('October commercial intent safety corrections', () => {
  it.each([
    'Я хочу заказать уборку квартиры. Оплачу 3000 рублей, звоните 8 900 000 10 42.',
    'Закажу уборку квартиры за 3000 рублей. Мой телефон 8 900 000 10 42.',
    'Буду заказывать уборку квартиры. Бюджет 3000 рублей, пишите 8 900 000 10 42.',
    'Куплю услуги электрика за 3000 рублей. Мой телефон 8 900 000 10 42.',
    'Услуги сантехника я не оказываю. Телефон 8 900 000 10 42.',
    'Ремонт холодильников не выполняю. Телефон 8 900 000 10 42.',
    'Я не сантехник. Сантехнические услуги не оказываю, телефон 8 900 000 10 42.',
    'Мастер обманул меня. Ремонт холодильников 2000 рублей, телефон 8 900 000 10 42. Никому не советую.',
    'Этот мастер мошенник, ремонт холодильников обещал за 2000 рублей. Его телефон 8 900 000 10 42.',
    'Жалоба на мастера. Ремонт холодильников 2000 рублей. Телефон 8 900 000 10 42.',
  ])('keeps author demand, refusal and third-party complaints: %s', (text) => {
    for (const profile of PROFILES) {
      for (const candidate of [
        text,
        text.replace('8 900 000 10 42', '[phone]'),
        `Добрый день, ${text}`,
      ]) {
        expect({ candidate, profile, cleanup: canCleanup(detect(candidate, profile)) }).toEqual({
          candidate,
          profile,
          cleanup: false,
        });
        expect(hasCommercialSpamMarkers(candidate)).toBe(false);
      }
    }
  });

  it.each([
    'Я оказываю услуги уборки квартиры. Цена 3000 рублей, звоните 8 900 000 10 42.',
    'Услуги сантехника. Принимаю заказы. Телефон 8 900 000 10 42.',
    'Ремонт холодильников выполняю. Цена 2000 рублей. Телефон 8 900 000 10 42.',
    'Мастер по ремонту холодильников. Выезд от 2000 рублей, телефон 8 900 000 10 42.',
    'Рекомендую наши услуги ремонта холодильников. Мы работаем с гарантией. Звоните 8 900 000 10 42.',
    'Мастер обманул меня. Отдельно: мы ремонтируем холодильники от 2000 рублей, звоните 8 900 000 10 42.',
  ])('retains paired source-side offers and independent offers after complaints: %s', (text) => {
    for (const profile of PROFILES) expect(canCleanup(detect(text, profile))).toBe(true);
  });

  it.each([
    'Я не занимаюсь ремонтом холодильников, но делаю натяжные потолки от 300 рублей за метр. Звоните 8 900 000 10 42.',
    'Ищу электрика, но предлагаю ремонт холодильников от 2000 рублей. Звоните 8 900 000 10 42.',
    'Не оказываем услуги электрика, только монтаж электропроводки за 2000 рублей, звоните 8 900 000 10 42.',
  ])('recognizes a contrast candidate without granting unpromoted cleanup: %s', (text) => {
    for (const profile of PROFILES) {
      for (const cohorts of [
        [],
        ['unrelated-cohort'],
        [COMMERCIAL_OWNED_SERVICE_CONTRAST_COHORT],
        [],
      ]) {
        const result = detect(text, profile, cohorts);
        expect(result?.requiredPolicyCohorts).toEqual([COMMERCIAL_OWNED_SERVICE_CONTRAST_COHORT]);
        const promoted = cohorts.includes(COMMERCIAL_OWNED_SERVICE_CONTRAST_COHORT);
        expect(canCleanup(result)).toBe(promoted);
        if (!promoted) {
          expect(result?.actionBand).toBe('REVIEW_ONLY');
          expect(result?.messageDisposition).toBe('KEEP');
          expect(result?.recordable).toBe(false);
          expect(result?.reasonCodes).toContain(
            `suppressed:unpromoted-policy:${COMMERCIAL_OWNED_SERVICE_CONTRAST_COHORT}`,
          );
        }
      }
    }
  });

  it.each([
    [
      'BЫКУП АBТОМОБИЛЕЙ в любом состоянии, расчёт на месте, звоните 8 900 000 10 42.',
      'ВЫКУП АВТОМОБИЛЕЙ в любом состоянии, расчёт на месте, звоните 8 900 000 10 42.',
    ],
    [
      'Билет в лотерею 200 рублей. ЛОТ С ПОBТОРОМ, оплата на карту 8 900 000 10 42.',
      'Билет в лотерею 200 рублей. ЛОТ С ПОВТОРОМ, оплата на карту 8 900 000 10 42.',
    ],
  ])(
    'maps uppercase visual letters before the production lowercase path: %s',
    (obfuscated, plain) => {
      for (const profile of PROFILES) {
        const original = detect(plain, profile);
        const result = detect(obfuscated, profile);
        expect(canCleanup(original)).toBe(true);
        expect(result?.actionBand).toBe(original?.actionBand);
        expect(result?.messageDisposition).toBe(original?.messageDisposition);
        expect(result?.matchedSignals).toEqual(original?.matchedSignals);
        expect(hasCommercialSpamMarkers(obfuscated)).toBe(hasCommercialSpamMarkers(plain));
      }
    },
  );
});
