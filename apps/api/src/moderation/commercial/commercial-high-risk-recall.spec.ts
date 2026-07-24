import type { ChatSettings } from '../../prisma/prisma-client';
import type { CommercialCampaignContext } from '../commercial-campaign.util';
import { createRuleDetectionContext } from '../rule-engine-detection-context';
import { CommercialAdDetector } from './commercial-ad.detector';
import { collectCommercialHighRiskRecallHits } from './commercial-high-risk-recall';
import { ADS_GOODS_RETAIL_PATTERNS, ADS_PROPERTY_PRIVATE_PATTERNS } from './commercial-patterns';

const BASE_SETTINGS = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'STRICT',
  commercialAdsWarnThreshold: 38,
  commercialAdsDeleteThreshold: 55,
} as unknown as ChatSettings;

const STRONG_CAMPAIGN_CONTEXT: CommercialCampaignContext = {
  senderDistinctChatCount: 5,
  sameTextDistinctChatCount: 5,
  repeatedPhoneDistinctChatCount: 5,
  repeatedLinkDistinctChatCount: 5,
  nearTextDistinctChatCount: 5,
  repeatedDomainDistinctChatCount: 76,
  repeatedHandleDistinctChatCount: 0,
  senderDistinctChatCount5m: 3,
  senderDistinctChatCount30m: 5,
  senderDistinctChatCount120m: 5,
};

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

describe('bounded high-risk commercial recall', () => {
  it.each([
    {
      label: 'medicine price catalog',
      ruleLabel: 'medicine-price-catalog',
      cap: 'review',
      actionBand: 'REVIEW_ONLY',
      text: 'пикамилон 250. Топизофам 200 Тералиджен 550 Остальные по 200',
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 49,
        commercialAdsDeleteThreshold: 69,
      },
    },
    {
      label: 'personal mortgage lead generation',
      ruleLabel: 'mortgage-leadgen',
      cap: 'warn',
      actionBand: 'WARN',
      text: 'ПОМОГУ получить ипотеку 2% на строительство, Без ПВ и земельного участка. Лимит на ипотеку заканчивается, поэтому рекомендую не медлить . Писать или звонить на ☎ [phone]',
      settings: {
        commercialAdsSensitivity: 'STRICT',
        commercialAdsWarnThreshold: 38,
        commercialAdsDeleteThreshold: 55,
      },
    },
    {
      label: 'long divination service offer',
      ruleLabel: 'divination-contact-offer',
      cap: 'warn',
      actionBand: 'WARN',
      text: '⚡️ Любовь Григорьевна ⚡️ 👑 Потомственная гадалка с феноменальным даром 💼 Бизнес — снимаю преграды к успеху 💕 Возвращаю любимых и тепло 🔮 Полная диагностика будущего 🤍 Индивидуально, с душой, конфиденциально 🤍 Дар передан по роду 📲 [phone] ⏳ Отвечаю в течение часа! 💬 Добавьте в контакты 🙏 ✨ Потомственный дар. Веками проверен.',
      settings: {
        commercialAdsSensitivity: 'STRICT',
        commercialAdsWarnThreshold: 38,
        commercialAdsDeleteThreshold: 55,
      },
      commercialCampaignContext: STRONG_CAMPAIGN_CONTEXT,
    },
    {
      label: 'handmade health product claims',
      ruleLabel: 'handmade-health-claims',
      cap: 'review',
      actionBand: 'REVIEW_ONLY',
      text: 'Мыло ручной работы на основе жира черная львинка.удалчет перхоть . восстанавливают волос.рост волос.грибок ног.растрескивание кожи.крыши.зуд......',
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 49,
        commercialAdsDeleteThreshold: 69,
      },
    },
    {
      label: 'weight loss chat funnel',
      ruleLabel: 'weight-loss-chat-funnel',
      cap: 'review',
      actionBand: 'REVIEW_ONLY',
      text: 'Девочки, открываю двери в наш секретный чат худеющих! 🔥Всё БЕСПЛАТНО 🤫Внутри: тренировки, меню без жестких диет, разбор привычек, челленджи и поддержка 24/7.Худеем в кайф, пьем водичку, высыпаемся и вместе радуемся цифрам на весах. Главное — ваша дисциплина и наша общая энергия! В команде результаты всегда быстрее 🚀Пиши + в комментариях/директ, и я скину ссылку! 👇',
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 60,
        commercialAdsDeleteThreshold: 82,
      },
    },
    {
      label: 'pharmacy group promotion',
      ruleLabel: 'pharmacy-channel-promotion',
      cap: 'warn',
      actionBand: 'WARN',
      text: 'Китайская аптека 🇨🇳 У нас есть все,а чего нет найдем и привезем ✅ Отправка в любые населенные пункты📦 Наши группы: WhatsApp👇 [url] WhatsApp MAX👇 [url]',
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 45,
        commercialAdsDeleteThreshold: 65,
      },
      commercialCampaignContext: STRONG_CAMPAIGN_CONTEXT,
    },
    {
      label: 'developer financing lead generation',
      ruleLabel: 'mortgage-leadgen',
      cap: 'warn',
      actionBand: 'WARN',
      text: '1-комнатная квартира с просторной террасой в ЖК «МӨҢГҮН» Площадь квартиры — 33,16 м². Удобная планировка: отдельная комната, кухня, полноценная ванная и большая терраса для отдыха. 💰 Первоначальный взнос — 1 508 000 ₽ 📆 Платёж — 22 177 ₽ в месяц 🔑 Выдача ключей — декабрь 2026 года Хороший вариант для собственного проживания или выгодной инвестиции. Количество квартир ограничено. 📞 [phone] Поможем подобрать квартиру и рассчитать условия покупки.',
      settings: {
        commercialAdsSensitivity: 'STRICT',
        commercialAdsWarnThreshold: 38,
        commercialAdsDeleteThreshold: 55,
      },
    },
  ])('routes $label to its exact bounded action', (testCase) => {
    const result = detect(testCase.text, {
      settings: testCase.settings as Partial<ChatSettings>,
      commercialCampaignContext: testCase.commercialCampaignContext,
    });

    expect(result).toBeDefined();
    expect(result?.matchedSignals).toContain(`risk:${testCase.ruleLabel}`);
    expect(result?.matchedSignals).toContain(`recall-cap:${testCase.cap}:${testCase.ruleLabel}`);
    expect(result?.actionBand).toBe(testCase.actionBand);
    expect(result?.actionBand).not.toBe('DELETE');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
    expect(result?.suppressionReasons).toContain(
      testCase.cap === 'review' ? 'bounded-recall-review-cap' : 'bounded-recall-warn-cap',
    );
  });

  it('does not treat a rhetorical question mark as a blanket recall exclusion', () => {
    expect(
      collectCommercialHighRiskRecallHits(
        'Нужна ипотека? Помогу получить ипотеку 2% на строительство без ПВ. Лимит заканчивается, не медлите, пишите [phone]'.toLowerCase(),
      ),
    ).toContainEqual({ label: 'mortgage-leadgen', actionCap: 'warn' });
  });

  it('counts distinct medicine-price pairs inside the extended catalog family', () => {
    expect(
      collectCommercialHighRiskRecallHits(
        'Фенибут 500, прегабалин 600, габапентин 700, атаракс 800. Остальные по 300'.toLowerCase(),
      ),
    ).toContainEqual({ label: 'medicine-price-catalog', actionCap: 'review' });
  });

  it('does not count repeated prices for one medicine as distinct catalog entries', () => {
    expect(
      collectCommercialHighRiskRecallHits(
        'Фенибут 500, фенибут 600, фенибут 700. Остальные по 300'.toLowerCase(),
      ),
    ).toEqual([]);
  });

  it('lets a bounded warn source win beside a review-only high-risk recall', () => {
    const result = detect(
      'Мыло ручной работы: перхоть, рост волос, грибок ног и зуд. Подписывайся на наш канал [url]',
      {
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 49,
          commercialAdsDeleteThreshold: 69,
        },
      },
    );

    expect(result?.matchedSignals).toContain('recall-cap:review:handmade-health-claims');
    expect(result?.matchedSignals).toContain('recall-cap:warn:explicit-group-promotion');
    expect(result?.actionBand).toBe('WARN');
    expect(result?.suppressionReasons).toContain('bounded-recall-warn-cap');
  });

  it.each([
    'Врач назначил: пикамилон 250 мг, тофизопам 200 мг, тералиджен 5 мг вечером.',
    'Подскажите, сколько стоит пикамилон, тофизопам и тералиджен?',
    'Новости: банки снизили ставки по ипотеке до 2% на строительство.',
    'Продам дом, ипотека возможна, телефон [phone].',
    'Я собственник, ипотека возможна, первоначальный взнос обсуждается. Телефон [phone]',
    'Осторожно: гадалка обещает вернуть любимого, снимает преграды и просит звонить [phone].',
    'Подруга рекомендует гадалку: делает расклады и диагностику, связаться [phone].',
    'Опытная ясновидящая: провожу диагностику ситуации, предсказываю события и отвечаю по телефону [phone].',
    'Рецепт мыла ручной работы: помогает от перхоти, грибка, зуда и сухости кожи.',
    'Купила мыло ручной работы от перхоти, грибка и зуда, но оно не помогло.',
    'Мой канал с заметками про ручную работу, корзины и куклы без продаж.',
    'Некоммерческая анонимная группа худеющих: тренировки, меню, привычки и поддержка без рекламы и продаж.',
    'Обсуждаем тренировки, меню, привычки и поддержку для похудения.',
    'Подскажите, есть ли лекарство в китайской аптеке и отправляют ли по России?',
    'Список аптек города: адреса, режим работы и официальные телефоны.',
  ])(
    'does not match treatment, warning, news, quote, question, or peer-support context',
    (text) => {
      expect(collectCommercialHighRiskRecallHits(text.toLowerCase())).toEqual([]);
    },
  );

  it.each([
    {
      text: 'НОВЫЙ❗ АнтиПРОЛЕЖНЕВЫЙ матрас с компрессором✅. Цена ниже аптек =1800 руб. 📲 [phone]',
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 50,
        commercialAdsDeleteThreshold: 70,
      },
    },
    {
      text: 'Чем раньше вы подадите на банкротство, тем быстрее обретёте шанс на новое финансовое будущее. 🔮',
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 49,
        commercialAdsDeleteThreshold: 69,
      },
    },
    {
      text: 'Продам цена ниже аптеки. Тел [phone]',
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 57,
        commercialAdsDeleteThreshold: 78,
      },
    },
    {
      text: 'Доставка Новый-4 77. Стики хитс розовые-3. Перевод',
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 48,
        commercialAdsDeleteThreshold: 68,
      },
    },
  ])('preserves the bounded high-risk guard corpus', ({ text, settings }) => {
    expect(collectCommercialHighRiskRecallHits(text.toLowerCase())).toEqual([]);
    expect(detect(text, { settings: settings as Partial<ChatSettings> })).toBeNull();
  });
});

describe('private property morphology around indoor plants', () => {
  const privatePropertySalePattern = ADS_PROPERTY_PRIVATE_PATTERNS.find(
    ({ label }) => label === 'property-sale',
  )?.pattern;

  it('does not interpret indoor flowers as a room listing', () => {
    expect(privatePropertySalePattern).toBeDefined();
    expect(privatePropertySalePattern?.test('продам комнатные цветы')).toBe(false);
  });

  it.each([
    'продам комнату в общежитии',
    'продаю квартиру рядом с парком',
    'продам дом в деревне',
    'продается участок под строительство',
  ])('keeps real property listings private: %s', (text) => {
    expect(privatePropertySalePattern?.test(text)).toBe(true);
  });

  it('warns on the structured indoor-plant assortment without animal or property noise', () => {
    const text =
      'По всем вопросам звонить [phone] 🪴 ПРОДАМ КОМНАТНЫЕ ЦВЕТЫ - разные, подрощенные, здоровы🍃 Фикусы - 500 руб Коллизия - 350 руб. Сингониумы (пикси и шоколад) - от 380 руб. Эпипремнум (вьющийся) - 450 руб, и другие... Фото по запросу Барнаул, Пр. Северный Власихинский, 96';
    const result = detect(text, {
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 51,
        commercialAdsDeleteThreshold: 71,
      },
      commercialCampaignContext: {
        senderDistinctChatCount: 2,
        sameTextDistinctChatCount: 2,
        repeatedPhoneDistinctChatCount: 2,
        repeatedLinkDistinctChatCount: 0,
        nearTextDistinctChatCount: 2,
        repeatedDomainDistinctChatCount: 0,
        repeatedHandleDistinctChatCount: 0,
        senderDistinctChatCount5m: 2,
        senderDistinctChatCount30m: 2,
        senderDistinctChatCount120m: 2,
      },
    });

    expect(result?.actionBand).toBe('WARN');
    expect(result?.matchedSignals).toContain('goods-retail:indoor-plant-assortment');
    expect(result?.matchedSignals).toContain('recall-cap:warn:indoor-plant-assortment');
    expect(result?.matchedSignals).not.toContain('goods-retail:animal-breeder-retail');
    expect(result?.negativeSignals).not.toContain('private:property-sale');
  });

  it('keeps the breeder rule on animal nouns but not suffixes inside unrelated words', () => {
    const breederPatterns = ADS_GOODS_RETAIL_PATTERNS.filter(
      ({ label }) => label === 'animal-breeder-retail',
    ).map(({ pattern }) => pattern);

    expect(
      breederPatterns.some((pattern) =>
        pattern.test(
          'продам породистых щенков лабрадора, привиты, документы ркф, цена 30000 руб, телефон [phone]',
        ),
      ),
    ).toBe(true);
    expect(
      breederPatterns.some((pattern) =>
        pattern.test('продам комнатные цветы, разные, подрощенные, цена 500 руб, телефон [phone]'),
      ),
    ).toBe(false);
  });
});
