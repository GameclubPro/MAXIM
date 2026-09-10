import { Injectable, Logger } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import type { ChatSettings } from '../../prisma/prisma-client';
import { classifyDuplicateEventTime } from '../duplicate-enforcement-safety';
import { resolveDuplicateFlowConfig } from '../duplicate-flow-policy';
import { extractDuplicateMessageContent } from './message-duplicate-content';
import { MessageDuplicateEnforcementService } from './message-duplicate-enforcement.service';
import { MessageDuplicateHistoryService } from './message-duplicate-history.service';
import { MessageDuplicatePolicyService } from './message-duplicate-policy.service';
import { MessageDuplicateEnqueueService } from './message-duplicate.queue';
import { messageDuplicateSettingsDigest } from './message-duplicate-state';

@Injectable()
export class MessageDuplicateService {
  private readonly logger = new Logger(MessageDuplicateService.name);
  constructor(
    private readonly policy: MessageDuplicatePolicyService,
    private readonly history: MessageDuplicateHistoryService,
    private readonly enforcement: MessageDuplicateEnforcementService,
    private readonly queue: MessageDuplicateEnqueueService,
  ) {}

  async observe(params: {
    update: MaxUpdate;
    webhookEventId?: string;
    eventTimestampMs?: number;
    settings: ChatSettings;
    botId: string;
    actionEligible: boolean;
    track: boolean;
  }): Promise<void> {
    const message = params.update.message;
    if (
      !message ||
      !params.settings.antiDuplicateEnabled ||
      !['message_created', 'message_edited'].includes(params.update.type)
    )
      return;
    const policy = await this.policy.resolve(message.chatId);
    if (policy.mode === 'off') return;
    const eventTimestampMs = params.eventTimestampMs;
    if (
      !Number.isSafeInteger(eventTimestampMs) ||
      !eventTimestampMs ||
      classifyDuplicateEventTime({
        eventTimestampMs,
        windowSec: resolveDuplicateFlowConfig(params.settings).windowSec,
      })
    ) {
      this.logger.debug(
        { chatId: message.chatId },
        'Message duplicate skipped: untrusted event time',
      );
      return;
    }
    const content = extractDuplicateMessageContent(params.update.raw);
    const observedContent = params.track
      ? content
      : { ...content, complete: false, reason: 'invalid_content' as const };
    const result = await this.history.observe({
      content: observedContent,
      chatId: message.chatId,
      userId: message.senderId,
      messageId: message.messageId,
      eventTimestampMs,
      controlRevision: policy.revision,
      settings: params.settings,
    });
    if (!params.track) return;
    if (
      params.settings.duplicateCompareMode !== 'TEXT' &&
      content.complete &&
      content.media.length > 0
    ) {
      if (!params.webhookEventId) {
        this.logger.debug(
          { chatId: message.chatId },
          'Message duplicate media skipped: missing durable receipt',
        );
        return;
      }
      await this.queue.enqueue({
        webhookEventId: params.webhookEventId,
        chatId: message.chatId,
        messageId: message.messageId,
        eventTimestampMs,
        sourceCreatedAt: new Date(eventTimestampMs).toISOString(),
        controlRevision: policy.revision,
        settingsDigest: messageDuplicateSettingsDigest(params.settings),
        actionEligible: params.actionEligible && policy.mode === 'delete_only',
      });
      return;
    }
    if (!content.complete && !result)
      this.logger.debug(
        { chatId: message.chatId, reason: content.reason },
        'Message duplicate content could not be verified',
      );
    if (result && params.actionEligible && policy.mode === 'delete_only') {
      await this.enforcement.enqueue({
        ...result,
        chatId: message.chatId,
        botId: params.botId,
        sourceCreatedAt: message.createdAt,
        text: content.text,
        settings: params.settings,
      });
    }
  }
}
