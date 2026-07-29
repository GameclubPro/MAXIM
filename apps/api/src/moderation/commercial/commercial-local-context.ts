import { normalizeCommercialText } from './commercial-normalization';
import { hasCommercialPhoneLikeText } from './commercial-phone';
import {
  ADS_BUSINESS_PATTERNS,
  ADS_BUYOUT_PATTERNS,
  ADS_CHANNEL_PLACEMENT_PATTERNS,
  ADS_CONTEXTUAL_PHONE_PLACEHOLDER_PATTERN,
  ADS_GOODS_RETAIL_PATTERNS,
  ADS_HANDLE_CONTACT_PATTERN,
  ADS_HIGH_RISK_COMMERCIAL_PATTERNS,
  ADS_HIGH_RISK_RAW_LINK_PATTERNS,
  ADS_LINK_PATTERN,
  ADS_PRICE_PATTERN,
  ADS_PROPERTY_AGENT_PATTERNS,
  ADS_PROPERTY_COMMERCIAL_PATTERNS,
  ADS_RECRUITMENT_PATTERNS,
  ADS_SERVICE_OFFER_PATTERNS,
  ADS_SERVICE_SPECIALTY_PATTERNS,
  type CommercialLabeledPattern,
} from './commercial-patterns';

const MAX_LOCAL_CONTEXT_LENGTH = 8_000;
const MAX_LOCAL_ASSERTIONS = 64;
const MAX_LOCAL_WINDOW_LENGTH = 700;
const MAX_LOCAL_WINDOW_ASSERTIONS = 6;

const CONTRASTIVE_SELF_PROMO_BOUNDARY =
  /,\s*(?=(?:(?:(?:а|но)\s+)?у\s+нас|(?:а|но)\s+мы|зато\s+(?:у\s+нас|мы))(?=$|[^\p{L}\p{N}_-]))/giu;
const WARNING_PREFIX_SELF_PROMO_BOUNDARY =
  /,\s*(?=(?:(?:(?:а|но)\s+)?(?:у\s+нас|мы)|зато\s+(?:у\s+нас|мы)|наш[аи]\s+компани[яи]|я\s+(?:помогу|помогаю|предлагаю|оформлю|выдам)|(?:получите|оставьте\s+заявк[\p{L}\p{N}_-]*|пишите|звоните|заказывайте|оформите|регистрируйтесь|переходите))(?=$|[^\p{L}\p{N}_-]))/giu;
const ASSERTION_BOUNDARY = /(?:[\n!?;]+|\.(?=\s|$))/u;

const PROHIBITED_ACTION_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:не\s+(?:(?:надо|нужно|стоит)\s+)?(?:звоните?|пишите?|переходите?|открывайте?|регистрируйтесь?|отвечайте?|оставляйте?|отправляйте?|переводите?|платите?|верьте|соглашайтесь|пополняйте?)|не\s+оставляйте?\s+заявк[\p{L}\p{N}_-]*|не\s+сообщайте?\s+(?:код|данн)[\p{L}\p{N}_-]*|заблокируйте|как\s+удалить\s+реклам[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const REPORTING_OR_ATTRIBUTION_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:мне|нам|ему|ей)(?:\s+[\p{L}\p{N}_-]+){0,3}\s+(?:звонил[иа]?|писал[иа]?|предлагал[иа]?|обещал[иа]?|прислал[иа]?)|(?:они|мошенник[\p{L}\p{N}_-]*|спамер[\p{L}\p{N}_-]*)\s+(?:звонят|пишут|предлагают|обещают|рассылают|присылают)|(?:в\s+(?:новост[яьи][\p{L}\p{N}_-]*|стать[еьи]|обзор[еа])|на\s+(?:лекци[иия]|семинар[еа]))\s+(?:разобрал[и]?|разбирал[и]?|обсуждал[и]?|объяснял[и]?|рассказал[и]?|написал[и]?|показал[и]?)|(?:обсуждал[и]?|разбирал[и]?)\s+на\s+(?:встреч[еаи]|совещани[иие]|лекци[иие]|семинар[еаи])|(?:новост[ьи]|стать[яи]|обзор|лекци[яи]|редакци[яи])\s+(?:разбира[а-яё-]*|объясня[а-яё-]*|предупрежда[а-яё-]*|сообща[а-яё-]*))(?=$|[^\p{L}\p{N}_-])/iu;
const LOCAL_REPORTING_FRAME_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:мне|нам)\s+отказал[и]?\s+в\s+(?:кредит[еа]?|займ[еа]?|выплат[еа]?|рассрочк[еаи])|(?:в|из)\s+(?:письм[еа]|сообщени[иия]|переписк[еаи])\s+(?:был[аио]?|упоминал[аио]?|написал[аио]?|предлагал[аио]?))(?=$|[^\p{L}\p{N}_-])/iu;
const COMPLAINT_OR_WARNING_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:осторожн[\p{L}\p{N}_-]*|похоже\s+(?:на\s+)?развод|это\s+(?:развод|спам|реклама)|не\s+доверяю|заявк[\p{L}\p{N}_-]*\s+(?:я\s+)?не\s+оставлял[а]?|жалоб[аы]|^отзыв\s*:|сайт\s+опасен|не\s+регистрируйтесь|это\s+реклама\s+или\s+нет|проверял[и]?)(?=$|[^\p{L}\p{N}_-])/iu;
const EDITORIAL_CONTACT_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:телефон|номер|справочн[\p{L}\p{N}_-]*)\s+(?:редакци[иия]|полици[иия]|мошенник[\p{L}\p{N}_-]*|спамер[\p{L}\p{N}_-]*|организатор[а-яё-]*)|их\s+номер|номер\s+(?:из\s+)?сообщени[яи])(?=$|[^\p{L}\p{N}_-])/iu;
const PROTECTED_FRAME_CARRY_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:не\s+(?:звоните?|пишите?|переходите?|открывайте?|регистрируйтесь?))\s+(?:им|ему|ей|по\s+(?:этой\s+)?ссылк[еуы]|на\s+(?:этот\s+)?сайт)|(?:мне|нам)\s+(?:звонил[иа]?|писал[иа]?|предлагал[иа]?|обещал[иа]?)|(?:в\s+(?:новост[яьи][\p{L}\p{N}_-]*|стать[еьи]|обзор[еа])|на\s+(?:лекци[иия]|семинар[еа])))(?=$|[^\p{L}\p{N}_-])/iu;
const SELF_PROMO_RESET_PATTERN =
  /^(?:(?:а|но)\s+)?(?:(?:у\s+нас|мы|наш[аи]\s+компани[яи]|я\s+(?:помогу|помогаю|предлагаю|оформлю|выдам))\b|(?:получите|оставьте\s+заявк[\p{L}\p{N}_-]*|пишите|звоните|заказывайте|оформите|регистрируйтесь|переходите)\b)/iu;
const AFFIRMATIVE_ACTION_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:пишите?|напишите?|звоните?|обращайтесь|остав(?:ьте|ляйте)\s+заявк[\p{L}\p{N}_-]*|получите|оформите|закаж(?:ите|и|ем|у)|заказывайте|регистрируйтесь|переходите|подписывайтесь|свяжитесь|записывайтесь)(?=$|[^\p{L}\p{N}_-])/giu;
const AFFIRMATIVE_TRANSACTION_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:цен[аы]|стоимость|скидк[а-и]|бонус|депозит|доставка|оплат[аы]|оплатим|платим|вознаграждени[\p{L}\p{N}_-]*|предоплата|бронь|обязательн[\p{L}\p{N}_-]*\s+взнос|участи[ея]\s+платн[\p{L}\p{N}_-]*|в\s+наличии|вход\s+(?:по\s+)?инвайт[\p{L}\p{N}_-]*|ответ[\p{L}\p{N}_-]*\s+в\s+комментар[\p{L}\p{N}_-]*|заявк[\p{L}\p{N}_-]*\s+в\s+профил[еья]|принима(?:ю|ем)\s+заказ[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const AFFIRMATIVE_RESPONSE_CHANNEL_PATTERN =
  /(?:\[(?:phone|url)\]|(?:^|[^\p{L}\p{N}_-])ссылк[\p{L}\p{N}_-]*\s+в\s+профил[еья](?=$|[^\p{L}\p{N}_-]))/iu;
const CROSS_ASSERTION_DEAL_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:скидк[а-и]|бонус|депозит|оплат[аы]|оплатим|платим|вознаграждени[\p{L}\p{N}_-]*|предоплата|бронь|билет[\p{L}\p{N}_-]*|номерок[\p{L}\p{N}_-]*|перевод\s+(?:по\s+номер[у]?|на\s+карт[уы]|оплат[ыа])|обязательн[\p{L}\p{N}_-]*\s+взнос|участи[ея]\s+платн[\p{L}\p{N}_-]*|в\s+наличии|вход\s+(?:по\s+)?инвайт[\p{L}\p{N}_-]*|ответ[\p{L}\p{N}_-]*\s+в\s+комментар[\p{L}\p{N}_-]*|заявк[\p{L}\p{N}_-]*\s+в\s+профил[еья]|принима(?:ю|ем)\s+заказ[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const NEGATION_BEFORE_ACTION_PATTERN = /(?:^|[^\p{L}\p{N}_-])не\s+(?:(?:надо|нужно|стоит)\s+)?$/iu;
const QUOTED_REPORT_INTRO_PATTERN =
  /(?:мошенник[\p{L}\p{N}_-]*|спамер[\p{L}\p{N}_-]*|они|мне|нам)(?:[\p{L}\p{N}\s,()-]{0,60})(?:пишут|прислал[иа]?|рассылают|предлагают|обещают)\s*:/iu;
const CHANNEL_AD_DUE_DILIGENCE_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:кто\s+покупал|покупал[аи]?|брал[аи]?)(?:[\p{L}\p{N}\s.,:;()/%+_"«»—-]{0,80})реклам[\p{L}\p{N}_-]*/iu;

const GENERAL_COMMERCIAL_PATTERNS: readonly CommercialLabeledPattern[] = [
  ...ADS_BUSINESS_PATTERNS,
  ...ADS_BUYOUT_PATTERNS,
  ...ADS_CHANNEL_PLACEMENT_PATTERNS,
  ...ADS_GOODS_RETAIL_PATTERNS,
  ...ADS_PROPERTY_AGENT_PATTERNS,
  ...ADS_PROPERTY_COMMERCIAL_PATTERNS,
  ...ADS_RECRUITMENT_PATTERNS,
  ...ADS_SERVICE_OFFER_PATTERNS,
  ...ADS_SERVICE_SPECIALTY_PATTERNS,
];

type LocalAssertion = {
  text: string;
  normalizedText: string;
  protectedFrame: boolean;
  parts?: readonly LocalAssertion[];
};

export type CommercialLocalContext = {
  hasIndependentCommercialOffer: boolean;
  hasIndependentEscalationOffer: boolean;
  hasOnlyProtectedEscalationMentions: boolean;
};

export function resolveCommercialLocalContext(params: {
  rawLoweredText: string;
  escalationRiskLabels: readonly string[];
}): CommercialLocalContext {
  if (
    params.escalationRiskLabels.length === 0 &&
    !isProtectedAssertion(params.rawLoweredText) &&
    !CHANNEL_AD_DUE_DILIGENCE_PATTERN.test(params.rawLoweredText)
  ) {
    return {
      hasIndependentCommercialOffer: false,
      hasIndependentEscalationOffer: false,
      hasOnlyProtectedEscalationMentions: false,
    };
  }

  const riskPatterns = selectRiskPatterns(params.escalationRiskLabels);
  const assertions = classifyAssertions(
    splitCommercialAssertions(params.rawLoweredText),
    riskPatterns,
  );
  const hasIndependentEscalationOffer = hasOfferInUnprotectedWindow(assertions, (window) =>
    hasEscalationOffer(window, riskPatterns),
  );
  const hasIndependentCommercialOffer =
    hasIndependentEscalationOffer ||
    hasOfferInUnprotectedWindow(assertions, (window) => hasGeneralCommercialOffer(window));
  const hasProtectedEscalationMention = assertions.some(
    (assertion) => assertion.protectedFrame && hasRiskPattern(assertion, riskPatterns),
  );

  return {
    hasIndependentCommercialOffer,
    hasIndependentEscalationOffer,
    hasOnlyProtectedEscalationMentions:
      riskPatterns.length > 0 && !hasIndependentEscalationOffer && hasProtectedEscalationMention,
  };
}

export function splitCommercialAssertions(rawLoweredText: string): string[] {
  return rawLoweredText
    .slice(0, MAX_LOCAL_CONTEXT_LENGTH)
    .replace(CONTRASTIVE_SELF_PROMO_BOUNDARY, '\n')
    .split(ASSERTION_BOUNDARY)
    .flatMap(splitWarningPrefixedSelfPromo)
    .map((assertion) => assertion.trim())
    .filter(Boolean)
    .slice(0, MAX_LOCAL_ASSERTIONS);
}

function splitWarningPrefixedSelfPromo(assertion: string): string[] {
  WARNING_PREFIX_SELF_PROMO_BOUNDARY.lastIndex = 0;
  for (const match of assertion.matchAll(WARNING_PREFIX_SELF_PROMO_BOUNDARY)) {
    const boundaryIndex = match.index ?? -1;
    if (boundaryIndex < 0) {
      continue;
    }
    const prefix = assertion.slice(0, boundaryIndex).trim();
    if (
      !COMPLAINT_OR_WARNING_PATTERN.test(prefix) ||
      REPORTING_OR_ATTRIBUTION_PATTERN.test(prefix)
    ) {
      continue;
    }
    return [prefix, assertion.slice(boundaryIndex + match[0].length).trim()];
  }
  return [assertion];
}

function classifyAssertions(
  assertionTexts: readonly string[],
  riskPatterns: readonly CommercialLabeledPattern[],
): LocalAssertion[] {
  const assertions: LocalAssertion[] = [];
  let protectedCarry = 0;
  let protectedQuote = false;

  for (const text of assertionTexts) {
    const normalizedText = normalizeCommercialText(text);
    const intrinsicProtected = isProtectedAssertion(text);
    const rawAssertion = { text, normalizedText, protectedFrame: false };
    const resetsProtectedCarry =
      protectedCarry > 0 &&
      (SELF_PROMO_RESET_PATTERN.test(text) ||
        (!intrinsicProtected &&
          (hasEscalationOffer(rawAssertion, riskPatterns) ||
            hasGeneralCommercialOffer(rawAssertion))));
    const protectedFrame =
      intrinsicProtected || protectedQuote || (protectedCarry > 0 && !resetsProtectedCarry);

    assertions.push({ text, normalizedText, protectedFrame });

    const opensProtectedQuote =
      (intrinsicProtected || protectedQuote) &&
      QUOTED_REPORT_INTRO_PATTERN.test(text) &&
      countCharacter(text, '«') > countCharacter(text, '»');
    if (opensProtectedQuote) {
      protectedQuote = true;
    }
    if (protectedQuote && countCharacter(text, '»') > countCharacter(text, '«')) {
      protectedQuote = false;
    }

    if (intrinsicProtected && PROTECTED_FRAME_CARRY_PATTERN.test(text)) {
      protectedCarry = 2;
    } else if (resetsProtectedCarry) {
      protectedCarry = 0;
    } else if (protectedCarry > 0) {
      protectedCarry -= 1;
    }
  }

  return assertions;
}

function isProtectedAssertion(text: string): boolean {
  return (
    PROHIBITED_ACTION_PATTERN.test(text) ||
    REPORTING_OR_ATTRIBUTION_PATTERN.test(text) ||
    LOCAL_REPORTING_FRAME_PATTERN.test(text) ||
    COMPLAINT_OR_WARNING_PATTERN.test(text) ||
    EDITORIAL_CONTACT_PATTERN.test(text)
  );
}

function hasOfferInUnprotectedWindow(
  assertions: readonly LocalAssertion[],
  predicate: (window: LocalAssertion) => boolean,
): boolean {
  for (let index = 0; index < assertions.length; index += 1) {
    const first = assertions[index];
    if (first.protectedFrame) {
      continue;
    }

    let text = '';
    let normalizedText = '';
    for (
      let end = index;
      end < assertions.length && end < index + MAX_LOCAL_WINDOW_ASSERTIONS;
      end += 1
    ) {
      const assertion = assertions[end];
      if (assertion.protectedFrame) {
        break;
      }
      text = text ? `${text}. ${assertion.text}` : assertion.text;
      normalizedText = normalizedText
        ? `${normalizedText}. ${assertion.normalizedText}`
        : assertion.normalizedText;
      if (text.length > MAX_LOCAL_WINDOW_LENGTH) {
        break;
      }
      if (
        predicate({
          text,
          normalizedText,
          protectedFrame: false,
          parts: assertions.slice(index, end + 1),
        })
      ) {
        return true;
      }
    }
  }

  return false;
}

function hasEscalationOffer(
  assertion: LocalAssertion,
  riskPatterns: readonly CommercialLabeledPattern[],
): boolean {
  if (!hasRiskPattern(assertion, riskPatterns)) {
    return false;
  }
  if ((assertion.parts?.length ?? 1) === 1) {
    return hasAffirmativeDealCue(assertion);
  }

  return (
    hasNonNegatedAffirmativeAction(assertion.text) ||
    AFFIRMATIVE_RESPONSE_CHANNEL_PATTERN.test(assertion.text) ||
    CROSS_ASSERTION_DEAL_PATTERN.test(assertion.text) ||
    ADS_CONTEXTUAL_PHONE_PLACEHOLDER_PATTERN.test(assertion.text) ||
    ADS_HANDLE_CONTACT_PATTERN.test(assertion.text) ||
    ADS_LINK_PATTERN.test(assertion.text) ||
    hasCommercialPhoneLikeText(assertion.text)
  );
}

function hasGeneralCommercialOffer(assertion: LocalAssertion): boolean {
  if (!hasAffirmativeDealCue(assertion) || EDITORIAL_CONTACT_PATTERN.test(assertion.text)) {
    return false;
  }
  return GENERAL_COMMERCIAL_PATTERNS.some(
    ({ pattern }) =>
      testPattern(pattern, assertion.text) || testPattern(pattern, assertion.normalizedText),
  );
}

function hasAffirmativeDealCue(assertion: LocalAssertion): boolean {
  if (hasNonNegatedAffirmativeAction(assertion.text)) {
    return true;
  }
  if (AFFIRMATIVE_TRANSACTION_PATTERN.test(assertion.text)) {
    return true;
  }
  if (AFFIRMATIVE_RESPONSE_CHANNEL_PATTERN.test(assertion.text)) {
    return true;
  }
  return (
    [
      ADS_CONTEXTUAL_PHONE_PLACEHOLDER_PATTERN,
      ADS_HANDLE_CONTACT_PATTERN,
      ADS_LINK_PATTERN,
      ADS_PRICE_PATTERN,
    ].some(
      (pattern) =>
        testPattern(pattern, assertion.text) || testPattern(pattern, assertion.normalizedText),
    ) || hasCommercialPhoneLikeText(assertion.text)
  );
}

function hasNonNegatedAffirmativeAction(text: string): boolean {
  AFFIRMATIVE_ACTION_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(AFFIRMATIVE_ACTION_PATTERN)) {
    const actionIndex = match.index + match[0].search(/[\p{L}\p{N}]/u);
    const prefix = text.slice(Math.max(0, actionIndex - 24), actionIndex);
    if (!NEGATION_BEFORE_ACTION_PATTERN.test(prefix)) {
      return true;
    }
  }
  return false;
}

function hasRiskPattern(
  assertion: Pick<LocalAssertion, 'text' | 'normalizedText'>,
  riskPatterns: readonly CommercialLabeledPattern[],
): boolean {
  return riskPatterns.some(
    ({ pattern }) =>
      testPattern(pattern, assertion.text) || testPattern(pattern, assertion.normalizedText),
  );
}

function selectRiskPatterns(labels: readonly string[]): CommercialLabeledPattern[] {
  const selectedLabels = new Set(labels);
  return [...ADS_HIGH_RISK_COMMERCIAL_PATTERNS, ...ADS_HIGH_RISK_RAW_LINK_PATTERNS].filter(
    ({ label }) => selectedLabels.has(label),
  );
}

function testPattern(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

function countCharacter(text: string, character: string): number {
  return text.split(character).length - 1;
}
