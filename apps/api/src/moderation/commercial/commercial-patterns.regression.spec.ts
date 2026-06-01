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

const REPEATED_PRIVATE_RESALE_CONTEXT: CommercialCampaignContext = {
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

function detect(
  text: string,
  options: {
    commercialCampaignContext?: CommercialCampaignContext | null;
    settings?: Partial<ChatSettings>;
  } = {},
) {
  const settings = {
    ...BASE_SETTINGS,
    ...options.settings,
  } as ChatSettings;
  const context = createRuleDetectionContext({
    text,
    settings,
  });

  return detector.detect({
    normalizedText: context.normalizedText,
    rawLoweredText: context.rawLoweredText,
    settings,
    commercialCampaignContext: options.commercialCampaignContext,
  });
}

describe('commercial pattern regressions', () => {
  it.each([
    {
      label: 'accounting subscription service',
      text: 'Бухгалтер для ИП и ООО. Отчётность, декларации, налоги, кадровый учет. Абонентское обслуживание от 3000 руб. +7 900 000 00 92.',
      subtype: 'SERVICES',
      signals: ['service-specialty:accounting-service', 'transaction:price', 'contact:phone'],
    },
    {
      label: 'yandex direct contextual ads service',
      text: 'Настрою Яндекс Директ и контекстную рекламу. Аудит бесплатно, заявки уже через неделю. Пишите https://max.ru/u/directolog',
      subtype: 'SERVICES',
      signals: [
        'service-specialty:digital-service',
        'service-specialty:promotion-service',
        'deal-channel:link',
      ],
    },
    {
      label: 'medical center service',
      text: 'Медицинский центр: УЗИ, анализы, прием терапевта и невролога. Скидка 15%, запись +7 900 000 00 93.',
      subtype: 'SERVICES',
      signals: ['service-specialty:medical-service', 'promo:скидк', 'contact:phone'],
    },
    {
      label: 'scrap metal buyout',
      text: 'Приём металлолома, цветной и черный металл. Расчет сразу, выезд, звоните +7 900 000 00 94.',
      subtype: 'BUYOUT',
      signals: ['buyout:scrap-metal-buyout', 'contact:phone'],
    },
    {
      label: 'truck spare parts retail from fourteen hour audit miss',
      text: 'Продам запчасти грузовые. Рессоры FAW J6, амортизаторы, бортовые, генератор, стартер. Новые, цена от 5000 руб. Телефон +7 900 000 00 95.',
      subtype: 'GOODS_RETAIL',
      signals: ['intent:продам', 'goods-retail:auto-parts-retail', 'contact:phone'],
    },
    {
      label: 'multi object residential showcase from fourteen hour audit miss',
      text: 'ЖК Флора. Студия 24 м2 цена 3.450.000, квартира 32 м2 цена 4.250.000, студия 28 м2 цена 3.900.000. Звоните +7 900 000 00 96.',
      subtype: 'PROPERTY_AGENT',
      signals: ['property-agent:витрина-объектов-прайс', 'contact:phone'],
      negativeSignals: ['private:property-sale'],
    },
    {
      label: 'bath tub retail stays retail instead of recruitment',
      text: 'Банный чан из нержавеющей стали. Цена за полный комплект, доставка, гарантия. Телефон +7 900 000 00 97.',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:bath-tub-retail', 'contact:phone'],
    },
    {
      label: 'electromontage service with procurement wording stays service',
      text: 'Все виды электромонтажных работ, помощь закупки материалов, розетки, автоматы, щитки. Телефон +7 900 000 00 98.',
      subtype: 'SERVICES',
      signals: ['service-specialty:электромонтаж', 'contact:phone'],
    },
    {
      label: 'livestock procurement stays buyout after generic zakup tightening',
      text: 'Закуп КРС и МРС: коровы, быки, телята, овцы. Расчет сразу, выезд по району. Телефон +7 900 000 00 99.',
      subtype: 'BUYOUT',
      signals: ['buyout:livestock-procurement', 'contact:phone'],
    },
    {
      label: 'speech therapy launch from twelve hour audit miss',
      text: 'Запуск речи у неговорящих или малоговорящих детей. Ваш ребёнок заговорит уверенно с помощью профессионального логопеда! Индивидуальные занятия помогут развить речь быстро и эффективно. Запишитесь сегодня по номеру +7 900 000 01 00, действуют скидки.',
      subtype: 'SERVICES',
      signals: ['service-specialty:speech-therapy-lessons', 'contact:phone'],
    },
    {
      label: 'crane beam installation from twelve hour audit miss',
      text: 'Производство и монтаж кран балок под ключ. +7 900 000 01 02',
      subtype: 'SERVICES',
      signals: ['intent:crane-beam-under-key', 'service-specialty:crane-beam-installation'],
    },
    {
      label: 'pvc window and door maintenance from twelve hour audit miss',
      text: 'Ремонт и обслуживание окон и дверей из ПВХ, ремонт и обслуживание деревянных евроокон. Телефон +7 900 000 01 03.',
      subtype: 'SERVICES',
      signals: ['intent:window-door-maintenance', 'service-specialty:pvc-window-door-repair'],
    },
    {
      label: 'custom portrait order from twelve hour audit miss',
      text: 'Портрет на холсте - это подарок, который хранит воспоминания. Для заказа пишите именно на этот номер: +7 900 000 01 04 WA, Max.',
      subtype: 'SERVICES',
      signals: ['intent:custom-art-order', 'service-specialty:custom-art-order'],
    },
    {
      label: 'home goods order with emoji phone from twelve hour audit miss',
      text: 'Переходите в нашу группу, где вы найдете посуду, технику и текстиль по самым низким ценам. По поводу заказа пишите по номеру 8️⃣9️⃣8️⃣9️⃣8️⃣8️⃣8️⃣2️⃣0️⃣8️⃣9️⃣',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:home-goods-low-price-order', 'contact:phone'],
    },
  ])('detects $label', ({ text, subtype, signals, negativeSignals = [] }) => {
    const result = detect(text);

    expect(result).toBeDefined();
    expect(result?.primarySubtype).toBe(subtype);
    expect(result?.matchedSignals).toEqual(expect.arrayContaining(signals));
    expect(result?.negativeSignals).toEqual(negativeSignals);
  });

  it('does not classify broad bath tub retail wording as recruitment', () => {
    const result = detect(
      'Цена за полный комплект. Доставка по региону. Банный чан из нержавеющей стали, работаем по договору. Телефон +7 900 000 00 97.',
    );

    expect(result?.primarySubtype).toBe('GOODS_RETAIL');
    expect(result?.matchedSignals).toContain('goods-retail:bath-tub-retail');
    expect(result?.matchedSignals).not.toContain('recruitment:работа-условия');
  });

  it('detects emoji separated multi-object Flora showcase under balanced thresholds', () => {
    const result = detect(
      'ЖК Флора 🌱 Г.Сочи Кудепста ♦️ Студия ♦️ 24м2 ♦️ черновая 🔥7.200.000 ♦️ Студия ♦️ 24м2 ♦️ РМТ 🔥8.500.000 ♦️ Студия ♦️ 26м2 ♦️ РМТ 🔥8.600.000 Все предложения по комплексам Флора, Летний и Лестория от собственника на ключах 🔑 📱 +7 900 000 01 01 Виктория',
      {
        commercialCampaignContext: {
          ...REPEATED_PRIVATE_RESALE_CONTEXT,
          senderDistinctChatCount: 1,
          sameTextDistinctChatCount: 1,
          nearTextDistinctChatCount: 1,
          repeatedPhoneDistinctChatCount: 1,
          senderDistinctChatCount5m: 1,
          senderDistinctChatCount30m: 1,
          senderDistinctChatCount120m: 1,
        },
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 55,
          commercialAdsDeleteThreshold: 76,
        },
      },
    );

    expect(result?.primarySubtype).toBe('PROPERTY_AGENT');
    expect(result?.matchedSignals).toContain('property-agent:витрина-объектов-прайс');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
  });

  it('detects conditioner install and refill services under balanced thresholds', () => {
    const result = detect(
      'Здравствуйте, оперативно, быстро и качественно выполняем работы по: - установке кондиционеров - обслуживанию -заправке -ремонту Звоните прямо сейчас - начинается горячий сезон. Выезжаем за город. +7 900 000 01 02',
      {
        commercialCampaignContext: {
          ...REPEATED_PRIVATE_RESALE_CONTEXT,
          senderDistinctChatCount: 1,
          sameTextDistinctChatCount: 1,
          nearTextDistinctChatCount: 1,
          repeatedPhoneDistinctChatCount: 1,
          senderDistinctChatCount5m: 1,
          senderDistinctChatCount30m: 1,
          senderDistinctChatCount120m: 1,
        },
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 58,
          commercialAdsDeleteThreshold: 78,
        },
      },
    );

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.matchedSignals).toEqual(
      expect.arrayContaining(['service-specialty:appliance-repair', 'contact:phone']),
    );
    expect(['REVIEW_ONLY', 'WARN']).toContain(result?.actionBand);
  });

  it('does not let generic medical appointment wording become buyout evidence', () => {
    const result = detect(
      'Медицинский центр: УЗИ, анализы, прием терапевта и невролога. Скидка 15%, запись +7 900 000 00 93.',
    );

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.matchedSignals).not.toContain('buyout:прием');
    expect(result?.matchedSignals).not.toContain('buyout:приём');
  });

  it('does not let material procurement wording become buyout evidence for services', () => {
    const result = detect(
      'Все виды электромонтажных работ, помощь закупки материалов, розетки, автоматы, щитки. Телефон +7 900 000 00 98.',
    );

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.matchedSignals).not.toContain('buyout:закуп');
    expect(result?.matchedSignals).not.toContain('buyout:livestock-procurement');
  });

  it.each([
    [
      'accountant recommendation request',
      'Посоветуйте бухгалтера для ИП, кто хорошо сдаёт отчетность?',
    ],
    [
      'yandex direct recommendation request',
      'Кто настраивал Яндекс Директ, подскажите нормального специалиста?',
    ],
    ['medical center recommendation request', 'Кто знает хороший медицинский центр для УЗИ?'],
    [
      'plain medical appointment queue',
      'Прием у врача задержали на 40 минут, кто сейчас в очереди?',
    ],
    [
      'non promotional accounting report mention',
      'Бухгалтер сдал отчетность, декларации и налоги вчера, можно больше не переживать.',
    ],
    [
      'delivery discussion in private messages from fourteen hour audit false positive',
      'Эта доставка мне в личку пишет.',
    ],
    [
      'long delivery complaint from fourteen hour audit false positive',
      'Я писала выше, что на доставке она мне в личку ещё звонит, адрес знает, потом всё удалили после разборки.',
    ],
    [
      'private one off shoes resale from fourteen hour audit false positive',
      'Продам полусапожки весна осень, размер 38, состояние отличное - 1300 руб.',
    ],
    [
      'animal adoption relocation mention is not logistics advertising',
      'Кошка ищет дом, отдают в добрые руки при переезде, пишите в личку.',
    ],
    [
      'quoted commercial text is discussion, not own ad',
      'Сосед прислал рекламу: "Скидка на курс, пишите в личку, цена 3000 руб". Такое удаляем?',
    ],
    [
      'channel metrics report with explicit not selling placement',
      'Отчет по каналу: ER24 12%, рекламный пост стоил 500р у конкурента, размещение не продаём.',
    ],
    [
      'admin moderation discussion about ad spam',
      'Админы, спамер кидает рекламу, бот удаляет такие сообщения или нужно настроить фильтр?',
    ],
    [
      'low quantity plant giveaway stays private',
      'Отдам денежное дерево по 50 руб за шт, в наличии 3 шт, есть с корнями, район Комета',
    ],
  ])('allows %s', (_label, text) => {
    expect(detect(text)).toBeNull();
  });

  it('keeps repeated private clothing resale out of commercial actions even with campaign context', () => {
    const result = detect(
      'Продам детские вещи: куртка р-р 122 сост. отличное 700 руб, сапоги р-р 30 сост. хорошее 500 руб, шапка 150 руб. Пишите в личку.',
      { commercialCampaignContext: REPEATED_PRIVATE_RESALE_CONTEXT },
    );

    expect(result).toBeNull();
  });
});
