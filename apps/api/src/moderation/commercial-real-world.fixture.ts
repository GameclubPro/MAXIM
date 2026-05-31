import type { CommercialCampaignContext } from './commercial-campaign.util';
import type { CommercialSubtype } from './rule-engine.contract';

type CommercialFixtureOverrides = {
  commercialAdsSensitivity?: 'BALANCED' | 'STRICT';
  commercialAdsWarnThreshold?: number;
  commercialAdsDeleteThreshold?: number;
};

export type CommercialRealWorldPositiveCase = {
  label: string;
  text: string;
  expectedSubtype: CommercialSubtype;
  expectedSignals: string[];
  reviewRecommended?: boolean;
  requireClassifier?: boolean;
  campaignContext?: CommercialCampaignContext;
  overrides?: CommercialFixtureOverrides;
};

export type CommercialRealWorldNegativeCase = {
  label: string;
  text: string;
  campaignContext?: CommercialCampaignContext;
  overrides?: CommercialFixtureOverrides;
};

export const COMMERCIAL_REAL_WORLD_POSITIVE_CASES: CommercialRealWorldPositiveCase[] = [
  {
    label: 'remote perfumery recruitment from production logs',
    text: `🙋‍♀️ Ищу девушку или женщину для работы с парфюмом. В парфюмерную компанию ESSENS на удалённую работу, подработку. Прямой доход от 1000 ₽ с одного флакона духов сразу на руки плюс бонусы. Работа онлайн по всей России. Всегда актуальные вакансии. Пишите на номер +7 900 000 00 01, пришлю ссылку на группу.`,
    expectedSubtype: 'RECRUITMENT',
    reviewRecommended: false,
    expectedSignals: [
      'recruitment:ваканси',
      'recruitment:подработк',
      'transaction:price',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'fast food vacancies from recent moderation window',
    text: `Открыты вакансии в новое кафе быстрого питания «Тут Поесть». Повар-шаурмист, опыт от 1 года. График индивидуальный, смена 24 часа или 12 часов, ставка 20% от продажи, минимум 8000 за смену. Помощник повара и кассир тоже требуются. Подробности по телефону +7 900 000 00 02.`,
    expectedSubtype: 'RECRUITMENT',
    reviewRecommended: false,
    expectedSignals: [
      'recruitment:ваканси',
      'recruitment:смена',
      'contact:по телефону',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'paving and landscaping offer from factory ad',
    text: `Вибропрессованная тротуарная плитка от завода. Продажа тротуарной плитки, укладка брусчатки, установка садовых и дорожных бордюров, системы водоотведения, благоустройство дворовых территорий. Выезд на замер и составление сметы бесплатно. Работаем по договору. Телефон +7 900 000 00 03.`,
    expectedSubtype: 'SERVICES',
    reviewRecommended: false,
    expectedSignals: [
      'intent:продажа',
      'service-specialty:установк',
      'group-trade:продажа',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'construction brigade all works from three hour audit miss',
    text: `СТРОИТЕЛЬНАЯ БРИГАДА Все виды работ: кровля, фасады, ремонт квартир, заливка фундамента и отмостки, тротуарная плитка, сантехника, электрика, навесы, металлоконструкции, заборы, пристройки, бани, сараи. Ремонт под ключ. Сайдинг, термопанели. Работаем со своим стройматериалом. Пенсионерам и участникам СВО — скидка 15%. Звоните: 8 900 000 00 31, 8 900 000 00 32.`,
    expectedSubtype: 'SERVICES',
    expectedSignals: ['intent:строительная-бригада', 'service-specialty:ремонт', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'tree trimming and welding service from three hour audit miss',
    text: `Спилим, обрежем деревья небольшие сварочные работы, изготовление оградок, заборов, столов, лавочек, ремонт крыш, пластиковое водоснабжение. НОМЕР: 8 918-97-300-95`,
    expectedSubtype: 'SERVICES',
    expectedSignals: [
      'intent:сделаю',
      'service-specialty:tree-yard-repair-service',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'language tutor phone ad from three hour audit miss',
    text: `Английский, китайский для взрослых и детей. Опытный преподаватель. 8 900 000 00 33`,
    expectedSubtype: 'SERVICES',
    expectedSignals: [
      'intent:language-lessons',
      'service-specialty:language-tutor',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 60,
      commercialAdsDeleteThreshold: 82,
    },
  },
  {
    label: 'fragrance retail teaser from three hour audit miss',
    text: `Аромат, который говорит за тебя — громче слов. Парфюм по приятным ценам. Стойкие ароматы и тот самый вау-эффект в каждом флаконе. Подпишись и найди свой идеальный шлейф уже сегодня.`,
    expectedSubtype: 'GOODS_RETAIL',
    expectedSignals: ['goods-retail:fragrance-retail-promo', 'transaction:keywords'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'newcomer bonus link from three hour audit miss',
    text: `https://example.com/promo НОВЕНЬКИМ БОНУС. ЖДЁМ ВАС`,
    expectedSubtype: 'GOODS',
    expectedSignals: ['business:newcomer-bonus-promo', 'deal-channel:link'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'multi-platform promotion service from production messages',
    text: `Нужны клиенты? В любой сфере сделаю продвижение, на рынке 11 лет. Сегодня скидки для всех желающих. Пишите либо звоните сразу. Продвижение WhatsApp, MAX, Telegram, ВКонтакте. Быстрый поиск клиентов по доступным ценам, запуск рекламных постов, создание групп, сообществ и каналов под вашу бизнес-деятельность. Телефон +7 900 000 00 04.`,
    expectedSubtype: 'SERVICES',
    expectedSignals: ['intent:сделаю', 'promo:скидк', 'audience:клиент', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'cleaning service with max chat invite from production logs',
    text: `Ростов-на-Дону. Уборка квартир, домов и офисов. Предлагаю вам свои услуги: поддерживающая уборка, генеральная уборка, уборка после сдачи в аренду, уборка для продажи, мытьё окон, уборка после ремонта. Пишите, звоните, буду рада помочь. +7 900 000 00 05. Присоединяйся к чату по ссылке: https://max.ru/join/example-cleaning-chat`,
    expectedSubtype: 'SERVICES',
    expectedSignals: [
      'intent:услуги',
      'service-specialty:уборк',
      'contact:phone',
      'deal-channel:link',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'nutrition marathon chat invite from production messages',
    text: `Приглашаю в бесплатный чат правильного питания только для женщин. У нас живое общение, советы по питанию, рецепты и марафоны стройности. Мы научим вас правильно питаться и доведём до нужного результата. Чат в Max: https://max.ru/join/example-healthy-chat`,
    expectedSubtype: 'INFO_PRODUCT',
    expectedSignals: ['info:марафон', 'group-promo:приглашаю', 'deal-channel:link'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'broker flat listing with keys and commission from production logs',
    text: `ЖК Архитектор. Тип квартиры: Евро 3к. Площадь 65 м². Отделка: ремонт, мебель, техника. Квартира на ключах. Показ 24/7. Комиссия: ваша комиссия сверху. Цена 13 500 000 ₽. Звоните прямо сейчас: +7 900 000 00 06.`,
    expectedSubtype: 'PROPERTY_AGENT',
    reviewRecommended: false,
    expectedSignals: [
      'property-agent:комиссия-сверху',
      'property-agent:на-ключах',
      'property-agent:показ-247',
      'transaction:price',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'broker house sale with explicit commission from production logs',
    text: `Срочная продажа. Дом в Центральном районе города. 3 комнаты, 2 этажа, площадь 62,7 кв м. Требуется ремонт, мебель, техника. Цена 5 100 000 ₽. Ваша комиссия сверху. Связь: +7 900 000 00 07.`,
    expectedSubtype: 'PROPERTY_AGENT',
    reviewRecommended: false,
    expectedSignals: [
      'intent:продажа',
      'property-agent:комиссия-сверху',
      'transaction:price',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'commercial premises sale from production logs',
    text: `#продам #недвижимость #коммерция #краснодар #центр Продажа помещения в центре. Площадь 46.2 м². Назначение жилое, но более 30 лет используется как коммерция. Вход с улицы, фасадные окна, свет 15 кВт, вода и канализация центральные. Цена 5.3 млн. +7 900 000 00 13.`,
    expectedSubtype: 'PROPERTY_COMMERCIAL',
    reviewRecommended: false,
    expectedSignals: [
      'intent:продам',
      'business:коммерция',
      'property-commercial:commercial-space',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'office rent commercial space from edge-case audit',
    text: `Сдам офис 30 м² в деловом центре, первая линия, отдельный вход. Подойдёт под услуги или небольшой шоурум. Звоните: +7 900 000 00 86.`,
    expectedSubtype: 'PROPERTY_COMMERCIAL',
    reviewRecommended: false,
    expectedSignals: ['intent:сдам', 'property-commercial:commercial-space', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'warehouse rent commercial space from edge-case audit',
    text: `Аренда склада 120 м², тёплый бокс, ворота под газель, круглосуточный доступ. Телефон +7 900 000 00 87.`,
    expectedSubtype: 'PROPERTY_COMMERCIAL',
    reviewRecommended: false,
    expectedSignals: ['intent:аренда', 'property-commercial:commercial-space', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'passive trading space rent from edge-case audit',
    text: `Сдаётся торговое помещение 45 м², первая линия, отдельный вход, 60 000 руб/мес. Звоните +7 900 000 00 88.`,
    expectedSubtype: 'PROPERTY_COMMERCIAL',
    reviewRecommended: false,
    expectedSignals: ['property-commercial:commercial-space', 'transaction:price', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'ready business sale from edge-case audit',
    text: `Продажа готового бизнеса: кофейня в центре, оборудование остаётся, выручка подтверждена. Цена 1 200 000 руб, звоните +7 900 000 00 89.`,
    expectedSubtype: 'GOODS',
    reviewRecommended: false,
    expectedSignals: ['business:business-sale', 'transaction:price', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'spaced letters retail offer from edge-case audit',
    text: `П Р О Д А Е М мебель от производителя. Каталог, доставка по городу, оплата при получении. Телефон +7 900 000 00 90.`,
    expectedSubtype: 'GOODS_RETAIL',
    reviewRecommended: false,
    expectedSignals: [
      'intent:продаем',
      'goods-retail:manufacturer',
      'goods-retail:order-flow',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'punctuated letters retail offer from edge-case audit',
    text: `П.Р.О.Д.А.Е.М мебель от производителя. Каталог, доставка по городу, оплата при получении. Телефон +7 900 000 00 91.`,
    expectedSubtype: 'GOODS_RETAIL',
    reviewRecommended: false,
    expectedSignals: [
      'intent:продаем',
      'goods-retail:manufacturer',
      'goods-retail:order-flow',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'bike sales with delivery from production logs',
    text: `В продаже новые велосипеды. Цены от 15 000 р. Возможна доставка. В наличии разные размеры и цвета. Пишите или звоните, отвечу на все вопросы, скину подробные фото и видео. Телефон +7 900 000 00 08.`,
    expectedSubtype: 'GOODS_RETAIL',
    reviewRecommended: false,
    requireClassifier: true,
    expectedSignals: [
      'promo:доставк',
      'goods-retail:sizes-and-colors',
      'contact:phone',
      'combo:contact+price',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'signboard catalog ad from production logs',
    text: `Рекламное агентство. Сезон штендеров-книжек открыт. Штендеры с вашей рекламой для улицы и помещений. Пластиковые и металлические. Стоимость 2900 рублей. Доставка до вашего офиса бесплатно. +7 900 000 00 14.`,
    expectedSubtype: 'GOODS_RETAIL',
    reviewRecommended: false,
    expectedSignals: [
      'goods-retail:commercial-use',
      'transaction:price',
      'contact:phone',
      'combo:business+deal',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'furniture retail ad with order flow from production logs',
    text: `Кровати и матрасы от производителя. Цены от 18 000 ₽. В наличии разные размеры и цвета, доставка по региону, работаем со склада. Пишите, скину каталог моделей. +7 900 000 00 15.`,
    expectedSubtype: 'GOODS_RETAIL',
    reviewRecommended: false,
    requireClassifier: true,
    expectedSignals: [
      'goods-retail:manufacturer',
      'goods-retail:catalog-media',
      'goods-retail:sizes-and-colors',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'multi sku bicycle listing from production logs',
    text: `Продам велосипед на 20 - 5000р., велосипед на 16 - 3000р. т. +7 900 000 00 17`,
    expectedSubtype: 'GOODS_RETAIL',
    reviewRecommended: false,
    requireClassifier: true,
    expectedSignals: ['intent:продам', 'transaction:price', 'contact:phone', 'combo:contact+price'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'broker flat listing from last two hours moderation window',
    text: `💎 ЖК Самолет 2💎 🏢 Тип квартиры: Евро 2к 📐 Площадь: 37 м² 🎨 Отделка: Ремонт Мебель Тех 🔑 Квартира на ключах ⏰ Показ: 24/7 — в любое удобное время 💼 Комиссия: ваша комиссия сверху 💸 Цена: 6.500.000 ₽ 💸 📞 Звоните прямо сейчас: +7 900 000 00 19`,
    expectedSubtype: 'PROPERTY_AGENT',
    reviewRecommended: false,
    expectedSignals: [
      'property-agent:комиссия-сверху',
      'property-agent:на-ключах',
      'property-agent:показ-247',
      'transaction:price',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'finishing crew recruitment ad from last two hours moderation window',
    text: `Требуется бригада отделочников работа в Сургуте объём большой обращаться по телефону +7 932 406 24 28 напишите`,
    expectedSubtype: 'RECRUITMENT',
    reviewRecommended: false,
    expectedSignals: [
      'recruitment:требуется',
      'service-specialty:бригада',
      'contact:по телефону',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'labor and demolition service ad from last two hours moderation window',
    text: `Разнорабочие, подсобные рабочие, грузчики, выполняем работу под ваши задачи. 8 967 828 01 02. Отмостки, кровля, заборы, ремонт крыш, демонтаж построек и зданий, копка ям и траншей.`,
    expectedSubtype: 'SERVICES',
    reviewRecommended: false,
    expectedSignals: [
      'service-specialty:ремонт',
      'service-specialty:грузчик',
      'service-specialty:демонтаж',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'business plan service with training context from production logs',
    text: `Реклама. Разработка бизнес-плана. Желаете получить от государства до 350 тыс руб на развитие собственного бизнеса или ЛПХ? Разработаю бизнес-план, проведу аудит лаборатории, помогу с аккредитацией и обучением персонала. Звоните или пишите в телеграм: +7 900 000 00 09.`,
    expectedSubtype: 'INFO_PRODUCT',
    reviewRecommended: false,
    expectedSignals: ['info:обучени', 'contact:telegram', 'contact:phone', 'combo:info+deal'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'cross-chat audience group invite from production audit',
    text: `Рассылка - добавка MAX, ватцап. Строго в группу писать. Более 400 клиентов. Действуют акции, пишите в группу. https://max.ru/join/example-audience-group`,
    expectedSubtype: 'SERVICES',
    reviewRecommended: true,
    requireClassifier: true,
    campaignContext: {
      senderDistinctChatCount: 6,
      sameTextDistinctChatCount: 6,
      repeatedPhoneDistinctChatCount: 0,
      repeatedLinkDistinctChatCount: 6,
    },
    expectedSignals: [
      'promo:акци',
      'service-specialty:marketing-automation',
      'audience:клиент',
      'deal-channel:link',
      'campaign:cross-chat-text',
      'campaign:cross-chat-link',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'beauty service promo from production audit',
    text: `Милые дамы, приглашаю вас на маникюр и педикюр. Будь готова к лету. Действует акция: при депиляции подмышки в подарок. Цена за две процедуры 1200 рублей. Запись по телефону +7 900 000 00 20.`,
    expectedSubtype: 'SERVICES',
    reviewRecommended: false,
    expectedSignals: [
      'intent:запись',
      'promo:акци',
      'service-specialty:маникюр',
      'service-specialty:педикюр',
      'transaction:price',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'tracked max invite pair from last six hour audit',
    text: `https://max.ru/join/example-audience-link https://i.oneme.ru/i?r=BTGBPUwtwgYUeoFhO7rESmr8PkKUFrFQzWAxDtP-JVoTo6VPQDN2Rt7SGDf0beLbl-E`,
    expectedSubtype: 'CHANNEL_PLACEMENT',
    reviewRecommended: false,
    expectedSignals: ['channel-placement:mass-invite-link', 'deal-channel:link'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'same day auto buyout from last six hour audit',
    text: `Куплю автомобиль при срочной продаже. На ходу, не на ходу, с документами, без документов, с проблемными документами. Приезжаю и забираю сам в любой район. Звоните и пишите в любое время. Телефон +7 900 000 00 23.`,
    expectedSubtype: 'BUYOUT',
    reviewRecommended: false,
    expectedSignals: ['buyout:auto-same-day-buyout', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'custom knitted slippers service from twelve hour audit miss',
    text: `Всем привет! Меня зовут Аня, я вяжу на заказ крутые мягкие домашние тапочки на войлочной подошве, которые не порвутся после нескольких стирок. Два вида подошвы: экокожа до 45, резина до 41 размера. Открытый и закрытый носик. Отправляю по всей России. Все вопросы по телефону +7 900 000 00 92.`,
    expectedSubtype: 'SERVICES',
    reviewRecommended: false,
    expectedSignals: [
      'intent:на заказ',
      'service-specialty:custom-handmade-order',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 60,
      commercialAdsDeleteThreshold: 82,
    },
  },
  {
    label: 'paid survey referral from twelve hour audit miss',
    text: `Присоединяйся к Анкетке и зарабатывай на опросах! https://www.anketka.ru/referral/16481224`,
    expectedSubtype: 'GROUP_PROMOTION',
    reviewRecommended: false,
    expectedSignals: [
      'business:paid-survey-referral',
      'group-promo:присоединяйся',
      'deal-channel:link',
    ],
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 65,
    },
  },
  {
    label: 'construction multi service from twelve hour audit miss',
    text: `Здравствуйте! Построим без переплаты: беседки, гаражи, пристройки, веранды, теплицы. Фасад, кровля, обшивка, отделка любым материалом. Строительство фундамента, установка заборов, сварочные работы, демонтаж старых сооружений. Телефон +7 900 000 00 93.`,
    expectedSubtype: 'SERVICES',
    reviewRecommended: false,
    expectedSignals: ['intent:construction-multi-service', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 60,
      commercialAdsDeleteThreshold: 81,
    },
  },
  {
    label: 'building sheet stock campaign from twelve hour audit miss',
    text: `НОВЫЕ ПРОФЛИСТЫ! 2 метра. Коричневый. Двухсторонний. Одна сторона матовая, другая глянец. Количество 46 листов. Цена 1200 руб лист. При покупке всех привезем бесплатно. Оплата на месте. Телефон +7 900 000 00 94.`,
    expectedSubtype: 'GOODS_RETAIL',
    reviewRecommended: false,
    expectedSignals: [
      'goods-retail:building-material-sheet-stock',
      'contact:phone',
      'campaign:cross-chat-text',
    ],
    campaignContext: {
      senderDistinctChatCount: 4,
      sameTextDistinctChatCount: 4,
      repeatedPhoneDistinctChatCount: 4,
      repeatedLinkDistinctChatCount: 0,
      nearTextDistinctChatCount: 4,
      repeatedDomainDistinctChatCount: 0,
      repeatedHandleDistinctChatCount: 0,
      senderDistinctChatCount30m: 4,
      senderDistinctChatCount120m: 4,
    },
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 60,
      commercialAdsDeleteThreshold: 82,
    },
  },
  {
    label: 'custom leather goods service from twelve hour audit miss',
    text: `Из натуральной кожи изготавливаем обложки, бумажники, кошельки, портмоне, мужские ремни, сумки, клатчи и органайзеры. С гравировкой ваш текст, пожелание или фото. По всем вопросам обращаться сюда +7 900 000 00 95, MAX, telegram. Мои работы смотрите в МАХ https://max.ru/u/leatherwork`,
    expectedSubtype: 'SERVICES',
    reviewRecommended: false,
    expectedSignals: [
      'intent:сделаю',
      'service-specialty:custom-handmade-order',
      'deal-channel:link',
    ],
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 60,
      commercialAdsDeleteThreshold: 81,
    },
  },
  {
    label: 'warehouse job in Moscow from twelve hour audit miss',
    text: `Работа в Москве, склад. Бесплатная регистрация, трудовой договор, зарплата каждый месяц, аванс каждую неделю. Работа на складе через ТСД-сканер, сортировка товаров. 120000-200000 рублей. Телефон +7 900 000 00 96.`,
    expectedSubtype: 'RECRUITMENT',
    reviewRecommended: true,
    expectedSignals: ['recruitment:warehouse-job-conditions', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 48,
      commercialAdsDeleteThreshold: 68,
    },
  },
  {
    label: 'mobile data package retail from twelve hour audit miss',
    text: `Продам ГИГАБАЙТЫ Теле2. 5 гб - 70 рублей, 10 гб - 100 рублей, 20 гб - 200 рублей, 30 гб - 300 рублей. Обращаться в лс +7 900 000 00 97.`,
    expectedSubtype: 'GOODS_RETAIL',
    reviewRecommended: false,
    expectedSignals: [
      'goods-retail:mobile-data-package-retail',
      'transaction:price',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 56,
    },
  },
  {
    label: 'kizlyar knives retail catalog from twelve hour audit miss',
    text: `КИЗЛЯРСКИЕ НОЖИ - легенда ручной ковки. Что предлагаем: охотничьи ножи, кинжалы, шашки, шашлычные наборы. Где купить: в МАХ https://max.ru/join/kizlyar, Telegram https://t.me/kizlyar, WhatsApp заказ https://wa.me/79000000098. Телефон +7 900 000 00 98.`,
    expectedSubtype: 'GOODS_RETAIL',
    reviewRecommended: true,
    expectedSignals: [
      'goods-retail:knife-retail-catalog',
      'deal-channel:link',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 65,
    },
  },
  {
    label: 'kitchen worker vacancy with adjective role from last six hour audit',
    text: `Срочно требуется кухонный работник, объем небольшой, с 8 до 14. Просьба звонить, работу в ленте не просматриваю. Телефон +7 900 000 00 24.`,
    expectedSubtype: 'RECRUITMENT',
    reviewRecommended: false,
    expectedSignals: ['recruitment:требуется', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'driver license document service from last six hour audit',
    text: `Оформление водительских прав без экзаменов и очередей. Все категории: A, B, C, D. Без походов в ГИБДД и автошколу. Документы вносятся в официальную базу, готовность 14 дней. Пишите прямо сейчас: https://max.ru/u/example-driver-docs`,
    expectedSubtype: 'SERVICES',
    reviewRecommended: false,
    expectedSignals: [
      'risk:document-service',
      'service-specialty:document-service',
      'deal-channel:link',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'construction contractor repeated across chats in last six hour audit',
    text: `Возьмем подряд на строительство газобетонного дома. Участок расположен рядом с новой школой. Цена обсуждается. Поможем с первоначальным взносом, юридическое сопровождение включено. Звоните +7 900 000 00 25.`,
    expectedSubtype: 'SERVICES',
    expectedSignals: [
      'intent:возьмем-подряд',
      'service-specialty:construction-contractor',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'regional cargo delivery service from last six hour audit',
    text: `Доставка по Чите и краю. Переезды, доставка сборных грузов, посылок и стройматериалов, как попутно, так и отдельной машиной. До 30 кубов, до 5 тонн. Сергей +7 900 000 00 26.`,
    expectedSubtype: 'SERVICES',
    expectedSignals: ['promo:доставк', 'service-specialty:logistics-delivery', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'bulk materials delivery from last six hour audit',
    text: `Навоз, перегной, почвогрунт, чернозем, щебень, отсев, песок речной, песок карьерный, ПГС, дрова колотые, пиломатериал до 4 м. Доставка до 4 тонн, оплата наличными. Звонить +7 900 000 00 27.`,
    expectedSubtype: 'GOODS_RETAIL',
    reviewRecommended: false,
    expectedSignals: ['goods-retail:bulk-materials', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'tattoo master service from last six hour audit',
    text: `Тату-мастер Андрей. Индивидуальные эскизы, безопасная работа, профессиональный подход. Для записи отправьте фото желаемого места и размера или опишите идею. Контакты: личные сообщения в MAX https://max.ru/u/example-tattoo-master`,
    expectedSubtype: 'SERVICES',
    reviewRecommended: false,
    expectedSignals: ['service-specialty:тату', 'contact:для записи', 'deal-channel:link'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'wholesale produce lot from last six hour audit',
    text: `Без посредников, от собственника. Капуста белокочанная, сетевое качество, калибр 1-2 кг. Нал, безнал, объем. Цена 16,50 р. Телефон +7 900 000 00 28.`,
    expectedSubtype: 'GOODS_RETAIL',
    expectedSignals: ['goods-retail:wholesale-produce', 'transaction:price', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'plant pot volume price table from last six hour audit',
    text: `Фактурные кашпо из ротанга. У нас 4 серии: морской бриз, голубая лагуна, лавандовая и коричневая. Любой объем от 5 до 20 литров. 5 л - 1000 ₽, 7 л - 1200 ₽, 10 л - 1400 ₽, 12 л - 1600 ₽. Все вопросы и точный адрес по телефону +7 900 000 00 30.`,
    expectedSubtype: 'GOODS_RETAIL',
    reviewRecommended: false,
    expectedSignals: ['goods-retail:volume-price-table', 'transaction:price', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'lead generation bot missed in last six hour clear sweep',
    text: `Меньше работы, больше заявок! Всего 200 отправленных сообщений через нашего бота, и вы получаете стабильный поток из 40-60 клиентов ежедневно. Работает незаметно, без прокси и IP. Стартовая база в комплекте. Жми, чтобы узнать как: https://max.ru/join/example-leads`,
    expectedSubtype: 'SERVICES',
    reviewRecommended: false,
    expectedSignals: [
      'risk:bulk-client-leadgen',
      'service-specialty:marketing-automation',
      'audience:клиент',
      'deal-channel:link',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'mailing automation software missed in last six hour clear sweep',
    text: `Хватит терять аккаунты! Рассылки, которые не вызывают блокировок. Софт, который не подведет и не забанят. Забудьте о бесконечной настройке прокси и рассылках с нулевым результатом. Наш инструмент работает как живой человек. Стартовая база в комплекте: https://max.ru/join/example-mailing-soft`,
    expectedSubtype: 'SERVICES',
    reviewRecommended: false,
    expectedSignals: [
      'risk:messaging-automation',
      'service-specialty:marketing-automation',
      'deal-channel:link',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'city event channel invite missed in last six hour clear sweep',
    text: `Уважаемые участники группы. Приглашаем вас на наш канал "Афиша города. Куда сходить с детьми". Все события и мероприятия города: https://max.ru/join/example-city-events`,
    expectedSubtype: 'CHANNEL_PLACEMENT',
    expectedSignals: [
      'channel-placement:invite-to-channel',
      'group-promo:приглашаем',
      'deal-channel:link',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'agency rental with АН marker missed in last six hour clear sweep',
    text: `Сдам меблированную 1к квартиру с хорошим ремонтом. Центр энергетика, ул. Погодаева 7. Цена 17000 руб., коммунальные платежи включены. Звоните, тел. +7 900 000 00 31. АН.`,
    expectedSubtype: 'PROPERTY_AGENT',
    reviewRecommended: false,
    expectedSignals: [
      'property-agent:агентство-недвижимости',
      'transaction:price',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'broker price feed with safe request missed in last six hour clear sweep',
    text: `ЖК Лучший. Мини-2к.кв., 10/24 этаж, S=37 кв.м. Новый ремонт, мебель, техника. Сейф по запросу. Разбивка 4 150 000. Цена: 6 300 000. Светлана +7 900 000 00 32.`,
    expectedSubtype: 'PROPERTY_AGENT',
    expectedSignals: [
      'property-agent:сейф-по-запросу',
      'property-agent:разбивка-цены',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'official guard service recruitment missed in last six hour clear sweep',
    text: `Отдел вневедомственной охраны войск национальной гвардии приглашает на службу. Ищем граждан РФ от 18 до 50 лет, образование не ниже среднего, официальное трудоустройство, стабильная зарплата. Подробности по телефону +7 900 000 00 33.`,
    expectedSubtype: 'RECRUITMENT',
    reviewRecommended: false,
    expectedSignals: ['recruitment:приглашает-на-службу', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'nationwide clothing retail delivery from six hour manual review',
    text: `Футболка турецкая, люкс качество, размер от 58 до 62, вискоза. Доставка по Ростову и всей России любой транспортной компанией, писать в личку или звонить по телефону +7 900 000 00 34.`,
    expectedSubtype: 'GOODS_RETAIL',
    reviewRecommended: false,
    expectedSignals: ['promo:доставк', 'goods-retail:apparel-retail-order-flow', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'clothing preorder with prepayment from six hour manual review',
    text: `Платье производство Турция, размер 50/52, купить и заказать можно по предоплате. Писать в телеграмм или звонить по номеру +7 900 000 00 35.`,
    expectedSubtype: 'GOODS_RETAIL',
    reviewRecommended: true,
    expectedSignals: [
      'goods-retail:apparel-retail-order-flow',
      'contact:telegram',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'concrete works contractor from six hour manual review',
    text: `Бетонные работы под ключ по Краснодарскому краю и Адыгее. Работаем с юрлицами и физлицами, любые объёмы и сложность. Делаем фундаменты, отмостки, дорожки, площадки, бетонные полы и стяжки. Работаем по договору, звоните +7 900 000 00 36.`,
    expectedSubtype: 'SERVICES',
    reviewRecommended: false,
    expectedSignals: [
      'service-specialty:бетон',
      'service-specialty:concrete-works',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'seedling nursery stock from six hour manual review',
    text: `Саженцы винограда районированные для Сибири и Урала. С закрытой корневой системой, в больших горшках, 100% приживаемость. Цена от 700р. Звоните +7 900 000 00 37 или пишите в лс.`,
    expectedSubtype: 'GOODS_RETAIL',
    reviewRecommended: false,
    expectedSignals: ['goods-retail:plant-nursery-stock', 'transaction:price', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'broiler delivery sale from six hour manual review',
    text: `Реализуем и доставляем на дом цыплят бройлеров Кобб 500, возрастом 65 дней, весом от 4 до 5 кг. Цена 180 руб за кг. +7 900 000 00 38.`,
    expectedSubtype: 'GOODS_RETAIL',
    reviewRecommended: false,
    expectedSignals: ['goods-retail:farm-livestock-retail', 'transaction:price', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'restaurant waiter recruitment from six hour manual review',
    text: `Приглашаем в ресторан официантов. Рассматриваем кандидатов без опыта, всему обучаем. График 2/2, 3/2 или 5/2, ставка за смену от 1500 до 2100 ₽, личные чаевые. WhatsApp +7 900 000 00 39.`,
    expectedSubtype: 'RECRUITMENT',
    reviewRecommended: false,
    expectedSignals: ['recruitment:приглашаем-роли', 'transaction:price', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'insurance service from six hour manual review',
    text: `По любым видам страхования: недвижимость, ОСАГО, КАСКО, здоровье, жизнь, путешествия. Елена, специалист по страхованию. Телефон +7 900 000 00 40.`,
    expectedSubtype: 'SERVICES',
    reviewRecommended: false,
    expectedSignals: ['business:страхован', 'service-specialty:insurance-service', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'travel agency offer from six hour manual review',
    text: `Турагентство Елены Сафиной. Туры в любую точку мира, работаем 10 лет, подберём тур из любого города. Телефон +7 900 000 00 41, офис в Уфе.`,
    expectedSubtype: 'SERVICES',
    reviewRecommended: false,
    expectedSignals: ['business:турагентств', 'service-specialty:tour-agency', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'paid raffle transfer from six hour manual review',
    text: `Встречаем новый лот с повтором чисел. По 300 рублей, перевод по номеру +7 900 000 00 42 Тбанк Анна. 1 место 600, 2 место 350, 3 место 250. Всем удачи.`,
    expectedSubtype: 'GOODS',
    reviewRecommended: false,
    expectedSignals: ['risk:paid-raffle-transfer', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'vpn referral bonus from six hour manual review',
    text: `Отправьте другу ссылку и получите 67 ₽ на баланс avoVPN: https://avobonus.com/ref?start=example`,
    expectedSubtype: 'GOODS',
    reviewRecommended: false,
    expectedSignals: ['risk:referral-bonus-link', 'deal-channel:link'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'logistics office recruitment free workplace from six hour historical miss',
    text: `📋 В логистическом филиале СВОБОДНО РАБОЧЕЕ МЕСТО ⚠️Ищем сотрудника на долгосрочное сотрудничество! ✅ Оформление по договору ✅ 56 000 + премиальная часть ✅ Пятидневная рабочая неделя с 8:30 до 17:00 (есть возможность совмещения) Ваши задачи: 👥 Встречать и регистрировать гостей; 👤 Работать с документами (сканирование, копирование); 👤 Периодически отвечать на звонки; Что мы ценим: ✅ Уверенное владение ПК ✅ Опыт ведения деловой документации; ✅ Коммуникабельность и вежливость; ✅ Аккуратность и пунктуальность; Просьба внимательно ознакомится с работой перед откликом 📍 г. Иркутск, Центр, Октябрьский район 📞 Для отклика: 89990000022 💬 MAX: 89930000014`,
    expectedSubtype: 'RECRUITMENT',
    reviewRecommended: false,
    expectedSignals: [
      'risk:structured-job-vacancy',
      'recruitment:сотрудничеств',
      'recruitment:отклик',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 60,
      commercialAdsDeleteThreshold: 82,
    },
  },
  {
    label: 'appliance repair private master from six hour clear sweep',
    text: `Частный мастер по ремонту холодильников и стиральных машин. Продажа, чистка, заправка и установка кондиционеров. Пенсионерам скидка 20%. Бесплатная консультация по телефону +7 900 000 00 46.`,
    expectedSubtype: 'SERVICES',
    reviewRecommended: false,
    expectedSignals: ['service-specialty:ремонт', 'promo:скидк', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'home building contractor with mortgage from six hour clear sweep',
    text: `Постройте дом своей мечты уже в этом сезоне. Мы строим дома более 8 лет, помогаем подобрать землю и оформить ипотеку от 2%. Заключите договор с надежным подрядчиком. Звоните +7 900 000 00 47.`,
    expectedSubtype: 'SERVICES',
    reviewRecommended: false,
    expectedSignals: ['intent:строим-дома', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'short term seaside apartment rental from six hour clear sweep',
    text: `Сдаётся уютная квартира у моря для отдыха. Пляж в пяти минутах, Wi-Fi, кондиционер, парковка. Цена 4500 руб. сутки. Звоните +7 900 000 00 48, забронируйте свой отдых прямо сейчас.`,
    expectedSubtype: 'PROPERTY_AGENT',
    reviewRecommended: false,
    expectedSignals: ['property-agent:посуточная-аренда', 'transaction:price', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'realtor max group directory from six hour clear sweep',
    text: `Агрегатор риелторов: еще 31 группа. Платим комиссию, запросы и районы города. Кирилла Россинского https://max.ru/join/example1 Восточка https://max.ru/join/example2`,
    expectedSubtype: 'CHANNEL_PLACEMENT',
    reviewRecommended: false,
    expectedSignals: ['channel-placement:realtor-group-directory', 'deal-channel:link'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'debt relief legal lead from six hour clear sweep',
    text: `Жизнь без долгов реально. Предлагаю поддержку и помощь в списании долгов любой сложности с сохранением жилья, пенсий и автомобиля. Телефон WhatsApp Telegram +7 900 000 00 49, заполните анкету и мы свяжемся.`,
    expectedSubtype: 'SERVICES',
    reviewRecommended: false,
    expectedSignals: ['risk:debt-relief-service', 'service-specialty:debt-relief-service'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'speech therapy classes from six hour clear sweep',
    text: `Индивидуальные занятия с логопедом для детей от 2 лет: диагностика, запуск речи, коррекция звукопроизношения, подготовка к школе. Звоните +7 900 000 00 50, скидки на летние занятия.`,
    expectedSubtype: 'SERVICES',
    reviewRecommended: false,
    expectedSignals: ['service-specialty:speech-therapy-lessons', 'promo:скидк'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'hotel houseman recruitment from six hour clear sweep',
    text: `Срочно в уютный отель ищем хаусмена-разнорабочего. Зарплата от 105000 ₽ в месяц, график 6/1, принимаем без опыта, питание и форма. Обращаться WhatsApp Telegram +7 900 000 00 51.`,
    expectedSubtype: 'RECRUITMENT',
    reviewRecommended: false,
    expectedSignals: ['recruitment:ищет-команду', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'commercial cleaning service with bare seven phone from six hour clear sweep',
    text: `Клининг любой сложности: уборка после ремонта, спецуборка, генеральная уборка, мойка окон и фасадов. Сотрудничаем с коммерческими объектами, юрлицами и физлицами. Телефон 7 987 639 00 19.`,
    expectedSubtype: 'SERVICES',
    reviewRecommended: false,
    expectedSignals: ['service-specialty:клининг', 'service-specialty:уборк', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'cargo moving service from six hour clear sweep',
    text: `Грузоперевозки по РФ и обратно. Газель до 2 тонн, грузчики, домашние и офисные переезды, стройматериалы, быстро и аккуратно. Телеграм +7 900 000 00 52.`,
    expectedSubtype: 'SERVICES',
    expectedSignals: [
      'service-specialty:грузоперевоз',
      'service-specialty:logistics-delivery',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'self service coffee machine commercial equipment from six hour audit',
    text: `Продам кофе машину самообслуживания с платёжной системой. Полностью обслужена, готова к работе. Все вопросы в лс. +7 900 000 00 53.`,
    expectedSubtype: 'GOODS_RETAIL',
    reviewRecommended: false,
    expectedSignals: ['goods-retail:commercial-equipment', 'intent:продам', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'repair service with tg handle and price range recall pack',
    text: `Ремонт холодильников на дому. Диагностика, заправка, замена компрессора, гарантия. Цены от 1500. Пишите tg master_holod или в личные сообщения.`,
    expectedSubtype: 'SERVICES',
    expectedSignals: [
      'service-specialty:ремонт',
      'service-specialty:appliance-repair',
      'contact:handle',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'retail preorder with shortlink recall pack',
    text: `Предзаказ кроссовок. Размеры 36/37/38/39/40, цвета на выбор, доставка по России. Цены от 3900. Каталог: clck.ru/example`,
    expectedSubtype: 'GOODS_RETAIL',
    reviewRecommended: false,
    expectedSignals: ['transaction:price', 'goods-retail:order-flow', 'deal-channel:link'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'loan leadgen with masked phone recall pack',
    text: `Займ онлайн без отказа до зарплаты. Быстрое одобрение заявки, пишите сразу. Телефон +7 900 *** 12 34.`,
    expectedSubtype: 'GOODS',
    reviewRecommended: false,
    expectedSignals: ['risk:loan-leadgen', 'contact:masked-phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'short tile and finishing service from three hour audit',
    text: `+7 900 000 00 57 Валерий. Плитка и отделочные работы.`,
    expectedSubtype: 'SERVICES',
    expectedSignals: [
      'service-specialty:плитк',
      'service-specialty:отделочн',
      'service-specialty:tile-finishing-works',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'split system cleaning service from three hour audit',
    text: `Ваш кондиционер пахнет неприятно? Выполним чистку и заправку сплит-систем. Звоните +7 900 000 00 58.`,
    expectedSubtype: 'SERVICES',
    expectedSignals: ['service-specialty:appliance-repair', 'contact:звоните', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 54,
      commercialAdsDeleteThreshold: 74,
    },
  },
  {
    label: 'livestock buyout from three hour audit',
    text: `Куплю коров, телок, бычков. Вынужденный забой КРС. Звоните +7 900 000 00 59.`,
    expectedSubtype: 'BUYOUT',
    expectedSignals: ['buyout:livestock-buyout', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 60,
      commercialAdsDeleteThreshold: 82,
    },
  },
  {
    label: 'damaged auto buyout from three hour audit',
    text: `Куплю для личных нужд автомобиль Лада, можно не на ходу, после ДТП. Ватсаап, MAX, звонки +7 900 000 00 60.`,
    expectedSubtype: 'BUYOUT',
    expectedSignals: ['buyout:damaged-auto-buyout', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'remote daily pay funnel from three hour audit',
    text: `СРОЧНЫЙ НАБОР: УДАЛЕНКА. Оплата до 3500 ₽ ежедневно. Пиши по ссылке https://example.com/start`,
    expectedSubtype: 'RECRUITMENT',
    expectedSignals: [
      'recruitment:remote-network-work',
      'transaction:price',
      'contact:recruitment-response-keyword',
      'deal-channel:link',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'hr chat recruiter funnel from three hour audit',
    text: `МЕНЕДЖЕР ПО ПОДБОРУ ПЕРСОНАЛА. Работа с чатами и откликами, обучение. Пиши СТАРТ.`,
    expectedSubtype: 'RECRUITMENT',
    expectedSignals: ['recruitment:hr-chat-recruiter', 'contact:recruitment-response-keyword'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'pest control service with unicode hyphen phone from three hour audit',
    text: `ДЕЗИНСЕКЦИЯ / ДЕЗИНФЕКЦИЯ / ДЕРАТИЗАЦИЯ. Уничтожение клопов, тараканов, грызунов. Звоните +7 900‑000‑00‑61.`,
    expectedSubtype: 'SERVICES',
    expectedSignals: [
      'service-specialty:дезинсекц',
      'service-specialty:дезинфекц',
      'service-specialty:дератизац',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'cosmetic removal service from three hour audit',
    text: `Удаляем капилляры, сосудистые звездочки, папилломы и бородавки. Запись по телефону +7 900 000 00 62.`,
    expectedSubtype: 'SERVICES',
    expectedSignals: ['intent:specialist-self-work', 'service-specialty:капилляр', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'garden treatment service from three hour audit',
    text: `Проведу обработку вашего участка от клещей и комаров. Цены договорные, пишите или звоните +7 900 000 00 63.`,
    expectedSubtype: 'SERVICES',
    expectedSignals: ['intent:specialist-self-work', 'service-specialty:клещ', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'delivery platform onboarding from three hour audit',
    text: `ЯНДЕКС ЕДА. ПОДКЛЮЧЕНИЕ https://example.com/eats`,
    expectedSubtype: 'SERVICES',
    expectedSignals: ['service-specialty:delivery-platform-onboarding', 'deal-channel:link'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'paid wellness menu from three hour audit',
    text: `Продам меню правильного питания для похудения. Цена 200 р. Ватсап или телеграм +7 900 000 00 64.`,
    expectedSubtype: 'GOODS',
    expectedSignals: ['intent:продам', 'business:wellness-menu-product', 'transaction:price'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'exclusive broker flat listing from three hour audit',
    text: `Экс. ЖК Самолет. Квартира 1 к.к, ремонт, мебель, сейф в объекте. Цена 6 500 000 ₽. Звоните +7 900 000 00 65.`,
    expectedSubtype: 'PROPERTY_AGENT',
    expectedSignals: [
      'property-agent:экс-витрина',
      'property-agent:сейф-в-объекте',
      'transaction:price',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'rental room business property from three hour audit',
    text: `Продается жилой дом с номерами для сдачи, готовый арендный бизнес. Цена 12 000 000 ₽. Телефон +7 900 000 00 66.`,
    expectedSubtype: 'PROPERTY_COMMERCIAL',
    expectedSignals: [
      'property-commercial:rental-room-business',
      'transaction:price',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'rental rooms property sale from three hour audit',
    text: `ПРОДАМ Голубицкая, два жилых дома на участке. На территории 4 номера для сдачи, гараж, летние санузлы. Один собственник, документы готовы. Звоните, торг уместен +7 900 000 00 68.`,
    expectedSubtype: 'PROPERTY_COMMERCIAL',
    expectedSignals: [
      'property-commercial:rental-room-business',
      'contact:phone',
      'combo:property-commercial+deal',
    ],
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 55,
      commercialAdsDeleteThreshold: 76,
    },
  },
  {
    label: 'broker basement studio commercial use from three hour audit',
    text: `Большая студия 31 м2 на Комарова. Цоколь, по документам жилое, отдельный вход, можно использовать как коммерцию. Под ремонт, на ключах. Цена 2 100 000. Денис +7 900 000 00 69.`,
    expectedSubtype: 'PROPERTY_AGENT',
    expectedSignals: ['property-agent:на-ключах', 'contact:phone', 'combo:property-agent+deal'],
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 65,
    },
  },
  {
    label: 'plant nursery shipping stock from three hour audit',
    text: `Предлагаю двухлетние саженцы черной, красной, белой смородины и крыжовника, закрытая корневая, сорта разные. Самовывоз, отправка почтой, Озон, Яндекс. Виктор +7 900 000 00 70.`,
    expectedSubtype: 'GOODS_RETAIL',
    expectedSignals: [
      'goods-retail:plant-nursery-stock',
      'goods-retail:plant-nursery-shipping',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 65,
    },
  },
  {
    label: 'mixed-script clearance stock retail from three hour audit',
    text: `Раcпрoдажa остатки товаpов всё по низкoй цeнe, цена от 30 pуб до 190 pуб. Всё нoвoе, можно оптом, можно по рoзницу, подарочные боксы. Пишите, отвечу на вопросы.`,
    expectedSubtype: 'GOODS_RETAIL',
    expectedSignals: [
      'goods-retail:clearance-stock-retail',
      'transaction:keywords',
      'combo:goods-retail+deal',
    ],
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 52,
      commercialAdsDeleteThreshold: 72,
    },
  },
  {
    label: 'mixed-script clearance gift boxes from three hour audit',
    text: `Раcпрoдажa остатки товаpов вcё по низкoй цeнe ценa oт 30 pуб до 190 pуб Bcё нoвoе срoки в нopме можно оптом мoжнo пo рoзницу нaпишитe отвeчу нa любые интepеcующие вопpocы Также мoжно coбиpать пoдaрочныe бoкс в пoдaрочнoй кoрoбкe+наполнитель. Подарочный Набор боксы по вашему пожеланиям. Пишите отвечу на все интересующие вопросы.`,
    expectedSubtype: 'GOODS_RETAIL',
    expectedSignals: [
      'goods-retail:clearance-stock-retail',
      'transaction:keywords',
      'combo:promo+deal',
    ],
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 52,
      commercialAdsDeleteThreshold: 72,
    },
  },
  {
    label: 'balanced furniture store weekend sale from 24 hour audit miss',
    text: `Крутое предложение в эти выходные. Мебель ОптТорг. Успейте обновить интерьер по выгодным ценам: диваны от 20 999 руб, кровати от 6000 руб, матрасы и спальные гарнитуры до 45%. Количество акционных моделей ограничено. Пишите, звоните и приезжайте для заказа и уточнения сроков доставки. Телефон +7 900 000 00 71.`,
    expectedSubtype: 'GOODS_RETAIL',
    expectedSignals: ['goods-retail:furniture-retail-sale', 'transaction:price', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 50,
      commercialAdsDeleteThreshold: 70,
    },
  },
  {
    label: 'balanced incubation egg farm order from 24 hour audit miss',
    text: `Набираю заказ на инкубационное яйцо бройлера Росс 308 на 5 июня, вывод проверен не ниже 80%. Яйцо загрязненное - цена 55₽. Утром получаем напрямую с фабрики свежее, после обеда передаем вам. Звоните +7 900 000 00 72.`,
    expectedSubtype: 'GOODS_RETAIL',
    expectedSignals: ['goods-retail:poultry-farm-order', 'transaction:price', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 65,
    },
  },
  {
    label: 'balanced yard cleanup service from 24 hour audit miss',
    text: `Группа занимается спилом деревьев, работаем быстро и качественно, любой сложности. Также покос травы, разбор старых построек, копка ям и траншей, вывоз мусора, чистка участков. Пенсионерам скидка. Звоните в любое удобное время, номер +7 900 000 00 73.`,
    expectedSubtype: 'SERVICES',
    expectedSignals: [
      'intent:занимаюсь-услугами',
      'service-specialty:yard-cleanup-service',
      'contact:phone',
    ],
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 57,
      commercialAdsDeleteThreshold: 77,
    },
  },
  {
    label: 'balanced paving landscaping company from 24 hour audit miss',
    text: `Компания Профблагоустройство предлагает услуги: асфальтирование ангаров, площадок, дорожек любой сложности, укладка брусчатки, установка бордюра, бетонирование отмостки и площадок. Выезд на замер и консультация бесплатно. Пенсионерам скидка 10%. Телефон +7 900 000 00 74.`,
    expectedSubtype: 'SERVICES',
    expectedSignals: ['intent:занимаюсь-услугами', 'service-specialty:бетон', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 57,
      commercialAdsDeleteThreshold: 77,
    },
  },
  {
    label: 'paid wildberries review work from 24 hour audit miss',
    text: `Платим 3500₽ за отзыв на Wildberries. Свободный график, ежедневные задания, без опыта и вложений. Выдаем аванс и товар в подарок. Чтобы начать, пишите плюс в чат: https://example.com/wb-review`,
    expectedSubtype: 'RECRUITMENT',
    expectedSignals: [
      'risk:paid-review-task',
      'recruitment:marketplace-review-work',
      'deal-channel:link',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'homemade pork order delivery from 24 hour audit miss',
    text: `Мяско домашнего порося любой кусочек по вашему желанию. Телефон +7 900 000 00 75, заказ в личку, доставка и самовывоз Хабаровск.`,
    expectedSubtype: 'GOODS_RETAIL',
    expectedSignals: ['goods-retail:home-food-order', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 42,
      commercialAdsDeleteThreshold: 60,
    },
  },
  {
    label: 'poultry factory broiler retail from 24 hour audit miss',
    text: `Добрый день. Реализация бройлеров Росс 308 продолжается. Возраст 22 дня, средний вес 1200 гр. Цена 300₽. С уважением, Илишевская птицефабрика. Контакты для связи +7 900 000 00 76.`,
    expectedSubtype: 'GOODS_RETAIL',
    expectedSignals: ['goods-retail:poultry-farm-order', 'transaction:price', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 47,
      commercialAdsDeleteThreshold: 67,
    },
  },
  {
    label: 'balanced contract military recruitment from 24 hour audit miss',
    text: `Войска беспилотных систем по контракту с МО РФ. ЗП от 210 000 рублей за календарный месяц, проживание, питание и билеты. Оформление из разных регионов России. Звоните +7 900 000 00 77, Андрей.`,
    expectedSubtype: 'RECRUITMENT',
    expectedSignals: ['recruitment:контрактная-служба-мо', 'transaction:price', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 55,
      commercialAdsDeleteThreshold: 76,
    },
  },
  {
    label: 'rental helper service from 24 hour audit miss',
    text: `Срочно нужна квартира или дом в Казани? Помогу снять или сдать. Посуточно или на долгий срок, квартиры и дома по всему городу. Без предоплат и комиссий заранее, понравилось - едем на заселение, договор и оплата услуг сразу. Звоните +7 900 000 00 78, много эксклюзивных объектов.`,
    expectedSubtype: 'PROPERTY_AGENT',
    expectedSignals: ['property-agent:помогу-снять-сдать', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 65,
    },
  },
  {
    label: 'homemade salad meat order from 24 hour audit miss',
    text: `Оливье с домашним мяском вкуснее чем в ресторане. Телефон +7 900 000 00 79, заказ в личку, доставка и самовывоз Хабаровск, 100р/100гр.`,
    expectedSubtype: 'GOODS_RETAIL',
    expectedSignals: ['goods-retail:home-food-order', 'transaction:price', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 42,
      commercialAdsDeleteThreshold: 60,
    },
  },
  {
    label: 'accounting subscription service from recall regression pack',
    text: `Бухгалтер для ИП и ООО. Отчётность, декларации, налоги, кадровый учет. Абонентское обслуживание от 3000 руб. +7 900 000 00 92.`,
    expectedSubtype: 'SERVICES',
    expectedSignals: ['service-specialty:accounting-service', 'transaction:price', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'yandex direct contextual ads service from recall regression pack',
    text: `Настрою Яндекс Директ и контекстную рекламу. Аудит бесплатно, заявки уже через неделю. Пишите https://max.ru/u/directolog`,
    expectedSubtype: 'SERVICES',
    expectedSignals: [
      'service-specialty:digital-service',
      'service-specialty:promotion-service',
      'deal-channel:link',
    ],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'medical center service avoids buyout subtype from fp regression pack',
    text: `Медицинский центр: УЗИ, анализы, прием терапевта и невролога. Скидка 15%, запись +7 900 000 00 93.`,
    expectedSubtype: 'SERVICES',
    expectedSignals: ['service-specialty:medical-service', 'promo:скидк', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'scrap metal buyout contextual priem from recall regression pack',
    text: `Приём металлолома, цветной и черный металл. Расчет сразу, выезд, звоните +7 900 000 00 94.`,
    expectedSubtype: 'BUYOUT',
    expectedSignals: ['buyout:scrap-metal-buyout', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'truck spare parts retail from fourteen hour audit miss',
    text: `Продам запчасти грузовые. Рессоры FAW J6, амортизаторы, бортовые, генератор, стартер. Новые, цена от 5000 руб. Телефон +7 900 000 00 95.`,
    expectedSubtype: 'GOODS_RETAIL',
    expectedSignals: ['goods-retail:auto-parts-retail', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'multi object flora residential showcase from fourteen hour audit miss',
    text: `ЖК Флора. Студия 24 м2 цена 3.450.000, квартира 32 м2 цена 4.250.000, студия 28 м2 цена 3.900.000. Звоните +7 900 000 00 96.`,
    expectedSubtype: 'PROPERTY_AGENT',
    expectedSignals: ['property-agent:витрина-объектов-прайс', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'bath tub retail subtype guard from fourteen hour audit',
    text: `Банный чан из нержавеющей стали. Цена за полный комплект, доставка, гарантия. Телефон +7 900 000 00 97.`,
    expectedSubtype: 'GOODS_RETAIL',
    expectedSignals: ['goods-retail:bath-tub-retail', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'electromontage service procurement wording from fourteen hour audit',
    text: `Все виды электромонтажных работ, помощь закупки материалов, розетки, автоматы, щитки. Телефон +7 900 000 00 98.`,
    expectedSubtype: 'SERVICES',
    expectedSignals: ['service-specialty:электромонтаж', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'livestock procurement still detected after generic zakup tightening',
    text: `Закуп КРС и МРС: коровы, быки, телята, овцы. Расчет сразу, выезд по району. Телефон +7 900 000 00 99.`,
    expectedSubtype: 'BUYOUT',
    expectedSignals: ['buyout:livestock-procurement', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
];

export const COMMERCIAL_REAL_WORLD_NEGATIVE_CASES: CommercialRealWorldNegativeCase[] = [
  {
    label: 'owner rental listing with repair and phone from production logs',
    text: `Сдаётся уютная 2х комнатная квартира в районе МКК. В квартире хороший ремонт, застеклённый балкон, вся мебель и техника в наличии. Сдаётся на длительный срок ответственным арендаторам. +7 900 000 00 10.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'private rental listing with repair mention from production logs',
    text: `Сдам в пгт Афипском, в новом доме, в центре просторную 1к кв, общая площадь 45 м2, большая кухня, комната 25 м2, балкон есть, мебель, техника, в хорошем состоянии, сделан качественный ремонт, есть интернет. Цена 30 т.р., коммунальные услуги включены. Звоните, покажем в любое время. +7 900 000 00 11.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'private house listing with septic and family mortgage from production logs',
    text: `г. Краснодар. Дом 85 м2. Участок 3 сотки. Свет 15 кВт. Септик. Скважина. Газ по меже. Семейная ипотека подходит. Цена 8 900 000. +7 900 000 00 12.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'service recommendation request from production logs',
    text: `Здравствуйте, кто ремонтирует стиральные машинки-автомат? Напишите, пожалуйста, в личные сообщения.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'single clothing item with size and doorstep delivery from production logs',
    text: `Бомбер как куртка, размер 44, 1200р. Возможна доставка до подъезда.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'single apparel item with measurements from production logs',
    text: `Новый, размер указан 52, маломерит. 1300р, подробные замеры могу отправить по запросу. Возможна доставка до подъезда.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'single stroller resale with phone from production logs',
    text: `Продам детскую коляску, после одного ребенка, в отличном состоянии, без дефектов. Цена 12 000 ₽, торг уместен. +7 900 000 00 16.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'two used scooters resale with phone from production logs',
    text: `Продам два самоката, б/у, после одного ребенка, в хорошем состоянии. Один 4000р, второй 3500р. Торг уместен. +7 900 000 00 18.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'wellness diary note from production audit without direct deal channel',
    text: `Завтра быстрый и вкусный завтрак: огурец, зелень, сыр, яйцо, греческий йогурт. После завтрака коллаген. Сегодня снова записи по самочувствию и питанию, без боли и без отеков.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'private apartment sale with repeated phone from production audit',
    text: `Продаю, недорого 3х комнатную квартиру в селе Подлужном вопросы только по телефону +7 900 000 00 21`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'private owner apartment sale with any payment and questions by phone from twelve hour audit guard',
    text: `Продаю квартиру в селе Подлужном изобильненского района ставропольского края, в квартире 3 комнаты, ванная, кухня, веранда, все коммуникации, отдельно земельный участок 4 сотки, документы на квартиру и участок есть, срочно, недорого, небольшой торг, собственник, любой вид оплаты .На сообщения не отвечает все вопросы только по телефону +7 900 000 00 24`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'short low quantity plant lamp listing from production audit',
    text: `Фитолампа для комнатных растений, в наличии 2 шт, по 500 р каждая. +7 900 000 00 22`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'ride share driver seat from last six hour audit',
    text: `Водитель 29.05.26 ст. АСКИЗ-АБАКАН и обратно, с места до места, выезд со станции 8.30 + 30 мин. Звоните +7 900 000 00 29, есть 1 место.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'fruit delivery request from last six hour audit',
    text: `Здравствуйте, нужна доставка на Подгорбунского, 62. Четыре ящика черешни.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'single private dog feeding stand sale from last six hour audit',
    text: `Продам подставку для кормления собак. Цена 500 рублей.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'ordinary no-link invite without commercial deal from clear sweep guard',
    text: `Приглашаем соседей в чат дома обсудить субботник и график уборки подъезда.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'private single shoes sale with phone from six hour false-positive guard',
    text: `Продам новые женские лакированные туфли Renaissance черного цвета, 41 размер, за 3000 р. Писать в личку или по телефону +7 900 000 00 43.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'travel agency recommendation request from six hour false-positive guard',
    text: `Подскажите хорошее турагентство для семейной поездки, кто уже летал и остался доволен?`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'insurance recommendation request from six hour false-positive guard',
    text: `Кто оформлял ОСАГО онлайн, подскажите нормальный сервис без переплат?`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'buyer availability question from six hour false-positive guard',
    text: `Здравствуйте, черешня есть в наличии. Можно подъехать?`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'private bed chair with banquette from six hour false-positive guard',
    text: `Продам кресло-кровать и банкетку в комплекте. Есть отдел для постельного, цена 7000 рублей.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'private single sofa sale with delivery from six hour false-positive guard',
    text: `Продам диван за 10000 ₽, возможна доставка. Все вопросы по телефону +7 900 000 00 44.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'private land sale with cadastral price from six hour false-positive guard',
    text: `Продам земельный участок под ИЖС 7,39 соток. Цена кадастровая 200 тыс руб, телефон +7 900 000 00 54.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'private sofa sale with delivery from six hour historical false positive guard',
    text: `Продам диван 🛋️ 10.000₽, ДОСТАВКА 🚚 Всё вопросы по телефону ⬇ +79000000055 ТОЛЬКО ЗВОНИТЬ ПО ТЕЛЕФОНУ❗`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 42,
      commercialAdsDeleteThreshold: 60,
    },
  },
  {
    label: 'private swim mattress sale with discount from six hour historical false positive guard',
    text: `Продам матрасы для плавания. Хвост русалки 194*101 и аудио-кассета 174*117. Новые, в упаковке. Цена 2000 руб каждый. При покупке обоих скидка 500 руб Михайловск, Гармония 89000000056`,
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 53,
      commercialAdsDeleteThreshold: 73,
    },
  },
  {
    label: 'private one off bicycle sale with shortlink false positive guard',
    text: `Продам свой детский велосипед б/у после одного сезона. Цена 3500 руб, самовывоз. Фото тут: clck.ru/private-bike`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'private working fridge sale from three hour false positive guard',
    text: `Продам холодильник рабочий по вопросам пишите в л/с или звоните`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'recommendation request with tg handle false positive guard',
    text: `Посоветуйте мастера по холодильникам, пожалуйста. Нашла tg holod_master, кто-нибудь обращался, нормальный специалист?`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'private shorthand apartment sale with repair from three hour false-positive guard',
    text: `КМР ПМР Комсомольский Пашковский ул. Лавочкина, 3. Монолит кирпич, 7/7 эт., без лифта. Дом 2012 г. 1 к.ка 35 м2, ремонт, мебель. 3 450 000 ₽, вся сумма в ДКП. Елена +7 900 000 00 67. Звоните, на смс долго отвечаю.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'private taiga land owner listing from 24 hour false-positive guard',
    text: `Продается земельный участок в живописном таежном месте деревни Кижа, на берегу водохранилища. Площадь 60 соток, кадастровый номер указан, есть дом с постройками, школа и магазины в деревне. Я собственник, цена и подробности по телефону +7 900 000 00 80.`,
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 65,
    },
  },
  {
    label: 'private single stand sale with phone from 24 hour false-positive guard',
    text: `Продам подставку под емкость, ширина 1,25, длина 2,05, высота 50 см. Цена 3000₽. Звоните по номеру +7 900 000 00 81.`,
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 57,
      commercialAdsDeleteThreshold: 77,
    },
  },
  {
    label: 'private soviet faucet sale from 24 hour false-positive guard',
    text: `Продается смеситель новый, СССР, без душа, цена 800₽. Только звонить +7 900 000 00 82.`,
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 49,
      commercialAdsDeleteThreshold: 69,
    },
  },
  {
    label: 'private leather clutch sale from 24 hour false-positive guard',
    text: `Продается мужской клатч кожаный, цвет черный, новый, КНР, 18 отделений для карт и отделение на молнии. Цена 1600₽. На сообщения не отвечаю, только звонить +7 900 000 00 83.`,
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 49,
      commercialAdsDeleteThreshold: 69,
    },
  },
  {
    label: 'private aluminum flasks sale from 24 hour false-positive guard',
    text: `Продаю фляги 40 литровые алюминиевые, была вода, состояние хорошее. В наличии 4 штуки, цена 2000 руб одна. Телефон +7 900 000 00 84.`,
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 60,
      commercialAdsDeleteThreshold: 82,
    },
  },
  {
    label: 'private owner cottage sale from 24 hour false-positive guard',
    text: `Продается коттедж в центре Байкальска, 3 этажа, кирпичный дом, центральные сети, баня, бассейн, теплица и насаждения. 20 млн. Собственник +7 900 000 00 85.`,
    overrides: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 65,
    },
  },
  {
    label: 'office rent search request from edge-case false-positive guard',
    text: `Сниму офис или кабинет для занятий на пару дней в неделю, недорого. Контакты можно в лс.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'office coworking recommendation request from edge-case false-positive guard',
    text: `Подскажите, кто сдаёт офис или переговорку для коворкинга на пару часов? Нужен проверенный вариант.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'spaced letters private bicycle sale from edge-case false-positive guard',
    text: `П Р О Д А М свой велосипед б/у после одного сезона. Цена 3500 руб, самовывоз.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'punctuated letters private sofa sale from edge-case false-positive guard',
    text: `П.Р.О.Д.А.М свой диван б/у после переезда. Цена 8000 руб, самовывоз.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'accountant recommendation request from false-positive regression pack',
    text: `Посоветуйте бухгалтера для ИП, кто хорошо сдаёт отчетность?`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'yandex direct recommendation request from false-positive regression pack',
    text: `Кто настраивал Яндекс Директ, подскажите нормального специалиста?`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'medical center recommendation request from false-positive regression pack',
    text: `Кто знает хороший медицинский центр для УЗИ?`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'plain medical appointment queue from false-positive regression pack',
    text: `Прием у врача задержали на 40 минут, кто сейчас в очереди?`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'non promotional accounting report mention from false-positive regression pack',
    text: `Бухгалтер сдал отчетность, декларации и налоги вчера, можно больше не переживать.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'private child shirt sale from twelve hour clear audit guard',
    text: `Новая детская футболка лонгслив Синсей, размер 128. Цена 300 ₽. Томск. Пишите в ЛС.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'private owner vehicle sale from twelve hour clear audit guard',
    text: `Улан-Удэ. Продам Тойота 2007 год, собственник я. Машина без вложений, ходовая обслуженная. Цена 650000 ₽, телефон +7 900 000 00 99.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'private lamb sale from twelve hour clear audit guard',
    text: `Продам овечку эдильбаевской породы, возраст 11 месяцев. Цена 22000 руб. Тюменская область, Ялуторовск. Телефон +7 900 000 01 00.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'private one off clothes size listing from twelve hour clear audit guard',
    text: `Костюм двойка. Цена 1850 руб. Размеры 44, 46, 48, 50, 52, 54. Материал сингапур.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'delivery discussion in private messages from fourteen hour audit guard',
    text: `Эта доставка мне в личку пишет.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'long delivery complaint from fourteen hour audit guard',
    text: `Я писала выше, что на доставке она мне в личку ещё звонит, адрес знает, потом всё удалили после разборки.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'private one off shoes resale from fourteen hour audit guard',
    text: `Продам полусапожки весна осень, размер 38, состояние отличное - 1300 руб.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'repeated private children clothes resale from fourteen hour audit guard',
    text: `Продам детские вещи: куртка р-р 122 сост. отличное 700 руб, сапоги р-р 30 сост. хорошее 500 руб, шапка 150 руб. Пишите в личку.`,
    campaignContext: {
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
    },
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'animal adoption relocation mention from fourteen hour audit guard',
    text: `Кошка ищет дом, отдают в добрые руки при переезде, пишите в личку.`,
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
];
