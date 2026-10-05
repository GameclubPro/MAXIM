import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MaxUpdate } from '@maxim/contracts';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookParser } from '../webhook/webhook.parser';
import { ParticipantModerationImmunityService } from './participant-moderation-immunity.service';
import {
  calculateEffectiveMessageLength,
  detectMediaFlags,
  hasForwardedMessage,
} from './moderation-update-extractors';
import { extractDetectedPhoneNumbers } from './rule-engine-message-limits.detector';
import { MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES } from './moderation.service.support';

export const MESSAGE_LIMITS_CURRENT_CONTENT_RULES = new Set([
  'MESSAGE_TOO_LONG_DELETE',
  'PHONE_NUMBER_BLOCKED_DELETE',
  'PHOTO_BLOCKED_DELETE',
  'VIDEO_BLOCKED_DELETE',
  'FILE_BLOCKED_DELETE',
  'VOICE_BLOCKED_DELETE',
  'FORWARDED_MESSAGE_BLOCKED_DELETE',
]);

export class MessageLimitsDeleteGuardRejectedError extends Error {
  readonly code = 'message_limits_delete_no_longer_authorized';
}

type Reason = { ruleCode: string; reasonKey: string };
type Settings = Awaited<ReturnType<MessageLimitsDeleteGuardService['loadSettings']>>;

@Injectable()
export class MessageLimitsDeleteGuardService {
  private readonly parser = new WebhookParser();
  constructor(
    private readonly prisma: PrismaService,
    private readonly max: MaxClientService,
    private readonly bots: MaxBotLinkService,
    private readonly immunity: ParticipantModerationImmunityService,
    private readonly config: ConfigService,
  ) {}

  async authorize(params: {
    chatId: string;
    messageId: string;
    subjectUserId: string | null;
    botId: string;
    reasons: readonly Reason[];
  }): Promise<'not_applicable' | 'absent' | { reasonKeys: string[] }> {
    const owned = params.reasons.filter((reason) =>
      MESSAGE_LIMITS_CURRENT_CONTENT_RULES.has(reason.ruleCode),
    );
    if (!owned.length) return 'not_applicable';
    const userId = params.subjectUserId;
    if (!userId || this.bots.isKnownBotUserId(userId)) this.reject();
    const settings = await this.loadSettings(params.chatId, userId);
    const options = {
      botId: params.botId,
      bypassCache: true,
      timeoutMs: this.config.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5000,
      trafficClass: 'critical' as const,
      actionHealthLane: 'critical' as const,
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
    };
    const access = await this.max.getChatMemberAccess(params.chatId, userId, options);
    if (!access || access.isAdmin === true || access.isOwner === true) this.reject();
    if (access.userId !== userId || access.isAdmin !== false || access.isOwner !== false)
      throw new Error('Message limits author access unavailable');
    // FLAG: Delayed generic reasons authorize only the exact current message through this
    // attempt's selected bot. A stored length, excerpt or receiver token is not proof.
    const row = await this.max.getExactMessageRow(params.chatId, params.messageId, options);
    if (!row) return 'absent';
    const update = this.parser.parse({
      type: 'message_created',
      updateId: 'message-limits-delete-guard',
      message: row,
    });
    const message = update.message;
    if (
      !message ||
      message.chatId !== params.chatId ||
      message.messageId !== params.messageId ||
      message.senderId !== userId ||
      message.entityType === 'channel'
    )
      this.reject();
    if (!owned.some((reason) => this.matches(reason.ruleCode, update, settings))) this.reject();
    if (
      (await this.immunity.consumeForMessage({
        chatId: params.chatId,
        userId,
        messageId: params.messageId,
        scope: 'message-limits-delete:v1',
        nightModeTimezone: settings.nightModeTimezone,
      })) === 'granted'
    )
      this.reject();
    const finalSettings = await this.loadSettings(params.chatId, userId);
    const reasonKeys = owned
      .filter((reason) => this.matches(reason.ruleCode, update, finalSettings))
      .map((reason) => reason.reasonKey);
    if (!reasonKeys.length) this.reject();
    return { reasonKeys };
  }

  async loadSettings(chatId: string, userId: string) {
    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId },
      include: {
        chat: {
          select: {
            entityType: true,
            admins: { where: { userId }, select: { userId: true } },
          },
        },
      },
    });
    if (!settings || settings.chat.entityType !== 'CHAT' || settings.chat.admins.length)
      this.reject();
    return settings;
  }

  private matches(ruleCode: string, update: MaxUpdate, settings: Settings): boolean {
    const media = detectMediaFlags(update);
    switch (ruleCode) {
      case 'MESSAGE_TOO_LONG_DELETE':
        return (
          settings.maxMessageLengthEnabled &&
          calculateEffectiveMessageLength(update) > settings.maxMessageLength
        );
      case 'PHONE_NUMBER_BLOCKED_DELETE':
        return (
          !settings.phoneNumbersEnabled &&
          extractDetectedPhoneNumbers(update.message?.text ?? '').length > 0
        );
      case 'PHOTO_BLOCKED_DELETE':
        return !settings.photoMessagesEnabled && media.hasPhotoAttachment;
      case 'VIDEO_BLOCKED_DELETE':
        return !settings.videoMessagesEnabled && media.hasVideoAttachment;
      case 'FILE_BLOCKED_DELETE':
        return !settings.fileMessagesEnabled && media.hasFileAttachment;
      case 'VOICE_BLOCKED_DELETE':
        return !settings.voiceMessagesEnabled && media.hasVoiceAttachment;
      case 'FORWARDED_MESSAGE_BLOCKED_DELETE':
        return settings.forwardedMessagesEnabled === false && hasForwardedMessage(update);
      default:
        return false;
    }
  }

  private reject(): never {
    throw new MessageLimitsDeleteGuardRejectedError();
  }
}
