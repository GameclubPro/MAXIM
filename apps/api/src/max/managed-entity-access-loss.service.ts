import { Injectable, Logger, Optional } from '@nestjs/common';
import type { ManagedEntityType } from '@maxim/contracts';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  ManagedEntityAccessState,
  type Prisma,
} from '../prisma/prisma-client';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import { PrismaService } from '../prisma/prisma.service';
import { NightModeTransitionSchedulerService } from '../moderation/night-mode-transition-scheduler.service';
import {
  isFreshMembershipAccessSnapshot,
  normalizeMembershipAccessSnapshot,
} from './max-bot-access-policy.util';
import { collectActiveManagedEntityBotMembershipIds } from './managed-entity-bot-access.util';
import {
  MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE,
  type MaxChatAdminRosterSyncJob,
} from './max-chat-admin-roster-sync.queue';
import { MaxBotLinkService } from './max-bot-link.service';
import { MaxBotRegistryService } from './max-bot-registry.service';

const MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;
const CONFIRMED_BOT_ACCESS_STATES = [
  ChatBotAccessState.CONFIRMED_ADMIN,
  ChatBotAccessState.CONFIRMED_OWNER,
] as const;

export type ManagedEntityAccessLossReason =
  | 'chat_not_found'
  | 'bot_denied'
  | 'bot_removed'
  | 'chat_inaccessible';

export type ManagedEntityAccessLossOperation =
  | 'send'
  | 'edit'
  | 'delete'
  | 'read'
  | 'lookup'
  | 'member_moderation';

export type MaxTerminalChatActionErrorClassification = {
  kind: 'managed_entity_access_lost' | 'message_not_found' | 'terminal_unknown';
  reason?: ManagedEntityAccessLossReason;
  statusCode: number | null;
  code: string | null;
  message: string;
};

export type RecordManagedEntityAccessLostParams = {
  chatId: string;
  botId?: string | null;
  entityType?: ChatEntityType | null;
  title?: string | null;
  reason: ManagedEntityAccessLossReason;
  source: string;
  lastMaxErrorCode?: string | null;
  lastMaxErrorMessage?: string | null;
  lastMaxStatusCode?: number | null;
};

export type RecordManagedEntityAccessLostFromErrorParams = Omit<
  RecordManagedEntityAccessLostParams,
  'reason'
> & {
  error: unknown;
  operation: ManagedEntityAccessLossOperation;
};

export type RecordManagedEntityAccessLostResult = {
  chatId: string;
  botId: string | null;
  nextOwnerBotId: string | null;
  updatedAccessEdges: number | null;
  cleanup: ManagedEntityAccessLossCleanupResult;
};

export type RecordManagedEntityAccessLostFromErrorResult = {
  classification: MaxTerminalChatActionErrorClassification;
  reason: ManagedEntityAccessLossReason | null;
  recorded: RecordManagedEntityAccessLostResult | null;
};

export type ManagedEntityAccessLossCleanupResult = {
  nightModeJobsCleared: boolean;
  canceledBroadcasts: number | null;
  canceledBroadcastDeliveries: number | null;
  canceledBroadcastOccurrences: number | null;
  clearedVkPublishPosts: number | null;
  pausedVkSources: number | null;
  removedRosterSyncJobs: number | null;
};

@Injectable()
export class ManagedEntityAccessLossService {
  private readonly logger = new Logger(ManagedEntityAccessLossService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly chatContextCache: ChatContextCacheService,
    @Optional()
    private readonly nightModeTransitionScheduler?: NightModeTransitionSchedulerService,
    @Optional()
    @InjectQueue(MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE)
    private readonly rosterSyncQueue?: Queue<MaxChatAdminRosterSyncJob>,
    @Optional()
    private readonly maxBotRegistry?: MaxBotRegistryService,
  ) {}

  async recordIfManagedEntityAccessLost(
    params: RecordManagedEntityAccessLostFromErrorParams,
  ): Promise<RecordManagedEntityAccessLostFromErrorResult | null> {
    const classification = classifyMaxTerminalChatActionError(params.error);
    if (!classification) {
      return null;
    }

    const reason = resolveManagedEntityAccessLossReason(params.operation, classification);
    if (!reason) {
      return {
        classification,
        reason: null,
        recorded: null,
      };
    }

    return {
      classification,
      reason,
      recorded: await this.recordManagedEntityAccessLost({
        chatId: params.chatId,
        botId: params.botId,
        entityType: params.entityType,
        title: params.title,
        source: params.source,
        reason,
        lastMaxErrorCode: classification.code,
        lastMaxErrorMessage: classification.message,
        lastMaxStatusCode: classification.statusCode,
      }),
    };
  }

  async recordManagedEntityAccessLost(
    params: RecordManagedEntityAccessLostParams,
  ): Promise<RecordManagedEntityAccessLostResult | null> {
    const chatId = params.chatId.trim();
    if (!chatId || isPrivateDirectChatId(chatId)) {
      return null;
    }

    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        title: true,
        entityType: true,
      },
    });
    const botId = await this.resolveBotId(chatId, params.botId);
    const title = params.title?.trim() || chat?.title || `Chat ${chatId}`;
    const entityType = params.entityType ?? chat?.entityType ?? null;
    const nextOwnerBotId = botId
      ? await this.maxBotLinkService.markChatBotRemoved({
          chatId,
          botId,
          title,
          entityType,
          accessLostReason: params.reason,
          accessLostSource: params.source,
          lastMaxErrorCode: params.lastMaxErrorCode,
          lastMaxErrorMessage: params.lastMaxErrorMessage,
          lastMaxStatusCode: params.lastMaxStatusCode,
        })
      : null;
    const updatedAccessEdges = botId
      ? await this.markAccessEdgesBotDenied({
          chatId,
          botId,
          reason: params.reason,
          source: params.source,
          lastMaxErrorCode: params.lastMaxErrorCode,
          lastMaxErrorMessage: params.lastMaxErrorMessage,
          lastMaxStatusCode: params.lastMaxStatusCode,
        })
      : 0;
    const hasSurvivingBotAccess = await this.hasConfirmedSurvivingBotAccess({
      chatId,
      lostBotId: botId,
      preferredBotId: nextOwnerBotId,
    });
    const cleanup = hasSurvivingBotAccess
      ? this.createEmptyCleanupResult()
      : await this.cleanupRuntimeWork({
          chatId,
          reason: params.reason,
          source: params.source,
        });

    await Promise.all([
      this.chatContextCache.invalidate(chatId),
      this.chatContextCache.invalidateManagedEntityHeader?.(chatId),
      this.chatContextCache.clearManagedEntitiesRecentBootstrapForChat(
        chatId,
        mapManagedEntityType(entityType),
      ),
    ]);

    this.logger.warn(
      {
        chatId,
        botId,
        nextOwnerBotId,
        reason: params.reason,
        source: params.source,
        updatedAccessEdges,
        cleanup,
      },
      'Recorded managed entity access lost',
    );

    return {
      chatId,
      botId,
      nextOwnerBotId,
      updatedAccessEdges,
      cleanup,
    };
  }

  private async cleanupRuntimeWork(params: {
    chatId: string;
    reason: ManagedEntityAccessLossReason;
    source: string;
  }): Promise<ManagedEntityAccessLossCleanupResult> {
    const cleanup: ManagedEntityAccessLossCleanupResult = {
      nightModeJobsCleared: false,
      canceledBroadcasts: null,
      canceledBroadcastDeliveries: null,
      canceledBroadcastOccurrences: null,
      clearedVkPublishPosts: null,
      pausedVkSources: null,
      removedRosterSyncJobs: null,
    };

    await Promise.all([
      this.clearNightModeJobs(params.chatId, cleanup),
      this.cancelManagedBroadcastRuntime(params, cleanup),
      this.clearVkParsingRuntime(params, cleanup),
      this.clearRosterSyncJobs(params.chatId, cleanup),
    ]);

    return cleanup;
  }

  private createEmptyCleanupResult(): ManagedEntityAccessLossCleanupResult {
    return {
      nightModeJobsCleared: false,
      canceledBroadcasts: null,
      canceledBroadcastDeliveries: null,
      canceledBroadcastOccurrences: null,
      clearedVkPublishPosts: null,
      pausedVkSources: null,
      removedRosterSyncJobs: null,
    };
  }

  private async hasConfirmedReplacementBotAccess(chatId: string, botId: string): Promise<boolean> {
    try {
      const now = new Date();
      const [membership, grantedEdge] = await Promise.all([
        typeof this.prisma.chatBotMembership?.findUnique === 'function'
          ? this.prisma.chatBotMembership.findUnique({
              where: {
                chatId_botId: {
                  chatId,
                  botId,
                },
              },
              select: {
                status: true,
                permissionsSnapshot: true,
                botAccessState: true,
                botAccessExpiresAt: true,
              },
            })
          : Promise.resolve(null),
        typeof this.prisma.managedEntityAccessEdge?.findFirst === 'function'
          ? this.prisma.managedEntityAccessEdge.findFirst({
              where: {
                chatId,
                botId,
                state: ManagedEntityAccessState.GRANTED,
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
              select: {
                botId: true,
              },
            })
          : Promise.resolve(null),
      ]);

      if (membership?.status !== ChatBotMembershipStatus.ACTIVE) {
        return false;
      }
      if (grantedEdge) {
        return true;
      }

      return this.membershipHasConfirmedAccess(membership, now);
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to verify replacement bot access after managed entity access loss',
      );
      return false;
    }
  }

  private async hasConfirmedSurvivingBotAccess(params: {
    chatId: string;
    lostBotId: string | null;
    preferredBotId: string | null;
  }): Promise<boolean> {
    const preferredBotId = this.readTrimmedString(params.preferredBotId);
    if (
      preferredBotId &&
      preferredBotId !== params.lostBotId &&
      this.isActionableRuntimeBotId(preferredBotId) &&
      (await this.hasConfirmedReplacementBotAccess(params.chatId, preferredBotId))
    ) {
      return true;
    }

    return this.hasAnyConfirmedSurvivingBotAccess(params.chatId, params.lostBotId);
  }

  private async hasAnyConfirmedSurvivingBotAccess(
    chatId: string,
    lostBotId: string | null,
  ): Promise<boolean> {
    try {
      const now = new Date();
      const candidateBotIds = this.getSurvivingActionableBotIds(lostBotId);
      if (candidateBotIds && candidateBotIds.length === 0) {
        return false;
      }

      const botIdWhere = candidateBotIds
        ? { in: candidateBotIds }
        : lostBotId
          ? { not: lostBotId }
          : undefined;
      const memberships =
        typeof this.prisma.chatBotMembership?.findMany === 'function'
          ? await this.prisma.chatBotMembership.findMany({
              where: {
                chatId,
                status: ChatBotMembershipStatus.ACTIVE,
                ...(botIdWhere ? { botId: botIdWhere } : {}),
              },
              select: {
                botId: true,
                status: true,
                permissionsSnapshot: true,
                botAccessState: true,
                botAccessExpiresAt: true,
              },
            })
          : [];
      const activeMembershipBotIds = collectActiveManagedEntityBotMembershipIds(memberships, {
        isRuntimeBotId: (botId) => this.isActionableRuntimeBotId(botId),
      });
      const grantedEdge =
        activeMembershipBotIds.size > 0 &&
        typeof this.prisma.managedEntityAccessEdge?.findFirst === 'function'
          ? await this.prisma.managedEntityAccessEdge.findFirst({
              where: {
                chatId,
                state: ManagedEntityAccessState.GRANTED,
                botId: { in: [...activeMembershipBotIds] },
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
              select: {
                botId: true,
              },
            })
          : null;

      if (grantedEdge && activeMembershipBotIds.has(grantedEdge.botId)) {
        return true;
      }

      return memberships.some(
        (membership) =>
          activeMembershipBotIds.has(membership.botId) &&
          this.membershipHasConfirmedAccess(membership, now),
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          lostBotId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to verify surviving bot access after managed entity access loss',
      );
      return false;
    }
  }

  private membershipHasConfirmedAccess(
    membership: {
      status?: ChatBotMembershipStatus | string | null;
      permissionsSnapshot?: unknown;
      botAccessState?: ChatBotAccessState | string | null;
      botAccessExpiresAt?: Date | string | null;
    },
    now: Date,
  ): boolean {
    if (membership.status !== ChatBotMembershipStatus.ACTIVE) {
      return false;
    }

    if (
      CONFIRMED_BOT_ACCESS_STATES.some((state) => state === membership.botAccessState) &&
      this.isFutureDate(membership.botAccessExpiresAt, now)
    ) {
      return true;
    }

    const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
    return Boolean(
      snapshot &&
        isFreshMembershipAccessSnapshot(snapshot, { nowMs: now.getTime() }) &&
        (snapshot.isAdmin || snapshot.isOwner),
    );
  }

  private getSurvivingActionableBotIds(lostBotId: string | null): string[] | null {
    if (!this.maxBotRegistry) {
      return null;
    }

    return this.maxBotRegistry
      .getActionableBots()
      .map((bot) => bot.id)
      .filter((botId) => botId !== lostBotId);
  }

  private isActionableRuntimeBotId(botId: string | null | undefined): boolean {
    const normalizedBotId = this.readTrimmedString(botId);
    if (!normalizedBotId) {
      return false;
    }
    if (!this.maxBotRegistry) {
      return true;
    }
    return this.maxBotRegistry.getActionableBots().some((bot) => bot.id === normalizedBotId);
  }

  private isFutureDate(value: Date | string | null | undefined, now: Date): boolean {
    const timestamp =
      value instanceof Date
        ? value.getTime()
        : typeof value === 'string'
          ? Date.parse(value)
          : NaN;
    return Number.isFinite(timestamp) && timestamp > now.getTime();
  }

  private async clearNightModeJobs(
    chatId: string,
    cleanup: ManagedEntityAccessLossCleanupResult,
  ): Promise<void> {
    if (!this.nightModeTransitionScheduler) {
      return;
    }
    await this.nightModeTransitionScheduler.clearChatJobs(chatId);
    cleanup.nightModeJobsCleared = true;
  }

  private async cancelManagedBroadcastRuntime(
    params: {
      chatId: string;
      reason: ManagedEntityAccessLossReason;
      source: string;
    },
    cleanup: ManagedEntityAccessLossCleanupResult,
  ): Promise<void> {
    if (
      typeof this.prisma.managedBroadcast?.updateMany !== 'function' ||
      typeof this.prisma.managedBroadcastDelivery?.updateMany !== 'function'
    ) {
      return;
    }

    const lastError = this.buildCleanupReasonMessage(params);
    const activeBroadcastStatuses = [
      ManagedBroadcastStatus.ACTIVE,
      ManagedBroadcastStatus.PARTIAL,
      ManagedBroadcastStatus.FAILED,
    ];
    const pendingDeliveryStatuses = [
      ManagedBroadcastDeliveryStatus.PENDING,
      ManagedBroadcastDeliveryStatus.SENDING,
      ManagedBroadcastDeliveryStatus.FAILED,
    ];

    const [broadcasts, deliveries, , occurrences] = await Promise.all([
      this.prisma.managedBroadcast.updateMany({
        where: {
          sourceChatId: params.chatId,
          status: { in: activeBroadcastStatuses },
        },
        data: {
          status: ManagedBroadcastStatus.CANCELED,
          nextSendAt: null,
          lockedAt: null,
          lockToken: null,
          lastError,
        },
      }),
      this.prisma.managedBroadcastDelivery.updateMany({
        where: {
          targetChatId: params.chatId,
          status: { in: pendingDeliveryStatuses },
        },
        data: {
          status: ManagedBroadcastDeliveryStatus.CANCELED,
          lockedAt: null,
          lockToken: null,
          lastError,
        },
      }),
      typeof this.prisma.managedBroadcastCalendarReservation?.deleteMany === 'function'
        ? this.prisma.managedBroadcastCalendarReservation.deleteMany({
            where: {
              OR: [{ sourceChatId: params.chatId }, { targetChatId: params.chatId }],
            },
          })
        : Promise.resolve(null),
      typeof this.prisma.managedBroadcastOccurrence?.updateMany === 'function'
        ? this.prisma.managedBroadcastOccurrence.updateMany({
            where: {
              sourceChatId: params.chatId,
              status: { in: activeBroadcastStatuses },
            },
            data: {
              status: ManagedBroadcastStatus.CANCELED,
            },
          })
        : Promise.resolve(null),
    ]);

    cleanup.canceledBroadcasts = this.readCount(broadcasts);
    cleanup.canceledBroadcastDeliveries = this.readCount(deliveries);
    cleanup.canceledBroadcastOccurrences = this.readCount(occurrences);
  }

  private async clearVkParsingRuntime(
    params: {
      chatId: string;
      reason: ManagedEntityAccessLossReason;
      source: string;
    },
    cleanup: ManagedEntityAccessLossCleanupResult,
  ): Promise<void> {
    const lastError = this.buildCleanupReasonMessage(params);
    const [posts, sources] = await Promise.all([
      typeof this.prisma.vkParsingPost?.updateMany === 'function'
        ? this.prisma.vkParsingPost.updateMany({
            where: {
              chatId: params.chatId,
              status: { in: ['NEW', 'FAILED'] },
              OR: [
                { publishQueuedAt: { not: null } },
                { publishLockedAt: { not: null } },
                { publishIdempotencyKey: { not: null } },
                { publishReason: { not: null } },
                { publishScheduledAt: { not: null } },
              ],
            },
            data: {
              publishQueuedAt: null,
              publishLockedAt: null,
              publishIdempotencyKey: null,
              publishReason: null,
              publishScheduledAt: null,
              lastError,
              autoPublishError: lastError,
            },
          })
        : Promise.resolve(null),
      typeof this.prisma.vkParsingSource?.updateMany === 'function'
        ? this.prisma.vkParsingSource.updateMany({
            where: {
              chatId: params.chatId,
              status: 'ACTIVE',
            },
            data: {
              nextSyncAt: null,
              syncStatus: 'ERROR',
              syncLockedAt: null,
              syncLockedBy: null,
              syncLockDeadlineAt: null,
              syncHeartbeatAt: null,
              lastErrorCode: 'max.access_lost',
              lastError,
              circuitOpenedAt: new Date(),
              circuitReasonCode: 'max.access_lost',
              circuitReason: lastError,
              circuitRetryAt: null,
              autoPublishPausedAt: new Date(),
              autoPublishPausedReason: lastError,
            },
          })
        : Promise.resolve(null),
    ]);

    cleanup.clearedVkPublishPosts = this.readCount(posts);
    cleanup.pausedVkSources = this.readCount(sources);
  }

  private async clearRosterSyncJobs(
    chatId: string,
    cleanup: ManagedEntityAccessLossCleanupResult,
  ): Promise<void> {
    if (!this.rosterSyncQueue) {
      return;
    }

    try {
      const job = await this.rosterSyncQueue.getJob(this.buildRosterSyncJobId(chatId));
      if (!job) {
        cleanup.removedRosterSyncJobs = 0;
        return;
      }

      const state = await job.getState();
      if (state === 'active') {
        cleanup.removedRosterSyncJobs = 0;
        return;
      }

      await job.remove();
      cleanup.removedRosterSyncJobs = 1;
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to clear roster sync jobs after managed entity access loss',
      );
    }
  }

  private buildRosterSyncJobId(chatId: string): string {
    return `chat-admin-roster-sync__${chatId}`;
  }

  private async resolveBotId(
    chatId: string,
    botId: string | null | undefined,
  ): Promise<string | null> {
    const explicit = this.readTrimmedString(botId);
    if (explicit) {
      return explicit;
    }

    try {
      const resolved = await this.maxBotLinkService.resolveBotId({ chatId });
      return this.readTrimmedString(resolved);
    } catch {
      return null;
    }
  }

  private async markAccessEdgesBotDenied(params: {
    chatId: string;
    botId: string | null;
    reason: string;
    source: string;
    lastMaxErrorCode?: string | null;
    lastMaxErrorMessage?: string | null;
    lastMaxStatusCode?: number | null;
  }): Promise<number | null> {
    if (typeof this.prisma.managedEntityAccessEdge?.updateMany !== 'function') {
      return null;
    }

    const result = await this.prisma.managedEntityAccessEdge.updateMany({
      where: {
        chatId: params.chatId,
        ...(params.botId ? { botId: params.botId } : {}),
      },
      data: {
        state: ManagedEntityAccessState.BOT_DENIED,
        botRole: 'MEMBER',
        checkedAt: new Date(),
        expiresAt: null,
        deniedReason: params.reason,
        lastMaxErrorCode: params.lastMaxErrorCode ?? null,
        lastMaxErrorMessage: params.lastMaxErrorMessage ?? null,
        lastMaxStatusCode: params.lastMaxStatusCode ?? null,
        source: params.source,
      } satisfies Prisma.ManagedEntityAccessEdgeUpdateManyMutationInput,
    });

    return typeof result.count === 'number' ? result.count : null;
  }

  private readTrimmedString(value: string | null | undefined): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private readCount(value: unknown): number | null {
    const count = (value as { count?: unknown } | null)?.count;
    return typeof count === 'number' ? count : null;
  }

  private buildCleanupReasonMessage(params: {
    reason: ManagedEntityAccessLossReason;
    source: string;
  }): string {
    return `Бот потерял доступ к чату (${params.reason}, ${params.source}); фоновые доставки остановлены.`;
  }
}

export function classifyMaxTerminalChatActionError(
  error: unknown,
): MaxTerminalChatActionErrorClassification | null {
  const statusCode = extractMaxErrorStatus(error);
  const code = extractMaxErrorCode(error);
  const message = extractMaxErrorMessage(error);

  if (code === 'message.not.found' || message.includes('message not found')) {
    return {
      kind: 'message_not_found',
      statusCode,
      code,
      message,
    };
  }

  if (code === 'chat.not.found' || message.includes('chat not found')) {
    return {
      kind: 'managed_entity_access_lost',
      reason: 'chat_not_found',
      statusCode,
      code,
      message,
    };
  }

  if (code === 'chat.denied') {
    return {
      kind: 'managed_entity_access_lost',
      reason: 'bot_denied',
      statusCode,
      code,
      message,
    };
  }

  if (message.includes('bot is not a chat member')) {
    return {
      kind: 'managed_entity_access_lost',
      reason: 'bot_removed',
      statusCode,
      code,
      message,
    };
  }

  if (message.includes('not accessible')) {
    return {
      kind: 'managed_entity_access_lost',
      reason: 'chat_inaccessible',
      statusCode,
      code,
      message,
    };
  }

  if (statusCode === 403 || statusCode === 404) {
    return {
      kind: 'terminal_unknown',
      statusCode,
      code,
      message,
    };
  }

  return null;
}

export function resolveManagedEntityAccessLossReason(
  operation: ManagedEntityAccessLossOperation,
  classification: MaxTerminalChatActionErrorClassification,
): ManagedEntityAccessLossReason | null {
  if (classification.kind === 'managed_entity_access_lost') {
    return classification.reason ?? 'chat_inaccessible';
  }

  if (classification.kind !== 'terminal_unknown') {
    return null;
  }

  if (operation === 'send' || operation === 'read' || operation === 'lookup') {
    if (classification.statusCode === 404) {
      return 'chat_not_found';
    }
    if (classification.statusCode === 403) {
      return 'bot_denied';
    }
  }

  if (operation === 'edit' && classification.statusCode === 403) {
    return 'bot_denied';
  }

  return null;
}

export function extractMaxErrorStatus(error: unknown): number | null {
  const maybeStatus = (error as { response?: { status?: number } })?.response?.status;
  return typeof maybeStatus === 'number' ? maybeStatus : null;
}

export function extractMaxErrorCode(error: unknown): string | null {
  const maybeCode = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  return typeof maybeCode === 'string' && maybeCode.trim().length > 0
    ? maybeCode.trim().toLowerCase()
    : null;
}

export function extractMaxErrorMessage(error: unknown): string {
  const responseMessage = (error as { response?: { data?: { message?: unknown } } })?.response?.data
    ?.message;
  if (typeof responseMessage === 'string' && responseMessage.trim().length > 0) {
    return responseMessage.trim().toLowerCase();
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim().toLowerCase();
  }

  return String(error).trim().toLowerCase();
}

function mapManagedEntityType(entityType: ChatEntityType | null): ManagedEntityType | null {
  if (entityType === ChatEntityType.CHAT) {
    return 'chat';
  }
  if (entityType === ChatEntityType.CHANNEL) {
    return 'channel';
  }
  return null;
}
