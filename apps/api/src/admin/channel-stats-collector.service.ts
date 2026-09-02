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
import { resolveRequiredWebhookUpdateTypes } from '../max/max-webhook-subscription.constants';
import { PrismaService } from '../prisma/prisma.service';
import { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';
import {
  SystemModeService,
  isSystemModeRecoveryWindow,
  type SystemModeSnapshot,
} from '../system/system-mode.service';

const CHANNEL_STATS_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const CHANNEL_STATS_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const CHANNEL_POST_VIEWS_24H_MS = 24 * 60 * 60 * 1000;
const CHANNEL_POST_VIEWS_48H_MS = 48 * 60 * 60 * 1000;
const CHANNEL_POST_VIEWS_MILESTONE_GRACE_MS = 3 * 60 * 60 * 1000;
const CHANNEL_POST_VIEWS_MILESTONE_RETRY_COOLDOWN_MS = 15 * 60 * 1000;
const CHANNEL_STATS_STALE_MS = 2 * 60 * 60 * 1000;
const CHANNEL_STATS_ALL_LOCK_TTL_MS = 30 * 60 * 1000;
const CHANNEL_STATS_CHAT_LOCK_TTL_MS = 10 * 60 * 1000;
const CHANNEL_STATS_SUBSCRIPTIONS_LOCK_TTL_MS = 60 * 1000;
const CHANNEL_STATS_STARTUP_INTER_CHANNEL_DELAY_MS = 2_000;
const CHANNEL_STATS_SCHEDULED_INTER_CHANNEL_DELAY_MS = 500;
const CHANNEL_STATS_BACKGROUND_THROTTLE_BACKOFF_MS = 60_000;
const CHANNEL_STATS_BACKGROUND_THROTTLE_BACKOFF_KEY = 'channel-stats:background-sync-backoff:v1';
const CHANNEL_STATS_DEGRADE_PAUSE_LOG_INTERVAL_MS = 60_000;
const CHANNEL_STATS_BACKGROUND_FAILURE_LOG_INTERVAL_MS = 60_000;
const CHANNEL_STATS_BACKGROUND_SHUTDOWN_TIMEOUT_MS = 5_000;
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
const CHANNEL_STATS_MILESTONE_CATCH_UP_MAX_POSTS = 200;
const CHANNEL_STATS_PRIORITY_MILESTONE_MAX_POSTS = 20;
const CHANNEL_STATS_PRIORITY_RECENT_VIEWS_MIN_CHANNELS = 4;
const CHANNEL_STATS_PRIORITY_RECENT_VIEWS_MAX_CHANNELS = 12;
const CHANNEL_STATS_PRIORITY_RECENT_VIEWS_MAX_PAGES = 2;
const CHANNEL_STATS_ENDPOINT_SLOW_MAX_PAGES = 1;
const CHANNEL_STATS_PRIORITY_RECENT_VIEWS_STALE_MS = 30 * 60 * 1000;
const CHANNEL_STATS_PRIORITY_RECENT_VIEWS_TARGET_CYCLE_MS = 12 * 60 * 60 * 1000;
const CHANNEL_STATS_PRIORITY_RECENT_VIEWS_CAPACITY_LOG_INTERVAL_MS = 60 * 60 * 1000;
const CHANNEL_STATS_PRIORITY_AUDIENCE_SLOW_MAX_CHANNELS = 2;
type ChannelStatsSyncResult = {
  audienceSynced: boolean;
  viewsSynced: boolean;
  throttled: boolean;
};

type ChannelStatsBackgroundTask =
  | 'scheduled_sync_timer'
  | 'scheduled_audience_catch_up_timer'
  | 'startup_sync_timer'
  | 'startup_audience_catch_up_timer'
  | 'startup_candidate_query'
  | 'channel_sync';

type ChannelStatsAudienceSyncResult = Pick<
  ChannelStatsSyncResult,
  'audienceSynced' | 'throttled'
> & {
  syncedAt: Date | null;
  unavailable?: boolean;
};

type ChannelStartupSyncCandidate = {
  id: string;
  channelStatsSyncState: {
    lastAudienceSyncAt: Date | null;
    lastViewsSyncAt: Date | null;
  } | null;
};

type ChannelScheduledSyncCandidate = {
  id: string;
  channelStatsSyncState: {
    lastAudienceSyncAt: Date | null;
    lastViewsSyncAt: Date | null;
    lastViewsDiscoveryAt: Date | null;
    lastViewsAttemptAt: Date | null;
  } | null;
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
  private readonly requiredWebhookUpdateTypes: readonly string[];
  private timer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private scheduledCatchUpStartupTimer: NodeJS.Timeout | null = null;
  private scheduledAudienceCatchUpTimer: NodeJS.Timeout | null = null;
  private scheduledSyncInFlight = false;
  private shuttingDown = false;
  private readonly backgroundTasksInFlight = new Set<Promise<void>>();
  private backgroundSyncBackoffUntilMs = 0;
  private backgroundSyncSlowUntilMs = 0;
  private subscriptionCoverageFrom: Date | null = null;
  private degradePauseLogAtMs = 0;
  private priorityViewsCapacityLogAtMs = 0;
  private readonly backgroundFailureLogAtMsByTask = new Map<ChannelStatsBackgroundTask, number>();

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
    this.requiredWebhookUpdateTypes = resolveRequiredWebhookUpdateTypes(
      configService.get<string>('MAX_EXTENDED_WEBHOOK_LIFECYCLE_MODE', 'shadow'),
    );
  }

  onModuleInit() {
    if (!this.backgroundEnabled || this.shuttingDown) {
      return;
    }

    this.timer = setInterval(() => {
      this.runBackgroundTask('scheduled_sync_timer', 'scheduled', () =>
        this.syncAllChannels('scheduled'),
      );
    }, this.syncIntervalMs);
    this.timer.unref();

    this.scheduledAudienceCatchUpTimer = setInterval(() => {
      this.runBackgroundTask('scheduled_audience_catch_up_timer', 'scheduled', () =>
        this.syncScheduledAudienceCatchUpOnly('scheduled'),
      );
    }, CHANNEL_STATS_AUDIENCE_CATCH_UP_INTERVAL_MS);
    this.scheduledAudienceCatchUpTimer.unref();

    this.scheduleScheduledCatchUpOnStartup();
    this.scheduleStartupSync();
  }

  async onModuleDestroy() {
    this.shuttingDown = true;
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

    await this.waitForBackgroundTasksToSettle();
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
          lastViewsDiscoveryAt: true,
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
    const viewsStale = this.isViewsDiscoveryStale(syncState, staleMs, nowMs);

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
      ((await this.isBackgroundWorkPaused('scheduled', {
        allowMaxApiCapacitySlowPath: true,
      })) ||
        (await this.isBackgroundSyncBackoffActive()));
    if (shouldPauseStatsEndpointRefresh) {
      return;
    }

    const syncResult = await this.syncChannel(chatId, {
      reason: options?.reason ?? 'opportunistic',
      markOpportunistic: true,
      ...(isStatsEndpointRefresh
        ? {
            maxPages: this.isBackgroundSyncSlowActive()
              ? CHANNEL_STATS_ENDPOINT_SLOW_MAX_PAGES
              : this.endpointSyncMaxPages,
            viewsMode: 'discovery' as const,
          }
        : {}),
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
      unavailable: false,
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
        result.unavailable = audienceResult.unavailable;

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
    if (this.shuttingDown || !this.startupSyncEnabled || this.startupSyncMaxChannels === 0) {
      return;
    }

    let channels: ChannelStartupSyncCandidate[];
    try {
      channels = await this.prisma.chat.findMany({
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
    } catch (error: unknown) {
      this.logBackgroundFailure('startup_candidate_query', 'startup', error);
      return;
    }
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
      priorityViewsLane?: boolean;
    },
  ) {
    if (!this.backgroundEnabled || this.shuttingDown || this.scheduledSyncInFlight) {
      return;
    }

    this.scheduledSyncInFlight = true;
    try {
      if (
        (await this.isBackgroundWorkPaused(reason, {
          allowMaxApiCapacitySlowPath: options?.priorityViewsLane === true,
        })) ||
        (await this.isBackgroundSyncBackoffActive())
      ) {
        return;
      }

      await this.withRedisLock(
        'channel-stats:sync-all',
        CHANNEL_STATS_ALL_LOCK_TTL_MS,
        async () => {
          if (reason === 'scheduled' && !channelsOverride) {
            await this.syncScheduledChannels({
              audienceOnly: options?.audienceOnly ?? false,
              priorityViewsLane: options?.priorityViewsLane ?? false,
            });
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
      this.logBackgroundFailure('channel_sync', reason, error);
    } finally {
      this.scheduledSyncInFlight = false;
    }
  }

  private async syncScheduledAudienceCatchUpOnly(reason: 'scheduled') {
    await this.syncChannels(reason, undefined, {
      audienceOnly: true,
      priorityViewsLane: true,
    });
  }

  private async syncScheduledChannels(options?: {
    audienceOnly?: boolean;
    priorityViewsLane?: boolean;
  }) {
    const priorityViewsLane = options?.priorityViewsLane === true;
    const slowActive = this.isBackgroundSyncSlowActive();
    const milestoneCatchUpThrottled = await this.syncDuePostViewMilestones(
      new Date(),
      priorityViewsLane || slowActive
        ? CHANNEL_STATS_PRIORITY_MILESTONE_MAX_POSTS
        : CHANNEL_STATS_MILESTONE_CATCH_UP_MAX_POSTS,
    );
    if (milestoneCatchUpThrottled) {
      const backoffMs = await this.activateBackgroundSyncBackoff();
      this.logger.warn(
        { reason: 'scheduled', backoffMs },
        'Paused channel view milestone catch-up after MAX API throttling',
      );
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
            lastViewsDiscoveryAt: true,
            lastViewsAttemptAt: true,
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
    if (priorityViewsLane) {
      const recentViewsCandidates = channels
        .filter((channel) =>
          this.isViewsDiscoveryStale(
            channel.channelStatsSyncState,
            CHANNEL_STATS_PRIORITY_RECENT_VIEWS_STALE_MS,
            nowMs,
          ),
        )
        .sort((left, right) => this.compareScheduledViewsDiscoveryCandidates(left, right))
        .slice(0, this.resolvePriorityViewsMaxChannels(channels.length));
      const recentViewsThrottled = await this.syncScheduledViews(recentViewsCandidates, new Map(), {
        maxPages: CHANNEL_STATS_PRIORITY_RECENT_VIEWS_MAX_PAGES,
        viewsMode: 'discovery',
      });
      if (recentViewsThrottled) {
        return;
      }
    }

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
      .slice(0, this.resolveScheduledAudienceCatchUpMaxChannels({ priorityViewsLane, slowActive }));
    const audienceResult = await this.syncScheduledAudienceCatchUp(audienceCandidates);
    if (audienceResult.throttled) {
      return;
    }

    if (options?.audienceOnly) {
      return;
    }

    if (slowActive) {
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

  private async syncDuePostViewMilestones(
    now: Date,
    maxPosts = CHANNEL_STATS_MILESTONE_CATCH_UP_MAX_POSTS,
  ): Promise<boolean> {
    const retryBefore = new Date(now.getTime() - CHANNEL_POST_VIEWS_MILESTONE_RETRY_COOLDOWN_MS);
    const duePosts = await this.prisma.channelPost.findMany({
      where: {
        AND: [
          {
            OR: [
              { viewMilestoneLastAttemptAt: null },
              { viewMilestoneLastAttemptAt: { lte: retryBefore } },
            ],
          },
          {
            OR: [
              {
                viewsAt24h: null,
                publishedAt: {
                  gte: new Date(
                    now.getTime() -
                      CHANNEL_POST_VIEWS_24H_MS -
                      CHANNEL_POST_VIEWS_MILESTONE_GRACE_MS,
                  ),
                  lte: new Date(now.getTime() - CHANNEL_POST_VIEWS_24H_MS),
                },
              },
              {
                viewsAt48h: null,
                publishedAt: {
                  gte: new Date(
                    now.getTime() -
                      CHANNEL_POST_VIEWS_48H_MS -
                      CHANNEL_POST_VIEWS_MILESTONE_GRACE_MS,
                  ),
                  lte: new Date(now.getTime() - CHANNEL_POST_VIEWS_48H_MS),
                },
              },
            ],
          },
        ],
      },
      orderBy: [
        { viewMilestoneLastAttemptAt: { sort: 'asc', nulls: 'first' } },
        { publishedAt: 'asc' },
        { id: 'asc' },
      ],
      take: maxPosts,
      select: {
        id: true,
        chatId: true,
        messageId: true,
      },
    });
    const postsByChatId = new Map<string, Array<{ id: string; messageId: string }>>();
    for (const post of duePosts) {
      const posts = postsByChatId.get(post.chatId) ?? [];
      posts.push({ id: post.id, messageId: post.messageId });
      postsByChatId.set(post.chatId, posts);
    }

    let throttled = false;
    for (const [chatId, posts] of postsByChatId) {
      await this.withRedisLock(
        `channel-stats:chat:${chatId}`,
        CHANNEL_STATS_CHAT_LOCK_TTL_MS,
        async () => {
          let statsBotId: string | undefined;
          try {
            statsBotId = await this.resolveCapabilityRouteBotId(chatId, 'channel_stats');
          } catch (error: unknown) {
            this.logger.warn(
              {
                chatId,
                postCount: posts.length,
                err: error instanceof Error ? error.message : String(error),
              },
              'Failed to resolve a channel post milestone route',
            );
            await this.markViewMilestoneAttempts(
              posts.map((post) => post.id),
              now,
            );
            return;
          }

          const attemptedPostIds: string[] = [];
          for (const post of posts) {
            try {
              const snapshot = await this.maxClient.getMessageSnapshot(chatId, post.messageId, {
                trafficClass: 'background',
                sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC,
                ignoreFailureMetricStatuses: CHANNEL_STATS_IGNORED_FAILURE_METRIC_STATUSES,
                ...(statsBotId ? { botId: statsBotId } : {}),
              });
              if (snapshot) {
                await this.upsertOfficialMessages(chatId, [snapshot], now);
              }
              attemptedPostIds.push(post.id);
            } catch (error: unknown) {
              if (this.isMaxApiThrottleError(error)) {
                throttled = true;
                break;
              }

              attemptedPostIds.push(post.id);
              const payload = {
                chatId,
                messageId: post.messageId,
                err: error instanceof Error ? error.message : String(error),
              };
              if (this.isMaxApiNotFoundError(error)) {
                this.logger.debug(payload, 'Skipped unavailable channel post milestone');
              } else {
                this.logger.warn(payload, 'Failed to capture due channel post view milestone');
              }
            }
          }

          await this.markViewMilestoneAttempts(attemptedPostIds, now);
        },
      );
      if (throttled) {
        return true;
      }
    }

    return false;
  }

  private async markViewMilestoneAttempts(postIds: string[], attemptedAt: Date): Promise<void> {
    if (postIds.length === 0) {
      return;
    }

    await this.prisma.channelPost.updateMany({
      where: { id: { in: postIds } },
      data: { viewMilestoneLastAttemptAt: attemptedAt },
    });
  }

  private async syncScheduledAudienceCatchUp(channels: ChannelScheduledSyncCandidate[]): Promise<{
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
    options?: {
      maxPages?: number;
      viewsMode?: 'full' | 'discovery';
    },
  ): Promise<boolean> {
    for (const [index, channel] of channels.entries()) {
      if (index > 0) {
        await this.sleepBetweenChannels('scheduled');
      }

      const audienceSyncedAt = syncedAudienceAtByChatId.get(channel.id);
      let syncResult: ChannelStatsSyncResult;
      try {
        syncResult = await this.syncChannel(channel.id, {
          reason: 'scheduled',
          skipAudience: true,
          ...(options?.maxPages ? { maxPages: options.maxPages } : {}),
          ...(options?.viewsMode ? { viewsMode: options.viewsMode } : {}),
          ...(audienceSyncedAt ? { audienceSyncedAt } : {}),
        });
      } catch (error: unknown) {
        await this.markViewsSyncAttempt(channel.id, new Date());
        if (this.isMaxApiThrottleError(error)) {
          const backoffMs = await this.activateBackgroundSyncBackoff();
          this.logger.warn(
            {
              reason: 'scheduled',
              chatId: channel.id,
              backoffMs,
              err: error instanceof Error ? error.message : String(error),
            },
            'Paused background channel stats sync after MAX API throttling',
          );
          return true;
        }

        this.logger.warn(
          {
            reason: 'scheduled',
            chatId: channel.id,
            err: error instanceof Error ? error.message : String(error),
          },
          'Skipped one channel after an unexpected stats sync failure',
        );
        continue;
      }
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
        return true;
      }
    }

    return false;
  }

  private async markViewsSyncAttempt(chatId: string, attemptedAt: Date): Promise<void> {
    await this.prisma.channelStatsSyncState.upsert({
      where: { chatId },
      create: { chatId, lastViewsAttemptAt: attemptedAt },
      update: { lastViewsAttemptAt: attemptedAt },
    });
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
    const leftSyncedAtMs = this.resolveScheduledViewsCursorMs(left, 'full');
    const rightSyncedAtMs = this.resolveScheduledViewsCursorMs(right, 'full');
    return this.compareNullableFreshness(leftSyncedAtMs, rightSyncedAtMs, left.id, right.id);
  }

  private compareScheduledViewsDiscoveryCandidates(
    left: ChannelScheduledSyncCandidate,
    right: ChannelScheduledSyncCandidate,
  ): number {
    const leftSyncedAtMs = this.resolveScheduledViewsCursorMs(left, 'discovery');
    const rightSyncedAtMs = this.resolveScheduledViewsCursorMs(right, 'discovery');
    return this.compareNullableFreshness(leftSyncedAtMs, rightSyncedAtMs, left.id, right.id);
  }

  private resolveScheduledViewsCursorMs(
    channel: ChannelScheduledSyncCandidate,
    mode: 'full' | 'discovery',
  ): number | null {
    const state = channel.channelStatsSyncState;
    if (!state) {
      return null;
    }

    const cursors = [
      state.lastViewsSyncAt,
      state.lastViewsAttemptAt,
      ...(mode === 'discovery' ? [state.lastViewsDiscoveryAt] : []),
    ].filter((value): value is Date => value instanceof Date);
    if (cursors.length === 0) {
      return null;
    }

    return Math.max(...cursors.map((value) => value.getTime()));
  }

  private resolvePriorityViewsMaxChannels(channelCount: number): number {
    const passesPerTargetCycle = Math.max(
      1,
      Math.floor(
        CHANNEL_STATS_PRIORITY_RECENT_VIEWS_TARGET_CYCLE_MS /
          CHANNEL_STATS_AUDIENCE_CATCH_UP_INTERVAL_MS,
      ),
    );
    const requiredChannelsPerPass = Math.max(
      CHANNEL_STATS_PRIORITY_RECENT_VIEWS_MIN_CHANNELS,
      Math.ceil(channelCount / passesPerTargetCycle),
    );
    if (
      requiredChannelsPerPass > CHANNEL_STATS_PRIORITY_RECENT_VIEWS_MAX_CHANNELS &&
      Date.now() - this.priorityViewsCapacityLogAtMs >=
        CHANNEL_STATS_PRIORITY_RECENT_VIEWS_CAPACITY_LOG_INTERVAL_MS
    ) {
      this.priorityViewsCapacityLogAtMs = Date.now();
      this.logger.warn(
        {
          channelCount,
          requiredChannelsPerPass,
          maxChannelsPerPass: CHANNEL_STATS_PRIORITY_RECENT_VIEWS_MAX_CHANNELS,
          targetCycleHours: CHANNEL_STATS_PRIORITY_RECENT_VIEWS_TARGET_CYCLE_MS / (60 * 60 * 1000),
        },
        'Channel views discovery fleet exceeds the bounded target-cycle capacity',
      );
    }

    return Math.min(requiredChannelsPerPass, CHANNEL_STATS_PRIORITY_RECENT_VIEWS_MAX_CHANNELS);
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

  private resolveScheduledAudienceCatchUpMaxChannels(options?: {
    priorityViewsLane?: boolean;
    slowActive?: boolean;
  }): number {
    const slowActive = options?.slowActive ?? this.isBackgroundSyncSlowActive();
    if (options?.priorityViewsLane && slowActive) {
      return CHANNEL_STATS_PRIORITY_AUDIENCE_SLOW_MAX_CHANNELS;
    }

    return slowActive
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
      viewsMode?: 'full' | 'discovery';
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
        const viewsMode = options?.viewsMode ?? 'full';
        let audienceUnavailable = false;
        let viewsAttempted = false;

        if (!options?.skipAudience) {
          const audienceResult = await this.syncOfficialAudienceSnapshot(chatId, {
            now,
            reason: options?.reason ?? 'manual',
            statsBotId,
          });
          result.audienceSynced = audienceResult.audienceSynced;
          result.throttled ||= audienceResult.throttled;
          audienceUnavailable = audienceResult.unavailable === true;
        }

        if (!result.throttled && !audienceUnavailable) {
          viewsAttempted = true;
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
        const nextViewsCoverageFrom =
          viewsMode === 'full'
            ? (state?.viewsCoverageFrom ?? lookbackFrom)
            : (state?.viewsCoverageFrom ?? null);
        const nextStateCreate = {
          chatId,
          viewsCoverageFrom: nextViewsCoverageFrom,
          membershipCoverageFrom: nextMembershipCoverageFrom,
          lastAudienceSyncAt: nextLastAudienceSyncAt,
          lastViewsSyncAt:
            result.viewsSynced && viewsMode === 'full' ? now : (state?.lastViewsSyncAt ?? null),
          lastViewsDiscoveryAt: result.viewsSynced ? now : (state?.lastViewsDiscoveryAt ?? null),
          lastViewsAttemptAt: viewsAttempted ? now : (state?.lastViewsAttemptAt ?? null),
          lastOpportunisticSyncAt: options?.markOpportunistic
            ? now
            : (state?.lastOpportunisticSyncAt ?? null),
        };

        await this.prisma.channelStatsSyncState.upsert({
          where: { chatId },
          create: nextStateCreate,
          update: {
            ...(viewsMode === 'full' ? { viewsCoverageFrom: nextViewsCoverageFrom } : {}),
            membershipCoverageFrom: nextMembershipCoverageFrom,
            ...(result.audienceSynced || options?.audienceSyncedAt
              ? { lastAudienceSyncAt: nextLastAudienceSyncAt }
              : {}),
            ...(result.viewsSynced && viewsMode === 'full' ? { lastViewsSyncAt: now } : {}),
            ...(result.viewsSynced ? { lastViewsDiscoveryAt: now } : {}),
            ...(viewsAttempted ? { lastViewsAttemptAt: now } : {}),
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
      const publishedAt = new Date(message.publishedAt);
      const views =
        typeof message.views === 'number' && Number.isFinite(message.views)
          ? Math.max(message.views, 0)
          : null;
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
          publishedAt,
          url: message.url,
          previewUrl: message.previewUrl,
          ...(views !== null ? { latestViews: views, latestSnapshotAt: capturedAt } : {}),
          latestReactions:
            reactions.length > 0 ? (reactions as Prisma.InputJsonValue) : Prisma.DbNull,
          latestReactionsTotal: reactionsTotal,
        },
        update: {
          publishedAt,
          url: message.url,
          previewUrl: message.previewUrl,
          ...(views !== null ? { latestViews: views, latestSnapshotAt: capturedAt } : {}),
          latestReactions:
            reactions.length > 0 ? (reactions as Prisma.InputJsonValue) : Prisma.DbNull,
          latestReactionsTotal: reactionsTotal,
        },
        select: {
          id: true,
          viewSnapshots: {
            orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
            take: 1,
            select: { views: true },
          },
        },
      });

      if (views === null) {
        continue;
      }

      if (post.viewSnapshots[0]?.views !== views) {
        await this.prisma.channelPostViewSnapshot.create({
          data: {
            channelPostId: post.id,
            views,
            reactionsTotal,
            capturedAt,
          },
        });
      }

      const postAgeMs = capturedAt.getTime() - publishedAt.getTime();
      if (
        postAgeMs >= CHANNEL_POST_VIEWS_24H_MS &&
        postAgeMs <= CHANNEL_POST_VIEWS_24H_MS + CHANNEL_POST_VIEWS_MILESTONE_GRACE_MS
      ) {
        await this.prisma.channelPost.updateMany({
          where: {
            id: post.id,
            viewsAt24h: null,
          },
          data: {
            viewsAt24h: views,
            viewsAt24hCapturedAt: capturedAt,
          },
        });
      }

      if (
        postAgeMs >= CHANNEL_POST_VIEWS_48H_MS &&
        postAgeMs <= CHANNEL_POST_VIEWS_48H_MS + CHANNEL_POST_VIEWS_MILESTONE_GRACE_MS
      ) {
        await this.prisma.channelPost.updateMany({
          where: {
            id: post.id,
            viewsAt48h: null,
          },
          data: {
            viewsAt48h: views,
            viewsAt48hCapturedAt: capturedAt,
          },
        });
      }
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
        unavailable: false,
      };
    } catch (error: unknown) {
      const logPayload = {
        chatId,
        reason: params.reason,
        err: error instanceof Error ? error.message : String(error),
      };
      if (this.isMaxApiNotFoundError(error)) {
        const recorded = await this.recordUnavailableAudienceSnapshot(chatId, params.now, {
          status: 'not_found',
        });
        this.logger.debug(logPayload, 'Skipped official channel audience snapshot after MAX 404');
        return {
          audienceSynced: recorded,
          throttled: false,
          syncedAt: recorded ? params.now : null,
          unavailable: recorded,
        };
      } else {
        this.logger.warn(logPayload, 'Failed to sync official channel audience snapshot');
      }

      return {
        audienceSynced: false,
        throttled: this.isMaxApiThrottleError(error),
        syncedAt: null,
        unavailable: false,
      };
    }
  }

  private async recordUnavailableAudienceSnapshot(
    chatId: string,
    capturedAt: Date,
    params: {
      status: string;
    },
  ): Promise<boolean> {
    try {
      await this.prisma.channelAudienceSnapshot.create({
        data: {
          chatId,
          participantsCount: null,
          status: params.status,
          isPublic: null,
          link: null,
          lastEventAt: null,
          capturedAt,
        },
      });
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          status: params.status,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to record unavailable channel audience snapshot',
      );
      return false;
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
        await this.maxClient.ensureWebhookSubscription([...this.requiredWebhookUpdateTypes], {
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

  private isViewsDiscoveryStale(
    syncState: {
      lastViewsSyncAt: Date | null;
      lastViewsDiscoveryAt: Date | null;
    } | null,
    staleMs: number,
    nowMs: number,
  ): boolean {
    const latestSuccessfulAtMs = Math.max(
      syncState?.lastViewsSyncAt?.getTime() ?? Number.NEGATIVE_INFINITY,
      syncState?.lastViewsDiscoveryAt?.getTime() ?? Number.NEGATIVE_INFINITY,
    );
    return !Number.isFinite(latestSuccessfulAtMs) || nowMs - latestSuccessfulAtMs > staleMs;
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
      this.runBackgroundTask('startup_sync_timer', 'startup', () => this.syncStartupChannels());
    }, startupDelayMs);
    this.startupTimer.unref();
  }

  private scheduleScheduledCatchUpOnStartup() {
    this.scheduledCatchUpStartupTimer = setTimeout(() => {
      this.scheduledCatchUpStartupTimer = null;
      this.runBackgroundTask('startup_audience_catch_up_timer', 'scheduled', () =>
        this.syncScheduledAudienceCatchUpOnly('scheduled'),
      );
    }, CHANNEL_STATS_SCHEDULED_CATCH_UP_STARTUP_DELAY_MS);
    this.scheduledCatchUpStartupTimer.unref();
  }

  private runBackgroundTask(
    task: ChannelStatsBackgroundTask,
    reason: 'startup' | 'scheduled',
    operation: () => Promise<void>,
  ): void {
    if (this.shuttingDown) {
      return;
    }

    try {
      const operationPromise = operation();
      const trackedPromise = operationPromise
        .catch((error: unknown) => {
          this.logBackgroundFailure(task, reason, error);
        })
        .finally(() => {
          this.backgroundTasksInFlight.delete(trackedPromise);
        });
      this.backgroundTasksInFlight.add(trackedPromise);
    } catch (error: unknown) {
      this.logBackgroundFailure(task, reason, error);
    }
  }

  private async waitForBackgroundTasksToSettle(): Promise<void> {
    const tasks = [...this.backgroundTasksInFlight];
    if (tasks.length === 0) {
      return;
    }

    let timeout: NodeJS.Timeout | null = null;
    const settled = await Promise.race([
      Promise.allSettled(tasks).then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), CHANNEL_STATS_BACKGROUND_SHUTDOWN_TIMEOUT_MS);
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (!settled) {
      this.logger.warn(
        {
          inFlightTaskCount: this.backgroundTasksInFlight.size,
          timeoutMs: CHANNEL_STATS_BACKGROUND_SHUTDOWN_TIMEOUT_MS,
        },
        'Timed out waiting for channel stats background tasks during shutdown',
      );
    }
  }

  private logBackgroundFailure(
    task: ChannelStatsBackgroundTask,
    reason: 'startup' | 'scheduled',
    error: unknown,
  ): void {
    const nowMs = Date.now();
    const lastLogAtMs = this.backgroundFailureLogAtMsByTask.get(task);
    if (
      lastLogAtMs !== undefined &&
      nowMs >= lastLogAtMs &&
      nowMs - lastLogAtMs < CHANNEL_STATS_BACKGROUND_FAILURE_LOG_INTERVAL_MS
    ) {
      return;
    }

    this.backgroundFailureLogAtMsByTask.set(task, nowMs);
    this.logger.warn(
      {
        task,
        reason,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to run channel stats background task',
    );
  }

  private async isBackgroundWorkPaused(
    reason: 'startup' | 'scheduled',
    options?: {
      allowMaxApiCapacitySlowPath?: boolean;
    },
  ): Promise<boolean> {
    if (this.backgroundRuntimeGovernorService) {
      const decision = await this.backgroundRuntimeGovernorService.decide({
        component: 'channel-stats',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC,
        ...(options?.allowMaxApiCapacitySlowPath ? { allowMaxApiCapacitySlowPath: true } : {}),
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
              audienceLimit: options?.allowMaxApiCapacitySlowPath
                ? CHANNEL_STATS_PRIORITY_AUDIENCE_SLOW_MAX_CHANNELS
                : CHANNEL_STATS_SCHEDULED_AUDIENCE_CATCH_UP_SLOW_MAX_CHANNELS,
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
