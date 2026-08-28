import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  publisherPostImportCreateRequestSchema,
  publisherPostImportFailureCodeSchema,
  publisherPostImportOmissionSchema,
  type PublisherPostImportCurrentResponse,
  type PublisherPostImportOmission,
  type PublisherPostImportSession,
} from '@maxim/contracts/publisher';
import type { MaxUpdate } from '@maxim/contracts';
import { randomBytes } from 'node:crypto';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { PublicationLifecycle, PublisherPostImportStatus } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { buildPublisherBotDescriptor } from './publisher-bot-descriptor';
import { PublisherPostImportQueueService } from './publisher-post-import.queue';

const POST_IMPORT_WAITING_TTL_MS = 10 * 60_000;
const POST_IMPORT_PROCESSING_TTL_MS = 15 * 60_000;
const POST_IMPORT_RESULT_TTL_MS = 24 * 60 * 60_000;
const POST_IMPORT_SECOND_FORWARD_GUARD_MS = 60_000;
const POST_IMPORT_START_PREFIX = 'pi_';
const POST_IMPORT_CANCEL_PREFIX = 'pi_cancel_';

type SessionRow = {
  id: string;
  publisherBotId: string;
  actorUserId: string;
  requestId: string;
  startToken: string;
  status: PublisherPostImportStatus;
  privateChatId: string | null;
  incomingMessageId: string | null;
  publicationId: string | null;
  failureCode: string | null;
  omissions: unknown;
  expiresAt: Date;
  captureGuardUntil?: Date | null;
};

export type PublisherPostImportAsset = {
  bytes: Buffer;
  mimeType: string;
};

@Injectable()
export class PublisherPostImportService {
  private readonly logger = new Logger(PublisherPostImportService.name);
  private readonly publisherBotId: string;
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PublisherPostImportQueueService,
    configService: ConfigService,
  ) {
    this.publisherBotId = buildPublisherBotDescriptor({
      id: configService.get<string>('MAX_PUBLISHER_BOT_ID'),
    }).id;
    this.enabled = configService.get<boolean>('PUBLISHER_POST_IMPORT_ENABLED', false);
  }

  async create(user: AuthUser, body: unknown): Promise<PublisherPostImportSession> {
    if (!this.enabled) {
      throw new ServiceUnavailableException({
        code: 'PUBLISHER_POST_IMPORT_DISABLED',
        message: 'Пересылка постов временно недоступна.',
      });
    }
    const parsed = publisherPostImportCreateRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const actorUserId = user.userId.trim();
    const now = new Date();
    await this.expireWaitingSessions(actorUserId, now);

    const replay = await this.prisma.publisherPostImportSession.findUnique({
      where: {
        publisherBotId_actorUserId_requestId: {
          publisherBotId: this.publisherBotId,
          actorUserId,
          requestId: parsed.data.requestId,
        },
      },
    });
    if (replay) {
      return this.present(replay);
    }

    const active = await this.findActiveSession(actorUserId);
    if (active) {
      return this.present(active);
    }

    try {
      const created = await this.prisma.publisherPostImportSession.create({
        data: {
          publisherBotId: this.publisherBotId,
          actorUserId,
          requestId: parsed.data.requestId,
          startToken: randomBytes(18).toString('base64url'),
          expiresAt: new Date(now.getTime() + POST_IMPORT_WAITING_TTL_MS),
        },
      });
      return this.present(created);
    } catch (error: unknown) {
      if (!this.isUniqueConflict(error)) {
        throw error;
      }
      const concurrent =
        (await this.prisma.publisherPostImportSession.findUnique({
          where: {
            publisherBotId_actorUserId_requestId: {
              publisherBotId: this.publisherBotId,
              actorUserId,
              requestId: parsed.data.requestId,
            },
          },
        })) ?? (await this.findActiveSession(actorUserId));
      if (!concurrent) {
        throw error;
      }
      return this.present(concurrent);
    }
  }

  async getCurrent(user: AuthUser): Promise<PublisherPostImportCurrentResponse> {
    const actorUserId = user.userId.trim();
    const now = new Date();
    await this.expireWaitingSessions(actorUserId, now);
    const session = await this.prisma.publisherPostImportSession.findFirst({
      where: {
        publisherBotId: this.publisherBotId,
        actorUserId,
        expiresAt: { gt: now },
        OR: [
          {
            status: {
              in: [
                PublisherPostImportStatus.WAITING,
                PublisherPostImportStatus.PROCESSING,
                PublisherPostImportStatus.FAILED,
                PublisherPostImportStatus.EXPIRED,
              ],
            },
          },
          {
            status: PublisherPostImportStatus.READY,
            publication: { is: { lifecycle: PublicationLifecycle.DRAFT } },
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return { session: session ? this.present(session) : null };
  }

  async getByToken(
    user: AuthUser,
    startToken: string,
  ): Promise<PublisherPostImportCurrentResponse> {
    const normalizedToken = startToken.trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/u.test(normalizedToken)) {
      return { session: null };
    }
    const session = await this.prisma.publisherPostImportSession.findFirst({
      where: {
        startToken: normalizedToken,
        publisherBotId: this.publisherBotId,
        actorUserId: user.userId.trim(),
        status: PublisherPostImportStatus.READY,
        expiresAt: { gt: new Date() },
        publication: { is: { lifecycle: PublicationLifecycle.DRAFT } },
      },
    });
    return { session: session ? this.present(session) : null };
  }

  async cancel(user: AuthUser): Promise<PublisherPostImportSession> {
    const actorUserId = user.userId.trim();
    const active = await this.findActiveSession(actorUserId);
    if (!active) {
      throw new NotFoundException('Активный импорт не найден.');
    }
    const now = new Date();
    const updated = await this.prisma.publisherPostImportSession.updateMany({
      where: {
        id: active.id,
        actorUserId,
        publisherBotId: this.publisherBotId,
        status: { in: [PublisherPostImportStatus.WAITING, PublisherPostImportStatus.PROCESSING] },
      },
      data: {
        status: PublisherPostImportStatus.CANCELED,
        lockedAt: null,
        lockToken: null,
        notificationKind: 'canceled',
        notificationPending: true,
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationDispatchStartedAt: null,
        expiresAt: new Date(now.getTime() + POST_IMPORT_RESULT_TTL_MS),
      },
    });
    const current =
      updated.count > 0
        ? await this.prisma.publisherPostImportSession.findUnique({ where: { id: active.id } })
        : await this.prisma.publisherPostImportSession.findUnique({ where: { id: active.id } });
    if (!current) {
      throw new NotFoundException('Активный импорт не найден.');
    }
    await this.enqueueNotificationSafe({
      sessionId: current.id,
      notification: 'canceled',
      privateChatId: current.privateChatId,
      dedupeKey: `api-${current.updatedAt.getTime()}`,
    });
    return this.present(current);
  }

  async getImageAsset(
    sessionId: string,
    assetId: string,
    user: AuthUser,
  ): Promise<PublisherPostImportAsset> {
    const asset = await this.prisma.publicationAsset.findFirst({
      where: {
        id: assetId,
        actorUserId: user.userId,
        mimeType: { startsWith: 'image/' },
        bytes: { not: null },
        contentLinks: {
          some: {
            contentRevision: {
              publication: {
                is: {
                  actorUserId: user.userId,
                  postImportSession: {
                    is: {
                      id: sessionId,
                      publisherBotId: this.publisherBotId,
                      status: PublisherPostImportStatus.READY,
                    },
                  },
                },
              },
            },
          },
        },
      },
      select: { bytes: true, mimeType: true },
    });
    if (!asset?.bytes || !asset.mimeType.toLowerCase().startsWith('image/')) {
      throw new NotFoundException('Фото не найдено.');
    }
    return { bytes: Buffer.from(asset.bytes), mimeType: asset.mimeType };
  }

  async observeWebhook(
    update: MaxUpdate,
    webhookEventId?: string | null,
    options: { duplicate?: boolean } = {},
  ): Promise<boolean> {
    if (update.botId?.trim() !== this.publisherBotId) {
      return false;
    }

    const callback = this.extractCallback(update);
    if (callback?.payload.startsWith(POST_IMPORT_CANCEL_PREFIX)) {
      await this.handleCancelCallback(update, callback);
      return true;
    }

    const startToken = this.extractImportStartToken(update);
    if (startToken !== null) {
      await this.handleImportStart(update, startToken);
      return true;
    }

    if (update.type.trim().toLowerCase() !== 'message_created') {
      return false;
    }
    const privateMessage = this.extractPrivateMessageIdentity(update);
    if (!privateMessage) {
      return false;
    }
    const now = new Date();
    await this.expireWaitingSessions(privateMessage.actorUserId, now);
    const forward = this.extractForwardedMessage(update);
    if (forward) {
      const priorCapture = await this.prisma.publisherPostImportSession.findUnique({
        where: {
          publisherBotId_incomingMessageId: {
            publisherBotId: this.publisherBotId,
            incomingMessageId: privateMessage.incomingMessageId,
          },
        },
      });
      if (priorCapture?.status === PublisherPostImportStatus.PROCESSING) {
        await this.enqueueProcessSafe(priorCapture.id);
      }
      if (priorCapture) {
        return true;
      }
    }
    const session = await this.prisma.publisherPostImportSession.findFirst({
      where: {
        publisherBotId: this.publisherBotId,
        actorUserId: privateMessage.actorUserId,
        OR: [
          {
            status: {
              in: [PublisherPostImportStatus.WAITING, PublisherPostImportStatus.PROCESSING],
            },
          },
          { captureGuardUntil: { gt: now } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!session) {
      return false;
    }
    const importActive =
      session.status === PublisherPostImportStatus.WAITING ||
      session.status === PublisherPostImportStatus.PROCESSING;
    if (!importActive && !forward) {
      return false;
    }
    if (options.duplicate) {
      return true;
    }
    if (session.status !== PublisherPostImportStatus.WAITING) {
      return true;
    }

    if (!forward) {
      await this.prisma.publisherPostImportSession.updateMany({
        where: { id: session.id, status: PublisherPostImportStatus.WAITING },
        data: {
          notificationKind: 'need_forward',
          notificationPending: true,
          notificationLockedAt: null,
          notificationLockToken: null,
          notificationDispatchStartedAt: null,
        },
      });
      await this.enqueueNotificationSafe({
        sessionId: session.id,
        notification: 'need_forward',
        privateChatId: privateMessage.privateChatId,
        dedupeKey: `need-${Math.floor(now.getTime() / 5_000)}`,
      });
      return true;
    }

    try {
      const captured = await this.prisma.publisherPostImportSession.updateMany({
        where: {
          id: session.id,
          publisherBotId: this.publisherBotId,
          actorUserId: privateMessage.actorUserId,
          status: PublisherPostImportStatus.WAITING,
          incomingMessageId: null,
          expiresAt: { gt: now },
        },
        data: {
          status: PublisherPostImportStatus.PROCESSING,
          privateChatId: privateMessage.privateChatId,
          incomingMessageId: privateMessage.incomingMessageId,
          sourceWebhookEventId: webhookEventId?.trim() || null,
          capturedAt: now,
          captureGuardUntil: new Date(now.getTime() + POST_IMPORT_SECOND_FORWARD_GUARD_MS),
          expiresAt: new Date(now.getTime() + POST_IMPORT_PROCESSING_TTL_MS),
          failureCode: null,
          omissions: [],
          notificationKind: 'processing',
          notificationPending: true,
          notificationLockedAt: null,
          notificationLockToken: null,
          notificationDispatchStartedAt: null,
        },
      });
      if (captured.count === 0) {
        return true;
      }
    } catch (error: unknown) {
      if (!this.isUniqueConflict(error)) {
        throw error;
      }
      return true;
    }

    await Promise.all([
      this.enqueueNotificationSafe({
        sessionId: session.id,
        notification: 'processing',
        privateChatId: privateMessage.privateChatId,
        dedupeKey: privateMessage.incomingMessageId,
      }),
      this.enqueueProcessSafe(session.id),
    ]);
    return true;
  }

  private async handleImportStart(update: MaxUpdate, startToken: string): Promise<void> {
    const identity = this.extractPrivateMessageIdentity(update);
    if (!identity) {
      return;
    }
    const session = await this.prisma.publisherPostImportSession.findFirst({
      where: {
        startToken,
        publisherBotId: this.publisherBotId,
        actorUserId: identity.actorUserId,
        status: PublisherPostImportStatus.WAITING,
        expiresAt: { gt: new Date() },
      },
    });
    if (!session) {
      return;
    }
    await this.prisma.publisherPostImportSession.updateMany({
      where: { id: session.id, status: PublisherPostImportStatus.WAITING },
      data: {
        privateChatId: identity.privateChatId,
        notificationKind: 'prompt',
        notificationPending: true,
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationDispatchStartedAt: null,
      },
    });
    await this.enqueueNotificationSafe({
      sessionId: session.id,
      notification: 'prompt',
      privateChatId: identity.privateChatId,
      dedupeKey: update.updateId,
    });
  }

  private async handleCancelCallback(
    update: MaxUpdate,
    callback: { payload: string; callbackId: string | null; actorUserId: string | null },
  ): Promise<void> {
    const startToken = callback.payload.slice(POST_IMPORT_CANCEL_PREFIX.length).trim();
    const actorUserId = callback.actorUserId ?? update.message?.senderId?.trim() ?? '';
    if (!startToken || !actorUserId) {
      return;
    }
    const session = await this.prisma.publisherPostImportSession.findFirst({
      where: { startToken, publisherBotId: this.publisherBotId, actorUserId },
    });
    if (!session) {
      return;
    }
    const now = new Date();
    await this.prisma.publisherPostImportSession.updateMany({
      where: {
        id: session.id,
        publisherBotId: this.publisherBotId,
        actorUserId,
        status: PublisherPostImportStatus.WAITING,
      },
      data: {
        status: PublisherPostImportStatus.CANCELED,
        callbackId: callback.callbackId,
        notificationKind: 'canceled',
        notificationPending: true,
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationDispatchStartedAt: null,
        expiresAt: new Date(now.getTime() + POST_IMPORT_RESULT_TTL_MS),
      },
    });
    await this.enqueueNotificationSafe({
      sessionId: session.id,
      notification: 'canceled',
      privateChatId: session.privateChatId ?? update.message?.chatId,
      callbackId: callback.callbackId,
      dedupeKey: callback.callbackId ?? update.updateId,
    });
  }

  private extractImportStartToken(update: MaxUpdate): string | null {
    if (update.type.trim().toLowerCase() !== 'bot_started') {
      return null;
    }
    const raw = this.asRecord(update.raw);
    const data = this.asRecord(raw?.data);
    const payload = this.readString(
      raw?.payload ?? raw?.start_payload ?? raw?.startPayload ?? data?.payload,
    );
    if (!payload?.startsWith(POST_IMPORT_START_PREFIX)) {
      return null;
    }
    return payload.slice(POST_IMPORT_START_PREFIX.length).trim();
  }

  private extractCallback(update: MaxUpdate): {
    payload: string;
    callbackId: string | null;
    actorUserId: string | null;
  } | null {
    if (update.type.trim().toLowerCase() !== 'message_callback') {
      return null;
    }
    const raw = this.asRecord(update.raw);
    const callback = this.asRecord(raw?.callback);
    const user = this.asRecord(callback?.user);
    const payload = this.readString(callback?.payload ?? callback?.data);
    if (!payload) {
      return null;
    }
    return {
      payload,
      callbackId: this.readString(callback?.callback_id ?? callback?.callbackId ?? callback?.id),
      actorUserId: this.readString(user?.user_id ?? user?.userId ?? user?.id),
    };
  }

  private extractPrivateMessageIdentity(update: MaxUpdate): {
    actorUserId: string;
    privateChatId: string;
    incomingMessageId: string;
  } | null {
    const message = update.message;
    const actorUserId = message?.senderId?.trim() ?? '';
    const privateChatId = message?.chatId?.trim() ?? '';
    const incomingMessageId = message?.messageId?.trim() ?? '';
    if (!/^\d+$/u.test(actorUserId) || !/^\d+$/u.test(privateChatId) || !incomingMessageId) {
      return null;
    }
    const rawMessage = this.extractRawMessage(update.raw);
    const recipient = this.asRecord(rawMessage?.recipient);
    const chatType = this.readString(recipient?.chat_type ?? recipient?.chatType)?.toLowerCase();
    if (chatType && chatType !== 'dialog') {
      return null;
    }
    return { actorUserId, privateChatId, incomingMessageId };
  }

  private extractForwardedMessage(update: MaxUpdate): Record<string, unknown> | null {
    const message = this.extractRawMessage(update.raw);
    const link = this.asRecord(message?.link);
    if (this.readString(link?.type)?.toLowerCase() !== 'forward') {
      return null;
    }
    return this.asRecord(link?.message);
  }

  private extractRawMessage(rawValue: unknown): Record<string, unknown> | null {
    const raw = this.asRecord(rawValue);
    if (!raw) {
      return null;
    }
    const direct = this.asRecord(raw.message);
    if (direct) {
      return direct;
    }
    for (const key of ['message_created', 'data', 'event']) {
      const envelope = this.asRecord(raw[key]);
      const nested = this.asRecord(envelope?.message);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  private async expireWaitingSessions(actorUserId: string, now: Date): Promise<void> {
    await this.prisma.publisherPostImportSession.updateMany({
      where: {
        publisherBotId: this.publisherBotId,
        actorUserId,
        status: PublisherPostImportStatus.WAITING,
        expiresAt: { lte: now },
      },
      data: {
        status: PublisherPostImportStatus.EXPIRED,
        notificationKind: null,
        notificationPending: false,
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationDispatchStartedAt: null,
        expiresAt: new Date(now.getTime() + POST_IMPORT_RESULT_TTL_MS),
      },
    });
  }

  private findActiveSession(actorUserId: string) {
    return this.prisma.publisherPostImportSession.findFirst({
      where: {
        publisherBotId: this.publisherBotId,
        actorUserId,
        status: {
          in: [PublisherPostImportStatus.WAITING, PublisherPostImportStatus.PROCESSING],
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  private present(row: SessionRow): PublisherPostImportSession {
    const status = row.status.toLowerCase() as PublisherPostImportSession['status'];
    const omissionParse = publisherPostImportOmissionSchema.array().safeParse(row.omissions);
    const omissions: PublisherPostImportOmission[] = omissionParse.success
      ? omissionParse.data
      : [];
    const failureParse = publisherPostImportFailureCodeSchema.safeParse(row.failureCode);
    const botUrl =
      row.status === PublisherPostImportStatus.WAITING
        ? `https://max.ru/${encodeURIComponent(this.publisherBotId)}?start=${encodeURIComponent(
            `${POST_IMPORT_START_PREFIX}${row.startToken}`,
          )}`
        : null;
    return {
      id: row.id,
      status,
      expiresAt: row.expiresAt.toISOString(),
      publicationId: row.publicationId,
      botUrl,
      failureCode:
        row.status === PublisherPostImportStatus.FAILED && failureParse.success
          ? failureParse.data
          : null,
      omissions,
    };
  }

  private async enqueueProcessSafe(sessionId: string): Promise<void> {
    try {
      await this.queue.enqueueProcess(sessionId);
    } catch (error: unknown) {
      this.logger.warn(
        { sessionId, err: error instanceof Error ? error.message : String(error) },
        'Publisher post import enqueue failed; bounded recovery will retry',
      );
    }
  }

  private async enqueueNotificationSafe(
    params: Parameters<PublisherPostImportQueueService['enqueueNotification']>[0],
  ): Promise<void> {
    try {
      await this.queue.enqueueNotification(params);
    } catch (error: unknown) {
      this.logger.warn(
        {
          sessionId: params.sessionId,
          notification: params.notification,
          err: error instanceof Error ? error.message : String(error),
        },
        'Publisher post import notification enqueue failed',
      );
    }
  }

  private isUniqueConflict(error: unknown): boolean {
    return (error as { code?: string }).code === 'P2002';
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readString(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }
    const normalized = String(value).trim();
    return normalized || null;
  }
}

export const PUBLISHER_POST_IMPORT_RESULT_TTL_MS = POST_IMPORT_RESULT_TTL_MS;
export const PUBLISHER_POST_IMPORT_PROCESSING_TTL_MS = POST_IMPORT_PROCESSING_TTL_MS;
export const PUBLISHER_POST_IMPORT_SECOND_FORWARD_GUARD_MS = POST_IMPORT_SECOND_FORWARD_GUARD_MS;
export const PUBLISHER_POST_IMPORT_CANCEL_PAYLOAD_PREFIX = POST_IMPORT_CANCEL_PREFIX;
