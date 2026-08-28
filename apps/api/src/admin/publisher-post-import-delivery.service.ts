import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  wasMaxMessageSendAttempted,
} from '../max/max-client.service';
import { PublisherPostImportStatus } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PUBLISHER_POST_IMPORT_CANCEL_PAYLOAD_PREFIX } from '../publisher/publisher-post-import.service';
import type {
  PublisherPostImportJob,
  PublisherPostImportNotification,
} from '../publisher/publisher-post-import.queue';

const FAILURE_TEXT: Record<string, string> = {
  invalid_forward: 'Не удалось распознать пересылку',
  message_unavailable: 'Сообщение больше недоступно',
  unsupported_content: 'Этот тип поста пока не поддерживается',
  text_too_long: 'Текст длиннее 4 000 символов',
  too_many_images: 'В посте больше 10 фото',
  image_too_large: 'Одно из фото больше 8 МБ',
  media_too_large: 'Медиа превышает лимит 24 МБ',
  media_download_failed: 'Не удалось сохранить медиа',
  processing_timeout: 'Импорт занял слишком много времени',
  internal_error: 'Не удалось подготовить черновик',
};
const NOTIFICATION_LEASE_MS = 30_000;

@Injectable()
export class PublisherPostImportDeliveryService {
  private readonly logger = new Logger(PublisherPostImportDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
  ) {}

  async deliver(job: Extract<PublisherPostImportJob, { kind: 'notify' }>): Promise<void> {
    const session = await this.prisma.publisherPostImportSession.findUnique({
      where: { id: job.sessionId },
    });
    if (!session || !this.notificationMatchesState(job.notification, session.status)) {
      return;
    }
    const privateChatId = job.privateChatId?.trim() || session.privateChatId?.trim() || '';
    if (!privateChatId) {
      return;
    }
    const notificationLockToken = randomUUID();
    const claimAt = new Date();
    const deliveryClaim = await this.prisma.publisherPostImportSession.updateMany({
      where: {
        id: session.id,
        status: session.status,
        notificationPending: true,
        notificationKind: job.notification,
        notificationDispatchStartedAt: null,
        OR: [
          { notificationLockedAt: null },
          {
            notificationLockedAt: {
              lt: new Date(claimAt.getTime() - NOTIFICATION_LEASE_MS),
            },
          },
        ],
      },
      data: {
        notificationLockedAt: claimAt,
        notificationLockToken,
      },
    });
    if (deliveryClaim.count === 0) {
      return;
    }

    const content = this.resolveContent(job.notification, session.failureCode);
    const buttons = this.resolveButtons(
      job.notification,
      session.startToken,
      session.publisherBotId,
      session.publicationId,
    );
    const requestOptions = {
      botId: session.publisherBotId,
      trafficClass: 'interactive' as const,
      actionHealthLane: 'background' as const,
      sourceTag: MAX_API_SOURCE_TAGS.PUBLISHER_POST_IMPORT,
      timeoutMs: 5_000,
    };

    if (job.notification === 'canceled' && job.callbackId?.trim()) {
      try {
        await this.maxClient.answerCallback(
          job.callbackId,
          'Отменено',
          session.botStatusMessageId
            ? {
                messageId: session.botStatusMessageId,
                text: content,
                options: { buttons: [] },
              }
            : undefined,
          { ...requestOptions, rateLimitEntityId: privateChatId },
        );
        await this.recordDeliveredState(session.id, session.status, notificationLockToken);
        return;
      } catch (error: unknown) {
        this.logger.warn(
          {
            sessionId: session.id,
            err: error instanceof Error ? error.message : String(error),
          },
          'Publisher post import callback answer failed; falling back to message edit',
        );
      }
    }

    const shouldSendTerminalMessage =
      job.notification === 'ready' || job.notification === 'failed';
    if (session.botStatusMessageId && !shouldSendTerminalMessage) {
      try {
        await this.maxClient.editMessageInlineKeyboard(
          privateChatId,
          session.botStatusMessageId,
          content,
          {
            buttons,
            debugContext: {
              screen: 'publisher_post_import',
              action: job.notification,
            },
          },
          requestOptions,
        );
        await this.recordDeliveredState(session.id, session.status, notificationLockToken);
        return;
      } catch (error: unknown) {
        await this.releaseDeliveryClaim(session.id, notificationLockToken);
        throw error;
      }
    }

    let dispatchStarted = false;
    try {
      const sent = await this.maxClient.sendMessageImmediateWithId(
        privateChatId,
        content,
        {
          buttons,
          debugContext: {
            screen: 'publisher_post_import',
            action: job.notification,
          },
          beforeSend: async () => {
            const marked = await this.prisma.publisherPostImportSession.updateMany({
              where: {
                id: session.id,
                notificationPending: true,
                notificationLockToken,
                notificationDispatchStartedAt: null,
              },
              data: { notificationDispatchStartedAt: new Date() },
            });
            if (marked.count !== 1) {
              throw new Error('Publisher post import notification claim was superseded');
            }
            dispatchStarted = true;
          },
        },
        requestOptions,
      );
      await this.recordDeliveredState(
        session.id,
        session.status,
        notificationLockToken,
        sent.messageId,
        privateChatId,
      );
    } catch (error: unknown) {
      if (dispatchStarted || wasMaxMessageSendAttempted(error)) {
        await this.prisma.publisherPostImportSession.updateMany({
          where: { id: session.id, notificationLockToken },
          data: {
            notificationPending: false,
            lastNotifiedStatus: `AMBIGUOUS:${session.status}`,
            notificationLockedAt: null,
            notificationLockToken: null,
          },
        });
        this.logger.warn(
          { sessionId: session.id, notification: job.notification },
          'Publisher post import status send became ambiguous and will not be retried',
        );
        return;
      }
      await this.releaseDeliveryClaim(session.id, notificationLockToken);
      throw error;
    }
  }

  private async recordDeliveredState(
    sessionId: string,
    status: PublisherPostImportStatus,
    notificationLockToken: string,
    botStatusMessageId?: string,
    privateChatId?: string,
  ): Promise<void> {
    await this.prisma.publisherPostImportSession.updateMany({
      where: { id: sessionId, status, notificationLockToken },
      data: {
        lastNotifiedStatus: status,
        notificationPending: false,
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationDispatchStartedAt: null,
        ...(botStatusMessageId ? { botStatusMessageId } : {}),
        ...(privateChatId ? { privateChatId } : {}),
      },
    });
  }

  private async releaseDeliveryClaim(
    sessionId: string,
    notificationLockToken: string,
  ): Promise<void> {
    await this.prisma.publisherPostImportSession.updateMany({
      where: {
        id: sessionId,
        notificationLockToken,
        notificationDispatchStartedAt: null,
      },
      data: { notificationLockedAt: null, notificationLockToken: null },
    });
  }

  private resolveContent(
    notification: PublisherPostImportNotification,
    failureCode: string | null,
  ) {
    switch (notification) {
      case 'prompt':
        return 'Перешлите один пост';
      case 'need_forward':
        return 'Нужно переслать готовый пост';
      case 'processing':
        return 'Пост принят';
      case 'ready':
        return 'Черновик готов';
      case 'failed':
        return FAILURE_TEXT[failureCode ?? ''] ?? FAILURE_TEXT.internal_error!;
      case 'canceled':
        return 'Отменено';
    }
  }

  private resolveButtons(
    notification: PublisherPostImportNotification,
    startToken: string,
    publisherBotId: string,
    publicationId: string | null,
  ) {
    if (notification === 'prompt' || notification === 'need_forward') {
      return [
        [
          {
            type: 'callback' as const,
            text: 'Отмена',
            payload: `${PUBLISHER_POST_IMPORT_CANCEL_PAYLOAD_PREFIX}${startToken}`,
          },
        ],
      ];
    }
    if (notification !== 'ready') {
      return [];
    }
    if (!publicationId?.trim()) {
      return [];
    }
    const startParam = `pi_${startToken}`;
    const url = `https://max.ru/${encodeURIComponent(publisherBotId)}?startapp=${encodeURIComponent(
      startParam,
    )}`;
    return [[{ type: 'link' as const, text: 'Открыть черновик', url }]];
  }

  private notificationMatchesState(
    notification: PublisherPostImportNotification,
    status: PublisherPostImportStatus,
  ): boolean {
    switch (notification) {
      case 'prompt':
      case 'need_forward':
        return status === PublisherPostImportStatus.WAITING;
      case 'processing':
        return status === PublisherPostImportStatus.PROCESSING;
      case 'ready':
        return status === PublisherPostImportStatus.READY;
      case 'failed':
        return status === PublisherPostImportStatus.FAILED;
      case 'canceled':
        return status === PublisherPostImportStatus.CANCELED;
    }
  }
}
