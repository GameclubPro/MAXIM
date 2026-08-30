import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  wasMaxMessageSendAttempted,
  type MaxMessageButton,
} from '../max/max-client.service';
import { PublisherAutoReplyAuthoringState } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  PublisherAutoReplyAuthoringJob,
  PublisherAutoReplyAuthoringNotification,
} from '../publisher/publisher-auto-reply-authoring.queue';
import { readStoredPublicationButtons } from './publication-buttons';

const NOTIFICATION_LEASE_MS = 30_000;

@Injectable()
export class PublisherAutoReplyAuthoringDeliveryService {
  private readonly logger = new Logger(PublisherAutoReplyAuthoringDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
  ) {}

  async deliver(job: Extract<PublisherAutoReplyAuthoringJob, { kind: 'notify' }>): Promise<void> {
    const session = await this.prisma.publisherAutoReplyAuthoringSession.findUnique({
      where: { id: job.sessionId },
      include: {
        rule: {
          include: {
            currentContentRevision: {
              select: {
                text: true,
                textFormat: true,
                buttons: true,
                _count: { select: { assets: true } },
              },
            },
          },
        },
      },
    });
    if (
      !session ||
      !session.notificationPending ||
      session.notificationKind !== job.notification ||
      !this.notificationMatchesState(job.notification, session.state)
    ) {
      return;
    }
    const privateChatId = session.privateChatId?.trim() ?? '';
    if (!privateChatId) return;

    const lockToken = randomUUID();
    const now = new Date();
    const notificationRevision = session.notificationRevision;
    const claimed = await this.prisma.publisherAutoReplyAuthoringSession.updateMany({
      where: {
        id: session.id,
        state: session.state,
        notificationPending: true,
        notificationKind: job.notification,
        notificationRevision,
        notificationDispatchStartedAt: null,
        OR: [
          { notificationLockedAt: null },
          { notificationLockedAt: { lte: new Date(now.getTime() - NOTIFICATION_LEASE_MS) } },
        ],
      },
      data: {
        notificationLockedAt: now,
        notificationLockToken: lockToken,
        notificationClaimRevision: notificationRevision,
      },
    });
    if (claimed.count !== 1) {
      throw new Error('Publisher auto-reply authoring notification is waiting for prior delivery');
    }

    const text = this.notificationText(job.notification, session);
    const buttons = this.notificationButtons(job.notification, session);
    const requestOptions = {
      botId: session.publisherBotId,
      trafficClass: 'interactive' as const,
      actionHealthLane: 'background' as const,
      sourceTag: MAX_API_SOURCE_TAGS.PUBLISHER_AUTO_REPLY,
      timeoutMs: 5_000,
    };

    if (job.callbackId?.trim()) {
      try {
        await this.maxClient.answerCallback(job.callbackId, 'Готово', undefined, {
          ...requestOptions,
          rateLimitEntityId: privateChatId,
        });
      } catch {
        this.logger.warn(
          { sessionId: session.id, notification: job.notification },
          'Publisher auto-reply callback answer failed; continuing with a new status message',
        );
      }
    }

    let sendStarted = false;
    try {
      const sent = await this.maxClient.sendMessageImmediateWithId(
        privateChatId,
        text,
        {
          buttons,
          beforeSend: async () => {
            const fenced = await this.prisma.publisherAutoReplyAuthoringSession.updateMany({
              where: {
                id: session.id,
                state: session.state,
                notificationPending: true,
                notificationRevision,
                notificationLockToken: lockToken,
                notificationClaimRevision: notificationRevision,
                notificationDispatchStartedAt: null,
              },
              data: { notificationDispatchStartedAt: new Date() },
            });
            if (fenced.count !== 1) {
              throw new Error('Publisher auto-reply authoring notification was superseded');
            }
            sendStarted = true;
          },
          debugContext: { screen: 'publisher_auto_reply_authoring', action: job.notification },
        },
        requestOptions,
      );
      await this.complete(
        session.id,
        session.state,
        job.notification,
        notificationRevision,
        lockToken,
        sent.messageId,
      );
    } catch (error: unknown) {
      if (sendStarted || wasMaxMessageSendAttempted(error)) {
        const current = await this.prisma.publisherAutoReplyAuthoringSession.updateMany({
          where: {
            id: session.id,
            state: session.state,
            notificationKind: job.notification,
            notificationRevision,
            notificationLockToken: lockToken,
            notificationClaimRevision: notificationRevision,
          },
          data: {
            notificationPending: false,
            notificationKind: null,
            notificationLockedAt: null,
            notificationLockToken: null,
            notificationClaimRevision: null,
            notificationLastAmbiguousRevision: notificationRevision,
            notificationDispatchStartedAt: null,
          },
        });
        if (current.count !== 1) {
          await this.releaseSuperseded(
            session.id,
            notificationRevision,
            lockToken,
            undefined,
            true,
          );
        }
        this.logger.warn(
          { sessionId: session.id, notification: job.notification },
          'Publisher auto-reply authoring notification became ambiguous and will not be retried',
        );
        return;
      }
      await this.release(session.id, lockToken);
      throw error;
    }
  }

  private notificationText(
    notification: PublisherAutoReplyAuthoringNotification,
    session: {
      phrase: string | null;
      failureCode: string | null;
      omissions: unknown;
      rule: {
        currentContentRevision: {
          buttons: unknown;
          _count: { assets: number };
        } | null;
      } | null;
    },
  ): string {
    switch (notification) {
      case 'prompt_phrase':
        if (session.failureCode === 'phrase_conflict') {
          return 'Такая кодовая фраза уже используется. Отправьте другую фразу.';
        }
        if (session.failureCode === 'invalid_phrase') {
          return 'Отправьте кодовую фразу одним текстовым сообщением, до 80 символов.';
        }
        return 'Отправьте кодовую фразу для автоответа.';
      case 'prompt_content':
        return `Фраза «${session.phrase ?? ''}» сохранена. Пришлите одним сообщением ответ, который Публик будет отправлять участникам. Можно использовать форматирование и добавить до 10 фото. Кнопки-ссылки можно добавить после сохранения в мини-приложении.`;
      case 'processing':
        return 'Готовлю автоответ.';
      case 'ready': {
        const imageCount = session.rule?.currentContentRevision?._count.assets ?? 0;
        const buttonCount = readStoredPublicationButtons(
          session.rule?.currentContentRevision?.buttons,
        ).length;
        const details = [
          ...(imageCount ? [`Фото: ${imageCount}`] : []),
          ...(buttonCount ? [`Кнопки: ${buttonCount}`] : []),
        ];
        const summary = `Автоответ для фразы «${session.phrase ?? ''}» готов.${details.length > 0 ? ` ${details.join('. ')}.` : ''}`;
        return `${summary}${this.omissionText(session.omissions)}`;
      }
      case 'conflict':
        return `Фраза «${session.phrase ?? ''}» уже занята другим автоответом. Измените её и попробуйте снова.`;
      case 'activated':
        return `Автоответ для фразы «${session.phrase ?? ''}» включён.`;
      case 'failed':
        return this.failureText(session.failureCode);
      case 'canceled':
        return 'Создание автоответа отменено.';
    }
  }

  private omissionText(value: unknown): string {
    if (!Array.isArray(value)) return '';
    const omissions = new Set(value.filter((item): item is string => typeof item === 'string'));
    const notices = [
      ...(omissions.has('formatting_not_preserved') ? [' Часть форматирования упрощена.'] : []),
      ...(omissions.has('buttons_not_imported') ? [' Некоторые кнопки не добавлены.'] : []),
      ...(omissions.has('attachments_not_imported') ? [' Другие вложения не добавлены.'] : []),
    ];
    return notices.join('');
  }

  private notificationButtons(
    notification: PublisherAutoReplyAuthoringNotification,
    session: { startToken: string; publisherBotId: string; targetChatId: string },
  ): MaxMessageButton[][] {
    const callback = (action: string, text: string): MaxMessageButton => ({
      type: 'callback',
      text,
      payload: `ar:${action}:${session.startToken}`,
    });
    const configureUrl = this.buildConfigureUrl(session.publisherBotId, session.targetChatId);
    if (notification === 'prompt_phrase' || notification === 'prompt_content') {
      return [[callback('cancel', 'Отмена')]];
    }
    if (notification === 'ready' || notification === 'conflict') {
      return [
        ...(notification === 'ready' ? [[callback('activate', 'Включить')]] : []),
        [
          callback('replace_phrase', 'Изменить фразу'),
          callback('replace_content', 'Заменить ответ'),
        ],
        [callback('cancel', 'Отмена')],
      ];
    }
    if (notification === 'activated' && configureUrl) {
      return [[{ type: 'link', text: 'Открыть автоответы', url: configureUrl }]];
    }
    return [];
  }

  private buildConfigureUrl(publisherBotId: string, chatId: string): string | null {
    const route = `/publisher/chat/${encodeURIComponent(chatId)}/auto-replies`;
    const payload = `mr-${Buffer.from(
      JSON.stringify({ v: 1, k: 'route', r: route }),
      'utf8',
    ).toString('base64url')}`;
    if (payload.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(payload)) return null;
    return `https://max.ru/${encodeURIComponent(publisherBotId)}?startapp=${encodeURIComponent(payload)}`;
  }

  private failureText(code: string | null): string {
    switch (code) {
      case 'phrase_conflict':
        return 'Эта кодовая фраза уже занята другим автоответом.';
      case 'text_too_long':
        return 'Текст ответа длиннее 4 000 символов.';
      case 'too_many_images':
        return 'В ответе больше 10 фотографий.';
      case 'duplicate_images':
        return 'Одно и то же фото добавлено несколько раз.';
      case 'image_too_large':
        return 'Одна из фотографий слишком большая.';
      case 'media_too_large':
        return 'Суммарный размер фотографий слишком большой.';
      case 'unsupported_content':
        return 'Для автоответа поддерживаются текст, фотографии и кнопки-ссылки.';
      case 'access_or_activation_failed':
        return 'Не удалось подтвердить доступ к чату. Откройте Публик и проверьте права.';
      case 'bot_capability_required':
        return 'Боту не хватает прав для автоответов. Проверьте права бота в чате.';
      default:
        return 'Не удалось подготовить автоответ. Начните создание ещё раз.';
    }
  }

  private async complete(
    sessionId: string,
    state: PublisherAutoReplyAuthoringState,
    notification: PublisherAutoReplyAuthoringNotification,
    notificationRevision: number,
    lockToken: string,
    botStatusMessageId?: string,
  ): Promise<void> {
    const completed = await this.prisma.publisherAutoReplyAuthoringSession.updateMany({
      where: {
        id: sessionId,
        state,
        notificationKind: notification,
        notificationRevision,
        notificationLockToken: lockToken,
        notificationClaimRevision: notificationRevision,
      },
      data: {
        notificationPending: false,
        notificationKind: null,
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationClaimRevision: null,
        notificationDispatchStartedAt: null,
        ...(botStatusMessageId ? { botStatusMessageId } : {}),
      },
    });
    if (completed.count === 1) return;
    await this.releaseSuperseded(sessionId, notificationRevision, lockToken, botStatusMessageId);
  }

  private releaseSuperseded(
    sessionId: string,
    notificationRevision: number,
    lockToken: string,
    botStatusMessageId?: string,
    ambiguous = false,
  ): Promise<{ count: number }> {
    return this.prisma.publisherAutoReplyAuthoringSession.updateMany({
      where: {
        id: sessionId,
        notificationLockToken: lockToken,
        notificationClaimRevision: notificationRevision,
      },
      data: {
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationClaimRevision: null,
        notificationDispatchStartedAt: null,
        ...(ambiguous ? { notificationLastAmbiguousRevision: notificationRevision } : {}),
        ...(botStatusMessageId ? { botStatusMessageId } : {}),
      },
    });
  }

  private release(sessionId: string, lockToken: string): Promise<{ count: number }> {
    return this.prisma.publisherAutoReplyAuthoringSession.updateMany({
      where: {
        id: sessionId,
        notificationLockToken: lockToken,
        notificationDispatchStartedAt: null,
      },
      data: {
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationClaimRevision: null,
      },
    });
  }

  private notificationMatchesState(
    notification: PublisherAutoReplyAuthoringNotification,
    state: PublisherAutoReplyAuthoringState,
  ): boolean {
    switch (notification) {
      case 'prompt_phrase':
        return state === PublisherAutoReplyAuthoringState.AWAITING_PHRASE;
      case 'prompt_content':
        return state === PublisherAutoReplyAuthoringState.AWAITING_CONTENT;
      case 'processing':
        return state === PublisherAutoReplyAuthoringState.PROCESSING;
      case 'ready':
        return state === PublisherAutoReplyAuthoringState.REVIEW;
      case 'conflict':
        return state === PublisherAutoReplyAuthoringState.REVIEW;
      case 'activated':
        return state === PublisherAutoReplyAuthoringState.COMPLETED;
      case 'failed':
        return state === PublisherAutoReplyAuthoringState.FAILED;
      case 'canceled':
        return state === PublisherAutoReplyAuthoringState.CANCELED;
    }
  }
}
