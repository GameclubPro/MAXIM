import { Injectable, Optional } from '@nestjs/common';
import {
  normalizeMessageLimitsBlockedWordCandidate,
  normalizeAllowlistDomain,
  normalizeAllowlistLink,
  parseStoredAllowlistEntry,
} from '@maxim/contracts';
import { CommercialAdsSensitivity, LinkPolicy, type ChatSettings } from '@prisma/client';
import { createHash } from 'node:crypto';
import { extractUrlsFromText as extractTextUrls, stripUrlsFromText } from '../common/url-text.util';
import { RuntimeDiagnosticsService } from '../system/runtime-diagnostics.service';
import { buildDuplicateStageKey } from './duplicate-state';
import { isExactProfanityVariant } from './profanity-lexicon';
import { RedisCounterService } from './redis-counter.service';

export type CommercialDecisionBand = 'LOW' | 'MEDIUM' | 'HIGH';

export type RuleViolation = {
  ruleCode: string;
  score: number;
  reason: string;
  metadata?: Record<string, unknown>;
};

export type DuplicateAction = 'WARN' | 'MUTE' | 'BAN';

export type DuplicateDecision = {
  action: DuplicateAction;
  count: number;
  threshold: number;
  windowSec: number;
  hash: string;
  nextAction: DuplicateAction | null;
};

export type DuplicateHit = {
  count: number;
  windowSec: number;
  hash: string;
};

export type DetectionResult = {
  violations: RuleViolation[];
  duplicateHit?: DuplicateHit;
  duplicateDecision?: DuplicateDecision;
  duplicateStateSkipped?: boolean;
};

type RuleEngineDetectProfile = {
  startedAtMs: number;
  lastMarkedAtMs: number;
  latestStage: string;
  stages: Map<string, number>;
  stageTimelineMs: Map<string, number>;
};

type DuplicateReactionStage = {
  action: DuplicateAction | null;
};

type CommercialDetection = {
  confidenceScore: number;
  decisionBand: CommercialDecisionBand;
  matchedSignals: string[];
  negativeSignals: string[];
  appliedThresholds: {
    warnThreshold: number;
    deleteThreshold: number;
    sensitivity: 'BALANCED' | 'STRICT';
    strictness: number;
  };
};

type CommercialThresholdProfile = {
  warnThreshold: number;
  deleteThreshold: number;
  sensitivity: 'BALANCED' | 'STRICT';
  strictness: number;
};

type LabeledPattern = {
  label: string;
  pattern: RegExp;
};

type CommercialSignalState = {
  score: number;
  matchedSignals: string[];
  negativeSignals: string[];
  hasIntent: boolean;
  hasServiceOfferContext: boolean;
  hasServiceSpecialtyContext: boolean;
  hasPrice: boolean;
  hasContact: boolean;
  hasPhoneContact: boolean;
  hasDealChannel: boolean;
  hasTransactional: boolean;
  hasDealSignal: boolean;
  hasPromoContext: boolean;
  hasBusinessContext: boolean;
  hasBuyoutContext: boolean;
  hasRecruitmentContext: boolean;
  hasInfoProductContext: boolean;
  hasGroupPromotionIntent: boolean;
  hasGroupPromoContext: boolean;
  hasCommercialAudienceContext: boolean;
  hasSearchRequestContext: boolean;
  hasJobSeekingContext: boolean;
  hasServiceContext: boolean;
  hasCallToActionContext: boolean;
  hasCommercialContext: boolean;
  hasPrivateSaleContext: boolean;
  hasStrongNegativeContext: boolean;
};

type AllowlistMatchers = {
  exactLinks: Set<string>;
  domains: Set<string>;
};

type TopicFilterDetection = {
  mode: 'CODEWORD';
  messageLength: number;
  requiredCodeword: string;
  messageFirstToken: string | null;
};

type BlockedWordDetection = {
  blockedWord: string;
};

const BLOCKED_WORD_LIST_CACHE_MAX_ENTRIES = 512;

// Keep regexes only for highly productive mat roots. Closed-form insults and slurs
// should come from the exact lexicon so names/surnames with the same prefix do not match.
const PROFANITY_CORE_TOKEN_PATTERNS = [
  /^бля(?:[дт][а-я0-9]*)?$/u,
  /^пизд[а-я0-9]*$/u,
  /^(?:на|по|до|о|за|ни|вы)?ху(?:й|е|я|и|ю)[а-я0-9]*$/u,
  /^(?:за|вы|на|по|до|пере|про|об|раз|под|у)?[её]б[а-я0-9]*$/u,
  /^долбо(?:[её]б)[а-я0-9]*$/u,
  /^мраз[а-я0-9]*$/u,
  /^шлюх[а-я0-9]*$/u,
  /^муда(?:к|ч)[а-я0-9]*$/u,
  /^мудил[а-я0-9]*$/u,
  /^ублюд[а-я0-9]*$/u,
  /^твар(?:ь|и|ин)[а-я0-9]*$/u,
  /^идиот[а-я0-9]*$/u,
  /^урод[а-я0-9]*$/u,
  /^г[ао]нд(?:он|ош)[а-я0-9]*$/u,
];
const PROFANITY_LATIN_TOKEN_PATTERNS = [
  /^bl(?:ya|ia)(?:d|t)?[a-z0-9]*$/i,
  /^pizd[a-z0-9]*$/i,
  /^(?:na|po|do|o|za|ni|vy)?(?:h|x)(?:u|oo)(?:y|i|e|ya|yu)?[a-z0-9]*$/i,
  /^(?:za|vy|na|po|do|pere|pro|ob|raz|pod|u)?e+b(?:a|o|i|y|e|u|l|n|t|s|k|sh|zh)[a-z0-9]*$/i,
  /^dolboe+b[a-z0-9]*$/i,
  /^mraz[a-z0-9]*$/i,
  /^shl?yuh[a-z0-9]*$/i,
  /^muda(?:k|ch)[a-z0-9]*$/i,
  /^mudil[a-z0-9]*$/i,
  /^ublyu?d[a-z0-9]*$/i,
  /^tvar(?:in)?[a-z0-9]*$/i,
  /^urod[a-z0-9]*$/i,
  /^g[ao]nd(?:on|osh)[a-z0-9]*$/i,
];
const PROFANITY_CANINE_FEMALE_FORMS = new Set([
  'сука',
  'суки',
  'суке',
  'суку',
  'сукой',
  'сукою',
]);
const PROFANITY_CANINE_CONTEXT_MARKERS = [
  'собак',
  'щен',
  'стерилиз',
  'кастрир',
  'привит',
  'в добрые руки',
  'отдается',
  'отдаётся',
  'охранниц',
  'кошк',
  'котят',
  'питомник',
];
const PROFANITY_EXCEPTIONS = [
  'бляха',
  'бляхер',
  'бляхой',
  'страхуй',
  'подстрахуй',
  'застрахуй',
  'страхуем',
  'страхуя',
  'педикюр',
  'сукно',
  'сукон',
  'скипидар',
  'дебилитац',
  'идиомат',
];
const PROFANITY_SHORT_JOINABLE_TOKENS = new Set([
  'б',
  'л',
  'я',
  'д',
  'дь',
  'т',
  'ть',
  'п',
  'и',
  'з',
  'х',
  'у',
  'й',
  'е',
  'ё',
  'на',
  'по',
  'до',
  'о',
  'за',
  'ни',
  'вы',
  'об',
  'раз',
  'под',
  'про',
  'у',
]);
const PROFANITY_JOIN_WINDOW_TOKENS = 6;
const ADS_INTENT_MARKERS = [
  'продам',
  'продаю',
  'продажа',
  'продается',
  'продаётся',
  'купите',
  'сдам',
  'сдаю',
  'аренда',
  'запись',
  'записывайтесь',
  'услуга',
  'услуги',
  'на заказ',
  'под заказ',
  'принимаю заказы',
  'принимаем заказы',
  'заказы принима',
  'прием заказов',
  'приём заказов',
];
const ADS_SERVICE_INTENT_MARKERS = new Set([
  'услуга',
  'услуги',
  'запись',
  'записывайтесь',
  'на заказ',
  'под заказ',
  'принимаю заказы',
  'принимаем заказы',
  'заказы принима',
  'прием заказов',
  'приём заказов',
]);
const ADS_BUYOUT_MARKERS = [
  'выкуп',
  'скуп',
  'закуп',
  'прием',
  'приём',
  'выкупаем',
  'скупаем',
  'закупаем',
];
const ADS_PROMO_MARKERS = [
  'акци',
  'прайс',
  'прайс-лист',
  'прайс лист',
  'промокод',
  'скидк',
  'распродаж',
  'доставк',
  'в наличии',
  'опт',
  'розниц',
  'остатк',
];
const ADS_BUSINESS_MARKERS = [
  'коммерция',
  'магазин',
  'салон',
  'студия',
  'компания',
  'официально',
  'каталог',
  'витрина',
  'ассортимент',
  'товары',
  'заказывайте',
  'оформить заказ',
  'оформляйте заказ',
  'менеджер',
  'подписывайтесь',
  'поставщик',
  'производитель',
  'вайлдберриз',
  'wildberries',
  'озон',
  'ozon',
];
const ADS_SERVICE_SPECIALTY_MARKERS = [
  'ремонт',
  'сантехник',
  'электрик',
  'грузчик',
  'мастер',
  'бригада',
  'монтаж',
  'демонтаж',
  'сборк',
  'установк',
  'настройк',
  'клининг',
  'уборк',
  'маникюр',
  'педикюр',
  'ресниц',
  'бров',
  'логопед',
  'юрист',
  'психолог',
  'консультац',
  'парикмах',
  'косметолог',
  'массаж',
  'репетитор',
  'няня',
  'сиделк',
  'эвакуатор',
  'грузоперевоз',
  'септик',
  'откачк',
  'ассениз',
];
const ADS_RECRUITMENT_MARKERS = [
  'ваканси',
  'подработк',
  'зарплат',
  'доход',
  'требует',
  'набор',
  'сотрудничеств',
  'смена',
  'отклик',
];
const ADS_INFO_PRODUCT_MARKERS = ['курс', 'вебинар', 'марафон', 'обучени', 'интенсив', 'наставнич'];
const ADS_CALL_TO_ACTION_MARKERS = [
  'успей',
  'переходите',
  'оставляйте заявку',
  'оставьте заявку',
  'открыта запись',
  'запись открыта',
  'места ограничены',
  'бронируйте',
  'бронь',
];
const ADS_GROUP_CONTEXT_MARKERS = [
  'группа',
  'чат',
  'канал',
  'сообщество',
  'клуб',
  'группа в max',
  'чат в max',
  'канал в max',
];
const ADS_GROUP_PROMO_MARKERS = [
  'приглашаю',
  'вступайте',
  'присоединяйтесь',
  'добавляйтесь',
  'заходите',
];
const ADS_GROUP_SELF_REFERENCE_MARKERS = [
  'мой канал',
  'моя группа',
  'мой чат',
  'мое сообщество',
  'моё сообщество',
  'свой канал',
  'свою группу',
  'свой чат',
  'наша группа',
  'наш канал',
  'наш чат',
];
const ADS_GROUP_TRADE_MARKERS = [
  'покупать',
  'продавать',
  'объявлен',
  'обмениваться',
  'купля',
  'продажа',
];
const ADS_COMMERCIAL_AUDIENCE_MARKERS = [
  'клиент',
  'клиентов',
  'подписчик',
  'подписчиков',
  'заказчик',
  'заказчиков',
  'для ваших проектов',
];
const ADS_CONTACT_MARKERS = [
  'пишите в лс',
  'пишите в лич',
  'в лс',
  'в личк',
  'в директ',
  'директ',
  'звоните',
  'звонить',
  'обращайтесь',
  'по телефону',
  'ватсап',
  'whatsapp',
  'вацап',
  'telegram',
  'телеграм',
  'телега',
  'в тг',
  ' тг',
];
const ADS_NEGATIVE_MARKERS = [
  'не продаю',
  'не продается',
  'не реклама',
  'без рекламы',
  'без коммерции',
  'для себя',
];
const ADS_PRIVATE_CONTEXT_MARKERS = [
  'собственник',
  'личные вещи',
  'свои вещи',
  'б/у',
  'с рук',
  'отдам',
  'даром',
  'обмен',
  'самовывоз',
  'торг',
  'не подошл',
  'переезд',
  'разбираю',
  'после ребен',
];
const ADS_QUESTION_CONTEXT_MARKERS = [
  'кто подскажет',
  'посоветуйте',
  'подскажите',
  'как лучше',
  'что выбрать',
  'может кто знает',
];
const ADS_SEARCH_REQUEST_MARKERS = [
  'ищу маст',
  'нужен мастер',
  'нужна помощь',
  'нужен контакт',
  'поделитесь контак',
  'у кого есть контакт',
  'у кого есть номер',
  'к кому обратиться',
  'порекомендуйте',
  'кто знает',
  'кто делал',
  'кто обращался',
  'кто заказывал',
  'где купить',
  'нашла номер',
  'нашла сайт',
  'нашла канал',
  'это нормальный мастер',
];
const ADS_JOB_SEEKING_PATTERNS: LabeledPattern[] = [
  {
    label: 'job-seeking:search',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:ищу|нужна)\s+(?:работ[\p{L}\p{N}_-]*|подработ[\p{L}\p{N}_-]*|вахт[\p{L}\p{N}_-]*|смен[\p{L}\p{N}_-]*|ваканси[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/u,
  },
  {
    label: 'job-seeking:review',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:рассмотрю|ищу)\s+(?:предложени[\p{L}\p{N}_-]*|ваканси[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/u,
  },
  {
    label: 'job-seeking:shift',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])ищу\s+(?:вахт[\p{L}\p{N}_-]*|охран[\p{L}\p{N}_-]*|работ[\p{L}\p{N}_-]*)\s+\d{1,2}\/\d{1,2}(?=$|[^\p{L}\p{N}_-])/u,
  },
];
const ADS_SEARCH_REQUEST_PATTERNS: LabeledPattern[] = [
  {
    label: 'request:specialist',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:ищу|нуж(?:ен|на|ны)|посоветуйте|порекомендуйте|подскажите)\s+(?:хорош(?:ий|ая|ее|его|ую|ие|их)\s+)?(?:маст[\p{L}\p{N}_-]*|бригад[\p{L}\p{N}_-]*|электрик[\p{L}\p{N}_-]*|сантехник[\p{L}\p{N}_-]*|психолог[\p{L}\p{N}_-]*|юрист[\p{L}\p{N}_-]*|логопед[\p{L}\p{N}_-]*|маникюр[\p{L}\p{N}_-]*|педикюр[\p{L}\p{N}_-]*|клининг[\p{L}\p{N}_-]*|ремонт[\p{L}\p{N}_-]*|грузчик[\p{L}\p{N}_-]*|парикмах[\p{L}\p{N}_-]*|косметолог[\p{L}\p{N}_-]*|массаж[\p{L}\p{N}_-]*|репетитор[\p{L}\p{N}_-]*|нян[\p{L}\p{N}_-]*|сиделк[\p{L}\p{N}_-]*|эвакуатор[\p{L}\p{N}_-]*|грузоперевоз[\p{L}\p{N}_-]*|консультац[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/u,
  },
  {
    label: 'request:business',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:посоветуйте|порекомендуйте|подскажите)\s+(?:хорош(?:ий|ая|ее|его|ую|ие|их)\s+)?(?:магазин|салон|студи[\p{L}\p{N}_-]*|компани[\p{L}\p{N}_-]*|канал[\p{L}\p{N}_-]*|групп[\p{L}\p{N}_-]*|чат[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/u,
  },
  {
    label: 'question:experience',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:кто\s+(?:знает|подскажет|делал|обращал[\p{L}\p{N}_-]*|заказывал|пользовал[\p{L}\p{N}_-]*)|может\s+кто\s+знает)(?=$|[^\p{L}\p{N}_-])/u,
  },
  {
    label: 'request:contact',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:у\s+кого\s+есть|поделитесь|есть\s+ли)\s+(?:контакт[\p{L}\p{N}_-]*|номер[\p{L}\p{N}_-]*|телефон[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/u,
  },
  {
    label: 'request:found-reference',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])нашл[аи]\s+(?:номер|контакт|сайт|канал|групп[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/u,
  },
  {
    label: 'request:where-to-buy',
    pattern: /(?:^|[^\p{L}\p{N}_-])где\s+купить(?=$|[^\p{L}\p{N}_-])/u,
  },
  {
    label: 'question:quality-check',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:это|он|она)\s+нормальн[\p{L}\p{N}_-]+\s+(?:мастер|специалист|салон|магазин)(?=$|[^\p{L}\p{N}_-])/u,
  },
];
const ADS_LINK_PATTERN =
  /(https?:\/\/|t\.me\/|max\.ru\/|vk\.com\/|wa\.me\/|taplink|wildberries|wb\.ru|ozon\.ru|market\.yandex)/iu;
const ADS_MARKETPLACE_LINK_PATTERN = /(avito|youla)/iu;
const ADS_PRICE_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])\d{2,}\s?(?:₽|руб(?:\.|лей)?|р\.?|₸|\$|€)(?=$|[^\p{L}\p{N}_-])/iu;
const ADS_TRANSACTIONAL_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:цена|цены|стоимость|оплата|предоплата|доставка|в наличии)(?=$|[^\p{L}\p{N}_-])/iu;
const ADS_URGENCY_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:срочно|только сегодня|до конца дня|осталось\s+\d+)(?=$|[^\p{L}\p{N}_-])/iu;
const ADS_QUANTITY_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:шт|штук|шт\.|пачк[\p{L}\p{N}_-]*|упак[\p{L}\p{N}_-]*|остатк[\p{L}\p{N}_-]*|места)(?=$|[^\p{L}\p{N}_-])/iu;
const ADS_PHONE_PATTERN =
  /(?:^|[^\d])(?:\+7|8)[\s-]*\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?:$|[^\d])/u;
const DUPLICATE_EXCLUDED_PHONE_PATTERN =
  /(?:^|[^\d])(?:\+7|8)[\s-]*\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?:$|[^\d])/u;
const THEMATIC_CODEWORD_MIN_LENGTH = 90;
const DUPLICATE_MIN_LENGTH = 50;
const DUPLICATE_MIN_TOKEN_COUNT = 6;
const DUPLICATE_MIN_UNIQUE_LONG_TOKENS = 4;
const DUPLICATE_STATE_LOOKUP_TIMEOUT_MS = 250;
const RULE_ENGINE_SLOW_LOG_THRESHOLD_MS = 3_000;
const MIXED_CHAR_MAP: Record<string, string> = {
  a: 'а',
  b: 'б',
  c: 'с',
  d: 'д',
  e: 'е',
  f: 'ф',
  g: 'г',
  h: 'х',
  i: 'и',
  j: 'й',
  k: 'к',
  l: 'л',
  m: 'м',
  n: 'н',
  o: 'о',
  p: 'п',
  q: 'к',
  r: 'р',
  s: 'с',
  t: 'т',
  u: 'у',
  v: 'в',
  w: 'в',
  x: 'х',
  y: 'у',
  z: 'з',
  '0': 'о',
  '1': 'и',
  '3': 'з',
  '4': 'а',
  '6': 'б',
  '7': 'т',
  '8': 'в',
  '9': 'д',
  '@': 'а',
  $: 'с',
};

@Injectable()
export class RuleEngineService {
  private duplicateTimeoutWarnAtMs = 0;
  private readonly blockedWordListCache = new Map<string, readonly string[]>();
  private readonly blockedWordPatternCache = new Map<string, RegExp>();

  constructor(
    private readonly redisCounter: RedisCounterService,
    @Optional() private readonly runtimeDiagnosticsService?: RuntimeDiagnosticsService,
  ) {}

  async detect(params: {
    chatId: string;
    userId: string;
    text: string;
    settings: ChatSettings;
    domainAllowlist: string[];
    effectiveLength?: number;
    hasPhotoAttachment?: boolean;
    hasStickerAttachment?: boolean;
    hasVideoAttachment?: boolean;
    hasFileAttachment?: boolean;
    hasVoiceAttachment?: boolean;
    skipDuplicateState?: boolean;
  }): Promise<DetectionResult> {
    const {
      chatId,
      userId,
      text,
      settings,
      domainAllowlist,
      effectiveLength,
      hasPhotoAttachment,
      hasStickerAttachment,
      hasVideoAttachment,
      hasFileAttachment,
      hasVoiceAttachment,
      skipDuplicateState,
    } = params;
    const profile = this.createDetectProfile();
    const violations: RuleViolation[] = [];
    const needsNormalized =
      settings.commercialAdsFilterEnabled ||
      settings.thematicCodewordEnabled ||
      settings.antiDuplicateEnabled;
    const normalized = needsNormalized ? this.normalizeForDetection(text) : '';
    this.markDetectStage(profile, 'normalize');
    const lowered = settings.commercialAdsFilterEnabled ? text.toLowerCase() : '';
    const measuredLength = typeof effectiveLength === 'number' ? effectiveLength : text.length;

    if (settings.russianProfanityFilterEnabled && this.hasProfanity(text)) {
      violations.push({
        ruleCode: 'PROFANITY',
        score: 0.95,
        reason: 'Detected profanity or abusive language pattern',
      });
    }
    this.markDetectStage(profile, 'profanity');

    if (settings.commercialAdsFilterEnabled) {
      const commercial = this.detectCommercialAd({
        normalizedText: normalized,
        rawLoweredText: lowered,
        settings,
      });
      if (commercial) {
        violations.push({
          ruleCode: 'COMMERCIAL_AD',
          score: commercial.confidenceScore / 100,
          reason: 'Detected Russian commercial ad pattern',
          metadata: {
            confidenceScore: commercial.confidenceScore,
            decisionBand: commercial.decisionBand,
            matchedSignals: commercial.matchedSignals,
            negativeSignals: commercial.negativeSignals,
            appliedThresholds: commercial.appliedThresholds,
          },
        });
      }
    }
    this.markDetectStage(profile, 'commercial-ad');

    const topicMismatch = this.detectTopicFilterMismatch({
      rawText: text,
      measuredLength,
      settings,
    });
    if (topicMismatch) {
      violations.push({
        ruleCode: 'TOPIC_FILTER_MISMATCH',
        score: 0.84,
        reason: 'Message without required thematic markers',
        metadata: {
          mode: topicMismatch.mode,
          messageLength: topicMismatch.messageLength,
          requiredCodeword: topicMismatch.requiredCodeword,
          messageFirstToken: topicMismatch.messageFirstToken,
        },
      });
    }
    this.markDetectStage(profile, 'topic-filter');

    const linkViolation = this.hasBlockedLink(text, settings.linkPolicy, domainAllowlist);
    if (linkViolation) {
      violations.push({ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: linkViolation });
    }
    this.markDetectStage(profile, 'links');

    if (settings.maxMessageLengthEnabled && measuredLength > settings.maxMessageLength) {
      violations.push({
        ruleCode: 'MESSAGE_TOO_LONG',
        score: 0.82,
        reason: `Message length ${measuredLength} exceeds limit ${settings.maxMessageLength}`,
      });
    }
    this.markDetectStage(profile, 'message-length');

    if (settings.messageCountLimitEnabled) {
      const windowHours = Math.min(24, Math.max(1, settings.messageCountLimitWindowHours));
      const maxMessages = Math.min(10, Math.max(1, settings.messageCountLimitMessages));
      const key = `message:count-limit:v1:${chatId}:${userId}:${maxMessages}:${windowHours}`;
      const count = await this.redisCounter.incrementWithTtl(key, windowHours * 60 * 60 + 1);
      if (count > maxMessages) {
        violations.push({
          ruleCode: 'MESSAGE_COUNT_LIMIT',
          score: 0.87,
          reason: `Messages are limited to ${maxMessages} per ${windowHours}h`,
        });
      }
    }
    this.markDetectStage(profile, 'message-count-limit');

    const blockedWord = this.detectMessageLimitsBlockedWord(
      text,
      settings.messageLimitsBlockedWords,
    );
    if (blockedWord) {
      violations.push({
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        score: 0.89,
        reason: `Blocked word detected: ${blockedWord.blockedWord}`,
        metadata: {
          blockedWord: blockedWord.blockedWord,
        },
      });
    }
    this.markDetectStage(profile, 'blocked-words');

    if (hasVideoAttachment && !settings.videoMessagesEnabled) {
      violations.push({
        ruleCode: 'VIDEO_BLOCKED',
        score: 0.88,
        reason: 'Video messages are disabled by chat settings',
      });
    }

    if (hasFileAttachment && !settings.fileMessagesEnabled) {
      violations.push({
        ruleCode: 'FILE_BLOCKED',
        score: 0.88,
        reason: 'File messages are disabled by chat settings',
      });
    }

    if (hasVoiceAttachment && !settings.voiceMessagesEnabled) {
      violations.push({
        ruleCode: 'VOICE_BLOCKED',
        score: 0.88,
        reason: 'Voice messages are disabled by chat settings',
      });
    }

    if (hasPhotoAttachment && settings.photoMessageCooldownEnabled) {
      const cooldownSec = settings.photoMessageCooldownHours * 60 * 60;
      const key = `photo:cooldown:${chatId}:${userId}`;
      const count = await this.redisCounter.incrementWithTtl(key, cooldownSec + 1);
      if (count > 1) {
        violations.push({
          ruleCode: 'PHOTO_RATE_LIMIT',
          score: 0.86,
          reason: `Messages with photos are limited to one per ${settings.photoMessageCooldownHours}h`,
        });
      }
    }

    if (hasStickerAttachment && settings.stickerMessageCooldownEnabled) {
      const cooldownSec = settings.stickerMessageCooldownMinutes * 60;
      const key = `sticker:cooldown:${chatId}:${userId}`;
      const count = await this.redisCounter.incrementWithTtl(key, cooldownSec + 1);
      if (count > 1) {
        violations.push({
          ruleCode: 'STICKER_RATE_LIMIT',
          score: 0.86,
          reason: `Stickers are limited to one per ${settings.stickerMessageCooldownMinutes}m`,
        });
      }
    }
    this.markDetectStage(profile, 'attachments');

    const compactText = settings.antiDuplicateEnabled ? normalized.replace(/\s+/g, ' ').trim() : '';
    const duplicateCandidate =
      settings.antiDuplicateEnabled &&
      violations.length === 0 &&
      !linkViolation &&
      this.shouldTrackDuplicate(text, compactText);
    this.markDetectStage(profile, 'duplicate-precheck');
    const duplicateState =
      duplicateCandidate && !skipDuplicateState
        ? await this.detectDuplicateStateWithin({
            chatId,
            userId,
            compactText,
            settings,
          })
        : undefined;
    this.markDetectStage(profile, 'duplicate-state');

    this.logSlowDetectIfNeeded({
      chatId,
      userId,
      measuredLength,
      settings,
      violationsCount: violations.length,
      duplicateCandidate,
      profile,
    });
    this.recordDetectProfile(profile);

    return {
      violations,
      ...(duplicateState?.hit ? { duplicateHit: duplicateState.hit } : {}),
      ...(duplicateState?.decision ? { duplicateDecision: duplicateState.decision } : {}),
      ...(skipDuplicateState ? { duplicateStateSkipped: true } : {}),
    };
  }

  private createDetectProfile(): RuleEngineDetectProfile {
    const now = Date.now();
    return {
      startedAtMs: now,
      lastMarkedAtMs: now,
      latestStage: 'start',
      stages: new Map(),
      stageTimelineMs: new Map(),
    };
  }

  private markDetectStage(profile: RuleEngineDetectProfile, stage: string): void {
    const now = Date.now();
    profile.latestStage = stage;
    profile.stages.set(stage, Math.max(0, now - profile.lastMarkedAtMs));
    profile.stageTimelineMs.set(stage, Math.max(0, now - profile.startedAtMs));
    profile.lastMarkedAtMs = now;
  }

  private readDetectProfileSnapshot(profile: RuleEngineDetectProfile): {
    latestStage: string;
    elapsedMs: number;
    stageDurations: Record<string, number>;
    stageTimelineMs: Record<string, number>;
  } {
    return {
      latestStage: profile.latestStage,
      elapsedMs: Math.max(0, Date.now() - profile.startedAtMs),
      stageDurations: Object.fromEntries(profile.stages.entries()),
      stageTimelineMs: Object.fromEntries(profile.stageTimelineMs.entries()),
    };
  }

  private logSlowDetectIfNeeded(params: {
    chatId: string;
    userId: string;
    measuredLength: number;
    settings: ChatSettings;
    violationsCount: number;
    duplicateCandidate: boolean;
    profile: RuleEngineDetectProfile;
  }): void {
    const snapshot = this.readDetectProfileSnapshot(params.profile);
    if (snapshot.elapsedMs < RULE_ENGINE_SLOW_LOG_THRESHOLD_MS) {
      return;
    }

    console.warn(
      JSON.stringify({
        level: 'warn',
        context: 'RuleEngineService',
        chatId: params.chatId,
        userId: params.userId,
        elapsedMs: snapshot.elapsedMs,
        latestStage: snapshot.latestStage,
        textLength: params.measuredLength,
        linkPolicy: params.settings.linkPolicy,
        antiDuplicateEnabled: params.settings.antiDuplicateEnabled,
        commercialAdsFilterEnabled: params.settings.commercialAdsFilterEnabled,
        thematicCodewordEnabled: params.settings.thematicCodewordEnabled,
        messageCountLimitEnabled: params.settings.messageCountLimitEnabled,
        russianProfanityFilterEnabled: params.settings.russianProfanityFilterEnabled,
        violationsCount: params.violationsCount,
        duplicateCandidate: params.duplicateCandidate,
        stageDurations: snapshot.stageDurations,
        stageTimelineMs: snapshot.stageTimelineMs,
        msg: 'Slow rule-engine detect completed close to the hot-path deadline',
      }),
    );
  }

  private recordDetectProfile(profile: RuleEngineDetectProfile): void {
    const snapshot = this.readDetectProfileSnapshot(profile);
    void this.runtimeDiagnosticsService?.recordHotPathProfile({
      snapshot: {
        stageDurations: Object.fromEntries(
          Object.entries(snapshot.stageDurations).map(([stage, elapsedMs]) => [
            `rule-engine.${stage}`,
            elapsedMs,
          ]),
        ),
      },
    });
  }

  private async detectDuplicateStateWithin(params: {
    chatId: string;
    userId: string;
    compactText: string;
    settings: ChatSettings;
  }): Promise<
    | {
        hit?: DuplicateHit;
        decision?: DuplicateDecision;
      }
    | undefined
  > {
    const operationPromise = this.detectDuplicateState(params);
    operationPromise.catch(() => undefined);

    let timeout: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<undefined>((resolve) => {
      timeout = setTimeout(() => resolve(undefined), DUPLICATE_STATE_LOOKUP_TIMEOUT_MS);
      timeout.unref?.();
    });

    try {
      const result = await Promise.race([operationPromise, timeoutPromise]);
      if (typeof result === 'undefined') {
        this.logDuplicateStateTimeout(params.chatId, params.userId);
      }
      return result;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  hasCommercialSpamMarkers(text: string): boolean {
    const normalizedText = this.normalizeForDetection(text);
    const rawLoweredText = text.toLowerCase();
    if (!normalizedText) {
      return false;
    }

    const hasMarker = (marker: string): boolean =>
      normalizedText.includes(marker) || rawLoweredText.includes(marker);

    const hasCommercialContext =
      ADS_PROMO_MARKERS.some((marker) => hasMarker(marker)) ||
      ADS_BUSINESS_MARKERS.some((marker) => hasMarker(marker)) ||
      ADS_BUYOUT_MARKERS.some((marker) => hasMarker(marker)) ||
      ADS_RECRUITMENT_MARKERS.some((marker) => hasMarker(marker)) ||
      ADS_INFO_PRODUCT_MARKERS.some((marker) => hasMarker(marker));
    const hasIntentContext = ADS_INTENT_MARKERS.some((marker) => hasMarker(marker));
    const hasServiceOfferContext = [...ADS_SERVICE_INTENT_MARKERS].some((marker) =>
      hasMarker(marker),
    );
    const hasServiceSpecialtyContext = ADS_SERVICE_SPECIALTY_MARKERS.some((marker) =>
      hasMarker(marker),
    );
    const hasGroupContext = ADS_GROUP_CONTEXT_MARKERS.some((marker) => hasMarker(marker));
    const hasGroupPromotionIntent =
      ADS_GROUP_PROMO_MARKERS.some((marker) => hasMarker(marker)) ||
      ADS_GROUP_SELF_REFERENCE_MARKERS.some((marker) => hasMarker(marker));
    const hasGroupTradeContext =
      ADS_GROUP_TRADE_MARKERS.some((marker) => hasMarker(marker)) ||
      ADS_COMMERCIAL_AUDIENCE_MARKERS.some((marker) => hasMarker(marker));
    const hasCommercialAudienceContext = ADS_COMMERCIAL_AUDIENCE_MARKERS.some((marker) =>
      hasMarker(marker),
    );
    const hasCallToActionContext = ADS_CALL_TO_ACTION_MARKERS.some((marker) => hasMarker(marker));
    const hasSearchRequestContext =
      ADS_QUESTION_CONTEXT_MARKERS.some((marker) => hasMarker(marker)) ||
      ADS_SEARCH_REQUEST_MARKERS.some((marker) => hasMarker(marker)) ||
      ADS_JOB_SEEKING_PATTERNS.some(
        ({ pattern }) => pattern.test(normalizedText) || pattern.test(rawLoweredText),
      ) ||
      ADS_SEARCH_REQUEST_PATTERNS.some(
        ({ pattern }) => pattern.test(normalizedText) || pattern.test(rawLoweredText),
      );
    const hasDealSignal =
      ADS_LINK_PATTERN.test(rawLoweredText) ||
      ADS_PHONE_PATTERN.test(rawLoweredText) ||
      ADS_PRICE_PATTERN.test(rawLoweredText) ||
      ADS_TRANSACTIONAL_PATTERN.test(normalizedText) ||
      hasIntentContext ||
      ADS_CONTACT_MARKERS.some((marker) => hasMarker(marker));
    const hasServiceCommercialContext =
      (hasServiceOfferContext && hasDealSignal) ||
      (hasServiceSpecialtyContext && hasDealSignal && !hasSearchRequestContext);
    const hasSelfPromotionalContext =
      hasIntentContext ||
      ADS_PROMO_MARKERS.some((marker) => hasMarker(marker)) ||
      ADS_BUYOUT_MARKERS.some((marker) => hasMarker(marker)) ||
      ADS_RECRUITMENT_MARKERS.some((marker) => hasMarker(marker)) ||
      ADS_INFO_PRODUCT_MARKERS.some((marker) => hasMarker(marker)) ||
      hasServiceOfferContext ||
      hasCallToActionContext ||
      hasGroupPromotionIntent ||
      hasCommercialAudienceContext;

    if (hasSearchRequestContext && !hasSelfPromotionalContext) {
      return false;
    }

    return (
      (hasCommercialContext ||
        hasServiceCommercialContext ||
        (hasGroupContext && hasDealSignal && hasGroupTradeContext && hasGroupPromotionIntent)) &&
      hasDealSignal &&
      !ADS_PRIVATE_CONTEXT_MARKERS.some((marker) => hasMarker(marker))
    );
  }

  private hasExplicitSelfPromotionalCommercialContext(state: CommercialSignalState): boolean {
    return (
      state.hasIntent ||
      state.hasPromoContext ||
      state.hasBuyoutContext ||
      state.hasRecruitmentContext ||
      state.hasInfoProductContext ||
      state.hasServiceOfferContext ||
      state.hasCallToActionContext ||
      state.hasGroupPromotionIntent ||
      state.hasCommercialAudienceContext
    );
  }

  private async detectDuplicateState(params: {
    chatId: string;
    userId: string;
    compactText: string;
    settings: ChatSettings;
  }): Promise<{
    hit?: DuplicateHit;
    decision?: DuplicateDecision;
  }> {
    const { chatId, userId, compactText, settings } = params;
    const hash = createHash('sha256').update(compactText).digest('hex').slice(0, 20);
    const flow = this.getDuplicateFlowConfig(settings);
    const flowKey = buildDuplicateStageKey(chatId, userId, hash, 'flow');
    const total = await this.redisCounter.incrementWithTtl(flowKey, flow.windowSec + 1);
    const repeatCount = Math.max(0, total - 1);

    if (repeatCount <= flow.allowedCount) {
      return {};
    }

    const hit: DuplicateHit = {
      count: repeatCount,
      windowSec: flow.windowSec,
      hash,
    };

    if (flow.reactions.length === 0) {
      return {};
    }

    const reactionIndex = Math.min(flow.reactions.length - 1, repeatCount - flow.allowedCount - 1);
    const reaction = flow.reactions[reactionIndex];

    if (!reaction || reaction.action === null) {
      return { hit };
    }

    return {
      hit,
      decision: {
        action: reaction.action,
        count: repeatCount,
        threshold: flow.allowedCount + reactionIndex + 1,
        windowSec: flow.windowSec,
        hash,
        nextAction: this.resolveNextDuplicateAction(flow.reactions, reactionIndex),
      },
    };
  }

  private getDuplicateFlowConfig(settings: ChatSettings): {
    allowedCount: number;
    windowSec: number;
    reactions: DuplicateReactionStage[];
  } {
    const firstThreshold = settings.duplicateWarnEnabled
      ? settings.duplicateWarnMaxCount
      : settings.duplicateMuteEnabled
        ? settings.duplicateMuteMaxCount
        : settings.duplicateBanEnabled
          ? settings.duplicateBanMaxCount
          : settings.duplicateWarnMaxCount;
    const windowSec = settings.duplicateWarnEnabled
      ? settings.duplicateWarnWindowSec
      : settings.duplicateMuteEnabled
        ? settings.duplicateMuteWindowSec
        : settings.duplicateBanEnabled
          ? settings.duplicateBanWindowSec
          : settings.duplicateWarnWindowSec;
    const allowedCount = Math.max(
      0,
      firstThreshold - (settings.duplicateBotMessageEnabled ? 2 : 1),
    );

    return {
      allowedCount,
      windowSec,
      reactions: this.getEnabledDuplicateReactions(settings),
    };
  }

  private getEnabledDuplicateReactions(settings: ChatSettings): DuplicateReactionStage[] {
    const reactions: DuplicateReactionStage[] = [];

    if (settings.duplicateBotMessageEnabled) {
      reactions.push({ action: null });
    }

    if (settings.duplicateWarnEnabled) {
      reactions.push({ action: 'WARN' });
    }

    if (settings.duplicateMuteEnabled) {
      reactions.push({ action: 'MUTE' });
    }

    if (settings.duplicateBanEnabled) {
      reactions.push({ action: 'BAN' });
    }

    return reactions;
  }

  private resolveNextDuplicateAction(
    reactions: DuplicateReactionStage[],
    currentIndex: number,
  ): DuplicateAction | null {
    for (let index = currentIndex + 1; index < reactions.length; index += 1) {
      const nextAction = reactions[index]?.action;
      if (nextAction) {
        return nextAction;
      }
    }

    return null;
  }

  private hasProfanity(text: string): boolean {
    const normalizedContext = this.normalizeForDetection(stripUrlsFromText(text));
    const candidates = this.extractProfanityCandidates(text);
    for (const candidate of candidates) {
      const normalizedCandidate = this.normalizeProfanityCandidate(candidate);
      if (
        normalizedCandidate &&
        !this.isProfanityException(normalizedCandidate) &&
        !this.isContextualProfanityException(normalizedCandidate, normalizedContext) &&
        (this.isProfanityToken(normalizedCandidate) || isExactProfanityVariant(normalizedCandidate))
      ) {
        return true;
      }

      const normalizedLatinCandidate = this.normalizeProfanityLatinCandidate(candidate);
      if (
        normalizedLatinCandidate &&
        PROFANITY_LATIN_TOKEN_PATTERNS.some((pattern) => pattern.test(normalizedLatinCandidate))
      ) {
        return true;
      }
    }

    return false;
  }

  private isProfanityToken(token: string): boolean {
    if (!token) {
      return false;
    }

    return PROFANITY_CORE_TOKEN_PATTERNS.some((pattern) => pattern.test(token));
  }

  private isProfanityException(token: string): boolean {
    return PROFANITY_EXCEPTIONS.some((exception) => token.startsWith(exception));
  }

  private isContextualProfanityException(token: string, normalizedContext: string): boolean {
    if (!normalizedContext || !PROFANITY_CANINE_FEMALE_FORMS.has(token)) {
      return false;
    }

    let matchedMarkers = 0;
    for (const marker of PROFANITY_CANINE_CONTEXT_MARKERS) {
      if (!normalizedContext.includes(marker)) {
        continue;
      }

      matchedMarkers += 1;
      if (matchedMarkers >= 2) {
        return true;
      }
    }

    return false;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private shouldTrackDuplicate(rawText: string, compactText: string): boolean {
    if (DUPLICATE_EXCLUDED_PHONE_PATTERN.test(rawText)) {
      return false;
    }
    const hasUrl = this.extractUrlsFromText(rawText).length > 0;

    const candidateText = hasUrl
      ? this.normalizeForDetection(stripUrlsFromText(rawText))
      : compactText;
    if (!candidateText) {
      return false;
    }

    const hasAdMarker =
      ADS_INTENT_MARKERS.some((marker) => candidateText.includes(marker)) ||
      ADS_CONTACT_MARKERS.some((marker) => candidateText.includes(marker)) ||
      ADS_PROMO_MARKERS.some((marker) => candidateText.includes(marker)) ||
      ADS_PRICE_PATTERN.test(candidateText) ||
      ADS_TRANSACTIONAL_PATTERN.test(candidateText);
    if (hasAdMarker) {
      return true;
    }

    const tokens = this.extractTokens(candidateText);
    if (tokens.length < DUPLICATE_MIN_TOKEN_COUNT || candidateText.length < DUPLICATE_MIN_LENGTH) {
      return false;
    }

    const uniqueLongTokens = new Set(tokens.filter((token) => token.length >= 4)).size;
    return uniqueLongTokens >= DUPLICATE_MIN_UNIQUE_LONG_TOKENS;
  }

  private hasBlockedLink(text: string, policy: LinkPolicy, allowlist: string[]): string | null {
    if (policy === LinkPolicy.ALERT_ONLY) {
      return null;
    }

    const links = this.extractUrlsFromText(text);

    if (links.length === 0) {
      return null;
    }

    if (policy === LinkPolicy.BLOCKLIST_ONLY) {
      return 'Links are not allowed by policy';
    }

    const matchers = this.buildAllowlistMatchers(allowlist);

    for (const link of links) {
      if (policy === LinkPolicy.ALLOWLIST_ONLY && !this.shouldCheckExactAllowlistLink(link)) {
        continue;
      }

      const linkMatch = this.resolveAllowlistMatch(link);
      if (!linkMatch) {
        continue;
      }

      if (!this.isAllowlistedLink(link, matchers, linkMatch)) {
        return `Link ${linkMatch.normalizedLink} is not in allowlist`;
      }
    }

    return null;
  }

  private buildAllowlistMatchers(allowlist: string[]): AllowlistMatchers {
    const exactLinks = new Set<string>();
    const domains = new Set<string>();

    for (const entry of allowlist) {
      const parsed = parseStoredAllowlistEntry(entry);
      if (!parsed) {
        continue;
      }

      if (parsed.matchType === 'DOMAIN') {
        domains.add(parsed.domain);
        continue;
      }

      exactLinks.add(parsed.domain);
    }

    return { exactLinks, domains };
  }

  private resolveAllowlistMatch(
    value: string,
  ): { normalizedLink: string; normalizedDomain: string | null } | null {
    const normalizedLink = normalizeAllowlistLink(value);
    if (!normalizedLink) {
      return null;
    }

    return {
      normalizedLink,
      normalizedDomain: normalizeAllowlistDomain(value),
    };
  }

  private isAllowlistedLink(
    value: string,
    matchers: AllowlistMatchers,
    resolvedMatch: { normalizedLink: string; normalizedDomain: string | null } | null = null,
  ): boolean {
    const match = resolvedMatch ?? this.resolveAllowlistMatch(value);
    if (!match) {
      return false;
    }

    if (matchers.exactLinks.has(match.normalizedLink)) {
      return true;
    }

    if (match.normalizedDomain && matchers.domains.has(match.normalizedDomain)) {
      return true;
    }

    return false;
  }

  private extractUrlsFromText(value: string): string[] {
    return extractTextUrls(value);
  }

  private shouldCheckExactAllowlistLink(value: string): boolean {
    const normalized = value.trim();
    if (!normalized) {
      return false;
    }

    if (/^https?:\/\//i.test(normalized)) {
      return true;
    }

    return /[/?#]/.test(normalized);
  }

  private detectCommercialAd(params: {
    normalizedText: string;
    rawLoweredText: string;
    settings: ChatSettings;
  }): CommercialDetection | null {
    const { normalizedText, rawLoweredText, settings } = params;

    if (!normalizedText || normalizedText.length < 6) {
      return null;
    }

    const appliedThresholds = this.resolveCommercialThresholds(settings);
    const state = this.collectCommercialSignals(normalizedText, rawLoweredText, appliedThresholds);
    if (state.matchedSignals.length === 0 || !state.hasCommercialContext || !state.hasDealSignal) {
      return null;
    }

    const hasStandardCommercialEvidence =
      state.hasPrice || state.hasContact || state.hasDealChannel || state.hasTransactional;
    const hasStrongCommercialEvidence =
      state.hasPrice || state.hasDealChannel || (state.hasContact && state.hasTransactional);
    const hasStructuredCommercialContext =
      state.hasPromoContext ||
      state.hasBusinessContext ||
      state.hasBuyoutContext ||
      state.hasRecruitmentContext ||
      state.hasInfoProductContext ||
      state.hasGroupPromoContext ||
      state.hasServiceContext;
    const hasSelfPromotionalCommercialContext =
      this.hasExplicitSelfPromotionalCommercialContext(state);

    if (state.hasPrivateSaleContext && !hasStructuredCommercialContext) {
      return null;
    }

    if (state.hasSearchRequestContext && !hasSelfPromotionalCommercialContext) {
      return null;
    }

    if (state.hasJobSeekingContext) {
      return null;
    }

    if (
      appliedThresholds.strictness < 0.35 &&
      !(hasStructuredCommercialContext && hasStrongCommercialEvidence)
    ) {
      return null;
    }

    if (
      appliedThresholds.strictness < 0.65 &&
      !(hasStructuredCommercialContext && hasStandardCommercialEvidence)
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

    if (confidenceScore < appliedThresholds.warnThreshold) {
      return null;
    }

    const decisionBand: CommercialDecisionBand =
      confidenceScore >= appliedThresholds.deleteThreshold
        ? 'HIGH'
        : confidenceScore >= appliedThresholds.warnThreshold
          ? 'MEDIUM'
          : 'LOW';

    return {
      confidenceScore,
      decisionBand,
      matchedSignals: state.matchedSignals,
      negativeSignals: state.negativeSignals,
      appliedThresholds,
    };
  }

  private resolveCommercialThresholds(settings: ChatSettings): {
    warnThreshold: number;
    deleteThreshold: number;
    sensitivity: 'BALANCED' | 'STRICT';
    strictness: number;
  } {
    const strict = settings.commercialAdsSensitivity === CommercialAdsSensitivity.STRICT;
    const warnBase = Number.isFinite(settings.commercialAdsWarnThreshold)
      ? settings.commercialAdsWarnThreshold
      : 45;
    const deleteBase = Number.isFinite(settings.commercialAdsDeleteThreshold)
      ? settings.commercialAdsDeleteThreshold
      : 65;
    const warnThreshold = Math.max(10, Math.min(90, warnBase));
    const deleteThreshold = Math.max(warnThreshold + 5, Math.min(100, deleteBase));
    const thresholdStrictness = ((60 - warnThreshold) / 22 + (82 - deleteThreshold) / 27) / 2;
    const strictness = Math.max(0, Math.min(1, thresholdStrictness + (strict ? 0.04 : -0.02)));

    return {
      warnThreshold,
      deleteThreshold,
      sensitivity: strict ? 'STRICT' : 'BALANCED',
      strictness,
    };
  }

  private detectTopicFilterMismatch(params: {
    rawText: string;
    measuredLength: number;
    settings: ChatSettings;
  }): TopicFilterDetection | null {
    const { rawText, measuredLength, settings } = params;
    const requiredCodeword = this.resolveRequiredThematicCodeword(settings);
    if (!requiredCodeword || measuredLength < THEMATIC_CODEWORD_MIN_LENGTH) {
      return null;
    }

    const messageFirstToken = this.extractFirstThematicCodewordToken(rawText);
    if (messageFirstToken === requiredCodeword) {
      return null;
    }

    return {
      mode: 'CODEWORD',
      messageLength: measuredLength,
      requiredCodeword,
      messageFirstToken,
    };
  }

  private resolveRequiredThematicCodeword(settings: ChatSettings): string | null {
    if (!settings.thematicCodewordEnabled) {
      return null;
    }

    return this.normalizeThematicCodeword(settings.thematicCodeword);
  }

  private normalizeThematicCodeword(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = this.normalizeMixedWriting(value.toLowerCase()).replace(/ё/g, 'е').trim();
    if (!normalized) {
      return null;
    }

    const parts = normalized.split(/\s+/u).filter(Boolean);
    if (parts.length !== 1) {
      return null;
    }

    const canonical = this.canonicalizeThematicCodewordToken(parts[0]);
    if (!canonical || canonical.length < 2 || canonical.length > 32) {
      return null;
    }

    return canonical;
  }

  private extractFirstThematicCodewordToken(value: string): string | null {
    if (!value) {
      return null;
    }

    const normalized = this.normalizeMixedWriting(value.toLowerCase()).replace(/ё/g, 'е');
    const match = normalized.match(/[\p{L}\p{N}]+(?:[_-][\p{L}\p{N}]+)*/u);
    if (!match) {
      return null;
    }

    return this.canonicalizeThematicCodewordToken(match[0]);
  }

  private canonicalizeThematicCodewordToken(value: string): string | null {
    const fragments = value.match(/[\p{L}\p{N}]+/gu);
    if (!fragments || fragments.length === 0) {
      return null;
    }

    return fragments.join('');
  }

  private collectCommercialSignals(
    normalizedText: string,
    rawLoweredText: string,
    profile: CommercialThresholdProfile,
  ): CommercialSignalState {
    const positiveFactor = 0.92 + profile.strictness * 0.28;
    const negativeFactor = 1.05 - profile.strictness * 0.2;

    let score = 0;
    const matchedSignals: string[] = [];
    const negativeSignals: string[] = [];

    const addPositive = (label: string, value: number) => {
      score += value * positiveFactor;
      matchedSignals.push(label);
    };
    const addNegative = (label: string, value: number, strong = false) => {
      score -= value * negativeFactor;
      negativeSignals.push(label);
      if (strong) {
        hasStrongNegativeContext = true;
      }
    };

    let hasIntent = false;
    let hasServiceOfferContext = false;
    let hasServiceSpecialtyContext = false;
    let hasPrice = false;
    let hasContact = false;
    let hasPhoneContact = false;
    let hasDealChannel = false;
    let hasTransactional = false;
    let hasDealSignal = false;
    let hasPromoContext = false;
    let hasBusinessContext = false;
    let hasBuyoutContext = false;
    let hasRecruitmentContext = false;
    let hasInfoProductContext = false;
    let hasGroupPromotionIntent = false;
    let hasGroupPromoContext = false;
    let hasSearchRequestContext = false;
    let hasJobSeekingContext = false;
    let hasServiceContext = false;
    let hasCallToActionContext = false;
    let hasCommercialContext = false;
    let hasPrivateSaleContext = false;
    let hasStrongNegativeContext = false;
    let hasGroupContext = false;
    let hasGroupTradeContext = false;
    let hasCommercialAudienceContext = false;

    const hasMarker = (marker: string): boolean =>
      normalizedText.includes(marker) || rawLoweredText.includes(marker);

    const intentHits = ADS_INTENT_MARKERS.filter((marker) => hasMarker(marker));
    for (const marker of intentHits.slice(0, 3)) {
      addPositive(`intent:${marker}`, 10);
      hasIntent = true;
      if (ADS_SERVICE_INTENT_MARKERS.has(marker)) {
        hasServiceOfferContext = true;
      }
      hasDealSignal = true;
    }

    const promoHits = ADS_PROMO_MARKERS.filter((marker) => hasMarker(marker));
    for (const marker of promoHits.slice(0, 3)) {
      addPositive(`promo:${marker}`, 12);
      hasPromoContext = true;
      hasCommercialContext = true;
    }

    const businessHits = ADS_BUSINESS_MARKERS.filter((marker) => hasMarker(marker));
    for (const marker of businessHits.slice(0, 2)) {
      addPositive(`business:${marker}`, 16);
      hasBusinessContext = true;
      hasCommercialContext = true;
    }

    const buyoutHits = ADS_BUYOUT_MARKERS.filter((marker) => hasMarker(marker));
    for (const marker of buyoutHits.slice(0, 2)) {
      addPositive(`buyout:${marker}`, 18);
      hasBuyoutContext = true;
      hasBusinessContext = true;
      hasCommercialContext = true;
    }

    const recruitmentHits = ADS_RECRUITMENT_MARKERS.filter((marker) => hasMarker(marker));
    for (const marker of recruitmentHits.slice(0, 2)) {
      addPositive(`recruitment:${marker}`, 14);
      hasRecruitmentContext = true;
      hasCommercialContext = true;
    }

    const infoProductHits = ADS_INFO_PRODUCT_MARKERS.filter((marker) => hasMarker(marker));
    for (const marker of infoProductHits.slice(0, 2)) {
      addPositive(`info:${marker}`, 12);
      hasInfoProductContext = true;
      hasCommercialContext = true;
    }

    const serviceSpecialtyHits = ADS_SERVICE_SPECIALTY_MARKERS.filter((marker) =>
      hasMarker(marker),
    );
    for (const marker of serviceSpecialtyHits.slice(0, 3)) {
      addPositive(`service-specialty:${marker}`, 8);
      hasServiceSpecialtyContext = true;
    }

    const groupContextHits = ADS_GROUP_CONTEXT_MARKERS.filter((marker) => hasMarker(marker));
    for (const marker of groupContextHits.slice(0, 2)) {
      addPositive(`group:${marker}`, 6);
      hasGroupContext = true;
    }

    const groupPromoHits = ADS_GROUP_PROMO_MARKERS.filter((marker) => hasMarker(marker));
    for (const marker of groupPromoHits.slice(0, 2)) {
      addPositive(`group-promo:${marker}`, 8);
      hasGroupContext = true;
      hasGroupPromotionIntent = true;
      hasCallToActionContext = true;
    }

    const groupSelfReferenceHits = ADS_GROUP_SELF_REFERENCE_MARKERS.filter((marker) =>
      hasMarker(marker),
    );
    for (const marker of groupSelfReferenceHits.slice(0, 2)) {
      addPositive(`group-self:${marker}`, 8);
      hasGroupContext = true;
      hasGroupPromotionIntent = true;
    }

    const groupTradeHits = ADS_GROUP_TRADE_MARKERS.filter((marker) => hasMarker(marker));
    for (const marker of groupTradeHits.slice(0, 3)) {
      addPositive(`group-trade:${marker}`, 8);
      hasGroupTradeContext = true;
    }

    const commercialAudienceHits = ADS_COMMERCIAL_AUDIENCE_MARKERS.filter((marker) =>
      hasMarker(marker),
    );
    for (const marker of commercialAudienceHits.slice(0, 2)) {
      addPositive(`audience:${marker}`, 12);
      hasCommercialAudienceContext = true;
      hasBusinessContext = true;
      hasCommercialContext = true;
    }

    const callToActionHits = ADS_CALL_TO_ACTION_MARKERS.filter((marker) => hasMarker(marker));
    for (const marker of callToActionHits.slice(0, 2)) {
      addPositive(`cta:${marker}`, 8);
      hasCallToActionContext = true;
    }

    if (ADS_PRICE_PATTERN.test(rawLoweredText) || ADS_PRICE_PATTERN.test(normalizedText)) {
      addPositive('transaction:price', 18);
      hasPrice = true;
      hasTransactional = true;
      hasDealSignal = true;
    }

    if (ADS_TRANSACTIONAL_PATTERN.test(normalizedText)) {
      addPositive('transaction:keywords', 8);
      hasTransactional = true;
      hasDealSignal = true;
    }

    const contactHits = ADS_CONTACT_MARKERS.filter((marker) => hasMarker(marker));
    for (const marker of contactHits.slice(0, 2)) {
      addPositive(`contact:${marker}`, 12);
      hasContact = true;
      hasDealSignal = true;
    }

    if (ADS_PHONE_PATTERN.test(rawLoweredText) || ADS_PHONE_PATTERN.test(normalizedText)) {
      addPositive('contact:phone', 14);
      hasContact = true;
      hasPhoneContact = true;
      hasDealSignal = true;
    }

    if (ADS_LINK_PATTERN.test(rawLoweredText)) {
      addPositive('deal-channel:link', 12);
      hasDealChannel = true;
      hasDealSignal = true;
    }

    if (ADS_MARKETPLACE_LINK_PATTERN.test(rawLoweredText)) {
      addNegative('private:marketplace-link', 10);
      hasPrivateSaleContext = true;
    }

    if (ADS_URGENCY_PATTERN.test(normalizedText)) {
      addPositive('booster:urgency', 6);
    }

    if (ADS_QUANTITY_PATTERN.test(normalizedText)) {
      addPositive('booster:quantity', 6);
    }

    for (const marker of ADS_NEGATIVE_MARKERS) {
      if (!hasMarker(marker)) {
        continue;
      }

      addNegative(`negative:${marker}`, 24, true);
    }

    for (const marker of ADS_QUESTION_CONTEXT_MARKERS) {
      if (!hasMarker(marker)) {
        continue;
      }

      addNegative(`context:${marker}`, 18, true);
      hasSearchRequestContext = true;
    }

    for (const marker of ADS_PRIVATE_CONTEXT_MARKERS) {
      if (!hasMarker(marker)) {
        continue;
      }

      addNegative(`private:${marker}`, 26, true);
      hasPrivateSaleContext = true;
    }

    for (const marker of ADS_SEARCH_REQUEST_MARKERS) {
      if (!hasMarker(marker)) {
        continue;
      }

      addNegative(`search:${marker}`, 20, true);
      hasSearchRequestContext = true;
    }

    for (const { label, pattern } of ADS_JOB_SEEKING_PATTERNS) {
      if (!(pattern.test(normalizedText) || pattern.test(rawLoweredText))) {
        continue;
      }

      addNegative(`job-seeking:${label}`, 26, true);
      hasJobSeekingContext = true;
      hasSearchRequestContext = true;
    }

    for (const { label, pattern } of ADS_SEARCH_REQUEST_PATTERNS) {
      if (!(pattern.test(normalizedText) || pattern.test(rawLoweredText))) {
        continue;
      }

      addNegative(`search-pattern:${label}`, 20, true);
      hasSearchRequestContext = true;
    }

    if (rawLoweredText.includes('?') && !hasPrice && !hasContact && !hasDealChannel) {
      addNegative('context:question', 10);
      hasSearchRequestContext = true;
    }

    if (hasIntent && (hasPrice || hasContact || hasDealChannel)) {
      addPositive('combo:intent+deal', 6);
    }

    const hasDirectDealEvidence =
      hasPhoneContact || hasContact || hasDealChannel || hasPrice || hasTransactional;

    if (hasBuyoutContext && hasDirectDealEvidence) {
      addPositive('combo:buyout+deal', 18);
      hasCommercialContext = true;
    }

    if (hasServiceOfferContext && hasDirectDealEvidence) {
      addPositive('combo:service-offer+deal', 16);
      hasServiceContext = true;
      hasCommercialContext = true;
    }

    if (hasServiceOfferContext && hasServiceSpecialtyContext) {
      addPositive('combo:service-offer+specialty', 8);
    }

    if (
      hasServiceSpecialtyContext &&
      (hasPhoneContact || hasContact || hasDealChannel) &&
      !hasSearchRequestContext
    ) {
      addPositive(
        profile.sensitivity === 'STRICT'
          ? 'combo:strict-service-specialty+deal'
          : 'combo:service-specialty+deal',
        profile.sensitivity === 'STRICT' ? 12 : 10,
      );
      hasServiceContext = true;
      hasCommercialContext = true;
    }

    if (
      profile.sensitivity === 'STRICT' &&
      hasIntent &&
      !hasSearchRequestContext &&
      (hasPhoneContact || hasPrice || hasTransactional || hasDealChannel)
    ) {
      addPositive('combo:strict-intent+direct-deal', 16);
      hasCommercialContext = true;
    }

    if (
      profile.sensitivity === 'STRICT' &&
      hasPhoneContact &&
      !hasSearchRequestContext &&
      (hasServiceSpecialtyContext ||
        hasPromoContext ||
        hasBusinessContext ||
        hasBuyoutContext ||
        hasRecruitmentContext ||
        hasInfoProductContext ||
        hasCallToActionContext)
    ) {
      addPositive('combo:strict-phone+self-promo', 18);
      hasCommercialContext = true;
      if (hasServiceSpecialtyContext) {
        hasServiceContext = true;
      }
    }

    if (
      hasGroupContext &&
      hasDealChannel &&
      hasGroupPromotionIntent &&
      (hasGroupTradeContext ||
        hasCommercialAudienceContext ||
        hasBusinessContext ||
        hasPromoContext)
    ) {
      addPositive('combo:group-promo+deal', 18);
      hasGroupPromoContext = true;
      hasCommercialContext = true;
    }

    if (hasPromoContext && (hasPrice || hasContact || hasDealChannel || hasTransactional)) {
      addPositive('combo:promo+deal', 18);
    }

    if (hasBusinessContext && (hasPrice || hasContact || hasDealChannel || hasTransactional)) {
      addPositive('combo:business+deal', 16);
    }

    if (hasRecruitmentContext && (hasContact || hasDealChannel || hasTransactional)) {
      addPositive('combo:recruitment+deal', 14);
    }

    if (
      hasInfoProductContext &&
      (hasContact || hasDealChannel || hasPrice || hasCallToActionContext)
    ) {
      addPositive('combo:info+deal', 14);
    }

    if (hasServiceContext && (hasContact || hasDealChannel || hasPrice || hasTransactional)) {
      addPositive('combo:service+deal', 12);
    }

    if (hasContact && hasPrice) {
      addPositive('combo:contact+price', 6);
    }

    return {
      score,
      matchedSignals: [...new Set(matchedSignals)],
      negativeSignals: [...new Set(negativeSignals)],
      hasIntent,
      hasServiceOfferContext,
      hasServiceSpecialtyContext,
      hasPrice,
      hasContact,
      hasPhoneContact,
      hasDealChannel,
      hasTransactional,
      hasDealSignal,
      hasPromoContext,
      hasBusinessContext,
      hasBuyoutContext,
      hasRecruitmentContext,
      hasInfoProductContext,
      hasGroupPromotionIntent,
      hasGroupPromoContext,
      hasCommercialAudienceContext,
      hasSearchRequestContext,
      hasJobSeekingContext,
      hasServiceContext,
      hasCallToActionContext,
      hasCommercialContext,
      hasPrivateSaleContext,
      hasStrongNegativeContext,
    };
  }

  private normalizeForDetection(value: string): string {
    if (!value) {
      return '';
    }

    let normalized = value.toLowerCase();
    normalized = this.normalizeMixedWriting(normalized);
    normalized = normalized.replace(/([a-zа-яё0-9])\1{2,}/giu, '$1$1');
    normalized = normalized.replace(/[_*~`"'«»“”(){}[[]\]|]+/g, ' ');
    normalized = normalized.replace(/[^\p{L}\p{N}\s:/?.,&%+-]/gu, ' ');
    normalized = normalized.replace(/\s+/g, ' ').trim();
    return normalized;
  }

  private extractProfanityCandidates(value: string): string[] {
    if (!value) {
      return [];
    }

    const stripped = stripUrlsFromText(value.toLowerCase());
    const segments = stripped
      .split(/\s+/u)
      .map((segment) => segment.trim())
      .filter(Boolean);
    const candidates = [...segments];

    for (let index = 0; index < segments.length; index += 1) {
      let joinedCandidate = '';
      let joinedCount = 0;

      for (
        let cursor = index;
        cursor < segments.length && cursor < index + PROFANITY_JOIN_WINDOW_TOKENS;
        cursor += 1
      ) {
        const normalizedToken = this.normalizeProfanityJoinToken(segments[cursor]);
        if (
          !normalizedToken ||
          (normalizedToken.length === 2 && !PROFANITY_SHORT_JOINABLE_TOKENS.has(normalizedToken))
        ) {
          break;
        }

        joinedCandidate += normalizedToken;
        joinedCount += 1;
        if (joinedCount >= 2) {
          candidates.push(joinedCandidate);
        }
      }
    }

    return candidates;
  }

  private normalizeProfanityCandidate(value: string): string {
    if (!value) {
      return '';
    }

    let normalized = value.toLowerCase();
    normalized = this.normalizeMixedWritingForProfanity(normalized);
    normalized = normalized.replace(/ё/g, 'е');
    normalized = normalized.replace(/([a-zа-я0-9])\1{2,}/giu, '$1$1');
    normalized = normalized.replace(/[_*~`"'«»“”(){}[[]\]|]+/g, '');
    normalized = normalized.replace(/[^\p{L}\p{N}]+/gu, '');
    return normalized;
  }

  private normalizeProfanityLatinCandidate(value: string): string {
    if (!value) {
      return '';
    }

    let normalized = value.toLowerCase();
    normalized = normalized.replace(/([a-z0-9])\1{2,}/g, '$1$1');
    normalized = normalized.replace(/[^a-z0-9]+/g, '');
    return normalized;
  }

  private normalizeProfanityJoinToken(value: string): string {
    const normalized = this.normalizeProfanityCandidate(value);
    return normalized.length <= 2 ? normalized : '';
  }

  private normalizeMixedWritingForProfanity(value: string): string {
    return value.replace(/[\p{L}\p{N}]+/gu, (token) => this.normalizeProfanityToken(token));
  }

  private normalizeProfanityToken(token: string): string {
    const lowered = token.toLowerCase();
    const hasCyrillic = /[а-яё]/iu.test(lowered);
    const hasLatin = /[a-z]/iu.test(lowered);
    const hasLetter = /[\p{L}]/u.test(token);
    let result = '';

    for (const char of lowered) {
      if (!hasLetter && /\p{N}/u.test(char)) {
        result += char;
        continue;
      }

      if (!hasCyrillic && hasLatin && /[a-z]/iu.test(char)) {
        result += char;
        continue;
      }

      result += MIXED_CHAR_MAP[char] ?? char;
    }

    return result;
  }

  private normalizeMixedWriting(value: string): string {
    let result = '';
    for (const char of value) {
      result += MIXED_CHAR_MAP[char] ?? char;
    }
    return result;
  }

  private logDuplicateStateTimeout(chatId: string, userId: string): void {
    const now = Date.now();
    if (now - this.duplicateTimeoutWarnAtMs < 30_000) {
      return;
    }

    this.duplicateTimeoutWarnAtMs = now;
    console.warn(
      JSON.stringify({
        level: 'warn',
        context: 'RuleEngineService',
        chatId,
        userId,
        timeoutMs: DUPLICATE_STATE_LOOKUP_TIMEOUT_MS,
        msg: 'Duplicate state lookup timed out; skipping duplicate enforcement in hot path',
      }),
    );
  }

  private extractTokens(value: string): string[] {
    const normalized = this.normalizeForDetection(value);
    return normalized.match(/[a-zа-яё0-9]+/giu) ?? [];
  }

  private detectMessageLimitsBlockedWord(
    text: string,
    blockedWords: readonly string[],
  ): BlockedWordDetection | null {
    if (!text || !Array.isArray(blockedWords) || blockedWords.length === 0) {
      return null;
    }

    const blockedWordList = this.resolveMessageLimitsBlockedWordList(blockedWords);
    if (blockedWordList.length === 0) {
      return null;
    }

    const normalizedText = this.normalizeMessageLimitsBlockedWordText(text);
    if (!normalizedText) {
      return null;
    }

    const compactText = normalizedText.replace(/[^\p{L}\p{N}]+/gu, '');
    const candidateBlockedWords = blockedWordList.filter((blockedWord) =>
      compactText.includes(blockedWord),
    );
    if (candidateBlockedWords.length === 0) {
      return null;
    }

    for (const blockedWord of candidateBlockedWords) {
      if (this.getMessageLimitsBlockedWordPattern(blockedWord).test(normalizedText)) {
        return {
          blockedWord,
        };
      }
    }

    return null;
  }

  private normalizeMessageLimitsBlockedWordText(value: string): string {
    if (!value) {
      return '';
    }

    let normalized = this.normalizeMixedWriting(value.toLowerCase()).replace(/ё/g, 'е');
    normalized = normalized.replace(/([a-zа-я0-9])\1{2,}/giu, '$1$1');
    return normalized;
  }

  private resolveMessageLimitsBlockedWordList(blockedWords: readonly string[]): readonly string[] {
    const cacheKey = this.buildBlockedWordListCacheKey(blockedWords);
    const cached = this.blockedWordListCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const resolved = [
      ...new Set(
        blockedWords
          .map((item) => this.normalizeMessageLimitsBlockedWordToken(item))
          .filter((item): item is string => Boolean(item)),
      ),
    ];
    this.blockedWordListCache.set(cacheKey, resolved);
    if (this.blockedWordListCache.size > BLOCKED_WORD_LIST_CACHE_MAX_ENTRIES) {
      const oldestKey = this.blockedWordListCache.keys().next().value;
      if (typeof oldestKey === 'string') {
        this.blockedWordListCache.delete(oldestKey);
      }
    }
    return resolved;
  }

  private buildBlockedWordListCacheKey(blockedWords: readonly string[]): string {
    return blockedWords.join('\u001f');
  }

  private getMessageLimitsBlockedWordPattern(value: string): RegExp {
    const cached = this.blockedWordPatternCache.get(value);
    if (cached) {
      return cached;
    }

    const pattern = this.buildMessageLimitsBlockedWordPattern(value);
    this.blockedWordPatternCache.set(value, pattern);
    return pattern;
  }

  private buildMessageLimitsBlockedWordPattern(value: string): RegExp {
    const joinerPattern = String.raw`[^\p{L}\p{N}]*`;
    const tokenPattern = [...value].map((char) => this.escapeRegExp(char)).join(joinerPattern);
    return new RegExp(String.raw`(?<![\p{L}\p{N}])${tokenPattern}(?![\p{L}\p{N}])`, 'iu');
  }

  private normalizeMessageLimitsBlockedWordToken(value: string): string | null {
    const candidate = normalizeMessageLimitsBlockedWordCandidate(value);
    return candidate ? this.normalizeMixedWriting(candidate) : null;
  }
}
