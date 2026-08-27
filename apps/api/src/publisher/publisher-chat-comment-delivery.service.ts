import { Injectable, Logger, Optional } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { PUBLISHER_CHAT_DIALOG_ACTION_COMMENT } from '../admin/admin.service.support';
import { formatCommentsButtonText } from '../common/dialog-button-label.util';
import { extractHttpStatusCode } from '../common/http-error.util';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  wasMaxMessageSendAttempted,
} from '../max/max-client.service';
import {
  isAmbiguousMaxSendError,
  MAX_SEND_AMBIGUOUS_ERROR_PREFIX,
} from '../max/max-send-ambiguity.util';
import {
  buildChatAutoCommentAuditId,
  CHAT_AUTO_COMMENT_ATTACH_STATUS,
  ReplacementAttachMarkerStore,
} from '../moderation/replacement-attach-marker.store';
import {
  CHAT_COMMENTS_REPLY_TEXT,
  CHAT_DIALOG_AUTO_ATTACH_ACTION,
} from '../moderation/moderation.service.support';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherActionCredentialService } from './publisher-action-credential.service';
import type {
  PublisherChatCommentAttachJob,
  PublisherChatCommentJob,
  PublisherCommentKeyboardEditJob,
} from './publisher-chat-comment.queue';
import {
  PublisherDispatchHealthService,
  extractPublisherMaxStatusCode,
} from './publisher-dispatch-health.service';
import { PublisherReadinessService, type PublisherReadyRoute } from './publisher-readiness.service';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';
import { PublisherDialogLinkService } from './publisher-dialog-link.service';
import { PublisherBindingRefreshService } from './publisher-binding-refresh.service';
import {
  ChatEntityType,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
} from '../prisma/prisma-client';

type PublisherJobAttempt = {
  final: boolean;
  attemptsMade: number;
  maxAttempts: number;
};

const PUBLISHER_COMMENT_SENDER_ACCESS_FRESH_MS = 15 * 60_000;

class PublisherCommentSenderNotAdminError extends Error {
  constructor() {
    super('Publisher chat-comment source message sender is not an administrator');
    this.name = 'PublisherCommentSenderNotAdminError';
  }
}

@Injectable()
export class PublisherChatCommentDeliveryService {
  private readonly logger = new Logger(PublisherChatCommentDeliveryService.name);
  private readonly markerStore: ReplacementAttachMarkerStore;
  private readonly publisherBotId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly readiness: PublisherReadinessService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    credentials: PublisherActionCredentialService,
    private readonly dialogLinks: PublisherDialogLinkService,
    private readonly bindingRefresh: PublisherBindingRefreshService,
    @Optional() private readonly dispatchHealth?: PublisherDispatchHealthService,
  ) {
    this.markerStore = new ReplacementAttachMarkerStore(prisma);
    this.publisherBotId = credentials.getBotId();
  }

  async process(job: PublisherChatCommentJob, attempt: PublisherJobAttempt): Promise<void> {
    this.assertEnvelope(job);
    if (job.kind === 'edit_comment_keyboard') {
      await this.processKeyboardEdit(job);
      return;
    }
    await this.processAttach(job, attempt);
  }

  private async processAttach(
    job: PublisherChatCommentAttachJob,
    attempt: PublisherJobAttempt,
  ): Promise<void> {
    const auditRecovery = await this.markerStore.probeChatAutoCommentAuditRecovery({
      chatId: job.chatId,
      messageId: job.messageId,
      expectedMarkerId: job.markerId,
      expectedLockToken: job.lockToken,
    });
    if (auditRecovery?.status === 'recover_audit') {
      await this.persistAttachAudit({
        job,
        replyMessageId: auditRecovery.replyMessageId,
        publisherBotId: job.requiredBotId,
      });
      await this.markerStore.completeChatAutoCommentAuditRecovery({
        markerId: auditRecovery.markerId,
        chatId: job.chatId,
        messageId: job.messageId,
        replyMessageId: auditRecovery.replyMessageId,
      });
      return;
    }
    if (auditRecovery?.status === 'done' || auditRecovery?.status === 'recovered_audit') {
      return;
    }

    const initialClaimState = await this.markerStore.inspectChatAutoCommentDispatchClaim({
      markerId: job.markerId,
      chatId: job.chatId,
      messageId: job.messageId,
      lockToken: job.lockToken,
    });
    if (initialClaimState === 'done' || initialClaimState === 'lost') {
      return;
    }
    if (initialClaimState === 'send_fenced') {
      await this.quarantineAmbiguousAttach(
        job,
        'A prior publisher worker crossed the durable send fence without a confirmed message id',
        null,
      );
      return;
    }

    let route: PublisherReadyRoute;
    try {
      route = await this.assertReady(job.chatId, 'chat_comments');
      this.assertAttachIdentity(job, route);
      if (!(await this.isSenderAdmin(job, true))) {
        await this.skipNonAdminAttach(job);
        return;
      }
    } catch (error: unknown) {
      await this.handlePredispatchFailure(job, error, attempt);
      throw error;
    }

    const claimState = await this.markerStore.refreshChatAutoCommentDispatchClaim({
      markerId: job.markerId,
      chatId: job.chatId,
      messageId: job.messageId,
      lockToken: job.lockToken,
    });
    if (claimState === 'done' || claimState === 'lost') {
      return;
    }
    if (claimState === 'send_fenced') {
      await this.quarantineAmbiguousAttach(
        job,
        'A prior publisher worker crossed the durable send fence without a confirmed message id',
        null,
      );
      return;
    }

    try {
      route = await this.assertReady(job.chatId, 'chat_comments');
      this.assertAttachIdentity(job, route);
    } catch (error: unknown) {
      await this.handlePredispatchFailure(job, error, attempt);
      throw error;
    }

    let sendFenceStartedAt: Date | null = null;
    let replyMessageId: string;
    try {
      const button =
        job.button ??
        this.dialogLinks.buildChatDialogButton(
          job.chatId,
          'comments',
          job.markerId,
          formatCommentsButtonText('💬 Комментарии', 0),
        );
      const sent = await this.maxClient.sendMessageImmediateWithResolvedLink(
        job.chatId,
        CHAT_COMMENTS_REPLY_TEXT,
        {
          buttons: [[button]],
          messageLink: {
            type: 'reply',
            mid: job.messageId,
          },
          beforeSend: async () => {
            const immediateRoute = await this.assertReady(job.chatId, 'chat_comments');
            this.assertAttachIdentity(job, immediateRoute);
            if (!(await this.isSenderAdmin(job, false))) {
              throw new PublisherCommentSenderNotAdminError();
            }
            route = immediateRoute;
            sendFenceStartedAt = await this.markerStore.recordChatReplySendStarted({
              chatId: job.chatId,
              messageId: job.messageId,
              lockToken: job.lockToken,
              senderBotId: route.requiredBotId,
            });
          },
          debugContext: {
            screen: 'chat-auto-comments',
            action: 'publisher-reply-to-admin-message',
          },
        },
        {
          trafficClass: 'background',
          actionHealthLane: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.COMMENT_NOTIFICATION,
          botId: route.requiredBotId,
        },
      );
      replyMessageId = sent.messageId;
    } catch (error: unknown) {
      const attempted = sendFenceStartedAt !== null || wasMaxMessageSendAttempted(error);
      if (!attempted && error instanceof PublisherCommentSenderNotAdminError) {
        await this.skipNonAdminAttach(job);
        return;
      }
      if (attempted && isAmbiguousMaxSendError(error)) {
        await this.recordSendFailure(job.chatId, error);
        await this.quarantineAmbiguousAttach(
          job,
          this.errorSummary(error),
          extractHttpStatusCode(error),
        );
        return;
      }

      const status = extractHttpStatusCode(error);
      if (
        attempted &&
        status &&
        status >= 400 &&
        status < 500 &&
        ![401, 403, 404, 429].includes(status)
      ) {
        await this.markerStore.completeChatAutoComment({
          chatId: job.chatId,
          messageId: job.messageId,
          lockToken: job.lockToken,
          status: CHAT_AUTO_COMMENT_ATTACH_STATUS.SKIPPED,
          source: 'webhook',
          botId: route.requiredBotId,
          deliveryMode: 'reply_message',
          originalDeleted: false,
          lastError: this.errorSummary(error),
          lastStatusCode: status,
        });
        return;
      }

      await this.recordSendFailure(job.chatId, error);
      await this.handleRetryableAttachFailure(
        job,
        error,
        attempt,
        route.requiredBotId,
        sendFenceStartedAt,
      );
      throw error;
    }

    let replyMarkerError: unknown = null;
    try {
      await this.markerStore.recordChatReplyMessage({
        chatId: job.chatId,
        messageId: job.messageId,
        lockToken: job.lockToken,
        replyMessageId,
        senderBotId: route.requiredBotId,
      });
    } catch (error: unknown) {
      replyMarkerError = error;
      try {
        await this.markerStore.completeChatAutoComment({
          chatId: job.chatId,
          messageId: job.messageId,
          lockToken: job.lockToken,
          status: CHAT_AUTO_COMMENT_ATTACH_STATUS.SUCCEEDED,
          source: 'webhook',
          botId: route.requiredBotId,
          deliveryMode: 'reply_message',
          replyMessageId,
          originalDeleted: false,
          lastError: `Delivered reply marker persistence failed: ${this.errorSummary(error)}`,
          lastStatusCode: extractHttpStatusCode(error),
        });
      } catch (completionError: unknown) {
        this.logger.error(
          {
            chatId: job.chatId,
            messageId: job.messageId,
            replyMessageId,
            err: this.errorSummary(completionError),
          },
          'Failed to terminalize a confirmed publisher chat-comment reply',
        );
      }
    }

    await this.persistAttachAudit({ job, replyMessageId, publisherBotId: route.requiredBotId });
    if (replyMarkerError) {
      await this.markerStore.completeChatAutoCommentAuditRecovery({
        markerId: job.markerId,
        chatId: job.chatId,
        messageId: job.messageId,
        replyMessageId,
      });
    } else {
      await this.markerStore.completeChatAutoComment({
        chatId: job.chatId,
        messageId: job.messageId,
        lockToken: job.lockToken,
        status: CHAT_AUTO_COMMENT_ATTACH_STATUS.SUCCEEDED,
        source: 'webhook',
        botId: route.requiredBotId,
        deliveryMode: 'reply_message',
        replyMessageId,
        originalDeleted: false,
        lastError: null,
        lastStatusCode: null,
      });
    }
    await this.recordSendSuccess(job.chatId);
  }

  private async processKeyboardEdit(job: PublisherCommentKeyboardEditJob): Promise<void> {
    let route = await this.assertReady(job.chatId, job.readinessFeature);
    this.assertKeyboardIdentity(job, route);

    const currentCount = await this.prisma.auditLog.count({
      where: {
        chatId: job.chatId,
        action: PUBLISHER_CHAT_DIALOG_ACTION_COMMENT,
        payload: {
          path: ['threadId'],
          equals: job.threadId,
        },
      },
    });
    const buttons = job.buttons.map((row) => row.map((button) => ({ ...button })));
    const commentsButton = buttons[job.commentsButton.rowIndex]?.[job.commentsButton.columnIndex];
    if (!commentsButton) {
      throw new UnrecoverableError('Publisher comment keyboard button position is invalid');
    }
    commentsButton.text = formatCommentsButtonText(job.commentsButton.baseText, currentCount);

    route = await this.assertReady(job.chatId, job.readinessFeature);
    this.assertKeyboardIdentity(job, route);
    try {
      await this.maxClient.editMessageInlineKeyboard(
        job.chatId,
        job.messageId,
        null,
        {
          buttons,
          appendNewInlineKeyboardRows: true,
          mergeExistingInlineKeyboard: true,
          beforeEditMutation: async () => {
            const immediateRoute = await this.assertReady(job.chatId, job.readinessFeature);
            this.assertKeyboardIdentity(job, immediateRoute);
            route = immediateRoute;
          },
        },
        {
          trafficClass: 'background',
          actionHealthLane: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.COMMENT_NOTIFICATION,
          botId: route.requiredBotId,
        },
      );
    } catch (error: unknown) {
      await this.recordSendFailure(job.chatId, error);
      throw error;
    }
    await this.recordSendSuccess(job.chatId);
  }

  private async isSenderAdmin(
    job: PublisherChatCommentAttachJob,
    refreshWhenUnknown: boolean,
  ): Promise<boolean> {
    const readFreshAccess = async () => {
      const now = new Date();
      return this.prisma.managedEntityAccessEdge.findFirst({
        where: {
          chatId: job.chatId,
          userId: job.senderId,
          botId: this.publisherBotId,
          entityType: ChatEntityType.CHAT,
          checkedAt: {
            gt: new Date(now.getTime() - PUBLISHER_COMMENT_SENDER_ACCESS_FRESH_MS),
          },
          expiresAt: { gt: now },
        },
        select: { state: true, userRole: true },
      });
    };
    let access = await readFreshAccess();
    if (!access && refreshWhenUnknown) {
      await this.bindingRefresh.refresh({
        version: 1,
        chatId: job.chatId,
        publisherBotId: this.publisherBotId,
        candidateUserId: job.senderId,
        reason: 'webhook_observed',
        requestedAt: new Date().toISOString(),
      });
      access = await readFreshAccess();
    }
    return (
      access?.state === ManagedEntityAccessState.GRANTED &&
      (access.userRole === ManagedEntityAccessRole.ADMIN ||
        access.userRole === ManagedEntityAccessRole.OWNER)
    );
  }

  private skipNonAdminAttach(job: PublisherChatCommentAttachJob): Promise<void> {
    return this.markerStore.completeChatAutoComment({
      chatId: job.chatId,
      messageId: job.messageId,
      lockToken: job.lockToken,
      status: CHAT_AUTO_COMMENT_ATTACH_STATUS.SKIPPED,
      source: 'webhook',
      botId: this.publisherBotId,
      deliveryMode: 'reply_message',
      originalDeleted: false,
      lastError: 'Publisher chat-comment source sender is not an administrator',
      lastStatusCode: null,
    });
  }

  private async assertReady(
    chatId: string,
    feature: 'publication' | 'chat_comments',
  ): Promise<PublisherReadyRoute> {
    await this.runtimeBoundaryCheck();
    return this.readiness.assertEntityReady(chatId, feature);
  }

  private async runtimeBoundaryCheck(): Promise<void> {
    this.runtimeBoundary.assertDispatchEnabled();
    await this.dispatchHealth?.assertDispatchAllowed();
  }

  private assertAttachIdentity(
    job: PublisherChatCommentAttachJob,
    route: PublisherReadyRoute,
  ): void {
    if (route.requiredBotId !== this.publisherBotId || job.requiredBotId !== route.requiredBotId) {
      throw new UnrecoverableError('Publisher chat-comment readiness selected another bot');
    }
  }

  private assertKeyboardIdentity(
    job: PublisherCommentKeyboardEditJob,
    route: PublisherReadyRoute,
  ): void {
    if (route.requiredBotId !== this.publisherBotId || job.requiredBotId !== route.requiredBotId) {
      throw new UnrecoverableError(
        'Publisher comment keyboard origin bot does not match readiness',
      );
    }
    if (
      (job.entityType === 'chat' && route.entityType !== 'chat') ||
      (job.entityType === 'channel' && route.entityType !== 'channel')
    ) {
      throw new UnrecoverableError(
        'Publisher comment keyboard entity type does not match readiness',
      );
    }
  }

  private async handlePredispatchFailure(
    job: PublisherChatCommentAttachJob,
    error: unknown,
    attempt: PublisherJobAttempt,
  ): Promise<void> {
    if (error instanceof UnrecoverableError) {
      await this.releaseAttachClaim(job, error, this.publisherBotId);
      return;
    }
    if (attempt.final) {
      this.logger.warn(
        {
          chatId: job.chatId,
          messageId: job.messageId,
          attemptsMade: attempt.attemptsMade,
          maxAttempts: attempt.maxAttempts,
        },
        'Publisher chat-comment delivery remains pending after its final automatic attempt',
      );
    }
    await this.retainAttachClaim(job, error, this.publisherBotId);
  }

  private async handleRetryableAttachFailure(
    job: PublisherChatCommentAttachJob,
    error: unknown,
    attempt: PublisherJobAttempt,
    senderBotId: string,
    sendStartedAt: Date | null,
  ): Promise<void> {
    if (attempt.final) {
      this.logger.warn(
        {
          chatId: job.chatId,
          messageId: job.messageId,
          attemptsMade: attempt.attemptsMade,
          maxAttempts: attempt.maxAttempts,
        },
        'Publisher chat-comment delivery remains pending after its final automatic attempt',
      );
    }
    await this.retainAttachClaim(job, error, senderBotId, sendStartedAt);
  }

  private retainAttachClaim(
    job: PublisherChatCommentAttachJob,
    error: unknown,
    senderBotId: string,
    sendStartedAt: Date | null = null,
  ): Promise<void> {
    return this.markerStore.recordChatAutoCommentRetryableFailure({
      markerId: job.markerId,
      chatId: job.chatId,
      messageId: job.messageId,
      lockToken: job.lockToken,
      senderBotId,
      sendStartedAt,
      lastError: this.errorSummary(error),
      lastStatusCode: extractHttpStatusCode(error),
    });
  }

  private releaseAttachClaim(
    job: PublisherChatCommentAttachJob,
    error: unknown,
    senderBotId: string,
  ): Promise<void> {
    return this.markerStore.releaseChatAutoComment({
      chatId: job.chatId,
      messageId: job.messageId,
      lockToken: job.lockToken,
      source: 'webhook',
      botId: senderBotId,
      lastError: this.errorSummary(error),
      lastStatusCode: extractHttpStatusCode(error),
    });
  }

  private quarantineAmbiguousAttach(
    job: PublisherChatCommentAttachJob,
    summary: string,
    statusCode: number | null,
  ): Promise<void> {
    return this.markerStore.completeChatAutoComment({
      chatId: job.chatId,
      messageId: job.messageId,
      lockToken: job.lockToken,
      status: CHAT_AUTO_COMMENT_ATTACH_STATUS.SKIPPED,
      source: 'webhook',
      botId: this.publisherBotId,
      deliveryMode: 'reply_message',
      originalDeleted: false,
      lastError: `${MAX_SEND_AMBIGUOUS_ERROR_PREFIX} ${summary}`,
      lastStatusCode: statusCode,
    });
  }

  private async persistAttachAudit(params: {
    job: PublisherChatCommentAttachJob;
    replyMessageId: string;
    publisherBotId: string;
  }): Promise<void> {
    const auditId = buildChatAutoCommentAuditId(params.job.markerId);
    if (!auditId) {
      throw new UnrecoverableError('Publisher chat-comment marker id is invalid');
    }
    try {
      await this.prisma.auditLog.create({
        data: {
          id: auditId,
          chatId: params.job.chatId,
          actorUserId: params.job.senderId,
          action: CHAT_DIALOG_AUTO_ATTACH_ACTION,
          payload: {
            messageId: params.job.messageId,
            threadId: params.job.markerId,
            source: 'webhook',
            deliveryMode: 'reply_message',
            replyMessageId: params.replyMessageId,
            originalDeleted: false,
            botId: params.publisherBotId,
            publisherBotId: params.publisherBotId,
            dialogBotId: params.job.dialogBotId,
            publisherQueueVersion: 1,
          },
        },
      });
    } catch (error: unknown) {
      if ((error as { code?: unknown } | null)?.code !== 'P2002') {
        throw error;
      }
    }
  }

  private async recordSendFailure(chatId: string, error: unknown): Promise<void> {
    if (!this.dispatchHealth) {
      return;
    }
    try {
      await this.dispatchHealth.recordSendFailure(chatId, error);
    } catch (healthError: unknown) {
      this.logger.warn(
        {
          chatId,
          statusCode: extractPublisherMaxStatusCode(error),
          err: this.errorSummary(healthError),
        },
        'Failed to record publisher dispatch health failure',
      );
    }
  }

  private async recordSendSuccess(chatId: string): Promise<void> {
    if (!this.dispatchHealth) {
      return;
    }
    try {
      await this.dispatchHealth.recordSendSuccess(chatId);
    } catch (error: unknown) {
      this.logger.warn(
        { chatId, err: this.errorSummary(error) },
        'Failed to record publisher dispatch health success',
      );
    }
  }

  private assertEnvelope(job: PublisherChatCommentJob): void {
    if (job.version !== 1 || job.retryPolicyName !== 'publisher-chat-comment') {
      throw new UnrecoverableError('Publisher chat-comment job envelope is invalid');
    }
    const requiredStrings =
      job.kind === 'attach_chat_reply'
        ? [
            job.markerId,
            job.lockToken,
            job.chatId,
            job.messageId,
            job.senderId,
            job.requiredBotId,
            job.dialogBotId,
          ]
        : [job.chatId, job.messageId, job.threadId, job.requiredBotId, job.dialogBotId];
    if (requiredStrings.some((value) => typeof value !== 'string' || !value.trim())) {
      throw new UnrecoverableError('Publisher chat-comment job identity is invalid');
    }
    // FLAG: New chat dialogs are Publisher-signed; distinct main-bot dialog ids remain valid only
    // for already persisted compatibility envelopes.
    if (job.requiredBotId !== this.publisherBotId) {
      throw new UnrecoverableError('Publisher comment job targets another publisher bot');
    }
  }

  private errorSummary(error: unknown): string {
    const message =
      error instanceof Error && error.message.trim()
        ? error.message.trim()
        : String(error ?? 'Unknown error');
    return message.slice(0, 500);
  }
}
