import { ChatEntityType, Prisma } from '../prisma/prisma-client';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxChannelMessageSnapshot,
} from '../max/max-client.service';
import {
  MaxBotLinkService,
  type MaxBotRoute,
  type MaxBotRouteRequest,
} from '../max/max-bot-link.service';
import { MAX_REQUIRED_WEBHOOK_UPDATE_TYPES } from '../max/max-webhook-subscription.constants';
import { PrismaService } from '../prisma/prisma.service';
import { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';
import {
  SystemModeService,
  isSystemModeRecoveryWindow,
  type SystemModeSnapshot,
} from '../system/system-mode.service';

const CHANNEL_STATS_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const CHANNEL_STATS_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const CHANNEL_STATS_STALE_MS = 2 * 60 * 60 * 1000;
const CHANNEL_STATS_ALL_LOCK_TTL_MS = 30 * 60 * 1000;
const CHANNEL_STATS_CHAT_LOCK_TTL_MS = 10 * 60 * 1000;
const CHANNEL_STATS_SUBSCRIPTIONS_LOCK_TTL_MS = 60 * 1000;
const CHANNEL_STATS_STARTUP_INTER_CHANNEL_DELAY_MS = 2_000;
const CHANNEL_STATS_SCHEDULED_INTER_CHANNEL_DELAY_MS = 500;
const CHANNEL_STATS_BACKGROUND_THROTTLE_BACKOFF_MS = 60_000;
const CHANNEL_STATS_BACKGROUND_THROTTLE_BACKOFF_KEY = 'channel-stats:background-sync-backoff:v1';
const CHANNEL_STATS_DEGRADE_PAUSE_LOG_INTERVAL_MS = 60_000;
const CHANNEL_STATS_IGNORED_FAILURE_METRIC_STATUSES = [404] as const;
const DEFAULT_CHANNEL_STATS_STARTUP_DELAY_MS = 30_000;
const DEFAULT_CHANNEL_STATS_STARTUP_JITTER_MS = 15_000;
const DEFAULT_CHANNEL_STATS_STARTUP_MAX_PAGES = 20;
const DEFAULT_CHANNEL_STATS_ENDPOINT_MAX_PAGES = 8;
const CHANNEL_STATS_SCHEDULED_CATCH_UP_STARTUP_DELAY_MS = 90_000;
const CHANNEL_STATS_AUDIENCE_CATCH_UP_INTERVAL_MS = 5 * 60 * 1000;
const CHANNEL_STATS_SCHEDULED_AUDIENCE_CATCH_UP_MAX_CHANNELS = 360;
const CHANNEL_STATS_SCHEDULED_AUDIENCE_CATCH_UP_SLOW_MAX_CHANNELS = 30;
const CHANNEL_STATS_SCHEDULED_VIEWS_SYNC_MAX_CHANNELS = 6;
type ChannelStatsSyncResult = {
  audienceSynced: boolean;
  viewsSynced: boolean;
  throttled: boolean;
};

type ChannelStatsAudienceSyncResult = Pick<
  ChannelStatsSyncResult,
  'audienceSynced' | 'throttled'
> & {
  syncedAt: Date | null;
};

type ChannelStartupSyncCandidate = {
  id: string;
  channelStatsSyncState: {
    lastAudienceSyncAt: Date | null;
    lastViewsSyncAt: Date | null;
  } | null;
};

type ChannelScheduledSyncCandidate = ChannelStartupSyncCandidate & {
  channelAudienceSnapshots: Array<{
    capturedAt: Date;
  }>;
};

@Injectable()
export class ChannelStatsCollectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChannelStatsCollectorService.name);
  private readonly redis: Redis;
  private readonly backgroundEnabled = roleRunsAction(getAppRole());
  private readonly startupSyncEnabled: boolean;
  private readonly startupSyncMaxChannels: number;
  private readonly startupSyncStaleMs: number;
  private readonly startupSyncDelayMs: number;
  private readonly startupSyncJitterMs: number;
  private readonly startupSyncMaxPages: number;
  private readonly endpointSyncMaxPages: number;
  private readonly syncIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private scheduledCatchUpStartupTimer: NodeJS.Timeout | null = null;
  private scheduledAudienceCatchUpTimer: NodeJS.Timeout | null = null;
  private scheduledSyncInFlight = false;
  private backgroundSyncBackoffUntilMs = 0;
  private backgroundSyncSlowUntilMs = 0;
  private subscriptionCoverageFrom: Date | null = null;
  private degradePauseLogAtMs = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    configService: ConfigService,
    @Optional() private readonly systemModeService?: SystemModeService,
    @Optional() private readonly maxBotLinkService?: MaxBotLinkService,
    @Optional()
    private readonly backgroundRuntimeGovernorService?: BackgroundRuntimeGovernorService,
  ) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.startupSyncEnabled = configService.get<boolean>(
      'CHANNEL_STATS_STARTUP_SYNC_ENABLED',
      false,
    );
    this.startupSyncMaxChannels = Math.max(
      0,
      configService.get<number>('CHANNEL_STATS_STARTUP_MAX_CHANNELS', 6),
    );
    this.startupSyncStaleMs = Math.max(
      1,
      configService.get<number>('CHANNEL_STATS_STARTUP_STALE_MS', 6 * 60 * 60 * 1_000),
    );
    this.startupSyncDelayMs = Math.max(
      0,
      configService.get<number>(
        'CHANNEL_STATS_STARTUP_DELAY_MS',
        DEFAULT_CHANNEL_STATS_STARTUP_DELAY_MS,
      ),
    );
    this.startupSyncJitterMs = Math.max(
      0,
      configService.get<number>(
        'CHANNEL_STATS_STARTUP_JITTER_MS',
        DEFAULT_CHANNEL_STATS_STARTUP_JITTER_MS,
      ),
    );
    this.startupSyncMaxPages = Math.max(
      1,
      configService.get<number>(
        'CHANNEL_STATS_STARTUP_MAX_PAGES',
        DEFAULT_CHANNEL_STATS_STARTUP_MAX_PAGES,
      ),
    );
    this.endpointSyncMaxPages = Math.max(
      1,
      configService.get<number>(
        'CHANNEL_STATS_ENDPOINT_MAX_PAGES',
        DEFAULT_CHANNEL_STATS_ENDPOINT_MAX_PAGES,
      ),
    );
    this.syncIntervalMs = CHANNEL_STATS_SYNC_INTERVAL_MS;
  }

  onModuleInit() {
    if (!this.backgroundEnabled) {
      return;
    }

    this.timer = setInterval(() => {
      void this.syncAllChannels('scheduled');
    }, this.syncIntervalMs);
    this.timer.unref();

    this.scheduledAudienceCatchUpTimer = setInterval(() => {
      void this.syncScheduledAudienceCatchUpOnly('scheduled');
    }, CHANNEL_STATS_AUDIENCE_CATCH_UP_INTERVAL_MS);
    this.scheduledAudienceCatchUpTimer.unref();

    this.scheduleScheduledCatchUpOnStartup();
    this.scheduleStartupSync();
  }

  async onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.scheduledCatchUpStartupTimer) {
      clearTimeout(this.scheduledCatchUpStartupTimer);
      this.scheduledCatchUpStartupTimer = null;
    }
    if (this.scheduledAudienceCatchUpTimer) {
      clearInterval(this.scheduledAudienceCatchUpTimer);
      this.scheduledAudienceCatchUpTimer = null;
    }

    await this.redis.quit();
  }

  async syncChannelIfStale(
    chatId: string,
    options?: {
      staleMs?: number;
      reason?: string;
    },
  ) {
    const staleMs = options?.staleMs ?? CHANNEL_STATS_STALE_MS;
    const [latestAudienceSnapshot, syncState] = await Promise.all([
      this.prisma.channelAudienceSnapshot.findFirst({
        where: { chatId },
        orderBy: { capturedAt: 'desc' },
        select: { capturedAt: true },
      }),
      this.prisma.channelStatsSyncState.findUnique({
        where: { chatId },
        select: {
          lastViewsSyncAt: true,
          lastAudienceSyncAt: true,
        },
      }),
    ]);

    const nowMs = Date.now();
    const audienceStale =
      !latestAudienceSnapshot ||
      nowMs - latestAudienceSnapshot.capturedAt.getTime() > staleMs ||
      !syncState?.lastAudienceSyncAt ||
      nowMs - syncState.lastAudienceSyncAt.getTime() > staleMs;
    const viewsStale =
      !syncState?.lastViewsSyncAt || nowMs - syncState.lastViewsSyncAt.getTime() > staleMs;

    if (!audienceStale && !viewsStale) {
      return;
    }

    const reason = options?.reason ?? 'opportunistic';
    const isStatsEndpointRefresh = reason === 'stats_endpoint';
    let refreshedAudienceForStatsEndpoint = false;
    let audienceSyncedAtForStatsEndpoint: Date | null = null;

    if (isStatsEndpointRefresh && audienceStale) {
      const audienceResult = await this.syncAudienceSnapshotIfStale(chatId, {
        staleMs,
        reason,
        markOpportunistic: true,
      });
      refreshedAudienceForStatsEndpoint = audienceResult.audienceSynced;
      audienceSyncedAtForStatsEndpoint = audienceResult.syncedAt;
      if (audienceResult.throttled) {
        await this.activateBackgroundSyncBackoff();
        return;
      }
    }

    if (isStatsEndpointRefresh && !viewsStale) {
      return;
    }

    const shouldPauseStatsEndpointRefresh =
      isStatsEndpointRefresh &&
      ((await this.isBackgroundWorkPaused('scheduled')) ||
        (await this.isBackgroundSyncBackoffActive()));
    if (shouldPauseStatsEndpointRefresh) {
      return;
    }

    const syncResult = await this.syncChannel(chatId, {
      reason: options?.reason ?? 'opportunistic',
      markOpportunistic: true,
      ...(isStatsEndpointRefresh ? { maxPages: this.endpointSyncMaxPages } : {}),
      ...(refreshedAudienceForStatsEndpoint
        ? { skipAudience: true, audienceSyncedAt: audienceSyncedAtForStatsEndpoint ?? undefined }
        : {}),
    });
    if (isStatsEndpointRefresh && syncResult.throttled) {
      await this.activateBackgroundSyncBackoff();
    }
  }

  async syncAudienceSnapshotIfStale(
    chatId: string,
    options?: {
      staleMs?: number;
      reason?: string;
      markOpportunistic?: boolean;
    },
  ): Promise<ChannelStatsAudienceSyncResult> {
    const result: ChannelStatsAudienceSyncResult = {
      audienceSynced: false,
      throttled: false,
      syncedAt: null,
    };
    const staleMs = options?.staleMs ?? CHANNEL_STATS_STALE_MS;
    const [latestAudienceSnapshot, syncState] = await Promise.all([
      this.prisma.channelAudienceSnapshot.findFirst({
        where: { chatId },
        orderBy: { capturedAt: 'desc' },
        select: { capturedAt: true },
      }),
      this.prisma.channelStatsSyncState.findUnique({
        where: { chatId },
        select: {
          lastAudienceSyncAt: true,
        },
      }),
    ]);

    if (!this.isAudienceSnapshotStale(latestAudienceSnapshot, syncState, staleMs, Date.now())) {
      return result;
    }

    await this.withRedisLock(
      `channel-stats:chat:${chatId}`,
      CHANNEL_STATS_CHAT_LOCK_TTL_MS,
      async () => {
        const now = new Date();
        const [lockedLatestAudienceSnapshot, lockedState] = await Promise.all([
          this.prisma.channelAudienceSnapshot.findFirst({
            where: { chatId },
            orderBy: { capturedAt: 'desc' },
            select: { capturedAt: true },
          }),
          this.prisma.channelStatsSyncState.findUnique({
            where: { chatId },
          }),
        ]);

        if (
          !this.isAudienceSnapshotStale(
            lockedLatestAudienceSnapshot,
            lockedState,
            staleMs,
            now.getTime(),
          )
        ) {
          return;
        }

        const statsBotId = await this.resolveCapabilityRouteBotId(chatId, 'channel_stats');
        const audienceResult = await this.syncOfficialAudienceSnapshot(chatId, {
          now,
          reason: options?.reason ?? 'opportunistic',
          statsBotId,
        });
        result.audienceSynced = audienceResult.audienceSynced;
        result.throttled = audienceResult.throttled;
        result.syncedAt = audienceResult.syncedAt;

        if (!audienceResult.audienceSynced) {
          return;
        }

        await this.prisma.channelStatsSyncState.upsert({
          where: { chatId },
          create: {
            chatId,
            viewsCoverageFrom: lockedState?.viewsCoverageFrom ?? null,
            membershipCoverageFrom: lockedState?.membershipCoverageFrom ?? null,
            lastAudienceSyncAt: now,
            lastViewsSyncAt: lockedState?.lastViewsSyncAt ?? null,
            lastOpportunisticSyncAt: options?.markOpportunistic
              ? now
              : (lockedState?.lastOpportunisticSyncAt ?? null),
          },
          update: {
            lastAudienceSyncAt: now,
            ...(options?.markOpportunistic ? { lastOpportunisticSyncAt: now } : {}),
          },
        });
      },
    );

    return result;
  }

  async syncAllChannels(reason: 'startup' | 'scheduled') {
    await this.syncChannels(reason);
  }

  private async syncStartupChannels() {
    if (!this.startupSyncEnabled || this.startupSyncMaxChannels === 0) {
      return;
    }

    const channels = await this.prisma.chat.findMany({
      where: { entityType: ChatEntityType.CHANNEL },
      select: {
        id: true,
        channelStatsSyncState: {
          select: {
            lastAudienceSyncAt: true,
            lastViewsSyncAt: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
    const candidates = channels
      .filter((channel) => this.shouldSyncChannelOnStartup(channel))
      .sort((left, right) => this.compareStartupSyncCandidates(left, right))
      .slice(0, this.startupSyncMaxChannels)
      .map((channel) => ({ id: channel.id }));

    if (candidates.length === 0) {
      return;
    }

    await this.syncChannels('startup', candidates);
  }

  private async syncChannels(
    reason: 'startup' | 'scheduled',
    channelsOverride?: Array<{ id: string }>,
    options?: {
      audienceOnly?: boolean;
    },
  ) {
    if (
      !this.backgroundEnabled ||
      this.scheduledSyncInFlight ||
      (await this.isBackgroundWorkPaused(reason)) ||
      (await this.isBackgroundSyncBackoffActive())
    ) {
      return;
    }

    this.scheduledSyncInFlight = true;
    try {
      await this.withRedisLock(
        'channel-stats:sync-all',
        CHANNEL_STATS_ALL_LOCK_TTL_MS,
        async () => {
          if (reason === 'scheduled' && !channelsOverride) {
            await this.syncScheduledChannels({ audienceOnly: options?.audienceOnly ?? false });
            return;
          }

          await this.ensureWebhookCoverage();
          const channels =
            channelsOverride ??
            (await this.prisma.chat.findMany({
              where: { entityType: ChatEntityType.CHANNEL },
              select: { id: true },
              orderBy: { updatedAt: 'desc' },
            }));

          for (const [index, channel] of channels.entries()) {
            if (index > 0) {
              await this.sleepBetweenChannels(reason);
            }

            const syncResult = await this.syncChannel(channel.id, { reason });
            if (syncResult.throttled) {
              const backoffMs = await this.activateBackgroundSyncBackoff();
              this.logger.warn(
                {
                  reason,
                  chatId: channel.id,
                  backoffMs,
                },
                'Paused background channel stats sync after MAX API throttling',
              );
              break;
            }
          }
        },
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          reason,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to sync channel stats in background',
      );
    } finally {
      this.scheduledSyncInFlight = false;
    }
  }

  private async syncScheduledAudienceCatchUpOnly(reason: 'scheduled') {
    await this.syncChannels(reason, undefined, { audienceOnly: true });
  }

  private async syncScheduledChannels(options?: { audienceOnly?: boolean }) {
    const channels = await this.prisma.chat.findMany({
      where: { entityType: ChatEntityType.CHANNEL },
      select: {
        id: true,
        channelStatsSyncState: {
          select: {
            lastAudienceSyncAt: true,
            lastViewsSyncAt: true,
          },
        },
        channelAudienceSnapshots: {
          orderBy: { capturedAt: 'desc' },
          take: 1,
          select: { capturedAt: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
    const nowMs = Date.now();
    const audienceCandidates = channels
      .filter((channel) =>
        this.isAudienceSnapshotStale(
          channel.channelAudienceSnapshots[0] ?? null,
          channel.channelStatsSyncState,
          CHANNEL_STATS_STALE_MS,
          nowMs,
        ),
      )
      .sort((left, right) => this.compareScheduledAudienceSyncCandidates(left, right))
      .slice(0, this.resolveScheduledAudienceCatchUpMaxChannels());
    const audienceResult = await this.syncScheduledAudienceCatchUp(audienceCandidates);
    if (audienceResult.throttled) {
      return;
    }

    if (options?.audienceOnly) {
      return;
    }

    if (this.isBackgroundSyncSlowActive()) {
      return;
    }

    const viewsCandidates = channels
      .filter(
        (channel) =>
          this.isViewsSyncStale(channel.channelStatsSyncState, CHANNEL_STATS_STALE_MS, nowMs) &&
          (!this.isAudienceSnapshotStale(
            channel.channelAudienceSnapshots[0] ?? null,
            channel.channelStatsSyncState,
            CHANNEL_STATS_STALE_MS,
            nowMs,
          ) ||
            audienceResult.syncedAudienceAtByChatId.has(channel.id)),
      )
      .sort((left, right) => this.compareScheduledViewsSyncCandidates(left, right))
      .slice(0, CHANNEL_STATS_SCHEDULED_VIEWS_SYNC_MAX_CHANNELS);
    await this.syncScheduledViews(viewsCandidates, audienceResult.syncedAudienceAtByChatId);
  }

  private async syncScheduledAudienceCatchUp(
    channels: ChannelScheduledSyncCandidate[],
  ): Promise<{
    throttled: boolean;
    syncedAudienceAtByChatId: Map<string, Date>;
  }> {
    const syncedAudienceAtByChatId = new Map<string, Date>();

    for (const [index, channel] of channels.entries()) {
      if (index > 0) {
        await this.sleepBetweenChannels('scheduled');
      }

      const audienceResult = await this.syncAudienceSnapshotIfStale(channel.id, {
        staleMs: CHANNEL_STATS_STALE_MS,
        reason: 'scheduled',
      });
      if (audienceResult.audienceSynced && audienceResult.syncedAt) {
        syncedAudienceAtByChatId.set(channel.id, audienceResult.syncedAt);
      }
      if (audienceResult.throttled) {
        const backoffMs = await this.activateBackgroundSyncBackoff();
        this.logger.warn(
          {
            reason: 'scheduled',
            chatId: channel.id,
            backoffMs,
          },
          'Paused background channel audience catch-up after MAX API throttling',
        );
        return { throttled: true, syncedAudienceAtByChatId };
      }
    }

    return { throttled: false, syncedAudienceAtByChatId };
  }

  private async syncScheduledViews(
    channels: ChannelScheduledSyncCandidate[],
    syncedAudienceAtByChatId: Map<string, Date>,
  ) {
    for (const [index, channel] of channels.entries()) {
      if (index > 0) {
        await this.sleepBetweenChannels('scheduled');
      }

      const audienceSyncedAt = syncedAudienceAtByChatId.get(channel.id);
      const syncResult = await this.syncChannel(channel.id, {
        reason: 'scheduled',
        skipAudience: true,
        ...(audienceSyncedAt ? { audienceSyncedAt } : {}),
      });
      if (syncResult.throttled) {
        const backoffMs = await this.activateBackgroundSyncBackoff();
        this.logger.warn(
          {
            reason: 'scheduled',
            chatId: channel.id,
            backoffMs,
          },
          'Paused background channel stats sync after MAX API throttling',
        );
        break;
      }
    }
  }

  private shouldSyncChannelOnStartup(channel: ChannelStartupSyncCandidate): boolean {
    const lastAudienceSyncAt = channel.channelStatsSyncState?.lastAudienceSyncAt ?? null;
    const lastViewsSyncAt = channel.channelStatsSyncState?.lastViewsSyncAt ?? null;

    if (!lastAudienceSyncAt || !lastViewsSyncAt) {
      return true;
    }

    const freshestSyncAtMs = Math.max(lastAudienceSyncAt.getTime(), lastViewsSyncAt.getTime());
    return Date.now() - freshestSyncAtMs >= this.startupSyncStaleMs;
  }

  private compareStartupSyncCandidates(
    left: ChannelStartupSyncCandidate,
    right: ChannelStartupSyncCandidate,
  ): number {
    const leftFreshestSyncAtMs = this.resolveStartupFreshestSyncAtMs(left);
    const rightFreshestSyncAtMs = this.resolveStartupFreshestSyncAtMs(right);
    if (leftFreshestSyncAtMs === null && rightFreshestSyncAtMs !== null) {
      return -1;
    }
    if (leftFreshestSyncAtMs !== null && rightFreshestSyncAtMs === null) {
      return 1;
    }
    if (leftFreshestSyncAtMs === null && rightFreshestSyncAtMs === null) {
      return left.id.localeCompare(right.id);
    }

    return (
      (leftFreshestSyncAtMs ?? Number.NEGATIVE_INFINITY) -
        (rightFreshestSyncAtMs ?? Number.NEGATIVE_INFINITY) || left.id.localeCompare(right.id)
    );
  }

  private resolveStartupFreshestSyncAtMs(channel: ChannelStartupSyncCandidate): number | null {
    const lastAudienceSyncAt = channel.channelStatsSyncState?.lastAudienceSyncAt ?? null;
    const lastViewsSyncAt = channel.channelStatsSyncState?.lastViewsSyncAt ?? null;
    if (!lastAudienceSyncAt || !lastViewsSyncAt) {
      return null;
    }

    return Math.max(lastAudienceSyncAt.getTime(), lastViewsSyncAt.getTime());
  }

  private compareScheduledAudienceSyncCandidates(
    left: ChannelScheduledSyncCandidate,
    right: ChannelScheduledSyncCandidate,
  ): number {
    const leftFreshnessMs = this.resolveScheduledAudienceFreshnessMs(left);
    const rightFreshnessMs = this.resolveScheduledAudienceFreshnessMs(right);
    return this.compareNullableFreshness(leftFreshnessMs, rightFreshnessMs, left.id, right.id);
  }

  private compareScheduledViewsSyncCandidates(
    left: ChannelScheduledSyncCandidate,
    right: ChannelScheduledSyncCandidate,
  ): number {
    const leftSyncedAtMs = left.channelStatsSyncState?.lastViewsSyncAt?.getTime() ?? null;
    const rightSyncedAtMs = right.channelStatsSyncState?.lastViewsSyncAt?.getTime() ?? null;
    return this.compareNullableFreshness(leftSyncedAtMs, rightSyncedAtMs, left.id, right.id);
  }

  private resolveScheduledAudienceFreshnessMs(
    channel: ChannelScheduledSyncCandidate,
  ): number | null {
    const latestSnapshotAtMs = channel.channelAudienceSnapshots[0]?.capturedAt.getTime() ?? null;
    const lastAudienceSyncAtMs =
      channel.channelStatsSyncState?.lastAudienceSyncAt?.getTime() ?? null;
    if (latestSnapshotAtMs === null || lastAudienceSyncAtMs === null) {
      return null;
    }

    return Math.min(latestSnapshotAtMs, lastAudienceSyncAtMs);
  }

  private compareNullableFreshness(
    leftMs: number | null,
    rightMs: number | null,
    leftId: string,
    rightId: string,
  ): number {
    if (leftMs === null && rightMs !== null) {
      return -1;
    }
    if (leftMs !== null && rightMs === null) {
      return 1;
    }
    if (leftMs === null && rightMs === null) {
      return leftId.localeCompare(rightId);
    }

    return (
      (leftMs ?? Number.NEGATIVE_INFINITY) - (rightMs ?? Number.NEGATIVE_INFINITY) ||
      leftId.localeCompare(rightId)
    );
  }

  private resolveScheduledAudienceCatchUpMaxChannels(): number {
    return this.isBackgroundSyncSlowActive()
      ? CHANNEL_STATS_SCHEDULED_AUDIENCE_CATCH_UP_SLOW_MAX_CHANNELS
      : CHANNEL_STATS_SCHEDULED_AUDIENCE_CATCH_UP_MAX_CHANNELS;
  }

  async syncChannel(
    chatId: string,
    options?: {
      reason?: string;
      markOpportunistic?: boolean;
      maxPages?: number;
      skipAudience?: boolean;
      audienceSyncedAt?: Date;
    },
  ): Promise<ChannelStatsSyncResult> {
    const result: ChannelStatsSyncResult = {
      audienceSynced: false,
      viewsSynced: false,
      throttled: false,
    };

    await this.withRedisLock(
      `channel-stats:chat:${chatId}`,
      CHANNEL_STATS_CHAT_LOCK_TTL_MS,
      async () => {
        const now = new Date();
        const lookbackFrom = new Date(now.getTime() - CHANNEL_STATS_LOOKBACK_MS);
        const statsBotId = await this.resolveCapabilityRouteBotId(chatId, 'channel_stats');
        const state = await this.prisma.channelStatsSyncState.findUnique({
          where: { chatId },
        });
        const ensuredCoverageFrom = await this.ensureWebhookCoverage();

        if (!options?.skipAudience) {
          const audienceResult = await this.syncOfficialAudienceSnapshot(chatId, {
            now,
            reason: options?.reason ?? 'manual',
            statsBotId,
          });
          result.audienceSynced = audienceResult.audienceSynced;
          result.throttled ||= audienceResult.throttled;
        }

        if (!result.throttled) {
          try {
            const messages = await this.maxClient.listMessageSnapshots(chatId, {
              from: lookbackFrom,
              to: now,
              count: 100,
              maxPages: options?.maxPages ?? this.resolveMessageSnapshotMaxPages(options?.reason),
              trafficClass: 'background',
              ignoreFailureMetricStatuses: CHANNEL_STATS_IGNORED_FAILURE_METRIC_STATUSES,
              sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC,
              ...(statsBotId ? { botId: statsBotId } : {}),
            });
            await this.upsertOfficialMessages(chatId, messages, now);
            result.viewsSynced = true;
          } catch (error: unknown) {
            result.throttled ||= this.isMaxApiThrottleError(error);
            this.logger.warn(
              {
                chatId,
                reason: options?.reason ?? 'manual',
                err: error instanceof Error ? error.message : String(error),
              },
              'Failed to sync official channel posts and views',
            );
          }
        }

        const nextMembershipCoverageFrom =
          state?.membershipCoverageFrom ?? (ensuredCoverageFrom ? now : null);
        const nextLastAudienceSyncAt =
          result.audienceSynced || options?.audienceSyncedAt
            ? (options?.audienceSyncedAt ?? now)
            : (state?.lastAudienceSyncAt ?? null);
        const nextStateCreate = {
          chatId,
          viewsCoverageFrom: state?.viewsCoverageFrom ?? lookbackFrom,
          membershipCoverageFrom: nextMembershipCoverageFrom,
          lastAudienceSyncAt: nextLastAudienceSyncAt,
          lastViewsSyncAt: result.viewsSynced ? now : (state?.lastViewsSyncAt ?? null),
          lastOpportunisticSyncAt: options?.markOpportunistic
            ? now
            : (state?.lastOpportunisticSyncAt ?? null),
        };

        await this.prisma.channelStatsSyncState.upsert({
          where: { chatId },
          create: nextStateCreate,
          update: {
            viewsCoverageFrom: state?.viewsCoverageFrom ?? lookbackFrom,
            membershipCoverageFrom: nextMembershipCoverageFrom,
            ...(result.audienceSynced || options?.audienceSyncedAt
              ? { lastAudienceSyncAt: nextLastAudienceSyncAt }
              : {}),
            ...(result.viewsSynced ? { lastViewsSyncAt: now } : {}),
            ...(options?.markOpportunistic ? { lastOpportunisticSyncAt: now } : {}),
          },
        });
      },
    );

    return result;
  }

  private async upsertOfficialMessages(
    chatId: string,
    messages: MaxChannelMessageSnapshot[],
    capturedAt: Date,
  ) {
    for (const message of messages) {
      const views = Math.max(message.views ?? 0, 0);
      const reactions = message.reactions
        .filter((item) => item.count > 0)
        .map((item) => ({
          emoji: item.emoji,
          count: item.count,
        }));
      const reactionsTotal = Math.max(
        message.reactionsTotal ?? 0,
        reactions.reduce((total, item) => total + item.count, 0),
      );
      const post = await this.prisma.channelPost.upsert({
        where: {
          chatId_messageId: {
            chatId,
            messageId: message.messageId,
          },
        },
        create: {
          chatId,
          messageId: message.messageId,
          publishedAt: new Date(message.publishedAt),
          url: message.url,
          previewUrl: message.previewUrl,
          latestViews: views,
          latestReactions:
            reactions.length > 0 ? (reactions as Prisma.InputJsonValue) : Prisma.DbNull,
          latestReactionsTotal: reactionsTotal,
          latestSnapshotAt: capturedAt,
        },
        update: {
          publishedAt: new Date(message.publishedAt),
          url: message.url,
          previewUrl: message.previewUrl,
          latestViews: views,
          latestReactions:
            reactions.length > 0 ? (reactions as Prisma.InputJsonValue) : Prisma.DbNull,
          latestReactionsTotal: reactionsTotal,
          latestSnapshotAt: capturedAt,
        },
        select: {
          id: true,
        },
      });

      await this.prisma.channelPostViewSnapshot.create({
        data: {
          channelPostId: post.id,
          views,
          reactionsTotal,
          capturedAt,
        },
      });
    }
  }

  private async syncOfficialAudienceSnapshot(
    chatId: string,
    params: {
      now: Date;
      reason: string;
      statsBotId?: string;
    },
  ): Promise<ChannelStatsAudienceSyncResult> {
    try {
      const snapshot = await this.maxClient.getChatSnapshot(chatId, {
        trafficClass: 'background',
        ignoreFailureMetricStatuses: CHANNEL_STATS_IGNORED_FAILURE_METRIC_STATUSES,
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC,
        bypassCache: true,
        ...(params.statsBotId ? { botId: params.statsBotId } : {}),
      });
      await this.prisma.$transaction([
        this.prisma.chat.update({
          where: { id: chatId },
          data: {
            title: snapshot.title?.trim() || `Канал ${chatId}`,
            entityType: ChatEntityType.CHANNEL,
          },
        }),
        this.prisma.channelAudienceSnapshot.create({
          data: {
            chatId,
            participantsCount: snapshot.participantsCount,
            status: snapshot.status,
            isPublic: snapshot.isPublic,
            link: snapshot.link,
            lastEventAt: snapshot.lastEventAt ? new Date(snapshot.lastEventAt) : null,
            capturedAt: params.now,
          },
        }),
      ]);

      return {
        audienceSynced: true,
        throttled: false,
        syncedAt: params.now,
      };
    } catch (error: unknown) {
      const logPayload = {
        chatId,
        reason: params.reason,
        err: error instanceof Error ? error.message : String(error),
      };
      if (this.isMaxApiNotFoundError(error)) {
        this.logger.debug(logPayload, 'Skipped official channel audience snapshot after MAX 404');
      } else {
        this.logger.warn(logPayload, 'Failed to sync official channel audience snapshot');
      }

      return {
        audienceSynced: false,
        throttled: this.isMaxApiThrottleError(error),
        syncedAt: null,
      };
    }
  }

  private async ensureWebhookCoverage(): Promise<Date | null> {
    if (!this.backgroundEnabled) {
      return null;
    }

    if (this.subscriptionCoverageFrom) {
      return this.subscriptionCoverageFrom;
    }

    let ensuredAt: Date | null = null;
    await this.withRedisLock(
      'channel-stats:webhook-subscriptions',
      CHANNEL_STATS_SUBSCRIPTIONS_LOCK_TTL_MS,
      async () => {
        await this.maxClient.ensureWebhookSubscription([...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES], {
          trafficClass: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC,
        });
        ensuredAt = new Date();
      },
    );

    if (ensuredAt) {
      this.subscriptionCoverageFrom = ensuredAt;
      return ensuredAt;
    }

    return this.subscriptionCoverageFrom;
  }

  private isMaxApiThrottleError(error: unknown): boolean {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 429) {
      return true;
    }

    const message =
      error instanceof Error && error.message.trim()
        ? error.message.trim().toLowerCase()
        : String(error).trim().toLowerCase();
    return (
      message.includes('rate limit exceeded') ||
      message.includes('source limit exceeded') ||
      message.includes('circuit breaker')
    );
  }

  private isMaxApiNotFoundError(error: unknown): boolean {
    return (error as { response?: { status?: number } })?.response?.status === 404;
  }

  private isAudienceSnapshotStale(
    latestAudienceSnapshot: { capturedAt: Date } | null,
    syncState: { lastAudienceSyncAt: Date | null } | null,
    staleMs: number,
    nowMs: number,
  ): boolean {
    return (
      !latestAudienceSnapshot ||
      nowMs - latestAudienceSnapshot.capturedAt.getTime() > staleMs ||
      !syncState?.lastAudienceSyncAt ||
      nowMs - syncState.lastAudienceSyncAt.getTime() > staleMs
    );
  }

  private isViewsSyncStale(
    syncState: { lastViewsSyncAt: Date | null } | null,
    staleMs: number,
    nowMs: number,
  ): boolean {
    return !syncState?.lastViewsSyncAt || nowMs - syncState.lastViewsSyncAt.getTime() > staleMs;
  }

  private async isBackgroundSyncBackoffActive(): Promise<boolean> {
    const memoryActive = Date.now() < this.backgroundSyncBackoffUntilMs;
    try {
      const raw = await this.redis.get(CHANNEL_STATS_BACKGROUND_THROTTLE_BACKOFF_KEY);
      return memoryActive || (typeof raw === 'string' && raw.length > 0);
    } catch {
      return memoryActive;
    }
  }

  private isBackgroundSyncSlowActive(): boolean {
    return Date.now() < this.backgroundSyncSlowUntilMs;
  }

  private async activateBackgroundSyncBackoff(): Promise<number> {
    const now = Date.now();
    this.backgroundSyncBackoffUntilMs = Math.max(
      this.backgroundSyncBackoffUntilMs,
      now + CHANNEL_STATS_BACKGROUND_THROTTLE_BACKOFF_MS,
    );
    const backoffMs = this.backgroundSyncBackoffUntilMs - now;

    try {
      await this.redis.set(
        CHANNEL_STATS_BACKGROUND_THROTTLE_BACKOFF_KEY,
        '1',
        'EX',
        Math.max(1, Math.ceil(backoffMs / 1000)),
      );
    } catch {
      return backoffMs;
    }

    return backoffMs;
  }

  private resolveInterChannelDelayMs(reason: 'startup' | 'scheduled'): number {
    return reason === 'startup'
      ? CHANNEL_STATS_STARTUP_INTER_CHANNEL_DELAY_MS
      : CHANNEL_STATS_SCHEDULED_INTER_CHANNEL_DELAY_MS;
  }

  private resolveMessageSnapshotMaxPages(reason?: string): number {
    return reason === 'startup' ? this.startupSyncMaxPages : 80;
  }

  private scheduleStartupSync() {
    if (!this.startupSyncEnabled || this.startupSyncMaxChannels === 0) {
      return;
    }

    const startupDelayMs =
      this.startupSyncDelayMs +
      (this.startupSyncJitterMs > 0
        ? Math.floor(Math.random() * (this.startupSyncJitterMs + 1))
        : 0);
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.syncStartupChannels();
    }, startupDelayMs);
    this.startupTimer.unref();
  }

  private scheduleScheduledCatchUpOnStartup() {
    this.scheduledCatchUpStartupTimer = setTimeout(() => {
      this.scheduledCatchUpStartupTimer = null;
      void this.syncScheduledAudienceCatchUpOnly('scheduled');
    }, CHANNEL_STATS_SCHEDULED_CATCH_UP_STARTUP_DELAY_MS);
    this.scheduledCatchUpStartupTimer.unref();
  }

  private async isBackgroundWorkPaused(reason: 'startup' | 'scheduled'): Promise<boolean> {
    if (this.backgroundRuntimeGovernorService) {
      const decision = await this.backgroundRuntimeGovernorService.decide({
        component: 'channel-stats',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC,
      });
      if (decision.action === 'run') {
        return false;
      }

      const now = Date.now();
      if (decision.action === 'slow') {
        this.backgroundSyncSlowUntilMs = Math.max(
          this.backgroundSyncSlowUntilMs,
          now + decision.retryAfterMs,
        );
        if (now - this.degradePauseLogAtMs >= CHANNEL_STATS_DEGRADE_PAUSE_LOG_INTERVAL_MS) {
          this.degradePauseLogAtMs = now;
          this.logger.log(
            {
              reason,
              action: decision.action,
              details: decision.reason,
              retryAfterMs: decision.retryAfterMs,
              audienceLimit: CHANNEL_STATS_SCHEDULED_AUDIENCE_CATCH_UP_SLOW_MAX_CHANNELS,
            },
            'Slowed background channel stats sync because the runtime governor detected pressure',
          );
        }
        return false;
      }

      if (now - this.degradePauseLogAtMs >= CHANNEL_STATS_DEGRADE_PAUSE_LOG_INTERVAL_MS) {
        this.degradePauseLogAtMs = now;
        this.logger.log(
          {
            reason,
            action: decision.action,
            details: decision.reason,
            retryAfterMs: decision.retryAfterMs,
          },
          'Paused background channel stats sync because the runtime governor detected pressure',
        );
      }

      return true;
    }

    const snapshot = await this.resolveSystemModeSnapshot();
    if (snapshot.mode !== 'degrade' || isSystemModeRecoveryWindow(snapshot)) {
      return false;
    }

    const now = Date.now();
    if (now - this.degradePauseLogAtMs >= CHANNEL_STATS_DEGRADE_PAUSE_LOG_INTERVAL_MS) {
      this.degradePauseLogAtMs = now;
      this.logger.log(
        {
          reason,
          mode: snapshot.mode,
          source: snapshot.source,
          details: snapshot.reason,
        },
        'Paused background channel stats sync because the system is degraded',
      );
    }

    return true;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async sleepBetweenChannels(reason: 'startup' | 'scheduled') {
    const delayMs = this.resolveInterChannelDelayMs(reason);
    if (delayMs > 0) {
      await this.sleep(delayMs);
    }
  }

  private async resolveCapabilityRouteBotId(
    chatId: string,
    capability: 'channel_stats',
  ): Promise<string | undefined> {
    const routeResolver = this.maxBotLinkService as unknown as {
      resolveBotRoute?: (request: MaxBotRouteRequest) => Promise<MaxBotRoute>;
    };
    if (typeof routeResolver?.resolveBotRoute === 'function') {
      const route = await routeResolver.resolveBotRoute({
        purpose: 'capability',
        chatId,
        capability,
        fallbackToPrimary: true,
      });
      if (route.botId) {
        return route.botId;
      }
    }

    return (
      (await this.maxBotLinkService?.resolveBotIdForCapability({
        chatId,
        capability,
      })) ?? undefined
    );
  }

  private async withRedisLock(
    key: string,
    ttlMs: number,
    task: () => Promise<void>,
  ): Promise<boolean> {
    const token = randomUUID();
    const acquired = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    if (acquired !== 'OK') {
      return false;
    }

    try {
      await task();
      return true;
    } finally {
      await this.redis.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
        1,
        key,
        token,
      );
    }
  }

  private async resolveSystemModeSnapshot(): Promise<SystemModeSnapshot> {
    if (!this.systemModeService) {
      return this.createFallbackSystemModeSnapshot();
    }

    const systemModeService = this.systemModeService as SystemModeService & {
      getEffectiveSnapshot?: () => Promise<SystemModeSnapshot>;
      getSnapshot?: () => SystemModeSnapshot;
    };
    if (typeof systemModeService.getEffectiveSnapshot === 'function') {
      return systemModeService.getEffectiveSnapshot();
    }
    if (typeof systemModeService.getSnapshot === 'function') {
      return systemModeService.getSnapshot();
    }

    return this.createFallbackSystemModeSnapshot();
  }

  private createFallbackSystemModeSnapshot(): SystemModeSnapshot {
    return {
      mode: 'normal',
      source: 'auto',
      reason: 'fallback',
      updatedAt: new Date().toISOString(),
      manualMode: null,
      queueLagSec: 0,
      action: {
        windowSec: 60,
        total: 0,
        success: 0,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      },
    };
  }
}
