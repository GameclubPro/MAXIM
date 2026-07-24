import type { CommercialCampaignContext } from '../commercial-campaign.util';
import { normalizeCommercialRawText } from './commercial-normalization';
import {
  resolveGroupPromotionRecall,
  resolveLocalServiceRecall,
  resolveManualLaborServiceRecall,
  resolveProfessionalPropertyRecall,
  resolveProfessionalRetailRecall,
  resolveRecurringBuyoutRecall,
  resolveStructuredRecruitmentRecall,
  resolveTourEventRentalRecall,
  resolveTransportServiceRecall,
} from './commercial-recall-patterns';

const CAMPAIGN_CONTEXT: CommercialCampaignContext = {
  senderDistinctChatCount: 3,
  sameTextDistinctChatCount: 3,
  repeatedPhoneDistinctChatCount: 3,
  repeatedLinkDistinctChatCount: 3,
  nearTextDistinctChatCount: 3,
  repeatedDomainDistinctChatCount: 3,
  repeatedHandleDistinctChatCount: 0,
  senderDistinctChatCount5m: 1,
  senderDistinctChatCount30m: 3,
  senderDistinctChatCount120m: 3,
};

const raw = (text: string) => normalizeCommercialRawText(text.toLowerCase());

describe('bounded commercial recall patterns', () => {
  describe('professional retail', () => {
    it('warns on a packaged size-run catalog', () => {
      expect(
        resolveProfessionalRetailRecall({
          text: raw('Носки, размер 36-41, упаковка 10 шт - 1100 руб, 5 шт - 550 руб'),
        }),
      ).toEqual({ label: 'packaged-apparel-size-run', cap: 'WARN' });
    });

    it('reviews a single apparel size run without professional fulfillment evidence', () => {
      expect(
        resolveProfessionalRetailRecall({
          text: raw('Платье хлопок. Размеры 50,52,54,56. Цена 1400'),
        }),
      ).toEqual({ label: 'single-size-run-listing', cap: 'REVIEW_ONLY' });
    });

    it('does not let retail review weaken a repeated custom-forging service', () => {
      expect(
        resolveProfessionalRetailRecall({
          text: raw(
            'Кованая роза, цена 700 рублей за штуку. Могу изготовить букеты в любом количестве, по вопросам обращаться в лс.',
          ),
          campaignContext: CAMPAIGN_CONTEXT,
        }),
      ).toBeNull();
    });

    it('preserves a private local berry listing', () => {
      expect(
        resolveProfessionalRetailRecall({
          text: raw(
            'Продам малину 2 л 400 рублей, черную смородину 1 л 200 рублей, красную смородину 1 л 100 рублей',
          ),
        }),
      ).toBeNull();
    });

    it.each([
      {
        text: 'Лишняя рассада после посадки: помидоры бычье сердце, черри, перец желтый. Отдам по 30 руб, самовывоз.',
      },
      {
        text: 'Продам детские вещи: куртка р-р 122 сост. отличное 700 руб, сапоги р-р 30 сост. хорошее 500 руб, шапка 150 руб. Пишите в личку.',
        campaignContext: CAMPAIGN_CONTEXT,
      },
      {
        text: 'Костюм двойка. Цена 1850 руб. Размеры 44, 46, 48, 50, 52, 54. Материал сингапур.',
      },
      {
        text: 'Продам два матраса для плавания, новые в упаковке. Цена 2000 руб каждый, при покупке обоих скидка. [phone]',
      },
    ])('preserves a private retail near miss: $text', ({ text, campaignContext }) => {
      expect(
        resolveProfessionalRetailRecall({
          text: raw(text),
          campaignContext,
        }),
      ).toBeNull();
    });

    it.each(['лет', 'годов', 'месяцев', 'недель', 'дней', 'шт'])(
      'does not count an age or quantity lower bound as a price: %s',
      (unit) => {
        expect(
          resolveProfessionalRetailRecall({
            text: raw(`Питомник растений публикует памятку: наблюдение начинается от 10 ${unit}.`),
          }),
        ).toBeNull();
      },
    );

    it('keeps a bare numeric lower bound as a price when the context is retail', () => {
      expect(
        resolveProfessionalRetailRecall({
          text: raw('Питомник растений. Цены от 100.'),
        }),
      ).toEqual({ label: 'professional-retail-structure', cap: 'WARN' });
    });

    it.each([
      [
        'Яблоки по 60 рублей Пелагиада [phone]',
        CAMPAIGN_CONTEXT,
        { label: 'professional-retail-structure', cap: 'WARN' },
      ],
      [
        'Пляжная двойка 1000₽ Размеры S (40-42) и М (44-46) Новые с бирками в упаковке',
        undefined,
        { label: 'packaged-apparel-size-run', cap: 'WARN' },
      ],
      [
        'Новые, хлопковые, турецкие.6-12 лет. 500₽ Михайловск. [phone]',
        undefined,
        { label: 'single-size-run-listing', cap: 'REVIEW_ONLY' },
      ],
      [
        '"КОРЕГА"- для чистки зубных протезов ( цена ниже аптек) [phone], г. Зея',
        undefined,
        { label: 'pharmacy-comparison-product', cap: 'REVIEW_ONLY' },
      ],
      [
        'A + Lancome Poeme, edp., 100 ml цена 1568 руб Дзержинский район.',
        undefined,
        { label: 'single-fragrance-sku', cap: 'REVIEW_ONLY' },
      ],
    ])('recalls the final audited retail slice: %s', (text, campaignContext, expected) => {
      expect(
        resolveProfessionalRetailRecall({
          text: raw(text),
          campaignContext,
        }),
      ).toEqual(expected);
    });

    it.each([
      'Новый диван Лофт 250 см. Купить на выставке: ТК Звезда, МАТРАСИТИ. РАСПРОДАЖА. Цена 45290 руб вместо 48800 руб. [phone]',
      'Качественный парфюм по доступным ценам: 2400 руб флакон 30 мл, 250 руб миниверсия 2 мл, сет из 10 ароматов 2400 руб, отливанты 5 мл 500 руб. [url]',
    ])('warns on a final multi-item retail catalog: %s', (text) => {
      expect(
        resolveProfessionalRetailRecall({
          text: raw(text),
          campaignContext: CAMPAIGN_CONTEXT,
        }),
      ).toEqual({ label: 'professional-retail-structure', cap: 'WARN' });
    });

    it.each([
      'В аптеке спросили, правда ли Корега бывает дешевле, номер аптеки [phone].',
      'Новые данные исследования: хлопковые ткани подходят детям 6-12 лет, телефон редакции [phone].',
      'Обсуждаем Lancome Poeme edp 100 ml: цена выросла, покупать не планирую.',
      'A + Lancome Poeme edp 100 ml: обсуждаем, цена выросла, покупать не планирую.',
    ])('preserves a final-slice retail discussion guard: %s', (text) => {
      expect(resolveProfessionalRetailRecall({ text: raw(text) })).toBeNull();
    });

    it.each([
      {
        guard: 'private apparel with a disclosed defect',
        text: 'Продам укороченный пиджак Zara и макси юбки (2 шт), цвет черный, размер M. Экокожа. У юбки Zara есть дефект по шву впереди. Цена за 3 вещи 1100 руб',
      },
      {
        guard: 'humanitarian aid collection',
        text: 'Обращаемся за гуманитарной и материальной помощью. Ребятам нужны теплые вещи, носки, перчатки, мед и чай. Гуманитарную помощь можно приносить в ДК.',
      },
      {
        guard: 'public scam warning',
        text: 'Уважаемые читатели, это новая схема мошенничества. Детям предлагают вынести ценные вещи, одежду и обувь, а затем продать за 1000 руб. Поговорите со своими детьми и объясните им опасность криминальной схемы.',
      },
      {
        guard: 'kitten giveaway',
        text: 'Дорогие соседи, возможно вы думали завести котенка. Кошка родила котят, разные окрасы, все красивые и ласковые. Пишите в лс.',
      },
      {
        guard: 'two private dresses with a defect',
        text: 'Владивосток. Продам платья р.44-46: трикотажное ZARA - 1250 руб, яркое H&M (разошелся шов на рукаве) - 250 руб',
      },
      {
        guard: 'single evening dress',
        text: 'Вечернее платье р.48. На свадьбу, корпоратив, вечеринку. Бюст на косточках, юбка солнце. Цена 2.800р. Екатеринбург',
      },
      {
        guard: 'single wedding dress rental',
        text: 'Продам или сдам на прокат свадебное платье со шлейфом. По дополнительным вопросам в личку. Размер 44-48.',
      },
      {
        guard: 'worn private footwear',
        text: 'Оригинал кросовки женские 38-38.5, в носке немного, в отличном состоянии 1000 р Екатеринбург',
      },
      {
        guard: 'garden surplus',
        text: 'Чеснок 30 руб, помидоры 300 руб, баклажаны 350 руб. Все выращено на даче для себя. Продаю излишки. Тел [phone].',
      },
      {
        guard: 'donation appeal after a fire',
        text: 'После пожара семья осталась без вещей. Прошу помощи, кто чем может помочь: одежда, обувь, вещи. Номер карты привязан к телефону [phone]. Помощь погорельцам.',
      },
      {
        guard: 'household liquidation before moving',
        text: 'В связи с продажей дома продам мебель: шкаф с зеркалами 25000, шкаф для одежды 5000, прихожая с зеркалом 5000. [phone] Самовывоз.',
      },
      {
        guard: 'single potted plant without fulfillment',
        text: 'Кротон, молодое растение, пересадка не требуется, с горшком 1000 р. Патруши',
      },
      {
        guard: 'editorial automotive analysis',
        text: 'Часть 2. Что нужно знать водителю. Правительство России разрешило выпускать топливо с другими характеристиками. Ароматические соединения выросли, ароматики стало больше. Такое топливо продается только в РФ. Чем это грозит вашему автомобилю и как защитить двигатель?',
      },
      {
        guard: 'demand-side produce request',
        text: 'Добрый день. Куплю огурцы, укроп, лук и петрушку. Еще интересует малина и смородина. Писать в личку.',
      },
      {
        guard: 'property description containing garden produce',
        text: 'Собственник продает недвижимость. Рядом магазины, 8 соток земли, в огороде смородина. Цена 3 000 000. Все вопросы в личку.',
      },
      {
        guard: 'single private washing machine',
        text: 'Продаю стиральную машину Haier на 6 кг. Чистая, без запахов. Возможна помощь в доставке. Номер [phone]. Цена 14.000',
      },
      {
        guard: 'single used sofa',
        text: 'Продам диван б/у, пользовались три года. Состояние хорошее, самовывоз. Цена 8000 руб, [phone].',
      },
      {
        guard: 'agricultural land description containing produce',
        text: 'Продаю срочно землю сельхоз назначения 9 га. Кадастровый номер указан, по участку проходит ЛЭП. Можно выращивать картофель. Цена 2500 т.р., [phone], собственник.',
      },
      {
        guard: 'second private property variant containing garden produce',
        text: 'Собственник. Продается недвижимость 136 кв.м. Рядом магазины, на участке смородина. Цена 4 000 000. Вопросы в личку.',
      },
    ])('clears an audited v5 retail false positive: $guard', ({ text }) => {
      expect(
        resolveProfessionalRetailRecall({
          text: raw(text),
          campaignContext: CAMPAIGN_CONTEXT,
        }),
      ).toBeNull();
    });
  });

  describe('local services', () => {
    it('warns on a portfolio-backed gate installation offer', () => {
      expect(
        resolveLocalServiceRecall(
          raw('Сегодня сделали откатные ворота с автоматикой. По всем вопросам в лс'),
        ),
      ).toEqual({ label: 'construction-portfolio-cta', cap: 'WARN' });
    });

    it('reviews a beauty booking slot with a price and contact', () => {
      expect(
        resolveLocalServiceRecall(
          raw('Осталось 2 окошка на завтра, стоимость 1500 рублей, телефон [phone]'),
        ),
      ).toEqual({ label: 'beauty-slot-price-contact', cap: 'REVIEW_ONLY' });
    });

    it('does not treat contractor demand as a service offer', () => {
      expect(resolveLocalServiceRecall(raw('Кто делает откатные ворота? Нужен мастер'))).toBeNull();
    });

    it.each([
      'СПИЛ ОПАСНЫХ ДЕРЕВЬЕВ С ВЫВОЗОМ ВЕТОК. РАСЧИСТКА УЧАСТКА. ТЕЛ [phone]',
      'Конструкции из алюминиевого профиля и стекла. Цена за 1 кв.м. 1 тысяча рублей. Тел [phone]',
      'Установка караоке для домашнего использования + микрофон. 3 т.р.',
    ])('warns on the final audited service slice: %s', (text) => {
      expect(resolveLocalServiceRecall(raw(text))).toEqual({
        label: 'construction-specialty-price-contact',
        cap: 'WARN',
      });
    });

    it.each([
      [
        'Ремонт стиральных машин НА ДОМУ. Я лично отвечаю на звонки и сам приезжаю. Опыт более 15 лет. Вызов и диагностика бесплатно. [phone]',
        'appliance-repair-self-offer',
      ],
      [
        'РЕМОНТ ГАРАЖЕЙ! Покрытие крыш, ремонт погребов, внутренняя отделка, настил пола, стяжка, малярные и сварочные работы, ремонт ворот. Скидка 15%. [phone]',
        'garage-repair-catalog',
      ],
      [
        'Строители с опытом выполнят все виды строительных работ. Новое строительство, ремонт и отделка, строительство домов под ключ. Пенсионерам скидка. Звоните [phone]',
        'construction-multi-service-catalog',
      ],
    ])('warns on an audited professional service catalog: %s', (text, label) => {
      expect(resolveLocalServiceRecall(raw(text))).toEqual({ label, cap: 'WARN' });
    });

    it('does not read a furnished apartment with a good repair as appliance repair', () => {
      expect(
        resolveLocalServiceRecall(
          raw(
            'Сдам светлую квартиру с хорошим ремонтом. Есть холодильник, стиральная машина, микроволновая печь и плита. Сдаю на длительный срок. Стоимость 18000р, звоните [phone].',
          ),
        ),
      ).toBeNull();
    });

    it.each([
      'Кто спиливал опасное дерево, посоветуйте специалиста.',
      'Обсуждаем конструкции из алюминиевого профиля для своей веранды.',
      'Подскажите, кто устанавливал караоке дома?',
    ])('preserves a final-slice service demand or discussion: %s', (text) => {
      expect(resolveLocalServiceRecall(raw(text))).toBeNull();
    });

    it('requires an air-conditioning object for a service catalog', () => {
      expect(
        resolveLocalServiceRecall(
          raw(
            'Продается автомобиль после капитального ремонта. Проведены ремонт и обслуживание двигателя, проверена тормозная система. Цена договорная, [phone]',
          ),
        ),
      ).toBeNull();

      expect(
        resolveLocalServiceRecall(
          raw(
            'Ремонт, диагностика, дозаправка и обслуживание кондиционеров. Цены от 1500 рублей, [phone]',
          ),
        ),
      ).toEqual({ label: 'air-conditioner-service-catalog', cap: 'WARN' });

      expect(
        resolveLocalServiceRecall(
          raw(
            'Ремонт. Диагностика. Дозаправка. Обслуживание, промывка дома и улицы, цена 2 тыс. Выезжаем бесплатно. [phone]',
          ),
        ),
      ).toEqual({ label: 'air-conditioner-service-catalog', cap: 'WARN' });
    });
  });

  describe('professional property', () => {
    it('warns on a professional property specification and response CTA', () => {
      expect(
        resolveProfessionalPropertyRecall({
          text: raw(
            'Квартира в мкр. Свобода, без обременений, вся сумма в ДКП. Стоимость 5 300 000. Напишите для записи на просмотр',
          ),
        }),
      ).toEqual({ label: 'property-professional-cta', cap: 'WARN' });
    });

    it('preserves a household request for a renovation crew', () => {
      expect(
        resolveProfessionalPropertyRecall({
          text: raw('Требуется на ремонт квартиры бригада мастеров, оплата по этапам'),
        }),
      ).toBeNull();
    });

    it('warns on repeated professional one-room shorthand', () => {
      expect(
        resolveProfessionalPropertyRecall({
          text: raw('Продажа 1кк, 30,5м., 5/5 Петра Дубрава, ул Физкультурная 2650млн.'),
          campaignContext: CAMPAIGN_CONTEXT,
        }),
      ).toEqual({ label: 'property-professional-shorthand', cap: 'WARN' });
    });

    it('warns on a branded residential-development lead', () => {
      expect(
        resolveProfessionalPropertyRecall({
          text: raw(
            'ЖК «Аргумент» - 24-этажный монолитный дом в центре. Получите ключи в сентябре 2026 года. Узнайте больше и забронируйте свою квартиру сегодня. [phone] [url]',
          ),
        }),
      ).toEqual({ label: 'residential-development-leadgen', cap: 'WARN' });
    });

    it('preserves a question about one-room listing shorthand', () => {
      expect(
        resolveProfessionalPropertyRecall({
          text: raw('Что означает 1кк и 5/5 в объявлении о продаже?'),
        }),
      ).toBeNull();
    });

    it.each([
      {
        guard: 'жк inside пятиэтажки',
        text: 'Продаем 2х комнатную квартиру. Комнаты раздельные, 4/5этажки. Просим 2.500, есть торг. Тел [phone].',
      },
      {
        guard: 'bare ЖК in a private long-term rental',
        text: 'Сдаю на длительный срок двухкомнатную квартиру, 53 м.кв. ЖК Суворовский. Этаж 13 из 18. Аренда 25000, залог 25000. [phone]',
      },
      {
        guard: 'bare мкр in a private sale',
        text: 'Продается квартира в мкр. Молодежный, 1 этаж, можно с мебелью. Цена 3 200 000, [phone].',
      },
    ])('preserves an audited private property listing: $guard', ({ text }) => {
      expect(
        resolveProfessionalPropertyRecall({
          text: raw(text),
          campaignContext: CAMPAIGN_CONTEXT,
        }),
      ).toBeNull();
    });

    it('requires a property noun for multi-property inventory', () => {
      expect(
        resolveProfessionalPropertyRecall({
          text: raw(
            'Продам стиральную машинку DEXP, в ремонте не была, продается в связи с переездом. [phone]',
          ),
          campaignContext: CAMPAIGN_CONTEXT,
        }),
      ).toBeNull();

      expect(
        resolveProfessionalPropertyRecall({
          text: raw(
            'Продам квартиру в центре, также продается земельный участок. Документы готовы, [phone]',
          ),
        }),
      ).toEqual({ label: 'multi-property-inventory', cap: 'WARN' });
    });

    it('warns on an audited catalog of separate land listings', () => {
      expect(
        resolveProfessionalPropertyRecall({
          text: raw(
            'Продам участок - 280тр 6 соток, Вавилинский затон [phone]. Продам зем. участок 6 соток, цена 350тр [phone]. Продам ИЖС участок 7 соток, цена 750тр [phone]. Продам огороженный земельный участок 8 соток, цена 750тр [phone].',
          ),
        }),
      ).toEqual({ label: 'multi-property-inventory', cap: 'WARN' });
    });

    it.each([
      'ЖК МЕЧТА 36,1м 7 этаж Вся в ДКП Цена 4 900 000 [phone] Илона',
      'ЖК Абрикосово Евро-2, 37 кв.м, 22 этаж, новый ремонт. Цена 5 700 000 [phone]',
      'Снижение цены. Мкр Любимово, Евро 2, 42м, 20 этаж, мебель и техника. Цена 6 300 000 [phone]',
      'Новинка в продаже. ЖК Губернский, площадь 42м2, 17/20 этаж, полная сумма в ДКП. Цена 6 500 000 [phone]',
      'Срочная продажа. Мкр Любимово, площадь 47м2, разбивка в ДКП. Цена 5 450 000 [phone]',
    ])('warns on an audited professional property card: %s', (text) => {
      expect(resolveProfessionalPropertyRecall({ text: raw(text) })?.cap).toBe('WARN');
    });

    it.each([
      'ПЧО ЖК Ракурс 8 этаж Разбивка Цена 4 000 000 [phone]',
      'Коммерческая недвижимость ЖК Абрикосово 83м2. Можно поделить на два помещения. Новая цена 15 000 000 [phone]',
    ])('warns on an audited compact property business card: %s', (text) => {
      expect(resolveProfessionalPropertyRecall({ text: raw(text) })?.cap).toBe('WARN');
    });

    it('reviews only the heavily structured anonymous rental', () => {
      const detailedRental =
        'Сдается 1 комнатная квартира площадью 35 м² на 1/3 эт. дома. В комнате диван и шкаф. В кухне гарнитур, холодильник и плита. В ванной комнате стиральная машина. Сдам на длительный срок. Арендная плата 18000 руб, залог 18000 руб. Все вопросы по телефону [phone]. ' +
        'Квартира полностью готова к проживанию, коммунальные услуги оплачиваются отдельно.';

      expect(resolveProfessionalPropertyRecall({ text: raw(detailedRental) })).toEqual({
        label: 'structured-rental-review',
        cap: 'REVIEW_ONLY',
      });
      expect(
        resolveProfessionalPropertyRecall({
          text: raw(
            'Предлагаю в аренду студию 29 м2. Что внутри: мебель и техника. Условия аренды: 23000 руб, залог 20000 руб. Звоните [phone].',
          ),
        }),
      ).toBeNull();
    });

    it.each([
      'Продается Тайота Ист. Пробег 71060. Один владелец, стоит в гараже. Продается за ненадобностью. По кузову есть царапины, комплект резины. [phone]',
      'Продается участок под ИЖС. В тихом районе продается ровный земельный участок площадью 1490 м2. Документы готовы. [phone]',
    ])('does not confuse a repeated sale phrase with property inventory: %s', (text) => {
      expect(resolveProfessionalPropertyRecall({ text: raw(text) })).toBeNull();
    });
  });

  describe('recruitment and manual labor', () => {
    it('warns on a structured named-employer vacancy', () => {
      expect(
        resolveStructuredRecruitmentRecall(
          raw('В магазин Семья требуется фасовщик, 4000 рублей смена, график 2 через 2'),
        ),
      ).toEqual({ label: 'named-employer-vacancy', cap: 'WARN' });
    });

    it('warns on a structured shift vacancy with a sanitized phone', () => {
      expect(
        resolveStructuredRecruitmentRecall(
          raw(
            'Упаковщики и стикеровщики. 120 000 ₽ за 30 смен, 4 000 ₽ фикс за смену. Вахта, бесплатное проживание, авансы каждую неделю. График 6/1. [phone]',
          ),
        ),
      ).toEqual({ label: 'structured-shift-vacancy', cap: 'WARN' });
    });

    it('does not turn a job seeker into a vacancy', () => {
      expect(
        resolveStructuredRecruitmentRecall(
          raw('Ищу работу или калым: уборка, погрузка и покраска. Телефон [phone]'),
        ),
      ).toBeNull();
    });

    it('warns only on a sufficiently structured manual-service catalog', () => {
      expect(
        resolveManualLaborServiceRecall(
          raw('Покос травы, перекид угля, бетонные работы, копка ям, чистка печей'),
        ),
      ).toEqual({ label: 'manual-labor-service-catalog', cap: 'WARN' });
      expect(resolveManualLaborServiceRecall(raw('Могу покосить траву и ищу калым'))).toBeNull();
    });
  });

  describe('group promotion', () => {
    it('warns on an explicit trade-group invitation', () => {
      expect(
        resolveGroupPromotionRecall({
          text: raw('Группа купли-продажи. Перейдите по ссылке, чтобы вступить в группу [url]'),
          campaignContext: CAMPAIGN_CONTEXT,
        }),
      ).toEqual({ label: 'explicit-group-promotion', cap: 'WARN' });
    });

    it('reviews a weak free-classifieds link', () => {
      expect(
        resolveGroupPromotionRecall({
          text: raw('Добро пожаловать, бесплатные объявления нашего района [url]'),
        }),
      ).toEqual({ label: 'weak-promo-link', cap: 'REVIEW_ONLY' });
    });

    it('preserves an official emergency channel link', () => {
      expect(
        resolveGroupPromotionRecall({
          text: raw('Официальный канал МЧС: экстренные сообщения и предупреждения [url]'),
        }),
      ).toBeNull();
    });

    it.each([
      'Без рекламы: видео на YouTube как настроить роутер дома, просто инструкция для соседей https://youtube.com/watch?v=abc',
      'Группа для общения. Правила: разрешены музыка, видео и стикеры. Запрещены любые ссылки, спам и реклама. За нарушение правил удаляем. Переходите по ссылке [url].',
      'Добро пожаловать в мой мир страз. Изделия ручной работы, буду рада всем. Мой канал',
      'Реклама запрещена. Ссылка на памятку [url]',
      'Ссылки и реклама запрещены, нарушителей баним. Правила [url]',
      'Не размещайте рекламу, инструкция https://example.org/rules',
    ])('preserves a non-promotional weak-link context: %s', (text) => {
      expect(resolveGroupPromotionRecall({ text: raw(text) })).toBeNull();
    });
  });

  describe('transport services', () => {
    it('warns on an aerial-lift service with capacity and contact', () => {
      expect(resolveTransportServiceRecall(raw('Услуги автовышки 18 метров, тел [phone]'))).toEqual(
        { label: 'aerial-lift-service', cap: 'WARN' },
      );
    });

    it('preserves demand-side cargo coordination', () => {
      expect(
        resolveTransportServiceRecall(raw('Есть груз из Абакана в Кызыл, кто повезет? [phone]')),
      ).toBeNull();
    });
  });

  describe('tour, event, and rental offers', () => {
    it('warns on a priced console rental with booking contact', () => {
      expect(
        resolveTourEventRentalRecall({
          text: raw('Аренда PlayStation 5. Сутки 1200 рублей. Бронируйте по телефону [phone]'),
        }),
      ).toEqual({ label: 'console-rental-offer', cap: 'WARN' });
    });

    it('reviews a ticketed event with an app payment funnel', () => {
      expect(
        resolveTourEventRentalRecall({
          text: raw(
            'Дата: 1 августа. Место: театр Победа. Купить билет в приложении, оплатить через СБП [url]',
          ),
        }),
      ).toEqual({ label: 'ticketed-event-review', cap: 'REVIEW_ONLY' });
    });

    it('preserves a free community outing', () => {
      expect(
        resolveTourEventRentalRecall({
          text: raw('Бесплатная экскурсия для соседей, кто едет с нами в субботу?'),
        }),
      ).toBeNull();
    });
  });

  describe('recurring buyout', () => {
    it('warns on a recurring scrap buyout with price, pickup, and contact', () => {
      expect(
        resolveRecurringBuyoutRecall({
          text: raw(
            'Принимаем металлолом по 15 руб, самовывоз, звоните [phone] в любое время суток',
          ),
        }),
      ).toEqual({ label: 'recurring-scrap-buyout', cap: 'WARN' });
    });

    it('preserves a one-off request for unwanted computer parts', () => {
      expect(
        resolveRecurringBuyoutRecall({
          text: raw('Возьму ненужные компьютерные комплектующие для коллекции'),
        }),
      ).toBeNull();
    });
  });
});
