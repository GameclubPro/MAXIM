import { Injectable, Logger, Optional } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import type { ChatSettings } from '../../prisma/prisma-client';
import { classifyDuplicateEventTime } from '../duplicate-enforcement-safety';
import { resolveDuplicateFlowConfig } from '../duplicate-flow-policy';
import { extractDuplicateMessageContent, isExactImageContent } from './message-duplicate-content';
import { MessageDuplicateEnforcementService } from './message-duplicate-enforcement.service';
import { MessageDuplicateHistoryService } from './message-duplicate-history.service';
import { MessageDuplicatePolicyService } from './message-duplicate-policy.service';
import { messageDuplicateActionsEnabled } from './message-duplicate-policy.service';
import type { ExecuteDuplicateModerationAction } from '../duplicate-moderation.actions';
import { MessageDuplicateEnqueueService } from './message-duplicate.queue';
import {
  messageDuplicateSettingsDigest,
  exactImageSettingsDigest,
} from './message-duplicate-state';
import { MessageDuplicateMetricsService } from './message-duplicate-metrics.service';

@Injectable()
export class MessageDuplicateService {
  private readonly logger = new Logger(MessageDuplicateService.name);
  constructor(
    private readonly policy: MessageDuplicatePolicyService,
    private readonly history: MessageDuplicateHistoryService,
    private readonly enforcement: MessageDuplicateEnforcementService,
    private readonly queue: MessageDuplicateEnqueueService,
    @Optional() private readonly metrics?: MessageDuplicateMetricsService,
  ) {}

  async isAuthoritative(chatId: string): Promise<boolean> {
    return (await this.policy.resolve(chatId)).mode === 'full';
  }

  async observe(params: {
    update: MaxUpdate;
    webhookEventId?: string;
    eventTimestampMs?: number;
    settings: ChatSettings;
    botId: string;
    actionEligible: boolean;
    track: boolean;
    executeFullAction?: ExecuteDuplicateModerationAction;
  }): Promise<void> {
    const message = params.update.message;
    if (
      !message ||
      !params.settings.antiDuplicateEnabled ||
      !['message_created', 'message_edited'].includes(params.update.type)
    )
      return;
    const policy = await this.policy.resolve(message.chatId);
    if (policy.mode === 'off') {
      this.metrics?.record('admission.off');
      return;
    }
    const eventTimestampMs = params.eventTimestampMs;
    if (
      !Number.isSafeInteger(eventTimestampMs) ||
      !eventTimestampMs ||
      eventTimestampMs < policy.effectiveAtMs ||
      classifyDuplicateEventTime({
        eventTimestampMs,
        windowSec: resolveDuplicateFlowConfig(params.settings).windowSec,
      })
    ) {
      this.metrics?.record('admission.event_time_rejected');
      this.logger.debug(
        { chatId: message.chatId },
        'Message duplicate skipped: untrusted event time',
      );
      return;
    }
    const content = extractDuplicateMessageContent(params.update.raw);
    if (!content.complete) this.metrics?.recordContentRejection(content.reason);
    const hasPhotos = content.media.some((media) => media.kind === 'photo');
    const invalidContent = { ...content, complete: false, reason: 'invalid_content' as const };
    const imageMode = params.settings.duplicateCompareMode !== 'TEXT' && hasPhotos;
    const imageOnly = imageMode && isExactImageContent(content);
    const observedContent = params.track && !imageMode ? content : invalidContent;
    const result = await this.history.observe({
      content: observedContent,
      chatId: message.chatId,
      userId: message.senderId,
      messageId: message.messageId,
      eventTimestampMs,
      controlRevision: policy.revision,
      settings: params.settings,
    });
    // FLAG: One revision invalidates both histories when an edit changes the attachment kind.
    // Old message/photo jobs are never promoted into the new explicit IMAGE job authority.
    if (hasPhotos || params.update.type === 'message_edited') {
      await this.history.observe({
        content: params.track && imageOnly ? content : invalidContent,
        imageScope: params.settings.duplicatePhotoScope,
        chatId: message.chatId,
        userId: message.senderId,
        messageId: message.messageId,
        eventTimestampMs,
        controlRevision: policy.revision,
        settings: params.settings,
      });
    }
    if (!params.track) {
      this.metrics?.record('admission.untracked');
      return;
    }
    if (imageMode && !imageOnly) return;
    if (
      (imageOnly || params.settings.duplicateCompareMode !== 'TEXT') &&
      content.complete &&
      content.media.length > 0
    ) {
      if (!params.webhookEventId) {
        this.metrics?.record('admission.missing_receipt');
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
        settingsDigest: imageOnly
          ? exactImageSettingsDigest(params.settings)
          : messageDuplicateSettingsDigest(params.settings),
        ...(imageOnly ? { comparison: 'IMAGE' as const } : {}),
        actionEligible:
          params.actionEligible &&
          (imageOnly ? policy.mode === 'full' : messageDuplicateActionsEnabled(policy.mode)),
      });
      this.metrics?.record('admission.media_queued');
      return;
    }
    if (!content.complete && !result)
      this.logger.debug(
        { chatId: message.chatId, reason: content.reason },
        'Message duplicate content could not be verified',
      );
    if (result && params.actionEligible && messageDuplicateActionsEnabled(policy.mode)) {
      await this.enforcement.enqueue({
        ...result,
        chatId: message.chatId,
        botId: params.botId,
        sourceCreatedAt: message.createdAt,
        text: content.text,
        settings: params.settings,
        update: params.update,
        executeFullAction: params.executeFullAction,
      });
    } else if (result) {
      this.metrics?.record(
        params.actionEligible ? 'admission.shadow' : 'admission.action_ineligible',
      );
    }
  }
}
