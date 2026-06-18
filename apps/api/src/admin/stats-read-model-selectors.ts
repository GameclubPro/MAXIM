import type { ModerationFeedFilter } from '@maxim/contracts';
import type { ChannelStatsBucket } from '@maxim/contracts/channel-stats';
import { Prisma, type SanctionAction } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';

export type ModerationFeedReadModelRow = {
  id: string;
  action: SanctionAction;
  ruleCode: string;
  userId: string;
  createdAt: Date;
  maskedExcerpt: string | null;
  metadata: Prisma.JsonValue | null;
  userDisplayName?: string | null;
  avatarUrl?: string | null;
  profileUrl?: string | null;
  profileHandoffUrl?: string | null;
};

export type ChannelStatsMembershipBucketRow = {
  bucket_start: Date | string;
  joined_users: unknown;
  left_users: unknown;
};

export type ChannelStatsContentBucketRow = {
  bucket_start: Date | string;
  posts: unknown;
  views_delta: unknown;
  reactions: unknown;
};

type SelectModerationFeedRowsParams = {
  chatId: string;
  from: Date;
  to: Date;
  filter: ModerationFeedFilter;
  cursor: {
    createdAt: Date;
    id: string;
  } | null;
  limit: number;
};

type SelectChannelStatsMembershipBucketRowsParams = {
  chatId: string;
  from: Date;
  to: Date;
  bucket: ChannelStatsBucket;
};

type CompleteHourlyRollupWindow = {
  completeFrom: Date;
  completeTo: Date;
  hasCompleteBuckets: boolean;
};

const ONE_HOUR_MS = 60 * 60 * 1000;

export async function selectModerationFeedReadModelRows(
  prisma: PrismaService,
  params: SelectModerationFeedRowsParams,
): Promise<ModerationFeedReadModelRow[]> {
  const filterSql = buildModerationFeedFilterSql(params.filter);
  const cursorSql = params.cursor
    ? Prisma.sql`
        AND (
          feed.created_at < ${params.cursor.createdAt}
          OR (feed.created_at = ${params.cursor.createdAt} AND feed.id < ${params.cursor.id})
        )
      `
    : Prisma.empty;

  return prisma.$queryRaw<ModerationFeedReadModelRow[]>`
    SELECT
      feed.id,
      feed.action,
      feed.rule_code AS "ruleCode",
      feed.user_id AS "userId",
      feed.created_at AS "createdAt",
      feed.masked_excerpt AS "maskedExcerpt",
      feed.metadata,
      COALESCE(feed.user_display_name, membership_profile.sender_name) AS "userDisplayName",
      NULL::TEXT AS "avatarUrl",
      NULL::TEXT AS "profileUrl",
      NULL::TEXT AS "profileHandoffUrl"
    FROM chat_moderation_feed_items feed
    LEFT JOIN LATERAL (
      SELECT membership.sender_name
      FROM chat_membership_activity_feed_items membership
      WHERE membership.chat_id = feed.chat_id
        AND membership.user_id = feed.user_id
        AND COALESCE(BTRIM(membership.sender_name), '') <> ''
      ORDER BY membership.event_at DESC, membership.source_event_id DESC
      LIMIT 1
    ) membership_profile ON TRUE
    WHERE feed.chat_id = ${params.chatId}
      AND feed.created_at >= ${params.from}
      AND feed.created_at <= ${params.to}
      ${filterSql}
      ${cursorSql}
    ORDER BY feed.created_at DESC, feed.id DESC
    LIMIT ${params.limit}
  `;
}

export async function selectChannelStatsMembershipBucketRows(
  prisma: PrismaService,
  params: SelectChannelStatsMembershipBucketRowsParams,
): Promise<ChannelStatsMembershipBucketRow[]> {
  const bucketSql = buildChannelStatsBucketSql(params.bucket);
  const { completeFrom, completeTo, hasCompleteBuckets } = resolveCompleteHourlyRollupWindow(
    params.from,
    params.to,
  );
  const rollupRowsSql = hasCompleteBuckets
    ? Prisma.sql`
        SELECT
          date_trunc(${bucketSql}, bucket_start)::TIMESTAMP(3) AS bucket_start,
          COALESCE(SUM(joined_users), 0) AS joined_users,
          COALESCE(SUM(left_users), 0) AS left_users
        FROM channel_stats_bucket_rollups
        WHERE chat_id = ${params.chatId}
          AND bucket_start >= ${completeFrom}
          AND bucket_start < ${completeTo}
        GROUP BY date_trunc(${bucketSql}, bucket_start)::TIMESTAMP(3)
      `
    : Prisma.sql`
        SELECT
          NULL::TIMESTAMP(3) AS bucket_start,
          0::BIGINT AS joined_users,
          0::BIGINT AS left_users
        WHERE FALSE
      `;
  const edgeExclusionSql = hasCompleteBuckets
    ? Prisma.sql`AND NOT (event_at >= ${completeFrom} AND event_at < ${completeTo})`
    : Prisma.empty;

  return prisma.$queryRaw<ChannelStatsMembershipBucketRow[]>`
    WITH membership_bucket_rows AS (
      ${rollupRowsSql}

      UNION ALL

      SELECT
        date_trunc(${bucketSql}, event_at)::TIMESTAMP(3) AS bucket_start,
        COUNT(*) FILTER (WHERE event_type = 'user_added') AS joined_users,
        COUNT(*) FILTER (WHERE event_type = 'user_removed') AS left_users
      FROM chat_membership_activity_feed_items
      WHERE chat_id = ${params.chatId}
        AND event_type IN ('user_added', 'user_removed')
        AND event_at >= ${params.from}
        AND event_at <= ${params.to}
        ${edgeExclusionSql}
      GROUP BY date_trunc(${bucketSql}, event_at)::TIMESTAMP(3)
    )
    SELECT
      bucket_start,
      COALESCE(SUM(joined_users), 0) AS joined_users,
      COALESCE(SUM(left_users), 0) AS left_users
    FROM membership_bucket_rows
    GROUP BY bucket_start
    ORDER BY bucket_start ASC
  `;
}

export async function selectChannelStatsContentBucketRows(
  prisma: PrismaService,
  params: SelectChannelStatsMembershipBucketRowsParams,
): Promise<ChannelStatsContentBucketRow[]> {
  const bucketSql = buildChannelStatsBucketSql(params.bucket);
  const { completeFrom, completeTo, hasCompleteBuckets } = resolveCompleteHourlyRollupWindow(
    params.from,
    params.to,
  );
  const rollupRowsSql = hasCompleteBuckets
    ? Prisma.sql`
        SELECT
          date_trunc(${bucketSql}, bucket_start)::TIMESTAMP(3) AS bucket_start,
          COALESCE(SUM(posts), 0) AS posts,
          COALESCE(SUM(views_delta), 0) AS views_delta,
          COALESCE(SUM(reactions), 0) AS reactions
        FROM channel_stats_bucket_rollups
        WHERE chat_id = ${params.chatId}
          AND bucket_start >= ${completeFrom}
          AND bucket_start < ${completeTo}
        GROUP BY date_trunc(${bucketSql}, bucket_start)::TIMESTAMP(3)
      `
    : Prisma.sql`
        SELECT
          NULL::TIMESTAMP(3) AS bucket_start,
          0::BIGINT AS posts,
          0::BIGINT AS views_delta,
          0::BIGINT AS reactions
        WHERE FALSE
      `;
  const postEdgeExclusionSql = hasCompleteBuckets
    ? Prisma.sql`AND NOT (published_at >= ${completeFrom} AND published_at < ${completeTo})`
    : Prisma.empty;
  const viewEdgeExclusionSql = hasCompleteBuckets
    ? Prisma.sql`AND NOT (snapshots.captured_at >= ${completeFrom} AND snapshots.captured_at < ${completeTo})`
    : Prisma.empty;
  const initialViewCorrectionWindowSql = hasCompleteBuckets
    ? Prisma.sql`AND snapshots.captured_at >= ${completeFrom} AND snapshots.captured_at < ${completeTo}`
    : Prisma.sql`AND FALSE`;

  return prisma.$queryRaw<ChannelStatsContentBucketRow[]>`
    WITH content_bucket_rows AS (
      ${rollupRowsSql}

      UNION ALL

      SELECT
        date_trunc(${bucketSql}, published_at)::TIMESTAMP(3) AS bucket_start,
        COUNT(*) AS posts,
        0::BIGINT AS views_delta,
        COALESCE(SUM(GREATEST(latest_reactions_total, 0)), 0) AS reactions
      FROM channel_posts
      WHERE chat_id = ${params.chatId}
        AND published_at >= ${params.from}
        AND published_at <= ${params.to}
        ${postEdgeExclusionSql}
      GROUP BY date_trunc(${bucketSql}, published_at)::TIMESTAMP(3)

      UNION ALL

      SELECT
        date_trunc(${bucketSql}, snapshots.captured_at)::TIMESTAMP(3) AS bucket_start,
        0::BIGINT AS posts,
        COALESCE(
          SUM(
            GREATEST(
              snapshots.views - COALESCE(
                previous_snapshot.views,
                CASE WHEN posts.published_at >= ${params.from} THEN 0 ELSE snapshots.views END
              ),
              0
            )
          ),
          0
        ) AS views_delta,
        0::BIGINT AS reactions
      FROM channel_post_view_snapshots snapshots
      JOIN channel_posts posts ON posts.id = snapshots.channel_post_id
      LEFT JOIN LATERAL (
        SELECT previous.views
        FROM channel_post_view_snapshots previous
        WHERE previous.channel_post_id = snapshots.channel_post_id
          AND (
            previous.captured_at < snapshots.captured_at
            OR (
              previous.captured_at = snapshots.captured_at
              AND previous.id < snapshots.id
            )
          )
        ORDER BY previous.captured_at DESC, previous.id DESC
        LIMIT 1
      ) previous_snapshot ON TRUE
      WHERE posts.chat_id = ${params.chatId}
        AND snapshots.captured_at >= ${params.from}
        AND snapshots.captured_at <= ${params.to}
        ${viewEdgeExclusionSql}
      GROUP BY date_trunc(${bucketSql}, snapshots.captured_at)::TIMESTAMP(3)

      UNION ALL

      -- First snapshots of period posts are period views, but the hourly rollup
      -- stores only deltas after the first snapshot.
      SELECT
        date_trunc(${bucketSql}, snapshots.captured_at)::TIMESTAMP(3) AS bucket_start,
        0::BIGINT AS posts,
        COALESCE(SUM(GREATEST(snapshots.views, 0)), 0) AS views_delta,
        0::BIGINT AS reactions
      FROM channel_posts posts
      JOIN LATERAL (
        SELECT first_snapshot.captured_at, first_snapshot.views
        FROM channel_post_view_snapshots first_snapshot
        WHERE first_snapshot.channel_post_id = posts.id
        ORDER BY first_snapshot.captured_at ASC, first_snapshot.id ASC
        LIMIT 1
      ) snapshots ON TRUE
      WHERE posts.chat_id = ${params.chatId}
        AND posts.published_at >= ${params.from}
        AND posts.published_at <= ${params.to}
        AND snapshots.captured_at >= ${params.from}
        AND snapshots.captured_at <= ${params.to}
        ${initialViewCorrectionWindowSql}
      GROUP BY date_trunc(${bucketSql}, snapshots.captured_at)::TIMESTAMP(3)
    )
    SELECT
      bucket_start,
      COALESCE(SUM(posts), 0) AS posts,
      COALESCE(SUM(views_delta), 0) AS views_delta,
      COALESCE(SUM(reactions), 0) AS reactions
    FROM content_bucket_rows
    GROUP BY bucket_start
    ORDER BY bucket_start ASC
  `;
}

function buildChannelStatsBucketSql(bucket: ChannelStatsBucket): Prisma.Sql {
  return bucket === 'hour' ? Prisma.sql`'hour'` : Prisma.sql`'day'`;
}

function buildModerationFeedFilterSql(filter: ModerationFeedFilter): Prisma.Sql {
  if (filter === 'ALL') {
    return Prisma.sql`
      AND (
        feed.action IN ('WARN', 'DELETE_MESSAGE', 'MUTE', 'KICK', 'BAN')
        OR (
          feed.action = 'NONE'
          AND feed.rule_code IN ('MANUAL_UNMUTE', 'MANUAL_UNBAN')
        )
      )
    `;
  }

  if (filter === 'UNMUTE') {
    return Prisma.sql`
      AND feed.action = 'NONE'
      AND feed.rule_code = 'MANUAL_UNMUTE'
    `;
  }

  if (filter === 'UNBAN') {
    return Prisma.sql`
      AND feed.action = 'NONE'
      AND feed.rule_code = 'MANUAL_UNBAN'
    `;
  }

  if (filter === 'BAN') {
    return Prisma.sql`AND feed.action IN ('BAN', 'KICK')`;
  }

  return Prisma.sql`AND feed.action = ${filter}::"SanctionAction"`;
}

function resolveCompleteHourlyRollupWindow(from: Date, to: Date): CompleteHourlyRollupWindow {
  const flooredFrom = floorDateToHour(from);
  const completeFrom =
    flooredFrom.getTime() === from.getTime()
      ? flooredFrom
      : new Date(flooredFrom.getTime() + ONE_HOUR_MS);
  const completeTo = floorDateToHour(to);

  return {
    completeFrom,
    completeTo,
    hasCompleteBuckets: completeFrom.getTime() < completeTo.getTime(),
  };
}

function floorDateToHour(date: Date): Date {
  const result = new Date(date);
  result.setUTCMinutes(0, 0, 0);
  return result;
}
