import {
  addGlobalUserBlacklistRequestSchema,
  addDomainRequestSchema,
  addAdminRequestSchema,
  dateRangeQuerySchema,
  logsDashboardQuerySchema,
  logsDashboardResponseSchema,
  manualModerationActionRequestSchema,
  manualModerationActionResultSchema,
  type ChatSettings,
  chatSettingsSchema,
  type DomainAllowlistEntry,
  type GlobalUserBlacklistEntry,
  type LogsDashboardRange,
  type LogsDashboardResponse,
  type ManualModerationActionResult,
  type Me,
  type ModerationEvent,
  type SendBroadcastResult,
  type ChatSummary,
  sendBroadcastRequestSchema,
  scheduleDomainRemovalRequestSchema,
} from '@maxim/contracts';
import { EventType, Operator, Prisma, SanctionAction } from '@prisma/client';
import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { MaxClientService } from '../max/max-client.service';
import { ChatContextCacheService } from '../moderation/chat-context-cache.service';
import { PrismaService } from '../prisma/prisma.service';

type ApplySettingsToAllChatsResult = {
  sourceChatId: string;
  updatedChats: number;
  appliedChatIds: string[];
};

const BROADCAST_IMAGE_MAX_BYTES = 1_000_000;
const BROADCAST_MIN_DELAY_MS = 30_000;
const BROADCAST_MAX_DELAY_MS = 14 * 24 * 60 * 60 * 1000;
const BROADCAST_CYCLE_MAX_COUNT = 14;
const BROADCAST_DAY_MS = 24 * 60 * 60 * 1000;
const BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS = [1_500, 3_000, 6_000];
const LOGS_DASHBOARD_VIOLATIONS_LIMIT = 30;
const ONE_HOUR_MS = 60 * 60 * 1000;

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly chatContextCache: ChatContextCacheService,
  ) {}

  getMe(user: AuthUser): Me {
    return {
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
    };
  }

  async listChats(user: AuthUser): Promise<ChatSummary[]> {
    try {
      const remoteChats = await this.maxClient.listBotChats();
      const resolvedChats = await Promise.all(
        remoteChats.map(async (remoteChat) => {
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
          );

          const chat: ChatSummary = {
            id: persistedChat.id,
            title: persistedChat.title,
            createdAt: persistedChat.createdAt.toISOString(),
          };

          if (this.isFallbackTitle(chat.id, chat.title)) {
            await this.refreshChatTitle(chat);
          }

          return {
            chat,
            lastEventTime: remoteChat.lastEventTime ?? 0,
          };
        }),
      );

      const filtered = resolvedChats.filter(
        (item): item is { chat: ChatSummary; lastEventTime: number } => item !== null,
      );

      if (filtered.length > 0) {
        filtered.sort((a, b) => b.lastEventTime - a.lastEventTime);
        return filtered.map((item) => item.chat);
      }
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to auto-discover chats via MAX API',
      );
    }

    const cached = await this.listChatsFromAllowlist(user.userId);
    if (cached.length > 0) {
      return cached;
    }

    const bootstrapped = await this.bootstrapCurrentChat(user);
    return bootstrapped ? [bootstrapped] : [];
  }

  async getSettings(chatId: string, user: AuthUser): Promise<ChatSettings> {
    await this.assertChatAdmin(chatId, user.userId);

    const chat = await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: `Chat ${chatId}`,
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

  async updateSettings(chatId: string, user: AuthUser, body: unknown): Promise<ChatSettings> {
    await this.assertChatAdmin(chatId, user.userId);
    const parsed = chatSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: `Chat ${chatId}`,
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
        payload: parsed.data,
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return parsed.data;
  }

  async applySettingsToAllChats(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ApplySettingsToAllChatsResult> {
    await this.assertChatAdmin(sourceChatId, user.userId);
    const parsed = chatSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const availableChats = await this.listChats(user);
    const appliedChatIds = Array.from(
      new Set([sourceChatId, ...availableChats.map((chat) => chat.id)]),
    );

    for (const chatId of appliedChatIds) {
      await this.prisma.chat.upsert({
        where: { id: chatId },
        create: {
          id: chatId,
          title: `Chat ${chatId}`,
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
  ): Promise<SendBroadcastResult> {
    await this.assertChatAdmin(sourceChatId, user.userId);
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
      source: 'miniapp',
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
            reason: 'Manual kick from miniapp logs',
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
            reason: 'Manual temporary ban from miniapp logs',
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
          reason: 'Manual unban/restore from miniapp logs',
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

    return rows.map((row: { domain: string }) => row.domain);
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

    return rows.map((row: { domain: string; removeAfterAt: Date | null }) => ({
      domain: row.domain,
      removeAfterAt: row.removeAfterAt ? row.removeAfterAt.toISOString() : null,
    }));
  }

  async addDomain(chatId: string, user: AuthUser, body: unknown) {
    await this.assertChatAdmin(chatId, user.userId);
    const parsed = addDomainRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const normalized = parsed.data.domain.toLowerCase();

    await this.prisma.domainAllowlist.upsert({
      where: {
        chatId_domain: {
          chatId,
          domain: normalized,
        },
      },
      create: {
        chatId,
        domain: normalized,
      },
      update: {
        removeAfterAt: null,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'ADD_DOMAIN',
        payload: {
          domain: normalized,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async removeDomain(chatId: string, user: AuthUser, domain: string) {
    await this.assertChatAdmin(chatId, user.userId);
    const normalized = domain.toLowerCase();

    await this.prisma.domainAllowlist.delete({
      where: {
        chatId_domain: {
          chatId,
          domain: normalized,
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
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async scheduleDomainRemoval(chatId: string, user: AuthUser, domain: string, body: unknown) {
    await this.assertChatAdmin(chatId, user.userId);
    const normalizedDomain = domain.toLowerCase();
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

    await this.prisma.domainAllowlist.update({
      where: {
        chatId_domain: {
          chatId,
          domain: normalizedDomain,
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

  async addGlobalUserBlacklistUser(chatId: string, user: AuthUser, body: unknown) {
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
        },
      },
    });

    return { ok: true };
  }

  async removeGlobalUserBlacklistUser(chatId: string, user: AuthUser, targetUserId: string) {
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
        },
      },
    });

    return { ok: true };
  }

  async assertChatAdmin(chatId: string, userId: string) {
    const hasAdminAccess = await this.hasUserAndBotAdminAccess(chatId, userId);
    if (!hasAdminAccess) {
      throw new ForbiddenException('User is not chat admin');
    }

    await this.upsertUserChatAccess(chatId, userId, null);
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

  private isFallbackTitle(chatId: string, title: string): boolean {
    return title.trim() === `Chat ${chatId}`;
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

  private async listChatsFromAllowlist(userId: string): Promise<ChatSummary[]> {
    const rows = await this.prisma.chatAdminAllowlist.findMany({
      where: { userId },
      include: { chat: true },
      orderBy: {
        chat: {
          createdAt: 'desc',
        },
      },
    });

    return rows.map((row: { chat: { id: string; title: string; createdAt: Date } }) => ({
      id: row.chat.id,
      title: row.chat.title,
      createdAt: row.chat.createdAt.toISOString(),
    }));
  }

  private async upsertUserChatAccess(chatId: string, userId: string, chatTitle: string | null) {
    const normalizedTitle = chatTitle?.trim() ? chatTitle.trim() : null;
    const persistedChat = await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: normalizedTitle ?? `Chat ${chatId}`,
      },
      update: {
        ...(normalizedTitle
          ? {
              title: normalizedTitle,
            }
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

  private async bootstrapCurrentChat(user: AuthUser): Promise<ChatSummary | null> {
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
    );

    const chat: ChatSummary = {
      id: user.chatId,
      title: persistedChat.title,
      createdAt: persistedChat.createdAt.toISOString(),
    };

    if (this.isFallbackTitle(chat.id, chat.title)) {
      await this.refreshChatTitle(chat);
    }

    return chat;
  }
}
