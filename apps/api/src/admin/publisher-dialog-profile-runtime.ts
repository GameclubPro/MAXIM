import {
  channelDialogResponseSchema,
  channelDialogTypeSchema,
  createChannelDialogMessageRequestSchema,
  createChannelDialogMessageResponseSchema,
  type ChannelDialogMessage,
  type ChannelDialogNotificationSettings,
  type ChannelDialogType,
  type ChatSettings,
} from '@maxim/contracts';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import {
  ChatEntityType,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
  type Prisma,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherDialogLinkService } from '../publisher/publisher-dialog-link.service';
import { PublisherReadinessService } from '../publisher/publisher-readiness.service';
import { AdminDialogLinkHelper } from './admin-dialog-link-helper';
import { buildPublisherChatCommentsQuery } from './publisher-chat-comment-store';
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
};

export class PublisherDialogProfileRuntime {
  constructor(private readonly context: PublisherDialogProfileRuntimeContext) {}

  async getChannelSuggestionDialog(params: {
    chatId: string;
    user: AuthUser;
    dialogTypeRaw: string;
    token: string | null;
    mapAuditLog: DialogAuditLogMapper;
  }) {
    const dialogType = channelDialogTypeSchema.parse(params.dialogTypeRaw);
    if (dialogType !== 'suggest') {
      throw new BadRequestException('Для Публика доступен только сценарий предложек.');
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
      introText: 'Отправьте идею администраторам канала.',
      messages: rows
        .slice()
        .reverse()
        .map((row) => params.mapAuditLog(row, dialogType, params.user.userId, new Set())),
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
    if (
      parsed.data.attachments.length > 0 ||
      parsed.data.images.length > 0 ||
      Boolean(parsed.data.imageBase64)
    ) {
      throw new BadRequestException('В предложках Публика пока доступен только текст.');
    }
    const text = parsed.data.text.trim();
    if (!text) {
      throw new BadRequestException('Введите текст предложки.');
    }
    const threadId = this.resolveChannelThreadId(
      params.chatId,
      params.dialogType,
      parsed.data.token,
      'publisher',
    );
    await this.assertChannelSuggestionDailyLimit(params.chatId, params.user.userId);
    const created = await this.context.prisma.auditLog.create({
      data: {
        chatId: params.chatId,
        actorUserId: params.user.userId,
        action: PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST,
        payload: {
          type: 'suggest',
          threadId,
          text,
          ...(parsed.data.textFormat === 'markdown' ? { textFormat: 'markdown' } : {}),
          actorUserId: params.user.userId,
          authorDisplayName:
            params.user.displayName?.trim() || params.user.username?.trim() || null,
          authorUsername: params.user.username?.trim() || null,
          authorAvatarUrl: params.user.avatarUrl?.trim() || null,
          source: 'publisher_miniapp_dialog',
          publisherProfile: true,
          reviewStatus: 'pending',
          hasImage: false,
          imageCount: 0,
        },
      },
      select: { id: true, actorUserId: true, payload: true, createdAt: true },
    });
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

  async readAdminUserIds(chatId: string): Promise<Set<string>> {
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
        entityType: ChatEntityType.CHAT,
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

  async assertAdminAccess(chatId: string, userId: string): Promise<void> {
    if (!(await this.readAdminUserIds(chatId)).has(userId.trim())) {
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

  private async assertChannelSuggestionDailyLimit(chatId: string, userId: string): Promise<void> {
    const count = await this.context.prisma.auditLog.count({
      where: {
        chatId,
        actorUserId: userId,
        action: PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) },
      },
    });
    if (count >= 10) {
      throw new BadRequestException('Лимит предложек на сегодня исчерпан.');
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
