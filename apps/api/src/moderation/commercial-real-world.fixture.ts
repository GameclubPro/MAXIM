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
    expectedSignals: ['channel-placement:invite-to-channel', 'group-promo:приглашаем', 'deal-channel:link'],
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
    expectedSignals: ['property-agent:агентство-недвижимости', 'transaction:price', 'contact:phone'],
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
    expectedSignals: ['property-agent:сейф-по-запросу', 'property-agent:разбивка-цены', 'contact:phone'],
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
];
