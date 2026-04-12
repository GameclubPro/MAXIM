import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatEntityType, WebhookStatus, type Prisma } from '@prisma/client';
import type { MaxUpdate } from '@maxim/contracts';
import { MaxClientService, type MaxChatMemberAccess } from '../max/max-client.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxChatAdminRosterSyncService } from '../max/max-chat-admin-roster-sync.service';
import { MaxMembershipLookupService } from '../max/max-membership-lookup.service';
import { PrismaService } from '../prisma/prisma.service';

type WebhookIngestResult = {
  accepted: boolean;
  duplicate: boolean;
};

type BotSelfAccessCacheEntry = {
  canHandleUserFacing: boolean;
  expiresAtMs: number;
};

type PersistedBotSelfAccessSnapshot = {
  canHandleUserFacing: boolean;
  checkedAtMs: number | null;
};

const BOT_SELF_ACCESS_CACHE_TTL_MS = 5 * 60 * 1_000;
const BOT_SELF_ACCESS_NEGATIVE_CACHE_TTL_MS = 60 * 1_000;
const BOT_SELF_ACCESS_BACKOFF_MS = 30 * 1_000;
const BOT_SELF_ACCESS_TIMEOUT_MS = 900;
const BOT_SELF_ACCESS_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1_000;
const EXECUTION_OWNER_ASYNC_RECHECK_BACKOFF_MS = 30 * 1_000;
const BOT_SELF_ACCESS_FAILURE_METRIC_STATUSES = [403, 404] as const;
const MANAGED_ENTITY_ACTIVITY_UPDATE_TYPES = new Set([
  'message_created',
  'message_callback',
  'bot_started',
  'bot_added',
]);
const MEMBERSHIP_ACTIVITY_UPDATE_TYPES = new Set(['user_added', 'user_removed']);
const INLINE_EXECUTION_OWNER_REFRESH_UPDATE_TYPES = new Set([
  'bot_added',
  'bot_started',
  'chat_title_changed',
]);
const CHAT_ADMIN_ROSTER_MEMBERSHIP_CHURN_UPDATE_TYPES = new Set([
  'bot_started',
  'user_added',
  'user_removed',
]);

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private static readonly BOT_ADDED_ADMIN_ROSTER_RETRY_WINDOW_MS = 45_000;
  private readonly rawPayloadSampleRate: number;
  private readonly botSelfAccessCache = new Map<string, BotSelfAccessCacheEntry>();
  private readonly botSelfAccessBackoffUntilMs = new Map<string, number>();
  private readonly executionOwnerRecheckBackoffUntilMs = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
    private readonly maxBotLinkService: MaxBotLinkService,
    @Optional() private readonly membershipLookupService?: MaxMembershipLookupService,
    @Optional() private readonly maxClient?: MaxClientService,
    @Optional()
    private readonly maxChatAdminRosterSyncService?: MaxChatAdminRosterSyncService,
  ) {
    this.rawPayloadSampleRate = configService.get<number>('RAW_PAYLOAD_SAMPLE_RATE', 0.01);
  }

  async ingest(update: MaxUpdate, sourceIp: string | null) {
    const membershipInvalidationPromise = this.invalidateMembershipCacheFromWebhook(update);
    const executionOwnerBotId = await this.syncChatBotBindingFromWebhook(update);
    await membershipInvalidationPromise;
    this.attachExecutionOwnerBotId(update, executionOwnerBotId);

    const shouldKeepRawPayload = Math.random() <= this.rawPayloadSampleRate;
    const rawPayload = shouldKeepRawPayload ? (update.raw ?? {}) : {};

    try {
      await this.persistEvent(update, sourceIp, rawPayload);

      return { accepted: true, duplicate: false };
    } catch (error: unknown) {
      const duplicateResult = await this.handleDuplicateError(error);
      if (duplicateResult) {
        return duplicateResult;
      }

      if (this.shouldRetryWithSanitizedPayload(error)) {
        const sanitizedUpdate = this.sanitizeForJsonStorage(update) as MaxUpdate;
        const sanitizedRawPayload = this.sanitizeForJsonStorage(rawPayload);

        try {
          await this.persistEvent(sanitizedUpdate, sourceIp, sanitizedRawPayload);
          this.logger.warn(
            {
              dedupKey: update.updateId,
              reason: this.extractErrorMessage(error),
            },
            'Stored webhook event with sanitized payload fallback',
          );
          return { accepted: true, duplicate: false };
        } catch (retryError: unknown) {
          const duplicateRetryResult = await this.handleDuplicateError(retryError);
          if (duplicateRetryResult) {
            return duplicateRetryResult;
          }
        }
      }

      this.logger.error({ err: error }, 'Failed to ingest webhook event');
      throw error;
    }
  }

  private async invalidateMembershipCacheFromWebhook(update: MaxUpdate): Promise<void> {
    if (!this.membershipLookupService) {
      return;
    }

    const chatId = update.message?.chatId?.trim() ?? '';
    const memberUserIds =
      update.membership?.memberUserIds ??
      (this.isDirectMembershipChange(update) && update.message?.senderId
        ? [update.message.senderId]
        : []);

    if (!chatId || memberUserIds.length === 0) {
      return;
    }

    try {
      await this.membershipLookupService.invalidateMemberships(chatId, memberUserIds);
    } catch (error: unknown) {
      this.logger.warn(
        {
          updateId: update.updateId,
          chatId,
          memberUserIds,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to invalidate MAX membership cache from webhook',
      );
    }
  }

  private isDirectMembershipChange(update: MaxUpdate): boolean {
    const normalizedType = update.type.trim().toLowerCase();
    return (
      normalizedType === 'user_added' ||
      normalizedType === 'bot_added' ||
      normalizedType === 'user_removed' ||
      normalizedType === 'bot_removed'
    );
  }

  private async persistEvent(
    update: MaxUpdate,
    sourceIp: string | null,
    rawPayload: Prisma.InputJsonValue,
  ) {
    await this.prisma.webhookEvent.create({
      data: {
        dedupKey: update.updateId,
        ...(update.botId ? { botId: update.botId } : {}),
        sourceIp: sourceIp ?? undefined,
        rawPayload,
        normalizedPayload: update as Prisma.InputJsonValue,
        status: WebhookStatus.RECEIVED,
      },
    });
    await this.persistAdminReadModels(update);
  }

  private async syncChatBotBindingFromWebhook(update: MaxUpdate): Promise<string | null> {
    const chatId = update.message?.chatId?.trim() ?? '';
    if (!chatId) {
      return null;
    }

    const entityType = this.readWebhookChatEntityType(update);
    try {
      if (this.isBotRemovalUpdate(update)) {
        const nextOwnerBotId = await this.maxBotLinkService.markChatBotRemoved({
          chatId,
          title: update.message?.chatTitle ?? null,
          entityType,
          botId: update.botId,
        });
        this.scheduleChatAdminRosterSyncFromWebhook(update, chatId);
        return nextOwnerBotId;
      }

      const boundBotId = await this.maxBotLinkService.bindChatToBot({
        chatId,
        title: update.message?.chatTitle ?? null,
        entityType,
        botId: update.botId,
      });
      let executionOwnerBotId = boundBotId;
      const shouldRefreshExecutionOwner = await this.shouldRefreshExecutionOwnerFromWebhook(
        update,
        boundBotId,
      );
      if (shouldRefreshExecutionOwner) {
        const allowLiveCheck = this.shouldPerformInlineExecutionOwnerLiveRefresh(update);
        executionOwnerBotId = await this.maybeFailOverExecutionOwner({
          update,
          chatId,
          incomingBotId: update.botId ?? null,
          currentOwnerBotId: boundBotId,
          allowLiveCheck,
        });
        if (!allowLiveCheck && executionOwnerBotId === boundBotId) {
          this.scheduleExecutionOwnerFailoverRecheck({
            update,
            chatId,
            incomingBotId: update.botId ?? null,
            currentOwnerBotId: boundBotId,
          });
        }
      }
      this.scheduleChatAdminRosterSyncFromWebhook(update, chatId);
      return executionOwnerBotId;
    } catch (error: unknown) {
      this.logger.warn(
        {
          updateId: update.updateId,
          botId: update.botId ?? null,
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to bind chat to bot during webhook ingest',
      );
      return null;
    }
  }

  private async maybeFailOverExecutionOwner(params: {
    update: MaxUpdate;
    chatId: string;
    incomingBotId: string | null;
    currentOwnerBotId: string | null;
    allowLiveCheck: boolean;
  }): Promise<string | null> {
    const incomingBotId = params.incomingBotId?.trim() ?? '';
    const currentOwnerBotId = params.currentOwnerBotId?.trim() ?? '';
    if (
      !params.chatId.startsWith('-') ||
      !incomingBotId ||
      !currentOwnerBotId ||
      incomingBotId === currentOwnerBotId
    ) {
      return params.currentOwnerBotId;
    }

    const currentOwnerCanHandleUserFacing = params.allowLiveCheck
      ? await this.getBotSelfModerationAccessState(params.chatId, currentOwnerBotId)
      : await this.getCachedOrPersistedBotSelfModerationAccessState(
          params.chatId,
          currentOwnerBotId,
        );
    if (currentOwnerCanHandleUserFacing !== false) {
      return params.currentOwnerBotId;
    }

    const incomingBotCanHandleUserFacing = params.allowLiveCheck
      ? await this.getBotSelfModerationAccessState(params.chatId, incomingBotId)
      : await this.getCachedOrPersistedBotSelfModerationAccessState(params.chatId, incomingBotId);
    if (incomingBotCanHandleUserFacing !== true) {
      return params.currentOwnerBotId;
    }

    const reassignedBotId = await this.maxBotLinkService.bindChatToBot({
      chatId: params.chatId,
      title: params.update.message?.chatTitle ?? null,
      entityType: this.readWebhookChatEntityType(params.update),
      botId: incomingBotId,
      allowReassign: true,
    });

    if (reassignedBotId === incomingBotId) {
      this.logger.warn(
        {
          chatId: params.chatId,
          updateId: params.update.updateId,
          previousPrimaryBotId: currentOwnerBotId,
          nextPrimaryBotId: incomingBotId,
        },
        'Promoted the incoming bot to primary after detecting stale owner permissions',
      );
    }

    return reassignedBotId ?? params.currentOwnerBotId;
  }

  private shouldPerformInlineExecutionOwnerLiveRefresh(update: MaxUpdate): boolean {
    return INLINE_EXECUTION_OWNER_REFRESH_UPDATE_TYPES.has(update.type.trim().toLowerCase());
  }

  private async shouldRefreshExecutionOwnerFromWebhook(
    update: MaxUpdate,
    currentOwnerBotId: string | null,
  ): Promise<boolean> {
    const normalizedType = update.type.trim().toLowerCase();
    if (this.shouldPerformInlineExecutionOwnerLiveRefresh(update)) {
      return true;
    }

    if (normalizedType !== 'message_created' && normalizedType !== 'message_callback') {
      return false;
    }

    const incomingBotId = update.botId?.trim() ?? '';
    const chatId = update.message?.chatId?.trim() ?? '';
    if (!incomingBotId || !currentOwnerBotId || !chatId || incomingBotId === currentOwnerBotId) {
      return false;
    }

    return (
      (await this.getCachedOrPersistedBotSelfModerationAccessState(chatId, currentOwnerBotId)) ===
      false
    );
  }

  private async persistAdminReadModels(update: MaxUpdate): Promise<void> {
    const writes: Promise<unknown>[] = [];

    const membershipProjection = this.buildMembershipActivityProjection(update);
    const membershipModel = (
      this.prisma as PrismaService & {
        chatMembershipActivityEvent?: {
          createMany?: (args: {
            data: Array<{
              id: string;
              dedupeKey: string;
              botId?: string | null;
              chatId: string;
              eventType: string;
              userId?: string | null;
              senderName?: string | null;
              eventAt: Date;
              createdAt: Date;
            }>;
            skipDuplicates?: boolean;
          }) => Promise<unknown>;
        };
      }
    ).chatMembershipActivityEvent;
    if (membershipProjection && typeof membershipModel?.createMany === 'function') {
      writes.push(
        membershipModel.createMany({
          data: [membershipProjection],
          skipDuplicates: true,
        }),
      );
    }

    const managedProjection = this.buildManagedEntityLocalActivityProjection(update);
    const managedModel = (
      this.prisma as PrismaService & {
        managedEntityLocalActivity?: {
          upsert?: (args: {
            where: {
              userId_chatId: {
                userId: string;
                chatId: string;
              };
            };
            create: {
              userId: string;
              chatId: string;
              entityType: ChatEntityType;
              chatTitle?: string | null;
              sourceEventType: string;
              botId?: string | null;
              lastEventAt: Date;
            };
            update: {
              entityType: ChatEntityType;
              chatTitle?: string | null;
              sourceEventType: string;
              botId?: string | null;
              lastEventAt: Date;
            };
          }) => Promise<unknown>;
        };
      }
    ).managedEntityLocalActivity;
    if (managedProjection && typeof managedModel?.upsert === 'function') {
      const baseWrite = {
        entityType: managedProjection.entityType,
        sourceEventType: managedProjection.sourceEventType,
        botId: managedProjection.botId ?? null,
        lastEventAt: managedProjection.lastEventAt,
        ...(managedProjection.chatTitle ? { chatTitle: managedProjection.chatTitle } : {}),
      };
      writes.push(
        managedModel.upsert({
          where: {
            userId_chatId: {
              userId: managedProjection.userId,
              chatId: managedProjection.chatId,
            },
          },
          create: {
            userId: managedProjection.userId,
            chatId: managedProjection.chatId,
            ...baseWrite,
          },
          update: baseWrite,
        }),
      );
    }

    if (writes.length === 0) {
      return;
    }

    const settled = await Promise.allSettled(writes);
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        continue;
      }

      this.logger.warn(
        {
          updateId: update.updateId,
          type: update.type,
          err: result.reason instanceof Error ? result.reason.message : String(result.reason),
        },
        'Failed to persist admin read model during webhook ingest',
      );
    }
  }

  private buildMembershipActivityProjection(update: MaxUpdate): {
    id: string;
    dedupeKey: string;
    botId?: string | null;
    chatId: string;
    eventType: string;
    userId?: string | null;
    senderName?: string | null;
    eventAt: Date;
    createdAt: Date;
  } | null {
    const normalizedType = update.type.trim().toLowerCase();
    if (!MEMBERSHIP_ACTIVITY_UPDATE_TYPES.has(normalizedType)) {
      return null;
    }

    const chatId = update.message?.chatId?.trim() ?? '';
    if (!chatId) {
      return null;
    }

    const eventAt = this.resolveUpdateEventAt(update);
    return {
      id: update.updateId,
      dedupeKey: update.updateId,
      botId: update.botId?.trim() || null,
      chatId,
      eventType: normalizedType,
      userId: update.message?.senderId?.trim() || null,
      senderName: update.message?.senderName?.trim() || null,
      eventAt,
      createdAt: eventAt,
    };
  }

  private buildManagedEntityLocalActivityProjection(update: MaxUpdate): {
    userId: string;
    chatId: string;
    entityType: ChatEntityType;
    chatTitle?: string | null;
    sourceEventType: string;
    botId?: string | null;
    lastEventAt: Date;
  } | null {
    const normalizedType = update.type.trim().toLowerCase();
    if (!MANAGED_ENTITY_ACTIVITY_UPDATE_TYPES.has(normalizedType)) {
      return null;
    }

    const userId = update.message?.senderId?.trim() ?? '';
    const chatId = update.message?.chatId?.trim() ?? '';
    if (!userId || !chatId) {
      return null;
    }

    return {
      userId,
      chatId,
      entityType: this.readWebhookChatEntityType(update) ?? ChatEntityType.CHAT,
      chatTitle: update.message?.chatTitle?.trim() || null,
      sourceEventType: normalizedType,
      botId: update.botId?.trim() || null,
      lastEventAt: this.resolveUpdateEventAt(update),
    };
  }

  private resolveUpdateEventAt(update: MaxUpdate): Date {
    const createdAtIso = update.message?.createdAt?.trim() ?? '';
    const parsedTimestamp = createdAtIso ? Date.parse(createdAtIso) : Number.NaN;
    if (Number.isFinite(parsedTimestamp)) {
      return new Date(parsedTimestamp);
    }

    return new Date();
  }

  private async getBotSelfModerationAccessState(
    chatId: string,
    botId: string,
  ): Promise<boolean | null> {
    const cacheKey = this.buildBotSelfAccessCacheKey(chatId, botId);
    const cached = this.readCachedBotSelfAccess(cacheKey);
    if (cached !== null) {
      return cached;
    }

    const backoffUntilMs = this.botSelfAccessBackoffUntilMs.get(cacheKey) ?? 0;
    if (backoffUntilMs > Date.now()) {
      return null;
    }

    if (!this.maxClient) {
      return null;
    }

    try {
      const access = await this.maxClient.getCurrentChatMemberAccess(chatId, {
        botId,
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        timeoutMs: BOT_SELF_ACCESS_TIMEOUT_MS,
        ignoreFailureMetricStatuses: BOT_SELF_ACCESS_FAILURE_METRIC_STATUSES,
      });
      return await this.cacheBotSelfAccess(chatId, botId, access);
    } catch (error: unknown) {
      if (this.isTerminalBotSelfAccessError(error)) {
        await this.cacheBotSelfAccess(chatId, botId, null);
        return false;
      }

      this.botSelfAccessBackoffUntilMs.set(cacheKey, Date.now() + BOT_SELF_ACCESS_BACKOFF_MS);
      this.logger.debug(
        {
          chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to refresh bot self access snapshot during webhook owner failover check',
      );
      return null;
    }
  }

  private async getCachedOrPersistedBotSelfModerationAccessState(
    chatId: string,
    botId: string,
  ): Promise<boolean | null> {
    const cacheKey = this.buildBotSelfAccessCacheKey(chatId, botId);
    const cached = this.readCachedBotSelfAccess(cacheKey);
    if (cached !== null) {
      return cached;
    }

    const persisted = await this.readPersistedBotSelfAccess(chatId, botId);
    if (!persisted) {
      return null;
    }

    this.cacheBotSelfAccessState(cacheKey, persisted.canHandleUserFacing, persisted.checkedAtMs);
    return persisted.canHandleUserFacing;
  }

  private async cacheBotSelfAccess(
    chatId: string,
    botId: string,
    access: MaxChatMemberAccess | null,
  ): Promise<boolean> {
    const canHandleUserFacing = this.canBotHandleUserFacingUpdates(access);
    const cacheKey = this.buildBotSelfAccessCacheKey(chatId, botId);
    this.cacheBotSelfAccessState(cacheKey, canHandleUserFacing);
    this.botSelfAccessBackoffUntilMs.delete(cacheKey);
    await this.persistBotSelfAccessSnapshot(chatId, botId, access);
    return canHandleUserFacing;
  }

  private async persistBotSelfAccessSnapshot(
    chatId: string,
    botId: string,
    access: MaxChatMemberAccess | null,
  ): Promise<void> {
    try {
      await this.prisma.chatBotMembership.updateMany({
        where: {
          chatId,
          botId,
        },
        data: {
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
        'Failed to persist bot self access snapshot during webhook owner failover check',
      );
    }
  }

  private buildBotSelfAccessCacheKey(chatId: string, botId: string): string {
    return `${chatId}:${botId}`;
  }

  private cacheBotSelfAccessState(
    cacheKey: string,
    canHandleUserFacing: boolean,
    checkedAtMs: number | null = null,
  ): void {
    const now = Date.now();
    const ttlMs = canHandleUserFacing
      ? BOT_SELF_ACCESS_CACHE_TTL_MS
      : BOT_SELF_ACCESS_NEGATIVE_CACHE_TTL_MS;
    const snapshotExpiryMs =
      typeof checkedAtMs === 'number' && Number.isFinite(checkedAtMs)
        ? checkedAtMs + BOT_SELF_ACCESS_SNAPSHOT_MAX_AGE_MS - now
        : null;
    const cappedTtlMs =
      snapshotExpiryMs === null ? ttlMs : Math.max(1, Math.min(ttlMs, snapshotExpiryMs));
    this.botSelfAccessCache.set(cacheKey, {
      canHandleUserFacing,
      expiresAtMs: now + cappedTtlMs,
    });
  }

  private readCachedBotSelfAccess(cacheKey: string): boolean | null {
    const cached = this.botSelfAccessCache.get(cacheKey);
    if (!cached) {
      return null;
    }
    if (cached.expiresAtMs <= Date.now()) {
      this.botSelfAccessCache.delete(cacheKey);
      return null;
    }
    return cached.canHandleUserFacing;
  }

  private async readPersistedBotSelfAccess(
    chatId: string,
    botId: string,
  ): Promise<PersistedBotSelfAccessSnapshot | null> {
    const membershipModel = (
      this.prisma as PrismaService & {
        chatBotMembership?: {
          findUnique?: (args: {
            where: {
              chatId_botId: {
                chatId: string;
                botId: string;
              };
            };
            select: {
              permissionsSnapshot: true;
            };
          }) => Promise<{ permissionsSnapshot: unknown } | null>;
        };
      }
    ).chatBotMembership;
    if (typeof membershipModel?.findUnique !== 'function') {
      return null;
    }

    try {
      const membership = await membershipModel.findUnique({
        where: {
          chatId_botId: {
            chatId,
            botId,
          },
        },
        select: {
          permissionsSnapshot: true,
        },
      });
      return this.normalizePersistedBotSelfAccessSnapshot(membership?.permissionsSnapshot ?? null);
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to read persisted bot self access snapshot during webhook owner check',
      );
      return null;
    }
  }

  private normalizePersistedBotSelfAccessSnapshot(
    value: unknown,
  ): PersistedBotSelfAccessSnapshot | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const checkedAtRaw = typeof row.checkedAt === 'string' ? row.checkedAt.trim() : '';
    const checkedAtMs = checkedAtRaw ? Date.parse(checkedAtRaw) : Number.NaN;
    if (!Number.isFinite(checkedAtMs)) {
      return null;
    }
    if (checkedAtMs + BOT_SELF_ACCESS_SNAPSHOT_MAX_AGE_MS <= Date.now()) {
      return null;
    }

    const permissions = Array.isArray(row.permissions)
      ? row.permissions.filter((permission): permission is string => typeof permission === 'string')
      : [];
    return {
      canHandleUserFacing: this.canBotHandleUserFacingFlags({
        isAdmin: row.isAdmin === true,
        isOwner: row.isOwner === true,
        permissions,
      }),
      checkedAtMs: Math.trunc(checkedAtMs),
    };
  }

  private canBotHandleUserFacingUpdates(access: MaxChatMemberAccess | null): boolean {
    return this.canBotHandleUserFacingFlags({
      isAdmin: access?.isAdmin === true,
      isOwner: access?.isOwner === true,
      permissions: access?.permissions ?? [],
    });
  }

  private canBotHandleUserFacingFlags(params: {
    isAdmin: boolean;
    isOwner: boolean;
    permissions: readonly string[];
  }): boolean {
    if (params.isOwner) {
      return true;
    }

    if (!params.isAdmin) {
      return false;
    }

    const permissions = Array.from(
      new Set(
        (params.permissions ?? [])
          .map((permission) =>
            permission
              .trim()
              .toLowerCase()
              .replace(/[-\s]+/gu, '_'),
          )
          .filter((permission) => permission.length > 0),
      ),
    );
    if (permissions.length === 0) {
      // Older MAX payloads may not expose granular permissions for admins.
      return params.isAdmin;
    }

    return permissions.some((permission) => this.isUserFacingModerationPermission(permission));
  }

  private isUserFacingModerationPermission(permission: string): boolean {
    return (
      permission === 'delete' ||
      permission === 'delete_message' ||
      permission === 'delete_messages' ||
      permission === 'can_delete_message' ||
      permission === 'can_delete_messages' ||
      permission === 'post_edit_delete_message' ||
      permission === 'post_edit_delete_messages' ||
      permission === 'can_post_edit_delete_message' ||
      permission === 'can_post_edit_delete_messages' ||
      permission === 'add_remove_members' ||
      permission === 'can_add_remove_members' ||
      permission === 'write' ||
      permission === 'send_messages' ||
      permission === 'can_send_messages' ||
      permission === 'read_all_messages' ||
      permission === 'can_read_all_messages'
    );
  }

  private isBotRemovalUpdate(update: MaxUpdate): boolean {
    return update.type.trim().toLowerCase() === 'bot_removed';
  }

  private scheduleExecutionOwnerFailoverRecheck(params: {
    update: MaxUpdate;
    chatId: string;
    incomingBotId: string | null;
    currentOwnerBotId: string | null;
  }): void {
    if (!this.maxClient) {
      return;
    }

    const normalizedType = params.update.type.trim().toLowerCase();
    if (normalizedType !== 'message_created' && normalizedType !== 'message_callback') {
      return;
    }

    const chatId = params.chatId.trim();
    const incomingBotId = params.incomingBotId?.trim() ?? '';
    const currentOwnerBotId = params.currentOwnerBotId?.trim() ?? '';
    if (!chatId.startsWith('-') || !incomingBotId || !currentOwnerBotId || incomingBotId === currentOwnerBotId) {
      return;
    }

    const backoffKey = `${chatId}:${currentOwnerBotId}:${incomingBotId}`;
    const backoffUntilMs = this.executionOwnerRecheckBackoffUntilMs.get(backoffKey) ?? 0;
    if (backoffUntilMs > Date.now()) {
      return;
    }

    this.executionOwnerRecheckBackoffUntilMs.set(
      backoffKey,
      Date.now() + EXECUTION_OWNER_ASYNC_RECHECK_BACKOFF_MS,
    );
    setTimeout(() => {
      void this
        .maybeFailOverExecutionOwner({
          update: params.update,
          chatId,
          incomingBotId,
          currentOwnerBotId,
          allowLiveCheck: true,
        })
        .catch((error: unknown) => {
          this.logger.debug(
            {
              chatId,
              currentOwnerBotId,
              incomingBotId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Async execution-owner recheck after webhook ingest failed',
          );
        });
    }, 0);
  }

  private scheduleChatAdminRosterSyncFromWebhook(update: MaxUpdate, chatId: string): void {
    if (!this.maxChatAdminRosterSyncService) {
      return;
    }

    const normalizedType = update.type.trim().toLowerCase();
    if (
      normalizedType !== 'bot_added' &&
      normalizedType !== 'bot_removed' &&
      normalizedType !== 'chat_title_changed' &&
      !CHAT_ADMIN_ROSTER_MEMBERSHIP_CHURN_UPDATE_TYPES.has(normalizedType)
    ) {
      return;
    }

    const source =
      normalizedType === 'bot_added'
        ? 'webhook_bot_added'
        : normalizedType === 'bot_removed'
          ? 'webhook_bot_removed'
          : normalizedType === 'chat_title_changed'
            ? 'webhook_chat_title_changed'
            : CHAT_ADMIN_ROSTER_MEMBERSHIP_CHURN_UPDATE_TYPES.has(normalizedType)
              ? 'webhook_membership_churn'
            : null;

    void this.maxChatAdminRosterSyncService
      .scheduleChatAdminRosterSync({
        chatId,
        botIds: update.botId ? [update.botId] : [],
        title: update.message?.chatTitle ?? null,
        entityType: update.message?.entityType ?? null,
        source,
        retryUntilMs:
          normalizedType === 'bot_added'
            ? Date.now() + WebhookService.BOT_ADDED_ADMIN_ROSTER_RETRY_WINDOW_MS
            : null,
      })
      .catch((error: unknown) => {
        this.logger.warn(
          {
            chatId,
            updateId: update.updateId,
            type: normalizedType,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to enqueue chat admin roster sync from webhook',
        );
      });
  }

  private attachExecutionOwnerBotId(update: MaxUpdate, botId: string | null): void {
    if (!botId) {
      return;
    }

    (
      update as MaxUpdate & {
        executionOwnerBotId?: string;
      }
    ).executionOwnerBotId = botId;
  }

  private readWebhookChatEntityType(update: MaxUpdate): ChatEntityType | null {
    const entityType = update.message?.entityType;
    if (entityType === 'channel') {
      return ChatEntityType.CHANNEL;
    }
    if (entityType === 'chat') {
      return ChatEntityType.CHAT;
    }
    return null;
  }

  private async handleDuplicateError(error: unknown): Promise<WebhookIngestResult | null> {
    const code = (error as { code?: string }).code;
    if (code !== 'P2002') {
      return null;
    }

    return { accepted: true, duplicate: true };
  }

  private shouldRetryWithSanitizedPayload(error: unknown): boolean {
    const code = (error as { code?: string }).code;
    if (code === 'P2002') {
      return false;
    }

    const message = this.extractErrorMessage(error);
    return (
      code === 'InvalidArg' ||
      message.includes('hex escape') ||
      message.includes('unicode') ||
      message.includes('surrogate') ||
      message.includes('invalid byte sequence') ||
      message.includes('null byte')
    );
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message.trim().toLowerCase();
    }

    const directMessage = (error as { message?: unknown }).message;
    if (typeof directMessage === 'string' && directMessage.trim().length > 0) {
      return directMessage.trim().toLowerCase();
    }

    return String(error).trim().toLowerCase();
  }

  private extractStatusCode(error: unknown): number | null {
    const maybeStatus = (error as { response?: { status?: number } })?.response?.status;
    return typeof maybeStatus === 'number' ? maybeStatus : null;
  }

  private extractMaxErrorCode(error: unknown): string | null {
    const maybeCode = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
    return typeof maybeCode === 'string' && maybeCode.trim().length > 0
      ? maybeCode.trim().toLowerCase()
      : null;
  }

  private isTerminalBotSelfAccessError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    if (status === 403 || status === 404) {
      return true;
    }

    const code = this.extractMaxErrorCode(error);
    if (code === 'chat.denied' || code === 'chat.not.found') {
      return true;
    }

    const message = this.extractErrorMessage(error);
    return message.includes('bot is not a chat member') || message.includes('not accessible');
  }

  private sanitizeForJsonStorage(
    value: unknown,
    seen = new WeakSet<object>(),
  ): Prisma.InputJsonValue {
    const sanitized = this.sanitizeJsonFragment(value, seen);
    return sanitized ?? ({} as Prisma.InputJsonObject);
  }

  private sanitizeJsonFragment(
    value: unknown,
    seen = new WeakSet<object>(),
  ): Prisma.InputJsonValue | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'string') {
      return this.normalizeStorageString(value);
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (Buffer.isBuffer(value)) {
      return value.toString('base64');
    }

    if (ArrayBuffer.isView(value)) {
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64');
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeJsonFragment(item, seen));
    }

    if (typeof value === 'object') {
      if (seen.has(value)) {
        return null;
      }
      seen.add(value);

      const sanitized: Record<string, Prisma.InputJsonValue | null> = {};
      for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        if (
          nestedValue === undefined ||
          typeof nestedValue === 'function' ||
          typeof nestedValue === 'symbol'
        ) {
          continue;
        }
        sanitized[key] = this.sanitizeJsonFragment(nestedValue, seen);
      }

      seen.delete(value);
      return sanitized as Prisma.InputJsonObject;
    }

    return this.normalizeStorageString(String(value));
  }

  private normalizeStorageString(value: string): string {
    let normalized = '';

    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index);

      if (codeUnit === 0) {
        continue;
      }

      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const nextCodeUnit = value.charCodeAt(index + 1);
        if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
          normalized += value[index] + value[index + 1];
          index += 1;
        } else {
          normalized += '\ufffd';
        }
        continue;
      }

      if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        normalized += '\ufffd';
        continue;
      }

      normalized += value[index];
    }

    return normalized;
  }
}
