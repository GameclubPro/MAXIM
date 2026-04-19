import type { CommercialSubtype } from './rule-engine.service';

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
  overrides?: CommercialFixtureOverrides;
};

export type CommercialRealWorldNegativeCase = {
  label: string;
  text: string;
  overrides?: CommercialFixtureOverrides;
};

export const COMMERCIAL_REAL_WORLD_POSITIVE_CASES: CommercialRealWorldPositiveCase[] = [
  {
    label: 'remote perfumery recruitment from production logs',
    text: `🙋‍♀️ Ищу девушку или женщину для работы с парфюмом. В парфюмерную компанию ESSENS на удалённую работу, подработку. Прямой доход от 1000 ₽ с одного флакона духов сразу на руки плюс бонусы. Работа онлайн по всей России. Всегда актуальные вакансии. Пишите на номер +7 900 000 00 01, пришлю ссылку на группу.`,
    expectedSubtype: 'RECRUITMENT',
    reviewRecommended: false,
    expectedSignals: ['recruitment:ваканси', 'recruitment:подработк', 'transaction:price', 'contact:phone'],
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
    expectedSignals: ['recruitment:ваканси', 'recruitment:смена', 'contact:по телефону', 'contact:phone'],
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
    expectedSignals: ['intent:продажа', 'service-specialty:установк', 'group-trade:продажа', 'contact:phone'],
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
    expectedSignals: ['intent:услуги', 'service-specialty:уборк', 'contact:phone', 'deal-channel:link'],
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
    expectedSignals: ['property-agent:комиссия-сверху', 'property-agent:на-ключах', 'property-agent:показ-247', 'transaction:price'],
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
    expectedSignals: ['intent:продажа', 'property-agent:комиссия-сверху', 'transaction:price', 'contact:phone'],
    overrides: {
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  },
  {
    label: 'bike sales with delivery from production logs',
    text: `В продаже новые велосипеды. Цены от 15 000 р. Возможна доставка. В наличии разные размеры и цвета. Пишите или звоните, отвечу на все вопросы, скину подробные фото и видео. Телефон +7 900 000 00 08.`,
    expectedSubtype: 'GOODS',
    reviewRecommended: true,
    expectedSignals: ['promo:доставк', 'promo:в наличии', 'contact:phone', 'combo:contact+price'],
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
];
