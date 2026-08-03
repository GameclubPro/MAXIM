import type { ChatSettings } from '../../prisma/prisma-client';
import type { CommercialCampaignContext } from '../commercial-campaign.util';
import { resolveCommercialThresholds } from '../rule-engine-commercial-thresholds';
import type { CommercialDecisionBand, CommercialSubtype } from '../rule-engine.contract';
import { enrichCommercialDetection } from './commercial-explain';
import {
  collectCommercialSignals,
  hasCommercialSpamMarkers as hasCommercialSpamMarkersInText,
  hasExplicitLinkedBoundedGroupPromotion,
  hasExplicitSelfPromotionalCommercialContext,
  hasPrivateGoodsCommercialOverride,
  hasRideShareContext,
  isLikelyPrivateLowQuantityGoodsListing,
  isThirdPartyServiceRecommendationWithoutCurrentOffer,
} from './commercial-features';
import {
  isCommercialEscalationRiskSignal,
  resolveCommercialEvidenceProfile,
} from './commercial-evidence';
import {
  hasQualifiedSourceSideServiceOffer,
  resolveCommercialLocalContext,
  splitCommercialAssertions,
} from './commercial-local-context';
import { collectFirstPatternLabels, createCommercialTextMatcher } from './commercial-match-utils';
import { CommercialSecondStageScorer } from './commercial-scorer';
import { normalizeCommercialRawText, normalizeCommercialText } from './commercial-normalization';
import {
  ADS_AMBIGUOUS_TRANSPORT_REVIEW_PATTERNS,
  ADS_BOUNDED_WHERE_TO_BUY_REQUEST_PATTERN,
} from './commercial-patterns';
import { classifyCommercialDetection } from './commercial-subtypes';
import type { CommercialLegacyEvidenceStrength } from './commercial.types';

const COMMERCIAL_WARMUP_SETTINGS = {
  commercialAdsSensitivity: 'BALANCED',
  commercialAdsWarnThreshold: 57,
  commercialAdsDeleteThreshold: 77,
} as unknown as ChatSettings;

const COMMERCIAL_WARMUP_TEXTS = [
  'ГРУЗОПЕРЕВОЗКИ +7 900 000 10 42',
  'Приглашаю на окрашивание, окудрение, флисинг, карвинг и реконструкцию волос. Пиши/звони +7 900 000 10 43.',
  'Откройте для себя коллекцию селективных ароматов. Полный флакон 2400₽, мини-версия 250₽.',
  'Всем привет. Добро пожаловать в мой Мир страз: изделия ручной работы, портреты со скидкой, мой канал.',
] as const;

const AMBIGUOUS_TRANSPORT_REVIEW_PREFILTER =
  /(?:водител|пассажир|(?:^|[^\p{L}\p{N}_-])еду(?=$|[^\p{L}\p{N}_-]))/iu;
const MIXED_PROTECTED_COMMERCIAL_CONTEXT_PREFILTER =
  /(?:^|[.!?;\n])\s*(?:(?:(?:а|но)\s+)?(?:отдельно|также|другая\s+тема|по\s+другой\s+теме|ещ[её]\s+одно\s+предложение)\s*[:,-]?|(?:(?:а|но)\s+)?(?:у\s+нас|мы|наш[аи]\s+компани[яи]|я\s+(?:помогу|помогаю|предлагаю|оформлю|выдам))\b)/iu;
const EXPLICIT_TOPIC_CHANGE_BOUNDARY_PATTERN =
  /[.!?;\n…。！？；]\s*(?:(?:а|но)\s+)?(?:отдельно|другая\s+тема|по\s+другой\s+теме|ещ[её]\s+одно\s+предложение|также)\s*[:,-]\s*/giu;
const BOUNDARY_LOCAL_CURRENT_OFFER_PREFILTER =
  /[.!?;\n]\s*[^.!?;\n]{0,320}(?:пишите?|напишите?|звоните?|обращайтесь|остав(?:ьте|ляйте)\s+заявк[\p{L}\p{N}_-]*|получите|оформите|закаж(?:ите|и|ем|у)|заказывайте|регистрируйтесь|переходите|свяжитесь|записывайтесь|запис[ьи\p{L}\p{N}_-]*\s+в\s+(?:лс|личк[\p{L}\p{N}_-]*))(?=$|[^\p{L}\p{N}_-])/iu;
const BARE_QUESTION_CURRENT_OFFER_CUE_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:пиши(?:те)?|напиши(?:те)?|звони(?:те)?|обращай(?:ся|тесь)|записывай(?:ся|тесь)|запишись|запишитесь|остав(?:ьте|ляйте)\s+заявк[\p{L}\p{N}_-]*|закаж(?:и|ите)|оформите)(?=$|[^\p{L}\p{N}_-])/iu;
const BARE_QUESTION_FIRST_PERSON_SERVICE_OFFER_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:я|мы)\s+(?:предлага(?:ю|ем)|оказыва(?:ю|ем)|помога(?:ю|ем)|дела(?:ю|ем)|провод(?:жу|им)|принима(?:ю|ем)|расскаж(?:у|ем)|оформ(?:лю|им)|подбер(?:у|ем)|созда(?:ю|дим)|устанавлива(?:ю|ем)|убира(?:ю|ем))|я\s+ясновидящ[а-яё-]*(?=[\s\S]{0,300}(?:работаю|помогаю|провожу|предсказываю|связаться\s+со\s+мной))|(?:работаем|предлагаем|оказываем|помогаем|расскажем|бер[её]м|возьм[её]м)\s+(?:строго\s+)?(?:по\s+[\p{L}\p{N}_-]+|на\s+себя|как|что|услуг[\p{L}\p{N}_-]*))(?=$|[^\p{L}\p{N}_-])/iu;
const BUYER_OWNED_BUDGET_REQUEST_PATTERN =
  /^(?=[\s\S]{0,100}(?:ищу|нужн(?:а|о|ы|ен)|подскажите|посоветуйте|порекомендуйте|кто\s+(?:поставля(?:ет|ют)|размеща(?:ет|ют))))(?=[\s\S]{0,300}(?:поставщик[а-яё-]*|подрядчик[а-яё-]*|поставля(?:ет|ют)|доставк[а-яё-]*|ассортимент[а-яё-]*|реклам[а-яё-]*|прайс[а-яё-]*))(?=[\s\S]{0,440}(?:бюджет|цен[ау]|прайс[а-яё-]*)\s*(?:до|не\s+более)?\s*\d)(?=[\s\S]{0,520}(?:мо[ий]\s+(?:телефон|номер)|предложени[а-яё-]*[^.!?;\n]{0,40}\sмне|(?:звоните|пишите)\s+мне))[\s\S]{20,520}$/iu;
const BUYER_DIRECTED_RESPONSE_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:свои\s+)?предложени[а-яё-]*[^.!?;\n]{0,40}\sмне|(?:звоните|пишите)\s+мне|мо[ий]\s+(?:телефон|номер))(?=$|[^\p{L}\p{N}_-])/iu;
const LOCAL_BUYER_DIRECTED_REQUEST_PATTERN =
  /^(?=[\s\S]{0,180}(?:ищу|подскажите|посоветуйте|порекомендуйте|кто\s+(?:выда(?:ет|ют)|оформля(?:ет|ют)|оказыва(?:ет|ют)|прода(?:е[тё]|ют))|где\s+(?:купить|найти|заказать)|нужн(?:а|о|ы|ен)))(?=[\s\S]{0,520}(?:(?:пишите?|присылайте?)(?:[^.!?;\n]{0,40})(?:свои\s+)?предложени[а-яё-]*|предложени[а-яё-]*(?:[^.!?;\n]{0,40})(?:пишите?|присылайте?)(?:[^.!?;\n]{0,24})мне|мо[ий]\s+(?:телефон|номер)|бюджет(?:[^.!?;\n]{0,40})\d))[\s\S]{12,520}$/iu;
const EXPLICIT_OWNED_SOURCE_SIDE_OFFER_AFTER_REQUEST_PATTERN =
  /[.!?;\n…。！？；]\s*(?:(?:а|но|также)\s+)?(?:мы|наш[аи]\s+компани[яи])\s+(?:(?:сами|теперь|также|сейчас)\s+)*(?:прода(?:ю|ем)|изготавлива(?:ю|ем)|доставля(?:ю|ем)|поставля(?:ю|ем)|оказыва(?:ю|ем)|предоставля(?:ю|ем)|устанавлива(?:ю|ем)|ремонтиру(?:ю|ем))(?=$|[^\p{L}\p{N}_-])/iu;
const BARE_SOURCE_SIDE_OFFER_AFTER_REQUEST_PATTERN =
  /[.!?;\n…。！？；]\s*(?:(?:а|но|также)\s+)?(?:я\s+)?(?:прода(?:ю|ем)|предлага(?:ю|ем)|оказыва(?:ю|ем)|выполня(?:ю|ем)|изготавлива(?:ю|ем))(?=$|[^\p{L}\p{N}_-])/iu;
const THIRD_PARTY_SERVICE_QUESTION_PATTERN =
  /^(?:(?:(?:дорогие|уважаемые)\s+(?:соседи|друзья|коллеги)|соседи|друзья|коллеги|добрый\s+день|здравствуйте)[,!]?\s*)?(?:(?:пожалуйста\s+)?(?:подскажите|скажите|кто\s+знает)[,:\s-]+)?(?:компани[яи]|фирм[аы]|сервис|организаци[яи]|ооо|ип)\s+(?:(?:["«„][^"»”“\n]{1,80}["»”“])|[\p{L}\p{N}_-]{2,40}(?:\s+[\p{L}\p{N}_-]{1,40}){0,6})\s+(?:оказыва(?:ет|ют)|устанавлива(?:ет|ют)|выполня(?:ет|ют)|предлага(?:ет|ют)|предоставля(?:ет|ют)|занима(?:ется|ются)|провод(?:ит|ят)|дела(?:ет|ют)|ремонтиру(?:ет|ют))(?=$|[^\p{L}\p{N}_-])/iu;
const QUESTION_SEQUENCE_EXPLICIT_ORDER_CTA_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:закаж(?:и|ите)|остав(?:ьте|ляйте)\s+заявк[а-яё-]*|оформите|получите|запиш(?:ись|итесь)|переходите|регистрируйтесь)|телефон\s+для\s+(?:заказ[а-яё-]*|запис[а-яё-]*|заявк[а-яё-]*|брони[а-яё-]*)|(?:запис[ьи]|заявк[аи]|заказ[а-яё-]*|бронировани[ея])[^?？\n]{0,40}(?:по\s+телефон[ау]?|\[phone\]))(?=$|[^\p{L}\p{N}_-])/iu;
const QUESTION_SEQUENCE_GENERIC_RESPONSE_CTA_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:звоните?|пишите?|обращайтесь)(?![^?？\n]{0,64}(?:(?:в|к)\s+компани[а-яё-]*|по\s+(?:номеру|телефону)\s+компани[а-яё-]*|(?:ему|ей|им|мастер[а-яё-]*|подрядчик[а-яё-]*|специалист[а-яё-]*|менеджер[а-яё-]*|представител[а-яё-]*|сотрудник[а-яё-]*)(?:\s+компани[а-яё-]*)?))(?=$|[^\p{L}\p{N}_-])/iu;
const QUESTION_SEQUENCE_OWNED_AVAILABILITY_PREFIX_PATTERN =
  /^[^\p{L}\p{N}_]{0,16}(?:(?:а|но|также)\s+)?у\s+нас(?=$|[^\p{L}\p{N}_-])/iu;
const QUESTION_SEQUENCE_OWNED_AVAILABILITY_OFFER_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:в\s+наличи[а-яё-]*|доставк[а-яё-]*|продаж[а-яё-]*|прода(?:ю|ем)|ассортимент[а-яё-]*|каталог[а-яё-]*|принима(?:ю|ем)\s+заказ[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const QUESTION_SEQUENCE_NUMERIC_PRICE_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:цен[аы]|стоимост[ьи])\s*(?:от\s*)?\d{2,}|от\s+\d{2,}|\d[\d\s.,]{0,16}\s*(?:р(?:уб)?\.?|₽))(?=$|[^\p{L}\p{N}_-])/iu;
const QUESTION_SEQUENCE_RESPONSE_CHANNEL_PATTERN =
  /(?:\[(?:phone|url)\]|(?:^|[^\p{L}\p{N}_-])(?:телефон|номер|звоните?|пишите?|обращайтесь|закаж(?:и|ите)|остав(?:ьте|ляйте)\s+заявк[а-яё-]*)(?=$|[^\p{L}\p{N}_-]))/iu;
const QUESTION_SEQUENCE_ATTRIBUTED_OR_NEGATED_AVAILABILITY_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:обсужда[а-яё-]*|по\s+данн[а-яё-]*|ничего\s+не\s+прода[а-яё-]*|нет\s+в\s+наличи[а-яё-]*|их\s+(?:телефон|номер)|(?:телефон|номер)\s+(?:компани[а-яё-]*|магазин[а-яё-]*|поставщик[а-яё-]*|продавц[а-яё-]*)|пишите?\s+менеджер[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const QUESTION_SEQUENCE_DIRECT_SOURCE_PREFIX_PATTERN =
  /^[^\p{L}\p{N}_]{0,16}(?:(?:а|но|также)\s+)?(?:(?:(?:я|мы)\s+)?(?:прода(?:ю|ем)|предлага(?:ю|ем)|оказыва(?:ю|ем)|выполня(?:ю|ем)|изготавлива(?:ю|ем)|доставля(?:ю|ем)|поставля(?:ю|ем)|предоставля(?:ю|ем)|устанавлива(?:ю|ем)|ремонтиру(?:ю|ем)|убира(?:ю|ем))|наш[аи]\s+компани[яи]\s+(?:прода(?:[её]т|ют)|предлага(?:ет|ют)|оказыва(?:ет|ют)|выполня(?:ет|ют)|изготавлива(?:ет|ют)|доставля(?:ет|ют)|поставля(?:ет|ют)|предоставля(?:ет|ют)|устанавлива(?:ет|ют)|ремонтиру(?:ет|ют)))(?=$|[^\p{L}\p{N}_-])/iu;
const QUESTION_SEQUENCE_ATTRIBUTED_INQUIRY_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:их\s+(?:телефон|номер)|(?:телефон|номер)\s+(?:компани[а-яё-]*|магазин[а-яё-]*|поставщик[а-яё-]*|продавц[а-яё-]*|справочн[а-яё-]*)|(?:звоните?|пишите?|обращайтесь)(?:[^?？\n]{0,64})(?:(?:в|к)\s+компани[а-яё-]*|менеджер[а-яё-]*|секретар[а-яё-]*|охран[а-яё-]*|ему|ей|им))(?=$|[^\p{L}\p{N}_-])/iu;
const QUESTION_SEQUENCE_UNRELATED_ADMIN_CTA_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:по\s+вопрос[а-яё-]*\s+собрани[а-яё-]*|запис[а-яё-]*\s+к\s+врач[а-яё-]*|пропуск[а-яё-]*\s+у\s+охран[а-яё-]*|справочн[а-яё-]*|секретар[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const QUESTION_SEQUENCE_NEGATED_CTA_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:никогда\s+)?не\s+(?:(?:надо|нужно|стоит)\s+)?(?:звоните?|пишите?|обращайтесь|заказывайте?|закаж(?:и|ите)|оставляйте?\s+заявк[а-яё-]*)|запрещено\s+(?:звонить|писать|заказывать))(?=$|[^\p{L}\p{N}_-])/iu;
const QUESTION_SEQUENCE_BUYER_TERMS_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:я\s+)?предлагаю\s+(?:оплат[а-яё-]*|цен[ау]|бюджет|ставк[ау]|вознаграждени[а-яё-]*|услови[ея])|мо[ийя]\s+(?:бюджет|цен[аы]|ставк[аи]|услови[ея])|(?:бюджет|цен[аы]|оплат[а-яё-]*|ставк[аи]|вознаграждени[а-яё-]*|услови[ея])\s*(?:до|не\s+более)?\s*\d+)(?=$|[^\p{L}\p{N}_-])/iu;
const QUESTION_SEQUENCE_NON_ORDER_RESPONSE_PURPOSE_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:жалоб[а-яё-]*|отзыв[а-яё-]*|исследовани[а-яё-]*|опрос[а-яё-]*|протокол[а-яё-]*|архив[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu;

function hasBareQuestionCurrentOfferCue(rawLoweredText: string): boolean {
  return (
    /\[(?:phone|url)\]/iu.test(rawLoweredText) ||
    BARE_QUESTION_CURRENT_OFFER_CUE_PATTERN.test(rawLoweredText) ||
    BARE_QUESTION_FIRST_PERSON_SERVICE_OFFER_PATTERN.test(rawLoweredText)
  );
}

function isThirdPartyServiceQuestionSequence(rawLoweredText: string): boolean {
  const assertions = splitCommercialAssertions(rawLoweredText);
  const questionIndex = findThirdPartyServiceQuestionIndex(assertions);
  return (
    assertions.length >= 2 &&
    questionIndex >= 0 &&
    !hasQuestionLocalSourceSideCta(assertions, questionIndex) &&
    !extractIndependentSourceSideOfferAroundQuestion(assertions, questionIndex)
  );
}

function findThirdPartyServiceQuestionIndex(assertions: readonly string[]): number {
  return assertions.findIndex(
    (assertion) =>
      /[?？]["'»”’“]?\s*$/u.test(assertion) && THIRD_PARTY_SERVICE_QUESTION_PATTERN.test(assertion),
  );
}

function extractIndependentSourceSideOfferAroundQuestionFromText(
  rawLoweredText: string,
): string | null {
  const assertions = splitCommercialAssertions(rawLoweredText);
  const questionIndex = findThirdPartyServiceQuestionIndex(assertions);
  if (assertions.length < 2 || questionIndex < 0) {
    return null;
  }
  return extractIndependentSourceSideOfferAroundQuestion(assertions, questionIndex);
}

function hasQuestionLocalSourceSideCta(
  assertions: readonly string[],
  questionIndex: number,
): boolean {
  const localTail = assertions.slice(questionIndex + 1, questionIndex + 7);
  let hasAttributedInquiry = false;
  let hasBuyerTerms = false;
  let inspectedLength = 0;
  for (const assertion of localTail) {
    inspectedLength += assertion.length;
    if (inspectedLength > 700) {
      break;
    }
    if (QUESTION_SEQUENCE_ATTRIBUTED_INQUIRY_PATTERN.test(assertion)) {
      hasAttributedInquiry = true;
      continue;
    }
    if (QUESTION_SEQUENCE_BUYER_TERMS_PATTERN.test(assertion)) {
      hasBuyerTerms = true;
    }
    if (QUESTION_SEQUENCE_UNRELATED_ADMIN_CTA_PATTERN.test(assertion)) {
      continue;
    }
    if (
      QUESTION_SEQUENCE_NEGATED_CTA_PATTERN.test(assertion) ||
      QUESTION_SEQUENCE_NON_ORDER_RESPONSE_PURPOSE_PATTERN.test(assertion) ||
      (hasBuyerTerms && BUYER_DIRECTED_RESPONSE_PATTERN.test(assertion))
    ) {
      continue;
    }
    if (QUESTION_SEQUENCE_EXPLICIT_ORDER_CTA_PATTERN.test(assertion)) {
      return true;
    }
    if (!hasAttributedInquiry && QUESTION_SEQUENCE_GENERIC_RESPONSE_CTA_PATTERN.test(assertion)) {
      return true;
    }
  }
  return false;
}

function extractIndependentSourceSideOfferAroundQuestion(
  assertions: readonly string[],
  questionIndex: number,
): string | null {
  for (let index = 0; index < assertions.length; index += 1) {
    if (index === questionIndex) {
      continue;
    }
    const sourceAssertion = assertions[index];
    const hasDirectSource = QUESTION_SEQUENCE_DIRECT_SOURCE_PREFIX_PATTERN.test(sourceAssertion);
    const hasOwnedAvailabilitySource =
      QUESTION_SEQUENCE_OWNED_AVAILABILITY_PREFIX_PATTERN.test(sourceAssertion);
    if (!hasDirectSource && !hasOwnedAvailabilitySource) {
      continue;
    }

    const windowParts = [sourceAssertion];
    for (let offset = 1; offset < 3 && index + offset < assertions.length; offset += 1) {
      if (index + offset === questionIndex) {
        break;
      }
      const nextAssertion = assertions[index + offset];
      const nextWindow = `${windowParts.join('. ')}. ${nextAssertion}`;
      if (nextWindow.length > 560) {
        break;
      }
      windowParts.push(nextAssertion);
    }

    const window = windowParts.join('. ');
    if (
      QUESTION_SEQUENCE_BUYER_TERMS_PATTERN.test(window) &&
      BUYER_DIRECTED_RESPONSE_PATTERN.test(window)
    ) {
      continue;
    }
    const hasOfferCue = QUESTION_SEQUENCE_OWNED_AVAILABILITY_OFFER_PATTERN.test(window);
    const hasNumericPrice = QUESTION_SEQUENCE_NUMERIC_PRICE_PATTERN.test(window);
    const hasResponseChannel = QUESTION_SEQUENCE_RESPONSE_CHANNEL_PATTERN.test(window);
    const hasDirectSourceDeal =
      hasDirectSource && (hasNumericPrice || hasResponseChannel || hasOfferCue);
    const hasOwnedAvailabilityDeal =
      hasOwnedAvailabilitySource &&
      ((hasOfferCue && (hasNumericPrice || hasResponseChannel)) ||
        (hasNumericPrice && hasResponseChannel));
    if (
      !QUESTION_SEQUENCE_ATTRIBUTED_OR_NEGATED_AVAILABILITY_PATTERN.test(window) &&
      (hasDirectSourceDeal || hasOwnedAvailabilityDeal)
    ) {
      return window;
    }
  }

  return null;
}

function extractExplicitIndependentOffer(rawLoweredText: string): string | null {
  const boundedText = rawLoweredText.slice(0, 8_000);
  const quoteState: DelimitedQuoteState = { expectedClosers: [] };
  let quoteScanIndex = 0;
  EXPLICIT_TOPIC_CHANGE_BOUNDARY_PATTERN.lastIndex = 0;
  for (const boundary of boundedText.matchAll(EXPLICIT_TOPIC_CHANGE_BOUNDARY_PATTERN)) {
    if (boundary.index === undefined) {
      continue;
    }
    advanceDelimitedQuoteState(boundedText, quoteScanIndex, boundary.index, quoteState);
    quoteScanIndex = boundary.index;
    if (quoteState.expectedClosers.length > 0) {
      continue;
    }
    const offer = boundedText.slice(boundary.index + boundary[0].length).trim();
    if (offer) {
      return offer;
    }
  }
  return null;
}

type DelimitedQuoteState = {
  expectedClosers: string[];
};

function advanceDelimitedQuoteState(
  text: string,
  start: number,
  end: number,
  state: DelimitedQuoteState,
): void {
  for (let index = start; index < end; index += 1) {
    const character = text[index];
    if (character === '«') {
      state.expectedClosers.push('»');
    } else if (character === '„') {
      state.expectedClosers.push('“');
    } else if (character === '“') {
      toggleExpectedCloser(state, '“', '”');
    } else if (character === '»' || character === '”') {
      closeExpectedQuote(state, character);
    } else if (character === '"' && text[index - 1] !== '\\') {
      toggleExpectedCloser(state, '"', '"');
    }
  }
}

function toggleExpectedCloser(
  state: DelimitedQuoteState,
  closingCharacter: string,
  openingExpectedCloser: string,
): void {
  if (state.expectedClosers[state.expectedClosers.length - 1] === closingCharacter) {
    state.expectedClosers.pop();
    return;
  }
  state.expectedClosers.push(openingExpectedCloser);
}

function closeExpectedQuote(state: DelimitedQuoteState, character: string): void {
  if (state.expectedClosers[state.expectedClosers.length - 1] === character) {
    state.expectedClosers.pop();
  }
}

let commercialDetectorWarmUpComplete = false;
let commercialDetectorWarmUpInProgress = false;

export type CommercialDetection = {
  rawText: string;
  analysisText?: string;
  confidenceScore: number;
  decisionBand: CommercialDecisionBand;
  matchedSignals: string[];
  negativeSignals: string[];
  primarySubtype: CommercialSubtype;
  supportingSubtypes: CommercialSubtype[];
  evidenceStrength: CommercialLegacyEvidenceStrength;
  reviewRecommended: boolean;
  reviewReasons: string[];
  campaignContext: CommercialCampaignContext | null;
  appliedThresholds: {
    warnThreshold: number;
    deleteThreshold: number;
    sensitivity: 'BALANCED' | 'STRICT';
    strictness: number;
  };
  classifierVersion: string | null;
  commercialProbability: number | null;
  reviewProbability: number | null;
  classifierReasons: string[];
  hasActionDirectDealEvidence?: boolean;
  hasNonCampaignDirectDealEvidence?: boolean;
  hasEscalationRiskEvidence?: boolean;
  decisionVersion?: string;
  score?: number;
  actionScore?: number;
  fpRisk?: number;
  policyFpRisk?: number;
  evidenceTier?: string;
  subtype?: CommercialSubtype;
  actionBand?: string;
  reviewPriority?: string;
  campaignStrength?: string;
  safeContextBucket?: string;
  actionable?: boolean;
  recordable?: boolean;
  deleteSuppressed?: boolean;
  suppressionReasons?: string[];
  reasonCodes?: string[];
  featureVector?: Record<string, number>;
};

export class CommercialAdDetector {
  private readonly commercialSecondStageScorer = new CommercialSecondStageScorer();

  constructor() {
    this.warmUpProcessPatterns();
  }

  detect(params: {
    normalizedText: string;
    rawLoweredText: string;
    settings: ChatSettings;
    commercialCampaignContext?: CommercialCampaignContext | null;
  }): CommercialDetection | null {
    const detection = this.detectCommercialAd(params);
    const reviewSignals = collectAmbiguousTransportReviewSignals(params);
    if (!detection && reviewSignals.length === 0) {
      return null;
    }

    if (!detection) {
      return enrichCommercialDetection(
        buildAmbiguousTransportReviewDetection(params, reviewSignals),
      );
    }

    for (const signal of reviewSignals) {
      if (!detection.matchedSignals.includes(signal)) {
        detection.matchedSignals.push(signal);
      }
    }
    return enrichCommercialDetection(detection);
  }

  hasCommercialSpamMarkers(text: string): boolean {
    return hasCommercialSpamMarkersInText(text);
  }

  private warmUpProcessPatterns(): void {
    if (commercialDetectorWarmUpComplete || commercialDetectorWarmUpInProgress) {
      return;
    }

    commercialDetectorWarmUpInProgress = true;
    try {
      for (const text of COMMERCIAL_WARMUP_TEXTS) {
        this.detectCommercialAd({
          normalizedText: normalizeCommercialText(text),
          rawLoweredText: text.toLowerCase(),
          settings: COMMERCIAL_WARMUP_SETTINGS,
          commercialCampaignContext: null,
        });
      }
      commercialDetectorWarmUpComplete = true;
    } finally {
      commercialDetectorWarmUpInProgress = false;
    }
  }

  private detectCommercialAd(params: {
    normalizedText: string;
    rawLoweredText: string;
    settings: ChatSettings;
    commercialCampaignContext?: CommercialCampaignContext | null;
  }): CommercialDetection | null {
    const { settings, commercialCampaignContext } = params;
    let analysisCampaignContext = commercialCampaignContext;
    let rawLoweredText = normalizeCommercialRawText(params.rawLoweredText);
    let normalizedText = normalizeCommercialText(rawLoweredText || params.normalizedText);

    if (!normalizedText || normalizedText.length < 6) {
      return null;
    }

    const appliedThresholds = resolveCommercialThresholds(settings);
    let state = collectCommercialSignals({
      normalizedText,
      rawLoweredText,
      profile: appliedThresholds,
      commercialCampaignContext,
    });
    const hasExplicitAttributedSafeContext =
      state.negativeSignals.includes('context:quoted-ad-example') ||
      state.negativeSignals.includes('context:attributed-commercial-report');
    const escalationRiskLabels = state.matchedSignals
      .filter(isCommercialEscalationRiskSignal)
      .map((signal) => signal.slice('risk:'.length));
    const hasMixedProtectedCommercialContext =
      MIXED_PROTECTED_COMMERCIAL_CONTEXT_PREFILTER.test(rawLoweredText);
    const hasSearchRequestOfferBoundary =
      state.hasSearchRequestContext && BOUNDARY_LOCAL_CURRENT_OFFER_PREFILTER.test(rawLoweredText);
    const shouldInspectOrdinaryProtectedContext =
      (hasMixedProtectedCommercialContext ||
        hasExplicitAttributedSafeContext ||
        hasSearchRequestOfferBoundary) &&
      (escalationRiskLabels.length === 0 ||
        hasMixedProtectedCommercialContext ||
        hasExplicitAttributedSafeContext ||
        hasSearchRequestOfferBoundary);
    const localContext = shouldInspectOrdinaryProtectedContext
      ? resolveCommercialLocalContext({
          rawLoweredText,
          escalationRiskLabels,
          includeOrdinaryProtectedContext: true,
        })
      : null;
    const protectedContextOfferText = localContext?.hasProtectedContext
      ? localContext.independentCommercialOfferText
      : null;
    const explicitTopicOfferText = hasMixedProtectedCommercialContext
      ? extractExplicitIndependentOffer(rawLoweredText)
      : null;
    const questionSequenceOfferText =
      extractIndependentSourceSideOfferAroundQuestionFromText(rawLoweredText);
    const localOfferText =
      protectedContextOfferText ?? explicitTopicOfferText ?? questionSequenceOfferText;
    let isolatedIndependentOffer = false;
    if (localOfferText) {
      const localRawLoweredText = normalizeCommercialRawText(localOfferText);
      const localNormalizedText = normalizeCommercialText(localRawLoweredText);
      const localCampaignContext = retainSenderCommercialCampaignContext(commercialCampaignContext);
      const localState = collectCommercialSignals({
        normalizedText: localNormalizedText,
        rawLoweredText: localRawLoweredText,
        profile: appliedThresholds,
        commercialCampaignContext: localCampaignContext,
      });
      const localEscalationRiskLabels = localState.matchedSignals
        .filter(isCommercialEscalationRiskSignal)
        .map((signal) => signal.slice('risk:'.length));
      const hasIndependentLocalEscalationOffer =
        localEscalationRiskLabels.length === 0 ||
        resolveCommercialLocalContext({
          rawLoweredText: localRawLoweredText,
          escalationRiskLabels: localEscalationRiskLabels,
          includeOrdinaryProtectedContext: true,
        }).hasIndependentEscalationOffer;
      if (
        explicitTopicOfferText === localOfferText &&
        LOCAL_BUYER_DIRECTED_REQUEST_PATTERN.test(localRawLoweredText)
      ) {
        const offerIndex = rawLoweredText.lastIndexOf(localOfferText);
        const prefixRawLoweredText = rawLoweredText.slice(0, Math.max(0, offerIndex)).trim();
        const prefixState = collectCommercialSignals({
          normalizedText: normalizeCommercialText(prefixRawLoweredText),
          rawLoweredText: prefixRawLoweredText,
          profile: appliedThresholds,
          commercialCampaignContext,
        });
        if (!prefixState.hasCommercialContext || !prefixState.hasDealSignal) {
          return null;
        }
      }
      if (
        localState.matchedSignals.length > 0 &&
        localState.hasCommercialContext &&
        localState.hasDealSignal &&
        !LOCAL_BUYER_DIRECTED_REQUEST_PATTERN.test(localRawLoweredText) &&
        hasIndependentLocalEscalationOffer
      ) {
        localState.matchedSignals.push('locality:independent-commercial-offer');
        rawLoweredText = localRawLoweredText;
        normalizedText = localNormalizedText;
        state = localState;
        analysisCampaignContext = localCampaignContext;
        isolatedIndependentOffer = true;
      }
    }
    if (state.matchedSignals.length === 0 || !state.hasCommercialContext || !state.hasDealSignal) {
      return null;
    }

    if (isBareAvailabilityReply(rawLoweredText)) {
      return null;
    }

    const evidence = resolveCommercialEvidenceProfile({
      state,
      appliedThresholds,
      commercialCampaignContext: analysisCampaignContext,
    });
    const hasBoundedRecallEvidence = evidence.hasBoundedRecallEvidence;

    if (
      isThirdPartyServiceQuestionSequence(rawLoweredText) &&
      !evidence.hasEscalationRiskEvidence
    ) {
      return null;
    }

    if (
      isThirdPartyServiceRecommendationWithoutCurrentOffer(rawLoweredText, state) &&
      !evidence.hasEscalationRiskEvidence
    ) {
      return null;
    }

    if (
      state.negativeSignals.includes('search-pattern:request:specialist') &&
      /(?:^|[.!?;\n])\s*(?:ищу|нуж(?:ен|на|ны)|посоветуйте|порекомендуйте|подскажите)\s+/iu.test(
        rawLoweredText,
      ) &&
      !hasRecruitmentOfferOverride(state) &&
      !evidence.hasEscalationRiskEvidence &&
      !evidence.hasIndependentCommercialOfferEvidence
    ) {
      return null;
    }

    const hasQualifiedSourceSideServiceContext = hasQualifiedSourceSideServiceOffer(rawLoweredText);
    const hasBuyerOwnedBudgetRequest = BUYER_OWNED_BUDGET_REQUEST_PATTERN.test(rawLoweredText);
    const hasBoundedWhereToBuyRequest =
      ADS_BOUNDED_WHERE_TO_BUY_REQUEST_PATTERN.test(rawLoweredText);
    const hasBuyerDirectedResponse = BUYER_DIRECTED_RESPONSE_PATTERN.test(rawLoweredText);
    const hasIndependentSourceSideOfferAfterRequest =
      EXPLICIT_OWNED_SOURCE_SIDE_OFFER_AFTER_REQUEST_PATTERN.test(rawLoweredText) ||
      (!hasBuyerDirectedResponse &&
        (BOUNDARY_LOCAL_CURRENT_OFFER_PREFILTER.test(rawLoweredText) ||
          BARE_SOURCE_SIDE_OFFER_AFTER_REQUEST_PATTERN.test(rawLoweredText)));
    if (
      hasBuyerOwnedBudgetRequest &&
      !hasQualifiedSourceSideServiceContext &&
      !hasIndependentSourceSideOfferAfterRequest &&
      !evidence.hasEscalationRiskEvidence
    ) {
      return null;
    }
    if (hasBoundedWhereToBuyRequest && !evidence.hasEscalationRiskEvidence) {
      return null;
    }
    const hasSelfPromotionalCommercialContext =
      hasExplicitSelfPromotionalCommercialContext(state, rawLoweredText) ||
      BARE_QUESTION_FIRST_PERSON_SERVICE_OFFER_PATTERN.test(rawLoweredText) ||
      hasQualifiedSourceSideServiceContext ||
      hasIndependentSourceSideOfferAfterRequest;
    const hasPrivateLowQuantityGoodsListing =
      isLikelyPrivateLowQuantityGoodsListing(rawLoweredText);
    const hasOnlyBareQuestionSearchContext =
      state.negativeSignals.length > 0 &&
      state.negativeSignals.every((signal) => signal === 'context:question');
    const hasBareQuestionStructuredOfferEvidence =
      hasOnlyBareQuestionSearchContext &&
      evidence.hasStructuredCommercialContext &&
      state.hasTransactional &&
      (state.hasBusinessContext ||
        state.hasCallToActionContext ||
        state.hasServiceContext ||
        state.hasServiceOfferContext);
    const hasWhoProvidesServiceDemandContext =
      state.negativeSignals.includes('search-pattern:request:who-provides-service') &&
      !BARE_QUESTION_FIRST_PERSON_SERVICE_OFFER_PATTERN.test(rawLoweredText) &&
      !hasQualifiedSourceSideServiceContext;

    if (hasWhoProvidesServiceDemandContext) {
      return null;
    }

    if (
      state.hasPrivateSaleContext &&
      !evidence.hasPrivateSaleCommercialOverride &&
      !evidence.hasEscalationRiskEvidence &&
      !hasBoundedRecallEvidence
    ) {
      return null;
    }

    if (
      state.hasSearchRequestContext &&
      !hasSelfPromotionalCommercialContext &&
      !evidence.hasEscalationRiskEvidence &&
      !hasBareQuestionStructuredOfferEvidence
    ) {
      return null;
    }

    const hasBareQuestionCurrentOfferEvidence =
      hasBareQuestionStructuredOfferEvidence &&
      (hasSelfPromotionalCommercialContext || hasBareQuestionCurrentOfferCue(rawLoweredText));

    if (
      state.hasSearchRequestContext &&
      !state.hasPrice &&
      !state.hasContact &&
      !state.hasDealChannel &&
      !evidence.hasEscalationRiskEvidence &&
      !hasBoundedRecallEvidence &&
      !hasBareQuestionCurrentOfferEvidence
    ) {
      return null;
    }

    if (
      state.hasJobSeekingContext &&
      !hasRecruitmentOfferOverride(state) &&
      !hasBoundedRecallEvidence
    ) {
      return null;
    }

    if (isOfficialAppStoreReferenceNoise(state, rawLoweredText)) {
      return null;
    }

    if (isDefaultMaxInviteNoise(state, rawLoweredText)) {
      return null;
    }

    if (isLikelyDeliveryDiscussionNoise(state, rawLoweredText)) {
      return null;
    }

    if (
      hasRideShareContext(rawLoweredText) &&
      !hasRideShareCommercialOverride(state) &&
      !state.hasBusinessContext &&
      !state.hasDealChannel &&
      !state.hasRecruitmentContext &&
      !state.hasGoodsRetailContext &&
      !state.hasGroupPromoContext &&
      !state.hasCommercialAudienceContext &&
      !hasBoundedRecallEvidence
    ) {
      return null;
    }

    if (
      (state.hasPrivateGoodsItemContext || hasPrivateLowQuantityGoodsListing) &&
      !hasPrivateGoodsCommercialOverride(state) &&
      !evidence.hasEscalationRiskEvidence &&
      !hasBoundedRecallEvidence
    ) {
      return null;
    }

    if (
      hasCommercialDiscussionHardNegative(state, evidence.hasEscalationRiskEvidence, rawLoweredText)
    ) {
      return null;
    }

    if (isLikelyThirdPartyChatDirectoryNoise(state, rawLoweredText)) {
      return null;
    }

    if (
      appliedThresholds.strictness < 0.35 &&
      !hasBoundedRecallEvidence &&
      !(evidence.hasStructuredCommercialContext && evidence.hasStrongCommercialEvidence)
    ) {
      return null;
    }

    if (
      appliedThresholds.strictness < 0.65 &&
      !hasBoundedRecallEvidence &&
      !(evidence.hasStructuredCommercialContext && evidence.hasStandardCommercialEvidence)
    ) {
      return null;
    }

    let confidenceScore = Math.round(Math.max(0, Math.min(100, state.score)));
    if (
      state.hasStrongNegativeContext &&
      !state.hasPrice &&
      !state.hasContact &&
      !state.hasDealChannel
    ) {
      confidenceScore = Math.min(confidenceScore, appliedThresholds.warnThreshold - 1);
    }
    if (hasBoundedRecallEvidence) {
      confidenceScore = Math.max(confidenceScore, appliedThresholds.warnThreshold);
    }

    if (confidenceScore >= appliedThresholds.deleteThreshold) {
      const hasStrongCommercialCombo =
        state.hasCommercialContext &&
        (state.hasTransactional || state.hasContact || state.hasDealChannel || state.hasPrice);
      if (!hasStrongCommercialCombo) {
        confidenceScore = Math.max(
          appliedThresholds.warnThreshold,
          appliedThresholds.deleteThreshold - 1,
        );
      }
    }

    let decisionBand: CommercialDecisionBand =
      confidenceScore >= appliedThresholds.deleteThreshold
        ? 'HIGH'
        : confidenceScore >= appliedThresholds.warnThreshold
          ? 'MEDIUM'
          : 'LOW';
    let classification = classifyCommercialDetection({
      state,
      confidenceScore,
      decisionBand,
      appliedThresholds,
      hasCampaignDependentEvidence: state.hasCampaignContext && evidence.hasStrongCampaignEvidence,
    });
    const secondStage = this.commercialSecondStageScorer.evaluate({
      normalizedText,
      rawLoweredText,
      state,
      confidenceScore,
      decisionBand,
      appliedThresholds,
      classification,
      commercialCampaignContext: analysisCampaignContext,
    });
    if (secondStage) {
      confidenceScore = secondStage.adjustedConfidenceScore;
      decisionBand =
        confidenceScore >= appliedThresholds.deleteThreshold
          ? 'HIGH'
          : confidenceScore >= appliedThresholds.warnThreshold
            ? 'MEDIUM'
            : 'LOW';
      classification = {
        ...classification,
        primarySubtype: secondStage.primarySubtype,
        supportingSubtypes: secondStage.supportingSubtypes,
        reviewRecommended: secondStage.reviewRecommended,
        reviewReasons: secondStage.reviewReasons,
      };
    }

    if (hasBoundedRecallEvidence) {
      confidenceScore = Math.max(confidenceScore, appliedThresholds.warnThreshold);
      decisionBand = confidenceScore >= appliedThresholds.deleteThreshold ? 'HIGH' : 'MEDIUM';
    }

    if (confidenceScore < appliedThresholds.warnThreshold) {
      return null;
    }

    return {
      rawText: params.rawLoweredText,
      ...(isolatedIndependentOffer ? { analysisText: rawLoweredText } : {}),
      confidenceScore,
      decisionBand,
      matchedSignals: state.matchedSignals,
      negativeSignals: state.negativeSignals,
      primarySubtype: classification.primarySubtype,
      supportingSubtypes: classification.supportingSubtypes,
      evidenceStrength: classification.evidenceStrength,
      reviewRecommended: classification.reviewRecommended,
      reviewReasons: classification.reviewReasons,
      campaignContext: state.hasCampaignContext ? (analysisCampaignContext ?? null) : null,
      appliedThresholds,
      classifierVersion: secondStage?.classifierVersion ?? null,
      commercialProbability: secondStage?.commercialProbability ?? null,
      reviewProbability: secondStage?.reviewProbability ?? null,
      classifierReasons: [
        ...(secondStage?.classifierReasons ?? []),
        ...(isolatedIndependentOffer ? ['locality:isolated-independent-commercial-offer'] : []),
      ],
      hasActionDirectDealEvidence: evidence.hasActionDirectDealEvidence,
      hasNonCampaignDirectDealEvidence: evidence.hasNonCampaignDirectDealEvidence,
      hasEscalationRiskEvidence: evidence.hasEscalationRiskEvidence,
    };
  }
}

function retainSenderCommercialCampaignContext(
  context: CommercialCampaignContext | null | undefined,
): CommercialCampaignContext | null {
  if (!context) {
    return null;
  }

  return {
    senderDistinctChatCount: context.senderDistinctChatCount,
    senderDistinctChatCount5m: context.senderDistinctChatCount5m,
    senderDistinctChatCount30m: context.senderDistinctChatCount30m,
    senderDistinctChatCount120m: context.senderDistinctChatCount120m,
    sameTextDistinctChatCount: 0,
    nearTextDistinctChatCount: 0,
    repeatedPhoneDistinctChatCount: 0,
    repeatedLinkDistinctChatCount: 0,
    repeatedDomainDistinctChatCount: 0,
    repeatedHandleDistinctChatCount: 0,
  };
}

function collectAmbiguousTransportReviewSignals(params: {
  normalizedText: string;
  rawLoweredText: string;
}): string[] {
  const hasTransportCandidate = [params.rawLoweredText, params.normalizedText].some(
    (text) =>
      text.length >= 20 && text.length <= 300 && AMBIGUOUS_TRANSPORT_REVIEW_PREFILTER.test(text),
  );
  if (!hasTransportCandidate) {
    return [];
  }

  const rawLoweredText = normalizeCommercialRawText(params.rawLoweredText);
  const normalizedText = normalizeCommercialText(rawLoweredText || params.normalizedText);
  if (!normalizedText || normalizedText.length < 6) {
    return [];
  }

  const matcher = createCommercialTextMatcher(normalizedText, rawLoweredText, {
    rawLoweredTextIsCommercialNormalized: true,
  });
  return collectFirstPatternLabels(
    ADS_AMBIGUOUS_TRANSPORT_REVIEW_PATTERNS,
    matcher.matchesPattern,
    ADS_AMBIGUOUS_TRANSPORT_REVIEW_PATTERNS.length,
  ).map((label) => `review-only:transport-${label}`);
}

function buildAmbiguousTransportReviewDetection(
  params: {
    rawLoweredText: string;
    settings: ChatSettings;
  },
  matchedSignals: string[],
): CommercialDetection {
  return {
    rawText: params.rawLoweredText,
    confidenceScore: 0,
    decisionBand: 'LOW',
    matchedSignals,
    negativeSignals: [],
    primarySubtype: 'SERVICES',
    supportingSubtypes: [],
    evidenceStrength: 'BORDERLINE',
    reviewRecommended: true,
    reviewReasons: ['ambiguous-transport-review-only'],
    campaignContext: null,
    appliedThresholds: resolveCommercialThresholds(params.settings),
    classifierVersion: null,
    commercialProbability: null,
    reviewProbability: null,
    classifierReasons: [],
    hasActionDirectDealEvidence: false,
    hasNonCampaignDirectDealEvidence: false,
    hasEscalationRiskEvidence: false,
  };
}

function hasRecruitmentOfferOverride(state: ReturnType<typeof collectCommercialSignals>): boolean {
  if (!state.hasRecruitmentContext) {
    return false;
  }

  const hasOfferMarker = state.matchedSignals.some((signal) =>
    RECRUITMENT_OFFER_OVERRIDE_SIGNALS.has(signal),
  );
  if (!hasOfferMarker) {
    return false;
  }

  return state.matchedSignals.some(
    (signal) =>
      signal === 'combo:recruitment+deal' ||
      signal === 'risk:structured-job-vacancy' ||
      signal === 'contact:implicit-vacancy-offer' ||
      signal === 'contact:recruitment-response-keyword',
  );
}

const RECRUITMENT_OFFER_OVERRIDE_SIGNALS = new Set([
  'recruitment:ваканси',
  'recruitment:сотрудничеств',
  'recruitment:отклик',
  'recruitment:требуется',
  'recruitment:набор',
  'recruitment:ищет-команду',
  'recruitment:приглашаем-на-должность',
  'recruitment:приглашает-на-службу',
  'recruitment:приглашаем-роли',
  'recruitment:вахта-условия',
  'recruitment:warehouse-job-conditions',
  'recruitment:работа-условия',
  'recruitment:people-work-conditions',
  'recruitment:набирают-специалистов',
  'recruitment:есть-работа',
  'recruitment:marketplace-review-work',
  'recruitment:bot-income-work',
  'recruitment:роль-условия',
  'recruitment:role-first-vacancy',
  'recruitment:leaflet-daily-side-job',
  'recruitment:leaflet-assembly-work',
  'recruitment:remote-network-work',
  'recruitment:hr-chat-recruiter',
  'recruitment:свободное-рабочее-место',
  'recruitment:контрактная-служба',
  'recruitment:контрактная-служба-мо',
  'risk:structured-job-vacancy',
]);

function isOfficialAppStoreReferenceNoise(
  state: ReturnType<typeof collectCommercialSignals>,
  rawLoweredText: string,
): boolean {
  if (state.hasPrice || state.hasContact || state.hasTransactional) {
    return false;
  }

  const hasOfficialAppStoreRisk = state.matchedSignals.some(
    (signal) =>
      signal === 'risk:app-store-directory-promo' || signal === 'risk:app-store-directory-link',
  );
  const hasOnlyOfficialAppStoreLinkContext =
    state.matchedSignals.includes('business:официально') &&
    state.matchedSignals.includes('deal-channel:link') &&
    state.matchedSignals.every(
      (signal) =>
        signal === 'business:официально' ||
        signal === 'deal-channel:link' ||
        signal === 'risk:app-store-directory-promo' ||
        signal === 'risk:app-store-directory-link' ||
        signal === 'combo:business+deal',
    );
  if (!hasOnlyOfficialAppStoreLinkContext && !hasOfficialAppStoreRisk) {
    return false;
  }

  return (
    /(?:apps\.apple\.com|play\.google\.com\/store)/iu.test(rawLoweredText) &&
    /(?:официальн[\p{L}\p{N}_-]*\s+приложени[\p{L}\p{N}_-]*|госуслуг[\p{L}\p{N}_-]*)/iu.test(
      rawLoweredText,
    )
  );
}

function hasCommercialDiscussionHardNegative(
  state: ReturnType<typeof collectCommercialSignals>,
  hasEscalationRiskEvidence: boolean,
  rawLoweredText: string,
): boolean {
  const hasCommercialAnimalAdoptionOverride =
    state.negativeSignals.includes('context:animal-adoption') &&
    state.hasPrice &&
    (state.hasContact || state.hasDealChannel || state.hasGoodsRetailContext);
  const hasCommercialFuelRetailOverride =
    state.negativeSignals.includes('context:fuel-availability-report') &&
    state.matchedSignals.includes('goods-retail:explicit-fuel-retail');
  const hasExplicitLinkedGroupPromotionOverride = hasExplicitLinkedBoundedGroupPromotion(
    state,
    rawLoweredText,
  );

  return state.negativeSignals.some(
    (signal) =>
      signal === 'context:quoted-ad-example' ||
      signal === 'context:commercial-review-question' ||
      signal === 'context:channel-ad-due-diligence' ||
      signal === 'context:marketplace-review-complaint' ||
      signal === 'context:reported-escalation-risk' ||
      signal === 'context:leadgen-training-recap' ||
      signal === 'context:local-news-subscribe' ||
      (signal === 'context:moderation-ad-discussion' && !hasExplicitLinkedGroupPromotionOverride) ||
      signal === 'context:resale-pricing-discussion' ||
      signal === 'context:channel-metrics-not-selling' ||
      signal === 'context:public-fraud-warning' ||
      signal === 'context:official-civic-instruction' ||
      signal === 'context:public-training-or-event' ||
      signal === 'context:public-voting-contest' ||
      signal === 'context:public-service-enrollment' ||
      signal === 'context:currency-rate-news' ||
      signal === 'context:giveaway-results-report' ||
      signal === 'context:pseudomedical-attribution-or-debunking' ||
      (signal === 'context:fuel-price-analysis' && !hasEscalationRiskEvidence) ||
      (signal === 'context:fuel-availability-report' &&
        !hasCommercialFuelRetailOverride &&
        !hasEscalationRiskEvidence) ||
      (signal === 'context:public-help-request' && !hasEscalationRiskEvidence) ||
      (signal === 'context:animal-adoption' &&
        !hasCommercialAnimalAdoptionOverride &&
        !hasEscalationRiskEvidence),
  );
}

function isDefaultMaxInviteNoise(
  state: ReturnType<typeof collectCommercialSignals>,
  rawLoweredText: string,
): boolean {
  if (state.hasPrice || state.hasPhoneContact || state.hasTransactional) {
    return false;
  }
  if (state.matchedSignals.some((signal) => signal.startsWith('risk:'))) {
    return false;
  }

  const hasExpectedMaxInvite = /(?:\[url\]|https?:\/\/(?:www\.)?max\.ru\/(?:join\/)?\S+)/iu.test(
    rawLoweredText,
  );
  if (!hasExpectedMaxInvite) {
    return false;
  }

  const withoutUrls = rawLoweredText
    .replace(/(?:https?:\/\/\S+|\[url\])/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /^я\s+пользуюсь\s+мессенджером\s+max[.!?]?\s*присоединяйся[.!?]?$/iu.test(withoutUrls);
}

function isBareAvailabilityReply(rawLoweredText: string): boolean {
  const compactText = rawLoweredText.replace(/\s+/gu, ' ').trim();
  return /^(?:(?:да|нет|есть)[,.!?:-]?\s+)?(?:(?:там|тут|здесь)\s+)?(?:(?:весь|вся|все|всё)\s+)?в\s+наличи[ие][.!?]*$/iu.test(
    compactText,
  );
}

function isLikelyThirdPartyChatDirectoryNoise(
  state: ReturnType<typeof collectCommercialSignals>,
  rawLoweredText: string,
): boolean {
  if (state.matchedSignals.includes('group-promo:explicit-group-promotion')) {
    return false;
  }

  if (
    state.hasPrice ||
    state.hasContact ||
    state.matchedSignals.some((signal) => signal.startsWith('risk:'))
  ) {
    return false;
  }

  if (!state.hasDealChannel) {
    return false;
  }

  const hasDirectoryWording =
    /(?:^|[^\p{L}\p{N}_-])(?:подборк[\p{L}\p{N}_-]*|список|каталог|навигатор|полезн[\p{L}\p{N}_-]*)(?:[\s\S]{0,100})(?:чат[\p{L}\p{N}_-]*|групп[\p{L}\p{N}_-]*|канал[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    ) ||
    /(?:^|[^\p{L}\p{N}_-])(?:присоединяйся|вступай)(?:[\p{L}\p{N}\s.,:;()/%+-]{0,60})(?:групп[\p{L}\p{N}_-]*|чат(?:ы|ов|ам|ами|ах)|канал(?:ы|ов|ам|ами|ах))(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );
  if (!hasDirectoryWording) {
    return false;
  }

  const linkCount = rawLoweredText.match(/(?:https?:\/\/|max\.ru\/join\/|\[url\])/giu)?.length ?? 0;
  const numberedItemCount =
    rawLoweredText.match(/(?:^|[\s.,;:])\d{1,2}\s*[.)]\s+\p{L}/giu)?.length ?? 0;
  if (linkCount < 3 && numberedItemCount < 4) {
    return false;
  }

  if (
    /(?:^|[^\p{L}\p{N}_-])(?:размест(?:им|ить|иться)|реклам[\p{L}\p{N}_-]*|рассылк[\p{L}\p{N}_-]*|охват[\p{L}\p{N}_-]*|аудитори[\p{L}\p{N}_-]*|цена\s+за\s+пост|стоимость\s+(?:реклам[\p{L}\p{N}_-]*|размещени[\p{L}\p{N}_-]*)|прайс|продвижени[\p{L}\p{N}_-]*|платим\s+комисси[\p{L}\p{N}_-]*|добавлени[\p{L}\p{N}_-]*\s+платн[\p{L}\p{N}_-]*|платн[\p{L}\p{N}_-]*\s+добавлени[\p{L}\p{N}_-]*|публикаци[\p{L}\p{N}_-]*\s+платн[\p{L}\p{N}_-]*|платн[\p{L}\p{N}_-]*\s+публикаци[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    )
  ) {
    return false;
  }

  return true;
}

function hasRideShareCommercialOverride(
  state: ReturnType<typeof collectCommercialSignals>,
): boolean {
  return state.matchedSignals.some(
    (signal) =>
      signal.startsWith('service-specialty:') &&
      signal !== 'service-specialty:перевозк' &&
      signal !== 'service-specialty:logistics-delivery',
  );
}

function isLikelyDeliveryDiscussionNoise(
  state: ReturnType<typeof collectCommercialSignals>,
  rawLoweredText: string,
): boolean {
  const hasDeliveryPlatformOnboardingOnly =
    state.matchedSignals.includes('service-specialty:delivery-platform-onboarding') &&
    !state.matchedSignals.some(
      (signal) =>
        signal.startsWith('service-specialty:') &&
        signal !== 'service-specialty:delivery-platform-onboarding',
    );
  const hasDeliveryComplaintContext =
    /(?:^|[^\p{L}\p{N}_-])(?:заказал[аи]?|заказ|курьер[\p{L}\p{N}_-]*|ozon|озон|доставк[\p{L}\p{N}_-]*|оплат[\p{L}\p{N}_-]*\s+наличн[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;()/%+-]{0,180})(?:это\s+нормальн[\p{L}\p{N}_-]*|просит|пишет|звонит|мне|меня|в\s+личк[\p{L}\p{N}_-]*|личн[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    );

  if (
    !state.matchedSignals.includes('promo:доставк') ||
    state.hasIntent ||
    state.hasBusinessContext ||
    state.hasBuyoutContext ||
    state.hasRecruitmentContext ||
    state.hasInfoProductContext ||
    (state.hasServiceContext && !hasDeliveryPlatformOnboardingOnly) ||
    state.hasServiceOfferContext ||
    (state.hasServiceSpecialtyContext && !hasDeliveryPlatformOnboardingOnly) ||
    state.hasGoodsRetailContext ||
    state.hasGroupPromoContext ||
    state.hasCommercialAudienceContext ||
    state.hasChannelPlacementContext ||
    state.hasPropertyAgentContext ||
    state.hasCommercialPropertyContext ||
    state.hasCampaignContext ||
    state.hasPrice ||
    state.hasPhoneContact ||
    state.hasDealChannel
  ) {
    return false;
  }

  const hasOnlyWeakContact = state.matchedSignals.some(
    (signal) =>
      signal === 'contact:в личк' ||
      signal === 'contact:в личные сообщения' ||
      signal === 'contact:личные сообщения' ||
      signal === 'contact:пишите в лич' ||
      signal === 'contact:пишите в личные сообщения' ||
      signal === 'contact:писать в личку',
  );
  if (!hasOnlyWeakContact) {
    return false;
  }

  return (
    hasDeliveryComplaintContext ||
    /(?:^|[^\p{L}\p{N}_-])(?:мне|меня|она|он|они|я\s+писал[аи]?|пишет|звонит|адрес|удалил[аи]?|разборк[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      rawLoweredText,
    )
  );
}
