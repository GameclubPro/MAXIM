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
import type { CommercialCampaignContext } from './commercial-campaign.util';
import { buildDuplicateStageKey } from './duplicate-state';
import { isExactProfanityVariant } from './profanity-lexicon';
import { RedisCounterService } from './redis-counter.service';

export type CommercialDecisionBand = 'LOW' | 'MEDIUM' | 'HIGH';
export type CommercialSubtype =
  | 'CHANNEL_PLACEMENT'
  | 'PROPERTY_AGENT'
  | 'PROPERTY_COMMERCIAL'
  | 'RECRUITMENT'
  | 'INFO_PRODUCT'
  | 'BUYOUT'
  | 'SERVICES'
  | 'GOODS_RETAIL'
  | 'GOODS'
  | 'GROUP_PROMOTION'
  | 'GENERIC';

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
  primarySubtype: CommercialSubtype;
  supportingSubtypes: CommercialSubtype[];
  evidenceStrength: 'BORDERLINE' | 'STRUCTURED' | 'CAMPAIGN' | 'DIRECT';
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
};

type CommercialThresholdProfile = {
  warnThreshold: number;
  deleteThreshold: number;
  sensitivity: 'BALANCED' | 'STRICT';
  strictness: number;
};

type CommercialClassification = {
  primarySubtype: CommercialSubtype;
  supportingSubtypes: CommercialSubtype[];
  evidenceStrength: 'BORDERLINE' | 'STRUCTURED' | 'CAMPAIGN' | 'DIRECT';
  reviewRecommended: boolean;
  reviewReasons: string[];
};

type CommercialSecondStageDecision = {
  adjustedConfidenceScore: number;
  primarySubtype: CommercialSubtype;
  supportingSubtypes: CommercialSubtype[];
  reviewRecommended: boolean;
  reviewReasons: string[];
  classifierVersion: string;
  commercialProbability: number;
  reviewProbability: number;
  classifierReasons: string[];
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
  hasCampaignContext: boolean;
  hasPrivateSaleContext: boolean;
  hasPropertyPrivateContext: boolean;
  hasPropertyAgentContext: boolean;
  hasCommercialPropertyContext: boolean;
  hasGoodsRetailContext: boolean;
  hasPrivateGoodsItemContext: boolean;
  hasStrongNegativeContext: boolean;
};

type AllowlistMatchers = {
  exactLinks: Set<string>;
  domains: Set<string>;
};

type CommercialMarkerContext = {
  normalizedTextWithoutUrls: string;
  rawLoweredTextWithoutUrls: string;
  normalizedTokensWithoutUrls: string[];
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

type ResolvedBlockedWord = {
  blockedWord: string;
  inflectionRoot: string | null;
  prefilterToken: string;
};

type ResolvedBlockedWordTrieNode = {
  children: Map<string, ResolvedBlockedWordTrieNode>;
  terminalTokens?: string[];
};

type ResolvedBlockedWordIndex = {
  maxPrefilterTokenLength: number;
  prefilterRoot: ResolvedBlockedWordTrieNode;
  words: readonly ResolvedBlockedWord[];
  wordsByInflectionRoot: ReadonlyMap<string, readonly ResolvedBlockedWord[]>;
  wordsByPrefilterToken: ReadonlyMap<string, readonly ResolvedBlockedWord[]>;
};

const BLOCKED_WORD_LIST_CACHE_MAX_ENTRIES = 512;
const COMMERCIAL_SECOND_STAGE_VERSION = '2026-goods-hybrid-v1';
const COMMERCIAL_SECOND_STAGE_CACHE_MAX_ENTRIES = 4096;
const BLOCKED_WORD_CYRILLIC_INFLECTION_SUFFIXES = [
  'иями',
  'ями',
  'ами',
  'иях',
  'ях',
  'ах',
  'ого',
  'ему',
  'ому',
  'ыми',
  'ими',
  'его',
  'ией',
  'ою',
  'ею',
  'ую',
  'юю',
  'ая',
  'яя',
  'ое',
  'ее',
  'ые',
  'ие',
  'ий',
  'ый',
  'ой',
  'ов',
  'ев',
  'ей',
  'ам',
  'ям',
  'ом',
  'ем',
  'ым',
  'им',
  'ию',
  'ью',
  'ия',
  'ья',
  'а',
  'я',
  'у',
  'ю',
  'ы',
  'и',
  'ь',
  'й',
] as const;
const BLOCKED_WORD_LATIN_INFLECTION_SUFFIXES = [
  'ings',
  'ing',
  'ies',
  'ied',
  'ed',
  'es',
  's',
] as const;
const BLOCKED_WORD_CYRILLIC_MIN_ROOT_LENGTH = 3;
const BLOCKED_WORD_LATIN_MIN_ROOT_LENGTH = 4;

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
  /^жоп(?:а|ы|е|у|ой|ою|ам|ами|ах|н[а-я0-9]*)$/u,
  /^говн[а-я0-9]*$/u,
  /^дерьм[а-я0-9]*$/u,
  /^быдл[а-я0-9]*$/u,
  /^тупорыл[а-я0-9]*$/u,
  /^кончен[а-я0-9]*$/u,
];
const PROFANITY_LATIN_TOKEN_PATTERNS = [
  /^bl(?:ya|ia)(?:d|t)?[a-z0-9]*$/i,
  /^pizd[a-z0-9]*$/i,
  /^(?:na|po|do|o|za|ni|vy)?(?:h|x)(?:u|oo)(?:y|i|e|ya|yu)[a-z0-9]*$/i,
  /^(?:za|vy|na|po|do|pere|pro|ob|raz|pod|u)?e+b(?:a|o|i|y|e|u|l|n|t|s|k|sh|zh)[a-z0-9]*$/i,
  /^dolboe+b[a-z0-9]*$/i,
  /^mraz[a-z0-9]*$/i,
  /^shl?yuh[a-z0-9]*$/i,
  /^muda(?:k|ch)[a-z0-9]*$/i,
  /^mudil[a-z0-9]*$/i,
  /^ublyu?d[a-z0-9]*$/i,
  /^tvar(?:in)?[a-z0-9]*$/i,
  /^urod[a-z0-9]*$/i,
  /^zhop[a-z0-9]*$/i,
  /^govn[a-z0-9]*$/i,
  /^bydl[a-z0-9]*$/i,
  /^tuporyl[a-z0-9]*$/i,
  /^konchen[a-z0-9]*$/i,
];
const PROFANITY_CANINE_FEMALE_FORMS = new Set(['сука', 'суки', 'суке', 'суку', 'сукой', 'сукою']);
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
const PROFANITY_LIVESTOCK_FORMS = new Set([
  'скотина',
  'скотины',
  'скотине',
  'скотину',
  'скотиной',
  'скотиною',
  'скотинам',
  'скотинами',
  'скотинах',
]);
const PROFANITY_LIVESTOCK_CONTEXT_MARKERS = [
  'ферм',
  'крс',
  'коров',
  'быч',
  'телк',
  'телят',
  'овц',
  'коз',
  'свин',
  'стад',
  'пастбищ',
  'выпас',
  'хлев',
  'стойл',
  'хозяйств',
  'выращен',
  'откорм',
  'комбикорм',
  'надой',
];
const PROFANITY_PARASITE_FORMS = new Set(['гнида', 'гниды', 'гниде', 'гниду', 'гнидой', 'гнидою']);
const PROFANITY_PARASITE_CONTEXT_MARKERS = [
  'мошк',
  'комар',
  'укус',
  'укус',
  'насеком',
  'вош',
  'вши',
  'клещ',
  'паразит',
  'личин',
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
  'салон',
  'студия',
  'компания',
  'агентств',
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
];
const ADS_BUSINESS_PATTERNS: LabeledPattern[] = [
  {
    label: 'магазин',
    pattern: /(?:^|[^\p{L}\p{N}_-])интернет[\s-]*магазин(?=$|[^\p{L}\p{N}_-])/u,
  },
  {
    label: 'магазин',
    pattern: /(?:^|[^\p{L}\p{N}_-])магазин(?:[\s"«][\p{L}\p{N}]|-[\p{L}\p{N}])/u,
  },
  {
    label: 'магазин',
    pattern: /(?:^|[^\p{L}\p{N}_-])в\s+магазин[\p{L}\p{N}\s"«»_-]{0,40}привез/u,
  },
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
  'сотрудничеств',
  'смена',
  'отклик',
];
const ADS_RECRUITMENT_PATTERNS: LabeledPattern[] = [
  {
    label: 'требуется',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])треб(?:уется|уются|ует|уют)\s+(?:менеджер|сотрудник|работник|специалист|мастер|бригада|подрядчик|водитель|курьер|продавец|оператор|администратор|охранник|грузчик|разнорабоч[\p{L}\p{N}_-]*|нян[\p{L}\p{N}_-]*|сиделк[\p{L}\p{N}_-]*|повар[\p{L}\p{N}_-]*|шве[\p{L}\p{N}_-]*|парикмах[\p{L}\p{N}_-]*|маркетолог[\p{L}\p{N}_-]*|копирайтер[\p{L}\p{N}_-]*|бухгалтер[\p{L}\p{N}_-]*|юрист[\p{L}\p{N}_-]*|риелтор[\p{L}\p{N}_-]*|сварщик[\p{L}\p{N}_-]*|монтажник[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/u,
  },
  {
    label: 'набор',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:вед[её]т(?:ся)?\s+)?набор\s+(?:сотрудник[\p{L}\p{N}_-]*|персонал[\p{L}\p{N}_-]*|люд[\p{L}\p{N}_-]*|команд[\p{L}\p{N}_-]*|мастер[\p{L}\p{N}_-]*|водител[\p{L}\p{N}_-]*|курьер[\p{L}\p{N}_-]*|оператор[\p{L}\p{N}_-]*|охранник[\p{L}\p{N}_-]*|грузчик[\p{L}\p{N}_-]*|администратор[\p{L}\p{N}_-]*|менеджер[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/u,
  },
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
  'объявления',
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
const ADS_CHANNEL_PLACEMENT_MARKERS = [
  'каналы на трафике',
  'перелива нет',
  'мца',
  'жца',
  'сца',
  'места на завтра',
  'места на ближайшие дни',
  'свободные места',
  'продаю места',
  'цена за пост',
  'активная аудитория',
  'свежая активная аудитория',
  'рассмотрю вп',
  'max-tracker',
] as const;
const ADS_CHANNEL_PLACEMENT_PATTERNS: LabeledPattern[] = [
  {
    label: '1/48',
    pattern: /(?:^|[^\d])1\s*\/\s*(?:24|48|72)(?=$|[^\d])/u,
  },
  {
    label: 'er24',
    pattern: /(?:^|[^\p{L}\p{N}_-])er(?:24|48|72)(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    label: 'просмотры',
    pattern: /(?:^|[^\p{L}\p{N}_-])просмотр(?:ы|ов)?(?=$|[^\p{L}\p{N}_-])/u,
  },
  {
    label: 'цена-за-пост',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:цена\s+за\s+пост|продаю\s+места|места\s+на\s+(?:завтра|ближайшие\s+дни)|отдам\s+по\s+\d+)(?=$|[^\p{L}\p{N}_-])/iu,
  },
];
const ADS_CONTACT_MARKERS = [
  'пишите в лс',
  'пишите в лич',
  'пишите в личные сообщения',
  'в лс',
  'в личк',
  'в личные сообщения',
  'личные сообщения',
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
    label: 'request:who-repairs',
    pattern: /(?:^|[^\p{L}\p{N}_-])кто\s+(?:ремонтиру(?:ет|ют)|чинит)(?=$|[^\p{L}\p{N}_-])/u,
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
const ADS_SERVICE_OFFER_PATTERNS: LabeledPattern[] = [
  {
    label: 'кому нужно сделать',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])кому\s+нужно\s+(?:сделать|изготовить|построить|отремонтировать|починить|пробурить|сварить|сшить|связать|нарисовать|собрать)(?=$|[^\p{L}\p{N}_-])/u,
  },
  {
    label: 'сделаю',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:сделаю|изготовлю|построю|отремонтирую|починю|пробурю|сварю|сошью|свяжу|соберу)(?=$|[^\p{L}\p{N}_-])/u,
  },
];
const ADS_SERVICE_SPECIALTY_PATTERNS: LabeledPattern[] = [
  {
    label: 'подъем-домов',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])под[ъь]?ем(?:[\p{L}\p{N}\s.,:;()/-]{0,24})(?:дом[\p{L}\p{N}_-]*|бан[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    label: 'замена-венцов',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])замен(?:а|им|ю|ить)(?:[\p{L}\p{N}\s.,:;()/-]{0,18})нижн(?:их|его)(?:[\p{L}\p{N}\s.,:;()/-]{0,12})венц(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    label: 'ремонт-фундаментов',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:устройств[\p{L}\p{N}_-]*|ремонт[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;()/-]{0,14})фундамент[\p{L}\p{N}_-]*(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    label: 'строительство-пристроек',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])строительств[\p{L}\p{N}_-]*(?:[\p{L}\p{N}\s.,:;()/-]{0,20})(?:беседк[\p{L}\p{N}_-]*|террас[\p{L}\p{N}_-]*|веранд[\p{L}\p{N}_-]*|пристро[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu,
  },
];
const ADS_GOODS_RETAIL_PATTERNS: LabeledPattern[] = [
  {
    label: 'sizes-and-colors',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:разн(?:ые|ых)\s+(?:размер(?:ы)?|цвет(?:а)?|модел[\p{L}\p{N}_-]*)|размер(?:ы)?\s+и\s+цвет(?:а)?|материал[\p{L}\p{N}\s.,:;()/-]{0,18}на\s+выбор)(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    label: 'catalog-media',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:скину|отправлю)(?:[\p{L}\p{N}\s.,:;()/-]{0,18})(?:фото|видео|каталог)(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    label: 'manufacturer',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:от\s+производител[\p{L}\p{N}_-]*|от\s+завода)(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    label: 'commercial-use',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:для\s+улицы\s+и\s+помещений|до\s+вашего\s+офиса|для\s+офиса)(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    label: 'order-flow',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:под\s+заказ|по\s+заказу|оформить\s+заказ|оформляйте\s+заказ|оптом\s+и\s+в\s+розницу|доставка\s+по\s+(?:городу|региону|россии)|со\s+склада)(?=$|[^\p{L}\p{N}_-])/iu,
  },
];
const ADS_PRIVATE_GOODS_PATTERNS: LabeledPattern[] = [
  {
    label: 'apparel-size',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:бомбер|куртк[\p{L}\p{N}_-]*|пальт[\p{L}\p{N}_-]*|плать[\p{L}\p{N}_-]*|юбк[\p{L}\p{N}_-]*|джинс[\p{L}\p{N}_-]*|брюк[\p{L}\p{N}_-]*|кофт[\p{L}\p{N}_-]*|свитер[\p{L}\p{N}_-]*|худи|футболк[\p{L}\p{N}_-]*|кроссовк[\p{L}\p{N}_-]*|ботинк[\p{L}\p{N}_-]*|сапог[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;()/-]{0,70})(?:размер|маломерит|замер)(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    label: 'measurements',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:подробн(?:ые|ых)?\s+замер[\p{L}\p{N}_-]*|замеры\s+могу\s+отправить|доставка\s+до\s+подъезда)(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    label: 'resale-condition',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:в\s+отличном\s+состоянии|без\s+дефект[\p{L}\p{N}_-]*|носил[аи]?|одевал[аи]?|надевал[аи]?|после\s+одного\s+раза|почти\s+нов[\p{L}\p{N}_-]*|не\s+подошл[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu,
  },
];
const ADS_PROPERTY_PRIVATE_PATTERNS: LabeledPattern[] = [
  {
    label: 'property-sale',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:прода(?:м|ется|ётся)|сда(?:м|ется|ётся)|аренда|ипотек[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;()/-]{0,80})(?:квартир[\p{L}\p{N}_-]*|дом[\p{L}\p{N}_-]*|участ[\p{L}\p{N}_-]*|студи[\p{L}\p{N}_-]*|комнат[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/u,
  },
  {
    label: 'property-listing',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:квартир[\p{L}\p{N}_-]*|кв\.?|студи[\p{L}\p{N}_-]*|комнат[\p{L}\p{N}_-]*|\d+\s*к\.?\s*кв\.?)(?:[\p{L}\p{N}\s.,:;()/-]{0,100})(?:этаж|балкон|лоджи|сануз|ипотек|собственник|жк|дкп|обремен|ремонт|мебел[\p{L}\p{N}_-]*|техник[\p{L}\p{N}_-]*|цена)(?=$|[^\p{L}\p{N}_-])/u,
  },
];
const ADS_PROPERTY_CONTEXT_PATTERNS: LabeledPattern[] = [
  {
    label: 'property-jk',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])жк(?:[\p{L}\p{N}\s.,:;()/-]{0,100})(?:квартир[\p{L}\p{N}_-]*|студи[\p{L}\p{N}_-]*|к\.?\s*кв\.?|евро\s*\d+\s*к|этаж|м2|м²|цена|ремонт|дкп|обремен|ключ)(?=$|[^\p{L}\p{N}_-])/u,
  },
  {
    label: 'property-apartment-type',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:однушк[\p{L}\p{N}_-]*|двушк[\p{L}\p{N}_-]*|тр[её]шк[\p{L}\p{N}_-]*|евро\s*\d+\s*к|\d+\s*к\.?\s*кв\.?|студи(?:я|и))(?:(?:[\p{L}\p{N}\s.,:;()/-]{0,90})(?:этаж|м2|м²|балкон|жк|ремонт|мебел[\p{L}\p{N}_-]*|техник[\p{L}\p{N}_-]*|дкп|обремен|ипотек|цена|ключ))(?=$|[^\p{L}\p{N}_-])/u,
  },
  {
    label: 'property-land',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:ижс|днт|снт|з\/у|участок|земельный\s+участок)(?:[\p{L}\p{N}\s.,:;()/-]{0,80})(?:сот|дом|цена|продам|продаю|комисси|тел\.?|телефон|ремонт)(?=$|[^\p{L}\p{N}_-])/u,
  },
  {
    label: 'property-house-specs',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:дом|коттедж|таунхаус)(?:[\p{L}\p{N}\s.,:;()/-]{0,120})(?:участ(?:ок)?|сот|ипотек|септик|скважин|газ(?:\s+по\s+меже)?|свет|цена)(?=$|[^\p{L}\p{N}_-])/u,
  },
];
const ADS_PROPERTY_COMMERCIAL_PATTERNS: LabeledPattern[] = [
  {
    label: 'commercial-space',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:коммерци[\p{L}\p{N}_-]*|нежил[\p{L}\p{N}_-]*|(?:продажа|продам|продается|продаётся|аренда|сдам)(?:[\p{L}\p{N}\s.,:;()/-]{0,36})помещени[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu,
  },
  {
    label: 'street-traffic',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:вход\s+с\s+улицы|хороший\s+трафик|фасадн[\p{L}\p{N}_-]*\s+окн[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu,
  },
];
const ADS_PROPERTY_AGENT_PATTERNS: LabeledPattern[] = [
  {
    label: 'комиссия-сверху',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:(?:ваша|ваши)\s+комисси[\p{L}\p{N}\s.,:;/-]{0,10}сверх(?:у|ом)?|(?:ваша|ваши)\s+сверх(?:у|ом)?)(?=$|[^\p{L}\p{N}_-])/u,
  },
  {
    label: 'комиссия-обсуждается',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])комисси[\p{L}\p{N}\s.,:;/-]{0,14}обсуждаем(?=$|[^\p{L}\p{N}_-])/u,
  },
  {
    label: 'на-ключах',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:на\s+ключах|квартира\s+на\s+ключах|объект\s+на\s+ключах)(?=$|[^\p{L}\p{N}_-])/u,
  },
  {
    label: 'показ-247',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])показ(?:[\p{L}\p{N}\s.,:;/-]{0,14})(?:24\s*\/\s*7|в\s+любое\s+время)(?=$|[^\p{L}\p{N}_-])/u,
  },
  {
    label: 'прайс-по-запросу',
    pattern:
      /(?:^|[^\p{L}\p{N}_-])(?:прайс|фото|видео|планировк[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;/-]{0,18})по\s+запрос(?=$|[^\p{L}\p{N}_-])/u,
  },
  {
    label: 'эксклюзив',
    pattern: /(?:^|[^\p{L}\p{N}_-])эксклюзив(?=$|[^\p{L}\p{N}_-])/u,
  },
];
const PROPERTY_LISTING_NOISE_SERVICE_SPECIALTY_MARKERS = new Set([
  'ремонт',
  'сантехник',
  'сборк',
  'установк',
  'септик',
]);
const PROPERTY_LISTING_NOISE_BUSINESS_MARKERS = new Set(['магазин', 'студия']);
const ADS_SPECIAL_TOKEN_MATCHERS = new Map<string, RegExp>([
  ['чат', /^чат(?:ы|а|у|е|ом|ов|ам|ами|ах)?$/u],
  ['канал', /^канал(?:ы|а|у|е|ом|ов|ам|ами|ах)?$/u],
  ['клуб', /^клуб(?:ы|а|у|е|ом|ов|ам|ами|ах)?$/u],
  ['вп', /^вп$/u],
  ['озон', /^озон$/u],
  ['ozon', /^ozon$/u],
  ['wb', /^wb$/u],
]);
const ADS_LINK_PATTERN =
  /(https?:\/\/|t\.me\/|max\.ru\/|vk\.com\/|wa\.me\/|taplink|wildberries|wb\.ru|ozon\.ru|market\.yandex)/iu;
const ADS_MARKETPLACE_LINK_PATTERN = /(avito|youla)/iu;
const ADS_PRICE_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])\d{2,}\s?(?:₽|руб(?:\.|лей)?|р\.?|₸|\$|€)(?=$|[^\p{L}\p{N}_-])/iu;
const ADS_PRICE_CAPTURE_GLOBAL_PATTERN = /\d{2,}\s?(?:₽|руб(?:\.|лей)?|р\.?|₸|\$|€)/giu;
const ADS_MULTI_SKU_PRICE_LINE_PATTERN =
  /(?:^|[,.;\n])\s*(?:[^\s][\p{L}\p{N}\s()/"'#+-]{0,36})?(?:на\s+\d{1,2}(?:[.,]\d)?)?\s*[-:–]\s*\d{2,}\s?(?:₽|руб(?:\.|лей)?|р\.?|₸|\$|€)/giu;
const ADS_GOODS_VARIANT_MARKER_GLOBAL_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:на\s+\d{1,2}(?:[.,]\d)?|размер(?:ы)?\s*\d{1,2}(?:\s*[/,-]\s*\d{1,2})*|\d{1,2}\s*дюйм(?:а|ов)?|цвет(?:а)?\s+на\s+выбор)(?=$|[^\p{L}\p{N}_-])/giu;
const ADS_GOODS_FRESH_STOCK_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:в\s+продаже|нов(?:ый|ые|ая|ое)|поступлени[\p{L}\p{N}_-]*|остатк[\p{L}\p{N}_-]*|по\s+наличию)(?=$|[^\p{L}\p{N}_-])/iu;
const ADS_PERSONAL_RESALE_STRONG_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:б\/у|бу|в\s+отличном\s+состоянии|в\s+хорошем\s+состоянии|без\s+дефект[\p{L}\p{N}_-]*|после\s+одного\s+(?:ребенка|ребёнка|сезона)|носил[аи]?|одевал[аи]?|надевал[аи]?|не\s+подошл[\p{L}\p{N}_-]*|торг\s+уместен)(?=$|[^\p{L}\p{N}_-])/iu;
const ADS_TRANSACTIONAL_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:цена|цены|стоимость|оплата|предоплата|доставка|в наличии)(?=$|[^\p{L}\p{N}_-])/iu;
const ADS_PROPERTY_UTILITY_PAYMENT_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])ком(?:мунальн(?:ые|ых|ым|ыми))?(?:\s*|\.)услуг[\p{L}\p{N}_-]*(?=$|[^\p{L}\p{N}_-])/iu;
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
const PROFANITY_AMBIGUOUS_MIXED_CHAR_MAP: Record<string, string> = {
  ...MIXED_CHAR_MAP,
  '!': 'и',
  '|': 'и',
  '@': 'я',
  '9': 'я',
  u: 'и',
  y: 'я',
};
const PROFANITY_LATIN_LEET_CHAR_MAP: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '!': 'i',
  '|': 'i',
  '3': 'e',
  '4': 'a',
  '@': 'a',
  '5': 's',
  $: 's',
  '6': 'b',
  '7': 't',
  '8': 'b',
  '9': 'g',
};

@Injectable()
export class RuleEngineService {
  private duplicateTimeoutWarnAtMs = 0;
  private readonly blockedWordListCache = new Map<string, ResolvedBlockedWordIndex>();
  private readonly blockedWordPatternCache = new Map<string, RegExp>();
  private readonly commercialSecondStageCache = new Map<string, CommercialSecondStageDecision>();

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
    commercialCampaignContext?: CommercialCampaignContext | null;
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
      commercialCampaignContext,
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
        commercialCampaignContext,
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
            primarySubtype: commercial.primarySubtype,
            supportingSubtypes: commercial.supportingSubtypes,
            evidenceStrength: commercial.evidenceStrength,
            reviewRecommended: commercial.reviewRecommended,
            reviewReasons: commercial.reviewReasons,
            classifierVersion: commercial.classifierVersion,
            commercialProbability: commercial.commercialProbability,
            reviewProbability: commercial.reviewProbability,
            classifierReasons: commercial.classifierReasons,
            ...(commercial.campaignContext ? { campaignContext: commercial.campaignContext } : {}),
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

    if (violations.length === 0 && !duplicateState?.hit && !duplicateState?.decision) {
      if (hasPhotoAttachment && settings.photoMessageCooldownEnabled) {
        const cooldownSec = settings.photoMessageCooldownHours * 60 * 60;
        const key = this.buildMediaCooldownKey(
          'photo',
          chatId,
          userId,
          settings.photoMessageCooldownHours,
          settings.updatedAt,
        );
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
        const key = this.buildMediaCooldownKey(
          'sticker',
          chatId,
          userId,
          settings.stickerMessageCooldownMinutes,
          settings.updatedAt,
        );
        const count = await this.redisCounter.incrementWithTtl(key, cooldownSec + 1);
        if (count > 1) {
          violations.push({
            ruleCode: 'STICKER_RATE_LIMIT',
            score: 0.86,
            reason: `Stickers are limited to one per ${settings.stickerMessageCooldownMinutes}m`,
          });
        }
      }
    }

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

  private buildMediaCooldownKey(
    mediaKind: 'photo' | 'sticker',
    chatId: string,
    userId: string,
    windowValue: number,
    settingsUpdatedAt: Date | string,
  ): string {
    return `${mediaKind}:cooldown:v2:${chatId}:${userId}:${windowValue}:${this.normalizeSettingsUpdatedAt(settingsUpdatedAt)}`;
  }

  private normalizeSettingsUpdatedAt(value: Date | string): string {
    if (value instanceof Date) {
      const timestamp = value.getTime();
      return Number.isFinite(timestamp) ? String(timestamp) : 'na';
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? String(parsed) : 'na';
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

    const markerContext = this.buildCommercialMarkerContext(normalizedText, rawLoweredText);
    const hasMarker = (marker: string): boolean => this.hasCommercialMarker(marker, markerContext);
    const matchesPattern = (pattern: RegExp): boolean =>
      this.matchesCommercialPattern(pattern, markerContext);
    const hasUtilityPaymentContext =
      ADS_PROPERTY_UTILITY_PAYMENT_PATTERN.test(normalizedText) ||
      ADS_PROPERTY_UTILITY_PAYMENT_PATTERN.test(rawLoweredText);
    const hasPropertyPrivateContext =
      ADS_PROPERTY_PRIVATE_PATTERNS.some(({ pattern }) => matchesPattern(pattern)) ||
      ADS_PROPERTY_CONTEXT_PATTERNS.some(({ pattern }) => matchesPattern(pattern));
    const hasPropertyAgentContext = ADS_PROPERTY_AGENT_PATTERNS.some(({ pattern }) =>
      matchesPattern(pattern),
    );
    const hasCommercialPropertyContext = ADS_PROPERTY_COMMERCIAL_PATTERNS.some(({ pattern }) =>
      matchesPattern(pattern),
    );

    const hasPromoContext = ADS_PROMO_MARKERS.some((marker) => hasMarker(marker));
    const hasBuyoutContext = ADS_BUYOUT_MARKERS.some((marker) => hasMarker(marker));
    const hasRecruitmentContext =
      ADS_RECRUITMENT_MARKERS.some((marker) => hasMarker(marker)) ||
      ADS_RECRUITMENT_PATTERNS.some(({ pattern }) => matchesPattern(pattern));
    const hasInfoProductContext = ADS_INFO_PRODUCT_MARKERS.some((marker) => hasMarker(marker));
    const hasBusinessContext =
      ADS_BUSINESS_MARKERS.some(
        (marker) =>
          !(hasPropertyPrivateContext && PROPERTY_LISTING_NOISE_BUSINESS_MARKERS.has(marker)) &&
          hasMarker(marker),
      ) || ADS_BUSINESS_PATTERNS.some(({ pattern }) => matchesPattern(pattern));
    const hasCommercialContext =
      hasPromoContext ||
      hasBusinessContext ||
      hasBuyoutContext ||
      hasRecruitmentContext ||
      hasInfoProductContext ||
      hasPropertyAgentContext;
    const hasIntentContext = ADS_INTENT_MARKERS.some(
      (marker) =>
        !(
          hasPropertyPrivateContext &&
          hasUtilityPaymentContext &&
          ADS_SERVICE_INTENT_MARKERS.has(marker)
        ) && hasMarker(marker),
    );
    const hasServiceOfferContext =
      [...ADS_SERVICE_INTENT_MARKERS].some(
        (marker) =>
          !(
            hasPropertyPrivateContext &&
            hasUtilityPaymentContext &&
            ADS_SERVICE_INTENT_MARKERS.has(marker)
          ) && hasMarker(marker),
      ) || ADS_SERVICE_OFFER_PATTERNS.some(({ pattern }) => matchesPattern(pattern));
    const hasServiceSpecialtyContext =
      ADS_SERVICE_SPECIALTY_MARKERS.some(
        (marker) =>
          !(
            hasPropertyPrivateContext &&
            !hasServiceOfferContext &&
            PROPERTY_LISTING_NOISE_SERVICE_SPECIALTY_MARKERS.has(marker)
          ) && hasMarker(marker),
      ) || ADS_SERVICE_SPECIALTY_PATTERNS.some(({ pattern }) => matchesPattern(pattern));
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
    const hasChannelPlacementContext =
      ADS_CHANNEL_PLACEMENT_MARKERS.some((marker) => hasMarker(marker)) ||
      ADS_CHANNEL_PLACEMENT_PATTERNS.some(({ pattern }) => matchesPattern(pattern));
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
    const hasGoodsRetailContext =
      ADS_GOODS_RETAIL_PATTERNS.some(({ pattern }) => matchesPattern(pattern)) ||
      (!hasPropertyPrivateContext &&
        (hasPromoContext || hasBusinessContext) &&
        (hasMarker('в наличии') ||
          hasMarker('каталог') ||
          hasMarker('ассортимент') ||
          hasMarker('заказывайте')));
    const hasPrivateGoodsItemContext = ADS_PRIVATE_GOODS_PATTERNS.some(({ pattern }) =>
      matchesPattern(pattern),
    );
    const hasPropertyServiceCommercialOverride =
      hasServiceCommercialContext && (!hasPropertyPrivateContext || hasServiceOfferContext);
    const hasPrivateSaleCommercialOverride =
      hasPropertyAgentContext ||
      hasCommercialPropertyContext ||
      hasBusinessContext ||
      hasCommercialAudienceContext ||
      hasChannelPlacementContext ||
      hasBuyoutContext ||
      hasRecruitmentContext ||
      hasInfoProductContext ||
      hasPropertyServiceCommercialOverride ||
      hasGoodsRetailContext;
    const hasPrivateContextMarker = ADS_PRIVATE_CONTEXT_MARKERS.some((marker) => hasMarker(marker));
    const hasSelfPromotionalContext =
      hasIntentContext ||
      hasPromoContext ||
      hasBuyoutContext ||
      hasRecruitmentContext ||
      hasInfoProductContext ||
      hasServiceOfferContext ||
      hasServiceCommercialContext ||
      hasGoodsRetailContext ||
      hasCallToActionContext ||
      hasGroupPromotionIntent ||
      hasCommercialAudienceContext ||
      hasChannelPlacementContext ||
      hasPropertyAgentContext ||
      hasCommercialPropertyContext;

    if (hasSearchRequestContext && !hasSelfPromotionalContext) {
      return false;
    }

    if (
      hasPrivateGoodsItemContext &&
      !hasGoodsRetailContext &&
      !hasBusinessContext &&
      !hasChannelPlacementContext &&
      !hasServiceCommercialContext &&
      !ADS_LINK_PATTERN.test(rawLoweredText)
    ) {
      return false;
    }

    return (
      (hasCommercialContext ||
        hasCommercialPropertyContext ||
        hasGoodsRetailContext ||
        hasChannelPlacementContext ||
        hasServiceCommercialContext ||
        (hasGroupContext && hasDealSignal && hasGroupTradeContext && hasGroupPromotionIntent)) &&
      hasDealSignal &&
      !(hasPropertyPrivateContext && !hasPrivateSaleCommercialOverride) &&
      !(hasPrivateContextMarker && !hasPrivateSaleCommercialOverride)
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
      state.hasServiceContext ||
      state.hasCallToActionContext ||
      state.hasGroupPromotionIntent ||
      state.hasCommercialAudienceContext ||
      state.hasPropertyAgentContext ||
      state.hasCommercialPropertyContext ||
      state.hasGoodsRetailContext
    );
  }

  private buildCommercialMarkerContext(
    normalizedText: string,
    rawLoweredText: string,
  ): CommercialMarkerContext {
    const rawLoweredTextWithoutUrls = stripUrlsFromText(rawLoweredText);
    const normalizedTextWithoutUrls =
      rawLoweredTextWithoutUrls === rawLoweredText
        ? normalizedText
        : this.normalizeForDetection(rawLoweredTextWithoutUrls);

    return {
      normalizedTextWithoutUrls,
      rawLoweredTextWithoutUrls,
      normalizedTokensWithoutUrls: normalizedTextWithoutUrls.match(/[\p{L}\p{N}]+/gu) ?? [],
    };
  }

  private hasCommercialMarker(marker: string, context: CommercialMarkerContext): boolean {
    const normalizedMarker = this.normalizeForDetection(marker);
    if (!normalizedMarker) {
      return false;
    }

    const specialTokenMatcher = ADS_SPECIAL_TOKEN_MATCHERS.get(normalizedMarker);
    if (specialTokenMatcher) {
      return context.normalizedTokensWithoutUrls.some((token) => specialTokenMatcher.test(token));
    }

    if (/^[\p{L}\p{N}]+$/u.test(normalizedMarker)) {
      return context.normalizedTokensWithoutUrls.some((token) =>
        token.startsWith(normalizedMarker),
      );
    }

    return (
      context.normalizedTextWithoutUrls.includes(normalizedMarker) ||
      context.rawLoweredTextWithoutUrls.includes(marker.toLowerCase())
    );
  }

  private matchesCommercialPattern(pattern: RegExp, context: CommercialMarkerContext): boolean {
    return (
      pattern.test(context.normalizedTextWithoutUrls) ||
      pattern.test(context.rawLoweredTextWithoutUrls)
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
      for (const normalizedCandidate of this.buildProfanityCyrillicCandidates(candidate)) {
        if (
          normalizedCandidate &&
          !this.isProfanityException(normalizedCandidate) &&
          !this.isContextualProfanityException(normalizedCandidate, normalizedContext) &&
          (this.isProfanityToken(normalizedCandidate) ||
            isExactProfanityVariant(normalizedCandidate))
        ) {
          return true;
        }
      }

      for (const normalizedLatinCandidate of this.buildProfanityLatinCandidates(candidate)) {
        if (
          normalizedLatinCandidate &&
          PROFANITY_LATIN_TOKEN_PATTERNS.some((pattern) => pattern.test(normalizedLatinCandidate))
        ) {
          return true;
        }
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
    if (!normalizedContext) {
      return false;
    }

    return (
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_CANINE_FEMALE_FORMS,
        PROFANITY_CANINE_CONTEXT_MARKERS,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_LIVESTOCK_FORMS,
        PROFANITY_LIVESTOCK_CONTEXT_MARKERS,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_PARASITE_FORMS,
        PROFANITY_PARASITE_CONTEXT_MARKERS,
      )
    );
  }

  private matchesProfanityContextException(
    token: string,
    normalizedContext: string,
    forms: ReadonlySet<string>,
    markers: readonly string[],
  ): boolean {
    if (!forms.has(token)) {
      return false;
    }

    let matchedMarkers = 0;
    for (const marker of markers) {
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
    commercialCampaignContext?: CommercialCampaignContext | null;
  }): CommercialDetection | null {
    const { normalizedText, rawLoweredText, settings, commercialCampaignContext } = params;

    if (!normalizedText || normalizedText.length < 6) {
      return null;
    }

    const appliedThresholds = this.resolveCommercialThresholds(settings);
    const state = this.collectCommercialSignals(
      normalizedText,
      rawLoweredText,
      appliedThresholds,
      commercialCampaignContext,
    );
    if (state.matchedSignals.length === 0 || !state.hasCommercialContext || !state.hasDealSignal) {
      return null;
    }

    const hasStandardCommercialEvidence =
      state.hasPrice || state.hasContact || state.hasDealChannel || state.hasTransactional;
    const hasCampaignStrongEvidence = Boolean(
      commercialCampaignContext &&
      ((commercialCampaignContext.repeatedPhoneDistinctChatCount >= 2 && state.hasContact) ||
        (commercialCampaignContext.repeatedLinkDistinctChatCount >= 2 && state.hasDealChannel) ||
        (commercialCampaignContext.sameTextDistinctChatCount >= 3 &&
          (state.hasContact || state.hasDealChannel || state.hasTransactional))),
    );
    const hasStrongCommercialEvidence =
      state.hasPrice ||
      state.hasDealChannel ||
      (state.hasContact && state.hasTransactional) ||
      hasCampaignStrongEvidence;
    const hasStructuredCommercialContext =
      state.hasPromoContext ||
      state.hasBusinessContext ||
      state.hasBuyoutContext ||
      state.hasRecruitmentContext ||
      state.hasInfoProductContext ||
      state.hasGroupPromoContext ||
      state.hasServiceContext ||
      state.hasCommercialPropertyContext ||
      state.hasGoodsRetailContext ||
      state.hasCampaignContext;
    const hasSelfPromotionalCommercialContext =
      this.hasExplicitSelfPromotionalCommercialContext(state);
    const hasPrivateSaleCommercialOverride =
      state.hasPropertyAgentContext ||
      state.hasCommercialPropertyContext ||
      state.hasBusinessContext ||
      state.hasGroupPromoContext ||
      state.hasCommercialAudienceContext ||
      state.hasRecruitmentContext ||
      state.hasBuyoutContext ||
      state.hasInfoProductContext ||
      state.hasGoodsRetailContext ||
      (state.hasServiceContext &&
        (!state.hasPropertyPrivateContext || state.hasServiceOfferContext)) ||
      state.hasServiceOfferContext;

    if (state.hasPrivateSaleContext && !hasPrivateSaleCommercialOverride) {
      return null;
    }

    if (state.hasSearchRequestContext && !hasSelfPromotionalCommercialContext) {
      return null;
    }

    if (state.hasJobSeekingContext) {
      return null;
    }

    if (
      state.hasPrivateGoodsItemContext &&
      !state.hasGoodsRetailContext &&
      !state.hasBusinessContext &&
      !state.hasDealChannel &&
      !state.hasCampaignContext
    ) {
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

    let decisionBand: CommercialDecisionBand =
      confidenceScore >= appliedThresholds.deleteThreshold
        ? 'HIGH'
        : confidenceScore >= appliedThresholds.warnThreshold
          ? 'MEDIUM'
          : 'LOW';
    let classification = this.classifyCommercialDetection({
      state,
      confidenceScore,
      decisionBand,
      appliedThresholds,
      commercialCampaignContext,
    });
    const secondStage = this.evaluateCommercialSecondStage({
      normalizedText,
      rawLoweredText,
      state,
      confidenceScore,
      decisionBand,
      appliedThresholds,
      classification,
      commercialCampaignContext,
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

    if (confidenceScore < appliedThresholds.warnThreshold) {
      return null;
    }

    return {
      confidenceScore,
      decisionBand,
      matchedSignals: state.matchedSignals,
      negativeSignals: state.negativeSignals,
      primarySubtype: classification.primarySubtype,
      supportingSubtypes: classification.supportingSubtypes,
      evidenceStrength: classification.evidenceStrength,
      reviewRecommended: classification.reviewRecommended,
      reviewReasons: classification.reviewReasons,
      campaignContext: state.hasCampaignContext ? (commercialCampaignContext ?? null) : null,
      appliedThresholds,
      classifierVersion: secondStage?.classifierVersion ?? null,
      commercialProbability: secondStage?.commercialProbability ?? null,
      reviewProbability: secondStage?.reviewProbability ?? null,
      classifierReasons: secondStage?.classifierReasons ?? [],
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

  private evaluateCommercialSecondStage(params: {
    normalizedText: string;
    rawLoweredText: string;
    state: CommercialSignalState;
    confidenceScore: number;
    decisionBand: CommercialDecisionBand;
    appliedThresholds: CommercialThresholdProfile;
    classification: CommercialClassification;
    commercialCampaignContext?: CommercialCampaignContext | null;
  }): CommercialSecondStageDecision | null {
    const {
      normalizedText,
      rawLoweredText,
      state,
      confidenceScore,
      decisionBand,
      appliedThresholds,
      classification,
      commercialCampaignContext,
    } = params;

    if (
      !this.shouldRunCommercialSecondStage({
        state,
        confidenceScore,
        decisionBand,
        appliedThresholds,
        classification,
      })
    ) {
      return null;
    }

    const cacheKey = this.buildCommercialSecondStageCacheKey({
      normalizedText,
      confidenceScore,
      decisionBand,
      appliedThresholds,
      classification,
      commercialCampaignContext,
    });
    const cached = this.commercialSecondStageCache.get(cacheKey);
    if (cached) {
      this.commercialSecondStageCache.delete(cacheKey);
      this.commercialSecondStageCache.set(cacheKey, cached);
      return cached;
    }

    const directDealEvidence =
      (state.hasPrice && (state.hasContact || state.hasDealChannel || state.hasTransactional)) ||
      (state.hasDealChannel && state.hasContact);
    const strongCampaignEvidence = Boolean(
      commercialCampaignContext &&
      ((commercialCampaignContext.repeatedPhoneDistinctChatCount >= 2 && state.hasContact) ||
        (commercialCampaignContext.repeatedLinkDistinctChatCount >= 2 && state.hasDealChannel) ||
        (commercialCampaignContext.sameTextDistinctChatCount >= 3 &&
          (state.hasContact || state.hasDealChannel || state.hasTransactional))),
    );
    const structuredEvidence =
      (state.hasPropertyAgentContext ||
        state.hasCommercialPropertyContext ||
        state.hasRecruitmentContext ||
        state.hasInfoProductContext ||
        state.hasBuyoutContext ||
        state.hasServiceContext ||
        state.hasGoodsRetailContext ||
        state.hasGroupPromoContext ||
        state.hasBusinessContext ||
        state.hasPromoContext) &&
      (state.hasContact || state.hasDealChannel || state.hasPrice || state.hasTransactional);
    const priceMatchCount = this.countPatternMatches(
      rawLoweredText,
      ADS_PRICE_CAPTURE_GLOBAL_PATTERN,
    );
    const phoneMatchCount = rawLoweredText.match(/(?:\+?\d[\d\s()/-]{8,}\d)/g)?.length ?? 0;
    const multiSkuPriceLineCount = this.countPatternMatches(
      rawLoweredText,
      ADS_MULTI_SKU_PRICE_LINE_PATTERN,
      6,
    );
    const goodsVariantMarkerCount = this.countPatternMatches(
      rawLoweredText,
      ADS_GOODS_VARIANT_MARKER_GLOBAL_PATTERN,
      6,
    );
    const hasPriceRange = /(?:^|[^\p{L}\p{N}_-])от\s+\d{2,}/iu.test(rawLoweredText);
    const hasFreshStockContext = ADS_GOODS_FRESH_STOCK_PATTERN.test(rawLoweredText);
    const hasRetailOrderFlow =
      /(?:^|[^\p{L}\p{N}_-])(?:под\s+заказ|по\s+заказу|оформить\s+заказ|оформляйте\s+заказ|оптом\s+и\s+в\s+розницу|доставка\s+по\s+(?:городу|региону|россии)|со\s+склада)(?=$|[^\p{L}\p{N}_-])/iu.test(
        rawLoweredText,
      ) ||
      /(?:^|[^\p{L}\p{N}_-])(?:каталог|ассортимент|в\s+наличии)(?=$|[^\p{L}\p{N}_-])/iu.test(
        rawLoweredText,
      );
    const hasMultiSkuGoodsStructure =
      multiSkuPriceLineCount >= 2 || (priceMatchCount >= 2 && goodsVariantMarkerCount >= 1);
    const hasPersonalResalePattern =
      ADS_PERSONAL_RESALE_STRONG_PATTERN.test(rawLoweredText) ||
      /(?:^|[^\p{L}\p{N}_-])(?:после\s+одного\s+раза|почти\s+нов[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
        rawLoweredText,
      );
    const hasStrongDealCombo =
      state.matchedSignals.includes('combo:contact+price') ||
      state.matchedSignals.includes('combo:business+deal') ||
      state.matchedSignals.includes('combo:promo+deal') ||
      state.matchedSignals.includes('combo:service+deal') ||
      state.matchedSignals.includes('combo:service-offer+deal') ||
      state.matchedSignals.includes('combo:group-promo+deal') ||
      state.matchedSignals.includes('combo:campaign+deal');
    const scoreMargin = confidenceScore - appliedThresholds.warnThreshold;

    let commercialLogit = -2.2 + scoreMargin / 8;
    if (state.hasPrice) {
      commercialLogit += 1.15;
    }
    if (state.hasContact) {
      commercialLogit += 1.05;
    }
    if (state.hasDealChannel) {
      commercialLogit += 0.9;
    }
    if (state.hasTransactional) {
      commercialLogit += 0.7;
    }
    if (state.hasBusinessContext) {
      commercialLogit += 1.5;
    }
    if (state.hasPromoContext) {
      commercialLogit += 0.9;
    }
    if (state.hasGoodsRetailContext) {
      commercialLogit += 1.8;
    }
    if (state.hasCommercialPropertyContext) {
      commercialLogit += 2;
    }
    if (state.hasPropertyAgentContext) {
      commercialLogit += 2.1;
    }
    if (state.hasServiceContext) {
      commercialLogit += 1.1;
    }
    if (state.hasRecruitmentContext) {
      commercialLogit += 1.2;
    }
    if (state.hasInfoProductContext) {
      commercialLogit += 1.05;
    }
    if (state.hasGroupPromoContext) {
      commercialLogit += 1.25;
    }
    if (structuredEvidence) {
      commercialLogit += 0.7;
    }
    if (strongCampaignEvidence) {
      commercialLogit += 0.95;
    } else if (state.hasCampaignContext) {
      commercialLogit += 0.45;
    }
    if (priceMatchCount >= 2 || hasPriceRange) {
      commercialLogit += 0.45;
    }
    if (phoneMatchCount >= 2) {
      commercialLogit += 0.35;
    }
    if (hasMultiSkuGoodsStructure) {
      commercialLogit += 0.8;
    }
    if (hasFreshStockContext) {
      commercialLogit += 0.35;
    }
    if (hasRetailOrderFlow) {
      commercialLogit += 0.65;
    }
    if (hasStrongDealCombo) {
      commercialLogit += 0.8;
    }
    if (state.hasPrivateGoodsItemContext) {
      commercialLogit -= 1.8;
    }
    if (
      state.hasPrivateSaleContext &&
      !state.hasBusinessContext &&
      !state.hasCampaignContext &&
      !state.hasGoodsRetailContext &&
      !state.hasCommercialPropertyContext &&
      !state.hasPropertyAgentContext
    ) {
      commercialLogit -= 1.6;
    }
    if (
      state.hasPropertyPrivateContext &&
      !state.hasCommercialPropertyContext &&
      !state.hasPropertyAgentContext
    ) {
      commercialLogit -= 2.35;
    }
    if (state.hasSearchRequestContext || state.hasJobSeekingContext) {
      commercialLogit -= 2.5;
    }
    if (state.hasStrongNegativeContext) {
      commercialLogit -= 1;
    }
    if (state.negativeSignals.length >= 2) {
      commercialLogit -= 0.45;
    }
    if (hasPersonalResalePattern) {
      commercialLogit -= 1.4;
    }
    if (
      hasMultiSkuGoodsStructure &&
      hasPersonalResalePattern &&
      !state.hasBusinessContext &&
      !state.hasCampaignContext
    ) {
      commercialLogit -= 0.7;
    }

    const commercialProbability = this.sigmoid(commercialLogit);
    const classifierReasons: string[] = [];
    let adjustedConfidenceScore = confidenceScore;

    if (
      decisionBand === 'LOW' &&
      confidenceScore >= appliedThresholds.warnThreshold - 10 &&
      commercialProbability >= 0.78 &&
      structuredEvidence &&
      (state.hasPrice || state.hasContact || state.hasDealChannel || state.hasTransactional)
    ) {
      adjustedConfidenceScore = Math.max(
        adjustedConfidenceScore,
        appliedThresholds.warnThreshold + Math.round((commercialProbability - 0.78) * 18) + 1,
      );
      classifierReasons.push('rescued-borderline');
    }

    if (
      adjustedConfidenceScore >= appliedThresholds.warnThreshold &&
      commercialProbability <= 0.3 &&
      (classification.primarySubtype === 'GOODS' || classification.primarySubtype === 'GENERIC') &&
      (state.hasPrivateSaleContext ||
        state.hasPrivateGoodsItemContext ||
        state.hasStrongNegativeContext)
    ) {
      adjustedConfidenceScore = Math.min(
        adjustedConfidenceScore,
        appliedThresholds.warnThreshold - 1,
      );
      classifierReasons.push('suppressed-private-like');
    }

    if (
      adjustedConfidenceScore >= appliedThresholds.warnThreshold &&
      commercialProbability >= 0.9 &&
      adjustedConfidenceScore < appliedThresholds.deleteThreshold &&
      structuredEvidence &&
      directDealEvidence
    ) {
      adjustedConfidenceScore = Math.min(100, adjustedConfidenceScore + 4);
      classifierReasons.push('boosted-structured');
    }

    let primarySubtype = classification.primarySubtype;
    const supportingSubtypes = [...classification.supportingSubtypes];
    const pushSupportingSubtype = (subtype: CommercialSubtype) => {
      if (subtype === primarySubtype || supportingSubtypes.includes(subtype)) {
        return;
      }
      supportingSubtypes.unshift(subtype);
      supportingSubtypes.splice(3);
    };

    if (
      state.hasCommercialPropertyContext &&
      commercialProbability >= 0.84 &&
      primarySubtype !== 'PROPERTY_AGENT' &&
      primarySubtype !== 'PROPERTY_COMMERCIAL'
    ) {
      pushSupportingSubtype(primarySubtype);
      primarySubtype = 'PROPERTY_COMMERCIAL';
      classifierReasons.push('subtype:property-commercial');
    } else if (
      state.hasGoodsRetailContext &&
      commercialProbability >= 0.74 &&
      (primarySubtype === 'GOODS' || primarySubtype === 'GENERIC')
    ) {
      pushSupportingSubtype(primarySubtype);
      primarySubtype = 'GOODS_RETAIL';
      classifierReasons.push('subtype:goods-retail');
    } else if (
      hasMultiSkuGoodsStructure &&
      !hasPersonalResalePattern &&
      commercialProbability >= 0.8 &&
      state.hasContact &&
      state.hasPrice &&
      (primarySubtype === 'GOODS' || primarySubtype === 'GENERIC')
    ) {
      pushSupportingSubtype(primarySubtype);
      primarySubtype = 'GOODS_RETAIL';
      classifierReasons.push('subtype:goods-multi-sku');
    }

    const adjustedDecisionBand: CommercialDecisionBand =
      adjustedConfidenceScore >= appliedThresholds.deleteThreshold
        ? 'HIGH'
        : adjustedConfidenceScore >= appliedThresholds.warnThreshold
          ? 'MEDIUM'
          : 'LOW';

    let reviewLogit = -1.35;
    if (adjustedDecisionBand !== 'HIGH') {
      reviewLogit += 1.1;
    } else {
      reviewLogit -= 0.25;
    }
    if (adjustedConfidenceScore <= appliedThresholds.warnThreshold + 6) {
      reviewLogit += 0.85;
    }
    if (primarySubtype === 'GENERIC' || primarySubtype === 'GOODS') {
      reviewLogit += 1.25;
    }
    if (state.hasCampaignContext && !strongCampaignEvidence) {
      reviewLogit += 1.15;
    } else if (state.hasCampaignContext && strongCampaignEvidence && !directDealEvidence) {
      reviewLogit += 0.5;
    }
    if (state.hasStrongNegativeContext || state.negativeSignals.length > 0) {
      reviewLogit += 0.95;
    }
    if (
      state.hasPrivateSaleContext &&
      (state.hasServiceContext || state.hasGoodsRetailContext || state.hasCommercialPropertyContext)
    ) {
      reviewLogit += 0.7;
    }
    if (hasMultiSkuGoodsStructure && !hasPersonalResalePattern) {
      reviewLogit -= 0.55;
    }
    if (hasFreshStockContext || hasRetailOrderFlow) {
      reviewLogit -= 0.25;
    }
    if (directDealEvidence) {
      reviewLogit -= 0.9;
    }
    if (structuredEvidence) {
      reviewLogit -= 0.65;
    }
    if (
      (primarySubtype === 'GOODS_RETAIL' ||
        primarySubtype === 'PROPERTY_COMMERCIAL' ||
        primarySubtype === 'PROPERTY_AGENT') &&
      adjustedConfidenceScore >= appliedThresholds.deleteThreshold
    ) {
      reviewLogit -= 1.2;
    }
    if (commercialProbability < 0.45) {
      reviewLogit += 0.6;
    }
    if (commercialProbability > 0.84 && structuredEvidence) {
      reviewLogit -= 0.85;
    }

    const reviewProbability = this.sigmoid(reviewLogit);
    let reviewReasons = [...classification.reviewReasons];
    if (primarySubtype !== 'GOODS' && primarySubtype !== 'GENERIC') {
      reviewReasons = reviewReasons.filter((reason) => reason !== 'generic-subtype');
    }
    if (
      (primarySubtype === 'GOODS_RETAIL' || primarySubtype === 'PROPERTY_COMMERCIAL') &&
      adjustedConfidenceScore >= appliedThresholds.deleteThreshold &&
      directDealEvidence
    ) {
      reviewReasons = reviewReasons.filter(
        (reason) =>
          reason !== 'private-sale-override' &&
          reason !== 'conflicting-negative-signals' &&
          reason !== 'near-threshold' &&
          reason !== 'medium-band',
      );
    }
    if (
      primarySubtype === 'GOODS_RETAIL' &&
      hasMultiSkuGoodsStructure &&
      adjustedConfidenceScore >= appliedThresholds.deleteThreshold &&
      directDealEvidence
    ) {
      reviewReasons = reviewReasons.filter(
        (reason) => reason !== 'generic-subtype' && reason !== 'near-threshold',
      );
    }

    const hasHardReviewReason = reviewReasons.includes('campaign-dependent');
    let reviewRecommended =
      reviewReasons.length > 0 &&
      (adjustedDecisionBand !== 'HIGH' ||
        reviewReasons.includes('campaign-dependent') ||
        reviewReasons.includes('generic-subtype') ||
        reviewReasons.includes('conflicting-negative-signals'));

    if (
      !hasHardReviewReason &&
      reviewProbability <= 0.34 &&
      adjustedDecisionBand === 'HIGH' &&
      structuredEvidence &&
      directDealEvidence
    ) {
      reviewRecommended = false;
      reviewReasons = [];
      classifierReasons.push('cleared-review');
    } else if (
      reviewProbability >= 0.72 &&
      adjustedConfidenceScore >= appliedThresholds.warnThreshold
    ) {
      reviewRecommended = true;
      if (!reviewReasons.includes('classifier-ambiguous')) {
        reviewReasons.push('classifier-ambiguous');
      }
      classifierReasons.push('review:ambiguous');
    }

    const decision: CommercialSecondStageDecision = {
      adjustedConfidenceScore,
      primarySubtype,
      supportingSubtypes: [...new Set(supportingSubtypes)].slice(0, 3),
      reviewRecommended,
      reviewReasons: [...new Set(reviewReasons)],
      classifierVersion: COMMERCIAL_SECOND_STAGE_VERSION,
      commercialProbability: Number(commercialProbability.toFixed(4)),
      reviewProbability: Number(reviewProbability.toFixed(4)),
      classifierReasons,
    };
    this.rememberCommercialSecondStageDecision(cacheKey, decision);
    return decision;
  }

  private shouldRunCommercialSecondStage(params: {
    state: CommercialSignalState;
    confidenceScore: number;
    decisionBand: CommercialDecisionBand;
    appliedThresholds: CommercialThresholdProfile;
    classification: CommercialClassification;
  }): boolean {
    const { state, confidenceScore, decisionBand, appliedThresholds, classification } = params;
    return (
      confidenceScore <= appliedThresholds.deleteThreshold + 4 ||
      decisionBand === 'LOW' ||
      classification.reviewRecommended ||
      classification.primarySubtype === 'GOODS' ||
      classification.primarySubtype === 'GENERIC' ||
      state.hasGoodsRetailContext ||
      state.hasCommercialPropertyContext ||
      (state.hasCampaignContext && confidenceScore <= appliedThresholds.deleteThreshold + 8) ||
      (state.hasPrivateSaleContext &&
        !state.hasPropertyAgentContext &&
        !state.hasCommercialPropertyContext) ||
      (state.hasGoodsRetailContext && classification.primarySubtype !== 'GOODS_RETAIL') ||
      (state.hasCommercialPropertyContext &&
        classification.primarySubtype !== 'PROPERTY_COMMERCIAL')
    );
  }

  private buildCommercialSecondStageCacheKey(params: {
    normalizedText: string;
    confidenceScore: number;
    decisionBand: CommercialDecisionBand;
    appliedThresholds: CommercialThresholdProfile;
    classification: CommercialClassification;
    commercialCampaignContext?: CommercialCampaignContext | null;
  }): string {
    const {
      normalizedText,
      confidenceScore,
      decisionBand,
      appliedThresholds,
      classification,
      commercialCampaignContext,
    } = params;
    const textHash = createHash('sha1').update(normalizedText).digest('hex').slice(0, 16);
    return [
      COMMERCIAL_SECOND_STAGE_VERSION,
      textHash,
      classification.primarySubtype,
      decisionBand,
      Math.round(confidenceScore),
      appliedThresholds.warnThreshold,
      appliedThresholds.deleteThreshold,
      commercialCampaignContext?.sameTextDistinctChatCount ?? 0,
      commercialCampaignContext?.repeatedPhoneDistinctChatCount ?? 0,
      commercialCampaignContext?.repeatedLinkDistinctChatCount ?? 0,
      commercialCampaignContext?.senderDistinctChatCount ?? 0,
    ].join('|');
  }

  private rememberCommercialSecondStageDecision(
    cacheKey: string,
    decision: CommercialSecondStageDecision,
  ): void {
    this.commercialSecondStageCache.set(cacheKey, decision);
    if (this.commercialSecondStageCache.size <= COMMERCIAL_SECOND_STAGE_CACHE_MAX_ENTRIES) {
      return;
    }

    const oldestKey = this.commercialSecondStageCache.keys().next().value;
    if (typeof oldestKey === 'string') {
      this.commercialSecondStageCache.delete(oldestKey);
    }
  }

  private sigmoid(value: number): number {
    if (value >= 0) {
      const exponent = Math.exp(-value);
      return 1 / (1 + exponent);
    }

    const exponent = Math.exp(value);
    return exponent / (1 + exponent);
  }

  private countPatternMatches(value: string, pattern: RegExp, limit = 12): number {
    if (!value || limit <= 0) {
      return 0;
    }

    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const matcher = new RegExp(pattern.source, flags);
    let count = 0;

    while (count < limit && matcher.exec(value)) {
      count += 1;
    }

    return count;
  }

  private classifyCommercialDetection(params: {
    state: CommercialSignalState;
    confidenceScore: number;
    decisionBand: CommercialDecisionBand;
    appliedThresholds: CommercialThresholdProfile;
    commercialCampaignContext?: CommercialCampaignContext | null;
  }): CommercialClassification {
    const { state, confidenceScore, decisionBand, appliedThresholds, commercialCampaignContext } =
      params;
    const subtypeScores = new Map<CommercialSubtype, number>();
    const addSubtype = (subtype: CommercialSubtype, score: number) => {
      subtypeScores.set(subtype, Math.max(score, subtypeScores.get(subtype) ?? 0));
    };

    if (state.hasGroupPromoContext) {
      addSubtype('CHANNEL_PLACEMENT', 100);
    } else if (state.hasCommercialAudienceContext && state.hasGroupPromotionIntent) {
      addSubtype('CHANNEL_PLACEMENT', 90);
    }

    if (state.hasPropertyAgentContext) {
      addSubtype('PROPERTY_AGENT', 100);
    }

    if (state.hasCommercialPropertyContext) {
      addSubtype('PROPERTY_COMMERCIAL', 96);
    }

    if (state.hasRecruitmentContext) {
      addSubtype('RECRUITMENT', 95);
    }

    if (state.hasInfoProductContext) {
      addSubtype('INFO_PRODUCT', 88);
    }

    if (state.hasBuyoutContext) {
      addSubtype('BUYOUT', 92);
    }

    if (state.hasServiceContext) {
      addSubtype('SERVICES', 84);
    } else if (state.hasServiceOfferContext || state.hasServiceSpecialtyContext) {
      addSubtype('SERVICES', 74);
    }

    if (state.hasGoodsRetailContext) {
      addSubtype('GOODS_RETAIL', state.hasServiceContext ? 76 : 86);
    }

    if (state.hasGroupPromotionIntent && state.hasDealChannel) {
      addSubtype('GROUP_PROMOTION', state.hasGroupPromoContext ? 82 : 72);
    }

    if (
      !state.hasServiceContext &&
      !state.hasPropertyAgentContext &&
      !state.hasCommercialPropertyContext &&
      !state.hasRecruitmentContext &&
      !state.hasInfoProductContext &&
      !state.hasGoodsRetailContext &&
      (state.hasIntent || state.hasPromoContext || state.hasBusinessContext) &&
      (state.hasPrice || state.hasTransactional || state.hasContact || state.hasDealChannel)
    ) {
      addSubtype('GOODS', 68);
    }

    if (subtypeScores.size === 0) {
      addSubtype('GENERIC', 30);
    }

    const rankedSubtypes = [...subtypeScores.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([subtype, score]) => ({ subtype, score }));
    const primarySubtype = rankedSubtypes[0]?.subtype ?? 'GENERIC';
    const supportingSubtypes = rankedSubtypes
      .filter((entry, index) => index > 0 && entry.score >= rankedSubtypes[0].score - 24)
      .slice(0, 3)
      .map((entry) => entry.subtype);

    const hasDirectEvidence =
      (state.hasPrice && (state.hasContact || state.hasDealChannel || state.hasTransactional)) ||
      (state.hasDealChannel && state.hasContact);
    const hasCampaignDependentEvidence = Boolean(
      commercialCampaignContext &&
      state.hasCampaignContext &&
      ((commercialCampaignContext.repeatedPhoneDistinctChatCount >= 2 && state.hasContact) ||
        (commercialCampaignContext.repeatedLinkDistinctChatCount >= 2 && state.hasDealChannel) ||
        (commercialCampaignContext.sameTextDistinctChatCount >= 3 &&
          (state.hasContact || state.hasDealChannel || state.hasTransactional))),
    );
    const hasStructuredEvidence =
      (state.hasPropertyAgentContext ||
        state.hasCommercialPropertyContext ||
        state.hasRecruitmentContext ||
        state.hasInfoProductContext ||
        state.hasBuyoutContext ||
        state.hasServiceContext ||
        state.hasGoodsRetailContext ||
        state.hasGroupPromoContext ||
        state.hasBusinessContext ||
        state.hasPromoContext) &&
      (state.hasContact || state.hasDealChannel || state.hasPrice || state.hasTransactional);
    const evidenceStrength: CommercialClassification['evidenceStrength'] = hasDirectEvidence
      ? 'DIRECT'
      : hasCampaignDependentEvidence
        ? 'CAMPAIGN'
        : hasStructuredEvidence
          ? 'STRUCTURED'
          : 'BORDERLINE';
    const suppressPropertyAgentReviewNoise =
      primarySubtype === 'PROPERTY_AGENT' &&
      confidenceScore >= appliedThresholds.deleteThreshold &&
      (state.hasPrice || state.hasContact || state.hasTransactional);
    const suppressStructuredGoodsReviewNoise =
      (primarySubtype === 'GOODS_RETAIL' || primarySubtype === 'PROPERTY_COMMERCIAL') &&
      confidenceScore >= appliedThresholds.deleteThreshold &&
      (state.hasPrice || state.hasContact || state.hasTransactional);

    const reviewReasons: string[] = [];
    if (decisionBand !== 'HIGH') {
      reviewReasons.push('medium-band');
    }
    if (confidenceScore <= appliedThresholds.warnThreshold + 6) {
      reviewReasons.push('near-threshold');
    }
    if (
      (state.hasStrongNegativeContext || state.negativeSignals.length > 0) &&
      !suppressPropertyAgentReviewNoise &&
      !suppressStructuredGoodsReviewNoise
    ) {
      reviewReasons.push('conflicting-negative-signals');
    }
    if (hasCampaignDependentEvidence && evidenceStrength === 'CAMPAIGN') {
      reviewReasons.push('campaign-dependent');
    }
    if (primarySubtype === 'GENERIC' || primarySubtype === 'GOODS') {
      reviewReasons.push('generic-subtype');
    }
    if (
      state.hasPrivateSaleContext &&
      (state.hasServiceContext ||
        state.hasPropertyAgentContext ||
        state.hasCommercialPropertyContext) &&
      !suppressPropertyAgentReviewNoise &&
      !suppressStructuredGoodsReviewNoise
    ) {
      reviewReasons.push('private-sale-override');
    }

    const reviewRecommended =
      reviewReasons.length > 0 &&
      (decisionBand !== 'HIGH' ||
        reviewReasons.includes('campaign-dependent') ||
        reviewReasons.includes('generic-subtype') ||
        reviewReasons.includes('conflicting-negative-signals'));

    return {
      primarySubtype,
      supportingSubtypes: [...new Set(supportingSubtypes)],
      evidenceStrength,
      reviewRecommended,
      reviewReasons: [...new Set(reviewReasons)],
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
    commercialCampaignContext?: CommercialCampaignContext | null,
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
    let hasCampaignContext = false;
    let hasPrivateSaleContext = false;
    let hasPropertyAgentContext = false;
    let hasCommercialPropertyContext = false;
    let hasGoodsRetailContext = false;
    let hasPrivateGoodsItemContext = false;
    let hasStrongNegativeContext = false;
    let hasGroupContext = false;
    let hasGroupTradeContext = false;
    let hasCommercialAudienceContext = false;
    let hasPropertyPrivateContext = false;

    const markerContext = this.buildCommercialMarkerContext(normalizedText, rawLoweredText);
    const hasMarker = (marker: string): boolean => this.hasCommercialMarker(marker, markerContext);
    const matchesPattern = (pattern: RegExp): boolean =>
      this.matchesCommercialPattern(pattern, markerContext);
    const hasUtilityPaymentContext =
      ADS_PROPERTY_UTILITY_PAYMENT_PATTERN.test(normalizedText) ||
      ADS_PROPERTY_UTILITY_PAYMENT_PATTERN.test(rawLoweredText);

    const propertyPrivateHits = [
      ...ADS_PROPERTY_PRIVATE_PATTERNS.filter(({ pattern }) => matchesPattern(pattern)).map(
        ({ label }) => label,
      ),
      ...ADS_PROPERTY_CONTEXT_PATTERNS.filter(({ pattern }) => matchesPattern(pattern)).map(
        ({ label }) => label,
      ),
    ];
    if (propertyPrivateHits.length > 0) {
      addNegative('private:property-sale', 26, true);
      hasPrivateSaleContext = true;
      hasPropertyPrivateContext = true;
    }

    const intentHits = ADS_INTENT_MARKERS.filter((marker) => {
      if (
        hasPropertyPrivateContext &&
        hasUtilityPaymentContext &&
        ADS_SERVICE_INTENT_MARKERS.has(marker)
      ) {
        return false;
      }

      return hasMarker(marker);
    });
    for (const marker of intentHits.slice(0, 3)) {
      addPositive(`intent:${marker}`, 10);
      hasIntent = true;
      if (ADS_SERVICE_INTENT_MARKERS.has(marker)) {
        hasServiceOfferContext = true;
      }
      hasDealSignal = true;
    }

    const serviceOfferHits = ADS_SERVICE_OFFER_PATTERNS.filter(({ pattern }) =>
      matchesPattern(pattern),
    );
    for (const { label } of serviceOfferHits.slice(0, 2)) {
      addPositive(`intent:${label}`, 10);
      hasIntent = true;
      hasServiceOfferContext = true;
      hasDealSignal = true;
    }

    const promoHits = ADS_PROMO_MARKERS.filter((marker) => hasMarker(marker));
    for (const marker of promoHits.slice(0, 3)) {
      addPositive(`promo:${marker}`, 12);
      hasPromoContext = true;
      hasCommercialContext = true;
    }

    const propertyAgentHits = ADS_PROPERTY_AGENT_PATTERNS.filter(({ pattern }) =>
      matchesPattern(pattern),
    );
    for (const { label } of propertyAgentHits.slice(0, 3)) {
      addPositive(`property-agent:${label}`, 18);
      hasPropertyAgentContext = true;
      hasBusinessContext = true;
      hasCommercialContext = true;
    }

    const commercialPropertyHits = ADS_PROPERTY_COMMERCIAL_PATTERNS.filter(({ pattern }) =>
      matchesPattern(pattern),
    );
    for (const { label } of commercialPropertyHits.slice(0, 2)) {
      addPositive(`property-commercial:${label}`, 16);
      hasCommercialPropertyContext = true;
      hasBusinessContext = true;
      hasCommercialContext = true;
    }

    const businessHits = [
      ...ADS_BUSINESS_MARKERS.filter(
        (marker) =>
          !(hasPropertyPrivateContext && PROPERTY_LISTING_NOISE_BUSINESS_MARKERS.has(marker)) &&
          hasMarker(marker),
      ),
      ...ADS_BUSINESS_PATTERNS.filter(({ pattern }) => matchesPattern(pattern)).map(
        ({ label }) => label,
      ),
    ];
    for (const marker of [...new Set(businessHits)].slice(0, 2)) {
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

    const recruitmentHits = [
      ...ADS_RECRUITMENT_MARKERS.filter((marker) => hasMarker(marker)),
      ...ADS_RECRUITMENT_PATTERNS.filter(({ pattern }) => matchesPattern(pattern)).map(
        ({ label }) => label,
      ),
    ];
    for (const marker of [...new Set(recruitmentHits)].slice(0, 2)) {
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

    const serviceSpecialtyHits = [
      ...ADS_SERVICE_SPECIALTY_MARKERS.filter(
        (marker) =>
          !(
            hasPropertyPrivateContext &&
            !hasServiceOfferContext &&
            PROPERTY_LISTING_NOISE_SERVICE_SPECIALTY_MARKERS.has(marker)
          ) && hasMarker(marker),
      ),
      ...ADS_SERVICE_SPECIALTY_PATTERNS.filter(({ pattern }) => matchesPattern(pattern)).map(
        ({ label }) => label,
      ),
    ];
    for (const marker of [...new Set(serviceSpecialtyHits)].slice(0, 3)) {
      addPositive(`service-specialty:${marker}`, 8);
      hasServiceSpecialtyContext = true;
    }

    const goodsRetailHits = ADS_GOODS_RETAIL_PATTERNS.filter(({ pattern }) =>
      matchesPattern(pattern),
    );
    for (const { label } of goodsRetailHits.slice(0, 3)) {
      addPositive(`goods-retail:${label}`, 10);
      hasGoodsRetailContext = true;
      hasCommercialContext = true;
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

    const channelPlacementHits = [
      ...ADS_CHANNEL_PLACEMENT_MARKERS.filter((marker) => hasMarker(marker)),
      ...ADS_CHANNEL_PLACEMENT_PATTERNS.filter(({ pattern }) => matchesPattern(pattern)).map(
        ({ label }) => label,
      ),
    ];
    for (const marker of [...new Set(channelPlacementHits)].slice(0, 4)) {
      addPositive(`channel-placement:${marker}`, 12);
      hasGroupContext = true;
      hasGroupTradeContext = true;
      hasGroupPromotionIntent = true;
      hasCommercialAudienceContext = true;
      hasBusinessContext = true;
      hasCallToActionContext = true;
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

    if (
      !hasGoodsRetailContext &&
      !hasPropertyPrivateContext &&
      (hasPromoContext || hasBusinessContext) &&
      (hasMarker('в наличии') ||
        hasMarker('каталог') ||
        hasMarker('ассортимент') ||
        hasMarker('заказывайте'))
    ) {
      addPositive('goods-retail:inventory', 10);
      hasGoodsRetailContext = true;
      hasCommercialContext = true;
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

    if (commercialCampaignContext) {
      if (commercialCampaignContext.sameTextDistinctChatCount >= 2) {
        addPositive(
          'campaign:cross-chat-text',
          commercialCampaignContext.sameTextDistinctChatCount >= 3 ? 22 : 18,
        );
        hasCampaignContext = true;
      }

      if (commercialCampaignContext.repeatedPhoneDistinctChatCount >= 2) {
        addPositive(
          'campaign:cross-chat-phone',
          commercialCampaignContext.repeatedPhoneDistinctChatCount >= 3 ? 22 : 18,
        );
        hasCampaignContext = true;
      }

      if (commercialCampaignContext.repeatedLinkDistinctChatCount >= 2) {
        addPositive(
          'campaign:cross-chat-link',
          commercialCampaignContext.repeatedLinkDistinctChatCount >= 3 ? 20 : 16,
        );
        hasCampaignContext = true;
      }

      if (commercialCampaignContext.senderDistinctChatCount >= 3) {
        addPositive(
          'campaign:sender-multi-chat',
          commercialCampaignContext.senderDistinctChatCount >= 5 ? 10 : 6,
        );
        hasCampaignContext = true;
      }
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

    const privateGoodsHits = ADS_PRIVATE_GOODS_PATTERNS.filter(({ pattern }) =>
      matchesPattern(pattern),
    );
    for (const { label } of privateGoodsHits.slice(0, 2)) {
      addNegative(`private-goods:${label}`, 18, true);
      hasPrivateGoodsItemContext = true;
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

    if (hasCampaignContext && (hasContact || hasDealChannel || hasPrice || hasTransactional)) {
      addPositive('combo:campaign+deal', 14);
    }

    if (
      hasCampaignContext &&
      (hasPromoContext ||
        hasBusinessContext ||
        hasBuyoutContext ||
        hasRecruitmentContext ||
        hasInfoProductContext ||
        hasServiceContext ||
        hasServiceOfferContext ||
        hasCommercialAudienceContext ||
        hasGroupPromotionIntent)
    ) {
      addPositive('combo:campaign+self-promo', 10);
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
      hasCampaignContext,
      hasPrivateSaleContext,
      hasPropertyPrivateContext,
      hasPropertyAgentContext,
      hasCommercialPropertyContext,
      hasGoodsRetailContext,
      hasPrivateGoodsItemContext,
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

  private buildProfanityCyrillicCandidates(value: string): string[] {
    if (!value) {
      return [];
    }

    const candidates = new Set<string>();
    const normalized = this.normalizeProfanityCandidate(value);
    if (normalized) {
      candidates.add(normalized);
    }

    if (this.shouldBuildAmbiguousProfanityCandidate(value)) {
      const ambiguous = this.normalizeProfanityCandidateWithMap(
        value,
        PROFANITY_AMBIGUOUS_MIXED_CHAR_MAP,
      );
      if (ambiguous) {
        candidates.add(ambiguous);
      }
    }

    return [...candidates];
  }

  private shouldBuildAmbiguousProfanityCandidate(value: string): boolean {
    return /[а-яё@!|9]/iu.test(value) && /[a-z0-9@!|]/iu.test(value);
  }

  private normalizeProfanityCandidateWithMap(
    value: string,
    charMap: Readonly<Record<string, string>>,
  ): string {
    if (!value) {
      return '';
    }

    let normalized = '';
    for (const char of value.toLowerCase()) {
      const mapped = charMap[char] ?? char;
      if (/[\p{L}\p{N}]/u.test(mapped)) {
        normalized += mapped;
      }
    }

    normalized = normalized.replace(/ё/g, 'е');
    normalized = normalized.replace(/([a-zа-я0-9])\1{2,}/giu, '$1$1');
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

  private buildProfanityLatinCandidates(value: string): string[] {
    if (!value) {
      return [];
    }

    const candidates = new Set<string>();
    const normalized = this.normalizeProfanityLatinCandidate(value);
    if (normalized) {
      candidates.add(normalized);
    }

    const leetNormalized = this.normalizeProfanityLatinLeetCandidate(value);
    if (leetNormalized) {
      candidates.add(leetNormalized);
    }

    return [...candidates];
  }

  private normalizeProfanityLatinLeetCandidate(value: string): string {
    if (!value) {
      return '';
    }

    let normalized = '';
    for (const char of value.toLowerCase()) {
      const mapped = PROFANITY_LATIN_LEET_CHAR_MAP[char] ?? char;
      if (/[a-z0-9]/i.test(mapped)) {
        normalized += mapped;
      }
    }

    normalized = normalized.replace(/([a-z0-9])\1{2,}/g, '$1$1');
    return normalized;
  }

  private normalizeProfanityJoinToken(value: string): string {
    for (const normalized of this.buildProfanityCyrillicCandidates(value)) {
      if (normalized.length > 0 && normalized.length <= 2) {
        return normalized;
      }
    }

    const latinNormalized = this.normalizeProfanityLatinLeetCandidate(value);
    return latinNormalized.length <= 2 ? latinNormalized : '';
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

    const blockedWordIndex = this.resolveMessageLimitsBlockedWordList(blockedWords);
    if (blockedWordIndex.words.length === 0) {
      return null;
    }

    const normalizedText = this.normalizeMessageLimitsBlockedWordText(text);
    if (!normalizedText) {
      return null;
    }

    const compactText = normalizedText.replace(/[^\p{L}\p{N}]+/gu, '');
    const normalizedTokens = normalizedText.match(/[a-zа-яё0-9]+/giu) ?? [];
    const matchedPrefilterTokens = this.findMessageLimitsBlockedWordPrefilterTokens(
      compactText,
      blockedWordIndex.prefilterRoot,
      blockedWordIndex.maxPrefilterTokenLength,
    );
    const tokenInflectionRoots =
      this.resolveMessageLimitsBlockedWordInflectionRoots(normalizedTokens);
    if (matchedPrefilterTokens.size === 0 && tokenInflectionRoots.size === 0) {
      return null;
    }

    const candidateFlagsByBlockedWord = new Map<
      string,
      {
        inflection: boolean;
        prefilter: boolean;
      }
    >();

    for (const inflectionRoot of tokenInflectionRoots) {
      const words = blockedWordIndex.wordsByInflectionRoot.get(inflectionRoot);
      if (!words) {
        continue;
      }

      for (const word of words) {
        const candidate = candidateFlagsByBlockedWord.get(word.blockedWord) ?? {
          inflection: false,
          prefilter: false,
        };
        candidate.inflection = true;
        candidateFlagsByBlockedWord.set(word.blockedWord, candidate);
      }
    }

    for (const prefilterToken of matchedPrefilterTokens) {
      const words = blockedWordIndex.wordsByPrefilterToken.get(prefilterToken);
      if (!words) {
        continue;
      }

      for (const word of words) {
        const candidate = candidateFlagsByBlockedWord.get(word.blockedWord) ?? {
          inflection: false,
          prefilter: false,
        };
        candidate.prefilter = true;
        candidateFlagsByBlockedWord.set(word.blockedWord, candidate);
      }
    }

    if (candidateFlagsByBlockedWord.size === 0) {
      return null;
    }

    for (const blockedWord of blockedWordIndex.words) {
      const candidate = candidateFlagsByBlockedWord.get(blockedWord.blockedWord);
      if (!candidate) {
        continue;
      }

      if (
        candidate.prefilter &&
        this.getMessageLimitsBlockedWordPattern(blockedWord.blockedWord).test(normalizedText)
      ) {
        return {
          blockedWord: blockedWord.blockedWord,
        };
      }

      if (candidate.inflection) {
        return {
          blockedWord: blockedWord.blockedWord,
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

  private resolveMessageLimitsBlockedWordList(
    blockedWords: readonly string[],
  ): ResolvedBlockedWordIndex {
    const cacheKey = this.buildBlockedWordListCacheKey(blockedWords);
    const cached = this.blockedWordListCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const words = [
      ...new Set(
        blockedWords
          .map((item) => this.normalizeMessageLimitsBlockedWordToken(item))
          .filter((item): item is string => Boolean(item)),
      ),
    ].map((blockedWord) => {
      const inflectionRoot = this.resolveMessageLimitsBlockedWordInflectionRoot(blockedWord);
      return {
        blockedWord,
        inflectionRoot,
        prefilterToken: inflectionRoot ?? blockedWord,
      };
    });
    const prefilterRoot: ResolvedBlockedWordTrieNode = {
      children: new Map(),
    };
    const wordsByInflectionRoot = new Map<string, ResolvedBlockedWord[]>();
    const wordsByPrefilterToken = new Map<string, ResolvedBlockedWord[]>();
    let maxPrefilterTokenLength = 0;

    for (const word of words) {
      if (word.inflectionRoot) {
        const existingByRoot = wordsByInflectionRoot.get(word.inflectionRoot) ?? [];
        existingByRoot.push(word);
        wordsByInflectionRoot.set(word.inflectionRoot, existingByRoot);
      }

      const existingByPrefilterToken = wordsByPrefilterToken.get(word.prefilterToken) ?? [];
      existingByPrefilterToken.push(word);
      wordsByPrefilterToken.set(word.prefilterToken, existingByPrefilterToken);
      maxPrefilterTokenLength = Math.max(maxPrefilterTokenLength, word.prefilterToken.length);
      this.insertMessageLimitsBlockedWordPrefilterToken(prefilterRoot, word.prefilterToken);
    }

    const resolved = {
      maxPrefilterTokenLength,
      prefilterRoot,
      words,
      wordsByInflectionRoot,
      wordsByPrefilterToken,
    };

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

  private insertMessageLimitsBlockedWordPrefilterToken(
    root: ResolvedBlockedWordTrieNode,
    token: string,
  ): void {
    let node = root;
    for (const char of token) {
      let nextNode = node.children.get(char);
      if (!nextNode) {
        nextNode = {
          children: new Map(),
        };
        node.children.set(char, nextNode);
      }

      node = nextNode;
    }

    if (!node.terminalTokens) {
      node.terminalTokens = [token];
      return;
    }

    if (!node.terminalTokens.includes(token)) {
      node.terminalTokens.push(token);
    }
  }

  private findMessageLimitsBlockedWordPrefilterTokens(
    compactText: string,
    root: ResolvedBlockedWordTrieNode,
    maxPrefilterTokenLength: number,
  ): Set<string> {
    const matches = new Set<string>();
    if (!compactText || maxPrefilterTokenLength <= 0) {
      return matches;
    }

    for (let start = 0; start < compactText.length; start += 1) {
      let node = root;
      const endLimit = Math.min(compactText.length, start + maxPrefilterTokenLength);
      for (let end = start; end < endLimit; end += 1) {
        const nextNode = node.children.get(compactText[end]);
        if (!nextNode) {
          break;
        }

        node = nextNode;
        for (const token of node.terminalTokens ?? []) {
          matches.add(token);
        }
      }
    }

    return matches;
  }

  private resolveMessageLimitsBlockedWordInflectionRoots(values: readonly string[]): Set<string> {
    const roots = new Set<string>();
    for (const value of values) {
      const root = this.resolveMessageLimitsBlockedWordInflectionRoot(value);
      if (root) {
        roots.add(root);
      }
    }

    return roots;
  }

  private resolveMessageLimitsBlockedWordInflectionRoot(value: string): string | null {
    if (!value) {
      return null;
    }

    if (/^[а-яё]+$/iu.test(value)) {
      return this.resolveCyrillicMessageLimitsBlockedWordInflectionRoot(value);
    }

    if (/^[a-z]+$/iu.test(value)) {
      return this.resolveLatinMessageLimitsBlockedWordInflectionRoot(value);
    }

    return null;
  }

  private resolveCyrillicMessageLimitsBlockedWordInflectionRoot(value: string): string | null {
    for (const suffix of BLOCKED_WORD_CYRILLIC_INFLECTION_SUFFIXES) {
      if (!value.endsWith(suffix)) {
        continue;
      }

      const root = value.slice(0, -suffix.length);
      if (root.length >= BLOCKED_WORD_CYRILLIC_MIN_ROOT_LENGTH) {
        return root;
      }
    }

    if (/[аеёиоуыэюя]$/iu.test(value)) {
      return null;
    }

    return value.length >= BLOCKED_WORD_CYRILLIC_MIN_ROOT_LENGTH ? value : null;
  }

  private resolveLatinMessageLimitsBlockedWordInflectionRoot(value: string): string | null {
    for (const suffix of BLOCKED_WORD_LATIN_INFLECTION_SUFFIXES) {
      if (!value.endsWith(suffix)) {
        continue;
      }

      const root = value.slice(0, -suffix.length);
      if (root.length >= BLOCKED_WORD_LATIN_MIN_ROOT_LENGTH) {
        return root;
      }
    }

    if (/[aeiouy]$/iu.test(value)) {
      return null;
    }

    return value.length >= BLOCKED_WORD_LATIN_MIN_ROOT_LENGTH ? value : null;
  }

  private normalizeMessageLimitsBlockedWordToken(value: string): string | null {
    const candidate = normalizeMessageLimitsBlockedWordCandidate(value);
    return candidate ? this.normalizeMixedWriting(candidate) : null;
  }
}
