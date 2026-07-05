import {
  channelStatsResponseSchema,
  type ChannelStatsBucket,
  type ChannelStatsQuery,
  type ChannelStatsResponse,
  type ManagedEntityBotCapability,
  type ManagedEntityType,
  type MembershipActivityPage,
  type MembershipActivityQuery,
} from '@maxim/contracts';
import { Prisma } from '../prisma/prisma-client';
import { MAX_API_SOURCE_TAGS, type MaxClientService } from '../max/max-client.service';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { PrismaService } from '../prisma/prisma.service';
import { mapWithConcurrencyLimit } from './admin-legacy-utils';
import type { AdminChannelStatsRuntimeContext } from './admin-channel-stats-runtime-context';
import {
  selectChannelStatsContentBucketRows,
  selectChannelStatsMembershipBucketRows,
  type ChannelStatsContentBucketRow,
  type ChannelStatsMembershipBucketRow,
} from './stats-read-model-selectors';
import {
  ADMIN_ACTION_HEALTH_LANE,
  CHANNEL_DIALOG_ACTION_COMMENT,
  CHANNEL_DIALOG_ACTION_SUGGEST,
  CHANNEL_STATS_ACTIVITY_ACTIONS,
  CHANNEL_STATS_POST_ACTIONS,
  CHANNEL_STATS_REFRESH_STALE_MS,
  MEMBERSHIP_ACTIVITY_PAGE_LIMIT,
  ONE_HOUR_MS,
  TWENTY_FOUR_HOURS_MS,
  type ChannelStatsBestWindow,
  type ChannelStatsComparisonSeries,
  type ChannelStatsContentBucketPoint,
  type ChannelStatsDeltaMetric,
  type ChannelStatsGraphMarker,
  type ChannelStatsPeriodTotals,
  type ChannelStatsPostRow,
  type ChannelStatsPostViewMetric,
  type ChannelStatsPreviousPeriodSnapshot,
  type ChannelStatsSummaryWindowRow,
  type ChannelStatsViewsBucketPoint,
  type ChannelStatsViewSnapshotRow,
  type ResolveUserProfilesOptions,
} from './admin.service.support';
import type { ChannelStatsCollectorService } from './channel-stats-collector.service';

type ChannelStatsSecondaryRow = {
  posts_with_buttons: unknown;
  comments: unknown;
  suggestions: unknown;
  comment_authors: unknown;
  suggestion_authors: unknown;
  suggestions_delivered: unknown;
  suggestions_failed: unknown;
  last_bot_activity_at: Date | string | null;
};

type ChannelStatsViewWindowSummary = {
  last24h: number | null;
  last48h: number | null;
  totalLast24h: number;
  totalLast48h: number;
  reactions24h: number;
};

export class AdminChannelStatsRuntime {
  constructor(private readonly context: AdminChannelStatsRuntimeContext) {}

  private get prisma(): PrismaService {
    return this.context.prisma;
  }

  private get maxClient(): MaxClientService {
    return this.context.maxClient;
  }

  private get chatContextCache(): ChatContextCacheService {
    return this.context.chatContextCache;
  }

  private get logger(): AdminChannelStatsRuntimeContext['logger'] {
    return this.context.logger;
  }

  private get channelStatsCollector(): ChannelStatsCollectorService | undefined {
    return this.context.channelStatsCollector;
  }

  private get channelStatsRefreshRuns(): Map<string, Promise<void>> {
    return this.context.channelStatsRefreshRuns;
  }

  private resolveChannelStatsFrom(range: ChannelStatsQuery['range'], to: Date): Date {
    return this.context.resolveChannelStatsFrom(range, to);
  }

  private resolveChannelStatsBucket(range: ChannelStatsQuery['range']): ChannelStatsBucket {
    return this.context.resolveChannelStatsBucket(range);
  }

  private getMembershipActivityFeedPage(
    chatId: string,
    from: Date,
    to: Date,
    query: MembershipActivityQuery,
    entityType?: ManagedEntityType,
    profileOptions?: ResolveUserProfilesOptions,
  ): Promise<MembershipActivityPage> {
    return this.context.getMembershipActivityFeedPage(
      chatId,
      from,
      to,
      query,
      entityType,
      profileOptions,
    );
  }

  private buildEmptyMembershipActivityPage(): MembershipActivityPage {
    return this.context.buildEmptyMembershipActivityPage();
  }

  private invalidateChannelStatsResponseCache(chatId: string): void {
    return this.context.invalidateChannelStatsResponseCache(chatId);
  }

  private resolveAssistBotAssignment(
    chatId: string,
    capability: ManagedEntityBotCapability,
  ): Promise<string | undefined> {
    return this.context.resolveAssistBotAssignment(chatId, capability);
  }

  private readTrimmedString(value: unknown): string | null {
    return this.context.readTrimmedString(value);
  }

  private toIsoString(value: unknown): string | null {
    return this.context.toIsoString(value);
  }

  private toSafeInteger(value: unknown): number {
    return this.context.toSafeInteger(value);
  }

  async buildChannelStatsResponse(
    chatId: string,
    statsQuery: ChannelStatsQuery,
  ): Promise<ChannelStatsResponse> {
    const now = new Date();
    const from = this.resolveChannelStatsFrom(statsQuery.range, now);
    const bucket = this.resolveChannelStatsBucket(statsQuery.range);
    const isOverviewMode = statsQuery.mode === 'overview';
    const previousFrom = new Date(from.getTime() - (now.getTime() - from.getTime()));
    const previousTo = new Date(Math.max(previousFrom.getTime(), from.getTime() - 1));
    const summaryAudienceFrom = new Date(now.getTime() - 17 * TWENTY_FOUR_HOURS_MS);
    const summaryTodayFrom = this.floorChannelStatsMoscowDay(now);
    const summaryWeekFrom = new Date(now.getTime() - 7 * TWENTY_FOUR_HOURS_MS);
    const summarySixteenDaysFrom = new Date(now.getTime() - 16 * TWENTY_FOUR_HOURS_MS);
    const summaryViewsFrom = new Date(now.getTime() - 2 * TWENTY_FOUR_HOURS_MS);

    const [
      chat,
      header,
      secondaryRows,
      latestAudienceSnapshot,
      earliestAudienceSnapshot,
      previousAudienceSnapshot,
      audienceSnapshots,
      syncState,
      periodPosts,
      summaryPosts,
      anyPost,
      membershipBucketRows,
      contentBucketRows,
      summaryAudienceSnapshots,
      summaryWindowRows,
      summaryContentRows,
      sixteenDaysMembershipRows,
    ] = await Promise.all([
      this.prisma.chat.findUnique({
        where: { id: chatId },
        select: { id: true, title: true },
      }),
      this.chatContextCache.getManagedEntityHeader?.(chatId, 'channel') ?? Promise.resolve(null),
      isOverviewMode
        ? Promise.resolve([this.buildEmptyChannelStatsSecondaryRow()])
        : this.prisma.$queryRaw<ChannelStatsSecondaryRow[]>`
            SELECT
              COUNT(DISTINCT CASE
                WHEN action IN (${Prisma.join(CHANNEL_STATS_POST_ACTIONS)})
                THEN NULLIF(BTRIM(payload->>'threadId'), '')
                ELSE NULL
              END) AS posts_with_buttons,
              COUNT(*) FILTER (WHERE action = ${CHANNEL_DIALOG_ACTION_COMMENT}) AS comments,
              COUNT(*) FILTER (WHERE action = ${CHANNEL_DIALOG_ACTION_SUGGEST}) AS suggestions,
              COUNT(DISTINCT CASE
                WHEN action = ${CHANNEL_DIALOG_ACTION_COMMENT}
                THEN actor_user_id
                ELSE NULL
              END) AS comment_authors,
              COUNT(DISTINCT CASE
                WHEN action = ${CHANNEL_DIALOG_ACTION_SUGGEST}
                THEN actor_user_id
                ELSE NULL
              END) AS suggestion_authors,
              COUNT(*) FILTER (
                WHERE action = ${CHANNEL_DIALOG_ACTION_SUGGEST}
                  AND payload->>'delivered' = 'true'
              ) AS suggestions_delivered,
              COUNT(*) FILTER (
                WHERE action = ${CHANNEL_DIALOG_ACTION_SUGGEST}
                  AND payload->>'delivered' = 'false'
              ) AS suggestions_failed,
              MAX(created_at) FILTER (
                WHERE action IN (${Prisma.join(CHANNEL_STATS_ACTIVITY_ACTIONS)})
              ) AS last_bot_activity_at
            FROM audit_logs
            WHERE chat_id = ${chatId}
              AND created_at >= ${from}
              AND created_at <= ${now}
          `,
      this.prisma.channelAudienceSnapshot.findFirst({
        where: { chatId },
        orderBy: { capturedAt: 'desc' },
      }),
      this.prisma.channelAudienceSnapshot.findFirst({
        where: { chatId },
        orderBy: { capturedAt: 'asc' },
        select: {
          capturedAt: true,
        },
      }),
      this.prisma.channelAudienceSnapshot.findFirst({
        where: {
          chatId,
          capturedAt: { lt: from },
        },
        orderBy: { capturedAt: 'desc' },
        select: {
          participantsCount: true,
        },
      }),
      this.prisma.channelAudienceSnapshot.findMany({
        where: {
          chatId,
          capturedAt: { gte: from, lte: now },
        },
        orderBy: { capturedAt: 'asc' },
        select: {
          capturedAt: true,
          participantsCount: true,
        },
      }),
      this.prisma.channelStatsSyncState.findUnique({
        where: { chatId },
      }),
      isOverviewMode
        ? Promise.resolve<ChannelStatsPostRow[]>([])
        : this.prisma.channelPost.findMany({
            where: {
              chatId,
              publishedAt: { gte: from, lte: now },
            },
            orderBy: { publishedAt: 'asc' },
            select: {
              id: true,
              messageId: true,
              publishedAt: true,
              url: true,
              previewUrl: true,
              latestViews: true,
              latestReactions: true,
              latestReactionsTotal: true,
              latestSnapshotAt: true,
            },
          }),
      isOverviewMode
        ? Promise.resolve<ChannelStatsPostRow[]>([])
        : this.prisma.channelPost.findMany({
            where: {
              chatId,
              publishedAt: { gte: summaryViewsFrom, lte: now },
            },
            orderBy: { publishedAt: 'asc' },
            select: {
              id: true,
              messageId: true,
              publishedAt: true,
              url: true,
              previewUrl: true,
              latestViews: true,
              latestReactions: true,
              latestReactionsTotal: true,
              latestSnapshotAt: true,
            },
          }),
      this.prisma.channelPost.findFirst({
        where: { chatId },
        select: { id: true },
      }),
      selectChannelStatsMembershipBucketRows(this.prisma, { chatId, from, to: now, bucket }),
      selectChannelStatsContentBucketRows(this.prisma, { chatId, from, to: now, bucket }),
      this.prisma.channelAudienceSnapshot.findMany({
        where: {
          chatId,
          capturedAt: { gte: summaryAudienceFrom, lte: now },
        },
        orderBy: { capturedAt: 'asc' },
        select: {
          capturedAt: true,
          participantsCount: true,
        },
      }),
      isOverviewMode
        ? Promise.resolve<ChannelStatsSummaryWindowRow[]>([])
        : this.prisma.$queryRaw<ChannelStatsSummaryWindowRow[]>`
            WITH window_snapshots AS (
              SELECT
                posts.id AS channel_post_id,
                posts.published_at,
                snapshots.captured_at,
                snapshots.id AS snapshot_id,
                snapshots.views,
                snapshots.reactions_total
              FROM channel_post_view_snapshots snapshots
              JOIN channel_posts posts ON posts.id = snapshots.channel_post_id
              WHERE posts.chat_id = ${chatId}
                AND posts.published_at >= ${summaryViewsFrom}
                AND snapshots.captured_at >= ${summaryViewsFrom}
                AND snapshots.captured_at <= ${now}
            ),
            baseline_snapshots AS (
              SELECT DISTINCT ON (snapshots.channel_post_id)
                posts.id AS channel_post_id,
                posts.published_at,
                snapshots.captured_at,
                snapshots.id AS snapshot_id,
                snapshots.views,
                snapshots.reactions_total
              FROM channel_post_view_snapshots snapshots
              JOIN channel_posts posts ON posts.id = snapshots.channel_post_id
              WHERE posts.chat_id = ${chatId}
                AND posts.published_at >= ${summaryViewsFrom}
                AND snapshots.captured_at < ${summaryViewsFrom}
                AND EXISTS (
                  SELECT 1
                  FROM window_snapshots current_window
                  WHERE current_window.channel_post_id = snapshots.channel_post_id
                )
              ORDER BY snapshots.channel_post_id, snapshots.captured_at DESC, snapshots.id DESC
            )
            SELECT *
            FROM baseline_snapshots
            UNION ALL
            SELECT *
            FROM window_snapshots
            ORDER BY channel_post_id ASC, captured_at ASC, snapshot_id ASC
          `,
      isOverviewMode
        ? selectChannelStatsContentBucketRows(this.prisma, {
            chatId,
            from: summaryViewsFrom,
            to: now,
            bucket: 'hour',
          })
        : Promise.resolve<ChannelStatsContentBucketRow[]>([]),
      selectChannelStatsMembershipBucketRows(this.prisma, {
        chatId,
        from: summarySixteenDaysFrom,
        to: now,
        bucket: 'hour',
      }),
    ]);

    const refreshQueued = this.shouldRefreshChannelStats(latestAudienceSnapshot, syncState)
      ? this.scheduleChannelStatsRefresh(chatId)
      : false;
    const hasMembershipCoverageFrom = (windowFrom: Date) =>
      Boolean(
        syncState?.membershipCoverageFrom &&
          syncState.membershipCoverageFrom.getTime() <= windowFrom.getTime(),
      );
    const todayMembershipRows = this.filterChannelStatsMembershipRowsFrom(
      sixteenDaysMembershipRows,
      summaryTodayFrom,
    );
    const weekMembershipRows = this.filterChannelStatsMembershipRowsFrom(
      sixteenDaysMembershipRows,
      summaryWeekFrom,
    );

    const localTitle = chat?.title?.trim() || `Канал ${chatId}`;
    let maxSnapshotAvailable = latestAudienceSnapshot !== null;
    let title = localTitle;
    let participantsCount = latestAudienceSnapshot?.participantsCount ?? null;
    let status = latestAudienceSnapshot?.status ?? null;
    let isPublic = latestAudienceSnapshot?.isPublic ?? null;
    let link = latestAudienceSnapshot?.link ?? null;
    let lastEventAt = latestAudienceSnapshot?.lastEventAt?.toISOString() ?? null;
    let avatarUrl = header?.avatarUrl?.trim() || null;

    if (latestAudienceSnapshot) {
      title = chat?.title?.trim() || localTitle;
    } else {
      try {
        const snapshot = await this.maxClient.getChatSnapshot(chatId, {
          actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
        });
        title = snapshot.title?.trim() || localTitle;
        participantsCount = snapshot.participantsCount;
        status = snapshot.status;
        isPublic = snapshot.isPublic;
        link = snapshot.link;
        lastEventAt = snapshot.lastEventAt;
        avatarUrl = snapshot.avatarUrl?.trim() || avatarUrl;
        maxSnapshotAvailable = true;
      } catch (error: unknown) {
        maxSnapshotAvailable = false;
        this.logger.warn(
          {
            chatId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to fetch MAX fallback snapshot for channel stats',
        );
      }
    }

    const secondary = secondaryRows[0] ?? {
      posts_with_buttons: 0,
      comments: 0,
      suggestions: 0,
      comment_authors: 0,
      suggestion_authors: 0,
      suggestions_delivered: 0,
      suggestions_failed: 0,
      last_bot_activity_at: null,
    };

    const churnAvailable = Boolean(
      syncState?.membershipCoverageFrom &&
      syncState.membershipCoverageFrom.getTime() <= from.getTime(),
    );
    const bucketStarts = this.buildChannelStatsBucketStarts(from, now, bucket);
    const membershipSeries = this.buildMembershipSeriesFromBucketRows(
      bucketStarts,
      membershipBucketRows,
    );
    const joined = membershipSeries.reduce((total, item) => total + item.joined, 0);
    const left = membershipSeries.reduce((total, item) => total + item.left, 0);
    const contentSeries = this.buildContentSeriesFromBucketRows(bucketStarts, contentBucketRows);
    const contentTotals = this.buildContentTotals(contentSeries);
    const postViewMetrics = isOverviewMode ? [] : this.buildPostViewMetrics(periodPosts, [], from);
    const periodPostsCount = isOverviewMode ? contentTotals.posts : periodPosts.length;
    const periodViews = isOverviewMode
      ? contentTotals.viewsDelta
      : this.sumChannelPostMetricViews(postViewMetrics);
    const viewsSeries = isOverviewMode
      ? this.buildAverageViewsSeriesFromContentSeries(contentSeries)
      : this.buildAverageViewsSeriesFromPostMetrics(bucketStarts, postViewMetrics, bucket);
    const todayMembershipFlow = this.buildChannelStatsMembershipFlow(
      todayMembershipRows,
      hasMembershipCoverageFrom(summaryTodayFrom),
    );
    const summary = this.buildChannelStatsSummary({
      participantsCount,
      audienceSnapshots: summaryAudienceSnapshots,
      summaryPosts,
      summaryWindowRows,
      viewWindows: isOverviewMode
        ? this.buildChannelStatsViewWindowSummaryFromContentRows(summaryContentRows, now)
        : undefined,
      summaryMembershipRows: sixteenDaysMembershipRows,
      summaryMembershipCoverageFrom: syncState?.membershipCoverageFrom ?? null,
      membershipDeltas: {
        today: todayMembershipFlow.net,
        todayJoined: todayMembershipFlow.joined,
        todayLeft: todayMembershipFlow.left,
        week: this.buildChannelStatsMembershipDelta(
          weekMembershipRows,
          hasMembershipCoverageFrom(summaryWeekFrom),
        ),
        sixteenDays: this.buildChannelStatsMembershipDelta(
          sixteenDaysMembershipRows,
          hasMembershipCoverageFrom(summarySixteenDaysFrom),
        ),
      },
      now,
    });
    const topReactions = isOverviewMode ? [] : this.buildTopReactions(periodPosts);
    const topPosts = isOverviewMode
      ? []
      : await this.hydrateTopPostPreviews(chatId, this.buildTopPosts(postViewMetrics));
    const participantSeries = this.buildParticipantSeries(
      bucketStarts,
      bucket,
      previousAudienceSnapshot?.participantsCount ?? participantsCount,
      audienceSnapshots,
    );
    const activityFeed = statsQuery.includeActivityPreview
      ? await this.getMembershipActivityFeedPage(
          chatId,
          from,
          now,
          {
            range: statsQuery.range,
            filter: 'all',
            limit: MEMBERSHIP_ACTIVITY_PAGE_LIMIT,
          },
          'channel',
        )
      : this.buildEmptyMembershipActivityPage();
    const previousPeriod = isOverviewMode
      ? this.buildEmptyPreviousChannelStatsPeriodSnapshot()
      : await this.buildPreviousChannelStatsPeriodSnapshot(chatId, previousFrom, previousTo, bucket);
    const previousTotals = previousPeriod.totals;
    const currentTotals: ChannelStatsPeriodTotals = {
      joined,
      left,
      net: joined - left,
      posts: periodPostsCount,
      views: periodViews,
      averageViewsPerPost:
        periodPostsCount > 0 ? Math.round(periodViews / periodPostsCount) : 0,
      reactions: contentTotals.reactions,
    };
    const comparison = this.buildChannelStatsComparison(
      currentTotals,
      previousTotals,
      {
        from: previousFrom,
        to: previousTo,
      },
      isOverviewMode ? undefined : previousPeriod.series,
    );
    const signals = this.buildChannelStatsSignals({
      topPosts,
      membershipSeries,
      viewsSeries,
      postViewMetrics,
    });
    const response: ChannelStatsResponse = {
      channel: {
        id: chatId,
        title,
        participantsCount,
        status,
        isPublic,
        link,
        lastEventAt,
        avatarUrl,
      },
      period: {
        range: statsQuery.range,
        from: from.toISOString(),
        to: now.toISOString(),
        bucket,
      },
      official: {
        audience: {
          joined,
          left,
          net: joined - left,
        },
        content: {
          posts: periodPostsCount,
          views: periodViews,
          reactions: contentTotals.reactions,
          topReactions,
          topPosts,
          lastPublishedAt:
            periodPosts.length > 0
              ? periodPosts[periodPosts.length - 1].publishedAt.toISOString()
              : null,
        },
        series: {
          participants: participantSeries,
          membership: membershipSeries,
          views: viewsSeries,
        },
      },
      summary,
      secondary: {
        postsWithButtons: this.toSafeInteger(secondary.posts_with_buttons),
        comments: this.toSafeInteger(secondary.comments),
        suggestions: this.toSafeInteger(secondary.suggestions),
        commentAuthors: this.toSafeInteger(secondary.comment_authors),
        suggestionAuthors: this.toSafeInteger(secondary.suggestion_authors),
        suggestionsDelivered: this.toSafeInteger(secondary.suggestions_delivered),
        suggestionsFailed: this.toSafeInteger(secondary.suggestions_failed),
        lastBotActivityAt: this.toIsoString(secondary.last_bot_activity_at),
      },
      meta: {
        maxSnapshotAvailable,
        viewsAvailable: Boolean(anyPost),
        churnAvailable,
        officialCoverageFrom: this.resolveOfficialCoverageFrom(
          syncState,
          earliestAudienceSnapshot?.capturedAt ?? null,
        ),
        refreshQueued,
      },
      comparison,
      signals,
      activityFeed,
    };

    return channelStatsResponseSchema.parse(response);
  }

  buildChannelStatsResponseCacheKey(
    chatId: string,
    userId: string,
    query: ChannelStatsQuery,
  ): string {
    void userId;
    return [
      chatId,
      'views-posts-v1',
      query.range,
      `mode=${query.mode ?? 'full'}`,
      `activity=${query.includeActivityPreview ? 1 : 0}`,
    ].join(':');
  }

  shouldRefreshChannelStats(
    latestAudienceSnapshot: { capturedAt: Date } | null,
    syncState: { lastAudienceSyncAt: Date | null; lastViewsSyncAt: Date | null } | null,
  ): boolean {
    const nowMs = Date.now();
    const audienceStale =
      !latestAudienceSnapshot ||
      nowMs - latestAudienceSnapshot.capturedAt.getTime() > CHANNEL_STATS_REFRESH_STALE_MS ||
      !syncState?.lastAudienceSyncAt ||
      nowMs - syncState.lastAudienceSyncAt.getTime() > CHANNEL_STATS_REFRESH_STALE_MS;
    const viewsStale =
      !syncState?.lastViewsSyncAt ||
      nowMs - syncState.lastViewsSyncAt.getTime() > CHANNEL_STATS_REFRESH_STALE_MS;

    return audienceStale || viewsStale;
  }

  scheduleChannelStatsRefresh(chatId: string): boolean {
    const collector = this.channelStatsCollector;
    if (!collector) {
      return false;
    }

    const existing = this.channelStatsRefreshRuns.get(chatId);
    if (existing) {
      return true;
    }

    const pending = Promise.resolve()
      .then(() =>
        collector.syncChannelIfStale(chatId, {
          staleMs: CHANNEL_STATS_REFRESH_STALE_MS,
          reason: 'stats_endpoint',
        }),
      )
      .catch((error: unknown) => {
        this.logger.warn(
          {
            chatId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to refresh channel stats in background',
        );
      })
      .finally(() => {
        this.channelStatsRefreshRuns.delete(chatId);
        this.invalidateChannelStatsResponseCache(chatId);
      });
    this.channelStatsRefreshRuns.set(chatId, pending);
    return true;
  }

  buildEmptyPreviousChannelStatsPeriodSnapshot(): ChannelStatsPreviousPeriodSnapshot {
    return {
      totals: {
        joined: 0,
        left: 0,
        net: 0,
        posts: 0,
        views: 0,
        averageViewsPerPost: 0,
        reactions: 0,
      },
      series: {
        participants: [],
        membership: [],
        views: [],
      },
    };
  }

  buildEmptyChannelStatsSecondaryRow(): ChannelStatsSecondaryRow {
    return {
      posts_with_buttons: 0,
      comments: 0,
      suggestions: 0,
      comment_authors: 0,
      suggestion_authors: 0,
      suggestions_delivered: 0,
      suggestions_failed: 0,
      last_bot_activity_at: null,
    };
  }

  async buildPreviousChannelStatsPeriodSnapshot(
    chatId: string,
    from: Date,
    to: Date,
    bucket: ChannelStatsBucket,
  ): Promise<ChannelStatsPreviousPeriodSnapshot> {
    const [
      membershipBucketRows,
      contentBucketRows,
      previousAudienceSnapshot,
      audienceSnapshots,
      periodPosts,
    ] = await Promise.all([
        selectChannelStatsMembershipBucketRows(this.prisma, { chatId, from, to, bucket }),
        selectChannelStatsContentBucketRows(this.prisma, { chatId, from, to, bucket }),
        this.prisma.channelAudienceSnapshot.findFirst({
          where: {
            chatId,
            capturedAt: { lt: from },
          },
          orderBy: { capturedAt: 'desc' },
          select: {
            participantsCount: true,
          },
        }),
        this.prisma.channelAudienceSnapshot.findMany({
          where: {
            chatId,
            capturedAt: { gte: from, lte: to },
          },
          orderBy: { capturedAt: 'asc' },
          select: {
            capturedAt: true,
            participantsCount: true,
          },
        }),
        this.prisma.channelPost.findMany({
          where: {
            chatId,
            publishedAt: { gte: from, lte: to },
          },
          orderBy: { publishedAt: 'asc' },
          select: {
            id: true,
            messageId: true,
            publishedAt: true,
            url: true,
            previewUrl: true,
            latestViews: true,
            latestReactions: true,
            latestReactionsTotal: true,
            latestSnapshotAt: true,
          },
        }),
      ]);

    const bucketStarts = this.buildChannelStatsBucketStarts(from, to, bucket);
    const contentSeries = this.buildContentSeriesFromBucketRows(bucketStarts, contentBucketRows);
    const contentTotals = this.buildContentTotals(contentSeries);
    const postViewMetrics = this.buildPostViewMetrics(periodPosts, [], from);
    const viewsSeries = this.buildAverageViewsSeriesFromPostMetrics(
      bucketStarts,
      postViewMetrics,
      bucket,
    );
    const views = this.sumChannelPostMetricViews(postViewMetrics);

    const membershipSeries = this.buildMembershipSeriesFromBucketRows(
      bucketStarts,
      membershipBucketRows,
    );
    const joined = membershipSeries.reduce((total, item) => total + item.joined, 0);
    const left = membershipSeries.reduce((total, item) => total + item.left, 0);
    const participantSeries = this.buildParticipantSeries(
      bucketStarts,
      bucket,
      previousAudienceSnapshot?.participantsCount ?? null,
      audienceSnapshots,
    );

    return {
      totals: {
        joined,
        left,
        net: joined - left,
        posts: periodPosts.length,
        views,
        averageViewsPerPost: periodPosts.length > 0 ? Math.round(views / periodPosts.length) : 0,
        reactions: contentTotals.reactions,
      },
      series: {
        participants: participantSeries,
        membership: membershipSeries,
        views: viewsSeries,
      },
    };
  }

  buildChannelStatsComparison(
    current: ChannelStatsPeriodTotals,
    previous: ChannelStatsPeriodTotals,
    period: { from: Date; to: Date },
    series?: ChannelStatsComparisonSeries,
  ): ChannelStatsResponse['comparison'] {
    return {
      period: {
        from: period.from.toISOString(),
        to: period.to.toISOString(),
      },
      deltas: {
        audienceNet: this.buildChannelStatsDeltaMetric(current.net, previous.net),
        joined: this.buildChannelStatsDeltaMetric(current.joined, previous.joined),
        left: this.buildChannelStatsDeltaMetric(current.left, previous.left),
        posts: this.buildChannelStatsDeltaMetric(current.posts, previous.posts),
        views: this.buildChannelStatsDeltaMetric(current.views, previous.views),
        averageViewsPerPost: this.buildChannelStatsDeltaMetric(
          current.averageViewsPerPost,
          previous.averageViewsPerPost,
        ),
        reactions: this.buildChannelStatsDeltaMetric(current.reactions, previous.reactions),
      },
      ...(series ? { series } : {}),
    };
  }

  buildChannelStatsDeltaMetric(current: number, previous: number): ChannelStatsDeltaMetric {
    const normalizedCurrent = this.toSafeInteger(current);
    const normalizedPrevious = this.toSafeInteger(previous);
    const absolute = normalizedCurrent - normalizedPrevious;
    const percent =
      normalizedPrevious === 0
        ? normalizedCurrent === 0
          ? 0
          : null
        : Math.round((absolute / Math.abs(normalizedPrevious)) * 1000) / 10;

    return {
      current: normalizedCurrent,
      previous: normalizedPrevious,
      absolute,
      percent,
    };
  }

  buildChannelStatsSignals(params: {
    topPosts: ChannelStatsResponse['official']['content']['topPosts'];
    membershipSeries: ChannelStatsResponse['official']['series']['membership'];
    viewsSeries: ChannelStatsResponse['official']['series']['views'];
    postViewMetrics: ChannelStatsPostViewMetric[];
  }): ChannelStatsResponse['signals'] {
    const markers: ChannelStatsGraphMarker[] = [];
    const bestWindows = this.buildChannelStatsBestWindows(params.postViewMetrics);

    const topPost = params.topPosts[0] ?? null;
    if (topPost) {
      const topPostValue = topPost.viewsDelta;
      markers.push({
        code: 'top-post',
        type: 'post',
        label: '#1',
        value: this.formatChannelStatsCompactCount(topPostValue),
        tone: 'accent',
        at: topPost.publishedAt,
      });
    }

    const peakView = params.viewsSeries.reduce<(typeof params.viewsSeries)[number] | null>(
      (peak, item) => (!peak || item.views > peak.views ? item : peak),
      null,
    );
    if (peakView && peakView.views > 0) {
      markers.push({
        code: 'views-peak',
        type: 'peak',
        label: 'Пик',
        value: this.formatChannelStatsCompactCount(peakView.views),
        tone: 'success',
        at: peakView.at,
      });
    }

    const peakLeft = params.membershipSeries.reduce<
      (typeof params.membershipSeries)[number] | null
    >((peak, item) => (!peak || (item.left ?? 0) > (peak.left ?? 0) ? item : peak), null);
    if (peakLeft && (peakLeft.left ?? 0) > Math.max(0, peakLeft.joined)) {
      markers.push({
        code: 'audience-left-peak',
        type: 'anomaly',
        label: 'Отток',
        value: this.formatChannelStatsSignedInteger(-Math.max(0, peakLeft.left ?? 0)),
        tone: 'danger',
        at: peakLeft.at,
      });
    }

    return {
      markers: markers.slice(0, 8),
      bestWindows,
    };
  }

  buildChannelStatsBestWindows(
    postViewMetrics: ChannelStatsPostViewMetric[],
  ): ChannelStatsBestWindow[] {
    const grouped = new Map<
      string,
      {
        dayOfWeek: number;
        hour: number;
        posts: number;
        views: number;
        reactions: number;
      }
    >();

    for (const metric of postViewMetrics) {
      const views = Math.max(0, this.toSafeInteger(metric.post.latestViews));
      if (views <= 0) {
        continue;
      }

      const { dayOfWeek, hour } = this.resolveChannelStatsMoscowWindow(metric.post.publishedAt);
      const key = `${dayOfWeek}:${hour}`;
      const current = grouped.get(key) ?? {
        dayOfWeek,
        hour,
        posts: 0,
        views: 0,
        reactions: 0,
      };
      current.posts += 1;
      current.views += views;
      current.reactions += this.toSafeInteger(metric.post.latestReactionsTotal);
      grouped.set(key, current);
    }

    return Array.from(grouped.values())
      .map((item) => {
        const averageViews = item.posts > 0 ? Math.round(item.views / item.posts) : 0;
        const averageReactions = item.posts > 0 ? Math.round(item.reactions / item.posts) : 0;
        return {
          dayOfWeek: item.dayOfWeek,
          hour: item.hour,
          score: averageViews + averageReactions * 12 + item.posts * 4,
          posts: item.posts,
          averageViews,
          averageReactions,
        };
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.posts - left.posts ||
          left.dayOfWeek - right.dayOfWeek ||
          left.hour - right.hour,
      )
      .slice(0, 3);
  }

  resolveChannelStatsMoscowWindow(date: Date): { dayOfWeek: number; hour: number } {
    const moscowDate = new Date(date.getTime() + 3 * ONE_HOUR_MS);
    return {
      dayOfWeek: moscowDate.getUTCDay(),
      hour: moscowDate.getUTCHours(),
    };
  }

  formatChannelStatsSignedInteger(value: number): string {
    const normalized = this.toSafeInteger(value);
    return normalized > 0 ? `+${normalized}` : String(normalized);
  }

  formatChannelStatsCompactCount(value: number): string {
    const normalized = Math.max(0, this.toSafeInteger(value));
    if (normalized < 100_000) {
      return new Intl.NumberFormat('ru-RU').format(normalized);
    }

    return new Intl.NumberFormat('ru-RU', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(normalized);
  }

  buildChannelStatsBucketStarts(from: Date, to: Date, bucket: ChannelStatsBucket): Date[] {
    const starts: Date[] = [];
    let cursor = this.floorChannelStatsBucket(from, bucket);
    const end = this.floorChannelStatsBucket(to, bucket);

    while (cursor.getTime() <= end.getTime()) {
      starts.push(cursor);
      cursor = this.shiftChannelStatsBucket(cursor, bucket, 1);
    }

    return starts;
  }

  floorChannelStatsBucket(date: Date, bucket: ChannelStatsBucket): Date {
    if (bucket === 'day') {
      return this.floorChannelStatsMoscowDay(date);
    }

    const result = new Date(date);
    result.setUTCMinutes(0, 0, 0);
    return result;
  }

  shiftChannelStatsBucket(date: Date, bucket: ChannelStatsBucket, amount: number): Date {
    const result = new Date(date);
    if (bucket === 'hour') {
      result.setUTCHours(result.getUTCHours() + amount);
      return result;
    }

    result.setUTCDate(result.getUTCDate() + amount);
    return result;
  }

  buildParticipantSeries(
    bucketStarts: Date[],
    bucket: ChannelStatsBucket,
    initialParticipantsCount: number | null,
    snapshots: Array<{ capturedAt: Date; participantsCount: number | null }>,
  ) {
    let cursorValue = initialParticipantsCount;
    let snapshotIndex = 0;

    return bucketStarts.map((bucketStart) => {
      const bucketEnd = this.shiftChannelStatsBucket(bucketStart, bucket, 1);
      while (
        snapshotIndex < snapshots.length &&
        snapshots[snapshotIndex].capturedAt.getTime() < bucketEnd.getTime()
      ) {
        cursorValue = snapshots[snapshotIndex].participantsCount;
        snapshotIndex += 1;
      }

      return {
        at: bucketStart.toISOString(),
        participantsCount: cursorValue,
      };
    });
  }

  buildMembershipSeriesFromBucketRows(
    bucketStarts: Date[],
    rows: ChannelStatsMembershipBucketRow[],
  ) {
    const grouped = new Map<string, { joined: number; left: number }>();

    for (const row of rows) {
      const bucketStart = this.toIsoString(row.bucket_start);
      if (!bucketStart) {
        continue;
      }
      grouped.set(new Date(bucketStart).toISOString(), {
        joined: this.toSafeInteger(row.joined_users),
        left: this.toSafeInteger(row.left_users),
      });
    }

    return bucketStarts.map((bucketStart) => {
      const current = grouped.get(bucketStart.toISOString()) ?? { joined: 0, left: 0 };
      return {
        at: bucketStart.toISOString(),
        joined: current.joined,
        left: current.left,
      };
    });
  }

  buildPostViewMetrics(
    posts: ChannelStatsPostRow[],
    snapshots: ChannelStatsViewSnapshotRow[],
    from: Date,
  ): ChannelStatsPostViewMetric[] {
    const snapshotsByPostId = new Map<string, ChannelStatsViewSnapshotRow[]>();
    for (const snapshot of snapshots) {
      const current = snapshotsByPostId.get(snapshot.channelPostId) ?? [];
      current.push(snapshot);
      snapshotsByPostId.set(snapshot.channelPostId, current);
    }

    return posts.map((post) => {
      const postSnapshots = snapshotsByPostId
        .get(post.id)
        ?.slice()
        .sort((left, right) => left.capturedAt.getTime() - right.capturedAt.getTime());
      let previousViews: number | null = post.publishedAt.getTime() >= from.getTime() ? 0 : null;
      let viewsDelta = 0;
      const viewDeltas: ChannelStatsPostViewMetric['viewDeltas'] = [];

      for (const snapshot of postSnapshots ?? []) {
        const currentViews = Math.max(0, this.toSafeInteger(snapshot.views));
        if (previousViews === null) {
          previousViews = currentViews;
          continue;
        }

        const snapshotViewsDelta = Math.max(0, currentViews - previousViews);
        viewsDelta += snapshotViewsDelta;
        if (snapshotViewsDelta > 0) {
          viewDeltas.push({
            capturedAt: snapshot.capturedAt,
            viewsDelta: snapshotViewsDelta,
          });
        }
        previousViews = currentViews;
      }

      const hasPeriodDelta =
        Boolean(postSnapshots && postSnapshots.length > 0) &&
        (post.publishedAt.getTime() >= from.getTime() || (postSnapshots?.length ?? 0) >= 2);

      return {
        post,
        viewsDelta: hasPeriodDelta ? viewsDelta : 0,
        viewDeltas: hasPeriodDelta ? viewDeltas : [],
      };
    });
  }

  buildChannelStatsSummary(params: {
    participantsCount: number | null;
    audienceSnapshots: Array<{ capturedAt: Date; participantsCount: number | null }>;
    summaryPosts?: ChannelStatsPostRow[];
    summaryWindowRows: ChannelStatsSummaryWindowRow[];
    viewWindows?: ChannelStatsViewWindowSummary;
    summaryMembershipRows?: ChannelStatsMembershipBucketRow[];
    summaryMembershipCoverageFrom?: Date | null;
    membershipDeltas?: {
      today: number | null;
      todayJoined?: number | null;
      todayLeft?: number | null;
      week: number | null;
      sixteenDays: number | null;
    };
    now: Date;
  }): ChannelStatsResponse['summary'] {
    const sortedAudienceSnapshots = params.audienceSnapshots
      .slice()
      .sort((left, right) => left.capturedAt.getTime() - right.capturedAt.getTime());
    const currentParticipants =
      params.participantsCount ??
      this.resolveLastAudienceCountAt(sortedAudienceSnapshots, params.now) ??
      null;
    const daily = this.buildChannelStatsDailySummary(
      sortedAudienceSnapshots,
      currentParticipants,
      params.now,
      params.summaryMembershipRows,
      params.summaryMembershipCoverageFrom,
    );
    const resolveDelta = (lookbackMs: number) => {
      if (currentParticipants === null) {
        return null;
      }

      const baseline = this.resolveLastAudienceCountAt(
        sortedAudienceSnapshots,
        new Date(params.now.getTime() - lookbackMs),
      );
      return baseline === null ? null : currentParticipants - baseline;
    };
    const viewWindows =
      params.viewWindows ??
      this.buildChannelStatsViewWindowSummary(
        params.summaryPosts ?? [],
        params.summaryWindowRows,
        params.now,
      );
    const er24 =
      viewWindows.totalLast24h > 0 && viewWindows.reactions24h > 0
        ? Math.round((viewWindows.reactions24h / viewWindows.totalLast24h) * 10_000) / 100
        : null;

    return {
      subscribers: {
        current: currentParticipants,
        todayDelta: params.membershipDeltas?.today ?? resolveDelta(TWENTY_FOUR_HOURS_MS),
        todayJoined: params.membershipDeltas?.todayJoined ?? null,
        todayLeft: params.membershipDeltas?.todayLeft ?? null,
        weekDelta: params.membershipDeltas?.week ?? resolveDelta(7 * TWENTY_FOUR_HOURS_MS),
        sixteenDaysDelta:
          params.membershipDeltas?.sixteenDays ?? resolveDelta(16 * TWENTY_FOUR_HOURS_MS),
      },
      views: {
        perPost: viewWindows.last24h,
        last24h: viewWindows.last24h,
        last48h: viewWindows.last48h,
        er24,
      },
      daily,
    };
  }

  buildChannelStatsMembershipDelta(
    rows: ChannelStatsMembershipBucketRow[],
    hasCoverage: boolean,
  ): number | null {
    if (!hasCoverage) {
      return null;
    }

    return rows.reduce(
      (total, row) =>
        total + this.toSafeInteger(row.joined_users) - this.toSafeInteger(row.left_users),
      0,
    );
  }

  buildChannelStatsMembershipFlow(
    rows: ChannelStatsMembershipBucketRow[],
    hasCoverage: boolean,
  ): { joined: number | null; left: number | null; net: number | null } {
    if (rows.length === 0) {
      return {
        joined: hasCoverage ? 0 : null,
        left: hasCoverage ? 0 : null,
        net: hasCoverage ? 0 : null,
      };
    }

    const joined = rows.reduce((total, row) => total + this.toSafeInteger(row.joined_users), 0);
    const left = rows.reduce((total, row) => total + this.toSafeInteger(row.left_users), 0);

    return {
      joined,
      left,
      net: hasCoverage ? joined - left : null,
    };
  }

  buildChannelStatsDailySummary(
    audienceSnapshots: Array<{ capturedAt: Date; participantsCount: number | null }>,
    currentParticipants: number | null,
    now: Date,
    membershipRows?: ChannelStatsMembershipBucketRow[],
    membershipCoverageFrom?: Date | null,
  ): ChannelStatsResponse['summary']['daily'] {
    const firstDay = this.floorChannelStatsMoscowDay(
      new Date(now.getTime() - 15 * TWENTY_FOUR_HOURS_MS),
    );
    const days: ChannelStatsResponse['summary']['daily'] = [];
    let previousCount = this.resolveLastAudienceCountAt(
      audienceSnapshots,
      new Date(firstDay.getTime() - 1),
    );

    for (let offset = 15; offset >= 0; offset -= 1) {
      const day = this.floorChannelStatsMoscowDay(
        new Date(now.getTime() - offset * TWENTY_FOUR_HOURS_MS),
      );
      const dayEnd = new Date(day.getTime() + TWENTY_FOUR_HOURS_MS - 1);
      const subscribers =
        offset === 0 && currentParticipants !== null
          ? currentParticipants
          : this.resolveLastAudienceCountAt(audienceSnapshots, dayEnd);
      const delta =
        subscribers === null || previousCount === null ? null : subscribers - previousCount;
      days.push({
        date: this.formatChannelStatsMoscowDate(day),
        subscribers,
        delta,
        joined: null,
        left: null,
      });

      if (subscribers !== null) {
        previousCount = subscribers;
      }
    }

    const dailyMembershipFlows = membershipRows
      ? this.buildChannelStatsDailyMembershipFlows(
          firstDay,
          membershipRows,
          membershipCoverageFrom ?? null,
        )
      : null;
    if (dailyMembershipFlows) {
      days.forEach((day, index) => {
        const flow = dailyMembershipFlows[index];
        if (!flow) {
          return;
        }

        days[index] = {
          ...day,
          joined: flow.joined,
          left: flow.left,
        };
      });
    }

    if (
      dailyMembershipFlows &&
      currentParticipants !== null &&
      this.canUseMembershipFlowsForDailySubscriberBackfill(
        firstDay,
        audienceSnapshots,
        dailyMembershipFlows,
      )
    ) {
      let runningSubscribers = currentParticipants;
      for (let index = 15; index >= 0; index -= 1) {
        const flow = dailyMembershipFlows[index];
        if (!flow || flow.net === null) {
          break;
        }

        days[index] = {
          date: this.formatChannelStatsMoscowDate(
            new Date(firstDay.getTime() + index * TWENTY_FOUR_HOURS_MS),
          ),
          subscribers: runningSubscribers,
          delta: flow.net,
          joined: flow.joined,
          left: flow.left,
        };
        runningSubscribers -= flow.net;
      }
    }

    return days;
  }

  private canUseMembershipFlowsForDailySubscriberBackfill(
    firstDay: Date,
    audienceSnapshots: Array<{ capturedAt: Date; participantsCount: number | null }>,
    flows: Array<{ joined: number | null; left: number | null; net: number | null }>,
  ): boolean {
    const firstFlowIndex = flows.findIndex(
      (flow) => flow.net !== null && ((flow.joined ?? 0) > 0 || (flow.left ?? 0) > 0),
    );
    if (firstFlowIndex < 0) {
      return false;
    }

    const firstFlowDayStartMs = firstDay.getTime() + firstFlowIndex * TWENTY_FOUR_HOURS_MS;
    return audienceSnapshots.some(
      (snapshot) =>
        typeof snapshot.participantsCount === 'number' &&
        Number.isFinite(snapshot.participantsCount) &&
        snapshot.capturedAt.getTime() < firstFlowDayStartMs,
    );
  }

  buildChannelStatsDailyMembershipFlows(
    firstDay: Date,
    rows: ChannelStatsMembershipBucketRow[],
    membershipCoverageFrom: Date | null,
  ): Array<{ joined: number | null; left: number | null; net: number | null }> {
    const firstDayMs = firstDay.getTime();
    const flows: Array<{ joined: number | null; left: number | null; net: number | null }> =
      Array.from({ length: 16 }, (_, index) => ({
        joined: null,
        left: null,
        net:
          membershipCoverageFrom &&
          membershipCoverageFrom.getTime() <= firstDayMs + index * TWENTY_FOUR_HOURS_MS
            ? 0
            : null,
      }));
    const lastDayExclusiveMs = firstDayMs + 16 * TWENTY_FOUR_HOURS_MS;
    for (const row of rows) {
      const bucketStart = this.toIsoString(row.bucket_start);
      if (!bucketStart) {
        continue;
      }

      const bucketStartMs = new Date(bucketStart).getTime();
      if (
        !Number.isFinite(bucketStartMs) ||
        bucketStartMs < firstDayMs ||
        bucketStartMs >= lastDayExclusiveMs
      ) {
        continue;
      }

      const index = Math.floor((bucketStartMs - firstDayMs) / TWENTY_FOUR_HOURS_MS);
      const flow = flows[index];
      if (flow) {
        const hasDayCoverage = Boolean(
          membershipCoverageFrom &&
            membershipCoverageFrom.getTime() <= firstDayMs + index * TWENTY_FOUR_HOURS_MS,
        );
        const joined = this.toSafeInteger(row.joined_users);
        const left = this.toSafeInteger(row.left_users);
        flow.joined = (flow.joined ?? 0) + joined;
        flow.left = (flow.left ?? 0) + left;
        flow.net = hasDayCoverage ? (flow.net ?? 0) + joined - left : null;
      }
    }

    return flows;
  }

  buildChannelStatsViewWindowSummaryFromContentRows(
    rows: ChannelStatsContentBucketRow[],
    now: Date,
  ): ChannelStatsViewWindowSummary {
    const last24hFrom = new Date(now.getTime() - TWENTY_FOUR_HOURS_MS);
    const last48hFrom = new Date(now.getTime() - 2 * TWENTY_FOUR_HOURS_MS);
    let totalLast24h = 0;
    let totalLast48h = 0;
    let last24hPostCount = 0;
    let last48hPostCount = 0;
    let reactions24h = 0;

    for (const row of rows) {
      const bucketStart = this.toDateOrNull(row.bucket_start);
      if (!bucketStart) {
        continue;
      }

      const posts = this.toSafeInteger(row.posts);
      const views = this.toSafeInteger(row.views_delta);
      const reactions = this.toSafeInteger(row.reactions);
      if (bucketStart >= last48hFrom) {
        totalLast48h += views;
        last48hPostCount += posts;
      }
      if (bucketStart >= last24hFrom) {
        totalLast24h += views;
        last24hPostCount += posts;
        reactions24h += reactions;
      }
    }

    return {
      last24h: last24hPostCount > 0 ? Math.round(totalLast24h / last24hPostCount) : null,
      last48h: last48hPostCount > 0 ? Math.round(totalLast48h / last48hPostCount) : null,
      totalLast24h,
      totalLast48h,
      reactions24h,
    };
  }

  buildChannelStatsViewWindowSummary(
    posts: ChannelStatsPostRow[],
    rows: ChannelStatsSummaryWindowRow[],
    now: Date,
  ): ChannelStatsViewWindowSummary {
    const postsById = new Map(posts.map((post) => [post.id, post]));
    const postIds = new Set(postsById.keys());
    const rowsByPostId = new Map<
      string,
      Array<{
        publishedAt: Date;
        capturedAt: Date;
        snapshotId: string;
        views: number;
        reactionsTotal: number;
      }>
    >();

    for (const row of rows) {
      const publishedAt = this.toDateOrNull(row.published_at);
      const capturedAt = this.toDateOrNull(row.captured_at);
      if (!publishedAt || !capturedAt) {
        continue;
      }

      postIds.add(row.channel_post_id);
      const current = rowsByPostId.get(row.channel_post_id) ?? [];
      current.push({
        publishedAt,
        capturedAt,
        snapshotId: row.snapshot_id,
        views: Math.max(0, this.toSafeInteger(row.views)),
        reactionsTotal: Math.max(0, this.toSafeInteger(row.reactions_total)),
      });
      rowsByPostId.set(row.channel_post_id, current);
    }

    const last24hFrom = new Date(now.getTime() - TWENTY_FOUR_HOURS_MS);
    const last48hFrom = new Date(now.getTime() - 2 * TWENTY_FOUR_HOURS_MS);
    let totalLast24h = 0;
    let totalLast48h = 0;
    let last24hPostCount = 0;
    let last48hPostCount = 0;
    let reactions24h = 0;

    for (const postId of postIds) {
      const post = postsById.get(postId) ?? null;
      const postRows = rowsByPostId.get(postId) ?? [];
      const sorted = postRows.sort(
        (left, right) =>
          left.capturedAt.getTime() - right.capturedAt.getTime() ||
          left.snapshotId.localeCompare(right.snapshotId),
      );
      let previousViews: number | null = null;
      let previousReactions: number | null = null;
      const publishedAt = post?.publishedAt ?? sorted[0]?.publishedAt ?? null;
      if (!publishedAt) {
        continue;
      }

      const isLast48hPost = publishedAt >= last48hFrom;
      const isLast24hPost = publishedAt >= last24hFrom;
      let latestViews = Math.max(0, this.toSafeInteger(post?.latestViews ?? 0));
      let latestReactionsTotal = Math.max(0, this.toSafeInteger(post?.latestReactionsTotal ?? 0));
      let postReactions24h = 0;

      for (const row of sorted) {
        const seededFromPublication = previousViews === null && row.publishedAt >= last48hFrom;
        const reactionsDelta =
          previousReactions === null
            ? seededFromPublication
              ? row.reactionsTotal
              : 0
            : Math.max(0, row.reactionsTotal - previousReactions);

        if (row.capturedAt >= last24hFrom) {
          postReactions24h += reactionsDelta;
        }

        latestViews = Math.max(latestViews, row.views);
        latestReactionsTotal = Math.max(latestReactionsTotal, row.reactionsTotal);
        previousViews = row.views;
        previousReactions = row.reactionsTotal;
      }

      if (isLast48hPost) {
        totalLast48h += latestViews;
        last48hPostCount += 1;
      }
      if (isLast24hPost) {
        totalLast24h += latestViews;
        reactions24h += latestReactionsTotal || postReactions24h;
        last24hPostCount += 1;
      }
    }

    return {
      last24h: last24hPostCount > 0 ? Math.round(totalLast24h / last24hPostCount) : null,
      last48h: last48hPostCount > 0 ? Math.round(totalLast48h / last48hPostCount) : null,
      totalLast24h,
      totalLast48h,
      reactions24h,
    };
  }

  resolveLastAudienceCountAt(
    snapshots: Array<{ capturedAt: Date; participantsCount: number | null }>,
    at: Date,
  ): number | null {
    let value: number | null = null;
    for (const snapshot of snapshots) {
      if (snapshot.capturedAt.getTime() > at.getTime()) {
        break;
      }

      if (typeof snapshot.participantsCount === 'number') {
        value = snapshot.participantsCount;
      }
    }

    return value;
  }

  floorChannelStatsDay(date: Date): Date {
    const result = new Date(date);
    result.setUTCHours(0, 0, 0, 0);
    return result;
  }

  floorChannelStatsMoscowDay(date: Date): Date {
    const moscowDate = new Date(date.getTime() + 3 * ONE_HOUR_MS);
    moscowDate.setUTCHours(0, 0, 0, 0);
    return new Date(moscowDate.getTime() - 3 * ONE_HOUR_MS);
  }

  formatChannelStatsMoscowDate(date: Date): string {
    return new Date(date.getTime() + 3 * ONE_HOUR_MS).toISOString().slice(0, 10);
  }

  toDateOrNull(value: Date | string | null): Date | null {
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value : null;
    }

    if (typeof value === 'string') {
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed : null;
    }

    return null;
  }

  filterChannelStatsMembershipRowsFrom(
    rows: ChannelStatsMembershipBucketRow[],
    from: Date,
  ): ChannelStatsMembershipBucketRow[] {
    return rows.filter((row) => {
      const bucketStart =
        row.bucket_start instanceof Date ? row.bucket_start : new Date(row.bucket_start);
      return Number.isFinite(bucketStart.getTime()) && bucketStart.getTime() >= from.getTime();
    });
  }

  buildContentSeriesFromBucketRows(
    bucketStarts: Date[],
    rows: ChannelStatsContentBucketRow[],
  ): ChannelStatsContentBucketPoint[] {
    const grouped = new Map<string, Omit<ChannelStatsContentBucketPoint, 'at'>>();

    for (const row of rows) {
      const bucketStart = this.toIsoString(row.bucket_start);
      if (!bucketStart) {
        continue;
      }
      const key = new Date(bucketStart).toISOString();
      const current = grouped.get(key) ?? {
        posts: 0,
        viewsDelta: 0,
        reactions: 0,
      };
      current.posts += this.toSafeInteger(row.posts);
      current.viewsDelta += this.toSafeInteger(row.views_delta);
      current.reactions += this.toSafeInteger(row.reactions);
      grouped.set(key, current);
    }

    return bucketStarts.map((bucketStart) => {
      const current = grouped.get(bucketStart.toISOString()) ?? {
        posts: 0,
        viewsDelta: 0,
        reactions: 0,
      };
      return {
        at: bucketStart.toISOString(),
        posts: current.posts,
        viewsDelta: current.viewsDelta,
        reactions: current.reactions,
      };
    });
  }

  buildContentTotals(contentSeries: ChannelStatsContentBucketPoint[]) {
    return contentSeries.reduce(
      (totals, item) => ({
        posts: totals.posts + item.posts,
        viewsDelta: totals.viewsDelta + item.viewsDelta,
        reactions: totals.reactions + item.reactions,
      }),
      {
        posts: 0,
        viewsDelta: 0,
        reactions: 0,
      },
    );
  }

  sumChannelPostMetricViews(postViewMetrics: ChannelStatsPostViewMetric[]): number {
    return postViewMetrics.reduce(
      (total, metric) => total + Math.max(0, this.toSafeInteger(metric.post.latestViews)),
      0,
    );
  }

  buildAverageViewsSeriesFromContentSeries(
    contentSeries: ChannelStatsContentBucketPoint[],
  ): ChannelStatsViewsBucketPoint[] {
    return contentSeries.map((item) => ({
      at: item.at,
      posts: item.posts,
      views: item.posts > 0 ? Math.round(item.viewsDelta / item.posts) : 0,
    }));
  }

  buildAverageViewsSeriesFromPostMetrics(
    bucketStarts: Date[],
    postViewMetrics: ChannelStatsPostViewMetric[],
    bucket: ChannelStatsBucket,
  ): ChannelStatsViewsBucketPoint[] {
    const grouped = new Map<string, { posts: number; views: number }>();

    for (const metric of postViewMetrics) {
      const bucketStart = this.floorChannelStatsBucket(metric.post.publishedAt, bucket);
      const key = bucketStart.toISOString();
      const current = grouped.get(key) ?? { posts: 0, views: 0 };
      current.posts += 1;
      current.views += Math.max(0, this.toSafeInteger(metric.post.latestViews));
      grouped.set(key, current);
    }

    return bucketStarts.map((bucketStart) => {
      const current = grouped.get(bucketStart.toISOString()) ?? { posts: 0, views: 0 };
      return {
        at: bucketStart.toISOString(),
        posts: current.posts,
        views: current.posts > 0 ? Math.round(current.views / current.posts) : 0,
      };
    });
  }

  buildTopPosts(postViewMetrics: ChannelStatsPostViewMetric[]) {
    return postViewMetrics
      .sort(
        (left, right) =>
          this.toSafeInteger(right.post.latestViews) - this.toSafeInteger(left.post.latestViews) ||
          left.post.publishedAt.getTime() - right.post.publishedAt.getTime(),
      )
      .slice(0, 5)
      .map((metric) => ({
        messageId: metric.post.messageId,
        publishedAt: metric.post.publishedAt.toISOString(),
        url: metric.post.url,
        previewUrl: metric.post.previewUrl,
        viewsDelta: this.toSafeInteger(metric.post.latestViews),
      }));
  }

  async hydrateTopPostPreviews(
    chatId: string,
    topPosts: ChannelStatsResponse['official']['content']['topPosts'],
  ): Promise<ChannelStatsResponse['official']['content']['topPosts']> {
    const missingPreviewPosts = topPosts.filter((post) => !this.readTrimmedString(post.previewUrl));
    if (missingPreviewPosts.length === 0) {
      return topPosts;
    }

    const botId = await this.resolveAssistBotAssignment(chatId, 'channel_stats');
    const previewByMessageId = new Map<string, string>();
    await mapWithConcurrencyLimit(missingPreviewPosts, 2, async (post) => {
      try {
        const snapshot = await this.maxClient.getMessageSnapshot(chatId, post.messageId, {
          trafficClass: 'background',
          actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
          sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC,
          ...(botId ? { botId } : {}),
        });
        const previewUrl = this.readTrimmedString(snapshot?.previewUrl);
        if (previewUrl) {
          previewByMessageId.set(post.messageId, previewUrl);
        }
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            messageId: post.messageId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to hydrate channel stats top post preview',
        );
      }
    });

    if (previewByMessageId.size === 0) {
      return topPosts;
    }

    await Promise.all(
      Array.from(previewByMessageId.entries()).map(([messageId, previewUrl]) =>
        this.prisma.channelPost.updateMany({
          where: {
            chatId,
            messageId,
            previewUrl: null,
          },
          data: {
            previewUrl,
          },
        }),
      ),
    );
    this.invalidateChannelStatsResponseCache(chatId);

    return topPosts.map((post) => ({
      ...post,
      previewUrl: post.previewUrl ?? previewByMessageId.get(post.messageId) ?? null,
    }));
  }

  buildTopReactions(
    posts: Array<{
      latestReactions: Prisma.JsonValue | null;
    }>,
  ) {
    const grouped = new Map<string, number>();

    for (const post of posts) {
      for (const reaction of this.readChannelPostReactions(post.latestReactions)) {
        grouped.set(reaction.emoji, (grouped.get(reaction.emoji) ?? 0) + reaction.count);
      }
    }

    return Array.from(grouped.entries())
      .map(([emoji, count]) => ({ emoji, count }))
      .sort((left, right) => right.count - left.count || left.emoji.localeCompare(right.emoji))
      .slice(0, 3);
  }

  readChannelPostReactions(
    value: Prisma.JsonValue | null,
  ): Array<{ emoji: string; count: number }> {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => this.readChannelPostReaction(item))
      .filter((item): item is { emoji: string; count: number } => item !== null);
  }

  readChannelPostReaction(
    value: Prisma.JsonValue,
  ): { emoji: string; count: number } | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const emoji = typeof row.emoji === 'string' ? row.emoji.trim() : '';
    const count = this.toSafeInteger(row.count);
    if (!emoji || count <= 0) {
      return null;
    }

    return {
      emoji,
      count,
    };
  }

  resolveOfficialCoverageFrom(
    syncState: {
      viewsCoverageFrom: Date | null;
      membershipCoverageFrom: Date | null;
    } | null,
    latestAudienceCapturedAt: Date | null,
  ): string | null {
    const candidates = [
      syncState?.viewsCoverageFrom ?? null,
      syncState?.membershipCoverageFrom ?? null,
      latestAudienceCapturedAt,
    ].filter((value): value is Date => value instanceof Date && Number.isFinite(value.getTime()));

    if (candidates.length === 0) {
      return null;
    }

    const earliest = candidates.reduce((acc, item) =>
      item.getTime() < acc.getTime() ? item : acc,
    );
    return earliest.toISOString();
  }

}
