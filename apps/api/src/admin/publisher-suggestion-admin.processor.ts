import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import {
  ChannelSuggestionAdminDeliveryStatus,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherDispatchHealthService } from '../publisher/publisher-dispatch-health.service';
import { PublisherActionCredentialService } from '../publisher/publisher-action-credential.service';
import {
  assertPublisherDispatchAllowedOrDelay,
  assertPublisherRuntimeEnabledOrDelay,
} from '../publisher/publisher-dispatch-job-guard';
import { PublisherIdentityAttestationService } from '../publisher/publisher-identity-attestation.service';
import { assertPublisherIdentityOrDelay } from '../publisher/publisher-identity-attestation-job-guard';
import { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import {
  PUBLISHER_SUGGESTION_ADMIN_QUEUE,
  PublisherSuggestionAdminQueueService,
  type PublisherSuggestionAdminJob,
  type PublisherSuggestionAdminReviewStatus,
} from '../publisher/publisher-suggestion-admin.queue';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import { ChannelDialogService } from './channel-dialog.service';
import {
  MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS,
  PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST,
} from './admin.service.support';
import { PublisherSuggestionService } from './publisher-suggestion.service';

@Processor(PUBLISHER_SUGGESTION_ADMIN_QUEUE, { concurrency: 1 })
export class PublisherSuggestionAdminProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly channelDialogs: ChannelDialogService,
    private readonly suggestions: PublisherSuggestionService,
    private readonly queue: PublisherSuggestionAdminQueueService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    private readonly credentials: PublisherActionCredentialService,
  ) {
    super();
  }

  async process(job: Job<PublisherSuggestionAdminJob>, token?: string): Promise<void> {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher') {
      throw new Error('Publisher suggestion admin job received by a non-publisher API role');
    }
    if (job.data.requiredBotId !== this.credentials.getBotId()) {
      throw new UnrecoverableError('Publisher suggestion admin job targets another bot');
    }
    await assertPublisherRuntimeEnabledOrDelay(this.runtimeBoundary, job, token);
    await assertPublisherIdentityOrDelay(this.identityAttestation, job, token);
    await assertPublisherDispatchAllowedOrDelay(this.dispatchHealth, job, token);

    if (job.data.kind === 'deliver') {
      await this.channelDialogs.processPublisherSuggestionAdminDeliveryJob(
        job.data.suggestionId,
        job.data.requiredBotId,
      );
      return;
    }
    if (job.data.kind === 'sync') {
      await this.channelDialogs.syncPublisherSuggestionAdminReviewMessages(
        job.data.suggestionId,
        job.data.requiredBotId,
      );
      return;
    }
    await this.processReview(job.data);
  }

  private async processReview(job: Extract<PublisherSuggestionAdminJob, { kind: 'review' }>) {
    const row = await this.prisma.auditLog.findFirst({
      where: {
        id: job.suggestionId,
        action: PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST,
      },
      select: { id: true, chatId: true },
    });
    if (!row) {
      await this.answerCallback(job, 'Предложка не найдена.');
      return;
    }

    const deliveredCard = await this.prisma.channelSuggestionAdminDelivery.findFirst({
      where: {
        auditLogId: row.id,
        adminUserId: job.actor.userId,
        botKey: `publisher:${job.requiredBotId}`,
        botId: job.requiredBotId,
        privateChatId: job.privateChatId,
        remoteMessageId: job.messageId,
        status: ChannelSuggestionAdminDeliveryStatus.SENT,
      },
      select: { id: true },
    });
    if (!deliveredCard) {
      await this.answerCallback(job, 'Эта кнопка больше недоступна.');
      return;
    }

    try {
      const now = new Date();
      const accessEdge = await this.prisma.managedEntityAccessEdge.findFirst({
        where: {
          chatId: row.chatId,
          userId: job.actor.userId,
          botId: job.requiredBotId,
          state: ManagedEntityAccessState.GRANTED,
          userRole: { in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN] },
          OR: [
            { expiresAt: { gt: now } },
            {
              expiresAt: null,
              checkedAt: {
                gt: new Date(now.getTime() - MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS),
              },
            },
          ],
        },
        select: { chatId: true },
      });
      if (!accessEdge) {
        throw new ForbiddenException('Publisher access edge is no longer fresh.');
      }
      const access = (
        await this.maxClient.getChatMembersAccess(row.chatId, [job.actor.userId], {
          botId: job.requiredBotId,
          trafficClass: 'interactive',
          actionHealthLane: 'interactive',
          sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
          bypassCache: true,
        })
      ).get(job.actor.userId);
      if (!access || (!access.isAdmin && !access.isOwner)) {
        throw new ForbiddenException('Права администратора канала больше не подтверждены.');
      }

      const result = await this.suggestions.review(
        row.chatId,
        row.id,
        {
          userId: job.actor.userId,
          launchBotId: job.requiredBotId,
          username: job.actor.username,
          displayName: job.actor.displayName,
          avatarUrl: job.actor.avatarUrl,
          profileUrl: job.actor.profileUrl,
          chatId: job.privateChatId,
          chatType: 'dialog',
        },
        { action: job.action, responseVersion: 2 },
      );
      const reviewStatus = result.suggestion.reviewStatus;
      if (isTerminalReviewStatus(reviewStatus)) {
        await this.queue.enqueueSync({
          suggestionId: row.id,
          requiredBotId: job.requiredBotId,
          reviewStatus,
          recoverExisting: true,
        });
      }
      await this.answerCallback(job, reviewNotification(reviewStatus));
    } catch (error: unknown) {
      await this.answerCallback(job, reviewErrorNotification(error));
      if (!isTerminalReviewError(error)) {
        throw error;
      }
    }
  }

  private async answerCallback(
    job: Extract<PublisherSuggestionAdminJob, { kind: 'review' }>,
    notification: string,
  ): Promise<void> {
    try {
      await this.maxClient.answerCallback(job.callbackId, notification, undefined, {
        botId: job.requiredBotId,
        rateLimitEntityId: job.privateChatId,
        actionHealthLane: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.CALLBACK_ANSWER,
      });
    } catch {
      // Review state and card synchronization remain authoritative if callback UI expires.
    }
  }
}

function isTerminalReviewStatus(value: string): value is PublisherSuggestionAdminReviewStatus {
  return value === 'published' || value === 'drafted' || value === 'cancelled';
}

function reviewNotification(status: string): string {
  if (status === 'published') return 'Предложка передана в публикацию.';
  if (status === 'cancelled') return 'Предложка отклонена.';
  if (status === 'drafted') return 'Черновик создан.';
  return 'Предложка отправлена в публикацию.';
}

function isTerminalReviewError(error: unknown): boolean {
  if (!(error instanceof HttpException)) return false;
  const status = error.getStatus();
  return status >= 400 && status < 500 && status !== 429;
}

function reviewErrorNotification(error: unknown): string {
  if (error instanceof ForbiddenException) return 'Права администратора не подтверждены.';
  if (error instanceof HttpException && error.getStatus() === 409) {
    return 'Состояние предложки уже изменилось.';
  }
  return 'Не удалось обработать предложку. Повторите позже.';
}
