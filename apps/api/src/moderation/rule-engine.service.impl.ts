import { Injectable, Optional } from '@nestjs/common';
import type { ChatSettings } from '../prisma/prisma-client';
import { stripUrlsFromText } from '../common/url-text.util';
import { RuntimeDiagnosticsService } from '../system/runtime-diagnostics.service';
import { CommercialAdDetector } from './commercial';
import type { CommercialCampaignContext } from './commercial-campaign.util';
import { isExactProfanityVariant, isTargetedInsultVariant } from './profanity-lexicon';
import { RedisCounterService } from './redis-counter.service';
import { createRuleDetectionContext } from './rule-engine-detection-context';
import { RuleEngineDuplicateDetector } from './rule-engine-duplicate-detector';
import type { DetectionResult, RuleViolation } from './rule-engine.contract';
import {
  createAllowlistLinkMatcher,
  detectBlockedLink,
  extractUrlsFromText,
} from './rule-engine-link-detector';
import {
  extractDetectedPhoneNumbers,
  RuleEngineMessageLimitsDetector,
} from './rule-engine-message-limits.detector';
import {
  MIXED_CHAR_MAP,
  normalizeForDetection,
  normalizeMixedWriting,
} from './rule-engine-normalization';
import {
  createRuleEngineDetectProfile,
  logSlowRuleEngineDetectIfNeeded,
  markRuleEngineDetectStage,
  recordRuleEngineDetectProfile,
} from './rule-engine-profile';
import { detectTopicFilterMismatch } from './rule-engine-topic-filter';

type ProfanityCandidate = {
  value: string;
  joined: boolean;
  rawValue?: string;
  rawIndex?: number;
};

// Keep regexes only for highly productive mat roots. Closed-form insults and slurs
// should come from the exact lexicon so names/surnames with the same prefix do not match.
const PROFANITY_CORE_TOKEN_PATTERNS = [
  /^бля(?:[дт][а-я0-9]*)?$/u,
  /^пизд[а-я0-9]*$/u,
  /^(?:на|по|до|о|а|за|ни|вы|при|под|пере|раз|об)?ху(?:й|е|я|и|ю)[а-я0-9]*$/u,
  /^(?:за|вы|на|по|до|пере|про|об|раз|под|у)?(?:[её]|йо|йе)б(?:а(?:л|ть|н|ш|ч)|е(?:т|шь|м|те)|у(?:т|ч|н)|и(?:сь|т|те)|л(?:ан|о|и)?|н(?:у|ут)|о(?:н|ны)|щ|уч)[а-я0-9]*$/u,
  /^долбо(?:[её]б)[а-я0-9]*$/u,
];
const PROFANITY_LATIN_TOKEN_PATTERNS = [
  /^bl(?:ya|ia)(?:d|t)?[a-z0-9]*$/i,
  /^pizd[a-z0-9]*$/i,
  /^(?:na|po|do|o|a|za|ni|vy|pri|pod|pere|raz|ob)?(?:h|x)(?:u|oo|y)(?:y|j|i|e|ya|yu)[a-z0-9]*$/i,
  /^(?:za|vy|na|po|do|pere|pro|ob|raz|pod|u)?e+b(?:a(?:l|t|n|sh|ch)|e(?:t|sh|m|te)|u(?:t|ch|n)|i(?:s|t|te)|l(?:an|o|i)?|n(?:u|ut)|uch)[a-z0-9]*$/i,
  /^dolboe+b[a-z0-9]*$/i,
];
const PROFANITY_CANINE_FEMALE_FORMS = new Set([
  'сука',
  'суки',
  'суке',
  'суку',
  'сукой',
  'сукою',
  'сучка',
  'сучки',
  'сучке',
  'сучку',
  'сучкой',
  'сучкою',
  'сучек',
  'сучкам',
  'сучками',
  'сучках',
  'сучонок',
  'сучонка',
  'сучонку',
  'сучонком',
  'сучонки',
]);
const PROFANITY_CANINE_CONTEXT_MARKERS = [
  'собак',
  'щен',
  'стерилиз',
  'кастрир',
  'привит',
  'пород',
  'паспорт',
  'в добрые руки',
  'отдается',
  'отдаётся',
  'охранниц',
  'кошк',
  'котят',
  'питомник',
];
const PROFANITY_CANINE_STRONG_CONTEXT_MARKERS = [
  'собак',
  'щен',
  'овчарк',
  'терьер',
  'йоркшир',
  'стерилиз',
  'кастрир',
  'привит',
  'питомник',
  'родословн',
];
const PROFANITY_REACH_TYPO_CONTEXT_MARKERS = [
  'охват',
  'подписчик',
  'подписчиков',
  'размещен',
  'размещение',
  'канал',
  'реклам',
  'пост',
  'спм',
  'cpm',
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
const PROFANITY_LIVESTOCK_STRONG_CONTEXT_MARKERS = [
  'ферм',
  'крс',
  'выпас',
  'пастбищ',
  'коров',
  'быч',
  'телят',
  'овц',
  'коз',
  'свин',
  'хозяйств',
  'ветеринар',
  'привит',
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
const PROFANITY_PARASITE_STRONG_CONTEXT_MARKERS = [
  'мошк',
  'комар',
  'укус',
  'насеком',
  'вош',
  'вши',
  'клещ',
  'паразит',
  'личин',
];
const PROFANITY_GARDEN_PEST_FORMS = new Set([
  'тварь',
  'твари',
  'тварей',
  'тварям',
  'тварями',
  'тварях',
]);
const PROFANITY_GARDEN_PEST_CONTEXT_MARKERS = [
  'клубник',
  'огород',
  'сад',
  'растен',
  'вредител',
  'насеком',
  'жрут',
  'напали',
  'актар',
  'избавиться',
  'урожай',
  'листв',
];
const PROFANITY_GARDEN_PEST_STRONG_CONTEXT_MARKERS = [
  'клубник',
  'огород',
  'сад',
  'растен',
  'вредител',
  'насеком',
  'урожай',
  'листв',
];
const PROFANITY_AXIS_DIMENSION_FORMS = new Set(['хуи', 'хуиз', 'хуизна']);
const PROFANITY_AXIS_DIMENSION_CONTEXT_MARKERS = [
  'осям',
  'ось',
  'координат',
  'габарит',
  'размер',
  'оси',
  'мм',
  'дхш',
  'дхв',
];
const PROFANITY_PROPER_NAME_FORMS = new Set([
  'сукин',
  'сукина',
  'сукину',
  'сукиным',
  'мудаков',
  'дебилов',
  'идиотов',
  'уродов',
  'пидоров',
  'лохов',
  'mudakov',
  'debilov',
  'idiotov',
  'urodov',
  'pidorov',
  'lohov',
  'lokhov',
]);
const PROFANITY_PROPER_NAME_CONTEXT_MARKERS = [
  'фамил',
  'имя',
  'отчеств',
  'паспорт',
  'документ',
  'анкета',
  'резюме',
  'автор',
  'художник',
  'писател',
  'доктор',
  'врач',
  'мастер',
  'тренер',
  'учител',
  'преподавател',
  'директор',
  'менеджер',
  'записан',
  'запись',
  'прием',
  'приём',
  'улиц',
  'переул',
  'проспект',
  'село',
  'деревн',
  'посел',
  'иван',
  'андрей',
  'анна',
  'олег',
  'мария',
  'сергей',
  'петрович',
  'иванович',
  'ivan',
  'anna',
  'andrey',
  'sergey',
  'doctor',
  'достор',
  'street',
  'стреет',
  'author',
  'аутхор',
  'coach',
  'соасх',
];
const PROFANITY_BOTANY_AND_PLACE_FORMS = new Set([
  'лох',
  'лоха',
  'лоху',
  'лохом',
  'лохи',
  'лохов',
  'loh',
  'lohu',
  'lokh',
  'lokhu',
]);
const PROFANITY_BOTANY_AND_PLACE_CONTEXT_MARKERS = [
  'узколист',
  'серебрист',
  'растен',
  'сажен',
  'куст',
  'питомник',
  'ягод',
  'ботан',
  'гербар',
  'сад',
  'несс',
  'шотланд',
  'озер',
  'замок',
  'село',
  'истор',
  'архив',
  'loch ness',
  'plant',
  'garden',
];
const PROFANITY_CLINICAL_FORMS = new Set([
  'дебил',
  'дебила',
  'дебилу',
  'дебилом',
  'дебилы',
  'дебильный',
  'дебильная',
  'дебильное',
  'дебильные',
  'идиот',
  'идиота',
  'идиоту',
  'идиотом',
  'идиоты',
  'идиотизм',
  'идиотизма',
  'идиотизму',
  'имбецил',
  'имбецила',
  'имбецилу',
  'имбецилом',
  'имбецилы',
  'имбецильный',
  'имбецильная',
  'имбецильное',
  'имбецильные',
  'кретин',
  'кретина',
  'кретину',
  'кретином',
  'кретины',
  'дегенерат',
  'дегенерата',
  'дегенерату',
  'дегенератом',
  'дегенераты',
]);
const PROFANITY_CLINICAL_CONTEXT_MARKERS = [
  'мкб',
  'диагноз',
  'диагност',
  'пациент',
  'анамнез',
  'психиатр',
  'невролог',
  'олигофрен',
  'расстройств',
  'синдром',
  'термин',
  'учебник',
  'лекци',
  'истори',
  'медицин',
  'клиник',
  'заключени',
  'справк',
];
const PROFANITY_COMPLETION_FORMS = new Set([
  'конченый',
  'конченая',
  'конченое',
  'конченые',
  'конченный',
  'конченная',
  'конченное',
  'конченные',
  'конченного',
  'конченному',
  'конченную',
  'конченным',
  'конченных',
]);
const PROFANITY_COMPLETION_CONTEXT_MARKERS = [
  'заверш',
  'готов',
  'файл',
  'выгрузк',
  'документ',
  'работ',
  'ремонт',
  'проект',
  'этап',
  'процесс',
  'заказ',
  'архив',
  'строк',
  'статус',
];
const PROFANITY_LITERARY_TITLE_FORMS = new Set(['идиот', 'идиота', 'идиоту', 'идиотом']);
const PROFANITY_LITERARY_TITLE_CONTEXT_MARKERS = [
  'роман',
  'книг',
  'литератур',
  'достоевск',
  'произведени',
  'экранизац',
  'фильм',
  'спектакл',
  'театр',
  'названи',
  'цитат',
  'персонаж',
  'глав',
];
const PROFANITY_LATIN_CULTURAL_NAME_FORMS = new Set([
  'suki',
  'suke',
  'suku',
  'manda',
  'mandi',
  'mande',
  'mandu',
]);
const PROFANITY_LATIN_CULTURAL_NAME_CONTEXT_MARKERS = [
  'sushi',
  'сусхи',
  'roll',
  'tokyo',
  'japan',
  'bali',
  'hotel',
  'хотел',
  'house',
  'хоусе',
  'cafe',
  'restaurant',
  'кафе',
  'ресторан',
  'отель',
  'бренд',
  'блюдо',
  'рис',
  'открыл',
  'открыт',
  'рядом',
  'меню',
  'доставк',
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
  'бл',
  'бля',
  'л',
  'я',
  'д',
  'дь',
  'т',
  'ть',
  'п',
  'пид',
  'пидо',
  'пед',
  'педо',
  'педа',
  'пиз',
  'и',
  'з',
  'х',
  'у',
  'убл',
  'блю',
  'юд',
  'й',
  'е',
  'ё',
  'еб',
  'ебл',
  'еба',
  'ебан',
  'деб',
  'диб',
  'дол',
  'дал',
  'бол',
  'бал',
  'бо',
  'ба',
  'рас',
  'раз',
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
const PROFANITY_LATIN_JOINABLE_TOKENS = new Set([
  'b',
  'bl',
  'bly',
  'l',
  'y',
  'ya',
  'a',
  't',
  'd',
  'p',
  'pi',
  'piz',
  'pid',
  'pido',
  'pedo',
  'ped',
  'h',
  'x',
  'hu',
  'hy',
  'hui',
  'u',
  'e',
  'eb',
  'eba',
  'eban',
  'za',
  'dol',
  'dal',
  'bo',
  'ba',
  'bol',
  'bal',
  'ras',
  'raz',
  'mud',
  'muda',
  'mraz',
  'ub',
  'ubl',
  'blyu',
  'yud',
  'de',
  'deb',
  'di',
  'dib',
  'id',
  'idi',
  'ot',
  'suk',
  'su',
  'ka',
]);
const PROFANITY_JOIN_WINDOW_SEGMENTS = 14;
const PROFANITY_JOIN_MAX_FRAGMENTS = 8;
const PROFANITY_JOIN_NOISE_BUDGET = 12;
const PROFANITY_DIRECT_ADDRESS_MARKERS = new Set([
  'ты',
  'вы',
  'тебя',
  'тебе',
  'тобой',
  'вас',
  'вам',
  'вами',
  'ty',
  'ti',
  'vy',
  'vi',
  'tebya',
  'tebe',
  'vas',
  'vam',
]);
const PROFANITY_TARGET_BRIDGE_TOKENS = new Set([
  'же',
  'ж',
  'прям',
  'прямо',
  'реально',
  'просто',
  'полный',
  'полная',
  'полное',
  'полные',
  'конченый',
  'конченный',
  'конченая',
  'конченная',
  'конченое',
  'конченное',
  'тупой',
  'тупая',
  'тупое',
  'тупые',
  'жалкий',
  'жалкая',
  'жалкое',
  'жалкие',
  'настоящий',
  'настоящая',
  'настоящее',
  'настоящие',
  'какой',
  'какая',
  'какое',
  'какие',
  'все',
  'всё',
  'какой-то',
  'какая-то',
  'какое-то',
  'какие-то',
  'то',
  'vse',
  'same',
  'sam',
  'realno',
  'prosto',
  'polnyy',
  'polnaya',
]);
const PROFANITY_DEMONSTRATIVE_TARGET_MARKERS = new Set(['этот', 'эта', 'эти', 'тот', 'та', 'те']);
const PROFANITY_NEUTRAL_MODIFIER_FORMS = new Set([
  'жирный',
  'жирная',
  'жирное',
  'жирные',
  'глупый',
  'глупая',
  'глупое',
  'глупые',
  'тупой',
  'тупая',
  'тупое',
  'тупые',
]);
const PROFANITY_NEUTRAL_MODIFIER_NOUNS = new Set([
  'шрифт',
  'текст',
  'вопрос',
  'ответ',
  'угол',
  'уголок',
  'инструмент',
  'предмет',
  'вариант',
  'пример',
  'запрос',
]);
const PROFANITY_THIRD_PERSON_TARGET_MARKERS = new Set([
  'он',
  'она',
  'оно',
  'они',
  'его',
  'ее',
  'её',
  'их',
]);
const PROFANITY_THIRD_PERSON_SAFE_TOKENS = new Set([
  'диагноз',
  'синдром',
  'расстройство',
  'термин',
  'порода',
  'ферма',
  'питомник',
  'скот',
]);
const PROFANITY_NEUTRAL_IDENTITY_FORMS = new Set([
  'аутист',
  'аутиста',
  'аутисту',
  'аутистом',
  'аутисты',
  'аутистов',
  'аутистам',
  'аутистами',
  'аутистах',
  'псих',
  'психа',
  'психу',
  'психом',
  'психи',
  'психов',
  'психам',
  'психами',
  'психах',
  'алкоголик',
  'алкоголика',
  'алкоголику',
  'алкоголиком',
  'алкоголики',
  'наркоман',
  'наркомана',
  'наркоману',
  'наркоманом',
  'наркоманы',
]);
const PROFANITY_HOSTILE_AFTER_TARGET_TOKENS = new Set([
  'уйди',
  'вали',
  'свали',
  'заткнись',
  'молчи',
  'исчезни',
  'проваливай',
  'отстань',
  'достал',
  'достала',
  'достали',
  'спамишь',
  'спамит',
  'пишешь',
  'пишет',
  'лезешь',
  'лезет',
  'приперся',
  'приперлась',
  'приперлись',
  'пришел',
  'пришла',
  'пришли',
]);
const DUPLICATE_EXCLUDED_PHONE_PATTERN =
  /(?:^|[^\d])(?:\+?7|8)[\s-]*\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?:$|[^\d])/u;
const DUPLICATE_MIN_LENGTH = 50;
const DUPLICATE_MIN_TOKEN_COUNT = 6;
const DUPLICATE_MIN_UNIQUE_LONG_TOKENS = 4;
const PROFANITY_AMBIGUOUS_MIXED_CHAR_MAP: Record<string, string> = {
  ...MIXED_CHAR_MAP,
  '!': 'и',
  '|': 'и',
  '@': 'я',
  '9': 'я',
  p: 'р',
  u: 'и',
  y: 'я',
};
const PROFANITY_PHONETIC_MIXED_CHAR_MAP: Record<string, string> = {
  ...PROFANITY_AMBIGUOUS_MIXED_CHAR_MAP,
  p: 'п',
};
const PROFANITY_LEET_MIXED_CHAR_MAP: Record<string, string> = {
  ...PROFANITY_AMBIGUOUS_MIXED_CHAR_MAP,
  '3': 'е',
  '4': 'ч',
  '€': 'е',
  '₽': 'р',
  '¥': 'у',
};
const PROFANITY_EXTRA_CHAR_MAP: Record<string, string> = {
  і: 'и',
  ї: 'и',
  є: 'е',
  ґ: 'г',
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
  '€': 'e',
  '₽': 'p',
  '¥': 'y',
};

@Injectable()
export class RuleEngineService {
  private readonly duplicateDetector: RuleEngineDuplicateDetector;
  private readonly messageLimitsDetector: RuleEngineMessageLimitsDetector;
  private readonly commercialAdDetector = new CommercialAdDetector();

  constructor(
    private readonly redisCounter: RedisCounterService,
    @Optional() private readonly runtimeDiagnosticsService?: RuntimeDiagnosticsService,
  ) {
    this.duplicateDetector = new RuleEngineDuplicateDetector(redisCounter);
    this.messageLimitsDetector = new RuleEngineMessageLimitsDetector(redisCounter);
  }

  async detect(params: {
    chatId: string;
    userId: string;
    messageId?: string;
    text: string;
    settings: ChatSettings;
    domainAllowlist: string[];
    effectiveLength?: number;
    hasPhotoAttachment?: boolean;
    hasStickerAttachment?: boolean;
    hasVideoAttachment?: boolean;
    hasFileAttachment?: boolean;
    hasVoiceAttachment?: boolean;
    hasMediaBatch?: boolean;
    skipAntiSpamBurstLimit?: boolean;
    skipDuplicateState?: boolean;
    skipStatefulMessageLimits?: boolean;
    commercialCampaignContext?: CommercialCampaignContext | null;
  }): Promise<DetectionResult> {
    const {
      chatId,
      userId,
      messageId,
      text,
      settings,
      domainAllowlist,
      effectiveLength,
      hasPhotoAttachment,
      hasStickerAttachment,
      hasVideoAttachment,
      hasFileAttachment,
      hasVoiceAttachment,
      hasMediaBatch,
      skipAntiSpamBurstLimit,
      skipDuplicateState,
      skipStatefulMessageLimits,
      commercialCampaignContext,
    } = params;
    const hasAntiSpamBurstExcludedAttachment = Boolean(
      hasPhotoAttachment ||
      hasVideoAttachment ||
      hasFileAttachment ||
      hasVoiceAttachment ||
      hasMediaBatch,
    );
    const profile = createRuleEngineDetectProfile();
    const violations: RuleViolation[] = [];
    const detectionContext = createRuleDetectionContext({
      text,
      settings,
      effectiveLength,
    });
    markRuleEngineDetectStage(profile, 'normalize');

    if (settings.russianProfanityFilterEnabled && this.hasProfanity(text)) {
      violations.push({
        ruleCode: 'PROFANITY',
        score: 0.95,
        reason: 'Detected profanity or abusive language pattern',
      });
    }
    markRuleEngineDetectStage(profile, 'profanity');

    if (settings.commercialAdsFilterEnabled) {
      const commercial = this.commercialAdDetector.detect({
        normalizedText: detectionContext.normalizedText,
        rawLoweredText: detectionContext.rawLoweredText,
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
            decisionVersion: commercial.decisionVersion,
            score: commercial.score,
            actionScore: commercial.actionScore,
            fpRisk: commercial.fpRisk,
            policyFpRisk: commercial.policyFpRisk,
            evidenceTier: commercial.evidenceTier,
            subtype: commercial.subtype,
            actionBand: commercial.actionBand,
            reviewPriority: commercial.reviewPriority,
            campaignStrength: commercial.campaignStrength,
            safeContextBucket: commercial.safeContextBucket,
            actionable: commercial.actionable,
            recordable: commercial.recordable,
            deleteSuppressed: commercial.deleteSuppressed,
            suppressionReasons: commercial.suppressionReasons,
            reasonCodes: commercial.reasonCodes,
            featureVector: commercial.featureVector,
          },
        });
      }
    }
    markRuleEngineDetectStage(profile, 'commercial-ad');

    const topicMismatch = detectTopicFilterMismatch({
      rawText: text,
      measuredLength: detectionContext.measuredLength,
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
    markRuleEngineDetectStage(profile, 'topic-filter');

    const allowlistLinkMatcher =
      domainAllowlist.length > 0 ? createAllowlistLinkMatcher(domainAllowlist) : undefined;
    const linkViolation = detectBlockedLink(
      text,
      settings.linkPolicy,
      domainAllowlist,
      allowlistLinkMatcher,
    );
    if (linkViolation) {
      violations.push({ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: linkViolation });
    }
    markRuleEngineDetectStage(profile, 'links');

    const messageLengthViolation = this.messageLimitsDetector.detectMessageLengthLimit({
      measuredLength: detectionContext.measuredLength,
      settings,
    });
    if (messageLengthViolation) {
      violations.push(messageLengthViolation);
    }
    markRuleEngineDetectStage(profile, 'message-length');

    const antiSpamViolation = skipStatefulMessageLimits
      ? null
      : await this.messageLimitsDetector.detectAntiSpamBurstLimit({
          chatId,
          userId,
          messageId,
          settings,
          hasExcludedAttachment: hasAntiSpamBurstExcludedAttachment,
          skipAntiSpamBurstLimit,
        });
    if (antiSpamViolation) {
      violations.push(antiSpamViolation);
    }
    markRuleEngineDetectStage(profile, 'anti-spam-burst');

    const messageCountViolation = skipStatefulMessageLimits
      ? null
      : await this.messageLimitsDetector.detectMessageCountLimit({
          chatId,
          userId,
          messageId,
          settings,
        });
    if (messageCountViolation) {
      violations.push(messageCountViolation);
    }
    markRuleEngineDetectStage(profile, 'message-count-limit');

    const blockedWordViolation = this.messageLimitsDetector.detectBlockedWordLimit({
      text,
      settings,
    });
    if (blockedWordViolation) {
      violations.push(blockedWordViolation);
    }
    markRuleEngineDetectStage(profile, 'blocked-words');

    const blockedDomainViolation = this.messageLimitsDetector.detectBlockedDomainLimit({
      text,
      settings,
      isLinkAllowlisted: allowlistLinkMatcher,
    });
    if (blockedDomainViolation) {
      violations.push(blockedDomainViolation);
    }
    markRuleEngineDetectStage(profile, 'blocked-domains');

    const phoneNumberViolation = this.messageLimitsDetector.detectPhoneNumberLimit({
      text,
      settings,
    });
    if (phoneNumberViolation) {
      violations.push(phoneNumberViolation);
    }
    markRuleEngineDetectStage(profile, 'phone-numbers');

    violations.push(
      ...this.messageLimitsDetector.detectAttachmentLimits({
        settings,
        hasPhotoAttachment,
        hasVideoAttachment,
        hasFileAttachment,
        hasVoiceAttachment,
      }),
    );
    markRuleEngineDetectStage(profile, 'attachments');

    const duplicateCandidate =
      settings.antiDuplicateEnabled &&
      violations.length === 0 &&
      !linkViolation &&
      this.shouldTrackDuplicate(text, detectionContext.compactText, settings);
    markRuleEngineDetectStage(profile, 'duplicate-precheck');
    const duplicateState =
      duplicateCandidate && !skipDuplicateState && !skipStatefulMessageLimits
        ? await this.duplicateDetector.detectWithin({
            chatId,
            userId,
            messageId,
            rawText: text,
            compactText: detectionContext.compactText,
            settings,
          })
        : undefined;
    markRuleEngineDetectStage(profile, 'duplicate-state');

    if (
      violations.length === 0 &&
      !duplicateState?.hit &&
      !duplicateState?.decision &&
      !skipStatefulMessageLimits
    ) {
      violations.push(
        ...(await this.messageLimitsDetector.detectMediaCooldownLimits({
          chatId,
          userId,
          messageId,
          settings,
          hasPhotoAttachment,
          hasStickerAttachment,
        })),
      );
    }

    logSlowRuleEngineDetectIfNeeded({
      chatId,
      userId,
      measuredLength: detectionContext.measuredLength,
      settings,
      violationsCount: violations.length,
      duplicateCandidate,
      profile,
    });
    recordRuleEngineDetectProfile(profile, this.runtimeDiagnosticsService);

    return {
      violations,
      ...(duplicateState?.hit ? { duplicateHit: duplicateState.hit } : {}),
      ...(duplicateState?.decision ? { duplicateDecision: duplicateState.decision } : {}),
      ...(skipDuplicateState ? { duplicateStateSkipped: true } : {}),
    };
  }

  hasCommercialSpamMarkers(text: string): boolean {
    return this.commercialAdDetector.hasCommercialSpamMarkers(text);
  }

  private hasProfanity(text: string): boolean {
    const normalizedContext = this.normalizeForDetection(stripUrlsFromText(text));
    const latinTargetContext = this.normalizeProfanityLatinContext(stripUrlsFromText(text));
    const candidates = this.extractProfanityCandidates(text);
    for (const candidate of candidates) {
      for (const normalizedCandidate of this.buildProfanityCyrillicCandidates(candidate.value)) {
        if (!normalizedCandidate || this.isProfanityException(normalizedCandidate)) {
          continue;
        }

        if (
          this.isContextualProfanityException(normalizedCandidate, normalizedContext) ||
          this.matchesJoinedNotationException(normalizedCandidate, normalizedContext, candidate) ||
          this.matchesProperNameCapitalizationException(normalizedCandidate, text, candidate)
        ) {
          continue;
        }

        if (
          this.isProfanityToken(normalizedCandidate) ||
          isExactProfanityVariant(normalizedCandidate)
        ) {
          return true;
        }

        if (
          isTargetedInsultVariant(normalizedCandidate) &&
          this.matchesTargetedInsultContext(normalizedCandidate, normalizedContext, candidate)
        ) {
          return true;
        }
      }

      for (const normalizedLatinCandidate of this.buildProfanityLatinCandidates(candidate.value)) {
        if (
          normalizedLatinCandidate &&
          isTargetedInsultVariant(normalizedLatinCandidate) &&
          this.matchesTargetedInsultContext(normalizedLatinCandidate, latinTargetContext, candidate)
        ) {
          return true;
        }

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
      this.matchesProfanityReachTypoException(token, normalizedContext) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_CANINE_FEMALE_FORMS,
        PROFANITY_CANINE_STRONG_CONTEXT_MARKERS,
        1,
      ) ||
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
        PROFANITY_LIVESTOCK_STRONG_CONTEXT_MARKERS,
        1,
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
        PROFANITY_PARASITE_STRONG_CONTEXT_MARKERS,
        1,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_PARASITE_FORMS,
        PROFANITY_PARASITE_CONTEXT_MARKERS,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_GARDEN_PEST_FORMS,
        PROFANITY_GARDEN_PEST_STRONG_CONTEXT_MARKERS,
        1,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_GARDEN_PEST_FORMS,
        PROFANITY_GARDEN_PEST_CONTEXT_MARKERS,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_AXIS_DIMENSION_FORMS,
        PROFANITY_AXIS_DIMENSION_CONTEXT_MARKERS,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_PROPER_NAME_FORMS,
        PROFANITY_PROPER_NAME_CONTEXT_MARKERS,
        1,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_BOTANY_AND_PLACE_FORMS,
        PROFANITY_BOTANY_AND_PLACE_CONTEXT_MARKERS,
        1,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_CLINICAL_FORMS,
        PROFANITY_CLINICAL_CONTEXT_MARKERS,
        1,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_COMPLETION_FORMS,
        PROFANITY_COMPLETION_CONTEXT_MARKERS,
        2,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_LITERARY_TITLE_FORMS,
        PROFANITY_LITERARY_TITLE_CONTEXT_MARKERS,
        1,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_LATIN_CULTURAL_NAME_FORMS,
        PROFANITY_LATIN_CULTURAL_NAME_CONTEXT_MARKERS,
        1,
      )
    );
  }

  private matchesProfanityContextException(
    token: string,
    normalizedContext: string,
    forms: ReadonlySet<string>,
    markers: readonly string[],
    minimumMatchedMarkers = 2,
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
      if (matchedMarkers >= minimumMatchedMarkers) {
        return true;
      }
    }

    return false;
  }

  private matchesProfanityReachTypoException(token: string, normalizedContext: string): boolean {
    if (
      token !== 'суки' ||
      !/(?:^|[^\p{L}\p{N}_-])за\s+суки(?=$|[^\p{L}\p{N}_-])/u.test(normalizedContext)
    ) {
      return false;
    }

    let matchedMarkers = 0;
    for (const marker of PROFANITY_REACH_TYPO_CONTEXT_MARKERS) {
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

  private matchesJoinedNotationException(
    token: string,
    normalizedContext: string,
    candidate: ProfanityCandidate,
  ): boolean {
    const isNotationLikeToken =
      token === 'бля' ||
      token.startsWith('хуй') ||
      token.startsWith('хуи');
    if (!candidate.joined || !isNotationLikeToken) {
      return false;
    }

    const hasNotationContext =
      normalizedContext.includes('инициал') ||
      normalizedContext.includes('маркировк') ||
      normalizedContext.includes('схем') ||
      normalizedContext.includes('анкете') ||
      normalizedContext.includes('код ');

    if (!hasNotationContext) {
      return false;
    }

    return !this.hasDirectProfanityAddressContext(normalizedContext);
  }

  private hasDirectProfanityAddressContext(normalizedContext: string): boolean {
    const tokens = normalizedContext
      .replace(/[^\p{L}\p{N}-]+/gu, ' ')
      .split(/\s+/u)
      .filter(Boolean);

    return tokens.some(
      (token) =>
        PROFANITY_DIRECT_ADDRESS_MARKERS.has(token) ||
        PROFANITY_HOSTILE_AFTER_TARGET_TOKENS.has(token),
    );
  }

  private matchesProperNameCapitalizationException(
    token: string,
    rawText: string,
    candidate: ProfanityCandidate,
  ): boolean {
    if (
      candidate.joined ||
      candidate.rawIndex === undefined ||
      !PROFANITY_PROPER_NAME_FORMS.has(token)
    ) {
      return false;
    }

    const before = rawText.slice(0, candidate.rawIndex);
    const after = rawText.slice(candidate.rawIndex + (candidate.rawValue?.length ?? 0));
    const previousWord = before.match(/[\p{L}][\p{L}-]*\s*$/u)?.[0]?.trim() ?? '';
    const nextWord = after.match(/^\s*[\p{L}][\p{L}-]*/u)?.[0]?.trim() ?? '';

    return this.isCapitalizedCyrillicName(previousWord) || this.isCapitalizedCyrillicName(nextWord);
  }

  private isCapitalizedCyrillicName(value: string): boolean {
    return /^[А-ЯЁ][а-яё]{1,}(?:-[А-ЯЁ][а-яё]{1,})?$/u.test(value);
  }

  private matchesTargetedInsultContext(
    token: string,
    normalizedContext: string,
    candidate: ProfanityCandidate,
  ): boolean {
    if (candidate.joined) {
      return true;
    }

    const tokens = normalizedContext
      .replace(/[^\p{L}\p{N}-]+/gu, ' ')
      .split(/\s+/u)
      .filter(Boolean);
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index] !== token) {
        continue;
      }

      if (this.isNeutralTargetedModifier(tokens, index, token)) {
        continue;
      }

      if (
        this.hasDirectAddressBeforeTarget(tokens, index) ||
        this.hasDirectAddressAfterTarget(tokens, index) ||
        this.hasDemonstrativeHostileTarget(tokens, index) ||
        this.hasThirdPersonInsultTarget(tokens, index, token) ||
        this.hasHostileCommandAfterTarget(tokens, index)
      ) {
        return true;
      }
    }

    return false;
  }

  private isNeutralTargetedModifier(
    tokens: readonly string[],
    targetIndex: number,
    token: string,
  ): boolean {
    if (!PROFANITY_NEUTRAL_MODIFIER_FORMS.has(token)) {
      return false;
    }

    const next = tokens[targetIndex + 1];
    return Boolean(next && PROFANITY_NEUTRAL_MODIFIER_NOUNS.has(next));
  }

  private hasDirectAddressBeforeTarget(tokens: readonly string[], targetIndex: number): boolean {
    for (let index = targetIndex - 1; index >= Math.max(0, targetIndex - 5); index -= 1) {
      const token = tokens[index];
      if (!token) {
        continue;
      }

      if (PROFANITY_DIRECT_ADDRESS_MARKERS.has(token)) {
        return true;
      }

      if (!PROFANITY_TARGET_BRIDGE_TOKENS.has(token)) {
        return false;
      }
    }

    return false;
  }

  private hasDirectAddressAfterTarget(tokens: readonly string[], targetIndex: number): boolean {
    for (
      let index = targetIndex + 1;
      index <= Math.min(tokens.length - 1, targetIndex + 4);
      index += 1
    ) {
      const token = tokens[index];
      if (!token) {
        continue;
      }

      if (PROFANITY_DIRECT_ADDRESS_MARKERS.has(token)) {
        return true;
      }

      if (!PROFANITY_TARGET_BRIDGE_TOKENS.has(token)) {
        return false;
      }
    }

    return false;
  }

  private hasDemonstrativeHostileTarget(tokens: readonly string[], targetIndex: number): boolean {
    const previous = tokens[targetIndex - 1];
    if (!previous || !PROFANITY_DEMONSTRATIVE_TARGET_MARKERS.has(previous)) {
      return false;
    }

    for (
      let index = targetIndex + 1;
      index <= Math.min(tokens.length - 1, targetIndex + 3);
      index += 1
    ) {
      const token = tokens[index];
      if (token && PROFANITY_HOSTILE_AFTER_TARGET_TOKENS.has(token)) {
        return true;
      }
    }

    return false;
  }

  private hasThirdPersonInsultTarget(
    tokens: readonly string[],
    targetIndex: number,
    token: string,
  ): boolean {
    if (PROFANITY_NEUTRAL_IDENTITY_FORMS.has(token)) {
      return false;
    }

    let sawTargetMarker = false;
    for (let index = targetIndex - 1; index >= Math.max(0, targetIndex - 4); index -= 1) {
      const current = tokens[index];
      if (!current) {
        continue;
      }

      if (PROFANITY_THIRD_PERSON_SAFE_TOKENS.has(current)) {
        return false;
      }

      if (PROFANITY_THIRD_PERSON_TARGET_MARKERS.has(current)) {
        sawTargetMarker = true;
        continue;
      }

      if (!PROFANITY_TARGET_BRIDGE_TOKENS.has(current)) {
        break;
      }
    }

    return sawTargetMarker;
  }

  private hasHostileCommandAfterTarget(tokens: readonly string[], targetIndex: number): boolean {
    for (
      let index = targetIndex + 1;
      index <= Math.min(tokens.length - 1, targetIndex + 3);
      index += 1
    ) {
      const token = tokens[index];
      if (!token) {
        continue;
      }

      if (PROFANITY_HOSTILE_AFTER_TARGET_TOKENS.has(token)) {
        return true;
      }

      if (!PROFANITY_TARGET_BRIDGE_TOKENS.has(token)) {
        return false;
      }
    }

    return false;
  }

  private shouldTrackDuplicate(
    rawText: string,
    compactText: string,
    settings: ChatSettings,
  ): boolean {
    const detectedPhoneCount = extractDetectedPhoneNumbers(rawText).length;
    const hasPhone = detectedPhoneCount > 0 || DUPLICATE_EXCLUDED_PHONE_PATTERN.test(rawText);
    const isCustomDuplicateMode = settings.duplicateDetectionPreset === 'CUSTOM';
    const duplicateIgnoresPhones = settings.duplicateDetectionPreset === 'STRICT';
    const duplicateMatchesPhoneValues =
      isCustomDuplicateMode && settings.duplicateIgnorePhonesEnabled;
    if (hasPhone && !isCustomDuplicateMode && !duplicateIgnoresPhones) {
      return false;
    }

    const hasUrl = extractUrlsFromText(rawText).length > 0;
    const duplicateMatchesLinkValues =
      isCustomDuplicateMode && settings.duplicateIgnoreLinksEnabled;
    if ((hasUrl && duplicateMatchesLinkValues) || (hasPhone && duplicateMatchesPhoneValues)) {
      return true;
    }

    const shouldBuildContentCandidate = hasUrl || (hasPhone && duplicateIgnoresPhones);
    let candidateText = compactText;

    if (shouldBuildContentCandidate) {
      let rawCandidate = rawText;
      if (hasUrl) {
        rawCandidate = stripUrlsFromText(rawCandidate);
      }
      if (hasPhone && duplicateIgnoresPhones) {
        rawCandidate = rawCandidate.replace(DUPLICATE_EXCLUDED_PHONE_PATTERN, ' ');
      }
      candidateText = this.normalizeForDetection(rawCandidate);
    }

    if (!candidateText) {
      return false;
    }

    if (this.commercialAdDetector.hasCommercialSpamMarkers(candidateText)) {
      return true;
    }

    const tokens = this.extractTokens(candidateText);
    if (tokens.length < DUPLICATE_MIN_TOKEN_COUNT || candidateText.length < DUPLICATE_MIN_LENGTH) {
      return false;
    }

    const uniqueLongTokens = new Set(tokens.filter((token) => token.length >= 4)).size;
    return uniqueLongTokens >= DUPLICATE_MIN_UNIQUE_LONG_TOKENS;
  }

  private normalizeForDetection(value: string): string {
    return normalizeForDetection(value);
  }

  private extractProfanityCandidates(value: string): ProfanityCandidate[] {
    if (!value) {
      return [];
    }

    const rawStripped = this.normalizeProfanityUnicode(stripUrlsFromText(value));
    const stripped = rawStripped.toLowerCase();
    const whitespaceSegments = [...rawStripped.matchAll(/\S+/gu)];
    const candidates: ProfanityCandidate[] = [];
    const seenCandidates = new Set<string>();
    const pushCandidate = (candidate: ProfanityCandidate) => {
      const key = `${candidate.joined ? '1' : '0'}:${candidate.value}`;
      if (seenCandidates.has(key)) {
        return;
      }

      seenCandidates.add(key);
      candidates.push(candidate);
    };

    for (const match of whitespaceSegments) {
      const rawSegment = match[0];
      pushCandidate({
        value: rawSegment.toLowerCase(),
        joined: false,
        rawValue: rawSegment,
        rawIndex: match.index,
      });
    }

    const joinSegments =
      stripped.match(/[\p{L}\p{N}@!|$]+|[^\s\p{L}\p{N}]+/gu)?.filter(Boolean) ?? [];

    for (let index = 0; index < joinSegments.length; index += 1) {
      let joinedCandidate = '';
      let joinedCount = 0;
      let noiseCount = 0;

      for (
        let cursor = index;
        cursor < joinSegments.length && cursor < index + PROFANITY_JOIN_WINDOW_SEGMENTS;
        cursor += 1
      ) {
        const segment = joinSegments[cursor] ?? '';
        const normalizedToken = this.normalizeProfanityJoinToken(segment);
        if (normalizedToken) {
          joinedCandidate += normalizedToken;
          joinedCount += 1;
          if (joinedCount >= 2) {
            pushCandidate({ value: joinedCandidate, joined: true, rawValue: joinedCandidate });
          }
          if (joinedCount >= PROFANITY_JOIN_MAX_FRAGMENTS) {
            break;
          }
          continue;
        }

        if (joinedCount === 0 || !this.isProfanityJoinNoiseSegment(segment)) {
          break;
        }

        noiseCount += Array.from(segment).length;
        if (noiseCount > PROFANITY_JOIN_NOISE_BUDGET) {
          break;
        }
      }
    }

    return candidates;
  }

  private normalizeProfanityCandidate(value: string): string {
    if (!value) {
      return '';
    }

    let normalized = this.normalizeProfanityUnicode(value.toLowerCase());
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
      const primaryMapped = this.normalizeProfanityCandidateWithMap(value, MIXED_CHAR_MAP);
      if (primaryMapped) {
        candidates.add(primaryMapped);
      }

      const ambiguous = this.normalizeProfanityCandidateWithMap(
        value,
        PROFANITY_AMBIGUOUS_MIXED_CHAR_MAP,
      );
      if (ambiguous) {
        candidates.add(ambiguous);
      }

      const phonetic = this.normalizeProfanityCandidateWithMap(
        value,
        PROFANITY_PHONETIC_MIXED_CHAR_MAP,
      );
      if (phonetic) {
        candidates.add(phonetic);
      }

      const leet = this.normalizeProfanityCandidateWithMap(value, PROFANITY_LEET_MIXED_CHAR_MAP);
      if (leet) {
        candidates.add(leet);
      }
    }

    return [...candidates];
  }

  private shouldBuildAmbiguousProfanityCandidate(value: string): boolean {
    return (
      /[а-яёіїєґ@!|€₽¥]/iu.test(value) &&
      /[a-z0-9@!|€₽¥]/iu.test(value)
    );
  }

  private normalizeProfanityCandidateWithMap(
    value: string,
    charMap: Readonly<Record<string, string>>,
  ): string {
    if (!value) {
      return '';
    }

    let normalized = '';
    for (const char of this.normalizeProfanityUnicode(value.toLowerCase())) {
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

    let normalized = this.normalizeProfanityUnicode(value.toLowerCase());
    normalized = normalized.replace(/([a-z0-9])\1{2,}/g, '$1$1');
    normalized = normalized.replace(/[^a-z0-9]+/g, '');
    return normalized;
  }

  private normalizeProfanityLatinContext(value: string): string {
    if (!value) {
      return '';
    }

    let normalized = this.normalizeProfanityUnicode(value.toLowerCase());
    normalized = normalized.replace(/([a-z0-9])\1{2,}/g, '$1$1');
    normalized = normalized.replace(/[^a-z0-9-]+/g, ' ');
    normalized = normalized.replace(/\s+/g, ' ').trim();
    return normalized;
  }

  private buildProfanityLatinCandidates(value: string): string[] {
    if (!value || !this.shouldBuildLatinProfanityCandidate(value)) {
      return [];
    }

    const candidates = new Set<string>();
    const normalized = this.normalizeProfanityLatinCandidate(value);
    if (normalized) {
      candidates.add(normalized);
    }

    if (this.shouldBuildLatinLeetProfanityCandidate(value)) {
      const leetNormalized = this.normalizeProfanityLatinLeetCandidate(value);
      if (leetNormalized) {
        candidates.add(leetNormalized);
      }
    }

    return [...candidates];
  }

  private shouldBuildLatinProfanityCandidate(value: string): boolean {
    return /[a-z]/i.test(value);
  }

  private shouldBuildLatinLeetProfanityCandidate(value: string): boolean {
    return /[a-z]/i.test(value) && /[013456789@!|$]/.test(value);
  }

  private normalizeProfanityLatinLeetCandidate(value: string): string {
    if (!value) {
      return '';
    }

    let normalized = '';
    for (const char of this.normalizeProfanityUnicode(value.toLowerCase())) {
      const mapped = PROFANITY_LATIN_LEET_CHAR_MAP[char] ?? char;
      if (/[a-z0-9]/i.test(mapped)) {
        normalized += mapped;
      }
    }

    normalized = normalized.replace(/([a-z0-9])\1{2,}/g, '$1$1');
    return normalized;
  }

  private normalizeProfanityJoinToken(value: string): string {
    if (!/[a-zа-яё0-9]/iu.test(value)) {
      const symbolLeetNormalized = this.normalizeProfanityLatinLeetCandidate(value);
      return this.isLatinProfanityJoinToken(symbolLeetNormalized) ? symbolLeetNormalized : '';
    }

    for (const normalized of this.buildProfanityCyrillicCandidates(value)) {
      if (this.isCyrillicProfanityJoinToken(normalized)) {
        return normalized;
      }
    }

    const latinNormalized = this.normalizeProfanityLatinLeetCandidate(value);
    return this.isLatinProfanityJoinToken(latinNormalized) ? latinNormalized : '';
  }

  private isCyrillicProfanityJoinToken(value: string): boolean {
    return (
      /^[а-яё0-9]+$/iu.test(value) &&
      (value.length <= 2 || PROFANITY_SHORT_JOINABLE_TOKENS.has(value))
    );
  }

  private isLatinProfanityJoinToken(value: string): boolean {
    return (
      /^[a-z0-9]+$/i.test(value) &&
      (value.length <= 2 || PROFANITY_LATIN_JOINABLE_TOKENS.has(value))
    );
  }

  private isProfanityJoinNoiseSegment(value: string): boolean {
    return value.length > 0 && !/[\p{L}\p{N}@!|$]/u.test(value);
  }

  private normalizeMixedWritingForProfanity(value: string): string {
    return value.replace(/[\p{L}\p{N}]+/gu, (token) => this.normalizeProfanityToken(token));
  }

  private normalizeProfanityToken(token: string): string {
    const lowered = this.normalizeProfanityUnicode(token.toLowerCase());
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

      result += MIXED_CHAR_MAP[char] ?? PROFANITY_EXTRA_CHAR_MAP[char] ?? char;
    }

    return result;
  }

  private normalizeProfanityUnicode(value: string): string {
    if (!value) {
      return '';
    }

    return value
      .normalize('NFKC')
      .replace(/[\u0300-\u036f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '');
  }

  private normalizeMixedWriting(value: string): string {
    return normalizeMixedWriting(value);
  }

  private extractTokens(value: string): string[] {
    const normalized = this.normalizeForDetection(value);
    return normalized.match(/[a-zа-яё0-9]+/giu) ?? [];
  }
}
