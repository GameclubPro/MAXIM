import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import type { ChatSummary, ManagedEntityType } from '@maxim/contracts';
import { ChatBotMembershipStatus, ChatCatalogKind, ChatEntityType } from '../prisma/prisma-client';
import type { Queue } from 'bullmq';
import {
  ChatContextCacheService,
  type ManagedEntitiesPublishedSnapshot,
} from '../chat-context/chat-context-cache.service';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import { NightModeTransitionSchedulerService } from '../moderation/night-mode-transition-scheduler.service';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_API_SOURCE_TAGS, MaxClientService, type MaxBotChat } from './max-client.service';
import { MaxBotLinkService } from './max-bot-link.service';
import { MaxBotRegistryService } from './max-bot-registry.service';
import { canDiscoverChatsForBotState } from './max-bot-state.util';
import { buildBotAccessSnapshotPersistence } from './bot-access-snapshot.util';
import {
  MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE,
  type MaxChatAdminRosterSyncJob,
} from './max-chat-admin-roster-sync.queue';

const CHAT_ADMIN_ROSTER_SYNC_TIMEOUT_MS = 2_500;
const CHAT_ADMIN_ROSTER_SYNC_FAST_LANE_TIMEOUT_MS = 1_500;
const CHAT_ADMIN_ROSTER_SYNC_ACTION_HEALTH_LANE = 'background';
const CHAT_ADMIN_ROSTER_DISCOVERY_SCHEDULE_CONCURRENCY = 4;
const CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_ATTEMPTS = 8;
const CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_INITIAL_DELAY_MS = 5_000;
const CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_INITIAL_JITTER_MS = 5_000;
const CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_BACKOFF_DELAY_MS = 5_000;
const CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_RETRY_UNTIL_TOLERANCE_MS = 10_000;
const CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_MEMBERSHIP_CHURN_ATTEMPTS = 6;
const CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_MEMBERSHIP_CHURN_BACKOFF_DELAY_MS = 3_000;
const CHAT_ADMIN_ROSTER_SYNC_DEFAULT_PRIORITY = 10;
const CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_PRIORITY = 1;
const CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_MEMBERSHIP_CHURN_PRIORITY = 2;
const CHAT_ADMIN_ROSTER_SYNC_SOURCE_BACKOFF_MS = 10_000;
const CHAT_ADMIN_ROSTER_SYNC_SOURCE_BACKOFF_JITTER_MS = 5_000;
const CHAT_ADMIN_ROSTER_SYNC_TERMINAL_BOT_BACKOFF_MS = 5 * 60 * 1_000;
const MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_TTL_SEC = 7 * 24 * 60 * 60;
const MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_PATCH_CONCURRENCY = 8;
const MANAGED_ENTITY_ACCESS_EDGE_GRANTED_TTL_MS = 3 * 24 * 60 * 60 * 1_000;

type ManagedEntityAccessRoleValue = 'OWNER' | 'ADMIN' | 'MEMBER' | 'UNKNOWN';
type ManagedEntityAccessEdgeClient = {
  upsert?: (args: unknown) => Promise<unknown>;
  updateMany?: (args: unknown) => Promise<unknown>;
};
type ResolvedRosterCandidates = {
  botIds: string[];
  completeEnoughForGlobalDeny: boolean;
};

class PendingBotAdminGrantError extends Error {
  constructor(readonly chatId: string) {
    super(`Bot admin access for chat ${chatId} is still propagating`);
  }
}

export class MaxChatAdminRosterSyncSourceBackoffError extends Error {
  constructor(
    readonly chatId: string,
    readonly delayMs: number,
  ) {
    super('MAX API managed_refresh source backoff active');
    this.name = 'MaxChatAdminRosterSyncSourceBackoffError';
  }
}

@Injectable()
export class MaxChatAdminRosterSyncService {
  private readonly logger = new Logger(MaxChatAdminRosterSyncService.name);
  private managedRefreshSourceBackoffUntilMs = 0;
  private readonly terminalBotBackoffUntilMs = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly maxBotRegistry: MaxBotRegistryService,
    private readonly chatContextCache: ChatContextCacheService,
    @Optional()
    @InjectQueue(MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE)
    private readonly queue?: Queue<MaxChatAdminRosterSyncJob>,
    @Optional()
    private readonly nightModeTransitionScheduler?: NightModeTransitionSchedulerService,
  ) {}

  async scheduleDiscoverySnapshotSync(chats: readonly MaxBotChat[]): Promise<void> {
    await this.mapWithConcurrencyLimit(
      [...chats],
      CHAT_ADMIN_ROSTER_DISCOVERY_SCHEDULE_CONCURRENCY,
      async (chat) =>
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
        attempts: this.resolveJobAttempts(desiredJobData),
        priority: this.resolveJobPriority(desiredJobData),
        removeOnComplete: true,
        removeOnFail: false,
        delay: this.resolveJobInitialDelayMs(desiredJobData),
        backoff: this.resolveJobBackoff(desiredJobData),
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

  async backfillManagedEntitiesIndex(
    options: { bypassCache?: boolean; allowRemoteListBotChats?: boolean } = {},
  ): Promise<{
    discoveredChats: number;
    syncedChats: number;
  }> {
    const mergedByChatId =
      options.allowRemoteListBotChats === true
        ? await this.loadRemoteBackfillJobs(options)
        : await this.loadLocalBackfillJobs();

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

  private async loadRemoteBackfillJobs(options: {
    bypassCache?: boolean;
  }): Promise<Map<string, MaxChatAdminRosterSyncJob>> {
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

    return mergedByChatId;
  }

  private async loadLocalBackfillJobs(): Promise<Map<string, MaxChatAdminRosterSyncJob>> {
    const mergedByChatId = new Map<string, MaxChatAdminRosterSyncJob>();
    const memberships = await this.prisma.chatBotMembership.findMany({
      where: {
        status: ChatBotMembershipStatus.ACTIVE,
      },
      select: {
        botId: true,
        lastSeenAt: true,
        lastWebhookAt: true,
        chat: {
          select: {
            id: true,
            title: true,
            entityType: true,
            primaryBotId: true,
            botId: true,
          },
        },
      },
      orderBy: [{ lastSeenAt: 'desc' }, { updatedAt: 'desc' }],
      take: 20_000,
    });

    for (const membership of memberships) {
      const chatId = this.readTrimmedString(membership.chat.id);
      if (!chatId) {
        continue;
      }
      const entityType = this.fromPrismaEntityType(membership.chat.entityType);
      if (this.isUnsupportedManagedRosterSyncChat(chatId, entityType)) {
        continue;
      }

      const existing = mergedByChatId.get(chatId);
      const nextBotIds = Array.from(
        new Set(
          [
            ...(existing?.botIds ?? []),
            membership.botId,
            membership.chat.primaryBotId,
            membership.chat.botId,
          ]
            .map((botId) => this.resolveDiscoveryBotId(botId))
            .filter((botId): botId is string => Boolean(botId)),
        ),
      );
      if (nextBotIds.length === 0) {
        continue;
      }

      mergedByChatId.set(chatId, {
        chatId,
        botIds: nextBotIds,
        title: existing?.title ?? this.readTrimmedString(membership.chat.title),
        entityType: existing?.entityType ?? entityType,
        source: 'discovery_snapshot',
        retryUntilMs: null,
      });
    }

    return mergedByChatId;
  }

  private async syncChatAdminRoster(job: MaxChatAdminRosterSyncJob): Promise<boolean> {
    const normalized = await this.buildMergedJobData(job);
    if (!normalized) {
      return false;
    }

    await this.persistCatalogBinding(normalized);

    const candidateResolution = await this.resolveCandidateBotIds(normalized);
    const candidateBotIds = candidateResolution.botIds;
    const deniedBotIds: string[] = [];
    let recoverableError: unknown = null;
    let attemptedCandidate = false;
    let skippedDueToTerminalBackoff = false;

    for (const botId of candidateBotIds) {
      const sourceBackoffDelayMs = this.resolveManagedRefreshSourceBackoffDelayMs(normalized);
      if (sourceBackoffDelayMs > 0) {
        throw new MaxChatAdminRosterSyncSourceBackoffError(
          normalized.chatId,
          sourceBackoffDelayMs,
        );
      }

      if (
        normalized.source !== 'webhook_bot_added' &&
        this.isTerminalBotBackoffActive(normalized.chatId, botId)
      ) {
        skippedDueToTerminalBackoff = true;
        continue;
      }

      try {
        attemptedCandidate = true;
        const requestOptions = this.buildChatAdminRosterReadOptions(normalized, botId);
        const access = await this.maxClient.getCurrentChatMemberAccess(
          normalized.chatId,
          requestOptions,
        );
        await this.persistBotSelfAccessSnapshot(normalized, botId, access);

        if (!access.isAdmin && !access.isOwner) {
          deniedBotIds.push(botId);
          continue;
        }

        const adminUserIds = await this.maxClient.getChatAdminIds(
          normalized.chatId,
          requestOptions,
        );
        await this.syncAllowlist(normalized, adminUserIds, {
          botId,
          botRole: this.resolveManagedEntityAccessRole(access),
        });
        await this.markCatalogManagedAfterConfirmedRoster(normalized);
        await this.reconcileNightModeAfterConfirmedAccess(normalized.chatId, botId);
        return true;
      } catch (error: unknown) {
        if (this.isChatAccessDeniedError(error)) {
          await this.persistBotSelfAccessSnapshot(normalized, botId, null);
          deniedBotIds.push(botId);
          this.markTerminalBotBackoff(normalized.chatId, botId);
          continue;
        }

        if (this.isRateLimitPressureError(error)) {
          this.markManagedRefreshSourceBackoff();
          throw new MaxChatAdminRosterSyncSourceBackoffError(
            normalized.chatId,
            this.resolveManagedRefreshSourceBackoffDelayMs(normalized),
          );
        }

        recoverableError ??= error;
      }
    }

    if (recoverableError) {
      throw recoverableError;
    }

    if (!attemptedCandidate && skippedDueToTerminalBackoff) {
      this.logger.debug(
        {
          chatId: normalized.chatId,
          botIds: candidateBotIds,
          source: normalized.source ?? null,
        },
        'Skipped chat admin roster sync because every candidate bot is in terminal backoff',
      );
      return false;
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

    if (!candidateResolution.completeEnoughForGlobalDeny) {
      await this.recordIncompleteCandidateBotDeny(normalized.chatId, deniedBotIds);
      return false;
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
          this.resolveDiscoveryBotId(persisted?.primaryBotId),
          this.resolveDiscoveryBotId(persisted?.botId),
          ...((persisted?.botMemberships ?? []).map((membership) =>
            this.resolveDiscoveryBotId(membership.botId),
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
          .map((botId) => this.resolveDiscoveryBotId(botId))
          .filter((botId): botId is string => Boolean(botId)),
      ),
    );
    const entityType =
      params?.entityType === 'channel' ? 'channel' : params?.entityType === 'chat' ? 'chat' : null;
    const source =
      params?.source === 'webhook_bot_added' ||
      params?.source === 'webhook_bot_removed' ||
      params?.source === 'webhook_chat_title_changed' ||
      params?.source === 'webhook_membership_churn' ||
      params?.source === 'handshake_start' ||
      params?.source === 'moderation_destructive_path' ||
      params?.source === 'admin_access_validation' ||
      params?.source === 'discovery_snapshot'
        ? params.source
        : null;
    const retryUntilMs =
      typeof params?.retryUntilMs === 'number' && Number.isFinite(params.retryUntilMs)
        ? Math.max(0, Math.trunc(params.retryUntilMs))
        : null;
    if (this.isUnsupportedManagedRosterSyncChat(chatId, entityType)) {
      return null;
    }

    return {
      chatId,
      botIds,
      title: this.readTrimmedString(params?.title) ?? null,
      entityType,
      source,
      retryUntilMs,
    };
  }

  private isUnsupportedManagedRosterSyncChat(
    chatId: string,
    entityType: 'chat' | 'channel' | null,
  ): boolean {
    return entityType !== 'channel' && isPrivateDirectChatId(chatId);
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
      this.areRetryUntilMsEquivalent(left, right) &&
      left.botIds?.length === right.botIds?.length &&
      (left.botIds ?? []).every((botId, index) => botId === (right.botIds ?? [])[index])
    );
  }

  private areRetryUntilMsEquivalent(
    left: MaxChatAdminRosterSyncJob,
    right: MaxChatAdminRosterSyncJob,
  ): boolean {
    const leftRetryUntilMs = left.retryUntilMs ?? null;
    const rightRetryUntilMs = right.retryUntilMs ?? null;
    if (leftRetryUntilMs === rightRetryUntilMs) {
      return true;
    }

    if (
      left.source === 'webhook_bot_added' &&
      right.source === 'webhook_bot_added' &&
      typeof leftRetryUntilMs === 'number' &&
      typeof rightRetryUntilMs === 'number'
    ) {
      return (
        Math.abs(leftRetryUntilMs - rightRetryUntilMs) <=
        CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_RETRY_UNTIL_TOLERANCE_MS
      );
    }

    return false;
  }

  private buildJobId(chatId: string): string {
    return `chat-admin-roster-sync__${chatId}`;
  }

  private async resolveCandidateBotIds(
    job: MaxChatAdminRosterSyncJob,
  ): Promise<ResolvedRosterCandidates> {
    const discoveryBotIds = Array.from(
      new Set(
        this.maxBotRegistry
          .getDiscoveryBots()
          .map((bot) => this.resolveDiscoveryBotId(bot.id))
          .filter((botId): botId is string => Boolean(botId)),
      ),
    );
    const resolved = new Set(
      (job.botIds ?? [])
        .map((botId) => this.resolveDiscoveryBotId(botId))
        .filter((botId): botId is string => Boolean(botId)),
    );
    let loadedPersistedCandidates = false;

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
      loadedPersistedCandidates = true;

      for (const botId of [
        this.resolveDiscoveryBotId(persisted?.primaryBotId),
        this.resolveDiscoveryBotId(persisted?.botId),
        ...((persisted?.botMemberships ?? []).map((membership) =>
          this.resolveDiscoveryBotId(membership.botId),
        ) as Array<string | null>),
      ]) {
        if (botId) {
          resolved.add(botId);
        }
      }
    }

    if (resolved.size === 0) {
      for (const botId of discoveryBotIds) {
        resolved.add(botId);
      }
    }

    return {
      botIds: [...resolved],
      completeEnoughForGlobalDeny:
        discoveryBotIds.length > 0
          ? discoveryBotIds.every((botId) => resolved.has(botId))
          : loadedPersistedCandidates,
    };
  }

  private async persistCatalogBinding(job: MaxChatAdminRosterSyncJob): Promise<void> {
    const entityType = this.toPrismaEntityType(job.entityType);
    if (!entityType && !this.readTrimmedString(job.title) && (job.botIds?.length ?? 0) === 0) {
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
    accessContext: {
      botId: string;
      botRole: ManagedEntityAccessRoleValue;
    },
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
    await this.upsertManagedEntityAccessEdges({
      chatId,
      userIds: normalizedAdminUserIds,
      botId: accessContext.botId,
      entityType: job.entityType ?? null,
      state: 'GRANTED',
      userRole: 'ADMIN',
      botRole: accessContext.botRole,
      source: job.source ?? 'admin_roster_sync',
    });
    await this.upsertManagedEntityAdminMembers({
      chatId,
      userIds: normalizedAdminUserIds,
      botId: accessContext.botId,
      entityType: job.entityType ?? null,
      role: 'ADMIN',
      source: job.source ?? 'admin_roster_sync',
    });
    await this.markManagedEntityAccessEdgesDenied({
      chatId,
      userIds: usersToRemove,
      botId: accessContext.botId,
      state: 'USER_DENIED',
      deniedReason: 'user_removed_from_admin_roster',
      source: job.source ?? 'admin_roster_sync',
    });
    await this.expireManagedEntityAdminMembers({
      chatId,
      userIds: usersToRemove,
      botId: accessContext.botId,
      source: job.source ?? 'admin_roster_sync',
    });

    await this.patchManagedEntitiesPublishedSnapshots({
      chatId,
      entityTypeHint: job.entityType ?? null,
      titleHint: job.title ?? null,
      userIdsToUpsert: normalizedAdminUserIds,
      userIdsToRemove: usersToRemove,
    });
    await this.chatContextCache.clearManagedEntitiesRecentBootstrapForChat?.(
      chatId,
      job.entityType ?? null,
    );
  }

  private async markCatalogManagedAfterConfirmedRoster(
    job: Pick<MaxChatAdminRosterSyncJob, 'chatId' | 'entityType'>,
  ): Promise<void> {
    const chatId = this.readTrimmedString(job.chatId);
    if (!chatId || this.isUnsupportedManagedRosterSyncChat(chatId, job.entityType ?? null)) {
      return;
    }

    try {
      const entityType = job.entityType ? this.toPrismaEntityType(job.entityType) : null;
      await this.prisma.chat.update({
        where: { id: chatId },
        data: {
          catalogKind: ChatCatalogKind.MANAGED,
          ...(entityType ? { entityType } : {}),
        },
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to mark chat catalog kind as managed after confirmed roster sync',
      );
    }
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
    await this.markManagedEntityAccessEdgesDenied({
      chatId,
      userIds: existingUserIds,
      state: deniedState === 'user_denied' ? 'USER_DENIED' : 'BOT_DENIED',
      deniedReason: deniedState,
      source: 'admin_roster_sync_clear',
    });
    await this.expireManagedEntityAdminMembers({
      chatId,
      userIds: existingUserIds,
      source: 'admin_roster_sync_clear',
    });

    await this.patchManagedEntitiesPublishedSnapshots({
      chatId,
      entityTypeHint: null,
      titleHint: null,
      userIdsToUpsert: [],
      userIdsToRemove: existingUserIds,
    });
    await this.chatContextCache.clearManagedEntitiesRecentBootstrapForChat?.(chatId, null);
  }

  private async recordIncompleteCandidateBotDeny(
    chatId: string,
    candidateBotIds: readonly string[],
  ): Promise<void> {
    const botIds = Array.from(
      new Set(
        candidateBotIds
          .map((botId) => this.resolveDiscoveryBotId(botId))
          .filter((botId): botId is string => Boolean(botId)),
      ),
    );
    if (botIds.length === 0) {
      return;
    }

    await this.chatContextCache.clearManagedEntitiesRecentBootstrapForChat?.(chatId, null);
  }

  private shouldRetryPendingAdminGrant(job: MaxChatAdminRosterSyncJob): boolean {
    return (
      job.source === 'webhook_bot_added' &&
      typeof job.retryUntilMs === 'number' &&
      Number.isFinite(job.retryUntilMs) &&
      job.retryUntilMs > Date.now()
    );
  }

  private getManagedEntityAccessEdgeClient(): ManagedEntityAccessEdgeClient | null {
    const client = (this.prisma as unknown as { managedEntityAccessEdge?: unknown })
      .managedEntityAccessEdge;
    if (!client || typeof client !== 'object') {
      return null;
    }

    const candidate = client as ManagedEntityAccessEdgeClient;
    return typeof candidate.upsert === 'function' || typeof candidate.updateMany === 'function'
      ? candidate
      : null;
  }

  private async upsertManagedEntityAdminMembers(params: {
    chatId: string;
    userIds: readonly string[];
    botId: string;
    entityType: ManagedEntityType | null;
    role: Exclude<ManagedEntityAccessRoleValue, 'MEMBER' | 'UNKNOWN'>;
    source: string;
  }): Promise<void> {
    if (!params.entityType) {
      return;
    }

    const client = (
      this.prisma as PrismaService & {
        managedEntityAdminMember?: {
          upsert?: (args: unknown) => Promise<unknown>;
        };
      }
    ).managedEntityAdminMember;
    if (typeof client?.upsert !== 'function') {
      return;
    }

    const chatId = this.readTrimmedString(params.chatId);
    const botId =
      this.maxBotRegistry.getBotById(params.botId)?.id ?? this.readTrimmedString(params.botId);
    if (!chatId || !botId) {
      return;
    }

    const userIds = Array.from(
      new Set(
        params.userIds
          .map((userId) => this.readTrimmedString(userId))
          .filter((userId): userId is string => Boolean(userId)),
      ),
    );
    const now = new Date();
    const expiresAt = new Date(now.getTime() + MANAGED_ENTITY_ACCESS_EDGE_GRANTED_TTL_MS);
    await this.mapWithConcurrencyLimit(
      userIds,
      MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_PATCH_CONCURRENCY,
      async (userId) => {
        await client.upsert?.({
          where: {
            chatId_userId_observedByBotId: {
              chatId,
              userId,
              observedByBotId: botId,
            },
          },
          create: {
            chatId,
            userId,
            observedByBotId: botId,
            entityType: this.toPrismaEntityType(params.entityType),
            role: params.role,
            permissions: [],
            checkedAt: now,
            expiresAt,
            source: params.source,
          },
          update: {
            entityType: this.toPrismaEntityType(params.entityType),
            role: params.role,
            checkedAt: now,
            expiresAt,
            source: params.source,
          },
        });
        return null;
      },
    );
  }

  private async expireManagedEntityAdminMembers(params: {
    chatId: string;
    userIds: readonly string[];
    botId?: string | null;
    source: string;
  }): Promise<void> {
    const client = (
      this.prisma as PrismaService & {
        managedEntityAdminMember?: {
          updateMany?: (args: unknown) => Promise<unknown>;
        };
      }
    ).managedEntityAdminMember;
    if (typeof client?.updateMany !== 'function') {
      return;
    }

    const chatId = this.readTrimmedString(params.chatId);
    const userIds = Array.from(
      new Set(
        params.userIds
          .map((userId) => this.readTrimmedString(userId))
          .filter((userId): userId is string => Boolean(userId)),
      ),
    );
    if (!chatId || userIds.length === 0) {
      return;
    }

    const botId = params.botId
      ? (this.maxBotRegistry.getBotById(params.botId)?.id ?? this.readTrimmedString(params.botId))
      : null;
    await client.updateMany({
      where: {
        chatId,
        userId: {
          in: userIds,
        },
        ...(botId ? { observedByBotId: botId } : {}),
      },
      data: {
        expiresAt: new Date(),
        source: params.source,
      },
    });
  }

  private resolveManagedEntityAccessRole(access: {
    isAdmin?: boolean;
    isOwner?: boolean;
  }): ManagedEntityAccessRoleValue {
    if (access.isOwner === true) {
      return 'OWNER';
    }
    if (access.isAdmin === true) {
      return 'ADMIN';
    }
    return 'MEMBER';
  }

  private async upsertManagedEntityAccessEdges(params: {
    chatId: string;
    userIds: readonly string[];
    botId: string;
    entityType: ManagedEntityType | null;
    state: 'GRANTED';
    userRole: ManagedEntityAccessRoleValue;
    botRole: ManagedEntityAccessRoleValue;
    source: string;
  }): Promise<void> {
    const client = this.getManagedEntityAccessEdgeClient();
    if (!client?.upsert || !params.entityType) {
      return;
    }

    const chatId = this.readTrimmedString(params.chatId);
    const botId =
      this.maxBotRegistry.getBotById(params.botId)?.id ?? this.readTrimmedString(params.botId);
    if (!chatId || !botId) {
      return;
    }

    const userIds = Array.from(
      new Set(
        params.userIds
          .map((userId) => this.readTrimmedString(userId))
          .filter((userId): userId is string => Boolean(userId)),
      ),
    );
    const now = new Date();
    const expiresAt = new Date(now.getTime() + MANAGED_ENTITY_ACCESS_EDGE_GRANTED_TTL_MS);
    await this.mapWithConcurrencyLimit(
      userIds,
      MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_PATCH_CONCURRENCY,
      async (userId) => {
        await client.upsert?.({
          where: {
            chatId_userId_botId: {
              chatId,
              userId,
              botId,
            },
          },
          create: {
            chatId,
            userId,
            botId,
            entityType: this.toPrismaEntityType(params.entityType),
            state: params.state,
            userRole: params.userRole,
            botRole: params.botRole,
            checkedAt: now,
            expiresAt,
            deniedReason: null,
            lastMaxErrorCode: null,
            lastMaxErrorMessage: null,
            lastMaxStatusCode: null,
            source: params.source,
          },
          update: {
            entityType: this.toPrismaEntityType(params.entityType),
            state: params.state,
            userRole: params.userRole,
            botRole: params.botRole,
            checkedAt: now,
            expiresAt,
            deniedReason: null,
            lastMaxErrorCode: null,
            lastMaxErrorMessage: null,
            lastMaxStatusCode: null,
            source: params.source,
          },
        });
        return null;
      },
    );
  }

  private async markManagedEntityAccessEdgesDenied(params: {
    chatId: string;
    userIds: readonly string[];
    botId?: string | null;
    state: 'USER_DENIED' | 'BOT_DENIED';
    deniedReason: string;
    source: string;
  }): Promise<void> {
    const client = this.getManagedEntityAccessEdgeClient();
    if (!client?.updateMany) {
      return;
    }

    const chatId = this.readTrimmedString(params.chatId);
    const userIds = Array.from(
      new Set(
        params.userIds
          .map((userId) => this.readTrimmedString(userId))
          .filter((userId): userId is string => Boolean(userId)),
      ),
    );
    if (!chatId || userIds.length === 0) {
      return;
    }

    const botId = params.botId
      ? (this.maxBotRegistry.getBotById(params.botId)?.id ?? this.readTrimmedString(params.botId))
      : null;
    await client.updateMany({
      where: {
        chatId,
        userId: {
          in: userIds,
        },
        ...(botId ? { botId } : {}),
      },
      data: {
        state: params.state,
        userRole: params.state === 'USER_DENIED' ? 'MEMBER' : 'UNKNOWN',
        botRole: params.state === 'BOT_DENIED' ? 'MEMBER' : 'UNKNOWN',
        checkedAt: new Date(),
        expiresAt: null,
        deniedReason: params.deniedReason,
        source: params.source,
      },
    });
  }

  private resolveJobAttempts(job: MaxChatAdminRosterSyncJob): number {
    if (job.source === 'webhook_bot_added') {
      return CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_ATTEMPTS;
    }

    if (
      job.source === 'webhook_membership_churn' ||
      job.source === 'handshake_start' ||
      job.source === 'moderation_destructive_path' ||
      job.source === 'admin_access_validation'
    ) {
      return CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_MEMBERSHIP_CHURN_ATTEMPTS;
    }

    return 5;
  }

  private resolveJobPriority(job: MaxChatAdminRosterSyncJob): number {
    if (job.source === 'webhook_bot_added') {
      return CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_PRIORITY;
    }

    if (
      job.source === 'webhook_membership_churn' ||
      job.source === 'handshake_start' ||
      job.source === 'moderation_destructive_path' ||
      job.source === 'admin_access_validation'
    ) {
      return CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_MEMBERSHIP_CHURN_PRIORITY;
    }

    return CHAT_ADMIN_ROSTER_SYNC_DEFAULT_PRIORITY;
  }

  private resolveJobInitialDelayMs(job: MaxChatAdminRosterSyncJob): number {
    if (job.source !== 'webhook_bot_added') {
      return 0;
    }

    return (
      CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_INITIAL_DELAY_MS +
      this.hashModulo(job.chatId, CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_INITIAL_JITTER_MS + 1)
    );
  }

  private resolveJobBackoff(job: MaxChatAdminRosterSyncJob):
    | {
        type: 'fixed';
        delay: number;
      }
    | {
        type: 'exponential';
        delay: number;
      } {
    if (job.source === 'webhook_bot_added') {
      return {
        type: 'exponential',
        delay: CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_BACKOFF_DELAY_MS,
      };
    }

    if (
      job.source === 'webhook_membership_churn' ||
      job.source === 'handshake_start' ||
      job.source === 'moderation_destructive_path' ||
      job.source === 'admin_access_validation'
    ) {
      return {
        type: 'fixed',
        delay: CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_MEMBERSHIP_CHURN_BACKOFF_DELAY_MS,
      };
    }

    return {
      type: 'exponential',
      delay: 1_000,
    };
  }

  private hashModulo(value: string, modulo: number): number {
    if (modulo <= 1) {
      return 0;
    }

    const digest = createHash('sha256').update(value).digest();
    return digest.readUInt32BE(0) % modulo;
  }

  private buildChatAdminRosterReadOptions(
    job: MaxChatAdminRosterSyncJob,
    botId: string,
  ): {
    botId: string;
    trafficClass: 'background';
    actionHealthLane: 'background';
    sourceTag: string;
    timeoutMs: number;
  } {
    if (
      job.source === 'webhook_bot_added' ||
      job.source === 'webhook_membership_churn' ||
      job.source === 'handshake_start' ||
      job.source === 'moderation_destructive_path' ||
      job.source === 'admin_access_validation'
    ) {
      return {
        botId,
        trafficClass: 'background',
        actionHealthLane: CHAT_ADMIN_ROSTER_SYNC_ACTION_HEALTH_LANE,
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
        timeoutMs: CHAT_ADMIN_ROSTER_SYNC_FAST_LANE_TIMEOUT_MS,
      };
    }

    return {
      botId,
      trafficClass: 'background',
      actionHealthLane: CHAT_ADMIN_ROSTER_SYNC_ACTION_HEALTH_LANE,
      sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
      timeoutMs: CHAT_ADMIN_ROSTER_SYNC_TIMEOUT_MS,
    };
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

    const entityType = this.fromPrismaEntityType(persisted?.entityType) ?? entityTypeHint ?? null;
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
        this.isFallbackTitle(summary.id, existing.title) &&
        !this.isFallbackTitle(summary.id, summary.title)
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

    await this.writeManagedEntitiesPublishedSnapshot(
      userId,
      summary.entityType,
      currentSnapshot,
      nextItems,
    );
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

    await this.writeManagedEntitiesPublishedSnapshot(
      userId,
      entityType,
      currentSnapshot,
      nextItems,
    );
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
      itemsHash: this.buildManagedEntitiesPublishedSnapshotHash(
        items,
        currentSnapshot.lastSyncedAt,
      ),
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
    job: Pick<MaxChatAdminRosterSyncJob, 'chatId' | 'title' | 'entityType'>,
    botId: string,
    access: {
      isAdmin: boolean;
      isOwner: boolean;
      permissions?: readonly string[];
    } | null,
  ): Promise<void> {
    try {
      const now = new Date();
      const snapshot = buildBotAccessSnapshotPersistence(access, {
        source: 'admin_roster_sync',
        now,
      });
      await this.prisma.chatBotMembership.updateMany({
        where: {
          chatId: job.chatId,
          botId,
        },
        data: {
          lastSeenAt: now,
          ...snapshot,
        },
      });
      await this.maxBotLinkService.reconcileChatPrimaryByAccess({
        chatId: job.chatId,
        title: job.title ?? null,
        entityType: this.toPrismaEntityType(job.entityType),
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: job.chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist bot self access snapshot during chat admin roster sync',
      );
    }
  }

  private async reconcileNightModeAfterConfirmedAccess(
    chatId: string,
    botId: string,
  ): Promise<void> {
    if (!this.nightModeTransitionScheduler) {
      return;
    }

    try {
      await this.nightModeTransitionScheduler.reconcileChat(chatId);
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to reconcile night mode jobs after confirmed MAX access',
      );
    }
  }

  private isChatAccessDeniedError(error: unknown): boolean {
    const status = (error as { response?: { status?: number } } | null)?.response?.status;
    const code = (error as { response?: { data?: { code?: unknown } } } | null)?.response?.data
      ?.code;
    const normalizedCode = typeof code === 'string' ? code.trim().toLowerCase() : null;
    const message = (error as { response?: { data?: { message?: unknown } } } | null)?.response
      ?.data?.message;
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

  private isRateLimitPressureError(error: unknown): boolean {
    const status = (error as { response?: { status?: number } } | null)?.response?.status;
    if (status === 429) {
      return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    const normalizedMessage = message.trim().toLowerCase();
    return (
      normalizedMessage.includes('rate limit exceeded') ||
      normalizedMessage.includes('source limit exceeded')
    );
  }

  private isManagedRefreshSourceBackoffActive(now = Date.now()): boolean {
    if (this.managedRefreshSourceBackoffUntilMs <= now) {
      this.managedRefreshSourceBackoffUntilMs = 0;
      return false;
    }

    return true;
  }

  private markManagedRefreshSourceBackoff(now = Date.now()): void {
    this.managedRefreshSourceBackoffUntilMs = Math.max(
      this.managedRefreshSourceBackoffUntilMs,
      now + CHAT_ADMIN_ROSTER_SYNC_SOURCE_BACKOFF_MS,
    );
  }

  private resolveManagedRefreshSourceBackoffDelayMs(
    job: Pick<MaxChatAdminRosterSyncJob, 'chatId'>,
    now = Date.now(),
  ): number {
    if (!this.isManagedRefreshSourceBackoffActive(now)) {
      return 0;
    }

    return (
      Math.max(1, this.managedRefreshSourceBackoffUntilMs - now) +
      this.resolveSourceBackoffJitterMs(job)
    );
  }

  private resolveSourceBackoffJitterMs(job: Pick<MaxChatAdminRosterSyncJob, 'chatId'>): number {
    return this.hashModulo(job.chatId, CHAT_ADMIN_ROSTER_SYNC_SOURCE_BACKOFF_JITTER_MS + 1);
  }

  private isTerminalBotBackoffActive(chatId: string, botId: string, now = Date.now()): boolean {
    const key = this.buildTerminalBotBackoffKey(chatId, botId);
    const backoffUntilMs = this.terminalBotBackoffUntilMs.get(key) ?? 0;
    if (backoffUntilMs <= now) {
      if (backoffUntilMs > 0) {
        this.terminalBotBackoffUntilMs.delete(key);
      }
      return false;
    }

    return true;
  }

  private markTerminalBotBackoff(chatId: string, botId: string, now = Date.now()): void {
    this.terminalBotBackoffUntilMs.set(
      this.buildTerminalBotBackoffKey(chatId, botId),
      now + CHAT_ADMIN_ROSTER_SYNC_TERMINAL_BOT_BACKOFF_MS,
    );
  }

  private buildTerminalBotBackoffKey(chatId: string, botId: string): string {
    return `${chatId}:${botId}`;
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

  private resolveDiscoveryBotId(botId: unknown): string | null {
    const bot = this.maxBotRegistry.getBotById(this.readTrimmedString(botId));
    return bot && canDiscoverChatsForBotState(bot.state) ? bot.id : null;
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
