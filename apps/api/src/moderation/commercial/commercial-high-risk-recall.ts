export type CommercialHighRiskRecallCap = 'review' | 'warn';

export type CommercialHighRiskRecallHit = {
  label: string;
  actionCap: CommercialHighRiskRecallCap;
};

type CommercialHighRiskRecallRule = CommercialHighRiskRecallHit & {
  quickMatch: RegExp;
  matches: (text: string) => boolean;
};

const MEDICINE_PRICE_PAIRS = [
  /(?:^|[^\p{L}\p{N}_-])пикамилон[\s:=–—-]{0,12}\d{2,5}(?!\s*(?:мг|мкг|г|мл|таб|капсул|раз))/iu,
  /(?:^|[^\p{L}\p{N}_-])то(?:физопам|пизофам)[\s:=–—-]{0,12}\d{2,5}(?!\s*(?:мг|мкг|г|мл|таб|капсул|раз))/iu,
  /(?:^|[^\p{L}\p{N}_-])тералиджен[\s:=–—-]{0,12}\d{2,5}(?!\s*(?:мг|мкг|г|мл|таб|капсул|раз))/iu,
  /(?:^|[^\p{L}\p{N}_-])фенибут[\s:=–—-]{0,12}\d{2,5}(?!\s*(?:мг|мкг|г|мл|таб|капсул|раз))/iu,
  /(?:^|[^\p{L}\p{N}_-])прегабалин[\s:=–—-]{0,12}\d{2,5}(?!\s*(?:мг|мкг|г|мл|таб|капсул|раз))/iu,
  /(?:^|[^\p{L}\p{N}_-])габапентин[\s:=–—-]{0,12}\d{2,5}(?!\s*(?:мг|мкг|г|мл|таб|капсул|раз))/iu,
  /(?:^|[^\p{L}\p{N}_-])грандаксин[\s:=–—-]{0,12}\d{2,5}(?!\s*(?:мг|мкг|г|мл|таб|капсул|раз))/iu,
  /(?:^|[^\p{L}\p{N}_-])атаракс[\s:=–—-]{0,12}\d{2,5}(?!\s*(?:мг|мкг|г|мл|таб|капсул|раз))/iu,
  /(?:^|[^\p{L}\p{N}_-])баклофен[\s:=–—-]{0,12}\d{2,5}(?!\s*(?:мг|мкг|г|мл|таб|капсул|раз))/iu,
  /(?:^|[^\p{L}\p{N}_-])лирика[\s:=–—-]{0,12}\d{2,5}(?!\s*(?:мг|мкг|г|мл|таб|капсул|раз))/iu,
  /(?:^|[^\p{L}\p{N}_-])феназепам[\s:=–—-]{0,12}\d{2,5}(?!\s*(?:мг|мкг|г|мл|таб|капсул|раз))/iu,
] as const;

const HANDMADE_HEALTH_CLAIMS = [
  /(?:^|[^\p{L}\p{N}_-])перхот[ьи](?=$|[^\p{L}\p{N}_-])/iu,
  /(?:^|[^\p{L}\p{N}_-])восстанавлива[\p{L}\p{N}_-]*\s+волос[\p{L}\p{N}_-]*(?=$|[^\p{L}\p{N}_-])/iu,
  /(?:^|[^\p{L}\p{N}_-])рост\s+волос[\p{L}\p{N}_-]*(?=$|[^\p{L}\p{N}_-])/iu,
  /(?:^|[^\p{L}\p{N}_-])грибок[\p{L}\p{N}_-]*(?=$|[^\p{L}\p{N}_-])/iu,
  /(?:^|[^\p{L}\p{N}_-])растрескивани[ея]\s+кож[иы](?=$|[^\p{L}\p{N}_-])/iu,
  /(?:^|[^\p{L}\p{N}_-])зуд(?=$|[^\p{L}\p{N}_-])/iu,
  /(?:^|[^\p{L}\p{N}_-])(?:экзем[аы]|псориаз|дерматит)(?=$|[^\p{L}\p{N}_-])/iu,
] as const;

const WEIGHT_LOSS_PROGRAM_COMPONENTS = [
  /(?:^|[^\p{L}\p{N}_-])тренировк[\p{L}\p{N}_-]*(?=$|[^\p{L}\p{N}_-])/iu,
  /(?:^|[^\p{L}\p{N}_-])(?:меню|питани[ея]|рецепт[ыа]?)(?=$|[^\p{L}\p{N}_-])/iu,
  /(?:^|[^\p{L}\p{N}_-])(?:разбор\s+)?привыч[\p{L}\p{N}_-]*(?=$|[^\p{L}\p{N}_-])/iu,
  /(?:^|[^\p{L}\p{N}_-])челлендж[\p{L}\p{N}_-]*(?=$|[^\p{L}\p{N}_-])/iu,
  /(?:^|[^\p{L}\p{N}_-])поддержк[\p{L}\p{N}_-]*(?=$|[^\p{L}\p{N}_-])/iu,
  /(?:^|[^\p{L}\p{N}_-])дисциплин[\p{L}\p{N}_-]*(?=$|[^\p{L}\p{N}_-])/iu,
] as const;

const SHARED_RECALL_EXCLUSION_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:подскажите|кто\s+знает|можно\s+ли|есть\s+ли|где\s+(?:купить|найти)|сколько\s+стоит|новост[ьи]|журналист[\p{L}\p{N}_-]*|стать[яеию]|репортаж[\p{L}\p{N}_-]*|по\s+данным|сообща(?:ет|ют)|предупрежд[\p{L}\p{N}_-]*|осторожно|мошенни[кц][\p{L}\p{N}_-]*|не\s+верьте|обман|фейк|разоблачен[\p{L}\p{N}_-]*|цитат[аы]?|пересылаю|мне\s+прислал[аи]?|в\s+объявлени[и]\s+написано|по\s+словам|автор\s+пишет|реклама\s+обещает)(?=$|[^\p{L}\p{N}_-])/iu;

const COMMERCIAL_HIGH_RISK_RECALL_RULES: readonly CommercialHighRiskRecallRule[] = [
  {
    label: 'medicine-price-catalog',
    actionCap: 'review',
    quickMatch: /(?:пикамилон|то(?:физопам|пизофам)|тералиджен|фенибут|прегабалин|габапентин|грандаксин|атаракс|баклофен|лирика|феназепам)/iu,
    matches: isMedicinePriceCatalog,
  },
  {
    label: 'mortgage-leadgen',
    actionCap: 'warn',
    quickMatch:
      /(?:(?:помо(?:гу|жем)\s+(?:получить|одобрить|оформить)|одобр(?:ю|им)|оформ(?:лю|им))\s+ипотек|первоначальн[а-яё-]*\s+взнос)/iu,
    matches: isMortgageLeadgen,
  },
  {
    label: 'divination-contact-offer',
    actionCap: 'warn',
    quickMatch: /(?:гадалк|таролог|ясновидящ|экстрасенс)/iu,
    matches: isDivinationContactOffer,
  },
  {
    label: 'handmade-health-claims',
    actionCap: 'review',
    quickMatch:
      /(?:перхот|восстанавлива[а-яё-]*\s+волос|рост\s+волос|грибок|растрескивани[ея]\s+кож|зуд|экзем|псориаз|дерматит)/iu,
    matches: isHandmadeHealthClaimsOffer,
  },
  {
    label: 'weight-loss-chat-funnel',
    actionCap: 'review',
    quickMatch: /(?:похуд|худеющ|худеем|снижен[а-яё-]*\s+вес|марафон)/iu,
    matches: isWeightLossChatFunnel,
  },
  {
    label: 'pharmacy-channel-promotion',
    actionCap: 'warn',
    quickMatch: /аптек/iu,
    matches: isPharmacyChannelPromotion,
  },
] as const;

export function collectCommercialHighRiskRecallHits(
  rawLoweredText: string,
): CommercialHighRiskRecallHit[] {
  const text = rawLoweredText.replace(/\s+/gu, ' ').trim();
  if (text.length < 20 || text.length > 1_200) {
    return [];
  }

  return COMMERCIAL_HIGH_RISK_RECALL_RULES.filter(
    (rule) => rule.quickMatch.test(text) && rule.matches(text),
  ).map(({ label, actionCap }) => ({ label, actionCap }));
}

function isMedicinePriceCatalog(text: string): boolean {
  if (
    text.length > 420 ||
    hasSharedRecallExclusion(text) ||
    /(?:^|[^\p{L}\p{N}_-])(?:рецепт[\p{L}\p{N}_-]*|назначил[\p{L}\p{N}_-]*|принима(?:ть|ю|л[аи]?)|дозировк[\p{L}\p{N}_-]*|курс\s+лечени[яю]|схем[аы]\s+лечени[яю]|лечащ[\p{L}\p{N}_-]*\s+врач|утром|вечером|мг|мкг|таблетк[\p{L}\p{N}_-]*|капсул[\p{L}\p{N}_-]*|кассир|итого|чек|купил[аи]?|покупал[аи]?|сравн[\p{L}\p{N}_-]*\s+цен[ыау])(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    )
  ) {
    return false;
  }

  return MEDICINE_PRICE_PAIRS.filter((pattern) => pattern.test(text)).length >= 3;
}

function isMortgageLeadgen(text: string): boolean {
  if (
    hasSharedRecallExclusion(text) ||
    /(?:^|[^\p{L}\p{N}_-])(?:я\s+собственник|от\s+собственник[ао]|без\s+посредник[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    )
  ) {
    return false;
  }

  return isPersonalMortgageHelpOffer(text) || isDeveloperFinancingOffer(text);
}

function isPersonalMortgageHelpOffer(text: string): boolean {
  const hasSellerHelp =
    /(?:^|[^\p{L}\p{N}_-])(?:помо(?:гу|жем)\s+(?:получить|одобрить|оформить)|одобр(?:ю|им)|оформ(?:лю|им))\s+ипотек[\p{L}\p{N}_-]*(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );
  const hasFinancingConcession =
    /(?:^|[^\p{L}\p{N}_-])(?:ипотек[\p{L}\p{N}_-]*\s*\d{1,2}(?:[.,]\d+)?\s*%|\d{1,2}(?:[.,]\d+)?\s*%\s+на\s+(?:строительств[оа]|ипотек[\p{L}\p{N}_-]*)|без\s+(?:пв|первоначальн[\p{L}\p{N}_-]*\s+взнос[ао]?|земельн[\p{L}\p{N}_-]*\s+участк[ао]?))(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );
  const hasUrgency =
    /(?:^|[^\p{L}\p{N}_-])(?:лимит[\p{L}\p{N}_-]*[\s\S]{0,48}заканчива[\p{L}\p{N}_-]*|не\s+медлить|срочн[\p{L}\p{N}_-]*|до\s+конца\s+(?:недел[иь]|месяц[а]?))(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );

  return hasSellerHelp && hasFinancingConcession && hasUrgency && hasResponseChannel(text);
}

function isDeveloperFinancingOffer(text: string): boolean {
  const hasProperty =
    /(?:^|[^\p{L}\p{N}_-])(?:жк|квартир[аы]|новостройк[аеи])(?=$|[^\p{L}\p{N}_-])/iu.test(text);
  const hasInitialPayment =
    /(?:^|[^\p{L}\p{N}_-])первоначальн[\p{L}\p{N}_-]*\s+взнос(?=$|[^\p{L}\p{N}_-])/iu.test(text);
  const hasMonthlyPayment =
    /(?:^|[^\p{L}\p{N}_-])плат[её]ж[\p{L}\p{N}_-]*[\s\S]{0,42}(?:в\s+месяц|ежемесячн[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );
  const hasKeyDate =
    /(?:^|[^\p{L}\p{N}_-])(?:выдач[аеи]\s+ключ[ейи]|ключ[и]\s+(?:в|до))[\s\S]{0,48}(?:январ[ья]|феврал[ья]|март[а]?|апрел[ья]|ма[йя]|июн[ья]|июл[ья]|август[а]?|сентябр[ья]|октябр[ья]|ноябр[ья]|декабр[ья])\s+20\d{2}(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );
  const hasSellerCalculationCta =
    /(?:^|[^\p{L}\p{N}_-])(?:помо(?:гу|жем)|подбер[её]м)[\s\S]{0,100}(?:подобрать\s+квартир[уы]|рассчитать\s+услови[яй]|рассчита[её]м\s+услови[яй])(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );

  return (
    hasProperty &&
    hasInitialPayment &&
    hasMonthlyPayment &&
    hasKeyDate &&
    hasSellerCalculationCta &&
    hasPhoneChannel(text)
  );
}

function isDivinationContactOffer(text: string): boolean {
  if (
    hasSharedRecallExclusion(text) ||
    /(?:^|[^\p{L}\p{N}_-])(?:советую|рекомендую|обратитесь\s+к|моя\s+(?:знакомая|подруга)|мне\s+помогл[аи])(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    )
  ) {
    return false;
  }

  const hasIdentity =
    /(?:^|[^\p{L}\p{N}_-])(?:гадалк[а-яё-]*|таролог[а-яё-]*|ясновидящ[а-яё-]*|экстрасенс[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );
  const hasFirstPersonService =
    /(?:^|[^\p{L}\p{N}_-])(?:снимаю|возвращаю|предсказываю|делаю|провожу|помогу|отвечаю)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );
  const hasInterventionClaim =
    /(?:^|[^\p{L}\p{N}_-])(?:снимаю\s+преград[а-яё-]*|возвращаю\s+любим[а-яё-]*|защищу\s+от\s+сглаз[а-яё-]*|провожу\s+обряд[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );
  const serviceClaimCount = [
    /(?:^|[^\p{L}\p{N}_-])снимаю\s+преград[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu,
    /(?:^|[^\p{L}\p{N}_-])возвращаю\s+любим[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu,
    /(?:^|[^\p{L}\p{N}_-])предсказываю(?=$|[^\p{L}\p{N}_-])/iu,
    /(?:^|[^\p{L}\p{N}_-])диагностик[а-яё-]*(?:\s+(?:будущ[а-яё-]*|ситуаци[а-яё-]*))?(?=$|[^\p{L}\p{N}_-])/iu,
    /(?:^|[^\p{L}\p{N}_-])(?:расклад[а-яё-]*|обряд[а-яё-]*|приворот[а-яё-]*|сглаз[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu,
  ].filter((pattern) => pattern.test(text)).length;

  return (
    hasIdentity &&
    hasFirstPersonService &&
    hasInterventionClaim &&
    serviceClaimCount >= 2 &&
    hasResponseChannel(text)
  );
}

function isHandmadeHealthClaimsOffer(text: string): boolean {
  if (
    hasSharedRecallExclusion(text) ||
    /(?:^|[^\p{L}\p{N}_-])(?:рецепт[аы]?|как\s+сделать|как\s+приготовить|купил[аи]?|пользовал[аи]?[счь]?[а-яё-]*|не\s+помог[а-яё-]*|не\s+работает|вызвал[а-яё-]*|аллерги[а-яё-]*|ухудш[а-яё-]*|опасн[а-яё-]*|побочн[а-яё-]*|миф|не\s+лечит|производител[а-яё-]*\s+утвержда[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    )
  ) {
    return false;
  }

  const hasHandmadeProduct =
    /(?:^|[^\p{L}\p{N}_-])(?:(?:мыл[оа]|маз[ьи]|бальзам[а-яё-]*|крем[а-яё-]*)\s+ручн[а-яё-]*\s+работ[а-яё-]*|ручн[а-яё-]*\s+работ[а-яё-]*[\s\S]{0,48}(?:мыл[оа]|маз[ьи]|бальзам[а-яё-]*|крем[а-яё-]*))(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );

  return hasHandmadeProduct && countPatternHits(HANDMADE_HEALTH_CLAIMS, text) >= 3;
}

function isWeightLossChatFunnel(text: string): boolean {
  if (
    hasSharedRecallExclusion(text) ||
    /(?:^|[^\p{L}\p{N}_-])(?:некоммерческ[а-яё-]*|волонт[её]рск[а-яё-]*|анонимн[а-яё-]*\s+групп[а-яё-]*|без\s+реклам[а-яё-]*\s+и\s+продаж[а-яё-]*|расстройств[а-яё-]*\s+пищев[а-яё-]*\s+поведени[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    )
  ) {
    return false;
  }

  const hasWeightLossChat =
    /(?:^|[^\p{L}\p{N}_-])(?:(?:секретн[а-яё-]*\s+)?чат[а-яё-]*\s+(?:худеющ[а-яё-]*|для\s+похудени[а-яё-]*)|групп[а-яё-]*\s+(?:худеющ[а-яё-]*|для\s+похудени[а-яё-]*)|марафон[а-яё-]*\s+(?:похудени[а-яё-]*|снижен[а-яё-]*\s+вес[а-яё-]*))(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );
  const hasOwnerFunnel =
    /(?:^|[^\p{L}\p{N}_-])(?:открыва[а-яё-]*\s+двер[а-яё-]*|набираю|запускаю|приглашаю|я\s+скину\s+ссылк[а-яё-]*|скину\s+ссылк[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );
  const hasJoinCta =
    /(?:^|[^\p{L}\p{N}_-])(?:пиши(?:те)?\s*\+|напиши(?:те)?\s+(?:плюс|\+)|ставь(?:те)?\s*\+|в\s+комментари[а-яё-]*|в\s+директ|скину\s+ссылк[а-яё-]*|добавлю\s+в\s+чат)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );

  return (
    hasWeightLossChat &&
    hasOwnerFunnel &&
    hasJoinCta &&
    countPatternHits(WEIGHT_LOSS_PROGRAM_COMPONENTS, text) >= 3
  );
}

function isPharmacyChannelPromotion(text: string): boolean {
  if (
    hasSharedRecallExclusion(text) ||
    /(?:^|[^\p{L}\p{N}_-])(?:адрес[аы]\s+аптек|список\s+аптек|каталог\s+аптек|дежурн[а-яё-]*\s+аптек[а-яё-]*|режим\s+работ[а-яё-]*|отзыв[а-яё-]*|покупал[аи]?|обслуживани[ея]|фармацевт[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    )
  ) {
    return false;
  }

  const hasPharmacyIdentity =
    /(?:^|[^\p{L}\p{N}_-])(?:китайск[а-яё-]*\s+аптек[а-яё-]*|наш[а-яё-]*\s+аптек[а-яё-]*|у\s+нас\s+в\s+аптек[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );
  const hasInventoryOffer =
    /(?:^|[^\p{L}\p{N}_-])(?:у\s+нас\s+есть\s+вс[её]|в\s+наличи[ие]|чего\s+нет[\s\S]{0,48}найд[её]м[\s\S]{0,48}привез[её]м|под\s+заказ)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );
  const hasShipping =
    /(?:^|[^\p{L}\p{N}_-])(?:отправк[а-яё-]*|отправим|доставк[а-яё-]*)[\s\S]{0,80}(?:люб[а-яё-]*\s+населенн[а-яё-]*\s+пункт[а-яё-]*|по\s+росси[ии]|в\s+регион[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );
  const hasOwnedGroups =
    /(?:^|[^\p{L}\p{N}_-])наш[а-яё-]*\s+групп[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu.test(text);
  const linkCount = text.match(/(?:\[url\]|https?:\/\/\S+|max\.ru\/\S+)/giu)?.length ?? 0;

  return hasPharmacyIdentity && hasInventoryOffer && hasShipping && hasOwnedGroups && linkCount > 0;
}

function hasSharedRecallExclusion(text: string): boolean {
  return SHARED_RECALL_EXCLUSION_PATTERN.test(text);
}

function hasPhoneChannel(text: string): boolean {
  return /(?:\[phone\]|(?:\+?7|8)(?:[\s().‐‑‒–—―•·|/:+-]*\d){10})/u.test(text);
}

function hasResponseChannel(text: string): boolean {
  return (
    hasPhoneChannel(text) ||
    /(?:^|[^\p{L}\p{N}_-])(?:пиши(?:те|ть)?|звони(?:те|ть)?|связа[а-яё-]*|whatsapp|ватсап|telegram|телеграм|max|мах|директ)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    )
  );
}

function countPatternHits(patterns: readonly RegExp[], text: string): number {
  return patterns.filter((pattern) => pattern.test(text)).length;
}
