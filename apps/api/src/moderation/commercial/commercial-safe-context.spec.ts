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

    expect(result?.matchedSignals).not.toContain(
      'service-specialty:appliance-repair-self-offer',
    );
    expect(result?.safeContextBucket).toBe('private_one_off_sale');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
  });

  it('warn-caps a structured construction offer without calling it a private sale', () => {
    const text =
      'Ремонт под ключ квартир и домов. Берем на себя все этапы ремонта. Опытные мастера, монтаж отопления, гарантия и прозрачная смета. Подпишитесь и получите скидку: [url] [phone].';
    const result = detect(text);

    expect(result?.matchedSignals).toContain(
      'service-specialty:marketplace-construction-service',
    );
    expect(result?.safeContextBucket).toBe('none');
    expect(result?.actionBand).toBe('WARN');
    expect(result?.suppressionReasons).toContain('bounded-recall-warn-cap');
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
