import type { ChatSettings } from '../prisma/prisma-client';
import { raceWithTimeout } from '../common/promise-timeout.util';
import type { RuleViolation } from './rule-engine.service';
import { RedisCounterService } from './redis-counter.service';
import { MessageLimitsBlockedWordDetector } from './rule-engine-blocked-words.detector';

export const ANTI_SPAM_BURST_LIMIT = 5;
export const ANTI_SPAM_BURST_WINDOW_SEC = 10;
const ANTI_SPAM_STATE_LOOKUP_TIMEOUT_MS = 120;
const PHONE_NUMBER_CANDIDATE_PATTERN = /(?:^|[^\d+])(\+?\d[\d\s().-]{7,}\d)(?=$|[^\d])/gu;

export class RuleEngineMessageLimitsDetector {
  private readonly blockedWordDetector = new MessageLimitsBlockedWordDetector();

  constructor(private readonly redisCounter: RedisCounterService) {}

  async detectAntiSpamBurstLimit(params: {
    chatId: string;
    userId: string;
    settings: ChatSettings;
  }): Promise<RuleViolation | null> {
    const { chatId, userId, settings } = params;
    if (!settings.antiSpamEnabled) {
      return null;
    }

    const key = `message:anti-spam-burst:v1:${chatId}:${userId}:${ANTI_SPAM_BURST_LIMIT}:${ANTI_SPAM_BURST_WINDOW_SEC}`;
    const count = await raceWithTimeout<number | null>({
      operation: this.redisCounter.incrementWithTtl(key, ANTI_SPAM_BURST_WINDOW_SEC + 1),
      timeoutMs: ANTI_SPAM_STATE_LOOKUP_TIMEOUT_MS,
      onTimeout: () => null,
    });
    if (count === null) {
      return null;
    }

    if (count <= ANTI_SPAM_BURST_LIMIT) {
      return null;
    }

    return {
      ruleCode: 'MESSAGE_RATE_LIMIT',
      score: 0.9,
      reason: `Messages are limited to ${ANTI_SPAM_BURST_LIMIT} per ${ANTI_SPAM_BURST_WINDOW_SEC}s`,
      metadata: {
        count,
        maxMessages: ANTI_SPAM_BURST_LIMIT,
        windowSec: ANTI_SPAM_BURST_WINDOW_SEC,
      },
    };
  }

  detectMessageLengthLimit(params: {
    measuredLength: number;
    settings: ChatSettings;
  }): RuleViolation | null {
    const { measuredLength, settings } = params;
    if (!settings.maxMessageLengthEnabled || measuredLength <= settings.maxMessageLength) {
      return null;
    }

    return {
      ruleCode: 'MESSAGE_TOO_LONG',
      score: 0.82,
      reason: `Message length ${measuredLength} exceeds limit ${settings.maxMessageLength}`,
    };
  }

  async detectMessageCountLimit(params: {
    chatId: string;
    userId: string;
    settings: ChatSettings;
  }): Promise<RuleViolation | null> {
    const { chatId, userId, settings } = params;
    if (!settings.messageCountLimitEnabled) {
      return null;
    }

    const windowHours = Math.min(24, Math.max(1, settings.messageCountLimitWindowHours));
    const maxMessages = Math.min(10, Math.max(1, settings.messageCountLimitMessages));
    const key = `message:count-limit:v1:${chatId}:${userId}:${maxMessages}:${windowHours}`;
    const count = await this.redisCounter.incrementWithTtl(key, windowHours * 60 * 60 + 1);
    if (count <= maxMessages) {
      return null;
    }

    return {
      ruleCode: 'MESSAGE_COUNT_LIMIT',
      score: 0.87,
      reason: `Messages are limited to ${maxMessages} per ${windowHours}h`,
    };
  }

  detectBlockedWordLimit(params: {
    text: string;
    settings: ChatSettings;
  }): RuleViolation | null {
    const blockedWord = this.blockedWordDetector.detect(
      params.text,
      params.settings.messageLimitsBlockedWords,
    );
    if (!blockedWord) {
      return null;
    }

    return {
      ruleCode: 'MESSAGE_BLOCKED_WORD',
      score: 0.89,
      reason: `Blocked word detected: ${blockedWord.blockedWord}`,
      metadata: {
        blockedWord: blockedWord.blockedWord,
      },
    };
  }

  detectPhoneNumberLimit(params: {
    text: string;
    settings: ChatSettings;
  }): RuleViolation | null {
    if (params.settings.phoneNumbersEnabled) {
      return null;
    }

    const phoneCount = countDetectedPhoneNumbers(params.text);
    if (phoneCount === 0) {
      return null;
    }

    return {
      ruleCode: 'PHONE_NUMBER_BLOCKED',
      score: 0.88,
      reason: 'Phone numbers are disabled by chat settings',
      metadata: {
        phoneCount,
      },
    };
  }

  detectAttachmentLimits(params: {
    settings: ChatSettings;
    hasPhotoAttachment?: boolean;
    hasVideoAttachment?: boolean;
    hasFileAttachment?: boolean;
    hasVoiceAttachment?: boolean;
  }): RuleViolation[] {
    const violations: RuleViolation[] = [];
    const {
      settings,
      hasPhotoAttachment,
      hasVideoAttachment,
      hasFileAttachment,
      hasVoiceAttachment,
    } = params;

    if (hasPhotoAttachment && !settings.photoMessagesEnabled) {
      violations.push({
        ruleCode: 'PHOTO_BLOCKED',
        score: 0.88,
        reason: 'Photo messages are disabled by chat settings',
      });
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

    return violations;
  }

  async detectMediaCooldownLimits(params: {
    chatId: string;
    userId: string;
    settings: ChatSettings;
    hasPhotoAttachment?: boolean;
    hasStickerAttachment?: boolean;
  }): Promise<RuleViolation[]> {
    const violations: RuleViolation[] = [];
    const { chatId, userId, settings, hasPhotoAttachment, hasStickerAttachment } = params;

    if (hasPhotoAttachment && settings.photoMessageCooldownEnabled) {
      const cooldownSec = settings.photoMessageCooldownHours * 60 * 60;
      const key = buildMediaCooldownKey(
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
      const key = buildMediaCooldownKey(
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

    return violations;
  }
}

function buildMediaCooldownKey(
  mediaKind: 'photo' | 'sticker',
  chatId: string,
  userId: string,
  windowValue: number,
  settingsUpdatedAt: Date | string,
): string {
  return `${mediaKind}:cooldown:v2:${chatId}:${userId}:${windowValue}:${normalizeSettingsUpdatedAt(settingsUpdatedAt)}`;
}

function normalizeSettingsUpdatedAt(value: Date | string): string {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? String(timestamp) : 'na';
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? String(parsed) : 'na';
}

function countDetectedPhoneNumbers(text: string): number {
  let count = 0;
  for (const match of text.matchAll(PHONE_NUMBER_CANDIDATE_PATTERN)) {
    const candidate = match[1];
    if (candidate && isPhoneNumberCandidate(candidate)) {
      count += 1;
    }
  }

  return count;
}

function isPhoneNumberCandidate(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) {
    return false;
  }

  const trimmed = candidate.trim();
  if (trimmed.startsWith('+')) {
    return true;
  }

  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    return true;
  }

  if (digits.length !== 10) {
    return false;
  }

  if (digits.startsWith('9')) {
    return true;
  }

  return /\(\s*\d{3}\s*\)|\d{3}[\s.-]+\d{3}[\s.-]+\d{2}[\s.-]+\d{2}/u.test(
    candidate,
  );
}
