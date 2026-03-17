import { Injectable } from '@nestjs/common';
import { normalizeAllowlistLink } from '@maxim/contracts';
import { CommercialAdsSensitivity, LinkPolicy, type ChatSettings } from '@prisma/client';
import { createHash } from 'node:crypto';
import { extractUrlsFromText as extractTextUrls } from '../common/url-text.util';
import { RedisCounterService } from './redis-counter.service';

export type CommercialDecisionBand = 'LOW' | 'MEDIUM' | 'HIGH';

export type RuleViolation = {
  ruleCode: string;
  score: number;
  reason: string;
  metadata?: Record<string, unknown>;
};

export type DuplicateAction = 'WARN' | 'KICK' | 'BAN';

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
};

type DuplicateStageName = 'warn' | 'kick' | 'ban';

type DuplicateStage = {
  name: DuplicateStageName;
  action: DuplicateAction;
  windowSec: number;
  threshold: number;
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
  };
};

type CommercialSignalState = {
  score: number;
  matchedSignals: string[];
  negativeSignals: string[];
  hasIntent: boolean;
  hasPrice: boolean;
  hasContact: boolean;
  hasDealChannel: boolean;
  hasTransactional: boolean;
  hasStrongNegativeContext: boolean;
};

type TopicFilterDetection = {
  mode: 'CODEWORD';
  messageLength: number;
  requiredCodeword: string;
  messageFirstToken: string | null;
};

const PROFANITY_CORE_TOKEN_PATTERNS = [
  /^бля[а-я0-9]*$/u,
  /^пизд[а-я0-9]*$/u,
  /^(?:на|по|до|о|за|ни|вы)?ху[йеяиё][а-я0-9]*$/u,
  /^(?:за|вы|на|по|до|пере|про|об|раз|под|у)?[её]б[а-я0-9]*$/u,
  /^долбо[её]б[а-я0-9]*$/u,
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
const PROFANITY_OBFUSCATED_PATTERNS = [
  /(?:^|[^\p{L}\p{N}])б(?:[^\p{L}\p{N}]{0,3})л(?:[^\p{L}\p{N}]{0,3})[яе](?:[^\p{L}\p{N}]{0,3})[дт]/iu,
  /(?:^|[^\p{L}\p{N}])(?:на|по|до|о|за|ни|вы)?х(?:[^\p{L}\p{N}]{0,3})у(?:[^\p{L}\p{N}]{0,3})[йиея]/iu,
  /(?:^|[^\p{L}\p{N}])п(?:[^\p{L}\p{N}]{0,3})и(?:[^\p{L}\p{N}]{0,3})з(?:[^\p{L}\p{N}]{0,3})д/iu,
  /(?:^|[^\p{L}\p{N}])(?:за|вы|на|по|до|пере|про|об|раз|под|у)?[её](?:[^\p{L}\p{N}]{0,3})б(?:[^\p{L}\p{N}]{0,3})[аоуыиеё]/iu,
  /(?:^|[^\p{L}\p{N}])д(?:[^\p{L}\p{N}]{0,3})о(?:[^\p{L}\p{N}]{0,3})л(?:[^\p{L}\p{N}]{0,3})б(?:[^\p{L}\p{N}]{0,3})о(?:[^\p{L}\p{N}]{0,3})[её](?:[^\p{L}\p{N}]{0,3})б/iu,
  /(?:^|[^\p{L}\p{N}])у(?:[^\p{L}\p{N}]{0,3})[её](?:[^\p{L}\p{N}]{0,3})б(?:[^\p{L}\p{N}]{0,3})[аоуыиеё]/iu,
];
const ADS_INTENT_MARKERS = [
  'продам',
  'продаю',
  'продажа',
  'продается',
  'продаётся',
  'куплю',
  'купите',
  'сдам',
  'сдаю',
  'аренда',
  'запись',
  'записывайтесь',
  'услуга',
  'услуги',
  'на заказ',
  'заказ',
  'прайс',
  'прайс-лист',
  'прайс лист',
  'коммерция',
];
const ADS_PROMO_MARKERS = [
  'промокод',
  'скидк',
  'акци',
  'распродаж',
  'доставк',
  'в наличии',
  'опт',
  'розниц',
  'остатк',
];
const ADS_CONTACT_MARKERS = [
  'пишите в лс',
  'пишите в лич',
  'в лс',
  'в личк',
  'в директ',
  'директ',
  'звоните',
  'пишите',
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
  'кто подскажет',
  'ищу совет',
  'посоветуйте',
];
const ADS_QUESTION_CONTEXT_MARKERS = ['кто подскажет', 'посоветуйте', 'как лучше', 'что выбрать'];
const ADS_LINK_PATTERN = /(https?:\/\/|t\.me\/|max\.ru\/|vk\.com\/|wa\.me\/|taplink|avito|youla)/iu;
const ADS_PRICE_PATTERN = /\b\d{2,}\s?(₽|руб(\.|лей)?|р\.|р|₸|\$|€)\b/iu;
const ADS_TRANSACTIONAL_PATTERN = /\b(цена|стоимость|оплата|предоплата|доставка|в наличии)\b/iu;
const ADS_URGENCY_PATTERN = /\b(срочно|только сегодня|до конца дня|осталось\s+\d+)\b/iu;
const ADS_QUANTITY_PATTERN = /\b(шт|штук|шт\.|пачк|упак|остатк|места)\b/iu;
const ADS_PHONE_PATTERN = /\b(?:\+7|8)\s*\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b/u;
const DUPLICATE_EXCLUDED_PHONE_PATTERN =
  /(?:^|[^\d])(?:\+7|8)\s*\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?:$|[^\d])/u;
const THEMATIC_CODEWORD_MIN_LENGTH = 90;
const DEFAULT_DUPLICATE_WINDOW_SEC = 60;
const DUPLICATE_MIN_LENGTH = 50;
const DUPLICATE_MIN_TOKEN_COUNT = 6;
const DUPLICATE_MIN_UNIQUE_LONG_TOKENS = 4;
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
  constructor(private readonly redisCounter: RedisCounterService) {}

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
    } = params;
    const violations: RuleViolation[] = [];
    const normalized = this.normalizeForDetection(text);
    const lowered = text.toLowerCase();
    const measuredLength = typeof effectiveLength === 'number' ? effectiveLength : text.length;

    if (settings.russianProfanityFilterEnabled && this.hasProfanity(normalized)) {
      violations.push({ ruleCode: 'PROFANITY', score: 0.95, reason: 'Detected profanity pattern' });
    }

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

    const linkViolation = this.hasBlockedLink(text, settings.linkPolicy, domainAllowlist);
    if (linkViolation) {
      violations.push({ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: linkViolation });
    }

    if (settings.maxMessageLengthEnabled && measuredLength > settings.maxMessageLength) {
      violations.push({
        ruleCode: 'MESSAGE_TOO_LONG',
        score: 0.82,
        reason: `Message length ${measuredLength} exceeds limit ${settings.maxMessageLength}`,
      });
    }

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

    const compactText = normalized.replace(/\s+/g, ' ').trim();
    const hasOnlyAllowlistedLinks = this.hasOnlyAllowlistedLinks(
      text,
      settings.linkPolicy,
      domainAllowlist,
    );
    const duplicateCandidate =
      !hasOnlyAllowlistedLinks && this.shouldTrackDuplicate(text, compactText);
    const duplicateState =
      settings.antiDuplicateEnabled && duplicateCandidate
        ? await this.detectDuplicateState({
            chatId,
            userId,
            compactText,
            settings,
          })
        : undefined;

    return {
      violations,
      ...(duplicateState?.hit ? { duplicateHit: duplicateState.hit } : {}),
      ...(duplicateState?.decision ? { duplicateDecision: duplicateState.decision } : {}),
    };
  }

  hasCommercialSpamMarkers(text: string): boolean {
    const normalizedText = this.normalizeForDetection(text);
    const rawLoweredText = text.toLowerCase();
    if (!normalizedText) {
      return false;
    }

    const hasMarker = (marker: string): boolean =>
      normalizedText.includes(marker) || rawLoweredText.includes(marker);

    return (
      ADS_LINK_PATTERN.test(rawLoweredText) ||
      ADS_PHONE_PATTERN.test(rawLoweredText) ||
      ADS_PRICE_PATTERN.test(rawLoweredText) ||
      ADS_TRANSACTIONAL_PATTERN.test(normalizedText) ||
      ADS_INTENT_MARKERS.some((marker) => hasMarker(marker)) ||
      ADS_PROMO_MARKERS.some((marker) => hasMarker(marker)) ||
      ADS_CONTACT_MARKERS.some((marker) => hasMarker(marker))
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
    const hitKey = `dup:v3:${chatId}:${userId}:${hash}:hit`;
    const hitTotal = await this.redisCounter.incrementWithTtl(
      hitKey,
      DEFAULT_DUPLICATE_WINDOW_SEC + 1,
    );
    const hitCount = Math.max(0, hitTotal - 1);
    const hit =
      hitCount > 0
        ? {
            count: hitCount,
            windowSec: DEFAULT_DUPLICATE_WINDOW_SEC,
            hash,
          }
        : undefined;

    const stages = this.getEnabledDuplicateStages(settings);
    if (stages.length === 0) {
      return { hit };
    }

    const repeatCounts = new Map<DuplicateStageName, number>();

    for (const stage of stages) {
      const key = `dup:v3:${chatId}:${userId}:${hash}:${stage.name}`;
      const count = await this.redisCounter.incrementWithTtl(key, stage.windowSec + 1);
      repeatCounts.set(stage.name, Math.max(0, count - 1));
    }

    const priority: DuplicateStageName[] = ['ban', 'kick', 'warn'];
    for (const stageName of priority) {
      const stage = stages.find((candidate) => candidate.name === stageName);
      if (!stage) {
        continue;
      }

      const count = repeatCounts.get(stageName) ?? 0;
      if (count < stage.threshold) {
        continue;
      }

      return {
        hit,
        decision: {
          action: stage.action,
          count,
          threshold: stage.threshold,
          windowSec: stage.windowSec,
          hash,
          nextAction: this.resolveNextDuplicateAction(stages, stageName),
        },
      };
    }

    return { hit };
  }

  private getEnabledDuplicateStages(settings: ChatSettings): DuplicateStage[] {
    const stages: Array<DuplicateStage | null> = [
      settings.duplicateWarnEnabled
        ? {
            name: 'warn',
            action: 'WARN',
            windowSec: settings.duplicateWarnWindowSec,
            threshold: settings.duplicateWarnMaxCount,
          }
        : null,
      settings.duplicateKickEnabled
        ? {
            name: 'kick',
            action: 'KICK',
            windowSec: settings.duplicateKickWindowSec,
            threshold: settings.duplicateKickMaxCount,
          }
        : null,
      settings.duplicateBanEnabled
        ? {
            name: 'ban',
            action: 'BAN',
            windowSec: settings.duplicateBanWindowSec,
            threshold: settings.duplicateBanMaxCount,
          }
        : null,
    ];

    return stages.filter((item): item is DuplicateStage => item !== null);
  }

  private resolveNextDuplicateAction(
    stages: DuplicateStage[],
    actionName: DuplicateStageName,
  ): DuplicateAction | null {
    const order: DuplicateStageName[] = ['warn', 'kick', 'ban'];
    const stageNames = stages.map((stage) => stage.name);
    const currentIndex = order.indexOf(actionName);

    for (let index = currentIndex + 1; index < order.length; index += 1) {
      const nextName = order[index];
      if (!stageNames.includes(nextName)) {
        continue;
      }

      if (nextName === 'warn') {
        return 'WARN';
      }
      if (nextName === 'kick') {
        return 'KICK';
      }
      return 'BAN';
    }

    return null;
  }

  private hasProfanity(normalizedText: string): boolean {
    const profanityText = this.normalizeForProfanity(normalizedText);
    const sanitizedProfanityText = this.stripProfanityExceptions(profanityText);
    const tokens = this.extractProfanityTokens(profanityText);
    if (tokens.length === 0) {
      return false;
    }

    const tokenHit = tokens.some((token) => this.isProfanityToken(token));
    if (tokenHit) {
      return true;
    }

    return this.hasPatternHit(sanitizedProfanityText, PROFANITY_OBFUSCATED_PATTERNS);
  }

  private isProfanityToken(token: string): boolean {
    if (!token) {
      return false;
    }

    if (PROFANITY_EXCEPTIONS.some((exception) => token.startsWith(exception))) {
      return false;
    }

    return PROFANITY_CORE_TOKEN_PATTERNS.some((pattern) => pattern.test(token));
  }

  private hasPatternHit(text: string, patterns: RegExp[]): boolean {
    if (!text) {
      return false;
    }

    return patterns.some((pattern) => pattern.test(text));
  }

  private stripProfanityExceptions(text: string): string {
    let sanitized = text;
    for (const exception of PROFANITY_EXCEPTIONS) {
      const pattern = new RegExp(this.escapeRegExp(exception), 'giu');
      sanitized = sanitized.replace(pattern, ' ');
    }

    return sanitized;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private shouldTrackDuplicate(rawText: string, compactText: string): boolean {
    if (!compactText) {
      return false;
    }

    const hasUrl = this.extractUrlsFromText(rawText).length > 0;
    if (hasUrl || DUPLICATE_EXCLUDED_PHONE_PATTERN.test(rawText)) {
      return false;
    }

    const hasAdMarker =
      ADS_INTENT_MARKERS.some((marker) => compactText.includes(marker)) ||
      ADS_CONTACT_MARKERS.some((marker) => compactText.includes(marker)) ||
      ADS_PROMO_MARKERS.some((marker) => compactText.includes(marker)) ||
      ADS_PRICE_PATTERN.test(compactText) ||
      ADS_TRANSACTIONAL_PATTERN.test(compactText);
    if (hasAdMarker) {
      return true;
    }

    const tokens = this.extractTokens(compactText);
    if (tokens.length < DUPLICATE_MIN_TOKEN_COUNT || compactText.length < DUPLICATE_MIN_LENGTH) {
      return false;
    }

    const uniqueLongTokens = new Set(tokens.filter((token) => token.length >= 4)).size;
    return uniqueLongTokens >= DUPLICATE_MIN_UNIQUE_LONG_TOKENS;
  }

  private hasOnlyAllowlistedLinks(text: string, policy: LinkPolicy, allowlist: string[]): boolean {
    if (policy !== LinkPolicy.ALLOWLIST_ONLY) {
      return false;
    }

    const links = this.extractUrlsFromText(text);
    if (links.length === 0) {
      return false;
    }

    const normalizedAllowlist = new Set(
      allowlist
        .map((entry) => normalizeAllowlistLink(entry))
        .filter((entry): entry is string => Boolean(entry)),
    );

    let checkedLinks = 0;
    for (const link of links) {
      if (!this.shouldCheckExactAllowlistLink(link)) {
        continue;
      }

      const normalizedLink = normalizeAllowlistLink(link);
      if (!normalizedLink) {
        continue;
      }

      checkedLinks += 1;
      if (!normalizedAllowlist.has(normalizedLink)) {
        return false;
      }
    }

    return checkedLinks > 0;
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

    const normalizedAllowlist = new Set(
      allowlist
        .map((entry) => normalizeAllowlistLink(entry))
        .filter((entry): entry is string => Boolean(entry)),
    );

    for (const link of links) {
      if (policy === LinkPolicy.ALLOWLIST_ONLY && !this.shouldCheckExactAllowlistLink(link)) {
        continue;
      }

      const normalizedLink = normalizeAllowlistLink(link);
      if (!normalizedLink) {
        continue;
      }

      if (!normalizedAllowlist.has(normalizedLink)) {
        return `Link ${normalizedLink} is not in allowlist`;
      }
    }

    return null;
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
    const state = this.collectCommercialSignals(normalizedText, rawLoweredText, settings);
    if (state.matchedSignals.length === 0) {
      return null;
    }

    let confidenceScore = Math.round(Math.max(0, Math.min(100, state.score)));
    if (state.hasStrongNegativeContext && !state.hasPrice && !state.hasContact) {
      confidenceScore = Math.min(confidenceScore, appliedThresholds.warnThreshold - 1);
    }

    if (confidenceScore >= appliedThresholds.deleteThreshold) {
      const hasStrongCommercialCombo =
        state.hasIntent && (state.hasTransactional || state.hasContact || state.hasDealChannel);
      if (!hasStrongCommercialCombo) {
        confidenceScore = Math.max(
          appliedThresholds.warnThreshold,
          appliedThresholds.deleteThreshold - 1,
        );
      }
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
  } {
    const strict = settings.commercialAdsSensitivity === CommercialAdsSensitivity.STRICT;
    const warnBase = Number.isFinite(settings.commercialAdsWarnThreshold)
      ? settings.commercialAdsWarnThreshold
      : 45;
    const deleteBase = Number.isFinite(settings.commercialAdsDeleteThreshold)
      ? settings.commercialAdsDeleteThreshold
      : 65;
    const warnThreshold = strict ? Math.max(10, warnBase - 3) : warnBase;
    const deleteThreshold = strict
      ? Math.max(warnThreshold + 5, deleteBase - 4)
      : Math.max(warnThreshold + 5, deleteBase);

    return {
      warnThreshold,
      deleteThreshold,
      sensitivity: strict ? 'STRICT' : 'BALANCED',
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
    settings: ChatSettings,
  ): CommercialSignalState {
    const strict = settings.commercialAdsSensitivity === CommercialAdsSensitivity.STRICT;
    const positiveFactor = strict ? 1.15 : 1;
    const negativeFactor = strict ? 0.85 : 1;

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
    let hasPrice = false;
    let hasContact = false;
    let hasDealChannel = false;
    let hasTransactional = false;
    let hasStrongNegativeContext = false;

    const hasMarker = (marker: string): boolean =>
      normalizedText.includes(marker) || rawLoweredText.includes(marker);

    const intentHits = ADS_INTENT_MARKERS.filter((marker) => hasMarker(marker));
    for (const marker of intentHits.slice(0, 3)) {
      addPositive(`intent:${marker}`, 18);
      hasIntent = true;
    }

    const promoHits = ADS_PROMO_MARKERS.filter((marker) => hasMarker(marker));
    for (const marker of promoHits.slice(0, 3)) {
      addPositive(`promo:${marker}`, 8);
    }

    if (ADS_PRICE_PATTERN.test(rawLoweredText) || ADS_PRICE_PATTERN.test(normalizedText)) {
      addPositive('transaction:price', 24);
      hasPrice = true;
      hasTransactional = true;
    }

    if (ADS_TRANSACTIONAL_PATTERN.test(normalizedText)) {
      addPositive('transaction:keywords', 10);
      hasTransactional = true;
    }

    const contactHits = ADS_CONTACT_MARKERS.filter((marker) => hasMarker(marker));
    for (const marker of contactHits.slice(0, 2)) {
      addPositive(`contact:${marker}`, 16);
      hasContact = true;
    }

    if (ADS_PHONE_PATTERN.test(rawLoweredText) || ADS_PHONE_PATTERN.test(normalizedText)) {
      addPositive('contact:phone', 18);
      hasContact = true;
    }

    if (ADS_LINK_PATTERN.test(rawLoweredText)) {
      addPositive('deal-channel:link', 18);
      hasDealChannel = true;
    }

    if (ADS_URGENCY_PATTERN.test(normalizedText)) {
      addPositive('booster:urgency', 9);
    }

    if (ADS_QUANTITY_PATTERN.test(normalizedText)) {
      addPositive('booster:quantity', 8);
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
    }

    if (rawLoweredText.includes('?') && !hasPrice && !hasContact) {
      addNegative('context:question', 10);
    }

    if (hasIntent && (hasPrice || hasContact || hasDealChannel)) {
      addPositive('combo:intent+deal', 15);
    }

    if (hasContact && hasPrice) {
      addPositive('combo:contact+price', 8);
    }

    return {
      score,
      matchedSignals: [...new Set(matchedSignals)],
      negativeSignals: [...new Set(negativeSignals)],
      hasIntent,
      hasPrice,
      hasContact,
      hasDealChannel,
      hasTransactional,
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

  private normalizeForProfanity(value: string): string {
    if (!value) {
      return '';
    }

    let normalized = value.toLowerCase();
    normalized = this.normalizeMixedWriting(normalized);
    normalized = normalized.replace(/ё/g, 'е');
    normalized = normalized.replace(/([a-zа-я0-9])\1{2,}/giu, '$1$1');
    normalized = normalized.replace(/[_*~`"'«»“”(){}[[]\]|]+/g, ' ');
    normalized = normalized.replace(/[^\p{L}\p{N}\s]+/gu, ' ');
    normalized = normalized.replace(/\s+/g, ' ').trim();
    return normalized;
  }

  private normalizeMixedWriting(value: string): string {
    let result = '';
    for (const char of value) {
      result += MIXED_CHAR_MAP[char] ?? char;
    }
    return result;
  }

  private extractTokens(value: string): string[] {
    const normalized = this.normalizeForDetection(value);
    return normalized.match(/[a-zа-яё0-9]+/giu) ?? [];
  }

  private extractProfanityTokens(value: string): string[] {
    return value.match(/[a-zа-яё0-9]+/giu) ?? [];
  }
}
