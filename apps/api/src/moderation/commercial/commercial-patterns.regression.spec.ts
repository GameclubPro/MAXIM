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
      label: 'rehabilitation center from sixteen hour audit miss',
      text: 'Реабилитационный центр Birlik основан на миннесотской 12 шаговой программе. Гештальт терапия, арт терапия, групповая терапия, индивидуальная терапия. Мы готовы помочь, помощь анонимна. Телефон +7 900 000 02 21.',
      subtype: 'SERVICES',
      signals: ['service-specialty:rehab-center-service', 'contact:phone'],
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
      label: 'custom wood portrait service from post deploy sixteen hour audit miss',
      text: 'Портрет на дереве. Ваши фото на дереве, заготовки, подарите близким. Заказывают по телефону +7 900 000 02 06.',
      subtype: 'SERVICES',
      signals: ['intent:custom-art-order', 'service-specialty:custom-art-order', 'contact:phone'],
    },
    {
      label: 'home goods order with emoji phone from twelve hour audit miss',
      text: 'Переходите в нашу группу, где вы найдете посуду, технику и текстиль по самым низким ценам. По поводу заказа пишите по номеру 8️⃣9️⃣8️⃣9️⃣8️⃣8️⃣8️⃣2️⃣0️⃣8️⃣9️⃣',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:home-goods-low-price-order', 'contact:phone'],
    },
    {
      label: 'remote manager recruitment is not moderation discussion',
      text: 'Ищу сотрудников для работы удаленно. Управляющий/админ для сопровождения интернет магазина. Работа с рекламой, обработка входящих откликов. Подробнее пишите в Телеграмм или МАХ +7 900 000 01 05. #вакансия #работаонлайн https://max.ru/join/remote-work',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:ваканси', 'recruitment:отклик', 'contact:phone'],
    },
    {
      label: 'job-seeking hook with vacancy offer is still recruitment',
      text: 'Нужна работа? Вакансия удаленно, доход от 3000 в день, пишите в MAX https://max.ru/join/work',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:ваканси', 'recruitment:доход', 'deal-channel:link'],
      negativeSignals: ['job-seeking:job-seeking:search'],
    },
    {
      label: 'remote recruitment with roughly wording is not quoted-ad discussion',
      text: 'Открыта вакансия удаленной работы. Нужен менеджер по работе с холодной/теплой базой. Зп 17000 в месяц. Примерно час работы в день. Пишите на мой личный +7 900 000 01 06 Мах или вотсап.',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:ваканси', 'recruitment:remote-network-work', 'contact:phone'],
    },
    {
      label: 'hotel tour booking with examples wording',
      text: 'Обзор сетей отелей Voyage в Турции. Примеры туров на двоих с вылетом из Сочи - по ссылкам в MAX и Telegram. Подберу под ваши даты и город вылета. Забронировать: +7 900 000 01 07 @travelmax https://max.ru/join/tour',
      subtype: 'SERVICES',
      signals: ['service-specialty:tour-agency', 'contact:phone', 'deal-channel:link'],
    },
    {
      label: 'fish processing crew recruitment from sixteen hour audit miss',
      text: 'Требуются люди на добычу и переработку горбуши. Пишите, звоните по телефону +7 900 000 01 11.',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:people-work-conditions', 'contact:phone'],
    },
    {
      label: 'no investment remote work from sixteen hour audit miss',
      text: 'ИЩУ ЛЮДЕЙ ДЛЯ РАБОТЫ БЕЗ ВЛОЖЕНИЙ. Выплаты ежедневно от 5000. https://max.ru/join/work',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:people-work-conditions', 'recruitment:remote-network-work'],
    },
    {
      label: 'bank project staff recruitment from sixteen hour audit miss',
      text: 'В банковский проект набираются сотрудники. Зп от 15-35 тыс. Телефон +7 900 000 01 12.',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:people-work-conditions', 'contact:phone'],
    },
    {
      label: 'online lottery bonus from sixteen hour audit miss',
      text: 'Выигрыш до 10 000 ₽ в онлайн-лотерее. Стартовый баланс, играете и выигрываете. https://max.ru/join/game',
      subtype: 'GOODS',
      signals: ['risk:online-lottery-bonus', 'deal-channel:link'],
    },
    {
      label: 'clairvoyant paid service from sixteen hour audit miss',
      text: 'Опытная ясновидящая, делаю диагностику ситуации, предсказываю. Связаться Max WhatsApp Telegram.',
      subtype: 'GOODS',
      signals: ['risk:paid-esoteric-service', 'contact:whatsapp', 'contact:telegram'],
    },
    {
      label: 'photo restoration digital service from sixteen hour audit miss',
      text: 'Восстановление старых ч/б фото в цвете онлайн. 150 р. за 1 фото. +7 900 000 01 13.',
      subtype: 'SERVICES',
      signals: ['service-specialty:digital-service', 'contact:phone'],
    },
    {
      label: 'mosquito net installation from sixteen hour audit miss',
      text: 'МОСКИТНЫЕ СЕТКИ. Замеры, Изготовление, Установка. Пишите в ЛС.',
      subtype: 'SERVICES',
      signals: ['service-specialty:mosquito-net-service', 'contact:пишите в лс'],
    },
    {
      label: 'fence and gate installation from sixteen hour audit miss',
      text: 'Установим забор и ворота, монтаж откатных ворот. Бесплатно проконсультирую. +7 900 000 01 14.',
      subtype: 'SERVICES',
      signals: ['intent:fence-gate-installation', 'contact:phone'],
    },
    {
      label: 'clothing repair service from sixteen hour audit miss',
      text: 'Ремонт одежды. тел. +7 900 000 01 15.',
      subtype: 'SERVICES',
      signals: ['service-specialty:clothing-repair-service', 'contact:phone'],
    },
    {
      label: 'custom address signs from sixteen hour audit miss',
      text: 'Принимаем заявки на адресные таблички. Магазин Три кота.',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:custom-sign-order', 'transaction:keywords'],
    },
    {
      label: 'realtor commission rental from sixteen hour audit miss',
      text: 'Сдам однокомнатную квартиру. Риэлторская комиссия оплачивается по факту заселения. +7 900 000 01 16.',
      subtype: 'PROPERTY_AGENT',
      signals: ['property-agent:риэлторская-комиссия', 'contact:phone'],
      negativeSignals: ['private:property-sale'],
    },
    {
      label: 'rental commission percent from sixteen hour audit miss',
      text: 'Аренда дома. Цена:35000 Без залога Комиссия 60% Тел +7 900 000 01 17.',
      subtype: 'PROPERTY_AGENT',
      signals: ['property-agent:комиссия-процент', 'contact:phone'],
      negativeSignals: ['private:property-sale'],
    },
    {
      label: 'strawberry order from sixteen hour audit miss',
      text: 'Принимаю заказ на клубничку. Цена 250 руб килограмм. Бесплатная доставочка. +7 900 000 01 18.',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:wholesale-produce', 'contact:phone'],
    },
    {
      label: 'laying hens retail from sixteen hour audit miss',
      text: 'В продаже куры несушки. Цена 500р. от 10шт бесплатная доставка. +7 900 000 01 19.',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:farm-livestock-retail', 'contact:phone'],
    },
    {
      label: 'fresh trout delivery from sixteen hour audit miss',
      text: 'Свежий привоз. Форель Турция. Цена 1450 -1 кг. писать в личку или по телефону +7 900 000 01 20.',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:wholesale-produce', 'goods-retail:home-food-order'],
    },
    {
      label: 'stewed beef jar delivery from sixteen hour audit miss',
      text: 'Тушёная говядина 320 баночка от пяти баночек доставкой бесплатно.',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:home-food-order', 'transaction:keywords'],
    },
    {
      label: 'peony shipping retail from sixteen hour audit miss',
      text: 'ПИОНЫ. СНАЧАЛА ОПЛАТА ПОТОМ ОТПРАВКА. по 950р. доставка. +7 900 000 01 21.',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:plant-nursery-stock', 'goods-retail:plant-nursery-shipping'],
    },
    {
      label: 'paid group mailing with emoji keycap prices from sixteen hour audit miss',
      text: '3️⃣ дня рассылка 8️⃣6️⃣0️⃣Р. 5️⃣0️⃣0️⃣ групп MAX, база групп, фото/видео отчет. Пишите в личку https://example.com/max-mailing',
      subtype: 'SERVICES',
      signals: ['risk:paid-group-mailing', 'transaction:price', 'deal-channel:link'],
    },
    {
      label: 'leaflet assembly work with spaced role from sixteen hour audit miss',
      text: 'С Б О Р Щ И К упаковка листовок. Оплата 1️⃣0️⃣ 0️⃣0️⃣0️⃣ руб, график свободный, телефон +7 900 000 02 01',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:leaflet-assembly-work', 'transaction:price', 'contact:phone'],
    },
    {
      label: 'short daily leaflet side job from post deploy sixteen hour audit miss',
      text: 'ПОДРАБОТКА каждый день — раздача листовок',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:leaflet-daily-side-job', 'contact:implicit-vacancy-offer'],
    },
    {
      label: 'wb helper vacancy from sixteen hour audit miss',
      text: 'Срочно требуется помощник для работы с WB. В день от 4500 р, без опыта, подробности https://example.com/wb-job',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:требуется', 'transaction:price', 'deal-channel:link'],
    },
    {
      label: 'legal document services from sixteen hour audit miss',
      text: 'Юридические услуги: подготовка исковых заявлений, претензий и жалоб, представительство в суде. Телефон +7 900 000 02 02',
      subtype: 'SERVICES',
      signals: ['service-specialty:legal-document-service', 'contact:phone'],
    },
    {
      label: 'collectible violet retail from sixteen hour audit miss',
      text: 'Коллекционные фиалки, детки и стартеры, список сортов. Минимальный заказ, упаковка, отправка СДЭК и почтой. 150 руб, ватсап +7 900 000 02 04',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:collectible-flower-retail', 'transaction:price', 'contact:phone'],
    },
    {
      label: 'developer house with implied million price from sixteen hour audit miss',
      text: 'Дом от застройщика в новом поселке. Подходит под семейную ипотеку, стоимость 8.5 млн, отделка, телефон +7 900 000 02 05',
      subtype: 'PROPERTY_AGENT',
      signals: ['property-agent:дом-от-застройщика', 'transaction:implied-price', 'contact:phone'],
    },
    {
      label: 'generic domain service promo from blind spot sweep',
      text: 'Новый сервис доставки еды, скидка по промокоду START. Переходите example-food.ru/menu, заказ онлайн',
      subtype: 'GOODS',
      signals: ['promo:промокод', 'deal-channel:generic-domain'],
    },
    {
      label: 'service marketplace link from blind spot sweep',
      text: 'Ремонт холодильников на дому, диагностика бесплатно, гарантия. Запись тут avito.ru/services/remont-holodilnikov',
      subtype: 'SERVICES',
      signals: ['service-specialty:appliance-repair', 'deal-channel:marketplace-service-link'],
    },
    {
      label: 'email contact service from blind spot sweep',
      text: 'Бухгалтерское сопровождение ИП и ООО, отчетность и декларации. Заявки на почту buh-office@example.com',
      subtype: 'SERVICES',
      signals: ['service-specialty:accounting-service', 'contact:email'],
    },
    {
      label: 'soft response cta service from blind spot sweep',
      text: 'Ресницы, брови, ламинирование. Свободные окошки завтра, кто хочет - ставьте плюс',
      subtype: 'SERVICES',
      signals: ['service-specialty:ресниц', 'contact:soft-response-cta'],
    },
    {
      label: 'government benefit phishing from blind spot sweep',
      text: 'Получите выплату 10000 через госуслуги, заполните анкету по ссылке clck.ru/abc123',
      subtype: 'GOODS',
      signals: ['risk:government-benefit-phishing', 'deal-channel:link'],
    },
    {
      label: 'wireless internet service from forty eight hour audit miss',
      text: 'БЕСПРОВОДНОЙ ИНТЕРНЕТ В ЧАСТНЫЙ ДОМ! Скорость до 200 мегабит. Тел.: +7 900 000 03 01. Объявление.',
      subtype: 'SERVICES',
      signals: ['service-specialty:internet-connection-service', 'contact:phone'],
    },
    {
      label: 'addiction detox service from forty eight hour audit miss',
      text: 'Отравление, похмелье. Вывод из запоя, кодировка, снятие ломки, реабилитация. Помощь анонимна, телефон +7 900 000 03 02.',
      subtype: 'SERVICES',
      signals: ['service-specialty:addiction-detox-service', 'contact:phone'],
    },
    {
      label: 'telecom connection services from forty eight hour audit miss',
      text: 'Подключение услуг РОСТЕЛЕКОМ: Интернет, Wink, видеонаблюдение, мобильная связь. Прием заявок по телефону +7 900 000 03 03. Реклама.',
      subtype: 'SERVICES',
      signals: ['service-specialty:internet-connection-service', 'contact:phone'],
    },
    {
      label: 'story channel subscription from forty eight hour audit miss',
      text: 'ДУШЕВНЫЕ ИСТОРИИ НА ВЕЧЕР. Рекомендуем Вам подписаться на канал, переходите по ссылке https://max.ru/join/story',
      subtype: 'CHANNEL_PLACEMENT',
      signals: ['channel-placement:subscribe-channel-link', 'deal-channel:link'],
    },
    {
      label: 'paid sports raffle channel from forty eight hour audit miss',
      text: 'ВНИМАНИЕ! РОЗЫГРЫШ 50.000 РУБЛЕЙ ЗА ПОДПИСКУ В КАНАЛ. Автор зарабатывает на спорте, ссылка https://max.ru/join/sport',
      subtype: 'CHANNEL_PLACEMENT',
      signals: [
        'risk:paid-raffle',
        'channel-placement:subscribe-channel-link',
        'deal-channel:link',
      ],
    },
    {
      label: 'ai fitting app promo from forty eight hour audit miss',
      text: 'Попробуй Кадрум — AI-примерку одежды, крутые нейро-фотосессии и фото для профиля. Ссылка kadrum.ai',
      subtype: 'GOODS',
      signals: ['business:ai-media-app-promo', 'deal-channel:generic-domain'],
    },
    {
      label: 'obfuscated casino landing from agent blind spot',
      text: 'К а з и н о win4land точка com, бонус за регистрацию и быстрый депозит.',
      subtype: 'GOODS',
      signals: ['risk:betting-gambling'],
    },
    {
      label: 'electronics buyout without explicit phone from agent blind spot',
      text: 'Куплю ноутбуки и айфоны в любом состоянии. Оценка сразу, выезд к вам, расчет наличными.',
      subtype: 'BUYOUT',
      signals: ['buyout:used-electronics-buyout', 'transaction:buyout-deal'],
    },
    {
      label: 'property lead magnet from agent blind spot',
      text: 'Бесплатный подбор новостроек. Квартиры от застройщика без комиссии, оставьте заявку на сайте novostroy-example.ru',
      subtype: 'PROPERTY_AGENT',
      signals: ['property-agent:новостройки-лидоген', 'deal-channel:generic-domain'],
    },
    {
      label: 'crypto investment stays high risk instead of recruitment',
      text: 'Крипто-сигналы: пассивный доход, разбор портфеля и закрытый канал. Пишите https://max.ru/join/crypto',
      subtype: 'GOODS',
      signals: ['risk:crypto-investment', 'deal-channel:link'],
    },
    {
      label: 'loan leadgen with mixed-script salary wording',
      text: 'Дeньги дo зapплaты oнлaйн, oдoбpeниe 15 минут, без отказа. Ccылкa в профиле.',
      subtype: 'GOODS',
      signals: ['risk:loan-leadgen', 'transaction:high-risk-offer', 'contact:ссылка в профиле'],
    },
    {
      label: 'p2p crypto arbitrage training leadgen',
      text: 'P2P арбитраж: связки каждый день, депозит от 5000, обучение в закрытом чате, вход по инвайту.',
      subtype: 'INFO_PRODUCT',
      signals: ['risk:p2p-crypto-arbitrage', 'transaction:high-risk-offer'],
    },
    {
      label: 'p2p crypto arbitrage invite-only chat without explicit contact',
      text: 'P2P связки каждый день, закрытый чат, вход по инвайту.',
      subtype: 'GOODS',
      signals: ['risk:p2p-crypto-arbitrage', 'transaction:high-risk-offer'],
    },
    {
      label: 'credit history leadgen with comments response',
      text: 'Кредитная история испорчена? Поможем получить деньги быстро, ответ в комментариях.',
      subtype: 'GOODS',
      signals: ['risk:loan-leadgen', 'transaction:high-risk-offer', 'contact:comments-response'],
    },
    {
      label: 'payment card drop leadgen',
      text: 'Нужны карты для приема переводов, без визита, оплата ежедневно, пишите в тг cashwork77.',
      subtype: 'GOODS',
      signals: ['risk:payment-card-drop-leadgen', 'contact:handle'],
    },
    {
      label: 'iphone repair service with casual wording',
      text: 'Чиню айфоны, меняю стекла и батареи, выезд по городу. Писать в лс.',
      subtype: 'SERVICES',
      signals: ['service-specialty:digital-service', 'contact:в лс'],
    },
    {
      label: 'pet grooming appointment service',
      text: 'Груминг собак и кошек, стрижка когтей, вычес, купание. Принимаю по записи, свободно завтра.',
      subtype: 'SERVICES',
      signals: ['service-specialty:pet-grooming-service', 'contact:по записи'],
    },
    {
      label: 'kids event animator service',
      text: 'Аниматоры на детский праздник, шоу мыльных пузырей, аквагрим. Бронируйте дату, пишите в личку.',
      subtype: 'SERVICES',
      signals: ['service-specialty:kids-event-service', 'contact:пишите в лич'],
    },
    {
      label: 'channel ad window placement slang',
      text: 'Свободные окна в кaнaлe, 24ч топ, охват живой. Статa скину, место 700р, связь @adm_rek',
      subtype: 'CHANNEL_PLACEMENT',
      signals: ['channel-placement:ad-window-top', 'transaction:price', 'contact:handle'],
    },
    {
      label: 'info product registration through form',
      text: 'Марафон по отношениям 7 дней, практики и эфиры, места ограничены, регистрация через анкету.',
      subtype: 'INFO_PRODUCT',
      signals: ['info:марафон', 'transaction:keywords'],
    },
    {
      label: 'short stay apartment booking',
      text: 'Апартаменты у моря свободны с 12 июля. До пляжа 5 минут, бронь по предоплате, календарь в личку.',
      subtype: 'PROPERTY_AGENT',
      signals: ['property-agent:посуточная-бронь-апартаментов', 'transaction:keywords'],
    },
    {
      label: 'electrical wiring service from twenty four hour audit miss',
      text: 'Замена проводки в квартире, в доме. Сборка щитов. Работы на линиях электропередачи -кВ. Выполнение устройства заземления. ☎️Тел +7 900 000 10 01.',
      subtype: 'SERVICES',
      signals: ['service-specialty:electrical-wiring-service', 'contact:phone'],
    },
    {
      label: 'ready business sale reverse price order from twenty four hour audit miss',
      text: 'Так же продается бизнес за 100000 в Саянске, готовый. Писать +7 900 000 10 02',
      subtype: 'GOODS',
      signals: ['business:business-sale', 'contact:phone'],
    },
    {
      label: 'short collectible flower retail from twenty four hour audit miss',
      text: 'Сортовые фиалки по вопросам в личку',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:collectible-flower-retail'],
    },
    {
      label: 'short flowers with unit price and phone from twenty four hour audit miss',
      text: 'Продам цветы по 15 р шт. Кинель юг +7 900 000 10 41',
      subtype: 'GOODS_RETAIL',
      signals: [
        'goods-retail:flower-herb-unit-price-retail',
        'transaction:price',
        'contact:phone',
      ],
    },
    {
      label: 'short herb unit price from twenty four hour audit miss',
      text: 'Душица лист - 90руб/мешочек',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:flower-herb-unit-price-retail', 'transaction:price'],
    },
    {
      label: 'vehicle advertising placement from twenty four hour audit miss',
      text: 'Разместим вашу рекламу на наших авто +7 900 000 10 03',
      subtype: 'SERVICES',
      signals: ['service-specialty:vehicle-ad-placement', 'contact:phone'],
    },
    {
      label: 'uzbek mixed wildberries warehouse recruitment from twenty four hour audit miss',
      text: 'WILDBERRIES МОСКОВСКАЯ ОБЛАСТЬ. Бепул яшаш жой! ТРУДОВОЙ ДОГОВОР. Сортировка товара 4000₽, ойлик маош. ТУЛИК ДОКУМЕНТ БИЛАН ИШГА ОЛАМИЗ! Мурожаат учун: Телеграм/max/ прямой. +7 900 000 10 04',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:warehouse-job-conditions', 'contact:phone'],
    },
    {
      label: 'door retail discount from twenty four hour audit miss',
      text: 'ВНИМАНИЕ! Снижение цен на все металлические и межкомнатные двери. Двери с терморазрывом от 27000 руб! Рассрочка на все без %, тел. +7 900 000 10 05',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:door-window-retail-discount', 'transaction:price'],
    },
    {
      label: 'custom song service from twenty four hour audit miss',
      text: 'Делаю полноценные песни по вашим идеям. Цена вопроса - 1000₽. Чтобы начать, просто напиши мне в личку.',
      subtype: 'SERVICES',
      signals: ['service-specialty:custom-song-service', 'transaction:price'],
    },
    {
      label: 'stretch ceiling service from twenty four hour audit miss',
      text: 'НАТЯЖНЫЕ ПОТОЛКИ -20% пенсионерам. Замер бесплатный, звони по номеру +7 900 000 10 06',
      subtype: 'SERVICES',
      signals: ['service-specialty:stretch-ceiling-service', 'contact:phone'],
    },
    {
      label: 'wood outbuilding retail from twenty four hour audit miss',
      text: 'Предлагаем вашему вниманию изделия из сухого пиломатериала: хоз блоки, беседки, уличные туалеты. Находимся в п. Центральный, ул. Промышленная 41. +7 900 000 10 07',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:wood-outbuilding-retail', 'contact:phone'],
    },
    {
      label: 'mortgage studio promo from twenty four hour audit miss',
      text: 'Ремонт в подарок + ставка 4,5%. Студия 30,44 м² уже с ремонтом. Первоначальный взнос 400 000 ₽. Напишите СТУДИЯ, рассчитаем под вас. +7 900 000 10 08',
      subtype: 'PROPERTY_AGENT',
      signals: ['property-agent:mortgage-studio-promo', 'contact:phone'],
      negativeSignals: ['private:property-sale'],
    },
    {
      label: 'septic and excavator service from twenty four hour audit miss',
      text: 'ВЫГРЕБНЫЕ ЯМЫ ПОД КЛЮЧ, УСЛУГИ МИНИ ЭКСКАВАТОРА И САМОСВАЛА +7 900 000 10 09',
      subtype: 'SERVICES',
      signals: ['service-specialty:septic-excavator-service', 'contact:phone'],
    },
    {
      label: 'multi role shift pay recruitment from twenty four hour audit miss',
      text: 'На постоянную работу в кафе требуется уборщица: график 6/1, 3800р. за смену. Дворник: график 6/1, 3600р. за смену. +7 900 000 10 10',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:роль-условия', 'contact:phone'],
    },
    {
      label: 'driver park payout recruitment from twenty four hour audit miss',
      text: 'Парк где не требуется самозанятость. 24/7 поддержка. Моментальная выплата средств. +7 900 000 10 11',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:driver-park-payout-work', 'contact:phone'],
    },
    {
      label: 'agent commission townhouse from twenty four hour audit miss',
      text: 'КП АВСТРИЯ. ТАУНХАУС 130 кв.м. Лучшая цена 14 000 000₽. Комиссия агентам 250000₽ в цене. +7 900 000 10 12',
      subtype: 'PROPERTY_AGENT',
      signals: ['property-agent:комиссия-агентам', 'contact:phone'],
      negativeSignals: ['private:property-sale'],
    },
    {
      label: 'commercial property coffee shop lease boundary',
      text: 'Сдам место под кофейню 18 м² в проходном ТЦ, мокрая точка, витрина, 45000 в месяц. Звоните +7 900 000 11 01.',
      subtype: 'PROPERTY_COMMERCIAL',
      signals: ['property-commercial:commercial-space', 'contact:phone'],
    },
    {
      label: 'urgent damaged auto buyout with free tow',
      text: 'Срочно выкупим авто после ДТП без документов, деньги сразу, эвакуатор бесплатно. Пишите @auto_cash.',
      subtype: 'BUYOUT',
      signals: ['buyout:auto-same-day-buyout', 'transaction:buyout-deal', 'contact:handle'],
    },
    {
      label: 'short home dumplings order from agent recall sweep',
      text: 'Домашние пельмени 500р/кг, заказ @foodhome',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:home-food-order', 'transaction:price', 'contact:handle'],
    },
    {
      label: 'home dairy delivery from final prod audit false negative',
      text: 'Предлагаю козье молоко, творог, йогурт, сыры. Доставим до вашего подъезда . т 89277172079',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:home-dairy-retail', 'contact:phone'],
    },
    {
      label: 'home dairy applications with delivery rounds',
      text: 'Домашняя молочка: сметана, творог, кефир, сыр. Развоз по пятницам, заявки в личку.',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:home-dairy-retail', 'contact:в личк'],
    },
    {
      label: 'euphemistic auto buyout with immediate settlement',
      text: 'Заберу авто в любом состоянии, расчет сразу на месте. Документы не проблема.',
      subtype: 'BUYOUT',
      signals: ['buyout:auto-same-day-buyout', 'transaction:buyout-deal'],
    },
    {
      label: 'euphemistic livestock procurement with immediate settlement',
      text: 'Приедем заберём коров и бычков, расчет на месте живым весом.',
      subtype: 'BUYOUT',
      signals: ['buyout:livestock-procurement', 'transaction:buyout-deal'],
    },
    {
      label: 'remote project recruitment with income but no contact',
      text: 'Нужны люди в проект. Доход от 7000 в день, без вложений, обучение.',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:people-work-conditions', 'transaction:implied-price'],
    },
    {
      label: 'paid group directory addition',
      text: 'Каталог групп района: 1. Чат мам https://max.ru/join/a 2. Работа https://max.ru/join/b 3. Услуги https://max.ru/join/c. Добавление платное.',
      subtype: 'CHANNEL_PLACEMENT',
      signals: ['channel-placement:paid-directory-addition', 'deal-channel:link'],
    },
    {
      label: 'agent rental commission to realtor from recall sweep',
      text: 'Сдам квартиру на длительный срок, комиссия риэлтору 50%, показ сегодня, телефон +7 900 000 11 02.',
      subtype: 'PROPERTY_AGENT',
      signals: ['property-agent:комиссия-агенту-аренда', 'contact:phone'],
      negativeSignals: ['private:property-sale'],
    },
    {
      label: 'short stay apartment booking from recall sweep',
      text: 'Квартира посуточно рядом с вокзалом, свободна на выходные, бронь в личку.',
      subtype: 'PROPERTY_AGENT',
      signals: ['property-agent:посуточная-квартира-бронь', 'contact:в личк'],
    },
    {
      label: 'paid social actions work from recall sweep',
      text: 'Ставь лайки, подписывайся и получай деньги на карту ежедневно, задания в личку.',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:paid-social-actions-work', 'contact:в личк'],
    },
    {
      label: 'chat correspondence operator from recall sweep',
      text: 'Оператор переписки в MAX, свободный график, выплаты каждую неделю, обучение, пишите.',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:chat-correspondence-operator'],
    },
    {
      label: 'vp op channel cross promo from recall sweep',
      text: 'ОП/ВП в MAX каналах, аудитория 12к, статистику скину в личку.',
      subtype: 'CHANNEL_PLACEMENT',
      signals: ['channel-placement:vp-op-cross-promo', 'contact:в личк'],
    },
    {
      label: 'paid chat pin placement from recall sweep',
      text: 'Закреп в чате на сутки 300р, оставляйте ссылку админу.',
      subtype: 'CHANNEL_PLACEMENT',
      signals: ['channel-placement:paid-pin-placement', 'transaction:price'],
    },
    {
      label: 'group promo through profile link',
      text: 'Наш чат для мам, заходите, ссылка в профиле.',
      subtype: 'GROUP_PROMOTION',
      signals: ['combo:group-promo+profile-contact', 'contact:ссылка в профиле'],
    },
    {
      label: 'short stay island lodging from agent recall sweep',
      text: 'Сдаю бюджетное жильё на Ольхоне: домики, душ, мангал. Телефон +7 900 000 10 20',
      subtype: 'PROPERTY_AGENT',
      signals: ['property-agent:short-stay-domiki-booking', 'contact:phone'],
      negativeSignals: ['private:property-sale'],
    },
    {
      label: 'bare question sauna kit self promo from agent recall sweep',
      text: 'Хотите баню под ключ? Полная сборка, доставка отдельно, заказывайте готовое решение.',
      subtype: 'GOODS_RETAIL',
      signals: ['business:заказывайте', 'transaction:keywords', 'goods-retail:inventory'],
      negativeSignals: ['context:question'],
    },
    {
      label: 'short cabbage seedling clearance stock from twenty four hour audit miss',
      text: 'Продам остатки рассады белокочанной капусты : Надежда, Амагер, Московская поздняя, Грибовская.',
      subtype: 'GOODS_RETAIL',
      signals: [
        'intent:продам',
        'promo:остатк',
        'goods-retail:plant-nursery-clearance-stock',
        'transaction:clearance-stock',
      ],
    },
    {
      label: 'multi price seedling leftovers from post deploy audit miss',
      text: 'Продам остатки рассады томатов грунтовых 11 шт, цена 30 руб зашт, перцев красных, жёлтых, шоколадных, цена 20 руб за шт. Самовывоз Северск, Иглаково',
      subtype: 'GOODS_RETAIL',
      signals: [
        'intent:продам',
        'promo:остатк',
        'goods-retail:plant-nursery-stock',
        'transaction:price',
        'transaction:keywords',
      ],
      negativeSignals: ['private-goods:private-seedling-leftovers'],
    },
    {
      label: 'avito review side income from twenty four hour audit miss',
      text: 'Всем привет! Нам очень нужны отзывы на Авито. Отлично подойдет в качестве доп.заработка. Если кому-то актуально, пишите в личку.',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:marketplace-review-work', 'contact:пишите в лич'],
    },
    {
      label: 'debt relief leadgen with profile application',
      text: 'Списание долгов через банкротство, консультация бесплатно, анкета для заявки в профиле.',
      subtype: 'SERVICES',
      signals: [
        'risk:debt-relief-service',
        'service-specialty:debt-relief-service',
        'transaction:high-risk-offer',
      ],
    },
    {
      label: 'paid marketplace review task with chat link',
      text: 'Нужно 20 человек для отзывов на Wildberries, оплата сразу после задания, ссылка на чат https://max.ru/join/reviews.',
      subtype: 'RECRUITMENT',
      signals: [
        'risk:paid-review-task',
        'recruitment:marketplace-review-work',
        'deal-channel:link',
      ],
    },
    {
      label: 'paid survey referral with payout link',
      text: 'Опросы с оплатой до 500 рублей, вывод на карту, регистрация https://example.com/opros.',
      subtype: 'GOODS',
      signals: ['business:paid-survey-referral', 'transaction:price', 'deal-channel:link'],
    },
    {
      label: 'app directory promo with jobs and listings',
      text: 'Скачай приложение Работа и квартира: свежие вакансии, объявления и авто рядом, ссылка https://example.com/app.',
      subtype: 'RECRUITMENT',
      signals: ['risk:app-store-directory-promo', 'recruitment:ваканси', 'deal-channel:link'],
    },
    {
      label: 'bulk client leadgen with bot and warm base',
      text: 'Теплая база клиентов для мастеров красоты, заявки ежедневно, подключение через бот https://example.com/clients.',
      subtype: 'SERVICES',
      signals: ['risk:bulk-client-leadgen', 'service-specialty:marketing-automation'],
    },
    {
      label: 'paid channel ad placement with handle',
      text: 'Размещение рекламы в канале 1500р, статистика живая, заявки в личку @admin.',
      subtype: 'CHANNEL_PLACEMENT',
      signals: ['channel-placement:paid-group-promo', 'transaction:price', 'contact:handle'],
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

  it('escalates obfuscated salary loan leadgen instead of sending it to review only', () => {
    const result = detect(
      'Дeньги дo зapплaты oнлaйн, oдoбpeниe 15 минут, без отказа. Ccылкa в профиле.',
    );

    expect(result?.primarySubtype).toBe('GOODS');
    expect(result?.matchedSignals).toContain('risk:loan-leadgen');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it('keeps sanitized esoteric service contacts above balanced evidence gates', () => {
    const result = detect(
      'Ольга Романовна - сильнейшая ясновидящая и потомственная гадалка с опытом более 25 лет. Работаю по белой магии. Помогу вернуть гармонию в отношения, увидеть перспективы в финансах и работе. Связь со мной: Max: [phone], WhatsApp: [phone], Telegram: [phone], телефон для звонков: [phone].',
      {
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 60,
          commercialAdsDeleteThreshold: 81,
        },
      },
    );

    expect(result).toBeDefined();
    expect(result?.matchedSignals).toEqual(
      expect.arrayContaining([
        'risk:paid-esoteric-service',
        'transaction:high-risk-offer',
        'contact:whatsapp',
        'contact:telegram',
      ]),
    );
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

  it('detects balcony glazing service under balanced thresholds', () => {
    const result = detect(
      'Остекление и утепление балконов и лоджий, отделка пространства под ключ. Бесплатный замер и расчет стоимости, телефон +7 900 000 02 03',
      {
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 55,
          commercialAdsDeleteThreshold: 76,
        },
      },
    );

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.matchedSignals).toEqual(
      expect.arrayContaining([
        'service-specialty:balcony-glazing-service',
        'transaction:implied-price',
        'contact:phone',
      ]),
    );
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

  it('keeps campaign-heavy third-party chat directories review-only instead of delete', () => {
    const result = detect(
      'Подббдд 1 /2 Чаты 1 женский чат https://max.ru/join/a 2 доска объявлений обгэс https://max.ru/join/b 3 доска объявлений 1 https://max.ru/join/c 4 взаимосылочная 1 https://max.ru/join/d 5 группа для женщин причёски, мода, домоводство https://max.ru/join/e 6 НСК и НСО доска объявлений https://max.ru/join/f 7 Нск пристань надежда для бездомных животных https://max.ru/join/g 8 Нск и НСО недвижимость https://max.ru/join/h 9 Нск и НСО аренда квартир https://max.ru/join/i 10 Новосибирск https://max.ru/join/j 11 НСО и Новосибирск https://max.ru/join/k 12 женский журнал https://max.ru/join/l 13 Нск и НСО отдам - возьму в дар https://max.ru/join/m 14 Нск и НСО работа https://max.ru/join/n 15 Нск и НСО услуги https://max.ru/join/o 16 Нск и НСО реклама https://max.ru/join/p',
      {
        commercialCampaignContext: {
          senderDistinctChatCount: 7,
          sameTextDistinctChatCount: 6,
          repeatedPhoneDistinctChatCount: 0,
          repeatedLinkDistinctChatCount: 6,
          nearTextDistinctChatCount: 6,
          repeatedDomainDistinctChatCount: 21,
          repeatedHandleDistinctChatCount: 0,
          senderDistinctChatCount5m: 6,
          senderDistinctChatCount30m: 6,
          senderDistinctChatCount120m: 7,
        },
      },
    );

    expect(result?.primarySubtype).toBe('CHANNEL_PLACEMENT');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
    expect(result?.reviewRecommended).toBe(true);
    expect(result?.reasonCodes).toContain('fp-risk-high');
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
      'rehabilitation center recommendation request',
      'Кто знает хороший реабилитационный центр, родственнику нужна помощь?',
    ],
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
      'private home textile resale from twenty four hour audit false positive',
      'Продается новый комплект дивандеков. Эти стильные чехлы идеально подходят для защиты дивана от загрязнений. Комплект включает два чехла размером 90см /210см. Не подошли нам, сразу не успели сдать. На Озоне один стоит 1895р. Отдам дешевле, чем приобрела на маркетплейсе. Оба за 2700р.',
    ],
    [
      'private kiosk single object resale from twenty four hour audit false positive',
      'Срочно продаю киоск в хорошем состоянии. Металлический киоск белого цвета, площадью около 10 кв.м. Требуется небольшой косметический ремонт фасада. Стоимость 40 тыс. руб., торг возможен. По всем вопросам звоните по номеру телефона +7 900 000 10 31.',
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
    [
      'private low quantity money tree stays private with unit price wording',
      'Отдам денежное дерево по 50 руб за шт, всего 3 шт, есть с корнями, район Комета',
    ],
    [
      'local news subscribe footer from sixteen hour audit false positive',
      'Возле села Еловка на дорогу внезапно выбежал лось. Водители, будьте внимательны. Томск Сейчас | Подписаться https://example.com',
    ],
    [
      'road repair news subscribe footer from sixteen hour audit false positive',
      'В Томске завершается ремонт дороги после жалоб местных жителей. Томск Сейчас | Подписаться https://example.com',
    ],
    [
      'public city improvement voting from sixteen hour audit false positive',
      'Уважаемые жители города Азова! Идет голосование за объекты благоустройства, поддержите проект по ссылке https://example.com',
    ],
    [
      'contest voting from sixteen hour audit false positive',
      'Началось онлайн-голосование участников конкурса, каждый голос это шаг к победе. https://example.com',
    ],
    [
      'delivery request please from sixteen hour audit false positive',
      'Здравствуйте. Можно доставку пожалуйста! Если можно то в ЛС',
    ],
    [
      'job seeking typo from sixteen hour audit false positive',
      'Ищю подработку/любой калым писать в ЛС или обращаться по номеру +7 900 000 01 22',
    ],
    [
      'rideshare free seats from sixteen hour audit false positive',
      'Водитель завтра 03.06 Абакан Таштып Абаза, 3 места, +7 900 000 01 23',
    ],
    [
      'volunteer pet adoption delivery from sixteen hour audit false positive',
      'Есть примета, кто готов? Девочка ласковая, доставка за счет группы Помощь хвостикам +7 900 000 01 24',
    ],
    [
      'private manicure table resale from sixteen hour audit false positive',
      'Продам маникюрный стол со всем, что на фото, 5000 рублей. +7 900 000 01 25',
    ],
    [
      'private Toyota Vitz resale with ex wording from sixteen hour audit false positive',
      'Продам Toyota Vitz 2010 года, экс владелец, пробег 120000, цена 600000, +7 900 000 01 26',
    ],
    [
      'government services status is not benefit phishing',
      'На госуслугах можно проверить статус заявления, ссылка есть на сайте администрации.',
    ],
    [
      'ordinary meeting plus response is not service cta',
      'Кто идет завтра на встречу, ставьте плюс.',
    ],
    [
      'civic bare domain is not commercial generic domain',
      'На сайте администрации example-raion.ru опубликован график отключений воды.',
    ],
    [
      'civic email contact is not commercial contact',
      'Почта администрации для жалоб info@example.ru, напишите обращение по форме.',
    ],
    [
      'third party chat directory with links is not own channel placement ad',
      'Подборка полезных чатов района: женский чат https://max.ru/join/a, доска объявлений https://max.ru/join/b, соседи https://max.ru/join/c.',
    ],
    [
      'district group directory with job and service group names stays allowed',
      'Присоединяйся к группам по Краснокаменску и округу. Добавляйте контакты, чтобы не потерять любимые группы: Работа, Вакансии Краснокаменск https://max.ru/join/a, Недвижимость Краснокаменск https://max.ru/join/b, Услуги Краснокаменск https://max.ru/join/c.',
    ],
    [
      'realtor group catalog with price word in title stays allowed',
      'ГРУППЫ ДЛЯ КОЛЛЕГ С ЭКСКЛЮЗИВНОЙ НЕДВИЖИМОСТЬЮ. Вступай скорее. 1. Основной канал https://max.ru/join/a 2. Каталог групп https://max.ru/join/b 3. Первая цена https://max.ru/join/c 4. Вся недвижимость https://max.ru/join/d.',
    ],
    [
      'private avito resale stays private',
      'Продам детскую коляску б/у, самовывоз, ссылка на avito.ru/items/private-stroller, цена 3000 руб.',
    ],
    [
      'private auto exchange with starter is not auto-parts retail',
      'Обмен. Мото не предлагать Ока. стартер новый, генератор, документы.',
    ],
    [
      'private auto engine exchange with repair wording is not a service offer',
      'Обмен. Мото не предлагать. ДВС после капремонта, ставился новый венец, не сошёлся со стартером, нужно поменять. Двигатель обкатку не прошёл. Остальное в ЛС, в комплект отдам поршни, клапаны, вкладыши, кольца новые.',
    ],
    [
      'youtube tutorial with no ads is not a setup service',
      'Без рекламы: видео на YouTube как настроить роутер дома, просто инструкция для соседей https://youtube.com/watch?v=abc',
    ],
    [
      'official government app store link is not app directory spam',
      'Официальное приложение Госуслуги можно скачать в App Store: https://apps.apple.com/ru/app/gosuslugi/id123456',
    ],
    [
      'official work app store link is not app directory spam',
      'Официальное приложение Работа России можно скачать в App Store: https://apps.apple.com/ru/app/trudvsem/id123',
    ],
    [
      'news intensity wording is not info product',
      'Магнитная буря началась, в ближайшие часы интенсивность геомагнитных возмущений может усилиться. Прислать новость https://example.com/news',
    ],
    [
      'work app store tutorial is not app directory spam',
      'Инструкция: скачайте приложение Работа России через App Store, чтобы проверить статус резюме https://apps.apple.com/ru/app/trudvsem/id123',
    ],
    [
      'civic benefit instruction on administration site is not phishing',
      'Компенсацию за ЖКХ оформляют через Госуслуги, заявление по ссылке на сайте администрации https://example-raion.ru/benefits',
    ],
    [
      'fraud warning quoting loan ad is not a commercial loan offer',
      'Полиция предупреждает: мошенники рассылают займ без отказа, не переходите по ссылкам',
    ],
    [
      'private low quantity seedlings stay private',
      'Продам рассаду помидоров, осталось 10 штук по 50 рублей, самовывоз, пишите в личку',
    ],
    [
      'short private seedling leftovers without named varieties stays private',
      'Продам остатки рассады помидоров, 10 штук по 50 рублей, самовывоз',
    ],
    [
      'short private seedling leftovers without price stays private',
      'Продам остатки рассады помидоров, самовывоз',
    ],
    [
      'rideshare passenger wording is not logistics service',
      'Водитель завтра Абакан Таштып Абаза, 3 места по 500 рублей, перевозка пассажиров, телефон +7 900 000 10 06',
    ],
    [
      'student seeking marketplace side job stays allowed',
      'Студент ищет подработку на Ozon или WB, график после учебы, писать в личку',
    ],
    [
      'home dumplings recommendation request stays allowed',
      'Кто делает домашние пельмени, посоветуйте контакты.',
    ],
    [
      'home dairy recommendation request stays allowed',
      'Кто покупал козье молоко и творог у соседей, посоветуйте проверенные контакты.',
    ],
    [
      'buyer strawberry route order request stays allowed',
      'Добрый день, а можно сделать заказ на клубнику Азию по маршруту автобуса, может быть будет кому-то удобно попутно?',
    ],
    [
      'commercial property recommendation request stays allowed',
      'Подскажите, где недорого снять кабинет для занятий два раза в неделю?',
    ],
    [
      'info product experience question stays allowed',
      'Кто проходил курс по маркетплейсам, стоит ли своих денег? Нужны отзывы.',
    ],
    [
      'loan discussion is not loan leadgen',
      'Подскажите, кто брал кредит в банке, какие ставки сейчас?',
    ],
    [
      'credit history advice question is not loan leadgen',
      'Кредитная история испортилась, кто знает как исправить без новых займов?',
    ],
    [
      'job seeking with payment details stays allowed',
      'Ищу подработку на лето с ежедневной оплатой, писать в личку.',
    ],
    [
      'personal project volunteer request stays allowed',
      'Нужны люди в проект двора на субботник, без оплаты, просто помочь соседям.',
    ],
    [
      'rideshare with price stays allowed',
      'Водитель завтра Абакан Таштып Абаза, 3 места по 500 рублей, телефон +7 900 000 03 04.',
    ],
    [
      'personal car pickup is not auto buyout',
      'Заберу авто из сервиса после ремонта, расчет уже закрыт по заказ-наряду.',
    ],
    [
      'private land construction context is not building service',
      'Земельный участок ровный, при строительстве жилого дома сырости не будет. Свет рядом, цена 350 000, телефон +7 900 000 10 21.',
    ],
    [
      'livestock logistics note is not procurement',
      'Приедем заберём коров с пастбища после дождя, хозяин уже предупредил.',
    ],
    [
      'chat recommendation with profile link stays allowed',
      'Посоветуйте чат для мам, ссылка в профиле у соседки не открывается.',
    ],
    [
      'resale pricing discussion from twenty four hour audit false positive',
      'Если оптовик покупает по 700 р, то можно смело продавать по 1500.',
    ],
    [
      'news subscription wording with in course idiom stays allowed',
      'Подпишитесь, чтобы быть в курсе городских новостей и важных объявлений администрации. https://example.com/news',
    ],
    [
      'rental owner without commission stays allowed',
      'Сдам квартиру, собственник, без комиссии, залог 10000.',
    ],
    [
      'short stay apartment request stays allowed',
      'Ищу квартиру посуточно на выходные, посоветуйте варианты.',
    ],
    [
      'school voting likes without pay stay allowed',
      'Поставьте лайк посту школы, это голосование без оплаты.',
    ],
    [
      'max support operator story stays allowed',
      'Оператор поддержки MAX ответил в чате, проблема решена.',
    ],
    ['vp school homework stays allowed', 'ВП по математике задали на завтра, кто понял задачу?'],
    [
      'pin chat rules request stays allowed',
      'Закрепите правила чата, чтобы новички видели их сверху.',
    ],
    [
      'question quoting third party service ad stays allowed',
      'Кто пользовался услугами мастера из объявления "ремонт окон от 3000, звоните"? Это нормальный специалист или реклама?',
    ],
    [
      'course due diligence with price stays allowed',
      'Кто проходил курс по маркетплейсам за 3000 руб, стоит ли своих денег? Нужны отзывы.',
    ],
    [
      'ozon delivery complaint with cash request stays allowed',
      'Заказал на Ozon доставку, курьер просит оплату наличными и пишет в личку, это нормально?',
    ],
    [
      'channel ad due diligence with metrics stays allowed',
      'Кто покупал рекламу в этом канале: ER24 8%, цена за пост 500р, статистика похожа на накрутку?',
    ],
    [
      'generic district news subscribe footer stays allowed',
      'Сегодня в парке открыли новую детскую площадку после ремонта. Подписывайтесь на канал района https://example.com/news',
    ],
    [
      'private used dress resale with avito delivery stays allowed',
      'Продам платье б/у, размер 44, не подошло. Возможна доставка по России Авито доставкой, цена 1200 руб.',
    ],
    [
      'private seedling leftovers with one price stay allowed',
      'Лишняя рассада после посадки: помидоры бычье сердце, черри, перец желтый. Отдам по 30 руб, самовывоз.',
    ],
    [
      'private seedling leftovers with several small prices stay allowed',
      'Продам остатки рассады: томаты 5 шт по 50 руб, перец 4 шт по 60 руб, самовывоз.',
    ],
    [
      'district news channel subscription stays allowed',
      'Подписывайтесь на наш канал района, новости каждый день https://t.me/news',
    ],
    [
      'library master class sign-up stays allowed',
      'Мастер-класс в библиотеке, запись по ссылке https://example.ru/event',
    ],
    [
      'currency exchange rate news is not an info product',
      'Курс доллара сегодня вырос, подробности https://example.ru/news',
    ],
    [
      'debt relief legal discussion stays allowed',
      'Кто проходил банкротство физлица, сколько длится суд и какие документы нужны?',
    ],
    [
      'debt relief scam warning stays allowed',
      'Юристы предупреждают: объявления "спишем долги за неделю" часто мошеннические, не переводите предоплату.',
    ],
    [
      'wildberries buyer review complaint stays allowed',
      'Купила товар на Wildberries, отзыв не проходит модерацию в приложении, кто сталкивался?',
    ],
    [
      'local client search seminar recap stays allowed',
      'На семинаре обсуждали поиск клиентов для мастеров красоты, без продаж и ссылок.',
    ],
    [
      'chat bot monetization settings discussion stays allowed',
      'Чат-бот показывает монетизацию канала в настройках, рекламу мы не продаём.',
    ],
    [
      'bank referral code due diligence stays allowed',
      'Кто пользовался реферальным кодом банка, бонус реально начисляют или реклама?',
    ],
  ])('allows %s', (_label, text) => {
    expect(detect(text)).toBeNull();
  });

  it('still detects paid course ads after narrowing course marker', () => {
    const result = detect(
      'Открыт набор на курс по маркетплейсам. Цена 3000 руб, места ограничены, пишите в личку.',
    );

    expect(result?.primarySubtype).toBe('INFO_PRODUCT');
    expect(result?.matchedSignals).toContain('info:курс');
    expect(['WARN', 'REVIEW_ONLY']).toContain(result?.actionBand);
    expect(result?.reasonCodes).toContain('evidence:DIRECT');
    expect(result?.reasonCodes).not.toContain('evidence:action-direct');
  });

  it('deletes paid course ads when independent action-direct evidence is present', () => {
    const result = detect(
      'Открыт набор на курс по маркетплейсам. Цена 3000 руб, места ограничены, запись https://max.ru/join/course.',
    );

    expect(result?.primarySubtype).toBe('INFO_PRODUCT');
    expect(result?.matchedSignals).toContain('info:курс');
    expect(result?.matchedSignals).toContain('deal-channel:link');
    expect(result?.actionBand).toBe('DELETE');
    expect(result?.reasonCodes).toContain('evidence:action-direct');
  });

  it('flags short collectible flower retail under balanced real chat thresholds', () => {
    const result = detect('Сортовые фиалки по вопросам в личку', {
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 50,
        commercialAdsDeleteThreshold: 70,
      },
    });

    expect(result?.primarySubtype).toBe('GOODS_RETAIL');
    expect(result?.matchedSignals).toContain('goods-retail:collectible-flower-retail');
    expect(result?.matchedSignals).toContain('transaction:retail-inquiry');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
  });

  it('keeps ordinary pc sale out of betting high risk', () => {
    const result = detect(
      'Полный комплект ПК для работы и учебы, игр, тянет GTA V и прочие. 4-ядерный процессор AMD A10. Возможна доставка. Цена 10500 +7 900 000 10 13. Звоните, тут не могу ответить.',
    );

    expect(result?.primarySubtype).toBe('GOODS');
    expect(result?.actionBand).toBe('DELETE');
    expect(result?.matchedSignals).not.toContain('risk:betting-gambling');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it('keeps banquet vacancy out of bank card high risk', () => {
    const result = detect(
      'Вакансия. Требуются повара, ставка от 5500 +банкетные. График 6/1, официальное оформление. Связь: +7 900 000 10 14',
    );

    expect(result?.primarySubtype).toBe('RECRUITMENT');
    expect(result?.actionBand).toBe('DELETE');
    expect(result?.matchedSignals).not.toContain('risk:bank-card-leadgen');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it('keeps massage service out of messaging automation and channel placement', () => {
    const result = detect(
      'Приглашаем на массаж за 1800₽ для новых клиентов. У нас остаются 99% из всех пришедших! Запись/консультация +7 900 000 10 15',
    );

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.actionBand).toBe('DELETE');
    expect(result?.matchedSignals).not.toContain('risk:messaging-automation');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it('still escalates bank card leadgen after tightening bank word boundaries', () => {
    const result = detect(
      'Альфа-Банк. Дарим 500 ₽ за оформление Альфа-Карты. Подробности по ссылке https://example.com/card',
    );

    expect(result?.primarySubtype).toBe('GOODS');
    expect(result?.matchedSignals).toContain('risk:bank-card-leadgen');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it('still detects messaging automation after removing bare ban word', () => {
    const result = detect(
      'Новый софт для автоматической рассылки по чатам в MAX: прокси, аккаунты, база сообщений. Купить можно на канале https://example.com/soft',
    );

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.matchedSignals).toContain('risk:messaging-automation');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it('does not classify collectible flower starters as auto parts', () => {
    const result = detect(
      'Эксклюзивные коллекционные фиалки, детки и стартеры, упаковка, отправка СДЭК, 150 руб.',
    );

    expect(result?.primarySubtype).toBe('GOODS_RETAIL');
    expect(result?.matchedSignals).toContain('goods-retail:collectible-flower-retail');
    expect(result?.matchedSignals).not.toContain('goods-retail:auto-parts-retail');
    expect(result?.matchedSignals).not.toContain('property-agent:эксклюзив');
  });

  it('does not treat the domain portion of an email as a generic deal channel', () => {
    const result = detect(
      'Бухгалтерское сопровождение ИП и ООО, отчетность и декларации. Заявки на почту buh-office@example.com',
    );

    expect(result?.matchedSignals).toContain('contact:email');
    expect(result?.matchedSignals).not.toContain('deal-channel:generic-domain');
  });

  it('classifies wood portrait orders as services instead of property agent exclusives', () => {
    const result = detect(
      'Эксклюзивный портрет на дереве. Ваши фото на дереве, заготовки, подарите близким. Заказывают по телефону +7 900 000 02 06.',
    );

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.matchedSignals).toContain('intent:custom-art-order');
    expect(result?.matchedSignals).not.toContain('property-agent:эксклюзив');
  });

  it('keeps repeated private clothing resale out of commercial actions even with campaign context', () => {
    const result = detect(
      'Продам детские вещи: куртка р-р 122 сост. отличное 700 руб, сапоги р-р 30 сост. хорошее 500 руб, шапка 150 руб. Пишите в личку.',
      { commercialCampaignContext: REPEATED_PRIVATE_RESALE_CONTEXT },
    );

    expect(result).toBeNull();
  });

  it('uses buyout transaction evidence for delete decisions when a strong contact is present', () => {
    const result = detect(
      'Срочно выкупим авто после ДТП без документов, деньги сразу, эвакуатор бесплатно. Пишите @auto_cash.',
    );

    expect(result?.primarySubtype).toBe('BUYOUT');
    expect(result?.actionBand).toBe('DELETE');
    expect(result?.reasonCodes).toContain('evidence:action-direct');
    expect(result?.reasonCodes).toContain('evidence:direct:transaction-contact');
  });

  it('detects bulk material sale with phone-only question wording', () => {
    const result = detect('ПРОДАМ СЫПУЧИЕ МАТЕРИАЛЫ! ВОПРОСЫ +7 900 000 00 00');

    expect(result?.primarySubtype).toBe('GOODS_RETAIL');
    expect(result?.matchedSignals).toContain('goods-retail:bulk-materials');
    expect(result?.matchedSignals).toContain('contact:phone');
  });

  it('treats MAX and MAH reply CTA as contact for explicit services', () => {
    const serviceInMax = detect('Маникюр, запись открыта, пишите в МАХ');
    const repairInMax = detect('Ремонт квартир, пишите в MAX');

    expect(serviceInMax?.primarySubtype).toBe('SERVICES');
    expect(serviceInMax?.matchedSignals).toContain('contact:пишите в мах');
    expect(repairInMax?.primarySubtype).toBe('SERVICES');
    expect(repairInMax?.matchedSignals).toContain('contact:пишите в max');
  });

  it('keeps recent audit service and produce misses covered', () => {
    const electrical = detect(
      'Электромонтажные работы любой сложности. Сварочные и сантехнические работы. Отопление. +7 900 000 00 00',
    );
    const moving = detect(
      'ПЕРЕЕЗДЫ ПОД КЛЮЧ. ДОМАШНИЙ ДАЧНЫЙ ОФИСНЫЙ. ГРУЗЧИКИ АККУРАТНЫЕ. ВЫВОЗ МУСОРА. ГАЗЕЛЬ КАМАЗ ЗИЛ +7 900 000 00 00 ЗВОНИТЕ',
    );
    const strawberry = detect(
      'Продается домашняя клубника. Ягода крупная, сладкая. Суходол т +7 900 000 00 00',
    );

    expect(electrical?.primarySubtype).toBe('SERVICES');
    expect(electrical?.matchedSignals).toContain('service-specialty:электромонтаж');
    expect(electrical?.matchedSignals).toContain('contact:phone');
    expect(moving?.primarySubtype).toBe('SERVICES');
    expect(moving?.matchedSignals).toContain('service-specialty:moving-cargo-service');
    expect(strawberry?.primarySubtype).toBe('GOODS_RETAIL');
    expect(strawberry?.matchedSignals).toContain('goods-retail:wholesale-produce');
  });
});
