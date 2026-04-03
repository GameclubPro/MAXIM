import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ChatBotMembershipStatus, ChatEntityType, Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_API_SOURCE_TAGS, MaxClientService, type MaxBotChat } from './max-client.service';
import { MaxBotLinkService } from './max-bot-link.service';
import { MaxBotRegistryService } from './max-bot-registry.service';
import {
  MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE,
  type MaxChatAdminRosterSyncJob,
} from './max-chat-admin-roster-sync.queue';

const CHAT_ADMIN_ROSTER_SYNC_TIMEOUT_MS = 2_500;
const CHAT_ADMIN_ROSTER_SYNC_ACTION_HEALTH_LANE = 'background';
const CHAT_ADMIN_ROSTER_SCHEDULE_CONCURRENCY = 8;

@Injectable()
export class MaxChatAdminRosterSyncService {
  private readonly logger = new Logger(MaxChatAdminRosterSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly maxBotRegistry: MaxBotRegistryService,
    private readonly chatContextCache: ChatContextCacheService,
    @Optional()
    @InjectQueue(MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE)
    private readonly queue?: Queue<MaxChatAdminRosterSyncJob>,
  ) {}

  async scheduleDiscoverySnapshotSync(chats: readonly MaxBotChat[]): Promise<void> {
    await this.mapWithConcurrencyLimit([...chats], CHAT_ADMIN_ROSTER_SCHEDULE_CONCURRENCY, async (chat) =>
      this.scheduleChatAdminRosterSync({
        chatId: chat.chatId,
        botIds: chat.botIds ?? (chat.botId ? [chat.botId] : []),
        title: chat.title,
        entityType: chat.entityType,
      }),
    );
  }

  async scheduleChatAdminRosterSync(params: MaxChatAdminRosterSyncJob): Promise<boolean> {
    if (!this.queue) {
      return false;
    }

    const desiredJobData = this.normalizeJobData(params);
    if (!desiredJobData) {
      return false;
    }

    const jobId = this.buildJobId(desiredJobData.chatId);

    try {
      const existing = await this.queue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        const existingData = this.normalizeJobData(existing.data);
        if (state !== 'failed' && state !== 'completed') {
          if (existingData && this.areJobDataEqual(existingData, desiredJobData)) {
            return true;
          }
          if (state === 'waiting' || state === 'delayed') {
            await existing.remove();
          } else {
            return true;
          }
        } else {
          await existing.remove();
        }
      }

      await this.queue.add('sync-chat-admin-roster', desiredJobData, {
        jobId,
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: false,
        backoff: {
          type: 'exponential',
          delay: 1_000,
        },
      });
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('job') && message.toLowerCase().includes('exists')) {
        return true;
      }

      this.logger.warn(
        {
          chatId: desiredJobData.chatId,
          botIds: desiredJobData.botIds,
          err: message,
        },
        'Failed to enqueue chat admin roster sync job',
      );
      return false;
    }
  }

  async processJob(job: MaxChatAdminRosterSyncJob): Promise<boolean> {
    return this.syncChatAdminRoster(job);
  }

  async backfillManagedEntitiesIndex(options: { bypassCache?: boolean } = {}): Promise<{
    discoveredChats: number;
    syncedChats: number;
  }> {
    const mergedByChatId = new Map<string, MaxChatAdminRosterSyncJob>();

    for (const bot of this.maxBotRegistry.getDiscoveryBots()) {
      const chats = await this.maxClient.listBotChats({
        trafficClass: 'background',
        actionHealthLane: CHAT_ADMIN_ROSTER_SYNC_ACTION_HEALTH_LANE,
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
        timeoutMs: CHAT_ADMIN_ROSTER_SYNC_TIMEOUT_MS,
        ...(options.bypassCache === true ? { bypassCache: true } : {}),
        botId: bot.id,
      });

      for (const chat of chats) {
        const existing = mergedByChatId.get(chat.chatId);
        const nextBotIds = Array.from(
          new Set([
            ...(existing?.botIds ?? []),
            ...(chat.botIds ?? []),
            ...(chat.botId ? [chat.botId] : []),
          ]),
        );
        mergedByChatId.set(chat.chatId, {
          chatId: chat.chatId,
          botIds: nextBotIds,
          title: existing?.title ?? chat.title,
          entityType: existing?.entityType ?? chat.entityType,
        });
      }
    }

    let syncedChats = 0;
    for (const job of mergedByChatId.values()) {
      if (await this.syncChatAdminRoster(job)) {
        syncedChats += 1;
      }
    }

    return {
      discoveredChats: mergedByChatId.size,
      syncedChats,
    };
  }

  private async syncChatAdminRoster(job: MaxChatAdminRosterSyncJob): Promise<boolean> {
    const normalized = await this.buildMergedJobData(job);
    if (!normalized) {
      return false;
    }

    await this.persistCatalogBinding(normalized);

    const candidateBotIds = await this.resolveCandidateBotIds(normalized);
    let recoverableError: unknown = null;

    for (const botId of candidateBotIds) {
      try {
        const access = await this.maxClient.getCurrentChatMemberAccess(normalized.chatId, {
          botId,
          trafficClass: 'background',
          actionHealthLane: CHAT_ADMIN_ROSTER_SYNC_ACTION_HEALTH_LANE,
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
          timeoutMs: CHAT_ADMIN_ROSTER_SYNC_TIMEOUT_MS,
        });
        await this.persistBotSelfAccessSnapshot(normalized.chatId, botId, access);

        if (!access.isAdmin && !access.isOwner) {
          continue;
        }

        const adminUserIds = await this.maxClient.getChatAdminIds(normalized.chatId, {
          botId,
          trafficClass: 'background',
          actionHealthLane: CHAT_ADMIN_ROSTER_SYNC_ACTION_HEALTH_LANE,
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
          timeoutMs: CHAT_ADMIN_ROSTER_SYNC_TIMEOUT_MS,
        });
        await this.syncAllowlist(normalized.chatId, adminUserIds);
        return true;
      } catch (error: unknown) {
        if (this.isChatAccessDeniedError(error)) {
          await this.persistBotSelfAccessSnapshot(normalized.chatId, botId, null);
          continue;
        }

        recoverableError ??= error;
      }
    }

    if (recoverableError) {
      throw recoverableError;
    }

    await this.clearAllowlist(normalized.chatId, 'bot_denied');
    return false;
  }

  private async buildMergedJobData(
    params: MaxChatAdminRosterSyncJob,
  ): Promise<MaxChatAdminRosterSyncJob | null> {
    const incoming = this.normalizeJobData(params);
    if (!incoming) {
      return null;
    }

    const persisted = await this.prisma.chat.findUnique({
      where: { id: incoming.chatId },
      select: {
        title: true,
        entityType: true,
        primaryBotId: true,
        botId: true,
        botMemberships: {
          where: {
            status: ChatBotMembershipStatus.ACTIVE,
          },
          select: {
            botId: true,
          },
        },
      },
    });

    const mergedBotIds = Array.from(
      new Set(
        [
          ...(incoming.botIds ?? []),
          this.readTrimmedString(persisted?.primaryBotId),
          this.readTrimmedString(persisted?.botId),
          ...((persisted?.botMemberships ?? []).map((membership) =>
            this.readTrimmedString(membership.botId),
          ) as Array<string | null>),
        ].filter((botId): botId is string => Boolean(botId)),
      ),
    );

    return {
      chatId: incoming.chatId,
      botIds: mergedBotIds,
      title: incoming.title ?? this.readTrimmedString(persisted?.title) ?? null,
      entityType: incoming.entityType ?? this.fromPrismaEntityType(persisted?.entityType),
    };
  }

  private normalizeJobData(
    params: MaxChatAdminRosterSyncJob | null | undefined,
  ): MaxChatAdminRosterSyncJob | null {
    const chatId = this.readTrimmedString(params?.chatId);
    if (!chatId) {
      return null;
    }

    const botIds = Array.from(
      new Set(
        (params?.botIds ?? [])
          .map((botId) => this.maxBotRegistry.getBotById(botId)?.id ?? null)
          .filter((botId): botId is string => Boolean(botId)),
      ),
    );
    const entityType = params?.entityType === 'channel' ? 'channel' : params?.entityType === 'chat' ? 'chat' : null;

    return {
      chatId,
      botIds,
      title: this.readTrimmedString(params?.title) ?? null,
      entityType,
    };
  }

  private areJobDataEqual(
    left: MaxChatAdminRosterSyncJob,
    right: MaxChatAdminRosterSyncJob,
  ): boolean {
    return (
      left.chatId === right.chatId &&
      (left.title ?? null) === (right.title ?? null) &&
      (left.entityType ?? null) === (right.entityType ?? null) &&
      left.botIds?.length === right.botIds?.length &&
      (left.botIds ?? []).every((botId, index) => botId === (right.botIds ?? [])[index])
    );
  }

  private buildJobId(chatId: string): string {
    return `chat-admin-roster-sync__${chatId}`;
  }

  private async resolveCandidateBotIds(job: MaxChatAdminRosterSyncJob): Promise<string[]> {
    const resolved = new Set(
      (job.botIds ?? [])
        .map((botId) => this.maxBotRegistry.getBotById(botId)?.id ?? null)
        .filter((botId): botId is string => Boolean(botId)),
    );

    if (resolved.size === 0) {
      const persisted = await this.prisma.chat.findUnique({
        where: { id: job.chatId },
        select: {
          primaryBotId: true,
          botId: true,
          botMemberships: {
            where: {
              status: ChatBotMembershipStatus.ACTIVE,
            },
            select: {
              botId: true,
            },
          },
        },
      });

      for (const botId of [
        this.readTrimmedString(persisted?.primaryBotId),
        this.readTrimmedString(persisted?.botId),
        ...((persisted?.botMemberships ?? []).map((membership) =>
          this.readTrimmedString(membership.botId),
        ) as Array<string | null>),
      ]) {
        const normalizedBotId = this.maxBotRegistry.getBotById(botId)?.id ?? null;
        if (normalizedBotId) {
          resolved.add(normalizedBotId);
        }
      }
    }

    if (resolved.size === 0) {
      for (const bot of this.maxBotRegistry.getDiscoveryBots()) {
        resolved.add(bot.id);
      }
    }

    return [...resolved];
  }

  private async persistCatalogBinding(job: MaxChatAdminRosterSyncJob): Promise<void> {
    const entityType = this.toPrismaEntityType(job.entityType);
    if (
      !entityType &&
      !this.readTrimmedString(job.title) &&
      (job.botIds?.length ?? 0) === 0
    ) {
      return;
    }

    try {
      await this.maxBotLinkService.bindDiscoveredChatBots({
        chatId: job.chatId,
        primaryBotId: job.botIds?.[0] ?? null,
        botIds: job.botIds ?? [],
        title: job.title ?? null,
        entityType,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: job.chatId,
          botIds: job.botIds,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist discovered chat catalog binding before admin roster sync',
      );
    }
  }

  private async syncAllowlist(chatId: string, adminUserIds: readonly string[]): Promise<void> {
    const normalizedAdminUserIds = Array.from(
      new Set(
        adminUserIds
          .map((userId) => this.readTrimmedString(userId))
          .filter((userId): userId is string => Boolean(userId)),
      ),
    );
    const existingRows = await this.prisma.chatAdminAllowlist.findMany({
      where: {
        chatId,
      },
      select: {
        userId: true,
      },
    });
    const existingUserIds = new Set(
      existingRows
        .map((row) => this.readTrimmedString(row.userId))
        .filter((userId): userId is string => Boolean(userId)),
    );
    const nextUserIds = new Set(normalizedAdminUserIds);
    const usersToAdd = normalizedAdminUserIds.filter((userId) => !existingUserIds.has(userId));
    const usersToRemove = [...existingUserIds].filter((userId) => !nextUserIds.has(userId));

    if (usersToAdd.length > 0) {
      if (typeof this.prisma.chatAdminAllowlist.createMany === 'function') {
        await this.prisma.chatAdminAllowlist.createMany({
          data: usersToAdd.map((userId) => ({
            chatId,
            userId,
          })),
          skipDuplicates: true,
        });
      } else {
        await Promise.all(
          usersToAdd.map((userId) =>
            this.prisma.chatAdminAllowlist.upsert({
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
            }),
          ),
        );
      }
    }

    if (usersToRemove.length > 0) {
      await this.prisma.chatAdminAllowlist.deleteMany({
        where: {
          chatId,
          userId: {
            in: usersToRemove,
          },
        },
      });
    }

    await this.chatContextCache.replaceChatAdminUsers(chatId, normalizedAdminUserIds);

    await Promise.all(
      normalizedAdminUserIds.map((userId) =>
        this.chatContextCache.setAdminAccess(chatId, userId, 'granted'),
      ),
    );
    await Promise.all(
      usersToRemove.map((userId) =>
        this.chatContextCache.setAdminAccess(chatId, userId, 'user_denied'),
      ),
    );
  }

  private async clearAllowlist(
    chatId: string,
    deniedState: 'user_denied' | 'bot_denied',
  ): Promise<void> {
    const existingRows = await this.prisma.chatAdminAllowlist.findMany({
      where: {
        chatId,
      },
      select: {
        userId: true,
      },
    });
    const existingUserIds = Array.from(
      new Set(
        existingRows
          .map((row) => this.readTrimmedString(row.userId))
          .filter((userId): userId is string => Boolean(userId)),
      ),
    );

    if (existingUserIds.length > 0) {
      await this.prisma.chatAdminAllowlist.deleteMany({
        where: {
          chatId,
          userId: {
            in: existingUserIds,
          },
        },
      });
    }

    await this.chatContextCache.replaceChatAdminUsers(chatId, []);
    await Promise.all(
      existingUserIds.map((userId) =>
        this.chatContextCache.setAdminAccess(chatId, userId, deniedState),
      ),
    );
  }

  private async persistBotSelfAccessSnapshot(
    chatId: string,
    botId: string,
    access:
      | {
          isAdmin: boolean;
          isOwner: boolean;
          permissions?: readonly string[];
        }
      | null,
  ): Promise<void> {
    try {
      await this.prisma.chatBotMembership.updateMany({
        where: {
          chatId,
          botId,
        },
        data: {
          lastSeenAt: new Date(),
          permissionsSnapshot: {
            checkedAt: new Date().toISOString(),
            isAdmin: access?.isAdmin === true,
            isOwner: access?.isOwner === true,
            permissions: Array.from(
              new Set(
                (access?.permissions ?? [])
                  .map((permission) => permission.trim())
                  .filter((permission) => permission.length > 0),
              ),
            ),
          } satisfies Prisma.InputJsonValue,
        },
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist bot self access snapshot during chat admin roster sync',
      );
    }
  }

  private isChatAccessDeniedError(error: unknown): boolean {
    const status = (error as { response?: { status?: number } } | null)?.response?.status;
    const code = (error as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;
    const normalizedCode = typeof code === 'string' ? code.trim().toLowerCase() : null;
    const message =
      (error as { response?: { data?: { message?: unknown } } } | null)?.response?.data?.message;
    const normalizedMessage =
      typeof message === 'string'
        ? message.trim().toLowerCase()
        : error instanceof Error
          ? error.message.trim().toLowerCase()
          : String(error).trim().toLowerCase();

    if (normalizedCode === 'chat.denied' || normalizedCode === 'chat.not.found') {
      return true;
    }

    if (status !== 400 && status !== 403 && status !== 404) {
      return false;
    }

    return (
      normalizedMessage.includes('chat administrator') ||
      normalizedMessage.includes('bot is not a chat member') ||
      normalizedMessage.includes('chat not found') ||
      normalizedMessage.includes('forbidden')
    );
  }

  private toPrismaEntityType(entityType?: 'chat' | 'channel' | null): ChatEntityType | null {
    if (entityType === 'channel') {
      return ChatEntityType.CHANNEL;
    }
    if (entityType === 'chat') {
      return ChatEntityType.CHAT;
    }
    return null;
  }

  private fromPrismaEntityType(
    entityType: ChatEntityType | null | undefined,
  ): 'chat' | 'channel' | null {
    if (entityType === ChatEntityType.CHANNEL) {
      return 'channel';
    }
    if (entityType === ChatEntityType.CHAT) {
      return 'chat';
    }
    return null;
  }

  private readTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private async mapWithConcurrencyLimit<T, R>(
    items: readonly T[],
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
        const index = currentIndex;
        currentIndex += 1;
        if (index >= items.length) {
          return;
        }

        results[index] = await worker(items[index]);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
    return results;
  }
}
