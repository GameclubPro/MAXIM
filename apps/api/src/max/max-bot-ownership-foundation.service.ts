import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChatBotMembershipRole,
  ChatBotMembershipStatus,
  ChatEntityType,
  Prisma,
} from '@prisma/client';
import {
  botOwnershipFoundationSnapshotSchema,
  type BotOwnershipAnomalies,
  type BotOwnershipCoverage,
  type BotOwnershipFoundationSnapshot,
} from '@maxim/contracts';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsAdmin } from '../runtime/app-role';
import { MaxBotLinkService } from './max-bot-link.service';
import { MaxBotRegistryService } from './max-bot-registry.service';

const BOT_OWNERSHIP_FOUNDATION_STATUS_KEY = 'system:bot-ownership:foundation:v1';
const BOT_OWNERSHIP_FOUNDATION_LOCK_KEY = 'system:bot-ownership:foundation:repair-lock:v1';
const LOCAL_CACHE_TTL_MS = 2_000;

type RepairRuntimeState = {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastAppliedChanges: number;
  totalAppliedChanges: number;
};

type ChatRecord = {
  id: string;
  entityType: ChatEntityType;
  botId: string | null;
  primaryBotId: string | null;
};

type MembershipRecord = {
  chatId: string;
  botId: string;
  role: ChatBotMembershipRole;
  status: ChatBotMembershipStatus;
  permissionsSnapshot: unknown | null;
};

type MembershipAccessSnapshot = {
  isAdmin: boolean;
  isOwner: boolean;
};

@Injectable()
export class MaxBotOwnershipFoundationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaxBotOwnershipFoundationService.name);
  private readonly redis: Redis;
  private readonly enabled: boolean;
  private readonly activeOnThisRole: boolean;
  private readonly repairIntervalMs: number;
  private readonly repairLockTtlMs: number;
  private readonly repairBatchSize: number;
  private readonly runtimeState: RepairRuntimeState = {
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastAppliedChanges: 0,
    totalAppliedChanges: 0,
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
    this.repairIntervalMs = configService.get<number>('BOT_OWNERSHIP_REPAIR_INTERVAL_MS', 300_000);
    this.repairLockTtlMs = configService.get<number>('BOT_OWNERSHIP_REPAIR_LOCK_TTL_MS', 60_000);
    this.repairBatchSize = configService.get<number>('BOT_OWNERSHIP_REPAIR_BATCH_SIZE', 250);
    this.activeOnThisRole = this.enabled && roleRunsAdmin(getAppRole());
  }

  async onModuleInit(): Promise<void> {
    if (!this.activeOnThisRole) {
      return;
    }

    this.timer = setInterval(() => {
      void this.sync('scheduled');
    }, this.repairIntervalMs);
    this.timer.unref?.();

    await this.sync('startup');
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
      this.cacheSnapshot(cached);
      return cached;
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
      const appliedChanges = await this.repairRecoverableOwnership();
      this.runtimeState.lastAppliedChanges = appliedChanges;
      this.runtimeState.totalAppliedChanges += appliedChanges;
      this.runtimeState.lastSuccessAt = new Date().toISOString();
      this.runtimeState.lastError = null;

      if (appliedChanges > 0) {
        this.logger.log(
          {
            reason,
            appliedChanges,
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

  private async repairRecoverableOwnership(): Promise<number> {
    const [chats, memberships] = await Promise.all([
      this.prisma.chat.findMany({
        select: {
          id: true,
          entityType: true,
          botId: true,
          primaryBotId: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.chatBotMembership.findMany({
        select: {
          chatId: true,
          botId: true,
          role: true,
          status: true,
          permissionsSnapshot: true,
        },
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'asc' }],
      }),
    ]);

    const knownBotIds = new Set(this.botRegistry.getAllBots().map((bot) => bot.id));
    const membershipsByChat = this.groupMembershipsByChat(memberships);
    let appliedChanges = 0;

    for (const chat of chats) {
      if (appliedChanges >= this.repairBatchSize) {
        break;
      }

      const chatMemberships = membershipsByChat.get(chat.id) ?? [];
      const repair = this.planChatRepair(chat, chatMemberships, knownBotIds);
      if (!repair) {
        continue;
      }

      const operations: Prisma.PrismaPromise<unknown>[] = [];
      if (repair.nextPrimaryBotId) {
        const desiredPrimaryBotId = repair.nextPrimaryBotId;
        if (chat.primaryBotId !== desiredPrimaryBotId || chat.botId !== desiredPrimaryBotId) {
          operations.push(
            this.prisma.chat.update({
              where: { id: chat.id },
              data: {
                primaryBotId: desiredPrimaryBotId,
                botId: desiredPrimaryBotId,
              },
            }),
          );
        }

        operations.push(
          this.prisma.chatBotMembership.upsert({
            where: {
              chatId_botId: {
                chatId: chat.id,
                botId: desiredPrimaryBotId,
              },
            },
            create: {
              chatId: chat.id,
              botId: desiredPrimaryBotId,
              role: ChatBotMembershipRole.PRIMARY,
              status: ChatBotMembershipStatus.ACTIVE,
            },
            update: {
              role: ChatBotMembershipRole.PRIMARY,
              status: ChatBotMembershipStatus.ACTIVE,
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
      }

      if (operations.length === 0) {
        continue;
      }

      await this.prisma.$transaction(operations);
      appliedChanges += operations.length;
      if (repair.nextPrimaryBotId) {
        this.maxBotLinkService.rememberChatBotBinding(chat.id, repair.nextPrimaryBotId);
      }
    }

    return appliedChanges;
  }

  private planChatRepair(
    chat: ChatRecord,
    memberships: readonly MembershipRecord[],
    knownBotIds: ReadonlySet<string>,
  ): { nextPrimaryBotId: string | null; activeKnownStandbyBotIds: string[] } | null {
    const primaryKnown = this.readKnownBotId(chat.primaryBotId, knownBotIds);
    const legacyKnown = this.readKnownBotId(chat.botId, knownBotIds);
    const hasUnknownPrimary = Boolean(chat.primaryBotId && !primaryKnown);
    if (hasUnknownPrimary) {
      return null;
    }

    const activeKnownMemberships = memberships.filter(
      (membership) =>
        membership.status === ChatBotMembershipStatus.ACTIVE && knownBotIds.has(membership.botId),
    );
    const activePrimaryMembership = activeKnownMemberships.find(
      (membership) => membership.role === ChatBotMembershipRole.PRIMARY,
    );
    const hasActivePrimaryMembership =
      primaryKnown !== null &&
      activeKnownMemberships.some((membership) => membership.botId === primaryKnown);
    const hasRemovedPrimaryMembership =
      primaryKnown !== null &&
      memberships.some(
        (membership) =>
          membership.botId === primaryKnown &&
          membership.status === ChatBotMembershipStatus.REMOVED,
      );

    let nextPrimaryBotId: string | null = primaryKnown;
    if (!chat.primaryBotId) {
      if (activePrimaryMembership) {
        nextPrimaryBotId = activePrimaryMembership.botId;
      } else {
        const legacyObservedMembership = legacyKnown
          ? activeKnownMemberships.find((membership) => membership.botId === legacyKnown)
          : null;
        if (legacyObservedMembership) {
          nextPrimaryBotId = legacyObservedMembership.botId;
        } else if (activeKnownMemberships[0]) {
          nextPrimaryBotId = activeKnownMemberships[0].botId;
        } else if (legacyKnown) {
          nextPrimaryBotId = legacyKnown;
        }
      }
    } else if (primaryKnown && !hasActivePrimaryMembership && hasRemovedPrimaryMembership) {
      if (activePrimaryMembership) {
        nextPrimaryBotId = activePrimaryMembership.botId;
      } else if (activeKnownMemberships[0]) {
        nextPrimaryBotId = activeKnownMemberships[0].botId;
      } else {
        return null;
      }
    }

    if (!nextPrimaryBotId) {
      return null;
    }

    const activeKnownStandbyBotIds = activeKnownMemberships
      .filter((membership) => membership.botId !== nextPrimaryBotId)
      .map((membership) => membership.botId);

    const shouldRepair =
      chat.primaryBotId !== nextPrimaryBotId ||
      chat.botId !== nextPrimaryBotId ||
      !hasActivePrimaryMembership ||
      activeKnownMemberships.some(
        (membership) =>
          membership.botId !== nextPrimaryBotId && membership.role !== ChatBotMembershipRole.STANDBY,
      ) ||
      activeKnownMemberships.some(
        (membership) =>
          membership.botId === nextPrimaryBotId && membership.role !== ChatBotMembershipRole.PRIMARY,
      );

    if (!shouldRepair) {
      return null;
    }

    return {
      nextPrimaryBotId,
      activeKnownStandbyBotIds,
    };
  }

  private async buildSnapshot(): Promise<BotOwnershipFoundationSnapshot> {
    const [chats, memberships] = await Promise.all([
      this.prisma.chat.findMany({
        select: {
          id: true,
          entityType: true,
          botId: true,
          primaryBotId: true,
        },
      }),
      this.prisma.chatBotMembership.findMany({
        select: {
          chatId: true,
          botId: true,
          role: true,
          status: true,
          permissionsSnapshot: true,
        },
      }),
    ]);

    const knownBotIds = new Set(this.botRegistry.getAllBots().map((bot) => bot.id));
    const membershipsByChat = this.groupMembershipsByChat(memberships);
    const anomalies = this.createEmptyAnomalies();
    const totalCoverage = this.createCoverageAccumulator();
    const chatCoverage = this.createCoverageAccumulator();
    const channelCoverage = this.createCoverageAccumulator();

    for (const chat of chats) {
      const chatMemberships = membershipsByChat.get(chat.id) ?? [];
      const activeKnownMemberships = chatMemberships.filter(
        (membership) =>
          membership.status === ChatBotMembershipStatus.ACTIVE && knownBotIds.has(membership.botId),
      );
      const hasActiveUnknownMembership = chatMemberships.some(
        (membership) =>
          membership.status === ChatBotMembershipStatus.ACTIVE && !knownBotIds.has(membership.botId),
      );
      const primaryKnown = this.readKnownBotId(chat.primaryBotId, knownBotIds);
      const legacyKnown = this.readKnownBotId(chat.botId, knownBotIds);
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

        if (activeKnownMemberships.length > 0) {
          anomalies.recoverableFromMemberships += 1;
        } else if (legacyKnown) {
          anomalies.recoverableLegacyOnly += 1;
        } else if (chat.botId) {
          anomalies.legacyBotUnknown += 1;
        } else {
          anomalies.unbound += 1;
        }
      } else if (!primaryKnown) {
        anomalies.primaryBotUnknown += 1;
      }

      if (chat.primaryBotId && primaryKnown && !activeKnownMemberships.some((m) => m.botId === primaryKnown)) {
        anomalies.primaryWithoutActiveMembership += 1;
      }

      const primaryActiveMembership =
        primaryKnown !== null
          ? activeKnownMemberships.find((membership) => membership.botId === primaryKnown) ?? null
          : null;
      if (this.membershipExplicitlyLacksAccess(primaryActiveMembership?.permissionsSnapshot ?? null)) {
        anomalies.primaryWithoutAdminAccess += 1;
      }

      if (hasActiveUnknownMembership) {
        anomalies.activeMembershipBotUnknown += 1;
      }

      if (activeKnownMemberships.length > 1) {
        anomalies.sharedChats += 1;
      }
    }

    const bots = this.botRegistry.getAllBots();
    const parsed = botOwnershipFoundationSnapshotSchema.parse({
      generatedAt: new Date().toISOString(),
      bots: {
        configured: bots.length,
        adminVisible: this.botRegistry.getAdminVisibleBots().length,
        active: bots.filter((bot) => bot.state === 'active').length,
        dormant: bots.filter((bot) => bot.state === 'dormant').length,
        draining: bots.filter((bot) => bot.state === 'draining').length,
        disabled: bots.filter((bot) => bot.state === 'disabled').length,
      },
      entities: {
        total: this.finalizeCoverage(totalCoverage),
        chats: this.finalizeCoverage(chatCoverage),
        channels: this.finalizeCoverage(channelCoverage),
      },
      anomalies,
      repair: {
        enabled: this.enabled,
        activeOnThisRole: this.activeOnThisRole,
        intervalMs: this.repairIntervalMs,
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
      bots: {
        configured: this.botRegistry.getAllBots().length,
        adminVisible: this.botRegistry.getAdminVisibleBots().length,
        active: this.botRegistry.getAllBots().filter((bot) => bot.state === 'active').length,
        dormant: this.botRegistry.getAllBots().filter((bot) => bot.state === 'dormant').length,
        draining: this.botRegistry.getAllBots().filter((bot) => bot.state === 'draining').length,
        disabled: this.botRegistry.getAllBots().filter((bot) => bot.state === 'disabled').length,
      },
      entities: {
        total: this.finalizeCoverage(this.createCoverageAccumulator()),
        chats: this.finalizeCoverage(this.createCoverageAccumulator()),
        channels: this.finalizeCoverage(this.createCoverageAccumulator()),
      },
      anomalies: this.createEmptyAnomalies(),
      repair: {
        enabled: this.enabled,
        activeOnThisRole: this.activeOnThisRole,
        intervalMs: this.repairIntervalMs,
        lastRunAt: this.runtimeState.lastRunAt,
        lastSuccessAt: this.runtimeState.lastSuccessAt,
        lastError,
        lastAppliedChanges: this.runtimeState.lastAppliedChanges,
        totalAppliedChanges: this.runtimeState.totalAppliedChanges,
      },
    };
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
      unbound: 0,
      primaryBotUnknown: 0,
      legacyBotUnknown: 0,
      activeMembershipBotUnknown: 0,
      primaryWithoutActiveMembership: 0,
      primaryWithoutAdminAccess: 0,
      sharedChats: 0,
    };
  }

  private normalizeMembershipAccessSnapshot(value: unknown): MembershipAccessSnapshot | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, unknown>;
    return {
      isAdmin: row.isAdmin === true,
      isOwner: row.isOwner === true,
    };
  }

  private membershipExplicitlyLacksAccess(value: unknown): boolean {
    const snapshot = this.normalizeMembershipAccessSnapshot(value);
    return Boolean(snapshot && !snapshot.isAdmin && !snapshot.isOwner);
  }
}

export { BOT_OWNERSHIP_FOUNDATION_STATUS_KEY };
