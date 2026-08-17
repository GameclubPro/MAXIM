import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChatBotAccessState,
  ChatBotMembershipRole,
  ChatBotMembershipStatus,
  ChatCatalogKind,
  ChatEntityType,
  ChatRoutingState,
  Prisma,
} from '../prisma/prisma-client';
import {
  botOwnershipFoundationSnapshotSchema,
  type BotOwnershipAnomalies,
  type BotOwnershipCoverage,
  type BotOwnershipFoundationSnapshot,
} from '@maxim/contracts';
import Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsAdmin } from '../runtime/app-role';
import { MaxBotLinkService } from './max-bot-link.service';
import { MaxBotRegistryService } from './max-bot-registry.service';
import { canExecuteActionsForBotState, createBotLifecycleStats } from './max-bot-state.util';
import {
  calculatePrimaryAccessScore,
  isFreshMembershipAccessSnapshot,
  membershipExplicitlyLacksAccess,
  normalizeMembershipAccessSnapshot,
  resolvePreferredPrimaryBotId,
} from './max-bot-access-policy.util';
import { resolveWeightedRendezvousOwnerBotId } from './max-bot-ownership-assignment.util';
import type { MaxBotLifecycleState } from './max-bot-config.util';

const BOT_OWNERSHIP_FOUNDATION_STATUS_KEY = 'system:bot-ownership:foundation:v1';
const BOT_OWNERSHIP_FOUNDATION_LOCK_KEY = 'system:bot-ownership:foundation:repair-lock:v1';
const LOCAL_CACHE_TTL_MS = 2_000;

type BotOwnershipRebalanceMode = 'off' | 'shadow' | 'canary' | 'on';

type RepairRuntimeState = {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastAppliedChanges: number;
  totalAppliedChanges: number;
  lastAppliedMoves: number;
};

type OwnershipBotConfig = {
  state: MaxBotLifecycleState;
  ownershipWeight: number;
};

type ChatRecord = {
  id: string;
  entityType: ChatEntityType;
  title: string;
  botId: string | null;
  primaryBotId: string | null;
  catalogKind: ChatCatalogKind;
  routingState: ChatRoutingState;
  routingVersion: number;
};

type MembershipRecord = {
  chatId: string;
  botId: string;
  role: ChatBotMembershipRole;
  status: ChatBotMembershipStatus;
  botAccessState: ChatBotAccessState;
  botAccessCheckedAt: Date | null;
  botAccessExpiresAt: Date | null;
  permissionsSnapshot: unknown | null;
};

type RepairSignal = {
  chatId: string;
  botId: string | null;
  title: string | null;
  lastEventAt: Date;
};

type RawWebhookRepairSignal = {
  chat_id: string | null;
  bot_id: string | null;
  chat_title: string | null;
  created_at: Date;
};

@Injectable()
export class MaxBotOwnershipFoundationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaxBotOwnershipFoundationService.name);
  private readonly redis: Redis;
  private readonly enabled: boolean;
  private readonly repairRunnerEnabled: boolean;
  private readonly activeOnThisRole: boolean;
  private readonly repairIntervalMs: number;
  private readonly repairLockTtlMs: number;
  private readonly repairBatchSize: number;
  private readonly rebalanceMode: BotOwnershipRebalanceMode;
  private readonly rebalanceCanaryPercent: number;
  private readonly rebalanceCanaryEntityIds: ReadonlySet<string>;
  private readonly rebalanceMaxMovesPerRun: number;
  private readonly runtimeState: RepairRuntimeState = {
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastAppliedChanges: 0,
    totalAppliedChanges: 0,
    lastAppliedMoves: 0,
  };
  private timer: NodeJS.Timeout | null = null;
  private cachedSnapshot: BotOwnershipFoundationSnapshot | null = null;
  private cachedAtMs = 0;
  private syncPromise: Promise<void> | null = null;

  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly botRegistry: MaxBotRegistryService,
    private readonly maxBotLinkService: MaxBotLinkService,
  ) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.enabled = configService.get<boolean>('BOT_OWNERSHIP_FOUNDATION_ENABLED', true);
    this.repairRunnerEnabled = configService.get<boolean>(
      'BOT_OWNERSHIP_REPAIR_RUNNER_ENABLED',
      false,
    );
    this.repairIntervalMs = configService.get<number>('BOT_OWNERSHIP_REPAIR_INTERVAL_MS', 300_000);
    this.repairLockTtlMs = configService.get<number>('BOT_OWNERSHIP_REPAIR_LOCK_TTL_MS', 60_000);
    this.repairBatchSize = configService.get<number>('BOT_OWNERSHIP_REPAIR_BATCH_SIZE', 250);
    this.rebalanceMode = configService.get<BotOwnershipRebalanceMode>(
      'BOT_OWNERSHIP_REBALANCE_MODE',
      'shadow',
    );
    this.rebalanceCanaryPercent = configService.get<number>(
      'BOT_OWNERSHIP_REBALANCE_CANARY_PERCENT',
      1,
    );
    this.rebalanceCanaryEntityIds = new Set(
      (configService.get<string>('BOT_OWNERSHIP_REBALANCE_CANARY_ENTITY_IDS', '') ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );
    this.rebalanceMaxMovesPerRun = configService.get<number>(
      'BOT_OWNERSHIP_REBALANCE_MAX_MOVES_PER_RUN',
      25,
    );
    this.activeOnThisRole = this.enabled && this.repairRunnerEnabled && roleRunsAdmin(getAppRole());
  }

  async onModuleInit(): Promise<void> {
    if (!this.activeOnThisRole) {
      return;
    }

    this.timer = setInterval(() => {
      void this.sync('scheduled');
    }, this.repairIntervalMs);
    this.timer.unref?.();

    setTimeout(() => {
      void this.sync('startup').catch((error: unknown) => {
        this.logger.error(
          {
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to run startup bot ownership foundation sync',
        );
      });
    }, 1_000).unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    await this.redis.quit();
  }

  async getSnapshot(maxAgeMs = LOCAL_CACHE_TTL_MS): Promise<BotOwnershipFoundationSnapshot> {
    if (this.cachedSnapshot && Date.now() - this.cachedAtMs <= maxAgeMs) {
      return this.cachedSnapshot;
    }

    const cached = await this.readSnapshotFromRedis();
    if (cached) {
      const normalized = this.applyCurrentRepairRuntime(cached);
      this.cacheSnapshot(normalized);
      return normalized;
    }

    if (!this.enabled || !this.repairRunnerEnabled) {
      const fallback = this.createFallbackSnapshot(null);
      this.cacheSnapshot(fallback);
      return fallback;
    }

    try {
      const built = await this.buildSnapshot();
      this.cacheSnapshot(built);
      return built;
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to build bot ownership foundation snapshot',
      );
      const fallback = this.createFallbackSnapshot(
        error instanceof Error ? error.message : String(error),
      );
      this.cacheSnapshot(fallback);
      return fallback;
    }
  }

  private async sync(reason: 'startup' | 'scheduled'): Promise<void> {
    if (!this.activeOnThisRole) {
      return;
    }

    if (this.syncPromise) {
      return this.syncPromise;
    }

    this.syncPromise = this.runSync(reason);
    try {
      await this.syncPromise;
    } finally {
      this.syncPromise = null;
    }
  }

  private async runSync(reason: 'startup' | 'scheduled'): Promise<void> {
    const nowIso = new Date().toISOString();
    this.runtimeState.lastRunAt = nowIso;
    const lockToken = await this.acquireRepairLock();
    if (!lockToken) {
      const snapshot = await this.buildSnapshot();
      await this.writeSnapshot(snapshot);
      return;
    }

    try {
      const repairResult = await this.repairRecoverableOwnership();
      this.runtimeState.lastAppliedChanges = repairResult.appliedChanges;
      this.runtimeState.totalAppliedChanges += repairResult.appliedChanges;
      this.runtimeState.lastAppliedMoves = repairResult.appliedMoves;
      this.runtimeState.lastSuccessAt = new Date().toISOString();
      this.runtimeState.lastError = null;

      if (repairResult.appliedChanges > 0) {
        this.logger.log(
          {
            reason,
            appliedChanges: repairResult.appliedChanges,
            appliedMoves: repairResult.appliedMoves,
            totalAppliedChanges: this.runtimeState.totalAppliedChanges,
          },
          'Repaired bot ownership foundation anomalies',
        );
      }
    } catch (error: unknown) {
      this.runtimeState.lastError = error instanceof Error ? error.message : String(error);
      this.logger.error(
        {
          err: this.runtimeState.lastError,
          reason,
        },
        'Failed to repair bot ownership foundation anomalies',
      );
    } finally {
      const snapshot = await this.buildSnapshot();
      await this.writeSnapshot(snapshot);
      await this.releaseRepairLock(lockToken);
    }
  }

  private async repairRecoverableOwnership(): Promise<{
    appliedChanges: number;
    appliedMoves: number;
  }> {
    const configuredBots = this.botRegistry.getAllBots();
    const knownBotIds = new Set(configuredBots.map((bot) => bot.id));
    const botConfigs = new Map<string, OwnershipBotConfig>(
      configuredBots.map((bot) => [
        bot.id,
        { state: bot.state, ownershipWeight: bot.ownershipWeight },
      ]),
    );
    const eligiblePrimaryBotIds = new Set(
      this.botRegistry
        .getAllBots()
        .filter((bot) => canExecuteActionsForBotState(bot.state))
        .map((bot) => bot.id),
    );
    const [chats, memberships] = await Promise.all([
      this.prisma.chat.findMany({
        select: {
          id: true,
          entityType: true,
          title: true,
          botId: true,
          primaryBotId: true,
          catalogKind: true,
          routingState: true,
          routingVersion: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.chatBotMembership.findMany({
        select: {
          chatId: true,
          botId: true,
          role: true,
          status: true,
          botAccessState: true,
          botAccessCheckedAt: true,
          botAccessExpiresAt: true,
          permissionsSnapshot: true,
        },
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'asc' }],
      }),
    ]);

    const membershipsByChat = this.groupMembershipsByChat(memberships);
    const localActivityRepairByChat = await this.loadLocalActivityRepairSignals(
      chats,
      membershipsByChat,
      knownBotIds,
    );
    const webhookRepairByChat = await this.loadWebhookRepairSignals(
      chats,
      membershipsByChat,
      knownBotIds,
    );
    const repairSignalsByChat = this.mergeRepairSignals(
      localActivityRepairByChat,
      webhookRepairByChat,
    );
    let appliedChanges = 0;
    let appliedMoves = 0;

    for (const chat of chats) {
      if (!this.isManagedOwnershipChat(chat)) {
        continue;
      }

      if (appliedChanges >= this.repairBatchSize) {
        break;
      }

      const chatMemberships = membershipsByChat.get(chat.id) ?? [];
      const canApplyOwnershipWrite = this.shouldApplyRebalance(chat.id);
      const canApplyRebalance =
        appliedMoves < this.rebalanceMaxMovesPerRun && canApplyOwnershipWrite;
      const repair = this.planChatRepair(
        chat,
        chatMemberships,
        knownBotIds,
        eligiblePrimaryBotIds,
        botConfigs,
        canApplyRebalance,
        repairSignalsByChat.get(chat.id) ?? null,
      );
      if (!repair) {
        continue;
      }
      const shouldApplyRoutingState = chat.routingState !== repair.nextRoutingState;
      if (!canApplyOwnershipWrite) {
        continue;
      }

      const operations: Prisma.PrismaPromise<unknown>[] = [];
      const chatUpdateData: Prisma.ChatUpdateInput = {};
      let plannedOwnershipMove = false;
      if (repair.nextPrimaryBotId) {
        const desiredPrimaryBotId = repair.nextPrimaryBotId;
        if (chat.primaryBotId !== desiredPrimaryBotId || chat.botId !== desiredPrimaryBotId) {
          chatUpdateData.primaryBotId = desiredPrimaryBotId;
          chatUpdateData.botId = desiredPrimaryBotId;
          chatUpdateData.routingVersion = { increment: 1 };
          if (chat.primaryBotId && chat.primaryBotId !== desiredPrimaryBotId) {
            plannedOwnershipMove = true;
          }
        }

        operations.push(
          this.prisma.chatBotMembership.updateMany({
            where: {
              chatId: chat.id,
              botId: { in: [desiredPrimaryBotId] },
              status: ChatBotMembershipStatus.ACTIVE,
            },
            data: {
              role: ChatBotMembershipRole.PRIMARY,
            },
          }),
        );

        if (repair.activeKnownStandbyBotIds.length > 0) {
          operations.push(
            this.prisma.chatBotMembership.updateMany({
              where: {
                chatId: chat.id,
                botId: { in: repair.activeKnownStandbyBotIds },
                status: ChatBotMembershipStatus.ACTIVE,
              },
              data: {
                role: ChatBotMembershipRole.STANDBY,
              },
            }),
          );
        }
      } else if (repair.clearPrimary && (chat.primaryBotId || chat.botId)) {
        chatUpdateData.primaryBotId = null;
        chatUpdateData.botId = null;
        chatUpdateData.routingVersion = { increment: 1 };

        if (repair.activeKnownStandbyBotIds.length > 0) {
          operations.push(
            this.prisma.chatBotMembership.updateMany({
              where: {
                chatId: chat.id,
                botId: { in: repair.activeKnownStandbyBotIds },
                status: ChatBotMembershipStatus.ACTIVE,
              },
              data: {
                role: ChatBotMembershipRole.STANDBY,
              },
            }),
          );
        }
      }
      if (repair.nextTitle) {
        chatUpdateData.title = repair.nextTitle;
      }
      if (operations.length > 0 && Object.keys(chatUpdateData).length === 0) {
        chatUpdateData.routingVersion = { increment: 1 };
      }
      if (Object.keys(chatUpdateData).length > 0) {
        operations.push(
          this.prisma.chat.update({
            where: {
              id: chat.id,
              routingVersion: chat.routingVersion,
            },
            data: chatUpdateData,
          }),
        );
      }

      if (operations.length > 0) {
        try {
          await this.prisma.$transaction(operations);
        } catch (error: unknown) {
          if (this.isRoutingVersionConflict(error)) {
            this.logger.debug(
              { chatId: chat.id, routingVersion: chat.routingVersion },
              'Skipped stale bot ownership repair after routing version changed',
            );
            continue;
          }
          throw error;
        }
        appliedChanges += operations.length;
        if (plannedOwnershipMove) {
          appliedMoves += 1;
        }
      }

      const routingResult = shouldApplyRoutingState
        ? await this.maxBotLinkService.reconcileChatRoutingState?.({ chatId: chat.id })
        : null;
      if (routingResult?.changed) {
        appliedChanges += 1;
      }
      if (operations.length === 0 && !routingResult?.changed) {
        continue;
      }

      if (routingResult?.routingState === ChatRoutingState.NO_ELIGIBLE_BOT) {
        this.maxBotLinkService.forgetChatBotBinding(chat.id);
      } else if (repair.nextPrimaryBotId) {
        this.maxBotLinkService.rememberChatBotBinding(chat.id, repair.nextPrimaryBotId);
      } else if (repair.clearPrimary) {
        this.maxBotLinkService.forgetChatBotBinding(chat.id);
      }
    }

    return { appliedChanges, appliedMoves };
  }

  private planChatRepair(
    chat: ChatRecord,
    memberships: readonly MembershipRecord[],
    knownBotIds: ReadonlySet<string>,
    eligiblePrimaryBotIds: ReadonlySet<string>,
    botConfigs: ReadonlyMap<string, OwnershipBotConfig>,
    rebalance: boolean,
    repairSignal: RepairSignal | null = null,
  ): {
    nextPrimaryBotId: string | null;
    clearPrimary: boolean;
    nextTitle: string | null;
    nextRoutingState: ChatRoutingState;
    activeKnownStandbyBotIds: string[];
  } | null {
    const primaryKnown = this.readKnownBotId(chat.primaryBotId, knownBotIds);
    const rawPrimaryEligible = this.readKnownBotId(chat.primaryBotId, eligiblePrimaryBotIds);
    const rawLegacyEligible = this.readKnownBotId(chat.botId, eligiblePrimaryBotIds);
    const rawSignalEligible = this.readKnownBotId(
      repairSignal?.botId ?? null,
      eligiblePrimaryBotIds,
    );
    const nextTitle = this.resolveRepairTitle(chat, repairSignal);
    const hasUnknownPrimary = Boolean(chat.primaryBotId && !primaryKnown);

    const activeKnownMemberships = memberships.filter(
      (membership) =>
        membership.status === ChatBotMembershipStatus.ACTIVE && knownBotIds.has(membership.botId),
    );
    const isAccessEligible = (botId: string | null): boolean => {
      if (!botId) {
        return false;
      }
      const membership = memberships.find((candidate) => candidate.botId === botId) ?? null;
      if (!membership) {
        return false;
      }
      if (membership.status !== ChatBotMembershipStatus.ACTIVE) {
        return false;
      }
      if (this.membershipHasStructuredAccessLoss(membership)) {
        return false;
      }
      if (!this.isConfirmedOwnershipMembership(membership)) {
        return false;
      }
      return membership.status === ChatBotMembershipStatus.ACTIVE;
    };
    const primaryEligible = isAccessEligible(rawPrimaryEligible) ? rawPrimaryEligible : null;
    const primaryPotential = activeKnownMemberships.some(
      (membership) =>
        membership.botId === rawPrimaryEligible &&
        eligiblePrimaryBotIds.has(membership.botId) &&
        this.isPotentialOwnershipMembership(membership),
    );
    const legacyEligible = isAccessEligible(rawLegacyEligible) ? rawLegacyEligible : null;
    const signalEligible = isAccessEligible(rawSignalEligible) ? rawSignalEligible : null;
    const hasIneligiblePrimary = Boolean(primaryKnown && !primaryPotential);

    const activeEligibleMemberships = activeKnownMemberships.filter(
      (membership) =>
        eligiblePrimaryBotIds.has(membership.botId) &&
        this.isConfirmedOwnershipMembership(membership),
    );
    const activePotentialMemberships = activeKnownMemberships.filter(
      (membership) =>
        eligiblePrimaryBotIds.has(membership.botId) &&
        this.isPotentialOwnershipMembership(membership),
    );
    const nextRoutingState =
      activeEligibleMemberships.length > 0
        ? ChatRoutingState.READY
        : activePotentialMemberships.length === 0
          ? ChatRoutingState.NO_ELIGIBLE_BOT
          : chat.routingState;
    const activePrimaryMembership = activeEligibleMemberships.find(
      (membership) => membership.role === ChatBotMembershipRole.PRIMARY,
    );
    const hasActivePrimaryMembership =
      primaryEligible !== null &&
      activeKnownMemberships.some((membership) => membership.botId === primaryEligible);
    const hasRemovedPrimaryMembership =
      primaryKnown !== null &&
      memberships.some(
        (membership) =>
          membership.botId === primaryKnown &&
          membership.status === ChatBotMembershipStatus.REMOVED,
      );

    let nextPrimaryBotId: string | null = hasUnknownPrimary
      ? null
      : (primaryEligible ?? (primaryPotential ? rawPrimaryEligible : null));
    if (!chat.primaryBotId || hasUnknownPrimary || hasIneligiblePrimary) {
      if (activePrimaryMembership) {
        nextPrimaryBotId = activePrimaryMembership.botId;
      } else {
        const legacyObservedMembership = legacyEligible
          ? activeEligibleMemberships.find((membership) => membership.botId === legacyEligible)
          : null;
        if (legacyObservedMembership) {
          nextPrimaryBotId = legacyObservedMembership.botId;
        } else if (activeEligibleMemberships[0]) {
          nextPrimaryBotId = activeEligibleMemberships[0].botId;
        } else if (legacyEligible) {
          nextPrimaryBotId = legacyEligible;
        } else if (signalEligible) {
          nextPrimaryBotId = signalEligible;
        }
      }
    } else if (primaryEligible && !hasActivePrimaryMembership && hasRemovedPrimaryMembership) {
      if (activePrimaryMembership) {
        nextPrimaryBotId = activePrimaryMembership.botId;
      } else if (activeEligibleMemberships[0]) {
        nextPrimaryBotId = activeEligibleMemberships[0].botId;
      } else {
        nextPrimaryBotId = null;
      }
    }

    const strongestAccessBotId = resolvePreferredPrimaryBotId(
      nextPrimaryBotId,
      activeEligibleMemberships,
      {
        requireFreshSnapshotForPromotion: true,
      },
    );
    if (strongestAccessBotId) {
      nextPrimaryBotId = strongestAccessBotId;
    }

    if (rebalance || !nextPrimaryBotId) {
      const rendezvousBotId = this.resolveRendezvousOwnerBotId(
        chat.id,
        activeEligibleMemberships,
        botConfigs,
      );
      if (rendezvousBotId) {
        nextPrimaryBotId = rendezvousBotId;
      }
    }

    const clearPrimary = Boolean(
      !nextPrimaryBotId &&
      (chat.primaryBotId || chat.botId) &&
      (hasUnknownPrimary || hasIneligiblePrimary || hasRemovedPrimaryMembership),
    );
    if (
      !nextPrimaryBotId &&
      !clearPrimary &&
      !nextTitle &&
      chat.routingState === nextRoutingState
    ) {
      return null;
    }

    const activeKnownStandbyBotIds = activeKnownMemberships
      .filter((membership) => !nextPrimaryBotId || membership.botId !== nextPrimaryBotId)
      .map((membership) => membership.botId);

    const shouldRepairOwnership = Boolean(
      nextPrimaryBotId &&
      (chat.primaryBotId !== nextPrimaryBotId ||
        chat.botId !== nextPrimaryBotId ||
        !activeKnownMemberships.some(
          (membership) =>
            membership.botId === nextPrimaryBotId &&
            membership.role === ChatBotMembershipRole.PRIMARY,
        ) ||
        activeKnownMemberships.some(
          (membership) =>
            membership.botId !== nextPrimaryBotId &&
            membership.role !== ChatBotMembershipRole.STANDBY,
        ) ||
        activeKnownMemberships.some(
          (membership) =>
            membership.botId === nextPrimaryBotId &&
            membership.role !== ChatBotMembershipRole.PRIMARY,
        )),
    );

    if (
      !shouldRepairOwnership &&
      !clearPrimary &&
      !nextTitle &&
      chat.routingState === nextRoutingState
    ) {
      return null;
    }

    return {
      nextPrimaryBotId,
      clearPrimary,
      nextTitle,
      nextRoutingState,
      activeKnownStandbyBotIds,
    };
  }

  private async loadLocalActivityRepairSignals(
    chats: readonly ChatRecord[],
    membershipsByChat: ReadonlyMap<string, readonly MembershipRecord[]>,
    knownBotIds: ReadonlySet<string>,
  ): Promise<Map<string, RepairSignal>> {
    const knownBotIdList = Array.from(knownBotIds);
    if (knownBotIdList.length === 0) {
      return new Map();
    }

    const candidateChatIds = chats
      .filter((chat) =>
        this.shouldUseLocalActivityRepairSignal(
          chat,
          membershipsByChat.get(chat.id) ?? [],
          knownBotIds,
        ),
      )
      .map((chat) => chat.id);
    if (candidateChatIds.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.managedEntityLocalActivity.findMany({
      where: {
        chatId: { in: candidateChatIds },
        OR: [{ botId: { in: knownBotIdList } }, { chatTitle: { not: null } }],
      },
      select: {
        chatId: true,
        botId: true,
        chatTitle: true,
        lastEventAt: true,
      },
      orderBy: [{ chatId: 'asc' }, { lastEventAt: 'desc' }],
    });

    const result = new Map<string, RepairSignal>();
    for (const row of rows as Array<{
      chatId: string;
      botId: string | null;
      chatTitle: string | null;
      lastEventAt: Date;
    }>) {
      const botId = this.readKnownBotId(row.botId, knownBotIds);
      const title = this.readTrimmedString(row.chatTitle);
      if ((!botId && !title) || result.has(row.chatId)) {
        continue;
      }
      result.set(row.chatId, {
        chatId: row.chatId,
        botId,
        title,
        lastEventAt: row.lastEventAt,
      });
    }

    return result;
  }

  private async loadWebhookRepairSignals(
    chats: readonly ChatRecord[],
    membershipsByChat: ReadonlyMap<string, readonly MembershipRecord[]>,
    knownBotIds: ReadonlySet<string>,
  ): Promise<Map<string, RepairSignal>> {
    const knownBotIdList = Array.from(knownBotIds);
    if (knownBotIdList.length === 0) {
      return new Map();
    }

    const candidateChatIds = [
      ...new Set(
        chats
          .filter((chat) =>
            this.shouldUseWebhookRepairSignal(
              chat,
              membershipsByChat.get(chat.id) ?? [],
              knownBotIds,
            ),
          )
          .map((chat) => chat.id.trim())
          .filter(Boolean),
      ),
    ];
    if (candidateChatIds.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.$queryRaw<RawWebhookRepairSignal[]>(Prisma.sql`
      SELECT
        selected.chat_id,
        event_row.bot_id,
        event_row.chat_title,
        event_row.created_at
      FROM unnest(ARRAY[${Prisma.join(candidateChatIds)}]::text[]) AS selected(chat_id)
      JOIN LATERAL (
        SELECT bot_event.bot_id, bot_event.chat_title, bot_event.created_at
        FROM unnest(ARRAY[${Prisma.join(knownBotIdList)}]::text[]) AS selected_bot(bot_id)
        JOIN LATERAL (
          SELECT
            NULLIF(BTRIM(webhook_events.bot_id), '') AS bot_id,
            COALESCE(
              NULLIF(BTRIM(normalized_payload->'message'->>'chatTitle'), ''),
              NULLIF(BTRIM(normalized_payload->>'chatTitle'), '')
            ) AS chat_title,
            created_at
          FROM webhook_events
          WHERE webhook_events.bot_id = selected_bot.bot_id
            AND created_at >= now() - interval '30 days'
            AND COALESCE(
              NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), ''),
              NULLIF(BTRIM(normalized_payload->>'chatId'), '')
            ) = selected.chat_id
          ORDER BY created_at DESC
          LIMIT 1
        ) bot_event ON TRUE
        ORDER BY bot_event.created_at DESC
        LIMIT 1
      ) event_row ON TRUE
      WHERE event_row.bot_id IS NOT NULL
         OR event_row.chat_title IS NOT NULL
    `);

    const result = new Map<string, RepairSignal>();
    for (const row of rows) {
      const chatId = this.readTrimmedString(row.chat_id);
      if (!chatId || result.has(chatId)) {
        continue;
      }

      const botId = this.readKnownBotId(row.bot_id, knownBotIds);
      const title = this.readTrimmedString(row.chat_title);
      if (!botId && !title) {
        continue;
      }

      result.set(chatId, {
        chatId,
        botId,
        title,
        lastEventAt: row.created_at,
      });
    }

    return result;
  }

  private mergeRepairSignals(
    first: ReadonlyMap<string, RepairSignal>,
    second: ReadonlyMap<string, RepairSignal>,
  ): Map<string, RepairSignal> {
    const result = new Map(first);
    for (const signal of second.values()) {
      const existing = result.get(signal.chatId);
      if (!existing) {
        result.set(signal.chatId, signal);
        continue;
      }

      if (signal.lastEventAt.getTime() >= existing.lastEventAt.getTime()) {
        result.set(signal.chatId, {
          chatId: signal.chatId,
          botId: signal.botId ?? existing.botId,
          title: signal.title ?? existing.title,
          lastEventAt: signal.lastEventAt,
        });
        continue;
      }

      result.set(signal.chatId, {
        chatId: existing.chatId,
        botId: existing.botId ?? signal.botId,
        title: existing.title ?? signal.title,
        lastEventAt: existing.lastEventAt,
      });
    }

    return result;
  }

  private shouldUseLocalActivityRepairSignal(
    chat: ChatRecord,
    memberships: readonly MembershipRecord[],
    knownBotIds: ReadonlySet<string>,
  ): boolean {
    if (this.isFallbackTitle(chat.id, chat.title)) {
      return true;
    }

    if (chat.primaryBotId || chat.botId) {
      return false;
    }

    return !memberships.some(
      (membership) =>
        membership.status === ChatBotMembershipStatus.ACTIVE && knownBotIds.has(membership.botId),
    );
  }

  private shouldUseWebhookRepairSignal(
    chat: ChatRecord,
    memberships: readonly MembershipRecord[],
    knownBotIds: ReadonlySet<string>,
  ): boolean {
    if (chat.primaryBotId || chat.botId) {
      return false;
    }

    return !memberships.some(
      (membership) =>
        membership.status === ChatBotMembershipStatus.ACTIVE && knownBotIds.has(membership.botId),
    );
  }

  private async buildSnapshot(): Promise<BotOwnershipFoundationSnapshot> {
    const [chats, memberships] = await Promise.all([
      this.prisma.chat.findMany({
        select: {
          id: true,
          entityType: true,
          title: true,
          botId: true,
          primaryBotId: true,
          catalogKind: true,
          routingState: true,
          routingVersion: true,
        },
      }),
      this.prisma.chatBotMembership.findMany({
        select: {
          chatId: true,
          botId: true,
          role: true,
          status: true,
          botAccessState: true,
          botAccessCheckedAt: true,
          botAccessExpiresAt: true,
          permissionsSnapshot: true,
        },
      }),
    ]);

    const knownBotIds = new Set(this.botRegistry.getAllBots().map((bot) => bot.id));
    const executableBotIds = new Set(
      this.botRegistry
        .getAllBots()
        .filter((bot) => canExecuteActionsForBotState(bot.state))
        .map((bot) => bot.id),
    );
    const membershipsByChat = this.groupMembershipsByChat(memberships);
    const anomalies = this.createEmptyAnomalies();
    const totalCoverage = this.createCoverageAccumulator();
    const chatCoverage = this.createCoverageAccumulator();
    const channelCoverage = this.createCoverageAccumulator();
    const routingStates = {
      ready: 0,
      noEligibleBot: 0,
    };

    for (const chat of chats) {
      if (!this.isManagedOwnershipChat(chat)) {
        continue;
      }

      if (chat.routingState === ChatRoutingState.NO_ELIGIBLE_BOT) {
        routingStates.noEligibleBot += 1;
      } else {
        routingStates.ready += 1;
      }

      const chatMemberships = membershipsByChat.get(chat.id) ?? [];
      const activeKnownMemberships = chatMemberships.filter(
        (membership) =>
          membership.status === ChatBotMembershipStatus.ACTIVE && knownBotIds.has(membership.botId),
      );
      const activeEligibleMemberships = activeKnownMemberships.filter(
        (membership) =>
          executableBotIds.has(membership.botId) &&
          !this.membershipHasStructuredAccessLoss(membership) &&
          !membershipExplicitlyLacksAccess(membership.permissionsSnapshot),
      );
      const hasActiveUnknownMembership = chatMemberships.some(
        (membership) =>
          membership.status === ChatBotMembershipStatus.ACTIVE &&
          !knownBotIds.has(membership.botId),
      );
      const primaryKnown = this.readKnownBotId(chat.primaryBotId, knownBotIds);
      const legacyKnown = this.readKnownBotId(chat.botId, knownBotIds);
      const isStoredBotEligible = (botId: string | null): boolean => {
        if (!botId || !executableBotIds.has(botId)) {
          return false;
        }
        const membership = chatMemberships.find((candidate) => candidate.botId === botId) ?? null;
        return (
          membership?.status === ChatBotMembershipStatus.ACTIVE &&
          !this.membershipHasStructuredAccessLoss(membership) &&
          !membershipExplicitlyLacksAccess(membership.permissionsSnapshot)
        );
      };
      const legacyRouteEligible = isStoredBotEligible(legacyKnown);
      const hasEligibleBot =
        activeEligibleMemberships.length > 0 ||
        isStoredBotEligible(primaryKnown) ||
        legacyRouteEligible;
      if (!hasEligibleBot) {
        anomalies.noEligibleBot += 1;
      }
      totalCoverage.total += 1;
      if (primaryKnown) {
        totalCoverage.withPrimary += 1;
      } else {
        totalCoverage.withoutPrimary += 1;
      }

      if (chat.entityType === ChatEntityType.CHANNEL) {
        channelCoverage.total += 1;
        if (primaryKnown) {
          channelCoverage.withPrimary += 1;
        } else {
          channelCoverage.withoutPrimary += 1;
        }
      } else if (chat.entityType === ChatEntityType.CHAT) {
        chatCoverage.total += 1;
        if (primaryKnown) {
          chatCoverage.withPrimary += 1;
        } else {
          chatCoverage.withoutPrimary += 1;
        }
      }

      if (!chat.primaryBotId) {
        anomalies.noPrimary += 1;

        if (activeEligibleMemberships.length > 0) {
          anomalies.recoverableFromMemberships += 1;
        } else if (legacyRouteEligible) {
          anomalies.recoverableLegacyOnly += 1;
        } else if (chat.botId) {
          if (!legacyKnown) {
            anomalies.legacyBotUnknown += 1;
          }
        } else if (activeKnownMemberships.length === 0) {
          anomalies.unbound += 1;
        }
      } else if (!primaryKnown) {
        anomalies.primaryBotUnknown += 1;
      }

      if (
        chat.primaryBotId &&
        primaryKnown &&
        !activeKnownMemberships.some((m) => m.botId === primaryKnown)
      ) {
        anomalies.primaryWithoutActiveMembership += 1;
      }

      const primaryActiveMembership =
        primaryKnown !== null
          ? (activeKnownMemberships.find((membership) => membership.botId === primaryKnown) ?? null)
          : null;
      if (membershipExplicitlyLacksAccess(primaryActiveMembership?.permissionsSnapshot ?? null)) {
        anomalies.primaryWithoutAdminAccess += 1;
      }

      if (hasActiveUnknownMembership) {
        anomalies.activeMembershipBotUnknown += 1;
      }

      if (activeKnownMemberships.length > 1) {
        anomalies.sharedChats += 1;
      }
    }

    const parsed = botOwnershipFoundationSnapshotSchema.parse({
      generatedAt: new Date().toISOString(),
      bots: createBotLifecycleStats(this.botRegistry.getAllBots()),
      entities: {
        total: this.finalizeCoverage(totalCoverage),
        chats: this.finalizeCoverage(chatCoverage),
        channels: this.finalizeCoverage(channelCoverage),
      },
      routingStates,
      anomalies,
      repair: {
        enabled: this.enabled && this.repairRunnerEnabled,
        activeOnThisRole: this.activeOnThisRole,
        intervalMs: this.repairIntervalMs,
        rebalanceMode: this.rebalanceMode,
        rebalanceCanaryPercent: this.rebalanceCanaryPercent,
        rebalanceMaxMovesPerRun: this.rebalanceMaxMovesPerRun,
        recommendedMoves: this.countRecommendedOwnershipMoves(chats, membershipsByChat),
        lastAppliedMoves: this.runtimeState.lastAppliedMoves,
        lastRunAt: this.runtimeState.lastRunAt,
        lastSuccessAt: this.runtimeState.lastSuccessAt,
        lastError: this.runtimeState.lastError,
        lastAppliedChanges: this.runtimeState.lastAppliedChanges,
        totalAppliedChanges: this.runtimeState.totalAppliedChanges,
      },
    });

    return parsed;
  }

  private createFallbackSnapshot(lastError: string | null): BotOwnershipFoundationSnapshot {
    return {
      generatedAt: new Date().toISOString(),
      bots: createBotLifecycleStats(this.botRegistry.getAllBots()),
      entities: {
        total: this.finalizeCoverage(this.createCoverageAccumulator()),
        chats: this.finalizeCoverage(this.createCoverageAccumulator()),
        channels: this.finalizeCoverage(this.createCoverageAccumulator()),
      },
      routingStates: {
        ready: 0,
        noEligibleBot: 0,
      },
      anomalies: this.createEmptyAnomalies(),
      repair: {
        enabled: this.enabled && this.repairRunnerEnabled,
        activeOnThisRole: this.activeOnThisRole,
        intervalMs: this.repairIntervalMs,
        rebalanceMode: this.rebalanceMode,
        rebalanceCanaryPercent: this.rebalanceCanaryPercent,
        rebalanceMaxMovesPerRun: this.rebalanceMaxMovesPerRun,
        recommendedMoves: 0,
        lastAppliedMoves: this.runtimeState.lastAppliedMoves,
        lastRunAt: this.runtimeState.lastRunAt,
        lastSuccessAt: this.runtimeState.lastSuccessAt,
        lastError,
        lastAppliedChanges: this.runtimeState.lastAppliedChanges,
        totalAppliedChanges: this.runtimeState.totalAppliedChanges,
      },
    };
  }

  private resolveRendezvousOwnerBotId(
    chatId: string,
    memberships: readonly MembershipRecord[],
    botConfigs: ReadonlyMap<string, OwnershipBotConfig>,
  ): string | null {
    const scoredCandidates = memberships
      .map((membership) => {
        const bot = botConfigs.get(membership.botId);
        const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
        if (
          !bot ||
          this.membershipHasStructuredAccessLoss(membership) ||
          !isFreshMembershipAccessSnapshot(snapshot)
        ) {
          return null;
        }
        return {
          membership,
          bot,
          score: calculatePrimaryAccessScore(snapshot),
        };
      })
      .filter(
        (
          candidate,
        ): candidate is {
          membership: MembershipRecord;
          bot: OwnershipBotConfig;
          score: number;
        } => candidate !== null,
      );
    if (scoredCandidates.length === 0) {
      return null;
    }

    const strongestScore = Math.max(...scoredCandidates.map((candidate) => candidate.score));
    return resolveWeightedRendezvousOwnerBotId(
      chatId,
      scoredCandidates
        .filter((candidate) => candidate.score === strongestScore)
        .map((candidate) => ({
          botId: candidate.membership.botId,
          membershipStatus: candidate.membership.status,
          lifecycleState: candidate.bot.state,
          capabilityEligible: true,
          botAccessState: candidate.membership.botAccessState,
          permissionsSnapshot: candidate.membership.permissionsSnapshot,
          ownershipWeight: candidate.bot.ownershipWeight,
        })),
    );
  }

  private countRecommendedOwnershipMoves(
    chats: readonly ChatRecord[],
    membershipsByChat: ReadonlyMap<string, readonly MembershipRecord[]>,
  ): number {
    const botConfigs = new Map<string, OwnershipBotConfig>(
      this.botRegistry
        .getAllBots()
        .map((bot) => [bot.id, { state: bot.state, ownershipWeight: bot.ownershipWeight }]),
    );
    let recommendedMoves = 0;

    for (const chat of chats) {
      if (!this.isManagedOwnershipChat(chat)) {
        continue;
      }
      const desiredBotId = this.resolveRendezvousOwnerBotId(
        chat.id,
        membershipsByChat.get(chat.id) ?? [],
        botConfigs,
      );
      if (desiredBotId && desiredBotId !== chat.primaryBotId) {
        recommendedMoves += 1;
      }
    }

    return recommendedMoves;
  }

  private shouldApplyRebalance(chatId: string): boolean {
    if (this.rebalanceMode === 'on') {
      return true;
    }
    if (this.rebalanceMode !== 'canary' || this.rebalanceCanaryPercent <= 0) {
      return false;
    }
    if (!this.rebalanceCanaryEntityIds.has('*') && !this.rebalanceCanaryEntityIds.has(chatId)) {
      return false;
    }
    if (this.rebalanceCanaryPercent >= 100) {
      return true;
    }

    const cohortValue = createHash('sha256').update(chatId).digest().readUInt32BE(0);
    return (cohortValue / 0x1_0000_0000) * 100 < this.rebalanceCanaryPercent;
  }

  private membershipHasStructuredAccessLoss(
    membership: Pick<MembershipRecord, 'botAccessState'>,
  ): boolean {
    return (
      membership.botAccessState === ChatBotAccessState.DENIED ||
      membership.botAccessState === ChatBotAccessState.LOST
    );
  }

  private isRoutingVersionConflict(error: unknown): boolean {
    return (error as { code?: unknown } | null)?.code === 'P2025';
  }

  private isConfirmedOwnershipMembership(membership: MembershipRecord): boolean {
    if (
      membership.botAccessState !== ChatBotAccessState.CONFIRMED_ADMIN &&
      membership.botAccessState !== ChatBotAccessState.CONFIRMED_OWNER
    ) {
      return false;
    }
    if (
      this.membershipHasStructuredAccessLoss(membership) ||
      membershipExplicitlyLacksAccess(membership.permissionsSnapshot)
    ) {
      return false;
    }

    const expiresAtMs = membership.botAccessExpiresAt?.getTime() ?? Number.NaN;
    if (Number.isFinite(expiresAtMs)) {
      return expiresAtMs > Date.now();
    }
    return isFreshMembershipAccessSnapshot(
      normalizeMembershipAccessSnapshot(membership.permissionsSnapshot),
    );
  }

  private isPotentialOwnershipMembership(membership: MembershipRecord): boolean {
    if (this.membershipHasStructuredAccessLoss(membership)) {
      return false;
    }
    const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
    return !(
      membershipExplicitlyLacksAccess(membership.permissionsSnapshot) &&
      isFreshMembershipAccessSnapshot(snapshot)
    );
  }

  private isManagedOwnershipChat(chat: ChatRecord): boolean {
    return (
      chat.catalogKind === ChatCatalogKind.MANAGED ||
      (chat.catalogKind === ChatCatalogKind.UNKNOWN && chat.entityType === ChatEntityType.CHANNEL)
    );
  }

  private async readSnapshotFromRedis(): Promise<BotOwnershipFoundationSnapshot | null> {
    try {
      const raw = await this.redis.get(BOT_OWNERSHIP_FOUNDATION_STATUS_KEY);
      if (!raw) {
        return null;
      }

      const parsed = botOwnershipFoundationSnapshotSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to load bot ownership foundation snapshot from Redis',
      );
      return null;
    }
  }

  private applyCurrentRepairRuntime(
    snapshot: BotOwnershipFoundationSnapshot,
  ): BotOwnershipFoundationSnapshot {
    return {
      ...snapshot,
      repair: {
        ...snapshot.repair,
        enabled: this.enabled && this.repairRunnerEnabled,
        activeOnThisRole: this.activeOnThisRole,
      },
    };
  }

  private async writeSnapshot(snapshot: BotOwnershipFoundationSnapshot): Promise<void> {
    this.cacheSnapshot(snapshot);
    await this.redis.set(BOT_OWNERSHIP_FOUNDATION_STATUS_KEY, JSON.stringify(snapshot));
  }

  private cacheSnapshot(snapshot: BotOwnershipFoundationSnapshot): void {
    this.cachedSnapshot = snapshot;
    this.cachedAtMs = Date.now();
  }

  private async acquireRepairLock(): Promise<string | null> {
    const token = `${process.pid}:${randomUUID()}`;
    const result = await this.redis.set(
      BOT_OWNERSHIP_FOUNDATION_LOCK_KEY,
      token,
      'PX',
      this.repairLockTtlMs,
      'NX',
    );
    return result === 'OK' ? token : null;
  }

  private async releaseRepairLock(token: string): Promise<void> {
    try {
      const currentToken = await this.redis.get(BOT_OWNERSHIP_FOUNDATION_LOCK_KEY);
      if (currentToken === token) {
        await this.redis.del(BOT_OWNERSHIP_FOUNDATION_LOCK_KEY);
      }
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to release bot ownership repair lock cleanly',
      );
    }
  }

  private groupMembershipsByChat(
    memberships: readonly MembershipRecord[],
  ): Map<string, MembershipRecord[]> {
    const grouped = new Map<string, MembershipRecord[]>();
    for (const membership of memberships) {
      const bucket = grouped.get(membership.chatId);
      if (bucket) {
        bucket.push(membership);
      } else {
        grouped.set(membership.chatId, [membership]);
      }
    }
    return grouped;
  }

  private readKnownBotId(
    botId: string | null | undefined,
    knownBotIds: ReadonlySet<string>,
  ): string | null {
    return typeof botId === 'string' && knownBotIds.has(botId) ? botId : null;
  }

  private resolveRepairTitle(chat: ChatRecord, signal: RepairSignal | null): string | null {
    const nextTitle = this.readTrimmedString(signal?.title);
    if (!nextTitle || this.isFallbackTitle(chat.id, nextTitle)) {
      return null;
    }

    if (!this.isFallbackTitle(chat.id, chat.title)) {
      return null;
    }

    const currentTitle = this.readTrimmedString(chat.title);
    return currentTitle === nextTitle ? null : nextTitle;
  }

  private readTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  private isFallbackTitle(chatId: string, title: string | null | undefined): boolean {
    const normalizedTitle = this.readTrimmedString(title);
    return normalizedTitle === `Chat ${chatId}` || normalizedTitle === `Channel ${chatId}`;
  }

  private createCoverageAccumulator() {
    return {
      total: 0,
      withPrimary: 0,
      withoutPrimary: 0,
    };
  }

  private finalizeCoverage(input: {
    total: number;
    withPrimary: number;
    withoutPrimary: number;
  }): BotOwnershipCoverage {
    const total = input.total;
    return {
      total,
      withPrimary: input.withPrimary,
      withoutPrimary: input.withoutPrimary,
      coverageRatio: total > 0 ? input.withPrimary / total : 1,
    };
  }

  private createEmptyAnomalies(): BotOwnershipAnomalies {
    return {
      noPrimary: 0,
      recoverableLegacyOnly: 0,
      recoverableFromMemberships: 0,
      noEligibleBot: 0,
      unbound: 0,
      primaryBotUnknown: 0,
      legacyBotUnknown: 0,
      activeMembershipBotUnknown: 0,
      primaryWithoutActiveMembership: 0,
      primaryWithoutAdminAccess: 0,
      sharedChats: 0,
    };
  }
}

export { BOT_OWNERSHIP_FOUNDATION_STATUS_KEY };
