import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import type { ChatSummary, ManagedEntityType } from '@maxim/contracts';
import { ChatBotMembershipStatus, ChatEntityType, Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import {
  ChatContextCacheService,
  type ManagedEntitiesPublishedSnapshot,
} from '../chat-context/chat-context-cache.service';
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
const CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_ATTEMPTS = 20;
const CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_BACKOFF_DELAY_MS = 2_000;
const MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_TTL_SEC = 7 * 24 * 60 * 60;
const MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_PATCH_CONCURRENCY = 8;

class PendingBotAdminGrantError extends Error {
  constructor(readonly chatId: string) {
    super(`Bot admin access for chat ${chatId} is still propagating`);
  }
}

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
        source: 'discovery_snapshot',
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
        attempts:
          desiredJobData.source === 'webhook_bot_added'
            ? CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_ATTEMPTS
            : 5,
        removeOnComplete: true,
        removeOnFail: false,
        backoff:
          desiredJobData.source === 'webhook_bot_added'
            ? {
                type: 'fixed',
                delay: CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_BACKOFF_DELAY_MS,
              }
            : {
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
        await this.syncAllowlist(normalized, adminUserIds);
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

    if (this.shouldRetryPendingAdminGrant(normalized)) {
      this.logger.log(
        {
          chatId: normalized.chatId,
          botIds: normalized.botIds,
          retryUntilMs: normalized.retryUntilMs ?? null,
          source: normalized.source ?? null,
        },
        'Retrying chat admin roster sync while fresh bot_added admin rights propagate',
      );
      throw new PendingBotAdminGrantError(normalized.chatId);
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
      source: incoming.source ?? null,
      retryUntilMs: incoming.retryUntilMs ?? null,
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
    const source =
      params?.source === 'webhook_bot_added' ||
      params?.source === 'webhook_bot_removed' ||
      params?.source === 'webhook_chat_title_changed' ||
      params?.source === 'discovery_snapshot'
        ? params.source
        : null;
    const retryUntilMs =
      typeof params?.retryUntilMs === 'number' && Number.isFinite(params.retryUntilMs)
        ? Math.max(0, Math.trunc(params.retryUntilMs))
        : null;

    return {
      chatId,
      botIds,
      title: this.readTrimmedString(params?.title) ?? null,
      entityType,
      source,
      retryUntilMs,
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
      (left.source ?? null) === (right.source ?? null) &&
      (left.retryUntilMs ?? null) === (right.retryUntilMs ?? null) &&
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

  private async syncAllowlist(
    job: MaxChatAdminRosterSyncJob,
    adminUserIds: readonly string[],
  ): Promise<void> {
    const chatId = job.chatId;
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

    await this.patchManagedEntitiesPublishedSnapshots({
      chatId,
      entityTypeHint: job.entityType ?? null,
      titleHint: job.title ?? null,
      userIdsToUpsert: normalizedAdminUserIds,
      userIdsToRemove: usersToRemove,
    });
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

    await this.patchManagedEntitiesPublishedSnapshots({
      chatId,
      entityTypeHint: null,
      titleHint: null,
      userIdsToUpsert: [],
      userIdsToRemove: existingUserIds,
    });
  }

  private shouldRetryPendingAdminGrant(job: MaxChatAdminRosterSyncJob): boolean {
    return (
      job.source === 'webhook_bot_added' &&
      typeof job.retryUntilMs === 'number' &&
      Number.isFinite(job.retryUntilMs) &&
      job.retryUntilMs > Date.now()
    );
  }

  private async patchManagedEntitiesPublishedSnapshots(params: {
    chatId: string;
    entityTypeHint: ManagedEntityType | null;
    titleHint: string | null;
    userIdsToUpsert: readonly string[];
    userIdsToRemove: readonly string[];
  }): Promise<void> {
    const upsertUserIds = Array.from(
      new Set(
        params.userIdsToUpsert
          .map((userId) => this.readTrimmedString(userId))
          .filter((userId): userId is string => Boolean(userId)),
      ),
    );
    const removeUserIds = Array.from(
      new Set(
        params.userIdsToRemove
          .map((userId) => this.readTrimmedString(userId))
          .filter((userId): userId is string => Boolean(userId)),
      ),
    );
    if (upsertUserIds.length === 0 && removeUserIds.length === 0) {
      return;
    }

    const snapshotChat = await this.loadManagedEntitySnapshotPatchChat(
      params.chatId,
      params.entityTypeHint,
      params.titleHint,
    );
    const entityType = snapshotChat?.entityType ?? params.entityTypeHint;
    if (!entityType) {
      return;
    }

    const summary = snapshotChat
      ? await this.buildManagedEntitySnapshotPatchSummary(snapshotChat)
      : null;

    if (summary) {
      await this.mapWithConcurrencyLimit(
        upsertUserIds,
        MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_PATCH_CONCURRENCY,
        async (userId) => {
          await this.upsertManagedEntitiesPublishedSnapshotItem(userId, summary);
          return null;
        },
      );
    }

    await this.mapWithConcurrencyLimit(
      removeUserIds,
      MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_PATCH_CONCURRENCY,
      async (userId) => {
        await this.removeManagedEntitiesPublishedSnapshotItem(userId, entityType, params.chatId);
        return null;
      },
    );
  }

  private async loadManagedEntitySnapshotPatchChat(
    chatId: string,
    entityTypeHint: ManagedEntityType | null,
    titleHint: string | null,
  ): Promise<{
    id: string;
    title: string;
    createdAt: string;
    entityType: ManagedEntityType;
    primaryBotId: string | null;
    link: string | null;
    avatarUrl: string | null;
  } | null> {
    const persisted = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        id: true,
        title: true,
        createdAt: true,
        entityType: true,
        primaryBotId: true,
        botId: true,
      },
    });

    const entityType =
      this.fromPrismaEntityType(persisted?.entityType) ?? entityTypeHint ?? null;
    if (!entityType) {
      return null;
    }

    const cachedHeader = await this.chatContextCache.getManagedEntityHeader(chatId, entityType);
    const title =
      this.readTrimmedString(cachedHeader?.title) ??
      this.readTrimmedString(titleHint) ??
      this.readTrimmedString(persisted?.title) ??
      (entityType === 'channel' ? `Channel ${chatId}` : `Chat ${chatId}`);

    return {
      id: chatId,
      title,
      createdAt: persisted?.createdAt?.toISOString() ?? new Date().toISOString(),
      entityType,
      primaryBotId:
        this.readTrimmedString(persisted?.primaryBotId) ??
        this.readTrimmedString(persisted?.botId) ??
        null,
      link: this.readTrimmedString(cachedHeader?.link) ?? null,
      avatarUrl: this.readTrimmedString(cachedHeader?.avatarUrl) ?? null,
    };
  }

  private async buildManagedEntitySnapshotPatchSummary(params: {
    id: string;
    title: string;
    createdAt: string;
    entityType: ManagedEntityType;
    primaryBotId: string | null;
    link: string | null;
    avatarUrl: string | null;
  }): Promise<ChatSummary> {
    return {
      id: params.id,
      title: params.title,
      createdAt: params.createdAt,
      entityType: params.entityType,
      link: params.link,
      ...(params.avatarUrl ? { avatarUrl: params.avatarUrl } : {}),
      channelOverview: null,
      primaryBotId: params.primaryBotId,
      assignedBots: [],
      sharedMode: 'owned',
    };
  }

  private async upsertManagedEntitiesPublishedSnapshotItem(
    userId: string,
    summary: ChatSummary,
  ): Promise<void> {
    const currentSnapshot = await this.chatContextCache.getManagedEntitiesPublishedSnapshot(
      userId,
      summary.entityType,
    );
    if (!currentSnapshot) {
      return;
    }

    const nextItems = currentSnapshot.items.map((item) => this.cloneManagedEntitySummary(item));
    const existingIndex = nextItems.findIndex((item) => item.id === summary.id);
    let changed = false;

    if (existingIndex < 0) {
      nextItems.unshift(this.cloneManagedEntitySummary(summary));
      changed = true;
    } else {
      const existing = nextItems[existingIndex];
      const mergedTitle =
        this.isFallbackTitle(summary.id, existing.title) && !this.isFallbackTitle(summary.id, summary.title)
          ? summary.title
          : existing.title;
      const mergedLink = existing.link ?? summary.link ?? null;
      const mergedAvatarUrl = existing.avatarUrl ?? summary.avatarUrl;
      const mergedPrimaryBotId = existing.primaryBotId ?? summary.primaryBotId ?? null;

      if (
        mergedTitle !== existing.title ||
        mergedLink !== (existing.link ?? null) ||
        mergedAvatarUrl !== existing.avatarUrl ||
        mergedPrimaryBotId !== (existing.primaryBotId ?? null)
      ) {
        nextItems[existingIndex] = {
          ...existing,
          title: mergedTitle,
          link: mergedLink,
          ...(mergedAvatarUrl ? { avatarUrl: mergedAvatarUrl } : {}),
          primaryBotId: mergedPrimaryBotId,
        };
        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    await this.writeManagedEntitiesPublishedSnapshot(userId, summary.entityType, currentSnapshot, nextItems);
  }

  private async removeManagedEntitiesPublishedSnapshotItem(
    userId: string,
    entityType: ManagedEntityType,
    chatId: string,
  ): Promise<void> {
    const currentSnapshot = await this.chatContextCache.getManagedEntitiesPublishedSnapshot(
      userId,
      entityType,
    );
    if (!currentSnapshot) {
      return;
    }

    const nextItems = currentSnapshot.items.filter((item) => item.id !== chatId);
    if (nextItems.length === currentSnapshot.items.length) {
      return;
    }

    await this.writeManagedEntitiesPublishedSnapshot(userId, entityType, currentSnapshot, nextItems);
  }

  private async writeManagedEntitiesPublishedSnapshot(
    userId: string,
    entityType: ManagedEntityType,
    currentSnapshot: ManagedEntitiesPublishedSnapshot,
    items: readonly ChatSummary[],
  ): Promise<void> {
    const nextSnapshot: ManagedEntitiesPublishedSnapshot = {
      version: randomUUID(),
      builtAt: new Date().toISOString(),
      lastSyncedAt: currentSnapshot.lastSyncedAt,
      itemCount: items.length,
      itemsHash: this.buildManagedEntitiesPublishedSnapshotHash(items, currentSnapshot.lastSyncedAt),
      items: items.map((item) => this.cloneManagedEntitySummary(item)),
    };
    await this.chatContextCache.setManagedEntitiesPublishedSnapshot(
      userId,
      entityType,
      nextSnapshot,
      MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_TTL_SEC,
    );
  }

  private buildManagedEntitiesPublishedSnapshotHash(
    items: readonly ChatSummary[],
    lastSyncedAt: string | null,
  ): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          lastSyncedAt,
          items: items.map((item) => this.serializeManagedEntitySummary(item)),
        }),
      )
      .digest('hex');
  }

  private serializeManagedEntitySummary(item: ChatSummary): Record<string, unknown> {
    return {
      id: item.id,
      title: item.title,
      createdAt: item.createdAt,
      entityType: item.entityType,
      link: item.link ?? null,
      avatarUrl: this.readTrimmedString(item.avatarUrl) ?? null,
      channelOverview: item.channelOverview
        ? {
            enabledScenariosCount: item.channelOverview.enabledScenariosCount,
            commentsEnabled: item.channelOverview.commentsEnabled,
            postSuggestionsEnabled: item.channelOverview.postSuggestionsEnabled,
            commentsModerationEnabled: item.channelOverview.commentsModerationEnabled,
          }
        : null,
      primaryBotId: item.primaryBotId ?? null,
      assignedBots: (item.assignedBots ?? []).map((bot) => ({
        botId: bot.botId,
        label: bot.label,
        role: bot.role,
        membershipStatus: bot.membershipStatus,
        lifecycleState: bot.lifecycleState,
        speechPersona: bot.speechPersona,
        characterName: bot.characterName ?? null,
        avatarUrl: bot.avatarUrl ?? null,
        capabilities: [...bot.capabilities],
        permissionsSummary: bot.permissionsSummary
          ? {
              checkedAt: bot.permissionsSummary.checkedAt ?? null,
              isAdmin: bot.permissionsSummary.isAdmin,
              isOwner: bot.permissionsSummary.isOwner,
              permissions: [...bot.permissionsSummary.permissions],
            }
          : null,
      })),
      sharedMode: item.sharedMode,
    };
  }

  private cloneManagedEntitySummary(item: ChatSummary): ChatSummary {
    return {
      ...item,
      channelOverview: item.channelOverview ? { ...item.channelOverview } : null,
      assignedBots: Array.isArray(item.assignedBots)
        ? item.assignedBots.map((bot) => ({ ...bot }))
        : [],
    };
  }

  private isFallbackTitle(chatId: string, title: string): boolean {
    const normalized = title.trim();
    return normalized === `Chat ${chatId}` || normalized === `Channel ${chatId}`;
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
