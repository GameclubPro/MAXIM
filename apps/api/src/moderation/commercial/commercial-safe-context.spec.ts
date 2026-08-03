import type { ChatSettings } from '../../prisma/prisma-client';
import type { CommercialCampaignContext } from '../commercial-campaign.util';
import type { CommercialThresholdProfile } from '../rule-engine-commercial-thresholds';
import { createRuleDetectionContext } from '../rule-engine-detection-context';
import { CommercialAdDetector } from './commercial-ad.detector';
import { collectCommercialSignals } from './commercial-features';
import { normalizeCommercialRawText, normalizeCommercialText } from './commercial-normalization';
import { deriveCommercialSafeContextBucket } from './commercial-safe-context';

const STRICT_PROFILE: CommercialThresholdProfile = {
  warnThreshold: 38,
  deleteThreshold: 55,
  sensitivity: 'STRICT',
  strictness: 0.7,
};

const STRICT_SETTINGS = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'STRICT',
  commercialAdsWarnThreshold: 38,
  commercialAdsDeleteThreshold: 55,
} as unknown as ChatSettings;

const REPEATED_CAMPAIGN_CONTEXT: CommercialCampaignContext = {
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
};

const detector = new CommercialAdDetector();

function collect(text: string, commercialCampaignContext?: CommercialCampaignContext | null) {
  const rawLoweredText = normalizeCommercialRawText(text.toLowerCase());
  return collectCommercialSignals({
    normalizedText: normalizeCommercialText(rawLoweredText),
    rawLoweredText,
    profile: STRICT_PROFILE,
    commercialCampaignContext,
  });
}

function detect(text: string, commercialCampaignContext?: CommercialCampaignContext | null) {
  const context = createRuleDetectionContext({ text, settings: STRICT_SETTINGS });
  return detector.detect({
    normalizedText: context.normalizedText,
    rawLoweredText: context.rawLoweredText,
    settings: STRICT_SETTINGS,
    commercialCampaignContext,
  });
}

describe('commercial public and object-condition safe contexts', () => {
  it('does not read apartment appliances plus cosmetic repair as an appliance-repair offer', () => {
    const text =
      '🌼 Продается 2-х квартира, очень теплая, 4 этаж. В ванной умещается стиральная машинка. Остается вся мебель, холодильник, телевизор. Требуется косметический ремонт. Вся информация по тел. [phone], пишите, звоните. Собственник, торг.';
    const state = collect(text, REPEATED_CAMPAIGN_CONTEXT);

    expect(state.hasPropertyPrivateContext).toBe(true);
    expect(state.matchedSignals).not.toContain('service-specialty:appliance-repair');
    expect(detect(text, REPEATED_CAMPAIGN_CONTEXT)).toBeNull();
  });

  it('preserves an explicit appliance-repair self-offer inside property wording', () => {
    const state = collect(
      'Продается квартира. Предлагаю ремонт холодильников на дому, диагностика и гарантия. Цена от 2000 руб., звоните +7 900 000 00 00.',
    );

    expect(state.hasPropertyPrivateContext).toBe(true);
    expect(state.matchedSignals).toContain('service-specialty:appliance-repair');
  });

  it('does not classify a provider service for a home as a private property sale', () => {
    const text =
      'Меня зовут Ольга, менеджер компании Ростелеком. Подключаем безлимитный интернет: оптоволокно прямо в дом. Видеонаблюдение для безопасности вашего дома, участка. Контролируйте дом или участок со смартфона. Мобильная связь за 300 руб. Уточнить тарифы и оставить заявку: звоните [phone].';
    const state = collect(text);

    expect(state.negativeSignals).toContain('private:property-sale');
    expect(state.matchedSignals).toContain('service-specialty:internet-connection-service');
    expect(
      deriveCommercialSafeContextBucket({
        text,
        matchedSignals: state.matchedSignals,
        negativeSignals: state.negativeSignals,
        hasCommercialHit: true,
      }),
    ).toBe('none');
  });

  it('keeps a heavily structured anonymous rental in review', () => {
    const text =
      'Сдается 1 комнатная квартира площадью 35 м² на 1/3 эт. дома. В комнате диван, шкаф и телевизор. В кухне гарнитур, холодильник, плита и микроволновая печь. В ванной комнате плитка и стиральная машина. Сдам на длительный срок порядочным жильцам. Арендная плата 18000 руб, залог 18000 руб. Все вопросы по телефону [phone]. Квартира полностью готова к проживанию, коммунальные услуги оплачиваются отдельно.';
    const result = detect(text);

    expect(result?.matchedSignals).toContain('property-agent:structured-rental-review');
    expect(result?.safeContextBucket).toBe('private_one_off_sale');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
  });

  it('keeps a private furnished rental in review when repair describes the apartment', () => {
    const text =
      'Сдам приятную, светлую квартиру, с хорошим ремонтом в Северске. Есть всё необходимое для жизни холодильник, стиральная машина, микроволновая печь, плита (при необходимости могу дать и посуду), маленький телевизор, вай-фай, диван (раскладывается и становится как большая кровать, если нужно могу дать и постельное бельё), можно въехать и сразу жить. Сдаю на длительный срок порядочным и чистоплотным людям. Без домашних животных. Стоимость 18000р + ком. услуги оплачиваться вами отдельно. Посмотреть можно в любое удобное для вас время, звоните и договоримся по номеру [phone]';
    const result = detect(text);

    expect(result?.matchedSignals).not.toContain('service-specialty:appliance-repair-self-offer');
    expect(result?.safeContextBucket).toBe('private_one_off_sale');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
  });

  it('warn-caps a structured construction offer without calling it a private sale', () => {
    const text =
      'Ремонт под ключ квартир и домов. Берем на себя все этапы ремонта. Опытные мастера, монтаж отопления, гарантия и прозрачная смета. Подпишитесь и получите скидку: [url] [phone].';
    const result = detect(text);

    expect(result?.matchedSignals).toContain('service-specialty:marketplace-construction-service');
    expect(result?.safeContextBucket).toBe('none');
    expect(result?.actionBand).toBe('WARN');
    expect(result?.suppressionReasons).toContain('bounded-recall-warn-cap');
  });

  it('does not treat professional doorstep retail delivery as a private measurement', () => {
    const text =
      'Продаём в Хабаровске: икра кеты малосолёная, цена 7000 руб. за кг; кета потрошёная, цена 500 руб. за кг. Доставка по Хабаровску до подъезда бесплатно, пишите или звоните +7 900 000 00 02.';
    const state = collect(text);
    const result = detect(text);

    expect(state.negativeSignals).not.toContain('private-goods:measurements');
    expect(state.matchedSignals).toContain('goods-retail:professional-retail-structure');
    expect(result?.safeContextBucket).toBe('none');
    expect(['WARN', 'DELETE']).toContain(result?.actionBand);
  });

  it('keeps a repeated used-goods listing non-actionable beside retail recall evidence', () => {
    const text =
      'Школьные вещи на девочку и мальчика в отличном состоянии. Рюкзаки по 300 руб., учебники по 500 руб. Звоните +7 900 000 00 03.';
    const result = detect(text, REPEATED_CAMPAIGN_CONTEXT);

    expect(result?.negativeSignals).toContain('private-goods:resale-condition');
    expect(result?.matchedSignals).toContain('goods-retail:professional-retail-structure');
    expect(result?.safeContextBucket).toBe('private_one_off_sale');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
    expect(result?.suppressionReasons).toContain('safe-context:private_one_off_sale');
  });

  it('does not hide a construction crew service offer as ordinary job seeking', () => {
    const text =
      'Строительная бригада ищет работы. Строим дома, бани и беседки под ключ, ремонтируем кровлю и фасады. Пенсионерам скидка, звоните +7 900 000 00 04.';
    const state = collect(text);
    const result = detect(text);

    expect(state.negativeSignals).toContain('job-seeking:job-seeking:search');
    expect(state.matchedSignals).toContain('service-specialty:construction-crew-self-offer');
    expect(result?.safeContextBucket).toBe('none');
    expect(result?.actionBand).toBe('WARN');
  });

  it('keeps a repeated contractor request non-actionable despite campaign retail recall', () => {
    const text =
      'Ищу мастера по поклейке обоев\nОбъем: 9 рулонов\nБюджет: 3 500 руб. за весь объем\nКонтакты: [phone]';
    const state = collect(text, REPEATED_CAMPAIGN_CONTEXT);

    expect(state.negativeSignals).toEqual(
      expect.arrayContaining(['search:ищу маст', 'search-pattern:request:specialist']),
    );
    expect(state.matchedSignals).toContain('recall-cap:warn:professional-retail-structure');
    expect(state.matchedSignals).not.toContain('combo:intent+deal');
    expect(state.matchedSignals).not.toContain('combo:campaign+self-promo');
    expect(detect(text, REPEATED_CAMPAIGN_CONTEXT)).toBeNull();
  });

  it.each([
    'Сегодня обсуждали ремонт фасада. Телефон подрядчика +7 900 123-45-67.',
    'Ремонт кровли запланирован на август. Телефон подрядчика +7 900 123-45-67.',
    'Ремонт дома идет по графику. Телефон диспетчера +7 900 123-45-67.',
    'Ремонт холодильника уже завершен. Телефон мастера +7 900 123-45-67.',
    'Городские службы ведут ремонт кровли. Телефон диспетчера +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'Городские службы начали ремонт фасада. Телефон диспетчера +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'Городские службы приступили к ремонту дороги. Телефон диспетчера +7 900 123-45-67. Подписаться | Предложить новость [url].',
  ])('does not turn an informational service contact into campaign self-promotion: %s', (text) => {
    const result = detect(text, REPEATED_CAMPAIGN_CONTEXT);

    expect(['ALLOW', 'REVIEW_ONLY']).toContain(result?.actionBand ?? 'ALLOW');
  });

  it('does not let apparel sizing hide nationwide retail order flow', () => {
    const text =
      'Футболка турецкая, люкс качество, размер от 58 до 62. Доставка по всей России транспортной компанией, пишите в личку или звоните +7 900 000 00 05.';
    const state = collect(text);
    const result = detect(text);

    expect(state.negativeSignals).toContain('private-goods:apparel-size');
    expect(state.matchedSignals).toContain('goods-retail:apparel-retail-order-flow');
    expect(result?.safeContextBucket).toBe('none');
    expect(result?.actionable).toBe(true);
  });

  it('keeps a single private apparel listing safe despite nationwide delivery', () => {
    const text =
      'Продам новое платье, размер 46. Отправка транспортной компанией по России, цена 5000 руб., телефон +7 900 000 00 06.';
    const state = collect(text);
    const result = detect(text);

    expect(state.negativeSignals).toContain('private-goods:apparel-size');
    expect(state.matchedSignals).toContain('goods-retail:apparel-retail-order-flow');
    expect(result?.safeContextBucket).toBe('private_one_off_sale');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
    expect(result?.actionable).toBe(false);
  });

  it('does not treat one merchandising phrase as professional fulfillment', () => {
    const text =
      'Продам новое платье, размер 46, фабричное качество. Цена 5000 руб., телефон +7 900 000 00 10.';
    const state = collect(text);
    const result = detect(text);

    expect(state.negativeSignals).toContain('private-goods:apparel-size');
    expect(state.matchedSignals).toContain('goods-retail:apparel-retail-order-flow');
    expect(result?.safeContextBucket).toBe('private_one_off_sale');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
    expect(result?.actionable).toBe(false);
  });

  it('keeps professional apparel retail actionable when the seller says продаю', () => {
    const text =
      'Продаю турецкие футболки, люкс качество, размер от 48 до 62. Доставка по России, цена 2500 руб., телефон +7 900 000 00 08.';
    const state = collect(text);
    const result = detect(text);

    expect(state.matchedSignals).toContain('intent:продаю');
    expect(state.matchedSignals).toContain('goods-retail:apparel-retail-order-flow');
    expect(state.negativeSignals).toContain('private-goods:apparel-size');
    expect(result?.safeContextBucket).toBe('none');
    expect(result?.actionable).toBe(true);
  });

  it('keeps a gifted unworn apparel listing private despite retail wording', () => {
    const text =
      'Продается новое платье, размер 46, подарили, но не ношу. Люкс качество, доставка по России транспортной компанией, цена 5000 руб., телефон +7 900 000 00 09.';
    const state = collect(text);
    const result = detect(text);

    expect(state.negativeSignals).toEqual(
      expect.arrayContaining([
        'private-goods:apparel-size',
        'private-goods:private-apparel-personal-narrative',
      ]),
    );
    expect(state.matchedSignals).toContain('goods-retail:apparel-retail-order-flow');
    expect(result?.safeContextBucket).toBe('private_one_off_sale');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
    expect(result?.actionable).toBe(false);
  });

  it('keeps non-escalation marketplace wording inside an explicit used sale', () => {
    const text =
      'Продам свой диван б/у. На Авито есть карточка товара, цена 10000 руб., телефон +7 900 000 00 07.';
    const state = collect(text);
    const result = detect(text);

    expect(state.negativeSignals).toEqual(
      expect.arrayContaining(['private:б/у', 'private-goods:furniture-single']),
    );
    expect(state.matchedSignals).toContain('risk:marketplace-seller');
    expect(result?.hasEscalationRiskEvidence).toBe(false);
    expect(result?.safeContextBucket).toBe('private_one_off_sale');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
    expect(result?.actionable).toBe(false);
  });

  it('keeps an independent service offer actionable beside a fraud warning', () => {
    const text =
      'Осторожно: мошенники предлагают кредит без отказа. Не переводите им деньги. Отдельно: ремонт холодильников, цена 2000 руб., звоните +7 900 123-45-67.';
    const result = detect(text);

    expect(result?.safeContextBucket).toBe('spam_complaint_or_fraud_warning');
    expect(result?.matchedSignals).toContain('risk:loan-leadgen');
    expect(result?.matchedSignals).not.toContain('locality:escalation-offer');
    expect(result?.actionBand).toBe('WARN');
    expect(result?.actionable).toBe(true);
    expect(result?.suppressionReasons).toContain('non-local-escalation-offer');
  });

  it('keeps a repeated custom-forging offer at warn', () => {
    const text =
      'Кованая роза, цена 700 рублей за штуку. Могу изготовить букеты в любом количестве, по вопросам обращаться в лс.';
    const result = detect(text, REPEATED_CAMPAIGN_CONTEXT);

    expect(result?.matchedSignals).toContain('service-specialty:custom-forged-flower');
    expect(result?.matchedSignals).not.toContain('goods-retail:structured-retail-review');
    expect(result?.actionBand).toBe('WARN');
  });

  it('allows a repeated free community exercise invitation', () => {
    const text =
      '🎉 Приглашаю на утреннюю зарядку! 🎉 Завтра в 8:30 вместе встретим день с пользой. Легкий комплекс упражнений поможет проснуться. Присоединяйтесь, будет здорово! #зарядка #ЗОЖ';
    const state = collect(text, REPEATED_CAMPAIGN_CONTEXT);

    expect(state.negativeSignals).toContain('context:public-training-or-event');
    expect(
      deriveCommercialSafeContextBucket({
        text,
        matchedSignals: state.matchedSignals,
        negativeSignals: state.negativeSignals,
        hasCommercialHit: true,
      }),
    ).toBe('public_training_or_help');
    expect(detect(text, REPEATED_CAMPAIGN_CONTEXT)).toBeNull();
  });

  it('does not hide a paid community exercise offer', () => {
    const text =
      'Фитнес-студия приглашает на утреннюю зарядку. Стоимость занятия 500 руб., запись по телефону +7 900 000 00 01.';
    const state = collect(text);

    expect(state.negativeSignals).not.toContain('context:public-training-or-event');
    expect(detect(text)).not.toBeNull();
  });

  it.each([
    [
      'animal boarding collection',
      'ПОМОГИТЕ ОПЛАТИТЬ ПЕРЕДЕРЖКУ для спасенной собаки Юны. Стоимость передержки 7500 руб. в месяц. Сбор на Сбербанк с пометкой "Юна пожертвование" по номеру [phone].',
      'public_training_or_help',
    ],
    [
      'shelter treatment debt collection',
      'В приюте остаются 84 собаки и 27 кошек. У приюта накопился долг перед клиникой за лечение животных и корм. МЫ ОЧЕНЬ ПРОСИМ ПОМОЩИ. Нужно закрыть долг, реквизиты для пожертвований: Сбербанк, перевод по номеру [phone].',
      'public_training_or_help',
    ],
    [
      'long-form local incident report',
      'Смерч повредил бетонные ограждения и кровлю нескольких домов, сообщили очевидцы. Городские службы начали устранять последствия. На время ремонта опасный участок огородили. Специалисты обследовали поврежденные конструкции, убрали упавшие ветки, восстановили электроснабжение и проверили опоры. После завершения обследования доступ откроют в обычном режиме. Пострадавших нет, обстановка находится под контролем. Подписаться | Предложить новость [url] [url]',
      'news_or_analytics',
    ],
  ])('derives a safe context for an audited %s', (_label, text, bucket) => {
    const state = collect(text);

    expect(state.negativeSignals).toContain(
      bucket === 'news_or_analytics'
        ? 'context:local-news-subscribe'
        : 'context:public-help-request',
    );
    expect(
      deriveCommercialSafeContextBucket({
        text,
        matchedSignals: state.matchedSignals,
        negativeSignals: state.negativeSignals,
        hasCommercialHit: true,
      }),
    ).toBe(bucket);
    expect(['ALLOW', 'REVIEW_ONLY']).toContain(detect(text)?.actionBand ?? 'ALLOW');
  });

  it('does not hide breeder retail behind charity wording', () => {
    const text =
      'Питомник предлагает породистого щенка. Щенок ищет семью, цена 50 000 руб., открыта бронь. Телефон [phone]. Просим помочь оплатить передержку переводом по номеру [phone].';
    const state = collect(text);
    const result = detect(text);

    expect(state.negativeSignals).not.toContain('context:public-help-request');
    expect(result?.safeContextBucket).toBe('none');
    expect(['WARN', 'DELETE', 'DELETE_AND_ESCALATE']).toContain(result?.actionBand);
  });

  it.each([
    'Нужна помощь питомцу? Ветеринарная клиника проводит лечение и операции. Запись по номеру [phone], стоимость 2000 руб.',
    'Компания предлагает передержку собак с ежедневным уходом. Стоимость 1500 руб. в сутки, запись по номеру [phone].',
  ])('requires a donation anchor before suppressing a paid animal service: %s', (text) => {
    const state = collect(text);
    const result = detect(text);

    expect(state.negativeSignals).not.toContain('context:public-help-request');
    expect(result).not.toBeNull();
    expect(result?.safeContextBucket).toBe('none');
    expect(['WARN', 'DELETE']).toContain(result?.actionBand);
  });

  it('does not derive editorial safety from a service CTA with a copied news footer', () => {
    const text =
      'СТРОИТЕЛЬНАЯ БРИГАДА: кровля, фасады и ремонт квартир под ключ. Пенсионерам скидка 15%, звоните [phone]. Компания сообщила, что городские службы рекомендуют наш сервис. Подписаться | Предложить новость [url].';
    const state = collect(text);

    expect(state.matchedSignals).toContain('intent:строительная-бригада');
    expect(state.negativeSignals).not.toContain('context:local-news-subscribe');
  });

  it('does not derive editorial safety from a structured service offer with a phone', () => {
    const text =
      'Компания СтройПроф выполняет ремонт кровли и фасадов. Телефон +7 900 123-45-67. Подписаться | Предложить новость [url].';
    const state = collect(text);
    const result = detect(text);

    expect(state.matchedSignals).toContain('intent:выполняем-работы');
    expect(state.matchedSignals).toContain('contact:phone');
    expect(state.negativeSignals).not.toContain('context:local-news-subscribe');
    expect(result).not.toBeNull();
  });

  it.each([
    'Администрация сообщила, что подрядчик выполняет ремонт кровли и фасадов. Телефон диспетчера +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'МЧС сообщило, что оперативный штаб выполняет восстановительные работы. Телефон штаба +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'Власти сообщили, что подрядчик выполняет ремонт кровли и фасадов. Номер подрядчика +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'Городские службы рассказали, что подрядчик выполняет ремонт фасадов. Телефон подрядной организации +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'Администрация сообщает, что подрядчик выполняет ремонт кровли. Телефон подрядчика +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'Городские службы выполняют ремонт кровли и фасадов. Телефон диспетчера +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'Администрация сообщает, что подрядчик выполняет ремонт кровли. По вопросам звоните на горячую линию +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'Администрация сообщает, что подрядчик выполняет ремонт кровли, по вопросам звоните на горячую линию +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'Городские службы ведут ремонт кровли. По вопросам звоните диспетчеру +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'Городские службы проводят работы по ремонту фасада. Телефон диспетчера +7 900 123-45-67. Подписаться | Предложить новость [url].',
  ])('keeps an attributed public-service report editorial: %s', (text) => {
    const state = collect(text);
    const result = detect(text);

    expect(state.negativeSignals).toContain('context:local-news-subscribe');
    expect(['ALLOW', 'REVIEW_ONLY']).toContain(result?.actionBand ?? 'ALLOW');
  });

  it.each([
    'Мы подрядчик администрации: выполняем ремонт квартир и кровли. Телефон диспетчера +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'Компания СтройПроф выполняет ремонт квартир и кровли. Телефон диспетчера +7 900 123-45-67. Городские службы сообщили о завершении работ. Подписаться | Предложить новость [url].',
  ])('does not join unrelated official wording to hide a service advertisement: %s', (text) => {
    const state = collect(text);
    const result = detect(text);

    expect(state.negativeSignals).not.toContain('context:local-news-subscribe');
    expect(result).not.toBeNull();
    expect(['WARN', 'DELETE']).toContain(result?.actionBand);
  });

  it.each([
    [
      'humanitarian aid',
      'Мы обращаемся к жителям за гуманитарной и материальной помощью для наших ребят. Нужны медикаменты и теплые вещи; гуманитарную помощь можно приносить в ДК.',
      'context:public-help-request',
      'public_training_or_help',
    ],
    [
      'fire donation appeal',
      'В нашей семье произошел пожар, дом и все имущество уничтожены. Кто чем может помочь, любая помощь важна. Помощь погорельцам: [phone].',
      'context:public-help-request',
      'public_training_or_help',
    ],
    [
      'long public scam warning',
      'Сейчас массово применяют новую схему мошенничества, ориентированную на детей и подростков. Им звонят под видом сотрудников ФСБ или МВД. Поговорите со своими детьми и объясните, что силовые структуры никогда не вовлекают детей в операции.',
      'context:public-fraud-warning',
      'spam_complaint_or_fraud_warning',
    ],
    [
      'pet giveaway',
      'Возможно, ваш ребенок мечтал о котенке. Спасенная кошка родила котят, все игривые и ласковые. Пишите в лс.',
      'context:animal-adoption',
      'request_or_recommendation',
    ],
    [
      'fuel news analysis',
      'Правительство разрешило выпускать топливо класса К5 с характеристиками Евро-3. Что изменилось: выросло содержание серы и присадок. Чем это грозит автомобилю: износом двигателя и катализатора.',
      'context:fuel-availability-report',
      'news_or_analytics',
    ],
  ])('derives a safe context for %s', (_label, text, negativeSignal, bucket) => {
    const state = collect(text);

    expect(state.negativeSignals).toContain(negativeSignal);
    expect(
      deriveCommercialSafeContextBucket({
        text,
        matchedSignals: state.matchedSignals,
        negativeSignals: state.negativeSignals,
        hasCommercialHit: true,
      }),
    ).toBe(bucket);
  });
});
