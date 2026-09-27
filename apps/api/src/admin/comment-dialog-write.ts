import type { ChannelDialogReplyPreview, ManagedEntityType } from '@maxim/contracts';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import { ServiceUnavailableException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '../prisma/prisma-client';
import type { PublisherCommentNotificationService } from '../publisher/publisher-comment-notification.service';
import { resolveDialogAuditAction } from './admin-dialog-profile-helpers';
import type {
  ChannelDialogAttachmentAsset,
  ChannelDialogMessageSource,
} from './admin.service.support';
import { withCommentWrite } from './comment-restriction-store';

export function createCommentDialogAudit(
  prisma: PrismaClient,
  params: {
    chatId: string;
    entityType: ManagedEntityType;
    dialogProfile?: MiniappProfile;
    dialogType: 'comments';
    user: { userId: string };
    threadId: string | null;
    text: string;
    authorDisplayName: string | null;
    authorAvatarUrl: string | null;
    replyTo: ChannelDialogReplyPreview | null;
    source: ChannelDialogMessageSource;
  },
  attachments: ChannelDialogAttachmentAsset[],
  notifications?: PublisherCommentNotificationService,
) {
  return withCommentWrite(
    prisma,
    {
      chatId: params.chatId,
      entityType: params.entityType,
      profile: params.dialogProfile ?? 'moderation',
    },
    params.user.userId,
    async (tx) => {
      const row = await tx.auditLog.create({
        data: {
          chatId: params.chatId,
          actorUserId: params.user.userId,
          action: resolveDialogAuditAction(params.dialogType, params.dialogProfile),
          payload: {
            type: params.dialogType,
            threadId: params.threadId,
            text: params.text,
            authorDisplayName: params.authorDisplayName ?? null,
            authorAvatarUrl: params.authorAvatarUrl ?? null,
            ...(params.replyTo
              ? {
                  replyTo: {
                    messageId: params.replyTo.messageId,
                    authorDisplayName: params.replyTo.authorDisplayName,
                    text: params.replyTo.text,
                  },
                }
              : {}),
            ...(attachments.length ? { attachments: attachments as Prisma.InputJsonValue } : {}),
            ...(params.entityType === 'chat' ? { delivered: true, deliveredToUserId: null } : {}),
            source: params.source,
            ...(params.dialogProfile === 'publisher' ? { publisherProfile: true } : {}),
          },
        },
      });
      if (params.dialogProfile === 'publisher') {
        if (!notifications || !params.threadId)
          throw new ServiceUnavailableException('Уведомления Публика временно недоступны.');
        await notifications.recordComment(tx, {
          id: row.id,
          chatId: params.chatId,
          entityType: params.entityType,
          threadId: params.threadId,
          authorUserId: params.user.userId,
          replyToId: params.replyTo?.messageId ?? null,
          createdAt: row.createdAt,
        });
      }
      return row;
    },
  );
}
