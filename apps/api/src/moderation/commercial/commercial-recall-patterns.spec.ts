import type { ChatSettings } from '../../prisma/prisma-client';
import type { CommercialCampaignContext } from '../commercial-campaign.util';
import { createRuleDetectionContext } from '../rule-engine-detection-context';
import { CommercialAdDetector } from './commercial-ad.detector';
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
const DETECTOR_SETTINGS = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'STRICT',
  commercialAdsWarnThreshold: 38,
  commercialAdsDeleteThreshold: 55,
} as unknown as ChatSettings;
const detector = new CommercialAdDetector();

function detect(text: string, settings: ChatSettings = DETECTOR_SETTINGS) {
  const context = createRuleDetectionContext({
    text,
    settings,
  });

  return detector.detect({
    normalizedText: context.normalizedText,
    rawLoweredText: context.rawLoweredText,
    settings,
  });
}

describe('bounded commercial recall patterns', () => {
  describe('professional retail', () => {
    it.each([
      {
        branch: 'cosmetics store partner offer',
        text: 'Интернет-магазин корейской косметики: приятные цены и бесплатная доставка. Действует партнерская программа, подробности в личных сообщениях.',
        label: 'cosmetics-store-partner-offer',
      },
      {
        branch: 'named meat store orders',
        text: 'В наличии на продажу свиная и говяжья продукция. Принимаю заявки до вторника, привоз по четвергам. [phone], магазин Мираж.',
        label: 'named-meat-store-orders',
      },
      {
        branch: 'sushi delivery restaurant',
        text: 'Суши и роллы с доставкой каждый день. Акция и скидка на первый заказ. Закажите по телефону [phone] или на сайте [url].',
        label: 'sushi-delivery-restaurant',
      },
      {
        branch: 'poultry farm catalog',
        text: 'Яйца 100 руб, мясо 500 руб, живая птица 1000 руб. Вывод каждую неделю, забой производим по записи. Клетки делаем на заказ. [phone]',
        label: 'poultry-farm-catalog',
      },
      {
        branch: 'named manufacturer price catalog',
        text: 'В «Фабрике кроватей 38» изготавливают кровати. Размеры и цены: 80×200 — 16900 ₽, 90×200 — 17900 ₽, 120×200 — 18900 ₽. Дополнительно можно заказать ящики. Можно приехать в выставочный зал.',
        label: 'named-manufacturer-price-catalog',
      },
      {
        branch: 'passive multi-SKU order catalog',
        text: 'Сейчас принимаются заказы. Гортензия 1500₽, сирень 900₽, ель 2500₽, туя 1200₽. Самовывоз или доставка, телефон [phone].',
        label: 'passive-multi-sku-order-catalog',
      },
      {
        branch: 'furniture stock with installment CTA',
        text: 'Очень много мебели есть в наличии, пишите что вас интересует. Мебель в рассрочку: шкафы, комоды, кровати, диваны, столы и стулья.',
        label: 'furniture-stock-installment',
      },
      {
        branch: 'first-person custom manufacturing promotion',
        text: 'Изготавливаю на заказ кашпо разного объема, цвета и формы. Подписывайтесь: MAX [url], VK [url].',
        label: 'first-person-custom-manufacturing',
      },
    ])('warns on the bounded $branch recall', ({ text, label }) => {
      expect(
        resolveProfessionalRetailRecall({
          text: raw(text),
        }),
      ).toEqual({ label, cap: 'WARN' });
    });

    it.each([
      {
        branch: 'cosmetics store partner offer without a response channel',
        text: 'Интернет-магазин корейской косметики: приятные цены. Действует партнерская программа.',
      },
      {
        branch: 'named meat store orders reduced to a private one-off sale',
        text: 'Продам домашнее мясо одним куском, самовывоз, цена 5000 руб.',
      },
      {
        branch: 'sushi delivery restaurant discussion without an offer',
        text: 'Обсуждаем доставку суши и роллов: где вкуснее и бывают ли скидки?',
      },
      {
        branch: 'poultry farm catalog without prices, fulfillment, or contact',
        text: 'В хозяйстве получают яйца и мясо, содержат живую птицу. Вывод бывает каждую неделю.',
      },
      {
        branch: 'manufacturer discussion without a price catalog',
        text: 'Обсуждали, где фабрика изготавливает кровати и можно ли приехать в выставочный зал.',
      },
      {
        branch: 'buyer looking for cement stock',
        text: 'Подскажите, у кого цемент в наличии и есть доставка? Бюджет 865 рублей, мой телефон [phone].',
      },
      {
        branch: 'historical nursery orders without a current offer',
        text: 'В прошлом году питомник выращивал гортензии. Сейчас питомник закрыт.',
      },
      {
        branch: 'buyer looking for furniture on installment',
        text: 'Ищу мебель в рассрочку: шкаф, комод, кровать и стол. Пишите предложения [phone].',
      },
      {
        branch: 'custom manufacturing note without promotion links',
        text: 'В прошлом году изготавливала кашпо разного объема, цвета и формы для своего сада.',
      },
    ])('preserves the $branch boundary', ({ text }) => {
      expect(
        resolveProfessionalRetailRecall({
          text: raw(text),
        }),
      ).toBeNull();
    });

    it('warns on a packaged size-run catalog', () => {
      expect(
        resolveProfessionalRetailRecall({
          text: raw('Носки, размер 36-41, упаковка 10 шт - 1100 руб, 5 шт - 550 руб'),
        }),
      ).toEqual({ label: 'packaged-apparel-size-run', cap: 'WARN' });
    });

    it('reviews a direct manufacturer order flow without a product catalog', () => {
      expect(
        resolveProfessionalRetailRecall({
          text: raw(
            'Покупай напрямую у производителя. Доставка по всей России, оплата при получении. Нужна помощь в оформлении, пиши [phone].',
          ),
        }),
      ).toEqual({ label: 'direct-manufacturer-order-offer', cap: 'REVIEW_ONLY' });
    });

    it('preserves manufacturer advice without fulfillment and response details', () => {
      expect(
        resolveProfessionalRetailRecall({
          text: raw('В статье советуют покупать напрямую у производителя и сравнивать условия.'),
        }),
      ).toBeNull();
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
    it.each([
      {
        branch: 'clairvoyant self-offer',
        text: 'Я ясновидящая, работаю только во благо. Помогаю разобраться и провожу диагностику. Связаться со мной [phone].',
        label: 'clairvoyant-self-offer',
      },
      {
        branch: 'clairvoyant self-offer after a rhetorical help question',
        text: 'Нужна помощь? Я ясновидящая, работаю только во благо. Помогаю разобраться и провожу диагностику. Связаться со мной [phone].',
        label: 'clairvoyant-self-offer',
      },
      {
        branch: 'energy lawyer channel offer',
        text: 'Юрист-энергетик: технологическое присоединение, коммунальные ресурсы и судебно-техническая экспертиза. Присоединяйтесь к каналу [url].',
        label: 'energy-lawyer-channel-offer',
      },
      {
        branch: 'paid lead service marketplace',
        text: 'Канал площадки для экспертов и мастеров. Заказчики могут разместить заказ [url], мастера получают заявки от 100 ₽ за контакт. Стать мастером [url].',
        label: 'paid-lead-service-marketplace',
      },
      {
        branch: 'professional cleaning catalog',
        text: 'Комплексная уборка квартир, домов, гостиниц и офисов. Опытная команда, цена по запросу [phone].',
        label: 'professional-cleaning-catalog',
      },
      {
        branch: 'owned building material delivery after a rhetorical request',
        text: 'Нужна доставка цемента? Мы доставляем круглосуточно, цена 5000 руб., пишите мне [phone].',
        label: 'owned-building-material-delivery',
      },
      {
        branch: 'paid VPN access',
        text: 'Лёгкий VPN без отключений. Сайт [url], TG [url]. 179 р за 1 месяц, можно подключить 3 устройства.',
        label: 'paid-vpn-access',
      },
      {
        branch: 'air-conditioner installation and sale',
        text: 'Установка кондиционеров, продажа кондиционеров. Наличные, безнал, кредит и рассрочка. [phone] [url]',
        label: 'air-conditioner-installation-sale',
      },
    ])('warns on the bounded $branch recall', ({ text, label }) => {
      expect(resolveLocalServiceRecall(raw(text))).toEqual({ label, cap: 'WARN' });
    });

    it.each([
      {
        branch: 'clairvoyant self-offer without contact',
        text: 'Я ясновидящая, работаю только во благо, помогаю разобраться и провожу диагностику.',
      },
      {
        branch: 'energy lawyer channel offer without a channel link',
        text: 'Юрист-энергетик: технологическое присоединение, коммунальные ресурсы и судебно-техническая экспертиза. Присоединяйтесь к каналу.',
      },
      {
        branch: 'paid lead service marketplace with only one link',
        text: 'Канал площадки для экспертов и мастеров. Заказчики могут разместить заказ [url], мастера получают заявки от 100 ₽ за контакт.',
      },
      {
        branch: 'professional cleaning catalog without a contact',
        text: 'Комплексная уборка квартир, гостиниц и офисов. Опытная команда, цена по запросу.',
      },
      {
        branch: 'paid VPN access without a paid period',
        text: 'Подскажите бесплатный VPN для доступа к учебному сайту [url].',
      },
      {
        branch: 'air-conditioner installation and sale without terms or contact',
        text: 'Установка кондиционеров и продажа кондиционеров обсуждались перед началом сезона.',
      },
    ])('preserves the $branch boundary', ({ text }) => {
      expect(resolveLocalServiceRecall(raw(text))).toBeNull();
    });

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
      'Ищу мастера по ремонту холодильника. Я работаю дома, мой телефон [phone].',
      'Кто ремонтирует холодильники? Я работаю дома, нужен мастер, бюджет до 5000 руб., мой телефон [phone].',
      'Нужен ремонт холодильника. Я предлагаю оплату 3000 руб. Пишите мне [phone].',
      'Нужен ремонт холодильника. Я предлагаю бюджет 3000 руб. Пишите мне [phone].',
      'Нужен ремонт холодильника. Я предлагаю цену 3000 руб. Пишите мне [phone].',
      'Нужен ремонт холодильника. Я предлагаю ставку 3000 руб. Пишите мне [phone].',
      'Нужен ремонт холодильника. Я предлагаю вознаграждение 3000 руб. Пишите мне [phone].',
      'Нужен ремонт холодильника. Я предлагаю условия 3000 руб. Пишите мне [phone].',
    ])('does not treat incidental first-person work wording as a service offer: %s', (text) => {
      expect(resolveLocalServiceRecall(raw(text))).toBeNull();
      for (const settings of [
        DETECTOR_SETTINGS,
        {
          ...DETECTOR_SETTINGS,
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 57,
          commercialAdsDeleteThreshold: 77,
        } as unknown as ChatSettings,
      ]) {
        expect(detect(text, settings)?.actionable ?? false).toBe(false);
      }
    });

    it('preserves a first-person appliance repair offer after a rhetorical demand opener', () => {
      const text =
        'Нужен ремонт холодильника? Я предлагаю ремонт холодильников с выездом и гарантией. Пишите мне [phone].';

      expect(resolveLocalServiceRecall(raw(text))).toEqual({
        label: 'appliance-repair-self-offer',
        cap: 'WARN',
      });
      for (const settings of [
        DETECTOR_SETTINGS,
        {
          ...DETECTOR_SETTINGS,
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 57,
          commercialAdsDeleteThreshold: 77,
        } as unknown as ChatSettings,
      ]) {
        expect(detect(text, settings)?.actionBand).toBe('WARN');
      }
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
    it.each([
      {
        branch: 'expanded last-lot sales offer',
        text: 'Последний горящий лот! Есть 1к, 2к и 3к квартиры. Семейная ипотека от 3.5%. Ключи и подарок в день сделки. [phone]',
      },
    ])('warns on the $branch', ({ text }) => {
      expect(
        resolveProfessionalPropertyRecall({
          text: raw(text),
        }),
      ).toEqual({ label: 'last-lots-sales-offer', cap: 'WARN' });
    });

    it.each([
      {
        branch: 'expanded last-lot sales offer without a response channel',
        text: 'Последний горящий лот! Есть 1к, 2к и 3к квартиры. Семейная ипотека от 3.5%. Ключи и подарок в день сделки.',
      },
    ])('preserves the $branch boundary', ({ text }) => {
      expect(resolveProfessionalPropertyRecall({ text: raw(text) })).toBeNull();
    });

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
    it.each([
      {
        branch: 'daily-paid worker vacancy',
        text: 'Требуются рабочие на монтаж вентиляции. Оплата каждый день от 2500 руб. [phone]',
        label: 'daily-paid-worker-vacancy',
      },
      {
        branch: 'named production shift vacancy',
        text: 'Вахта на производство Hyundai. Нужны разнорабочие и водители погрузчика, 4500 ₽ за смену. Проживание и питание, покупаем билеты. [phone]',
        label: 'named-production-shift-vacancy',
      },
      {
        branch: 'retail pavilion vacancy',
        text: 'Требуется продавец в павильон. График с 8 до 20, опыт обязателен. Оплата еженедельно. [phone]',
        label: 'retail-pavilion-vacancy',
      },
    ])('warns on the bounded $branch recall', ({ text, label }) => {
      expect(resolveStructuredRecruitmentRecall(raw(text))).toEqual({ label, cap: 'WARN' });
    });

    it.each([
      {
        branch: 'daily-paid worker vacancy without a contact',
        text: 'Требуются рабочие на монтаж вентиляции. Оплата каждый день от 2500 руб.',
      },
      {
        branch: 'named production shift vacancy without the named production',
        text: 'Вахта на производство. Нужны разнорабочие и водители погрузчика, 4500 ₽ за смену. Проживание и питание, покупаем билеты. [phone]',
      },
      {
        branch: 'retail pavilion vacancy without weekly pay or contact',
        text: 'Требуется продавец в павильон. График с 8 до 20, опыт обязателен.',
      },
    ])('preserves the $branch boundary', ({ text }) => {
      expect(resolveStructuredRecruitmentRecall(raw(text))).toBeNull();
    });

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

    it.each([
      {
        branch: 'priced yard mowing service',
        text: 'Покос травы бензо-триммером 500р сотка. [phone]',
      },
      {
        branch: 'first-person priced yard mowing service',
        text: 'Могу выполнить покос травы бензо-триммером, 500р сотка. [phone]',
      },
    ])('warns on the $branch', ({ text }) => {
      expect(resolveManualLaborServiceRecall(raw(text))).toEqual({
        label: 'priced-yard-mowing-service',
        cap: 'WARN',
      });
    });

    it.each([
      {
        branch: 'priced yard mowing service expressed as demand',
        text: 'Нужен покос травы на шести сотках.',
      },
    ])('preserves the $branch boundary', ({ text }) => {
      expect(resolveManualLaborServiceRecall(raw(text))).toBeNull();
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

    it.each([
      {
        branch: 'multi-chat directory',
        text: 'Доска объявлений: присоединяйтесь в чат рекламы [url], чат барахолки [url], чат коммерции [url].',
        label: 'multi-chat-directory',
      },
      {
        branch: 'paid commercial promo group',
        text: 'Тематическая группа района. Платная коммерческая реклама: пишите админу, ответная ссылка [url].',
        label: 'paid-commercial-promo-group',
      },
      {
        branch: 'church channel with paid commercial placement',
        text: 'Канал храма: расписание богослужений. Платная коммерческая реклама: пишите админу, ответная ссылка [url].',
        label: 'paid-commercial-promo-group',
      },
      {
        branch: 'museum group with paid commercial placement',
        text: 'Группа музея: афиша выставок и мероприятий. Платная коммерческая реклама: пишите админу, ответная ссылка [url].',
        label: 'paid-commercial-promo-group',
      },
      {
        branch: 'gardeners group with paid commercial placement',
        text: 'Группа садоводов: обмен опытом и советы. Платная коммерческая реклама: пишите админу, ответная ссылка [url].',
        label: 'paid-commercial-promo-group',
      },
      {
        branch: 'mutual engagement chat',
        text: 'Чат взаимных реакций и подписок: реакции, подписки и комментарии [url].',
        label: 'mutual-engagement-chat',
      },
      {
        branch: 'first-person mutual subscription promotion',
        text: 'Привет, предлагаю взаимные подписки без отписок. Пиар-чат и реклама предложений [url].',
        label: 'mutual-engagement-chat',
      },
      {
        branch: 'plural subscribe frame',
        text: 'Подпишитесь на наш канал, там новые публикации [url].',
        label: 'explicit-group-promotion',
      },
      {
        branch: 'owned professional channel promotion',
        text: 'Я врач. В моих каналах рассказываю о здоровье и питании [url]. Подпишитесь, чтобы получать советы.',
        label: 'explicit-group-promotion',
      },
      {
        branch: 'commercial catalog inside a residential group frame',
        text: 'Жители дома, подпишитесь на группу нашего ТСЖ для уведомлений об отключениях и каталога товаров со скидками [url].',
        label: 'explicit-group-promotion',
      },
      {
        branch: 'store promotion presented as news',
        text: 'Новости скидок и акций нашего магазина. Подписывайтесь на канал [url].',
        label: 'explicit-group-promotion',
      },
      {
        branch: 'owned MAX classifieds network',
        text: 'Добро пожаловать в сообщество! Здесь вы можете разместить свое объявление. Взаимный обмен ссылками. Наши группы MAX: Чита [url], Смоленка [url], Благодатный [url].',
        label: 'owned-classifieds-network',
      },
      {
        branch: 'high-volume advertising chat catalog',
        text: 'Чаты MAX: биржа рекламы, пиар чат, взаимные ссылки. Взаимная подписка и рассылка по чатам. Каталог каналов и групп [url] [url] [url] [url] [url] [url].',
        label: 'multi-chat-directory',
      },
    ])('warns on the bounded $branch recall', ({ text, label }) => {
      expect(resolveGroupPromotionRecall({ text: raw(text) })).toEqual({ label, cap: 'WARN' });
    });

    it('keeps a dash-separated paid placement offer actionable', () => {
      const text =
        'Тематическая группа вакансий и услуг. Бесплатно - вакансии и услуги. ' +
        'Платно - коммерческая реклама не по теме группы и ссылки (пишите админу). ' +
        'Жду ответную ссылку [url].';

      expect(resolveGroupPromotionRecall({ text: raw(text) })).toEqual({
        label: 'paid-commercial-promo-group',
        cap: 'WARN',
      });
      expect(detect(text)?.actionBand).toBe('WARN');
    });

    it.each([
      {
        branch: 'three-assertion response and link',
        text: 'Платная коммерческая реклама. Для размещения пишите админу. Ответная ссылка [url]',
      },
      {
        branch: 'official channel offer',
        text: 'Официальный канал города. Платная коммерческая реклама. Пишите админу [url].',
      },
      {
        branch: 'unrelated historical clause before a current offer',
        text: 'Раньше группа называлась иначе, сегодня платная коммерческая реклама. Пишите админу [url].',
      },
      {
        branch: 'unrelated trailing transition after a complete offer',
        text: 'Платная коммерческая реклама, пишите админу [url], а сейчас перейдем к новостям.',
      },
      {
        branch: 'unrelated prohibition after an explicit permission',
        text: 'Платная коммерческая реклама разрешена, но запрещены оскорбления. Пишите админу [url].',
      },
      {
        branch: 'independent offer after a rules question',
        text: 'Кто-нибудь знает, разрешена ли платная коммерческая реклама? Отдельно: платная коммерческая реклама. Пишите админу [url].',
      },
      {
        branch: 'neutral administrator bridge',
        text: 'Платная коммерческая реклама. Подробности у администратора. Пишите админу [url].',
      },
    ])('warns on the bounded paid-placement $branch', ({ text }) => {
      expect(resolveGroupPromotionRecall({ text: raw(text) })).toEqual({
        label: 'paid-commercial-promo-group',
        cap: 'WARN',
      });
      for (const settings of [
        DETECTOR_SETTINGS,
        {
          ...DETECTOR_SETTINGS,
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 57,
          commercialAdsDeleteThreshold: 77,
        } as unknown as ChatSettings,
      ]) {
        expect(detect(text, settings)?.actionBand).toBe('WARN');
      }
    });

    it.each([
      {
        branch: 'rules question with an administrative contact',
        text: 'Кто-нибудь знает, разрешена ли платная коммерческая реклама? Пишите админу группы по вопросам правил [url].',
      },
      {
        branch: 'official channel prohibition',
        text: 'Официальный канал города. Платная коммерческая реклама не допускается. Пишите админу [url].',
      },
      {
        branch: 'tutorial quote with an intervening explanation',
        text: 'В учебном тексте написано: «Платно - коммерческая реклама: пишите админу [url]». Формулировка дана для разбора. Это цитата, не предложение.',
      },
    ])('preserves the bounded paid-placement $branch', ({ text }) => {
      expect(resolveGroupPromotionRecall({ text: raw(text) })).toBeNull();
      for (const settings of [
        DETECTOR_SETTINGS,
        {
          ...DETECTOR_SETTINGS,
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 57,
          commercialAdsDeleteThreshold: 77,
        } as unknown as ChatSettings,
      ]) {
        expect(detect(text, settings)).toBeNull();
      }
    });

    it.each([
      {
        branch: 'reverse-order paid placement verb',
        text: 'Коммерческую рекламу размещаем платно. Пишите админу [url].',
      },
      {
        branch: 'reverse-order paid placement noun',
        text: 'Размещение коммерческой рекламы платное. Пишите админу [url].',
      },
      {
        branch: 'administrator response synonym',
        text: 'Платное размещение коммерческой рекламы. Обращайтесь к администратору [url].',
      },
      {
        branch: 'seller rhetorical question',
        text: 'Хотите разместить платную коммерческую рекламу? Пишите админу [url].',
      },
      {
        branch: 'administrator contact',
        text: 'Платная коммерческая реклама. Контакт администратора [url].',
      },
      {
        branch: 'administrator connection',
        text: 'Платная коммерческая реклама. Связь с админом [url].',
      },
      {
        branch: 'administrator direct-message contact',
        text: 'Платная коммерческая реклама. В личку администратору [url].',
      },
      {
        branch: 'dash-separated reverse paid placement',
        text: 'Коммерческая реклама — платно. Пишите админу [url].',
      },
      {
        branch: 'paid-basis placement',
        text: 'Реклама на платной основе. Пишите админу [url].',
      },
    ])('warns on the final paid-placement $branch in both profiles', ({ text }) => {
      expect(resolveGroupPromotionRecall({ text: raw(text) })).toEqual({
        label: 'paid-commercial-promo-group',
        cap: 'WARN',
      });
      for (const settings of [
        DETECTOR_SETTINGS,
        {
          ...DETECTOR_SETTINGS,
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 57,
          commercialAdsDeleteThreshold: 77,
        } as unknown as ChatSettings,
      ]) {
        const result = detect(text, settings);
        expect(result?.actionBand).toBe('WARN');
        expect(result?.actionable).toBe(true);
      }
    });

    it.each([
      {
        branch: 'discussion with unrelated admin and third-assertion link',
        text: 'На собрании обсудили платную коммерческую рекламу. По вопросам протокола пишите админу. Ссылка: [url].',
      },
      {
        branch: 'documentation with unrelated admin and third-assertion link',
        text: 'В документации описана платная коммерческая реклама. По вопросам документа пишите админу. Ссылка: [url].',
      },
      {
        branch: 'discussion with unrelated linked admin response',
        text: 'На собрании обсудили платную коммерческую рекламу. По вопросам протокола пишите админу [url].',
      },
      {
        branch: 'documentation with unrelated linked admin response',
        text: 'В документации описана платная коммерческая реклама. По вопросам документа пишите админу [url].',
      },
      {
        branch: 'regulation mentioning paid placement',
        text: 'Регламент упоминает платную коммерческую рекламу. По вопросам документа пишите админу [url].',
      },
      {
        branch: 'meeting mention with a protocol contact',
        text: 'На совещании говорили о платной коммерческой рекламе. По вопросам протокола пишите админу [url].',
      },
      {
        branch: 'first-person placement prohibition',
        text: 'Платную коммерческую рекламу мы не размещаем. Пишите админу [url].',
      },
      {
        branch: 'ended placement acceptance',
        text: 'Платную коммерческую рекламу больше не принимаем. Пишите админу [url].',
      },
      {
        branch: 'current prohibited placement',
        text: 'Платная коммерческая реклама сейчас запрещена. Пишите админу [url].',
      },
      {
        branch: 'prohibited placement infinitive',
        text: 'Платную коммерческую рекламу запрещено размещать. Пишите админу [url].',
      },
      {
        branch: 'placement not admitted',
        text: 'Не допускается размещение платной коммерческой рекламы. Пишите админу [url].',
      },
      {
        branch: 'inadmissible placement',
        text: 'Платная коммерческая реклама недопустима. Пишите админу [url].',
      },
      {
        branch: 'placement under prohibition',
        text: 'Платная коммерческая реклама под запретом. Пишите админу [url].',
      },
      {
        branch: 'historical permission with a current prohibition',
        text: 'Раньше платная коммерческая реклама была разрешена. Сейчас запрещена. Пишите админу [url].',
      },
      {
        branch: 'complete offer followed by an anaphoric prohibition',
        text: 'Платная коммерческая реклама: пишите админу [url]. Сейчас не допускается.',
      },
      {
        branch: 'placement price question',
        text: 'Сколько стоит платная коммерческая реклама? Пишите админу [url].',
      },
      {
        branch: 'placement permission question',
        text: 'Платная коммерческая реклама разрешена? Пишите админу [url].',
      },
      {
        branch: 'placement acceptance question',
        text: 'Принимаете платную коммерческую рекламу? Пишите админу [url].',
      },
      {
        branch: 'placement price wording question',
        text: 'Какая цена на платную коммерческую рекламу? Пишите админу [url].',
      },
      {
        branch: 'placement availability question',
        text: 'Есть ли платная коммерческая реклама? Пишите админу [url].',
      },
      {
        branch: 'placement location question',
        text: 'Где можно разместить платную коммерческую рекламу? Пишите админу [url].',
      },
      {
        branch: 'tutorial quote introduced by the previous assertion',
        text: 'В учебном тексте дан следующий пример. «Платная коммерческая реклама: пишите админу [url]». Формулировка дана для разбора. Это цитата, не предложение.',
      },
      {
        branch: 'placement question with a neutral administrator bridge',
        text: 'Разрешена ли платная коммерческая реклама? Подробности у администратора. Пишите админу [url].',
      },
      {
        branch: 'placement prohibition with a neutral administrator bridge',
        text: 'Платная коммерческая реклама запрещена. Подробности у администратора. Пишите админу [url].',
      },
    ])('keeps the final paid-placement $branch non-actionable in both profiles', ({ text }) => {
      expect(resolveGroupPromotionRecall({ text: raw(text) })?.cap ?? null).not.toBe('WARN');
      for (const settings of [
        DETECTOR_SETTINGS,
        {
          ...DETECTOR_SETTINGS,
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 57,
          commercialAdsDeleteThreshold: 77,
        } as unknown as ChatSettings,
      ]) {
        const result = detect(text, settings);
        expect(['ALLOW', 'REVIEW_ONLY']).toContain(result?.actionBand ?? 'ALLOW');
        expect(result?.actionable ?? false).toBe(false);
      }
    });

    it.each([
      {
        branch: 'named discounts channel',
        text: 'Подпишитесь на канал Скидки дня [url].',
        expectedRecall: { label: 'explicit-group-promotion', cap: 'WARN' },
        expectedAction: 'WARN',
      },
      {
        branch: 'named sales channel',
        text: 'Подпишитесь на канал распродаж [url].',
        expectedRecall: { label: 'explicit-group-promotion', cap: 'WARN' },
        expectedAction: 'WARN',
      },
      {
        branch: 'named bargain-shopping channel',
        text: 'Подпишитесь на канал выгодных покупок [url].',
        expectedRecall: { label: 'explicit-group-promotion', cap: 'WARN' },
        expectedAction: 'WARN',
      },
      {
        branch: 'noncommercial named channel',
        text: 'Подпишитесь на канал Расписание дня [url].',
        expectedRecall: null,
        expectedAction: null,
      },
      {
        branch: 'commercial multi-chat directory',
        text: 'Доска объявлений: присоединяйтесь в чат рекламы [url], чат барахолки [url], чат коммерции [url].',
        expectedRecall: { label: 'multi-chat-directory', cap: 'WARN' },
        expectedAction: 'WARN',
      },
      {
        branch: 'operational multi-chat directory with one ambiguous cue',
        text: 'Присоединяйтесь: чат нашего дома для объявлений [url], чат родителей [url], чат спортивной секции [url].',
        expectedRecall: null,
        expectedAction: null,
      },
      {
        branch: 'direct mutual-engagement chat',
        text: 'Чат взаимных реакций и подписок: реакции, подписки и комментарии [url].',
        expectedRecall: { label: 'mutual-engagement-chat', cap: 'WARN' },
        expectedAction: 'WARN',
      },
      {
        branch: 'editorial quote of a chat invitation',
        text: 'Исследование цитирует приглашение «присоединяйтесь в чат» и анализирует реакции участников [url].',
        expectedRecall: null,
        expectedAction: null,
      },
      {
        branch: 'explicit group link exchange',
        text: 'Чат обмена ссылками: участники размещают ссылки на свои группы [url].',
        expectedRecall: { label: 'link-exchange-group', cap: 'REVIEW_ONLY' },
        expectedAction: 'REVIEW_ONLY',
      },
      {
        branch: 'owned reciprocal multi-channel offer',
        text: 'Давайте поддержим друг друга подпиской? У меня два канала: [url] и [url]. Я подписываюсь на вас в ответ. Оставьте ссылку на свои каналы в личных сообщениях. Взаимно подпишусь в течение суток.',
        expectedRecall: { label: 'mutual-engagement-chat', cap: 'REVIEW_ONLY' },
        expectedAction: 'REVIEW_ONLY',
      },
      {
        branch: 'group link-policy documentation',
        text: 'Ссылочная политика группы исследователей описана в документации [url].',
        expectedRecall: null,
        expectedAction: null,
      },
    ])('aligns the $branch resolver and full detector boundary', (testCase) => {
      expect(resolveGroupPromotionRecall({ text: raw(testCase.text) })).toEqual(
        testCase.expectedRecall,
      );
      expect(detect(testCase.text)?.actionBand ?? null).toBe(testCase.expectedAction);
    });

    it.each([
      { sensitivity: 'STRICT', warnThreshold: 38, deleteThreshold: 55 },
      { sensitivity: 'BALANCED', warnThreshold: 57, deleteThreshold: 77 },
    ] as const)(
      'ignores a paid-placement prohibition in the $sensitivity profile',
      ({ sensitivity, warnThreshold, deleteThreshold }) => {
        const text =
          'Канал храма: расписание служб.\n' +
          'Платная коммерческая реклама не допускается.\n' +
          'Пишите админу, ответная ссылка [url].';
        const settings = {
          ...DETECTOR_SETTINGS,
          commercialAdsSensitivity: sensitivity,
          commercialAdsWarnThreshold: warnThreshold,
          commercialAdsDeleteThreshold: deleteThreshold,
        } as unknown as ChatSettings;

        const result = detect(text, settings);

        expect(result).toBeNull();
        expect(result?.matchedSignals ?? []).toEqual([]);
      },
    );

    it.each([
      {
        branch: 'multi-chat directory with only two linked chats',
        text: 'Присоединяйтесь: чат района [url] и чат родителей [url].',
      },
      {
        branch: 'paid commercial promo group prohibition',
        text: 'Тематическая группа района. Коммерческая реклама запрещена, платные объявления тоже запрещены. Пишите админу [url].',
      },
      {
        branch: 'paid commercial promo group prohibition with a dash separator',
        text: 'Тематическая группа района. Платно - коммерческая реклама не допускается. Пишите админу, ответная ссылка [url].',
      },
      {
        branch: 'church channel where paid ads are not allowed',
        text: 'Канал храма: расписание служб. Платная коммерческая реклама не допускается. Пишите админу, ответная ссылка [url].',
      },
      {
        branch: 'museum group where paid ads are not permitted',
        text: 'Группа музея: афиша выставок. Платная коммерческая реклама не разрешается. Пишите админу, ответная ссылка [url].',
      },
      {
        branch: 'gardeners group that does not place paid ads',
        text: 'Группа садоводов: обмен опытом и советы. Платную коммерческую рекламу не размещаем. Пишите админу, ответная ссылка [url].',
      },
      {
        branch: 'dacha chat that does not accept paid ads',
        text: 'Чат дачников: советы по участкам. Не принимаем платную коммерческую рекламу. Пишите админу, ответная ссылка [url].',
      },
      {
        branch: 'complaint about paid commercial placement',
        text: 'Группа района. По жалобам на платное размещение коммерческой рекламы пишите админу [url].',
      },
      {
        branch: 'discussion of paid commercial placement rules',
        text: 'В группе обсуждаем правила платного размещения коммерческой рекламы. Пишите админу предложения по правилам [url].',
      },
      {
        branch: 'training example of paid commercial placement',
        text: 'В чате модераторов разбираем пример: платное размещение коммерческой рекламы, пишите админу [url]. Это учебный текст.',
      },
      {
        branch: 'mutual engagement chat without a link',
        text: 'Чат взаимных реакций и подписок: реакции, подписки и комментарии.',
      },
      {
        branch: 'plural subscribe frame in an editorial post',
        text: 'Новости района: городские службы завершили ремонт. Подпишитесь на наш канал [url].',
      },
      {
        branch: 'sale wording inside an editorial post',
        text: 'Новости района: суд рассмотрел дело о продаже квартиры. Подпишитесь на канал [url].',
      },
      {
        branch: 'protest coverage with a closed-store mention',
        text: 'Новости района: магазин закрылся, прошли акции протеста. Подписывайтесь на канал [url].',
      },
      {
        branch: 'plural subscribe frame beside an independently actionable phone offer',
        text: 'Гелиевые шары и фотозоны на заказ. Пишите, звоните [phone]. Подпишитесь на наши группы [url].',
      },
      {
        branch: 'residential operational group',
        text: 'Жители дома, подпишитесь на группу нашего ТСЖ для получения уведомлений об отключениях [url].',
      },
      {
        branch: 'entrance operational channel',
        text: 'Жильцы подъезда, подпишитесь на канал дома для уведомлений об отключениях воды [url].',
      },
      {
        branch: 'kindergarten operational group',
        text: 'Пожалуйста, подпишитесь на группу детского сада для объявлений воспитателя [url].',
      },
      {
        branch: 'sports section operational group',
        text: 'Родители, подпишитесь на группу спортивной секции для сообщений тренера [url].',
      },
      {
        branch: 'sports club participant operational group',
        text: 'Участники секции, подпишитесь на группу спортивного клуба для уведомлений о тренировках [url].',
      },
      {
        branch: 'football team operational group',
        text: 'Родители игроков, подпишитесь на канал футбольной команды для расписания тренировок [url].',
      },
      {
        branch: 'football section parent operational group',
        text: 'Родители команды, подпишитесь на группу футбольной секции для уведомлений о тренировках и выездах [url].',
      },
      {
        branch: 'volunteer logistics group',
        text: 'Волонтеры, подпишитесь на группу для координации доставки гуманитарной помощи [url].',
      },
      {
        branch: 'volunteer search team group',
        text: 'Волонтеры, подпишитесь на группу поискового отряда для координации выездов [url].',
      },
      {
        branch: 'volunteer collection action group',
        text: 'Волонтеры, подпишитесь на группу для координации акции по сбору вещей и доставки гуманитарной помощи [url].',
      },
      {
        branch: 'religious schedule channel',
        text: 'Подпишитесь на канал храма, там расписание служб [url].',
      },
      {
        branch: 'gardening experience group',
        text: 'Садоводы, подпишитесь на группу для обмена опытом и советами [url].',
      },
      {
        branch: 'noncommercial multi-chat directory',
        text: 'Присоединяйтесь: чат нашего дома [url], чат родителей [url], чат спортивной секции [url].',
      },
      {
        branch: 'third-party reciprocal subscribe request',
        text: 'Канал не мой, но прошу помочь: подпишитесь, пожалуйста, могу подписаться взамен [url].',
      },
      {
        branch: 'small owned project directory without ad placement',
        text: 'Наши группы MAX: семейный фотоархив [url], клуб чтения [url], школьный проект [url].',
      },
      {
        branch: 'recipe channel directory without advertising chats',
        text: 'Каталог каналов и групп с рецептами: супы [url], выпечка [url], салаты [url], завтраки [url], ужины [url], десерты [url].',
      },
      {
        branch: 'dietitian information channel',
        text: 'Канал диетолога о доказательном питании: статьи и ответы на вопросы [url].',
      },
    ])('preserves the $branch boundary', ({ text }) => {
      expect(resolveGroupPromotionRecall({ text: raw(text) })).toBeNull();
    });

    it.each([
      {
        branch: 'school operations before a separate store discount link',
        text: 'Школьная группа: объявления учителя и расписание уроков [url]. Отдельно: наш магазин со скидками [url].',
      },
      {
        branch: 'volunteer operations before a separate owned store link',
        text: 'Волонтеры, подпишитесь на группу для координации доставки гуманитарной помощи [url]. Отдельно: ссылка на наш магазин [url].',
      },
    ])('warns on the explicit merchant promotion after $branch', ({ text }) => {
      expect(resolveGroupPromotionRecall({ text: raw(text) })).toEqual({
        label: 'explicit-group-promotion',
        cap: 'WARN',
      });
      for (const settings of [
        DETECTOR_SETTINGS,
        {
          ...DETECTOR_SETTINGS,
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 57,
          commercialAdsDeleteThreshold: 77,
        } as unknown as ChatSettings,
      ]) {
        expect(detect(text, settings)?.actionBand).toBe('WARN');
      }
    });

    it.each([
      {
        branch: 'school operations and a separate schedule link',
        text: 'Школьная группа: объявления учителя и расписание уроков [url]. Отдельно: расписание кружков [url].',
      },
      {
        branch: 'volunteer operations and a separate aid-delivery link',
        text: 'Волонтеры, подпишитесь на группу для координации доставки гуманитарной помощи [url]. Отдельно: заявки на доставку помощи [url].',
      },
    ])('keeps same-topic $branch non-actionable', ({ text }) => {
      expect(resolveGroupPromotionRecall({ text: raw(text) })).toBeNull();
      for (const settings of [
        DETECTOR_SETTINGS,
        {
          ...DETECTOR_SETTINGS,
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 57,
          commercialAdsDeleteThreshold: 77,
        } as unknown as ChatSettings,
      ]) {
        expect(detect(text, settings)?.actionable ?? false).toBe(false);
      }
    });

    it('warns on a current paid placement offer after a historical prohibition', () => {
      const text =
        'Раньше коммерческая реклама была запрещена, но теперь разрешено платное размещение коммерческой рекламы. Пишите админу [url].';

      expect(resolveGroupPromotionRecall({ text: raw(text) })).toEqual({
        label: 'paid-commercial-promo-group',
        cap: 'WARN',
      });
      expect(detect(text)?.actionBand).toBe('WARN');
    });

    it('does not apply an unrelated historical sentence to a current paid placement offer', () => {
      const text =
        'Раньше группа называлась Новости. Платная коммерческая реклама. Пишите админу [url].';

      expect(resolveGroupPromotionRecall({ text: raw(text) })).toEqual({
        label: 'paid-commercial-promo-group',
        cap: 'WARN',
      });
      expect(detect(text)?.actionBand).toBe('WARN');
    });

    it.each([
      {
        branch: 'discussion before an independent offer',
        text: 'Модераторы обсуждали правила платного размещения рекламы. Платная коммерческая реклама. Пишите админу, ответная ссылка [url].',
      },
      {
        branch: 'discussion after a complete offer',
        text: 'Платная коммерческая реклама. Пишите админу, ответная ссылка [url]. Позже модераторы обсуждали правила платного размещения рекламы.',
      },
      {
        branch: 'tutorial quote after a complete offer',
        text: 'Платная коммерческая реклама. Пишите админу, ответная ссылка [url]. В учебном тексте написано: «Платная коммерческая реклама запрещена». Это цитата, не предложение.',
      },
    ])('keeps the paid placement offer independent from a neighboring $branch', ({ text }) => {
      expect(resolveGroupPromotionRecall({ text: raw(text) })).toEqual({
        label: 'paid-commercial-promo-group',
        cap: 'WARN',
      });
      expect(detect(text)?.actionBand).toBe('WARN');
    });

    it.each([
      'В другом канале платная коммерческая реклама запрещена.',
      'В канале Новости платная коммерческая реклама запрещена.',
      'Для группы Соседи платная коммерческая реклама запрещена.',
    ])('does not let an external prohibition suppress a complete offer: %s', (suffix) => {
      const control = 'Размещаем платную коммерческую рекламу. Пишите админу [url].';
      const text = `${control} ${suffix}`;

      expect(resolveGroupPromotionRecall({ text: raw(text) })).toEqual({
        label: 'paid-commercial-promo-group',
        cap: 'WARN',
      });
      for (const settings of [
        DETECTOR_SETTINGS,
        {
          ...DETECTOR_SETTINGS,
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 57,
          commercialAdsDeleteThreshold: 77,
        } as unknown as ChatSettings,
      ]) {
        const controlBand = detect(control, settings)?.actionBand;
        expect(controlBand).toBe('WARN');
        expect(detect(text, settings)?.actionBand).toBe(controlBand);
      }
    });

    it.each([
      'В нашей группе платная коммерческая реклама запрещена.',
      'В группе сейчас платная коммерческая реклама запрещена.',
      'В группе не размещаем платную коммерческую рекламу.',
    ])('lets a local prohibition suppress a complete offer: %s', (suffix) => {
      const text = 'Размещаем платную коммерческую рекламу. Пишите админу [url]. ' + suffix;

      expect(resolveGroupPromotionRecall({ text: raw(text) })).toBeNull();
      for (const settings of [
        DETECTOR_SETTINGS,
        {
          ...DETECTOR_SETTINGS,
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 57,
          commercialAdsDeleteThreshold: 77,
        } as unknown as ChatSettings,
      ]) {
        expect(detect(text, settings)?.actionable ?? false).toBe(false);
      }
    });

    it('lets an explicit current permission override an earlier rules discussion', () => {
      const text =
        'Вчера модераторы обсуждали правила платного размещения рекламы. Но теперь разрешена платная коммерческая реклама: пишите админу, ответная ссылка https://max.ru/foo.';

      expect(resolveGroupPromotionRecall({ text: raw(text) })).toEqual({
        label: 'paid-commercial-promo-group',
        cap: 'WARN',
      });
      expect(detect(text)?.actionBand).toBe('WARN');
    });

    it('lets a dash-separated current permission override an earlier rules discussion', () => {
      const text =
        'Вчера модераторы обсуждали правила платного размещения рекламы. ' +
        'Но теперь разрешено: платно - коммерческая реклама, пишите админу, ответная ссылка [url].';

      expect(resolveGroupPromotionRecall({ text: raw(text) })).toEqual({
        label: 'paid-commercial-promo-group',
        cap: 'WARN',
      });
      expect(detect(text)?.actionBand).toBe('WARN');
    });

    it('keeps current permission inside a qualified tutorial quote non-actionable', () => {
      const text =
        'Модераторы обсуждают правила платного размещения рекламы. В учебном примере написано: «Но теперь разрешена платная коммерческая реклама: пишите админу, ответная ссылка [url]». Это цитата, не предложение.';

      expect(resolveGroupPromotionRecall({ text: raw(text) })).toBeNull();
      expect(detect(text)).toBeNull();
    });

    it('keeps current permission inside a qualified tutorial text non-actionable', () => {
      const text =
        'Модераторы обсуждают правила платного размещения рекламы. В учебном тексте написано: «Но теперь разрешена платная коммерческая реклама: пишите админу, ответная ссылка [url]». Это цитата, не предложение.';

      expect(resolveGroupPromotionRecall({ text: raw(text) })).toBeNull();
      expect(detect(text)).toBeNull();
    });

    it('keeps dash-separated paid placement inside a qualified tutorial quote non-actionable', () => {
      const text =
        'Модераторы обсуждают правила платного размещения рекламы. ' +
        'В учебном тексте написано: «Платно - коммерческая реклама: пишите админу, ответная ссылка [url]». ' +
        'Это цитата, не предложение.';

      expect(resolveGroupPromotionRecall({ text: raw(text) })).toBeNull();
      expect(detect(text)).toBeNull();
    });

    it('lets an explicit current prohibition override permission-like wording', () => {
      const text =
        'А сейчас размещаем правило: платная коммерческая реклама не допускается. Пишите админу [url].';

      expect(resolveGroupPromotionRecall({ text: raw(text) })).toBeNull();
      expect(detect(text)).toBeNull();
    });

    it.each(['не публикуем', 'не распространяем', 'не присылайте'])(
      'does not treat a paid-ad rule with "%s" as an offer',
      (negatedAction) => {
        const text = `Правила группы: платную рекламу ${negatedAction}. Пишите админу, ответная ссылка [url].`;

        expect(resolveGroupPromotionRecall({ text: raw(text) })).toBeNull();
        expect(detect(text)).toBeNull();
      },
    );

    it('does not let a later historical note suppress a complete paid placement offer', () => {
      const text =
        'Платная коммерческая реклама. Пишите админу, ответная ссылка [url]. Раньше платная коммерческая реклама была запрещена.';

      expect(resolveGroupPromotionRecall({ text: raw(text) })).toEqual({
        label: 'paid-commercial-promo-group',
        cap: 'WARN',
      });
      expect(detect(text)?.actionBand).toBe('WARN');
    });

    it('lets a later current prohibition suppress an earlier paid placement offer', () => {
      const text =
        'Платная коммерческая реклама. Пишите админу, ответная ссылка [url]. Сейчас платная коммерческая реклама не допускается.';

      expect(resolveGroupPromotionRecall({ text: raw(text) })).toBeNull();
      expect(detect(text)).toBeNull();
    });

    it('reviews a weak free-classifieds link', () => {
      expect(
        resolveGroupPromotionRecall({
          text: raw('Добро пожаловать, бесплатные объявления нашего района [url]'),
        }),
      ).toEqual({ label: 'weak-promo-link', cap: 'REVIEW_ONLY' });
    });

    it('reviews a direct low-price retail link invitation', () => {
      expect(
        resolveGroupPromotionRecall({
          text: raw('[url] Приходите к нам, самые низкие итоговые цены.'),
        }),
      ).toEqual({ label: 'weak-promo-link', cap: 'REVIEW_ONLY' });
    });

    it('reviews a linked group-exchange description without sanctioning it', () => {
      expect(
        resolveGroupPromotionRecall({
          text: raw(
            'Ссылочная радуга. Админы группы кидают ссылки на свои группы три раза в день. Спам и реклама запрещены. [url]',
          ),
        }),
      ).toEqual({ label: 'link-exchange-group', cap: 'REVIEW_ONLY' });
    });

    it('ignores an unlinked discussion of a group-exchange rule', () => {
      expect(
        resolveGroupPromotionRecall({
          text: raw('Обсуждали ссылочную группу и правило обмена ссылками.'),
        }),
      ).toBeNull();
    });

    it('ignores ordinary documentation containing the adjective link-related', () => {
      expect(
        resolveGroupPromotionRecall({
          text: raw('Ссылочная политика сайта описана в документации [url].'),
        }),
      ).toBeNull();
    });

    it('ignores research discussing mutual reactions and subscriptions', () => {
      expect(
        resolveGroupPromotionRecall({
          text: raw(
            'Исследование анализирует взаимные реакции и подписки в чатах; методика опубликована [url].',
          ),
        }),
      ).toBeNull();
    });

    it('ignores a mutual-engagement quote with postposed research attribution', () => {
      const text =
        '«Предлагаю взаимную подписку и реакции» — фраза из исследования о чатах. Методика [url].';

      expect(resolveGroupPromotionRecall({ text: raw(text) })).toBeNull();
      for (const settings of [
        DETECTOR_SETTINGS,
        {
          ...DETECTOR_SETTINGS,
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 57,
          commercialAdsDeleteThreshold: 77,
        } as unknown as ChatSettings,
      ]) {
        expect(detect(text, settings)).toBeNull();
      }
    });

    it('preserves a quoted mutual-engagement offer without editorial attribution', () => {
      const text = '«Предлагаю взаимную подписку и реакции». Пиар-чат [url].';

      expect(resolveGroupPromotionRecall({ text: raw(text) })).toEqual({
        label: 'mutual-engagement-chat',
        cap: 'WARN',
      });
      expect(detect(text)?.actionBand).toBe('WARN');
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
      'Правила группы: реклама и ссылки запрещены. Подписывайтесь на канал с правилами [url]',
      'Новости района: городские службы завершили ремонт. Подписывайтесь на наш канал [url]',
    ])('preserves a non-promotional weak-link context: %s', (text) => {
      expect(resolveGroupPromotionRecall({ text: raw(text) })).toBeNull();
    });
  });

  describe('transport services', () => {
    it.each([
      {
        branch: 'round-the-clock taxi group offer',
        text: 'Такси TIK-TAK, круглосуточная работа. Добавляйте друзей в группу [url]. Заказать такси Алло [phone].',
      },
    ])('warns on the $branch', ({ text }) => {
      expect(resolveTransportServiceRecall(raw(text))).toEqual({
        label: 'taxi-group-order-service',
        cap: 'WARN',
      });
    });

    it.each([
      {
        branch: 'taxi group offer without round-the-clock service',
        text: 'Такси TIK-TAK. Добавляйте друзей в группу [url]. Заказать такси Алло [phone].',
      },
    ])('preserves the $branch boundary', ({ text }) => {
      expect(resolveTransportServiceRecall(raw(text))).toBeNull();
    });

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
    it.each([
      {
        branch: 'horseback riding club offer',
        text: 'Конный клуб Арго приглашает покататься на лошадях. Красивые маршруты, стоимость прогулки 2000р. Записывайтесь заранее [phone].',
        label: 'horseback-riding-club-offer',
      },
      {
        branch: 'short tour package',
        text: 'Тур в Дагестан 6-10 августа, 3 дня / 2 ночи, 10500 руб. Маршрут: Дербент и Сулакский каньон. Проживание включено, бронируйте [phone].',
        label: 'short-tour-package',
      },
    ])('warns on the bounded $branch recall', ({ text, label }) => {
      expect(resolveTourEventRentalRecall({ text: raw(text) })).toEqual({ label, cap: 'WARN' });
    });

    it.each([
      {
        branch: 'horseback riding club offer without a price',
        text: 'Конный клуб Арго приглашает покататься на лошадях. Красивые маршруты, записывайтесь заранее [phone].',
      },
      {
        branch: 'short tour package without booking or contact',
        text: 'Тур в Дагестан 6-10 августа, 3 дня / 2 ночи, 10500 руб. Маршрут: Дербент и Сулакский каньон. Проживание включено.',
      },
    ])('preserves the $branch boundary', ({ text }) => {
      expect(resolveTourEventRentalRecall({ text: raw(text) })).toBeNull();
    });

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
