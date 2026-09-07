import type { ChatSettings } from '../../prisma/prisma-client';
import { createRuleDetectionContext } from '../rule-engine-detection-context';
import { CommercialAdDetector } from './commercial-ad.detector';
import { resolveProfessionalRetailRecall } from './commercial-recall-patterns';

const SERVICE_CATALOG =
  'Предоставляю услуги в городе и ближайших районах: Мастер на час, мелкий ремонт и бытовые работы. Грузоперевозки легковым прицепом. Вывоз мусора. Сборка и установка корпусной мебели. Производство корпусной мебели на заказ. Производство окон. Работаю аккуратно, по договорённости. Звоните: PHONE';
const BULK_CROP_OFFER =
  'ЯЧМЕНЬ 1500 тонн (НДС). Натура 640, влага 13, сор 2. Погрузка маниту. ЛЕН КОРИЧНЕВЫЙ, отгрузка навалом, 500 тонн (без НДС). Сор до 3, влага 7-8, масло 45. Декларация готова. Ждем предложений по цене. PHONE (по телефону/MAX)';
const PROFILES = [
  {
    commercialAdsSensitivity: 'BALANCED',
    commercialAdsWarnThreshold: 59,
    commercialAdsDeleteThreshold: 81,
  },
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

function detect(text: string, profile: (typeof PROFILES)[number]) {
  const settings = { commercialAdsFilterEnabled: true, ...profile } as ChatSettings;
  return new CommercialAdDetector().detect({
    ...createRuleDetectionContext({ text, settings }),
    settings,
  });
}

describe('September production commercial regressions', () => {
  it.each([
    'Реклама. Продаётся АС-бочка. Марка автомобиля: ГАЗ-3307. Год выпуска: 1994. Объём цистерны: 4 куб. м. Цена: 430 000 руб. Торг. Автоцистерна предназначена для перевозки жидких бытовых отходов. Звоните [phone]',
    'Продаю телефоны Юг-2. Возможен обмен',
    'Сухой корм для кошек Royal Canin Gastrointestinal с проблемами пищеварения, диетический, 2 кг. Годен до 05.27. Категория: Дом и сад. Цена: 1710. Код: 1001 К. Остаток: 1 шт',
    'Продаются щенки Американской Акиты: мальчик и девочка. Возраст 5 месяцев, документы РКФ, привиты, без брака. Торг, рассрочка. Т [phone]',
  ])('does not restore old enforcement labels for ambiguous private-like inventory: %s', (text) => {
    expect(detect(text, PROFILES[1])?.actionable ?? false).toBe(false);
  });

  it.each(PROFILES)(
    'recognizes explicit catalogs in $commercialAdsSensitivity at $commercialAdsWarnThreshold',
    (profile) => {
      for (const template of [SERVICE_CATALOG, BULK_CROP_OFFER]) {
        for (const phone of ['+7 900 000 10 42', '8-900-000-10-42', '[phone]']) {
          const result = detect(template.replace('PHONE', phone), profile);
          expect(result?.actionable).toBe(true);
          expect(['WARN', 'DELETE']).toContain(result?.actionBand);
        }
      }
    },
  );

  it.each([
    'Подскажите мастера: мелкий ремонт, грузоперевозки, вывоз мусора. Мой телефон +7 900 000 10 42',
    'Сосед сделал мне мелкий ремонт, вывез мусор. Советую его, телефон +7 900 000 10 42',
    'Продам свою мебель после переезда, самовывоз. +7 900 000 10 42',
  ])('preserves requests, recommendations and private sales: %s', (text) => {
    for (const profile of PROFILES) {
      expect(detect(text, profile)?.actionable ?? false).toBe(false);
    }
  });

  it.each([
    'Куплю ячмень 1500 тонн с НДС. Погрузка маниту. Ждем предложений по цене. [phone]',
    'Новости: ячмень 1500 тонн с НДС, погрузка маниту. В статье приведен пример: продаем, телефон [phone]',
    'Не продаем ячмень 1500 тонн с НДС. Погрузка маниту. Ждем предложений по цене. [phone]',
    'Ячмень 1500 тонн с НДС. Погрузка маниту. Ждем предложений по цене.',
    'Продам ячмень 2 тонны, без НДС. Погрузка маниту. [phone]',
  ])('does not infer a bulk supplier without all independent anchors: %s', (text) => {
    expect(resolveProfessionalRetailRecall({ text: text.toLowerCase() })?.label).not.toBe(
      'bulk-crop-dispatch-offer',
    );
  });
});
