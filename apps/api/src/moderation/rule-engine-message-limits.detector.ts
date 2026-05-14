import type { ChatSettings } from '@prisma/client';
import type { RuleViolation } from './rule-engine.service';
import { RedisCounterService } from './redis-counter.service';
import { MessageLimitsBlockedWordDetector } from './rule-engine-blocked-words.detector';

export class RuleEngineMessageLimitsDetector {
  private readonly blockedWordDetector = new MessageLimitsBlockedWordDetector();

  constructor(private readonly redisCounter: RedisCounterService) {}

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

  detectAttachmentLimits(params: {
    settings: ChatSettings;
    hasVideoAttachment?: boolean;
    hasFileAttachment?: boolean;
    hasVoiceAttachment?: boolean;
  }): RuleViolation[] {
    const violations: RuleViolation[] = [];
    const { settings, hasVideoAttachment, hasFileAttachment, hasVoiceAttachment } = params;

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
