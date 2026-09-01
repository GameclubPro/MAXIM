import {
  channelSettingsSchema,
  channelDialogResponseSchema,
  channelDialogTypeSchema,
  createChannelDialogMessageRequestSchema,
  createChannelDialogMessageResponseSchema,
  type ChannelDialogMessage,
  type ChannelDialogNotificationSettings,
  type ChannelDialogType,
  type ChannelSettings,
  type ChatSettings,
  type ManagedEntityType,
} from '@maxim/contracts';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import {
  ChatEntityType,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
  Prisma,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherDialogLinkService } from '../publisher/publisher-dialog-link.service';
import { PublisherReadinessService } from '../publisher/publisher-readiness.service';
import { AdminDialogLinkHelper } from './admin-dialog-link-helper';
import {
  CHANNEL_SUGGESTION_IMAGE_STORAGE_VERSION,
  prepareChannelSuggestionImageRows,
  type PreparedChannelSuggestionImageRow,
} from './admin-channel-suggestion-image-storage';
import { buildPublisherChatCommentsQuery } from './publisher-chat-comment-store';
import {
  PUBLISHER_SUGGESTION_ADMISSION_ACTION,
  PUBLISHER_SUGGESTION_ADMISSION_LEASE_MS,
  PUBLISHER_SUGGESTION_ADMISSION_PROTOCOL,
  type PublisherSuggestionAdmissionStatus,
} from './publisher-suggestion-submission-admission';
import {
  CHANNEL_DIALOG_MESSAGES_LIMIT,
  MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS,
  PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST,
} from './admin.service.support';

type DialogAuditLogRow = {
  id: string;
  actorUserId: string;
  payload: Prisma.JsonValue;
  createdAt: Date;
};

type PublisherSuggestionSubmissionRow = DialogAuditLogRow & {
  chatId: string;
  action: string;
};

type PublisherSuggestionAdmission =
  | { kind: 'replay'; row: DialogAuditLogRow }
  | {
      kind: 'process';
      auditLogId: string;
      claimToken: string;
      inputHash: string;
    };

const PUBLISHER_SUGGESTION_DAILY_LIMIT = 10;
const PUBLISHER_SUGGESTION_DAILY_WINDOW_MS = 24 * 60 * 60_000;

type DialogAuditLogMapper = (
  row: DialogAuditLogRow,
  fallbackType: ChannelDialogType,
  currentUserId?: string | null,
  adminUserIds?: ReadonlySet<string>,
) => ChannelDialogMessage;

type PublisherDialogProfileRuntimeContext = {
  prisma: PrismaService;
  majorDialogLinks: AdminDialogLinkHelper;
  publisherDialogLinks?: PublisherDialogLinkService;
  publisherReadiness?: PublisherReadinessService;
  maxBotRegistry?: MaxBotRegistryService;
  enqueueSuggestionAdminDelivery?: (suggestionId: string) => Promise<void>;
};

export class PublisherDialogProfileRuntime {
  constructor(private readonly context: PublisherDialogProfileRuntimeContext) {}

  async getChannelDialog(params: {
    chatId: string;
    user: AuthUser;
    dialogTypeRaw: string;
    token: string | null;
    mapAuditLog: DialogAuditLogMapper;
  }) {
    const dialogType = channelDialogTypeSchema.parse(params.dialogTypeRaw);
    if (dialogType === 'comments') {
      return this.getChannelCommentsDialog({ ...params, dialogType });
    }
    await this.assertChannelSuggestionReady(params.chatId);
    const threadId = this.resolveChannelThreadId(
      params.chatId,
      dialogType,
      params.token,
      'publisher',
    );
    const rows = await this.context.prisma.auditLog.findMany({
      where: {
        chatId: params.chatId,
        actorUserId: params.user.userId,
        action: PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST,
        ...(threadId ? { payload: { path: ['threadId'], equals: threadId } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: CHANNEL_DIALOG_MESSAGES_LIMIT,
    });
    return channelDialogResponseSchema.parse({
      chatId: params.chatId,
      type: dialogType,
      introText: null,
      messages: rows
        .slice()
        .reverse()
        .map((row) => params.mapAuditLog(row, dialogType, params.user.userId, new Set())),
      notificationSettings: this.defaultNotificationSettings(),
    });
  }

  private async getChannelCommentsDialog(params: {
    chatId: string;
    user: AuthUser;
    dialogType: 'comments';
    token: string | null;
    mapAuditLog: DialogAuditLogMapper;
  }) {
    await this.assertChannelCommentThreadReady(params.chatId);
    const threadId = this.resolveRequiredPublisherThreadId(
      params.chatId,
      'channel',
      params.dialogType,
      params.token,
    );
    const [rows, adminUserIds] = await Promise.all([
      this.context.prisma.$queryRaw<DialogAuditLogRow[]>(
        buildPublisherChatCommentsQuery(params.chatId, threadId),
      ),
      this.readAdminUserIds(params.chatId, 'channel'),
    ]);
    return channelDialogResponseSchema.parse({
      chatId: params.chatId,
      type: params.dialogType,
      introText: null,
      messages: rows
        .slice()
        .reverse()
        .map((row) => params.mapAuditLog(row, params.dialogType, params.user.userId, adminUserIds)),
      notificationSettings: this.defaultNotificationSettings(),
    });
  }

  async createChannelSuggestion(params: {
    chatId: string;
    user: AuthUser;
    dialogType: ChannelDialogType;
    body: unknown;
    mapAuditLog: DialogAuditLogMapper;
  }) {
    if (params.dialogType !== 'suggest') {
      throw new BadRequestException('Для Публика доступен только сценарий предложек.');
    }
    await this.assertChannelSuggestionReady(params.chatId);
    const parsed = createChannelDialogMessageRequestSchema.safeParse(params.body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const text = parsed.data.text.trim();
    const fileAttachments = parsed.data.attachments.filter(
      (attachment) => attachment.type === 'file',
    );
    if (fileAttachments.length > 0) {
      throw new BadRequestException('В предложке поддерживаются только фотографии.');
    }
    const attachmentImages = parsed.data.attachments
      .filter((attachment) => attachment.type === 'image')
      .map((image) => ({
        base64: image.base64.trim(),
        mimeType: image.mimeType.trim(),
        fileName: image.fileName.trim(),
      }));
    const images =
      parsed.data.images.length > 0
        ? parsed.data.images.map((image) => ({
            base64: image.base64.trim(),
            mimeType: image.mimeType.trim(),
            fileName: image.fileName.trim(),
          }))
        : attachmentImages;
    if (!text && images.length === 0) {
      throw new BadRequestException('Введите текст или добавьте фото.');
    }
    const threadId = this.resolveChannelThreadId(
      params.chatId,
      params.dialogType,
      parsed.data.token,
      'publisher',
    );
    const inputHash = buildPublisherSuggestionInputHash({
      threadId,
      text,
      textFormat: parsed.data.textFormat,
      images,
    });
    const admission = await this.admitPublisherChannelSuggestion({
      chatId: params.chatId,
      user: params.user,
      requestId: parsed.data.requestId ?? null,
      inputHash,
    });
    if (admission.kind === 'replay') {
      await this.enqueueSuggestionAdminDelivery(admission.row.id);
      return createChannelDialogMessageResponseSchema.parse({
        ok: true,
        message: params.mapAuditLog(admission.row, 'suggest', params.user.userId),
      });
    }

    let preparedImages: PreparedChannelSuggestionImageRow[];
    try {
      preparedImages = await prepareChannelSuggestionImageRows(images);
    } catch (error: unknown) {
      await this.settlePublisherSuggestionAdmissionFailure(
        params.chatId,
        params.user.userId,
        admission,
        error,
      );
      throw error;
    }

    let created: DialogAuditLogRow;
    try {
      created = await this.finalizePublisherChannelSuggestion({
        chatId: params.chatId,
        user: params.user,
        requestId: parsed.data.requestId ?? null,
        threadId,
        text,
        textFormat: parsed.data.textFormat,
        preparedImages,
        admission,
      });
    } catch (error: unknown) {
      await this.settlePublisherSuggestionAdmissionFailure(
        params.chatId,
        params.user.userId,
        admission,
        error,
        'retryable',
      );
      throw error;
    }
    await this.enqueueSuggestionAdminDelivery(created.id);
    return createChannelDialogMessageResponseSchema.parse({
      ok: true,
      message: params.mapAuditLog(created, 'suggest', params.user.userId),
    });
  }

  async getChatCommentsDialog(params: {
    chatId: string;
    user: AuthUser;
    dialogTypeRaw: string;
    token: string | null;
    mapAuditLog: DialogAuditLogMapper;
  }) {
    const dialogType = channelDialogTypeSchema.parse(params.dialogTypeRaw);
    if (dialogType !== 'comments') {
      throw new BadRequestException('Для чатов доступен только сценарий комментариев.');
    }
    await this.assertChatReady(params.chatId);
    const threadId = this.resolveChatThreadId(params.chatId, dialogType, params.token, 'publisher');
    const [chatSettings, rows, adminUserIds] = await Promise.all([
      this.readChatCommentSettings(params.chatId),
      this.context.prisma.$queryRaw<DialogAuditLogRow[]>(
        buildPublisherChatCommentsQuery(params.chatId, threadId),
      ),
      this.readAdminUserIds(params.chatId),
    ]);
    if (!chatSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого чата сейчас закрыты.');
    }
    return channelDialogResponseSchema.parse({
      chatId: params.chatId,
      type: dialogType,
      introText: null,
      messages: rows
        .slice()
        .reverse()
        .map((row) => params.mapAuditLog(row, dialogType, params.user.userId, adminUserIds)),
      notificationSettings: this.defaultNotificationSettings(),
    });
  }

  async assertChatReady(chatId: string): Promise<void> {
    const readiness = this.context.publisherReadiness;
    if (!readiness) {
      throw new ServiceUnavailableException('Диалог Публика временно недоступен.');
    }
    const route = await readiness.assertEntityReady(chatId, 'chat_comments');
    if (route.entityType !== 'chat') {
      throw new BadRequestException('Комментарии Публика доступны только для чатов.');
    }
  }

  resolveChatThreadId(
    chatId: string,
    type: ChannelDialogType,
    token: string | null | undefined,
    profile: MiniappProfile,
  ): string | null {
    if (profile !== 'publisher') {
      return this.context.majorDialogLinks.resolveChatDialogThreadId(chatId, type, token);
    }
    const links = this.requirePublisherDialogLinks();
    return links.resolveChatDialogThreadId(chatId, type, token);
  }

  resolveChannelThreadId(
    chatId: string,
    type: ChannelDialogType,
    token: string | null | undefined,
    profile: MiniappProfile,
  ): string | null {
    if (profile !== 'publisher') {
      return this.context.majorDialogLinks.resolveChannelDialogThreadId(chatId, type, token);
    }
    const links = this.requirePublisherDialogLinks();
    return links.resolveChannelDialogThreadId(chatId, type, token);
  }

  resolveRequiredPublisherThreadId(
    chatId: string,
    entityType: ManagedEntityType,
    type: ChannelDialogType,
    token: string | null | undefined,
  ): string {
    const threadId =
      entityType === 'channel'
        ? this.resolveChannelThreadId(chatId, type, token, 'publisher')
        : this.resolveChatThreadId(chatId, type, token, 'publisher');
    if (!threadId) {
      throw new BadRequestException('Ссылка на комментарии недействительна.');
    }
    return threadId;
  }

  async readChatCommentSettings(
    chatId: string,
  ): Promise<
    Pick<
      ChatSettings,
      | 'commentsEnabled'
      | 'commentsAdminsEnabled'
      | 'commentsAllEnabled'
      | 'commentsChatBroadcastsEnabled'
    >
  > {
    const settings = await this.context.prisma.publisherEntitySettings.findUnique({
      where: { chatId },
      select: {
        chatCommentsEnabled: true,
        chatCommentsAdminsEnabled: true,
        chatCommentsPostsEnabled: true,
      },
    });
    return {
      commentsEnabled: settings?.chatCommentsEnabled ?? false,
      commentsAdminsEnabled: settings?.chatCommentsAdminsEnabled ?? false,
      commentsAllEnabled: false,
      commentsChatBroadcastsEnabled: settings?.chatCommentsPostsEnabled ?? false,
    };
  }

  async readChannelCommentThreadSettings(chatId: string): Promise<ChannelSettings> {
    await this.assertChannelCommentThreadReady(chatId);
    return channelSettingsSchema.parse({ commentsEnabled: true });
  }

  async readAdminUserIds(
    chatId: string,
    entityType: ManagedEntityType = 'chat',
  ): Promise<Set<string>> {
    const publisherBotId =
      this.context.publisherDialogLinks?.getBotId() ??
      this.context.maxBotRegistry?.getPublisherBotDescriptor().id;
    if (!publisherBotId) {
      throw new ServiceUnavailableException('Профиль Публика временно недоступен.');
    }
    const now = new Date();
    const rows = await this.context.prisma.managedEntityAccessEdge.findMany({
      where: {
        chatId,
        entityType: entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT,
        botId: publisherBotId,
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
      select: { userId: true },
    });
    return new Set(rows.map((row) => row.userId.trim()).filter(Boolean));
  }

  async assertAdminAccess(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType = 'chat',
  ): Promise<void> {
    if (!(await this.readAdminUserIds(chatId, entityType)).has(userId.trim())) {
      throw new ForbiddenException('Недостаточно прав администратора Публика.');
    }
  }

  private async assertChannelSuggestionReady(chatId: string): Promise<void> {
    const readiness = this.context.publisherReadiness;
    if (!readiness) {
      throw new ServiceUnavailableException('Предложки Публика временно недоступны.');
    }
    const route = await readiness.assertEntityReady(chatId, 'suggestion_publish');
    if (route.entityType !== 'channel') {
      throw new BadRequestException('Предложки Публика доступны только для каналов.');
    }
  }

  async assertChannelCommentThreadReady(chatId: string): Promise<void> {
    const readiness = this.context.publisherReadiness;
    if (!readiness) {
      throw new ServiceUnavailableException('Комментарии Публика временно недоступны.');
    }
    const route = await readiness.assertEntityReady(chatId, 'publication');
    if (route.entityType !== 'channel') {
      throw new BadRequestException('Комментарии канала Публика доступны только для каналов.');
    }
  }

  private async admitPublisherChannelSuggestion(params: {
    chatId: string;
    user: AuthUser;
    requestId: string | null;
    inputHash: string;
  }): Promise<PublisherSuggestionAdmission> {
    const deterministicAuditLogId = params.requestId
      ? buildPublisherSuggestionAuditLogId(params.chatId, params.user.userId, params.requestId)
      : null;
    const lockKey = buildPublisherSuggestionSubmissionLockKey(params.chatId, params.user.userId);
    return this.context.prisma.$transaction(async (tx) => {
      await lockPublisherSuggestionSubmission(tx, lockKey);
      const now = new Date();
      if (deterministicAuditLogId) {
        const existing = await tx.auditLog.findUnique({
          where: { id: deterministicAuditLogId },
          select: {
            id: true,
            chatId: true,
            actorUserId: true,
            action: true,
            payload: true,
            createdAt: true,
          },
        });
        if (existing) {
          return this.resolveExistingPublisherSuggestionSubmission(tx, existing, params, now);
        }
      }

      await this.assertNoActivePublisherSuggestionAdmission(
        tx,
        params.chatId,
        params.user.userId,
        now,
      );
      const count = await tx.auditLog.count({
        where: {
          chatId: params.chatId,
          actorUserId: params.user.userId,
          action: {
            in: [PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST, PUBLISHER_SUGGESTION_ADMISSION_ACTION],
          },
          createdAt: { gte: new Date(now.getTime() - PUBLISHER_SUGGESTION_DAILY_WINDOW_MS) },
        },
      });
      if (count >= PUBLISHER_SUGGESTION_DAILY_LIMIT) {
        throw new BadRequestException('Лимит предложек на сегодня исчерпан.');
      }

      const auditLogId = deterministicAuditLogId ?? `psa_${randomUUID().replace(/-/gu, '')}`;
      const claimToken = randomUUID();
      await tx.auditLog.create({
        data: {
          id: auditLogId,
          chatId: params.chatId,
          actorUserId: params.user.userId,
          action: PUBLISHER_SUGGESTION_ADMISSION_ACTION,
          payload: buildPublisherSuggestionAdmissionPayload({
            requestId: params.requestId,
            inputHash: params.inputHash,
            claimToken,
            now,
            attempt: 1,
          }),
        },
        select: { id: true },
      });
      return { kind: 'process', auditLogId, claimToken, inputHash: params.inputHash };
    });
  }

  private async resolveExistingPublisherSuggestionSubmission(
    tx: Prisma.TransactionClient,
    existing: PublisherSuggestionSubmissionRow,
    params: { chatId: string; user: AuthUser; requestId: string | null; inputHash: string },
    now: Date,
  ): Promise<PublisherSuggestionAdmission> {
    const payload = readRecord(existing.payload);
    if (
      existing.chatId !== params.chatId ||
      existing.actorUserId !== params.user.userId ||
      !payload ||
      readString(payload.requestInputHash) !== params.inputHash
    ) {
      throw publisherSuggestionRequestCollision();
    }
    if (existing.action === PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST) {
      return { kind: 'replay', row: existing };
    }
    if (
      existing.action !== PUBLISHER_SUGGESTION_ADMISSION_ACTION ||
      payload.submissionProtocol !== PUBLISHER_SUGGESTION_ADMISSION_PROTOCOL
    ) {
      throw publisherSuggestionRequestCollision();
    }

    const status = readPublisherSuggestionAdmissionStatus(payload.submissionStatus);
    if (status === 'rejected') {
      throw new BadRequestException(
        readString(payload.submissionError) ?? 'Предложка не прошла проверку.',
      );
    }
    const leaseExpiresAt = readDate(payload.submissionLeaseExpiresAt);
    if (status === 'processing' && leaseExpiresAt && leaseExpiresAt > now) {
      throw new ConflictException('Предложка уже отправляется. Повторите попытку чуть позже.');
    }

    await this.assertNoActivePublisherSuggestionAdmission(
      tx,
      params.chatId,
      params.user.userId,
      now,
      existing.id,
    );
    const claimToken = randomUUID();
    const attempt = readNonNegativeInteger(payload.submissionAttempt) + 1;
    await tx.auditLog.update({
      where: { id: existing.id },
      data: {
        payload: {
          ...payload,
          submissionStatus: 'processing',
          submissionClaimToken: claimToken,
          submissionLeaseExpiresAt: new Date(
            now.getTime() + PUBLISHER_SUGGESTION_ADMISSION_LEASE_MS,
          ).toISOString(),
          submissionAttempt: attempt,
          submissionError: null,
        },
      },
      select: { id: true },
    });
    return {
      kind: 'process',
      auditLogId: existing.id,
      claimToken,
      inputHash: params.inputHash,
    };
  }

  private async assertNoActivePublisherSuggestionAdmission(
    tx: Prisma.TransactionClient,
    chatId: string,
    userId: string,
    now: Date,
    excludedAuditLogId?: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id
      FROM audit_logs
      WHERE chat_id = ${chatId}::text
        AND actor_user_id = ${userId}::text
        AND action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION_ADMISSION'
        AND payload->>'submissionProtocol' = 'publisher_suggestion_admission_v1'
        AND payload->>'submissionStatus' = 'processing'
        AND payload->>'submissionLeaseExpiresAt' > ${now.toISOString()}::text
        ${excludedAuditLogId ? Prisma.sql`AND id <> ${excludedAuditLogId}::text` : Prisma.empty}
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `);
    if (rows.length > 0) {
      throw new ConflictException(
        'Другая предложка уже обрабатывается. Дождитесь завершения отправки.',
      );
    }
  }

  private async finalizePublisherChannelSuggestion(params: {
    chatId: string;
    user: AuthUser;
    requestId: string | null;
    threadId: string | null;
    text: string;
    textFormat: 'plain' | 'markdown';
    preparedImages: PreparedChannelSuggestionImageRow[];
    admission: Extract<PublisherSuggestionAdmission, { kind: 'process' }>;
  }): Promise<DialogAuditLogRow> {
    const lockKey = buildPublisherSuggestionSubmissionLockKey(params.chatId, params.user.userId);
    return this.context.prisma.$transaction(async (tx) => {
      await lockPublisherSuggestionSubmission(tx, lockKey);
      const existing = await tx.auditLog.findUnique({
        where: { id: params.admission.auditLogId },
        select: {
          id: true,
          chatId: true,
          actorUserId: true,
          action: true,
          payload: true,
          createdAt: true,
        },
      });
      const payload = readRecord(existing?.payload);
      if (
        existing?.chatId !== params.chatId ||
        existing.actorUserId !== params.user.userId ||
        !payload ||
        readString(payload.requestInputHash) !== params.admission.inputHash
      ) {
        throw publisherSuggestionRequestCollision();
      }
      if (existing.action === PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST) {
        return existing;
      }
      if (
        existing.action !== PUBLISHER_SUGGESTION_ADMISSION_ACTION ||
        payload.submissionProtocol !== PUBLISHER_SUGGESTION_ADMISSION_PROTOCOL ||
        payload.submissionStatus !== 'processing' ||
        payload.submissionClaimToken !== params.admission.claimToken
      ) {
        throw new ConflictException('Отправка предложки уже выполняется другим запросом.');
      }

      return tx.auditLog.update({
        where: { id: existing.id },
        data: {
          action: PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST,
          payload: {
            type: 'suggest',
            threadId: params.threadId,
            text: params.text,
            ...(params.textFormat === 'markdown' ? { textFormat: 'markdown' } : {}),
            actorUserId: params.user.userId,
            authorDisplayName:
              params.user.displayName?.trim() || params.user.username?.trim() || null,
            authorUsername: params.user.username?.trim() || null,
            authorAvatarUrl: params.user.avatarUrl?.trim() || null,
            source: 'publisher_miniapp_dialog',
            publisherProfile: true,
            reviewStatus: 'pending',
            delivered: false,
            deliveredToUserId: null,
            deliveredToUserIds: [],
            suggestionDelivery: {
              state: 'queued',
              deliveredCount: 0,
              targetCount: 0,
              pendingCount: 0,
              unreachableCount: 0,
            },
            deliveries: [],
            hasImage: params.preparedImages.length > 0,
            imageCount: params.preparedImages.length,
            imageStorageVersion: CHANNEL_SUGGESTION_IMAGE_STORAGE_VERSION,
            ...(params.requestId ? { requestId: params.requestId } : {}),
            requestInputHash: params.admission.inputHash,
            requestContentHash: params.admission.inputHash,
          },
          ...(params.preparedImages.length > 0
            ? {
                channelSuggestionImageAssets: {
                  create: params.preparedImages,
                },
              }
            : {}),
        },
        select: { id: true, actorUserId: true, payload: true, createdAt: true },
      });
    });
  }

  private async enqueueSuggestionAdminDelivery(suggestionId: string): Promise<void> {
    try {
      await this.context.enqueueSuggestionAdminDelivery?.(suggestionId);
    } catch {
      // The durable suggestion remains recoverable when Redis is temporarily unavailable.
    }
  }

  private async settlePublisherSuggestionAdmissionFailure(
    chatId: string,
    userId: string,
    admission: Extract<PublisherSuggestionAdmission, { kind: 'process' }>,
    error: unknown,
    forcedStatus?: PublisherSuggestionAdmissionStatus,
  ): Promise<void> {
    const status =
      forcedStatus ?? (error instanceof BadRequestException ? 'rejected' : 'retryable');
    const errorMessage =
      status === 'rejected'
        ? (readBadRequestMessage(error) ?? 'Предложка не прошла проверку.')
        : null;
    const lockKey = buildPublisherSuggestionSubmissionLockKey(chatId, userId);
    try {
      await this.context.prisma.$transaction(async (tx) => {
        await lockPublisherSuggestionSubmission(tx, lockKey);
        const existing = await tx.auditLog.findUnique({
          where: { id: admission.auditLogId },
          select: { action: true, payload: true },
        });
        const payload = readRecord(existing?.payload);
        if (
          existing?.action !== PUBLISHER_SUGGESTION_ADMISSION_ACTION ||
          !payload ||
          payload.submissionProtocol !== PUBLISHER_SUGGESTION_ADMISSION_PROTOCOL ||
          payload.submissionClaimToken !== admission.claimToken ||
          readString(payload.requestInputHash) !== admission.inputHash
        ) {
          return;
        }
        await tx.auditLog.update({
          where: { id: admission.auditLogId },
          data: {
            payload: {
              ...payload,
              submissionStatus: status,
              submissionClaimToken: null,
              submissionLeaseExpiresAt: null,
              submissionError: errorMessage,
            },
          },
          select: { id: true },
        });
      });
    } catch {
      // The lease makes a failed bookkeeping write reclaimable by the same request.
    }
  }

  private requirePublisherDialogLinks(): PublisherDialogLinkService {
    if (!this.context.publisherDialogLinks) {
      throw new ServiceUnavailableException('Ключ ссылок Публика временно недоступен.');
    }
    return this.context.publisherDialogLinks;
  }

  private defaultNotificationSettings(): ChannelDialogNotificationSettings {
    return {
      mode: 'off',
      canUseAll: true,
      scope: 'thread',
      thread: { mode: 'off', explicit: false },
      channel: { mode: 'off', explicit: false },
      allChannels: { mode: 'off', explicit: false },
    };
  }
}

function buildPublisherSuggestionAuditLogId(
  chatId: string,
  userId: string,
  requestId: string,
): string {
  return `psg_${createHash('sha256').update(`${chatId}\0${userId}\0${requestId}`).digest('hex')}`;
}

function buildPublisherSuggestionInputHash(params: {
  threadId: string | null;
  text: string;
  textFormat: 'plain' | 'markdown';
  images: readonly { base64: string; mimeType: string; fileName: string }[];
}): string {
  const hash = createHash('sha256')
    .update(params.threadId ?? '')
    .update('\0')
    .update(params.textFormat)
    .update('\0')
    .update(params.text);
  for (const [position, image] of params.images.entries()) {
    hash
      .update('\0')
      .update(String(position))
      .update('\0')
      .update(image.mimeType)
      .update('\0')
      .update(image.fileName)
      .update('\0')
      .update(image.base64);
  }
  return hash.digest('hex');
}

function buildPublisherSuggestionSubmissionLockKey(chatId: string, userId: string): string {
  return `publisher-suggestion-submit:${chatId}:${userId}`;
}

function buildPublisherSuggestionAdmissionPayload(params: {
  requestId: string | null;
  inputHash: string;
  claimToken: string;
  now: Date;
  attempt: number;
}): Prisma.InputJsonObject {
  return {
    type: 'suggest_admission',
    submissionProtocol: PUBLISHER_SUGGESTION_ADMISSION_PROTOCOL,
    submissionStatus: 'processing',
    submissionClaimToken: params.claimToken,
    submissionLeaseExpiresAt: new Date(
      params.now.getTime() + PUBLISHER_SUGGESTION_ADMISSION_LEASE_MS,
    ).toISOString(),
    submissionAttempt: params.attempt,
    submissionError: null,
    ...(params.requestId ? { requestId: params.requestId } : {}),
    requestInputHash: params.inputHash,
  };
}

function lockPublisherSuggestionSubmission(
  tx: Prisma.TransactionClient,
  lockKey: string,
): Promise<unknown> {
  return tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0::BIGINT))`,
  );
}

function publisherSuggestionRequestCollision(): ConflictException {
  return new ConflictException('Этот идентификатор уже использован для другой предложки.');
}

function readPublisherSuggestionAdmissionStatus(
  value: unknown,
): PublisherSuggestionAdmissionStatus | null {
  return value === 'processing' || value === 'retryable' || value === 'rejected' ? value : null;
}

function readBadRequestMessage(error: unknown): string | null {
  if (!(error instanceof BadRequestException)) return null;
  const response = error.getResponse();
  if (typeof response === 'string' && response.trim()) return response.trim().slice(0, 300);
  const message = (response as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300);
  if (Array.isArray(message)) {
    const first = message.find(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    );
    if (first) return first.trim().slice(0, 300);
  }
  return error.message.trim().slice(0, 300) || null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readDate(value: unknown): Date | null {
  const normalized = readString(value);
  if (!normalized) return null;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function readNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
