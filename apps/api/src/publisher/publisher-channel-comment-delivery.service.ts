import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { countPublisherChatComments } from '../admin/publisher-chat-comment-store';
import { readInternalChannelDialogButtonIdentitiesFromMessage } from '../common/channel-dialog-button-identity.util';
import { buildChannelPostActionRows } from '../common/channel-post-actions';
import { formatCommentsButtonText } from '../common/dialog-button-label.util';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxMessageButton,
} from '../max/max-client.service';
import { hasConfirmedEditMessageAccess } from '../max/max-delete-message-access.util';
import { ChatEntityType, type Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherActionCredentialService } from './publisher-action-credential.service';
import type { PublisherChannelCommentAttachJob } from './publisher-chat-comment.queue';
import { PublisherDialogLinkService } from './publisher-dialog-link.service';
import { PublisherReadinessService } from './publisher-readiness.service';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';
import { PublisherDispatchHealthService } from './publisher-dispatch-health.service';

@Injectable()
export class PublisherChannelCommentDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly readiness: PublisherReadinessService,
    private readonly runtime: PublisherRuntimeBoundaryService,
    private readonly credentials: PublisherActionCredentialService,
    private readonly links: PublisherDialogLinkService,
    private readonly health: PublisherDispatchHealthService,
  ) {}

  async process(job: PublisherChannelCommentAttachJob): Promise<void> {
    const age = Date.now() - Date.parse(job.createdAt);
    if (
      job.requiredBotId !== this.credentials.getBotId() ||
      job.dialogBotId !== job.requiredBotId ||
      !Number.isSafeInteger(job.publisherSettingsRevision) ||
      job.publisherSettingsRevision < 0 ||
      !Number.isSafeInteger(job.publicationPolicyRevision) ||
      job.publicationPolicyRevision < 0 ||
      !Number.isFinite(age) ||
      age < -60_000 ||
      age > 24 * 60 * 60_000
    ) {
      throw new UnrecoverableError('Invalid or expired Publisher channel keyboard identity');
    }
    const settings = await this.readCurrentSettings(job);
    if (!settings) return;
    await this.assertReady(job);
    const requestOptions = {
      botId: job.requiredBotId,
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
    } as const;
    let reference: Prisma.InputJsonObject | null = null;
    try {
      await this.maxClient.editMessageInlineKeyboard(
        job.chatId,
        job.messageId,
        null,
        {
          mergeExistingInlineKeyboard: true,
          appendNewInlineKeyboardRows: true,
          requireAllAttachmentsPreserved: true,
          prepareInlineKeyboard: async (message) => {
            const recipient = message?.recipient as Record<string, unknown> | undefined;
            if (
              !message ||
              !recipient ||
              String(recipient.chat_id) !== job.chatId ||
              recipient.chat_type !== 'channel' ||
              recipient.post_id != null
            ) {
              throw new UnrecoverableError(
                'Publisher keyboard source is not the exact channel post',
              );
            }
            // FLAG: Resolve existing Publisher threads inside the shared message edit lock;
            // Major links must neither suppress these buttons nor donate their thread identity.
            const identities = readInternalChannelDialogButtonIdentitiesFromMessage(
              message,
              job.chatId,
              'publisher',
              job.requiredBotId,
            );
            const threadId =
              identities.find((item) => item.kind === 'comments')?.threadId ??
              identities[0]?.threadId ??
              job.threadId;
            const count = settings.channelCommentsEnabled
              ? await countPublisherChatComments(this.prisma, job.chatId, threadId)
              : 0;
            const commentsText = '💬 Комментарии';
            const suggestText = '✍️ Предложить объявление';
            const comments = settings.channelCommentsEnabled
              ? this.links.buildChannelDialogButton(
                  job.chatId,
                  'comments',
                  threadId,
                  formatCommentsButtonText(commentsText, count),
                  'MINIAPP',
                )
              : null;
            const suggest = settings.channelSuggestionsEnabled
              ? this.links.buildChannelDialogButton(
                  job.chatId,
                  'suggest',
                  threadId,
                  suggestText,
                  'MINIAPP',
                )
              : null;
            const buttonRows = buildChannelPostActionRows({
              commentsButton: comments,
              suggestButton: suggest,
            });
            reference = {
              messageId: job.messageId,
              threadId,
              botId: job.requiredBotId,
              dialogBotId: job.dialogBotId,
              publisherProfile: true,
              source: 'publisher_channel_webhook',
              includeCommentsButton: settings.channelCommentsEnabled,
              includeSuggestButton: settings.channelSuggestionsEnabled,
              suggestionEntryMode: 'MINIAPP',
              suggestButtonText: suggestText,
              buttonRows: buttonRows as Prisma.InputJsonValue,
              commentsButton: comments
                ? { rowIndex: 0, columnIndex: 0, baseText: commentsText }
                : null,
            };
            const missing: MaxMessageButton[][] = [];
            if (comments && !identities.some((item) => item.kind === 'comments'))
              missing.push([comments]);
            if (suggest && !identities.some((item) => item.kind === 'suggest'))
              missing.push([suggest]);
            return missing.length ? missing : null;
          },
          beforeEditMutation: async () => {
            await this.assertReady(job);
            const snapshot = await this.maxClient.getChatSnapshot(job.chatId, {
              ...requestOptions,
              bypassCache: true,
              timeoutMs: 2_000,
            });
            const access = await this.maxClient.getCurrentChatMemberAccess(job.chatId, {
              ...requestOptions,
              bypassCache: true,
              timeoutMs: 2_000,
            });
            if (
              snapshot.entityType !== 'channel' ||
              !hasConfirmedEditMessageAccess({ ...access, checkedAt: null }, ChatEntityType.CHANNEL)
            ) {
              throw new UnrecoverableError('Publisher cannot edit this channel post');
            }
            if (!(await this.readCurrentSettings(job))) {
              throw new UnrecoverableError(
                'Publisher channel settings changed before keyboard edit',
              );
            }
          },
        },
        requestOptions,
      );
      if (reference) {
        await this.prisma.auditLog.upsert({
          where: { id: job.idempotencyKey },
          create: {
            id: job.idempotencyKey,
            chatId: job.chatId,
            actorUserId: job.requiredBotId,
            action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
            payload: reference,
          },
          update: {},
        });
      }
    } catch (error: unknown) {
      await this.health.recordSendFailure(job.chatId, error).catch(() => undefined);
      throw error;
    }
  }

  private async assertReady(job: PublisherChannelCommentAttachJob): Promise<void> {
    this.runtime.assertDispatchEnabled();
    await this.health.assertDispatchAllowed();
    const route = await this.readiness.assertEntityReady(job.chatId, 'publication');
    if (route.entityType !== 'channel' || route.requiredBotId !== job.requiredBotId) {
      throw new UnrecoverableError('Publisher channel readiness selected another route');
    }
  }

  private async readCurrentSettings(job: PublisherChannelCommentAttachJob) {
    const entity = await this.prisma.chat.findUnique({
      where: { id: job.chatId },
      select: {
        entityType: true,
        publicationPolicy: { select: { publikEnabled: true, revision: true } },
        publisherSettings: {
          select: { channelCommentsEnabled: true, channelSuggestionsEnabled: true, revision: true },
        },
      },
    });
    const settings = entity?.publisherSettings;
    return entity?.entityType === ChatEntityType.CHANNEL &&
      settings &&
      (settings.channelCommentsEnabled || settings.channelSuggestionsEnabled) &&
      settings.revision === job.publisherSettingsRevision &&
      entity.publicationPolicy?.publikEnabled !== false &&
      (entity.publicationPolicy?.revision ?? 0) === job.publicationPolicyRevision
      ? settings
      : null;
  }
}
