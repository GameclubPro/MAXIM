import type { ChatSettings } from '../../prisma/prisma-client';
import { createRuleDetectionContext } from '../rule-engine-detection-context';
import { CommercialAdDetector } from './commercial-ad.detector';
import { resolveProfessionalRetailRecall } from './commercial-recall-patterns';
import { hasCommercialSpamMarkers } from './commercial-features';

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
  const protectedAuditCases = [
    'Продам соковыжималку рабочая. При переезде утеряна деталь на фото. Цена 500 рублей. Пишите в личку.',
    'Продам раму на УАЗ 3303 бортовой. Целая без сварки. Цена 40000. +7 900 000 10 42',
    'Мой компьютер уже старенький. Мастер мне сегодня его восстановил, теперь работает как новый. Всем рекомендую этого молодого человека, вот его номер +7 900 000 10 42, сохраните обязательно.',
    'Срочно нужна машина: грузоперевозки или машина с прицепом. Из города в посёлок. Звонить +7 900 000 10 42',
    'Нужно 2 места на завтра, желательно с утра из города в посёлок. +7 900 000 10 42',
    'Нужно такси. Мой телефон +7 900 000 10 42',
  ];

  it.each(protectedAuditCases)(
    'protects September audit requests and personal experience: %s',
    (text) => {
      expect(hasCommercialSpamMarkers(text)).toBe(false);
      for (const profile of PROFILES) {
        expect(detect(text, profile)?.actionable ?? false).toBe(false);
        expect(
          detect(text.replace('+7 900 000 10 42', '[phone]'), profile)?.actionable ?? false,
        ).toBe(false);
      }
    },
  );

  it.each([
    'Такси +7 900 000 10 42',
    'Такси [phone]',
    'Асфальтирование +7 900 000 10 42',
    'Асфальтирование [phone]',
    'Мы предлагаем грузоперевозки, свои машины и прицепы. Звонить +7 900 000 10 42',
    'СТРОИТЕЛЬНАЯ БРИГАДА. Все виды работ: кровля, фасады, ремонт квартир, фундамент, сантехника, электрика, заборы. Ремонт под ключ. Работаем со своим стройматериалом. Скидка 15%. Звоните: +7 900 000 10 42',
    'Стоимость нанесения ППУ составляет 1200 рублей за квадратный метр. ППУ подходит для кровли и ремонта квартир. Свяжитесь с нами по телефону +7 900 000 10 42',
    'ВЫКУП АВТОМОБИЛЕЙ В ЛЮБОМ СОСТОЯНИИ. Куплю ваш автомобиль после ДТП, не на ходу. Возможен обмен. Быстрый расчёт на месте наличными. Работаем 24 на 7 89000001042',
    'Ведём закупку с/х продукции у сельхозпроизводителей: пшеница, кукуруза, ячмень, подсолнечник. Форма оплаты: безнал, с НДС и без НДС. Самовывоз. +7 900 000 10 42',
  ])('recognizes explicit September audit offers without lowering thresholds: %s', (text) => {
    for (const profile of PROFILES.slice(1)) {
      expect(detect(text, profile)?.actionable).toBe(true);
      expect(hasCommercialSpamMarkers(text)).toBe(true);
    }
  });

  it('does not interpret a quality slogan as a private-sale assertion', () => {
    const text =
      'ДОРОЖНЫЕ РАБОТЫ. Асфальтирование дорог, установка бордюров, благоустройство. Собственная техника, опытная бригада. Работаем по договору, предоставляем гарантию. Звоните +7 900 000 10 42. Работаем как для себя!';
    for (const profile of PROFILES.slice(1)) {
      const baseline = detect(text, profile);
      expect(baseline?.actionable).toBe(true);
      expect(baseline?.actionBand).toBe(
        detect(text.replace('как для себя', 'качественно'), profile)?.actionBand,
      );
    }
  });

  it.each([
    'Продам соковыжималку рабочая. При переезде утеряна деталь. Цена 500 рублей. Пишите в личку.',
    'Мастер мне восстановил компьютер, рекомендую его. Телефон +7 900 000 10 42',
    'Нужно 2 места на завтра. Мой телефон +7 900 000 10 42',
  ])('keeps protected text non-actionable even with repeated campaign evidence: %s', (text) => {
    for (const profile of PROFILES) {
      const settings = { commercialAdsFilterEnabled: true, ...profile } as ChatSettings;
      const result = new CommercialAdDetector().detect({
        ...createRuleDetectionContext({ text, settings }),
        settings,
        commercialCampaignContext: {
          senderDistinctChatCount: 6,
          sameTextDistinctChatCount: 4,
          repeatedPhoneDistinctChatCount: 4,
          repeatedLinkDistinctChatCount: 0,
        },
      });
      expect(result?.actionable ?? false).toBe(false);
    }
  });

  it.each([
    'Куплю ячмень для своего хозяйства. Телефон +7 900 000 10 42',
    'Ищу перевозчика для пшеницы и кукурузы. Безнал с НДС. Самовывоз. +7 900 000 10 42',
    'В статье цитируют: «Ведём закупку с/х продукции у сельхозпроизводителей: пшеница, кукуруза, ячмень. Безнал с НДС. Самовывоз. +7 900 000 10 42». Это цитата, не предложение.',
  ])('does not treat private demand or quoted procurement as a professional offer: %s', (text) => {
    expect(detect(text, PROFILES[1])?.actionable ?? false).toBe(false);
  });

  it.each([
    'Такси PHONE',
    'Асфальтирование PHONE',
    'Продам диплом без обучения и экзаменов. PHONE',
    'В статье приводят пример: «Продам диплом без обучения, PHONE». Это цитата, не предложение.',
  ])('does not grant extra enforcement solely to a phone placeholder: %s', (template) => {
    const original = detect(template.replace('PHONE', '+7 900 000 10 42'), PROFILES[1]);
    const sanitized = detect(template.replace('PHONE', '[phone]'), PROFILES[1]);
    expect(sanitized?.actionBand ?? null).toBe(original?.actionBand ?? null);
  });

  it('preserves an independent retail offer after a transport request', () => {
    const text =
      'Нужно такси. Мой телефон +7 900 000 10 42. Отдельно: мы продаем стройматериалы оптом, широкий ассортимент. Доставка по городу, заказывайте по телефону +7 900 000 10 43';
    expect(detect(text, PROFILES[1])?.actionable).toBe(true);
    expect(hasCommercialSpamMarkers(text)).toBe(true);
  });

  it.each(protectedAuditCases.slice(2))(
    'does not hide an independent offer after a protected assertion: %s',
    (text) => {
      const mixed = `${text}\nОтдельно: мы предлагаем грузоперевозки. Своя Газель, услуги грузчиков, работаем ежедневно. Заказы по телефону +7 900 000 10 43`;
      expect(detect(mixed, PROFILES[1])?.actionable).toBe(true);
      expect(hasCommercialSpamMarkers(mixed)).toBe(true);
    },
  );

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
