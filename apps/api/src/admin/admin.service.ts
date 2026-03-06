import {
  addGlobalUserBlacklistRequestSchema,
  addDomainRequestSchema,
  addAdminRequestSchema,
  channelDialogResponseSchema,
  channelDialogTypeSchema,
  channelSettingsSchema,
  createChannelDialogMessageRequestSchema,
  createChannelDialogMessageResponseSchema,
  dateRangeQuerySchema,
  logsDashboardQuerySchema,
  logsDashboardResponseSchema,
  manualModerationActionRequestSchema,
  manualModerationActionResultSchema,
  type ChannelDialogType,
  type ChannelSettings,
  type ChatSettings,
  chatSettingsSchema,
  type DomainAllowlistEntry,
  type GlobalUserBlacklistEntry,
  type LogsDashboardRange,
  type LogsDashboardResponse,
  type ManagedEntityType,
  type ManualModerationActionResult,
  type Me,
  type ModerationEvent,
  publishChannelEngagementRequestSchema,
  publishChannelEngagementResultSchema,
  type SendBroadcastResult,
  type ChatSummary,
  sendBroadcastRequestSchema,
  scheduleDomainRemovalRequestSchema,
} from '@maxim/contracts';
import { ChatEntityType, EventType, Operator, Prisma, SanctionAction } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  MaxClientService,
  type MaxMessageButton,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';

type ApplySettingsToAllChatsResult = {
  sourceChatId: string;
  updatedChats: number;
  appliedChatIds: string[];
};

type ManagedEntityTypeFilter = ManagedEntityType | 'all';

export type AdminActionSource = 'miniapp' | 'private_bot';

const BROADCAST_IMAGE_MAX_BYTES = 1_000_000;
const BROADCAST_MIN_DELAY_MS = 30_000;
const BROADCAST_MAX_DELAY_MS = 14 * 24 * 60 * 60 * 1000;
const BROADCAST_CYCLE_MAX_COUNT = 14;
const BROADCAST_DAY_MS = 24 * 60 * 60 * 1000;
const BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS = [1_500, 3_000, 6_000];
const LOGS_DASHBOARD_VIOLATIONS_LIMIT = 30;
const ONE_HOUR_MS = 60 * 60 * 1000;
const LIST_CHATS_ADMIN_CHECK_CONCURRENCY = 5;
const CHANNEL_DIALOG_MESSAGES_LIMIT = 80;
const CHANNEL_DIALOG_ACTION_COMMENT = 'CHANNEL_DIALOG_COMMENT';
const CHANNEL_DIALOG_ACTION_SUGGEST = 'CHANNEL_DIALOG_SUGGESTION';
const CHANNEL_DIALOG_ACTION_PUBLISH = 'PUBLISH_CHANNEL_ENGAGEMENT';
const CHANNEL_DIALOG_START_PARAM_PREFIX = 'cd-';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  private readonly appBaseUrl: string | null;
  private readonly explicitBotContactId: string | null;
  private readonly ownBotUserId: string | null;
  private readonly maxBotToken: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly chatContextCache: ChatContextCacheService,
    configService: ConfigService,
  ) {
    this.maxBotToken = configService.getOrThrow<string>('MAX_BOT_TOKEN');
    this.appBaseUrl = this.normalizeAppBaseUrl(configService.get<string>('APP_BASE_URL'));
    this.explicitBotContactId = this.normalizeBotContactId(configService.get<string>('MAX_BOT_CONTACT_ID'));
    this.ownBotUserId = this.normalizeOwnBotUserId(configService.get<string>('MAX_BOT_ID'));
  }

  getMe(user: AuthUser): Me {
    return {
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
    };
  }

  async listChats(user: AuthUser): Promise<ChatSummary[]> {
    return this.listManagedEntities(user, 'chat');
  }

  async listChannels(user: AuthUser): Promise<ChatSummary[]> {
    return this.listManagedEntities(user, 'channel');
  }

  async listManagedEntities(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter = 'all',
  ): Promise<ChatSummary[]> {
    try {
      const remoteChats = await this.maxClient.listBotChats();
      const resolvedChats = await this.mapWithConcurrencyLimit(
        remoteChats,
        LIST_CHATS_ADMIN_CHECK_CONCURRENCY,
        async (remoteChat) => {
          const hasAdminAccess = await this.hasUserAndBotAdminAccess(
            remoteChat.chatId,
            user.userId,
          );
          if (!hasAdminAccess) {
            return null;
          }

          const persistedChat = await this.upsertUserChatAccess(
            remoteChat.chatId,
            user.userId,
            remoteChat.title,
            remoteChat.entityType,
            { updateEntityType: true },
          );

          const chat: ChatSummary = {
            id: persistedChat.id,
            title: persistedChat.title,
            createdAt: persistedChat.createdAt.toISOString(),
            entityType: this.fromPrismaEntityType(persistedChat.entityType),
            link: remoteChat.link,
          };

          if (this.isFallbackTitle(chat.id, chat.title)) {
            await this.refreshChatTitle(chat);
          }

          return {
            chat,
            lastEventTime: remoteChat.lastEventTime ?? 0,
          };
        },
      );

      const filtered = resolvedChats.filter(
        (item): item is { chat: ChatSummary; lastEventTime: number } => item !== null,
      );

      if (filtered.length > 0) {
        const byType =
          entityType === 'all'
            ? filtered
            : filtered.filter((item) => item.chat.entityType === entityType);
        byType.sort((a, b) => b.lastEventTime - a.lastEventTime);
        return byType.map((item) => item.chat);
      }
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to auto-discover chats via MAX API',
      );
    }

    const cached = await this.listChatsFromAllowlist(user.userId, entityType);
    if (cached.length > 0) {
      return cached;
    }

    const bootstrapped = await this.bootstrapCurrentChat(user, entityType);
    return bootstrapped ? [bootstrapped] : [];
  }

  async getSettings(chatId: string, user: AuthUser): Promise<ChatSettings> {
    await this.assertChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const chat = await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: `Chat ${chatId}`,
        entityType: ChatEntityType.CHAT,
        settings: {
          create: {},
        },
      },
      update: {
        settings: {
          upsert: {
            update: {},
            create: {},
          },
        },
      },
      include: { settings: true },
    });

    if (!chat.settings) {
      throw new Error('Chat settings missing after upsert');
    }

    const parsed = chatSettingsSchema.safeParse(chat.settings);
    if (parsed.success) {
      return parsed.data;
    }

    this.logger.warn(
      {
        chatId,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      'Invalid chat settings found in DB, applying defaults',
    );

    const fallback = chatSettingsSchema.parse({});
    await this.prisma.chatSettings.update({
      where: { chatId },
      data: {
        ...fallback,
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return fallback;
  }

  async updateSettings(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ChatSettings> {
    await this.assertChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');
    const parsed = chatSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: `Chat ${chatId}`,
        entityType: ChatEntityType.CHAT,
        settings: {
          create: {
            ...parsed.data,
          },
        },
      },
      update: {
        settings: {
          upsert: {
            update: {
              ...parsed.data,
            },
            create: {
              ...parsed.data,
            },
          },
        },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'UPDATE_SETTINGS',
        payload: {
          ...parsed.data,
          source,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return parsed.data;
  }

  async getChannelSettings(chatId: string, user: AuthUser): Promise<ChannelSettings> {
    await this.assertChatAdmin(chatId, user.userId, 'channel');
    await this.ensureEntityType(chatId, user.userId, 'channel');

    const chat = await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: `Channel ${chatId}`,
        entityType: ChatEntityType.CHANNEL,
        channelSettings: {
          create: {},
        },
      },
      update: {
        entityType: ChatEntityType.CHANNEL,
        channelSettings: {
          upsert: {
            update: {},
            create: {},
          },
        },
      },
      include: { channelSettings: true },
    });

    if (!chat.channelSettings) {
      throw new Error('Channel settings missing after upsert');
    }

    const parsed = channelSettingsSchema.safeParse(chat.channelSettings);
    if (parsed.success) {
      return parsed.data;
    }

    this.logger.warn(
      {
        chatId,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      'Invalid channel settings found in DB, applying defaults',
    );

    const fallback = channelSettingsSchema.parse({});
    await this.prisma.channelSettings.update({
      where: { chatId },
      data: {
        ...fallback,
      },
    });

    return fallback;
  }

  async updateChannelSettings(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ChannelSettings> {
    await this.assertChatAdmin(chatId, user.userId, 'channel');
    await this.ensureEntityType(chatId, user.userId, 'channel');
    const parsed = channelSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: `Channel ${chatId}`,
        entityType: ChatEntityType.CHANNEL,
        channelSettings: {
          create: {
            ...parsed.data,
          },
        },
      },
      update: {
        entityType: ChatEntityType.CHANNEL,
        channelSettings: {
          upsert: {
            update: {
              ...parsed.data,
            },
            create: {
              ...parsed.data,
            },
          },
        },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'UPDATE_CHANNEL_SETTINGS',
        payload: {
          ...parsed.data,
          source,
        },
      },
    });

    return parsed.data;
  }

  async publishChannelEngagementMessage(chatId: string, user: AuthUser, body: unknown) {
    await this.assertChatAdmin(chatId, user.userId, 'channel');
    await this.ensureEntityType(chatId, user.userId, 'channel');

    const parsed = publishChannelEngagementRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const commentsUrl = this.buildChannelDialogWebAppUrl(chatId, 'comments');
    const suggestUrl = this.buildChannelDialogWebAppUrl(chatId, 'suggest');
    const botContactId = this.resolveBotContactId();
    const buttons: MaxMessageButton[] = [];
    buttons.push(
      commentsUrl && botContactId
        ? {
            type: 'open_app',
            text: parsed.data.commentsButtonText,
            webApp: commentsUrl,
            contactId: botContactId,
          }
        : {
            type: 'link',
            text: parsed.data.commentsButtonText,
            url: commentsUrl ?? `${this.appBaseUrl ?? 'https://maxim.play-team.ru'}/app/`,
          },
    );
    buttons.push(
      suggestUrl && botContactId
        ? {
            type: 'open_app',
            text: parsed.data.suggestButtonText,
            webApp: suggestUrl,
            contactId: botContactId,
          }
        : {
            type: 'link',
            text: parsed.data.suggestButtonText,
            url: suggestUrl ?? `${this.appBaseUrl ?? 'https://maxim.play-team.ru'}/app/`,
          },
    );

    await this.maxClient.sendMessage(
      chatId,
      parsed.data.text,
      {
        buttons: [buttons],
      } satisfies MaxSendMessageOptions,
      { immediate: true },
    );

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: CHANNEL_DIALOG_ACTION_PUBLISH,
        payload: {
          text: parsed.data.text,
          commentsButtonText: parsed.data.commentsButtonText,
          suggestButtonText: parsed.data.suggestButtonText,
          commentsUrl,
          suggestUrl,
        },
      },
    });

    return publishChannelEngagementResultSchema.parse({
      chatId,
      sent: true,
      messageId: null,
    });
  }

  async getChannelDialog(chatId: string, user: AuthUser, dialogTypeRaw: string, token: string | null) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    this.assertValidChannelDialogToken(chatId, dialogType, token);

    const action = dialogType === 'comments' ? CHANNEL_DIALOG_ACTION_COMMENT : CHANNEL_DIALOG_ACTION_SUGGEST;
    const rows = await this.prisma.auditLog.findMany({
      where: {
        chatId,
        action,
        ...(dialogType === 'suggest' ? { actorUserId: user.userId } : {}),
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: CHANNEL_DIALOG_MESSAGES_LIMIT,
    });

    const messages = rows
      .slice()
      .reverse()
      .map((row) => this.mapChannelDialogAuditLog(row, dialogType));

    return channelDialogResponseSchema.parse({
      chatId,
      type: dialogType,
      messages,
    });
  }

  async createChannelDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    body: unknown,
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    const parsed = createChannelDialogMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    this.assertValidChannelDialogToken(chatId, dialogType, parsed.data.token);
    const text = parsed.data.text.trim();
    const authorDisplayName = user.displayName?.trim() ? user.displayName.trim() : user.username;

    let delivered = true;
    let deliveredToUserId: string | null = null;
    if (dialogType === 'suggest') {
      const delivery = await this.deliverSuggestionToAdminPrivate(chatId, user, text);
      delivered = delivery.delivered;
      deliveredToUserId = delivery.deliveredToUserId;
    }

    const created = await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: dialogType === 'comments' ? CHANNEL_DIALOG_ACTION_COMMENT : CHANNEL_DIALOG_ACTION_SUGGEST,
        payload: {
          type: dialogType,
          text,
          authorDisplayName: authorDisplayName ?? null,
          delivered,
          deliveredToUserId,
          source: 'miniapp_dialog',
        },
      },
    });

    const message = {
      id: created.id,
      type: dialogType,
      text,
      authorUserId: user.userId,
      authorDisplayName: authorDisplayName ?? null,
      createdAt: created.createdAt.toISOString(),
      ...(dialogType === 'suggest'
        ? {
            delivered,
            deliveredToUserId,
          }
        : {}),
    };

    return createChannelDialogMessageResponseSchema.parse({
      ok: true,
      message,
    });
  }

  async applySettingsToAllChats(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
    settingKeys?: readonly (keyof ChatSettings)[],
  ): Promise<ApplySettingsToAllChatsResult> {
    await this.assertChatAdmin(sourceChatId, user.userId, 'chat');
    await this.ensureEntityType(sourceChatId, user.userId, 'chat');
    const parsed = chatSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const availableChats = await this.listChats(user);
    const appliedChatIds = Array.from(
      new Set([sourceChatId, ...availableChats.map((chat) => chat.id)]),
    );
    const filteredSettingKeys = Array.isArray(settingKeys)
      ? Array.from(new Set(settingKeys)).filter(
          (key): key is keyof ChatSettings => typeof key === 'string' && key in parsed.data,
        )
      : [];
    const settingsUpdatePayload: Partial<ChatSettings> =
      filteredSettingKeys.length > 0
        ? filteredSettingKeys.reduce<Partial<ChatSettings>>((acc, key) => {
            (acc as Record<keyof ChatSettings, ChatSettings[keyof ChatSettings]>)[key] = parsed.data[key];
            return acc;
          }, {})
        : parsed.data;

    for (const chatId of appliedChatIds) {
      await this.prisma.chat.upsert({
        where: { id: chatId },
        create: {
          id: chatId,
          title: `Chat ${chatId}`,
          entityType: ChatEntityType.CHAT,
          settings: {
            create: {
              ...parsed.data,
            },
          },
        },
        update: {
          settings: {
            upsert: {
              update: {
                ...settingsUpdatePayload,
              },
              create: {
                ...parsed.data,
              },
            },
          },
        },
      });

      await this.prisma.chatAdminAllowlist.upsert({
        where: {
          chatId_userId: {
            chatId,
            userId: user.userId,
          },
        },
        create: {
          chatId,
          userId: user.userId,
        },
        update: {},
      });

      await this.prisma.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: 'APPLY_SETTINGS_TO_ALL_CHATS',
          payload: {
            sourceChatId,
            targetChatId: chatId,
            source,
            ...(filteredSettingKeys.length > 0
              ? { settingKeys: filteredSettingKeys }
              : {}),
          },
        },
      });

      await this.chatContextCache.invalidate(chatId);
    }

    return {
      sourceChatId,
      updatedChats: appliedChatIds.length,
      appliedChatIds,
    };
  }

  async sendBroadcast(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<SendBroadcastResult> {
    await this.assertChatAdmin(sourceChatId, user.userId, 'chat');
    await this.ensureEntityType(sourceChatId, user.userId, 'chat');
    const parsed = sendBroadcastRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const availableChats = parsed.data.applyToAllChats ? await this.listChats(user) : [];
    const targetChatIds = parsed.data.applyToAllChats
      ? Array.from(new Set([sourceChatId, ...availableChats.map((chat) => chat.id)]))
      : [sourceChatId];
    const messageText = parsed.data.text.trim() || (parsed.data.imageEnabled ? ' ' : '');

    let delayMs = 0;
    let sendAt: string | null = null;
    if (parsed.data.sendAt) {
      const scheduledAt = new Date(parsed.data.sendAt);
      if (Number.isNaN(scheduledAt.getTime())) {
        throw new BadRequestException('Некорректное время рассылки.');
      }
      const calculatedDelayMs = scheduledAt.getTime() - Date.now();
      if (calculatedDelayMs < BROADCAST_MIN_DELAY_MS) {
        throw new BadRequestException('Укажите время рассылки минимум через 30 секунд.');
      }
      if (calculatedDelayMs > BROADCAST_MAX_DELAY_MS) {
        throw new BadRequestException('Максимальный таймер рассылки: 14 дней.');
      }
      delayMs = calculatedDelayMs;
      sendAt = scheduledAt.toISOString();
    }

    const cycleEnabled = parsed.data.cycleEnabled;
    const cycleEveryDays = cycleEnabled ? parsed.data.cycleEveryDays : 1;
    const cycleCount = cycleEnabled ? parsed.data.cycleCount : 1;
    if (cycleEnabled && cycleCount > BROADCAST_CYCLE_MAX_COUNT) {
      throw new BadRequestException(`Максимум ${BROADCAST_CYCLE_MAX_COUNT} отправок в цикле.`);
    }
    const cycleEveryMs = cycleEveryDays * BROADCAST_DAY_MS;
    const maxDelayWithCycles = delayMs + (cycleCount - 1) * cycleEveryMs;
    if (maxDelayWithCycles > BROADCAST_MAX_DELAY_MS) {
      throw new BadRequestException(
        'Все циклы должны укладываться в 14 дней от текущего момента.',
      );
    }

    let imagePayload: Record<string, unknown> | undefined;
    if (parsed.data.imageEnabled) {
      const imageMimeType = parsed.data.imageMimeType.trim().toLowerCase();
      if (!imageMimeType.startsWith('image/')) {
        throw new BadRequestException('Поддерживаются только изображения.');
      }
      const imageBuffer = this.decodeBroadcastImageBase64(parsed.data.imageBase64);
      if (imageBuffer.length > BROADCAST_IMAGE_MAX_BYTES) {
        throw new BadRequestException('Фото слишком большое. Максимум 1 MB.');
      }
      try {
        imagePayload = await this.maxClient.uploadImage(
          imageBuffer,
          this.resolveBroadcastImageFileName(parsed.data.imageFileName, imageMimeType),
          imageMimeType,
        );
      } catch (error: unknown) {
        this.logger.warn(
          {
            sourceChatId,
            actorUserId: user.userId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Broadcast image upload failed',
        );
        throw new BadRequestException('Не удалось загрузить фото. Попробуйте другое изображение.');
      }
    }

    const messageOptions =
      parsed.data.buttonEnabled || imagePayload
        ? {
            ...(parsed.data.buttonEnabled
              ? {
                  button: {
                    text: parsed.data.buttonText.trim(),
                    url: parsed.data.buttonUrl.trim(),
                  },
                }
              : {}),
            ...(imagePayload ? { imagePayload } : {}),
          }
        : undefined;

    const sentChatIds: string[] = [];
    const failedChatIds: string[] = [];
    let firstSendError: unknown = null;
    for (const chatId of targetChatIds) {
      let chatFailed = false;
      for (let cycleIndex = 0; cycleIndex < cycleCount; cycleIndex += 1) {
        const occurrenceDelayMs = delayMs + cycleIndex * cycleEveryMs;
        const sendImmediately = occurrenceDelayMs === 0;
        try {
          if (sendImmediately && imagePayload) {
            await this.sendBroadcastImageMessageWithRetry(chatId, messageText, messageOptions);
          } else {
            await this.maxClient.sendMessage(
              chatId,
              messageText,
              messageOptions,
              occurrenceDelayMs > 0 ? { delayMs: occurrenceDelayMs } : { immediate: true },
            );
          }
        } catch (error: unknown) {
          if (!firstSendError) {
            firstSendError = error;
          }
          chatFailed = true;
          this.logger.warn(
            {
              sourceChatId,
              targetChatId: chatId,
              actorUserId: user.userId,
              sendAt,
              cycleEnabled,
              cycleEveryDays,
              cycleCount,
              cycleIndex: cycleIndex + 1,
              err: error instanceof Error ? error.message : String(error),
            },
            'Broadcast message failed for target chat',
          );
          break;
        }
      }

      if (chatFailed) {
        failedChatIds.push(chatId);
        continue;
      }

      sentChatIds.push(chatId);
    }

    if (sentChatIds.length === 0 && failedChatIds.length > 0) {
      const fallbackMessage = 'Не удалось отправить рассылку.';
      const maxApiMessage = this.extractMaxApiErrorMessage(firstSendError);
      throw new BadRequestException(maxApiMessage || fallbackMessage);
    }

    await this.prisma.auditLog.create({
      data: {
        chatId: sourceChatId,
        actorUserId: user.userId,
        action: 'SEND_BROADCAST',
        payload: {
          applyToAllChats: parsed.data.applyToAllChats,
          targetChats: targetChatIds.length,
          sentChats: sentChatIds.length,
          failedChats: failedChatIds.length,
          sendAt,
          cycleEnabled,
          cycleEveryDays,
          cycleCount,
          sentChatIds,
          failedChatIds,
          source,
        },
      },
    });

    return {
      sourceChatId,
      targetChats: targetChatIds.length,
      sentChats: sentChatIds.length,
      failedChats: failedChatIds.length,
      sendAt,
      cycleEnabled,
      cycleEveryDays,
      cycleCount,
      sentChatIds,
      failedChatIds,
    };
  }

  private async sendBroadcastImageMessageWithRetry(
    chatId: string,
    text: string,
    options: { button?: { text: string; url: string }; imagePayload?: Record<string, unknown> } | undefined,
  ): Promise<void> {
    let lastError: unknown = null;
    const attempts = BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS.length + 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.maxClient.sendMessage(chatId, text, options, { immediate: true });
        return;
      } catch (error: unknown) {
        lastError = error;
        if (!this.isAttachmentNotReadyError(error) || attempt >= attempts) {
          throw error;
        }
        const delayMs = BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS[attempt - 1] ?? 1_500;
        await this.sleep(delayMs);
      }
    }

    if (lastError) {
      throw lastError;
    }
  }

  private isAttachmentNotReadyError(error: unknown): boolean {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status !== 400) {
      return false;
    }

    const responseData = (error as { response?: { data?: unknown } })?.response?.data;
    const normalized = JSON.stringify(responseData ?? '').toLowerCase();
    return normalized.includes('attachment.not.ready') || normalized.includes('not ready');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private extractMaxApiErrorMessage(error: unknown): string {
    const responseData = (error as { response?: { data?: unknown } })?.response?.data;
    if (!responseData || typeof responseData !== 'object') {
      return '';
    }

    const row = responseData as Record<string, unknown>;
    const message = row.message;
    if (typeof message === 'string' && message.trim()) {
      return message.trim();
    }

    const code = row.code;
    if (typeof code === 'string' && code.trim()) {
      return `Ошибка MAX API: ${code.trim()}`;
    }

    return '';
  }

  private decodeBroadcastImageBase64(value: string): Buffer {
    const normalized = value.trim().replace(/^data:[^;]+;base64,/, '');
    if (!normalized) {
      throw new BadRequestException('Добавьте фото для рассылки.');
    }

    let imageBuffer: Buffer;
    try {
      imageBuffer = Buffer.from(normalized, 'base64');
    } catch {
      throw new BadRequestException('Не удалось прочитать фото.');
    }

    if (imageBuffer.length === 0) {
      throw new BadRequestException('Не удалось прочитать фото.');
    }

    return imageBuffer;
  }

  private resolveBroadcastImageFileName(fileName: string, mimeType: string): string {
    const trimmed = fileName.trim();
    if (trimmed) {
      return trimmed;
    }

    if (mimeType === 'image/png') {
      return 'broadcast-image.png';
    }
    if (mimeType === 'image/webp') {
      return 'broadcast-image.webp';
    }
    if (mimeType === 'image/gif') {
      return 'broadcast-image.gif';
    }

    return 'broadcast-image.jpg';
  }

  async getLogsDashboard(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<LogsDashboardResponse> {
    await this.assertChatAdmin(chatId, user.userId);
    const parsed = logsDashboardQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const now = new Date();
    const from = this.resolveLogsDashboardFrom(parsed.data.range, now);

    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { id: true, title: true },
    });

    const membershipRows = await this.prisma.$queryRaw<
      Array<{ joined_users: unknown; left_users: unknown }>
    >`
      SELECT
        COUNT(*) FILTER (WHERE normalized_payload->>'type' = 'user_added') AS joined_users,
        COUNT(*) FILTER (WHERE normalized_payload->>'type' = 'user_removed') AS left_users
      FROM webhook_events
      WHERE normalized_payload->'message'->>'chatId' = ${chatId}
        AND normalized_payload->>'type' IN ('user_added', 'user_removed')
        AND created_at >= ${from}
        AND created_at <= ${now}
    `;

    const [warnCount, deleteMessageCount, kickCount, banCount, violationRows] = await Promise.all([
      this.prisma.moderationEvent.count({
        where: {
          chatId,
          action: 'WARN',
          createdAt: { gte: from, lte: now },
        },
      }),
      this.prisma.moderationEvent.count({
        where: {
          chatId,
          action: 'DELETE_MESSAGE',
          createdAt: { gte: from, lte: now },
        },
      }),
      this.prisma.moderationEvent.count({
        where: {
          chatId,
          action: 'KICK',
          createdAt: { gte: from, lte: now },
        },
      }),
      this.prisma.moderationEvent.count({
        where: {
          chatId,
          action: 'BAN',
          createdAt: { gte: from, lte: now },
        },
      }),
      this.prisma.moderationEvent.findMany({
        where: {
          chatId,
          action: {
            in: ['WARN', 'DELETE_MESSAGE', 'KICK', 'BAN'],
          },
          createdAt: { gte: from, lte: now },
        },
        orderBy: { createdAt: 'desc' },
        take: LOGS_DASHBOARD_VIOLATIONS_LIMIT,
      }),
    ]);
    const userDisplayNames = await this.resolveUserDisplayNames(
      chatId,
      violationRows.map((row) => row.userId),
    );

    const membershipSource = membershipRows[0] ?? { joined_users: 0, left_users: 0 };
    const response: LogsDashboardResponse = {
      chat: {
        id: chatId,
        title: chat?.title?.trim() || 'Чат без названия',
      },
      period: {
        range: parsed.data.range,
        from: from.toISOString(),
        to: now.toISOString(),
      },
      membership: {
        joinedUsers: this.toSafeInteger(membershipSource.joined_users),
        leftUsers: this.toSafeInteger(membershipSource.left_users),
      },
      violationsSummary: {
        warn: warnCount,
        deleteMessage: deleteMessageCount,
        kick: kickCount,
        ban: banCount,
        total: warnCount + deleteMessageCount + kickCount + banCount,
      },
      violations: violationRows.map((row) => ({
        id: row.id,
        action: row.action,
        ruleCode: row.ruleCode,
        userId: row.userId,
        userDisplayName: userDisplayNames.get(row.userId) ?? null,
        createdAt: row.createdAt.toISOString(),
        maskedExcerpt: row.maskedExcerpt,
        metadata:
          row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
            ? (row.metadata as Record<string, unknown>)
            : null,
      })),
    };

    return logsDashboardResponseSchema.parse(response);
  }

  async applyManualModerationAction(
    chatId: string,
    targetUserIdRaw: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ManualModerationActionResult> {
    await this.assertChatAdmin(chatId, user.userId);
    const targetUserId = targetUserIdRaw.trim();
    if (!targetUserId) {
      throw new BadRequestException('User ID is required');
    }
    if (targetUserId === user.userId) {
      throw new BadRequestException('Нельзя применять это действие к своему аккаунту.');
    }

    const parsed = manualModerationActionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const metadataBase = {
      source,
      initiatedByUserId: user.userId,
    } as const;

    if (parsed.data.action === 'KICK') {
      try {
        await this.maxClient.kickMember(chatId, targetUserId, { immediate: true });
      } catch (error: unknown) {
        const maxApiMessage = this.extractMaxApiErrorMessage(error);
        throw new BadRequestException(maxApiMessage || 'Не удалось удалить участника из чата.');
      }

      await this.prisma.moderationEvent.create({
        data: {
          chatId,
          userId: targetUserId,
          eventType: EventType.MEMBER_ACTION,
          ruleCode: 'MANUAL_KICK',
          action: SanctionAction.KICK,
          operator: Operator.ADMIN,
          metadata: {
            ...metadataBase,
            reason: 'Ручное удаление участника через miniapp',
          },
        },
      });

      await this.prisma.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: 'MANUAL_KICK_MEMBER',
          payload: {
            userId: targetUserId,
            source,
          },
        },
      });

      return manualModerationActionResultSchema.parse({
        ok: true,
        action: 'KICK',
        userId: targetUserId,
        banDurationHours: null,
        unbanScheduledAt: null,
        message: 'Участник удалён из чата.',
      });
    }

    if (parsed.data.action === 'BAN') {
      const banDurationHours = parsed.data.banDurationHours;
      if (!banDurationHours) {
        throw new BadRequestException('Укажите длительность бана в часах.');
      }
      const unbanScheduledAt = new Date(Date.now() + banDurationHours * ONE_HOUR_MS);

      try {
        await this.maxClient.banMember(chatId, targetUserId, { immediate: true });
        try {
          await this.maxClient.unbanMember(chatId, targetUserId, {
            delayMs: banDurationHours * ONE_HOUR_MS,
          });
        } catch (scheduleError: unknown) {
          try {
            await this.maxClient.unbanMember(chatId, targetUserId, { immediate: true });
          } catch (rollbackError: unknown) {
            this.logger.warn(
              {
                chatId,
                userId: targetUserId,
                err:
                  rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
              },
              'Failed to rollback manual ban after scheduling error',
            );
          }

          throw scheduleError;
        }
      } catch (error: unknown) {
        const maxApiMessage = this.extractMaxApiErrorMessage(error);
        throw new BadRequestException(maxApiMessage || 'Не удалось применить временный бан.');
      }

      await this.prisma.moderationEvent.create({
        data: {
          chatId,
          userId: targetUserId,
          eventType: EventType.MEMBER_ACTION,
          ruleCode: 'MANUAL_BAN',
          action: SanctionAction.BAN,
          operator: Operator.ADMIN,
          metadata: {
            ...metadataBase,
            reason: 'Ручной бан участника через miniapp',
            banDurationHours,
            unbanScheduledAt: unbanScheduledAt.toISOString(),
            mode: 'MAX_BLOCK',
          },
        },
      });

      await this.prisma.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: 'MANUAL_BAN_MEMBER',
          payload: {
            userId: targetUserId,
            banDurationHours,
            unbanScheduledAt: unbanScheduledAt.toISOString(),
            source,
          },
        },
      });

      return manualModerationActionResultSchema.parse({
        ok: true,
        action: 'BAN',
        userId: targetUserId,
        banDurationHours,
        unbanScheduledAt: unbanScheduledAt.toISOString(),
        message: `Участник забанен на ${banDurationHours}ч. Авторазбан запланирован.`,
      });
    }

    try {
      await this.maxClient.unbanMember(chatId, targetUserId, { immediate: true });
    } catch (error: unknown) {
      const maxApiMessage = this.extractMaxApiErrorMessage(error);
      throw new BadRequestException(maxApiMessage || 'Не удалось вернуть участника в чат.');
    }

    await this.prisma.moderationEvent.create({
      data: {
        chatId,
        userId: targetUserId,
        eventType: EventType.MEMBER_ACTION,
        ruleCode: 'MANUAL_UNBAN',
        action: SanctionAction.NONE,
        operator: Operator.ADMIN,
        metadata: {
          ...metadataBase,
          reason: 'Ручной разбан участника через miniapp',
          mode: 'MAX_UNBLOCK',
        },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'MANUAL_UNBAN_MEMBER',
          payload: {
            userId: targetUserId,
            source,
          },
        },
      });

    return manualModerationActionResultSchema.parse({
      ok: true,
      action: 'UNBAN',
      userId: targetUserId,
      banDurationHours: null,
      unbanScheduledAt: null,
      message: 'Участник возвращён в чат и разблокирован.',
    });
  }

  async getEvents(chatId: string, user: AuthUser, query: unknown): Promise<ModerationEvent[]> {
    await this.assertChatAdmin(chatId, user.userId);
    const parsed = dateRangeQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const from = parsed.data.from ? new Date(parsed.data.from) : undefined;
    const to = parsed.data.to ? new Date(parsed.data.to) : undefined;

    const rows = await this.prisma.moderationEvent.findMany({
      where: {
        chatId,
        ...(from || to
          ? {
              createdAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      skip: (parsed.data.page - 1) * parsed.data.limit,
      take: parsed.data.limit,
    });

    return rows.map((row) => ({
      id: row.id,
      chatId: row.chatId,
      userId: row.userId,
      eventType: row.eventType,
      ruleCode: row.ruleCode,
      action: row.action,
      maskedExcerpt: row.maskedExcerpt,
      score: row.score,
      metadata:
        row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : null,
      createdAt: row.createdAt.toISOString(),
      operator: row.operator,
    }));
  }

  async addAdmin(chatId: string, user: AuthUser, body: unknown) {
    await this.assertChatAdmin(chatId, user.userId);
    const parsed = addAdminRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: `Chat ${chatId}`,
      },
      update: {},
    });

    await this.prisma.chatAdminAllowlist.upsert({
      where: {
        chatId_userId: {
          chatId,
          userId: parsed.data.userId,
        },
      },
      create: {
        chatId,
        userId: parsed.data.userId,
      },
      update: {},
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'ADD_ADMIN',
        payload: {
          userId: parsed.data.userId,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async removeAdmin(chatId: string, user: AuthUser, targetUserId: string) {
    await this.assertChatAdmin(chatId, user.userId);

    await this.prisma.chatAdminAllowlist.delete({
      where: {
        chatId_userId: {
          chatId,
          userId: targetUserId,
        },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'REMOVE_ADMIN',
        payload: {
          userId: targetUserId,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async getDomainAllowlist(chatId: string, user: AuthUser): Promise<string[]> {
    await this.assertChatAdmin(chatId, user.userId);

    const rows = await this.prisma.domainAllowlist.findMany({
      where: this.activeDomainWhere(chatId),
      orderBy: { domain: 'asc' },
      select: { domain: true },
    });

    return Array.from(
      new Set(
        rows
          .map((row: { domain: string }) => this.normalizeAllowlistLink(row.domain))
          .filter((value): value is string => Boolean(value)),
      ),
    ).sort((left, right) => left.localeCompare(right));
  }

  async getDomainAllowlistDetails(chatId: string, user: AuthUser): Promise<DomainAllowlistEntry[]> {
    await this.assertChatAdmin(chatId, user.userId);

    const rows = await this.prisma.domainAllowlist.findMany({
      where: this.activeDomainWhere(chatId),
      orderBy: [{ removeAfterAt: 'asc' }, { domain: 'asc' }],
      select: {
        domain: true,
        removeAfterAt: true,
      },
    });

    const byDomain = new Map<string, Date | null>();
    for (const row of rows) {
      const normalizedDomain = this.normalizeAllowlistLink(row.domain);
      if (!normalizedDomain) {
        continue;
      }

      const current = byDomain.get(normalizedDomain);
      if (current === undefined) {
        byDomain.set(normalizedDomain, row.removeAfterAt);
        continue;
      }

      if (current === null || row.removeAfterAt === null) {
        byDomain.set(normalizedDomain, null);
        continue;
      }

      if (row.removeAfterAt.getTime() < current.getTime()) {
        byDomain.set(normalizedDomain, row.removeAfterAt);
      }
    }

    return Array.from(byDomain.entries())
      .sort(([leftDomain, leftRemoveAfter], [rightDomain, rightRemoveAfter]) => {
        if (leftRemoveAfter === null && rightRemoveAfter !== null) {
          return -1;
        }
        if (leftRemoveAfter !== null && rightRemoveAfter === null) {
          return 1;
        }
        if (leftRemoveAfter !== null && rightRemoveAfter !== null) {
          const byTime = leftRemoveAfter.getTime() - rightRemoveAfter.getTime();
          if (byTime !== 0) {
            return byTime;
          }
        }

        return leftDomain.localeCompare(rightDomain);
      })
      .map(([domain, removeAfterAt]) => ({
        domain,
        removeAfterAt: removeAfterAt ? removeAfterAt.toISOString() : null,
      }));
  }

  async addDomain(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ) {
    await this.assertChatAdmin(chatId, user.userId);
    const parsed = addDomainRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const normalized = this.normalizeAllowlistLink(parsed.data.domain);
    if (!normalized) {
      throw new BadRequestException('Invalid allowlist domain');
    }

    await this.upsertNormalizedAllowlistDomain(chatId, normalized);

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'ADD_DOMAIN',
        payload: {
          domain: normalized,
          source,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async removeDomain(
    chatId: string,
    user: AuthUser,
    domain: string,
    source: AdminActionSource = 'miniapp',
  ) {
    await this.assertChatAdmin(chatId, user.userId);
    const normalized = this.normalizeAllowlistLink(this.decodePathParam(domain));
    if (!normalized) {
      throw new BadRequestException('Invalid allowlist domain');
    }

    const matchingDomains = await this.findStoredAllowlistDomains(chatId, normalized);
    if (matchingDomains.length === 0) {
      throw new BadRequestException('Domain not found in allowlist');
    }

    await this.prisma.domainAllowlist.deleteMany({
      where: {
        chatId,
        domain: {
          in: matchingDomains,
        },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'REMOVE_DOMAIN',
        payload: {
          domain: normalized,
          source,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async scheduleDomainRemoval(
    chatId: string,
    user: AuthUser,
    domain: string,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ) {
    await this.assertChatAdmin(chatId, user.userId);
    const normalizedDomain = this.normalizeAllowlistLink(this.decodePathParam(domain));
    if (!normalizedDomain) {
      throw new BadRequestException('Invalid allowlist domain');
    }
    const parsed = scheduleDomainRemovalRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    let removeAfterAt: Date | null = null;
    if (parsed.data.removeAfterAt) {
      const scheduledAt = new Date(parsed.data.removeAfterAt);
      if (Number.isNaN(scheduledAt.getTime())) {
        throw new BadRequestException('Invalid removal datetime');
      }

      if (scheduledAt.getTime() <= Date.now()) {
        throw new BadRequestException('Removal datetime must be in the future');
      }

      removeAfterAt = scheduledAt;
    }

    const matchingDomains = await this.findStoredAllowlistDomains(chatId, normalizedDomain);
    if (matchingDomains.length === 0) {
      throw new BadRequestException('Domain not found in allowlist');
    }

    await this.prisma.domainAllowlist.updateMany({
      where: {
        chatId,
        domain: {
          in: matchingDomains,
        },
      },
      data: {
        removeAfterAt,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: removeAfterAt ? 'SCHEDULE_DOMAIN_REMOVE' : 'CLEAR_DOMAIN_REMOVE_SCHEDULE',
        payload: {
          domain: normalizedDomain,
          removeAfterAt: removeAfterAt ? removeAfterAt.toISOString() : null,
          source,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async getGlobalUserBlacklist(chatId: string, user: AuthUser): Promise<GlobalUserBlacklistEntry[]> {
    await this.assertChatAdmin(chatId, user.userId);

    const rows = await this.prisma.globalUserBlacklist.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        userId: true,
        createdAt: true,
      },
    });

    return rows.map((row: { userId: string; createdAt: Date }) => ({
      userId: row.userId,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async addGlobalUserBlacklistUser(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ) {
    await this.assertChatAdmin(chatId, user.userId);
    const parsed = addGlobalUserBlacklistRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const normalizedUserId = parsed.data.userId.trim();

    await this.prisma.globalUserBlacklist.upsert({
      where: {
        userId: normalizedUserId,
      },
      create: {
        userId: normalizedUserId,
        sourceChatId: chatId,
        reason: 'MANUAL',
      },
      update: {
        sourceChatId: chatId,
        reason: 'MANUAL',
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'ADD_GLOBAL_USER_BLACKLIST',
        payload: {
          userId: normalizedUserId,
          source,
        },
      },
    });

    return { ok: true };
  }

  async removeGlobalUserBlacklistUser(
    chatId: string,
    user: AuthUser,
    targetUserId: string,
    source: AdminActionSource = 'miniapp',
  ) {
    await this.assertChatAdmin(chatId, user.userId);
    const normalizedUserId = targetUserId.trim();

    await this.prisma.globalUserBlacklist.deleteMany({
      where: {
        userId: normalizedUserId,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'REMOVE_GLOBAL_USER_BLACKLIST',
        payload: {
          userId: normalizedUserId,
          source,
        },
      },
    });

    return { ok: true };
  }

  async assertChatAdmin(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType | null = null,
  ) {
    const hasAdminAccess = await this.hasUserAndBotAdminAccess(chatId, userId);
    if (!hasAdminAccess) {
      throw new ForbiddenException('User is not chat admin');
    }

    await this.upsertUserChatAccess(chatId, userId, null, entityType);
  }

  private resolveLogsDashboardFrom(range: LogsDashboardRange, to: Date): Date {
    const toTimestamp = to.getTime();

    if (range === '24h') {
      return new Date(toTimestamp - 24 * 60 * 60 * 1000);
    }

    if (range === '30d') {
      return new Date(toTimestamp - 30 * 24 * 60 * 60 * 1000);
    }

    return new Date(toTimestamp - 7 * 24 * 60 * 60 * 1000);
  }

  private toSafeInteger(value: unknown): number {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
    }

    if (typeof value === 'bigint') {
      return value > 0n ? Number(value) : 0;
    }

    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      return Number.isNaN(parsed) ? 0 : Math.max(0, parsed);
    }

    return 0;
  }

  private async resolveUserDisplayNames(chatId: string, userIds: string[]): Promise<Map<string, string>> {
    const normalizedUserIds = [...new Set(userIds.map((item) => item.trim()).filter(Boolean))];
    if (normalizedUserIds.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.$queryRaw<Array<{ user_id: string | null; sender_name: string | null }>>`
      SELECT DISTINCT ON (sender_id)
        sender_id AS user_id,
        sender_name
      FROM (
        SELECT
          normalized_payload->'message'->>'senderId' AS sender_id,
          NULLIF(BTRIM(normalized_payload->'message'->>'senderName'), '') AS sender_name,
          created_at
        FROM webhook_events
        WHERE normalized_payload->'message'->>'chatId' = ${chatId}
          AND normalized_payload->'message'->>'senderId' IN (${Prisma.join(normalizedUserIds)})
      ) AS sender_rows
      WHERE sender_id IS NOT NULL AND sender_name IS NOT NULL
      ORDER BY sender_id, created_at DESC
    `;

    const byUserId = new Map<string, string>();
    for (const row of rows) {
      const userId = typeof row.user_id === 'string' ? row.user_id.trim() : '';
      const senderName = typeof row.sender_name === 'string' ? row.sender_name.trim() : '';
      if (!userId || !senderName || byUserId.has(userId)) {
        continue;
      }
      byUserId.set(userId, senderName);
    }

    return byUserId;
  }

  private activeDomainWhere(chatId: string) {
    const now = new Date();
    return {
      chatId,
      OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: now } }],
    };
  }

  private decodePathParam(value: string): string {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  private normalizeAllowlistLink(value: string): string | null {
    const raw = value.trim();
    if (!raw) {
      return null;
    }

    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    let parsed: URL;
    try {
      parsed = new URL(withScheme);
    } catch {
      return null;
    }

    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
      return null;
    }

    const hostname = parsed.hostname.toLowerCase();
    if (!hostname) {
      return null;
    }

    const shouldKeepPort =
      parsed.port.length > 0 &&
      !((protocol === 'https:' && parsed.port === '443') || (protocol === 'http:' && parsed.port === '80'));
    const port = shouldKeepPort ? `:${parsed.port}` : '';

    return `${hostname}${port}`.toLowerCase();
  }

  private async upsertNormalizedAllowlistDomain(chatId: string, normalizedDomain: string) {
    const rows = await this.prisma.domainAllowlist.findMany({
      where: {
        chatId,
      },
      select: {
        domain: true,
      },
    });

    const obsoleteDomains = rows
      .map((row: { domain: string }) => row.domain)
      .filter(
        (storedDomain) =>
          storedDomain !== normalizedDomain &&
          this.normalizeAllowlistLink(storedDomain) === normalizedDomain,
      );

    await this.prisma.domainAllowlist.upsert({
      where: {
        chatId_domain: {
          chatId,
          domain: normalizedDomain,
        },
      },
      create: {
        chatId,
        domain: normalizedDomain,
      },
      update: {
        removeAfterAt: null,
      },
    });

    if (obsoleteDomains.length === 0) {
      return;
    }

    await this.prisma.domainAllowlist.deleteMany({
      where: {
        chatId,
        domain: {
          in: obsoleteDomains,
        },
      },
    });
  }

  private async findStoredAllowlistDomains(chatId: string, normalizedDomain: string): Promise<string[]> {
    const rows = await this.prisma.domainAllowlist.findMany({
      where: {
        chatId,
      },
      select: {
        domain: true,
      },
    });

    return rows
      .map((row: { domain: string }) => row.domain)
      .filter((storedDomain) => this.normalizeAllowlistLink(storedDomain) === normalizedDomain);
  }

  private mapChannelDialogAuditLog(
    row: { id: string; actorUserId: string; payload: Prisma.JsonValue; createdAt: Date },
    fallbackType: ChannelDialogType,
  ) {
    const payload = this.readObjectPayload(row.payload);
    const rawType = this.readLowerString(payload.type);
    const type: ChannelDialogType =
      rawType === 'suggest' || rawType === 'comments' ? rawType : fallbackType;
    const authorDisplayName = this.readTrimmedString(payload.authorDisplayName);
    const text = this.readTrimmedString(payload.text) ?? '';
    const delivered = payload.delivered === true;
    const deliveredToUserId = this.readTrimmedString(payload.deliveredToUserId);

    return {
      id: row.id,
      type,
      text,
      authorUserId: row.actorUserId,
      authorDisplayName,
      createdAt: row.createdAt.toISOString(),
      ...(type === 'suggest' ? { delivered, deliveredToUserId: deliveredToUserId ?? null } : {}),
    };
  }

  private readObjectPayload(value: Prisma.JsonValue): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    return value as Record<string, unknown>;
  }

  private readTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private readLowerString(value: unknown): string | null {
    const normalized = this.readTrimmedString(value);
    return normalized ? normalized.toLowerCase() : null;
  }

  private async deliverSuggestionToAdminPrivate(
    chatId: string,
    user: AuthUser,
    text: string,
  ): Promise<{ delivered: boolean; deliveredToUserId: string | null }> {
    const adminIds = Array.from(
      new Set(
        (await this.maxClient.getChatAdminIds(chatId)).filter(
          (id) => id.trim().length > 0 && !this.isOwnBotUserId(id),
        ),
      ),
    );

    if (adminIds.length === 0) {
      return { delivered: false, deliveredToUserId: null };
    }

    const channelTitle = await this.resolveChannelTitle(chatId);
    const actorName = user.displayName?.trim() || user.username?.trim() || `user:${user.userId}`;
    const message = [
      'Новая предложка поста',
      '',
      `Канал: ${channelTitle}`,
      `Отправитель: ${actorName} (${user.userId})`,
      '',
      text,
    ].join('\n');

    for (const adminUserId of adminIds) {
      const privateChatId = await this.findLatestPrivateChatIdForUser(adminUserId);
      if (!privateChatId) {
        continue;
      }

      try {
        await this.maxClient.sendMessage(privateChatId, message, undefined, { immediate: true });
        return { delivered: true, deliveredToUserId: adminUserId };
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            adminUserId,
            privateChatId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to deliver suggestion to admin private chat',
        );
      }
    }

    return { delivered: false, deliveredToUserId: null };
  }

  private async findLatestPrivateChatIdForUser(userId: string): Promise<string | null> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return null;
    }

    const rows = await this.prisma.$queryRaw<Array<{ recipient_chat_id: string | null }>>`
      SELECT
        COALESCE(raw_payload->'message'->'recipient'->>'chat_id', raw_payload->'message'->>'chat_id') AS recipient_chat_id
      FROM webhook_events
      WHERE COALESCE(raw_payload->'message'->'sender'->>'user_id', raw_payload->'message'->>'sender_id') = ${normalizedUserId}
        AND COALESCE(raw_payload->'message'->'recipient'->>'chat_id', raw_payload->'message'->>'chat_id') ~ '^[0-9]+$'
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (!rows[0]?.recipient_chat_id) {
      return null;
    }

    return rows[0].recipient_chat_id.trim();
  }

  private async resolveChannelTitle(chatId: string): Promise<string> {
    const local = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { title: true },
    });
    if (local?.title?.trim()) {
      return local.title.trim();
    }

    const remote = await this.maxClient.getChatTitle(chatId);
    if (remote?.trim()) {
      return remote.trim();
    }

    return `Канал ${chatId}`;
  }

  private buildChannelDialogWebAppUrl(chatId: string, type: ChannelDialogType): string | null {
    const launchUrl = this.buildMiniappStartUrl(this.buildChannelDialogStartParam(chatId, type));
    if (launchUrl) {
      return launchUrl;
    }

    if (!this.appBaseUrl) {
      return null;
    }

    const token = this.buildChannelDialogToken(chatId, type);
    const encodedChatId = encodeURIComponent(chatId);
    return `${this.appBaseUrl}/app/channel/${encodedChatId}/dialog/${type}?token=${token}`;
  }

  private buildChannelDialogStartParam(chatId: string, type: ChannelDialogType): string {
    const token = this.buildChannelDialogToken(chatId, type);
    const payload = JSON.stringify({
      v: 1,
      k: 'channel-dialog',
      c: chatId,
      m: type,
      t: token,
    });
    const encoded = Buffer.from(payload, 'utf8').toString('base64url');
    return `${CHANNEL_DIALOG_START_PARAM_PREFIX}${encoded}`;
  }

  private buildMiniappStartUrl(startParam: string): string | null {
    if (!this.ownBotUserId) {
      return null;
    }

    return `https://max.ru/${encodeURIComponent(this.ownBotUserId)}?startapp=${encodeURIComponent(startParam)}`;
  }

  private buildChannelDialogToken(chatId: string, type: ChannelDialogType): string {
    return createHmac('sha256', this.maxBotToken).update(`dialog:${chatId}:${type}`).digest('hex');
  }

  private assertValidChannelDialogToken(
    chatId: string,
    type: ChannelDialogType,
    token: string | null | undefined,
  ): void {
    const normalizedToken = typeof token === 'string' ? token.trim().toLowerCase() : '';
    if (!/^[a-f0-9]{64}$/u.test(normalizedToken)) {
      throw new BadRequestException('Неверный токен кнопки. Откройте диалог заново из сообщения канала.');
    }

    const expected = this.buildChannelDialogToken(chatId, type);
    const isValid =
      normalizedToken.length === expected.length &&
      timingSafeEqual(Buffer.from(normalizedToken, 'hex'), Buffer.from(expected, 'hex'));

    if (!isValid) {
      throw new BadRequestException('Кнопка устарела. Откройте сообщение в канале и нажмите кнопку снова.');
    }
  }

  private normalizeAppBaseUrl(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().replace(/\/+$/, '');
    if (!normalized || !/^https?:\/\//iu.test(normalized)) {
      return null;
    }

    return normalized;
  }

  private normalizeOwnBotUserId(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private normalizeBotContactId(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    if (!normalized || !/^\d+$/u.test(normalized)) {
      return null;
    }

    return normalized;
  }

  private resolveBotContactId(): string | null {
    if (this.explicitBotContactId) {
      return this.explicitBotContactId;
    }

    if (!this.ownBotUserId) {
      return null;
    }

    const [candidate] = this.ownBotUserId.split('_');
    return /^\d+$/u.test(candidate) ? candidate : null;
  }

  private isOwnBotUserId(userId: string): boolean {
    if (!this.ownBotUserId) {
      return false;
    }

    const normalized = userId.trim();
    if (!normalized) {
      return false;
    }

    return normalized === this.ownBotUserId || normalized === this.ownBotUserId.split('_')[0];
  }

  private async mapWithConcurrencyLimit<T, R>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<R>,
  ): Promise<R[]> {
    if (items.length === 0) {
      return [];
    }

    const concurrency = Math.max(1, Math.min(limit, items.length));
    const results: R[] = new Array<R>(items.length);
    let currentIndex = 0;

    const runWorker = async () => {
      while (true) {
        const itemIndex = currentIndex;
        currentIndex += 1;

        if (itemIndex >= items.length) {
          return;
        }

        results[itemIndex] = await worker(items[itemIndex]);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
    return results;
  }

  private isFallbackTitle(chatId: string, title: string): boolean {
    const normalized = title.trim();
    return normalized === `Chat ${chatId}` || normalized === `Channel ${chatId}`;
  }

  private async hasUserAndBotAdminAccess(chatId: string, userId: string): Promise<boolean> {
    try {
      const adminIds = await this.maxClient.getChatAdminIds(chatId);
      return adminIds.includes(userId);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Chat hidden: failed to validate bot/user admin access',
      );
      return false;
    }
  }

  private async refreshChatTitle(chat: ChatSummary): Promise<void> {
    try {
      const refreshedTitle = await this.maxClient.getChatTitle(chat.id);
      if (!refreshedTitle) {
        return;
      }

      chat.title = refreshedTitle;
      await this.prisma.chat.update({
        where: { id: chat.id },
        data: {
          title: refreshedTitle,
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: chat.id,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to refresh chat title from MAX API',
      );
    }
  }

  private async listChatsFromAllowlist(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): Promise<ChatSummary[]> {
    const whereClause =
      entityType === 'all'
        ? { userId }
        : {
            userId,
            chat: {
              entityType: this.toPrismaEntityType(entityType),
            },
          };
    const rows = await this.prisma.chatAdminAllowlist.findMany({
      where: whereClause,
      include: { chat: true },
      orderBy: {
        chat: {
          createdAt: 'desc',
        },
      },
    });

    return rows.map((row: { chat: { id: string; title: string; createdAt: Date; entityType: ChatEntityType } }) => ({
      id: row.chat.id,
      title: row.chat.title,
      createdAt: row.chat.createdAt.toISOString(),
      entityType: this.fromPrismaEntityType(row.chat.entityType),
      link: null,
    }));
  }

  private async upsertUserChatAccess(
    chatId: string,
    userId: string,
    chatTitle: string | null,
    entityType: ManagedEntityType | null = null,
    options: { updateEntityType?: boolean } = {},
  ) {
    const normalizedTitle = chatTitle?.trim() ? chatTitle.trim() : null;
    const fallbackTitle = entityType === 'channel' ? `Channel ${chatId}` : `Chat ${chatId}`;
    const updateEntityType = options.updateEntityType === true;
    const persistedChat = await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: normalizedTitle ?? fallbackTitle,
        ...(entityType ? { entityType: this.toPrismaEntityType(entityType) } : {}),
      },
      update: {
        ...(normalizedTitle
          ? {
              title: normalizedTitle,
            }
          : {}),
        ...(updateEntityType && entityType
          ? { entityType: this.toPrismaEntityType(entityType) }
          : {}),
      },
    });

    await this.prisma.chatAdminAllowlist.upsert({
      where: {
        chatId_userId: {
          chatId,
          userId,
        },
      },
      create: {
        chatId,
        userId,
      },
      update: {},
    });

    return persistedChat;
  }

  private async bootstrapCurrentChat(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
  ): Promise<ChatSummary | null> {
    if (entityType === 'channel') {
      return null;
    }

    if (!user.chatId) {
      return null;
    }

    const hasAdminAccess = await this.hasUserAndBotAdminAccess(user.chatId, user.userId);
    if (!hasAdminAccess) {
      return null;
    }

    const persistedChat = await this.upsertUserChatAccess(
      user.chatId,
      user.userId,
      user.chatTitle ?? null,
      'chat',
    );

    const chat: ChatSummary = {
      id: user.chatId,
      title: persistedChat.title,
      createdAt: persistedChat.createdAt.toISOString(),
      entityType: this.fromPrismaEntityType(persistedChat.entityType),
      link: null,
    };

    if (this.isFallbackTitle(chat.id, chat.title)) {
      await this.refreshChatTitle(chat);
    }

    return chat;
  }

  private async ensureEntityType(
    chatId: string,
    userId: string,
    expectedEntityType: ManagedEntityType,
  ): Promise<void> {
    const current = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        entityType: true,
      },
    });

    if (current) {
      if (this.fromPrismaEntityType(current.entityType) !== expectedEntityType) {
        throw new BadRequestException(
          expectedEntityType === 'channel'
            ? 'Этот ID относится к чату, а не к каналу.'
            : 'Этот ID относится к каналу, а не к чату.',
        );
      }
      return;
    }

    try {
      const remoteChats = await this.maxClient.listBotChats();
      const discovered = remoteChats.find((item) => item.chatId === chatId);
      if (discovered && discovered.entityType !== expectedEntityType) {
        throw new BadRequestException(
          expectedEntityType === 'channel'
            ? 'Этот ID относится к чату, а не к каналу.'
            : 'Этот ID относится к каналу, а не к чату.',
        );
      }
    } catch (error: unknown) {
      if (error instanceof BadRequestException) {
        throw error;
      }
    }

    await this.upsertUserChatAccess(chatId, userId, null, expectedEntityType);
  }

  private toPrismaEntityType(entityType: ManagedEntityType): ChatEntityType {
    return entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
  }

  private fromPrismaEntityType(entityType: ChatEntityType): ManagedEntityType {
    return entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat';
  }
}
