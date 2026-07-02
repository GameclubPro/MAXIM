import { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';

const ONE_HOUR_MS = 60 * 60 * 1000;

type RollupWindow = {
  completeFrom: Date;
  completeTo: Date;
  hasCompleteBuckets: boolean;
};

export type LogsDashboardMembershipSummary = {
  joinedUsers: number;
  leftUsers: number;
};

export type LogsDashboardModerationSummary = {
  warn: number;
  deleteMessage: number;
  mute: number;
  ban: number;
  unmute: number;
  unban: number;
  affectedUsers: number;
};

export async function selectLogsDashboardMembershipSummary(
  prisma: PrismaService,
  chatId: string,
  from: Date,
  to: Date,
): Promise<LogsDashboardMembershipSummary> {
  const { completeFrom, completeTo, hasCompleteBuckets } = resolveCompleteRollupWindow(from, to);
  const rollupRowsPromise = hasCompleteBuckets
    ? prisma.$queryRaw<Array<{ joined_users: unknown; left_users: unknown }>>`
        SELECT
          COALESCE(SUM(joined_users), 0) AS joined_users,
          COALESCE(SUM(left_users), 0) AS left_users
        FROM chat_membership_activity_rollups
        WHERE chat_id = ${chatId}
          AND bucket_start >= ${completeFrom}
          AND bucket_start < ${completeTo}
      `
    : Promise.resolve([{ joined_users: 0, left_users: 0 }]);
  const edgeRanges = resolveDashboardEdgeRanges(
    from,
    to,
    completeFrom,
    completeTo,
    hasCompleteBuckets,
  );
  const edgeRowsPromise = prisma.$queryRaw<Array<{ joined_users: unknown; left_users: unknown }>>`
    WITH membership_edge_rows AS (
      ${buildMembershipEdgeSummarySql(chatId, edgeRanges)}
    )
    SELECT
      COALESCE(SUM(joined_users), 0) AS joined_users,
      COALESCE(SUM(left_users), 0) AS left_users
    FROM membership_edge_rows
  `;
  const [rollupRows, edgeRows] = await Promise.all([
    rollupRowsPromise,
    edgeRowsPromise,
  ]);

  const rollupSource = rollupRows[0] ?? { joined_users: 0, left_users: 0 };
  const edgeSource = edgeRows[0] ?? { joined_users: 0, left_users: 0 };
  const summary: LogsDashboardMembershipSummary = {
    joinedUsers: toSafeInteger(rollupSource.joined_users) + toSafeInteger(edgeSource.joined_users),
    leftUsers: toSafeInteger(rollupSource.left_users) + toSafeInteger(edgeSource.left_users),
  };

  return summary;
}

export async function selectLogsDashboardModerationSummary(
  prisma: PrismaService,
  chatId: string,
  from: Date,
  to: Date,
): Promise<LogsDashboardModerationSummary> {
  const { completeFrom, completeTo, hasCompleteBuckets } = resolveCompleteRollupWindow(from, to);
  const rollupRowsPromise = hasCompleteBuckets
    ? prisma.$queryRaw<Array<LogsDashboardModerationSummary>>`
        SELECT
          COALESCE(SUM(warn), 0) AS "warn",
          COALESCE(SUM(delete_message), 0) AS "deleteMessage",
          COALESCE(SUM(mute), 0) AS "mute",
          COALESCE(SUM(ban), 0) AS "ban",
          COALESCE(SUM(unmute), 0) AS "unmute",
          COALESCE(SUM(unban), 0) AS "unban",
          0 AS "affectedUsers"
        FROM chat_moderation_stats_rollups
        WHERE chat_id = ${chatId}
          AND bucket_start >= ${completeFrom}
          AND bucket_start < ${completeTo}
      `
    : Promise.resolve([
        {
          warn: 0,
          deleteMessage: 0,
          mute: 0,
          ban: 0,
          unmute: 0,
          unban: 0,
          affectedUsers: 0,
        },
      ]);
  const edgeExclusion = hasCompleteBuckets
    ? Prisma.sql`AND NOT (created_at >= ${completeFrom} AND created_at < ${completeTo})`
    : Prisma.empty;
  const edgeRowsPromise = prisma.$queryRaw<Array<LogsDashboardModerationSummary>>`
    SELECT
      COUNT(*) FILTER (WHERE action = 'WARN') AS "warn",
      COUNT(*) FILTER (WHERE action = 'DELETE_MESSAGE') AS "deleteMessage",
      COUNT(*) FILTER (WHERE action = 'MUTE') AS "mute",
      COUNT(*) FILTER (WHERE action IN ('BAN', 'KICK')) AS "ban",
      COUNT(*) FILTER (
        WHERE action = 'NONE' AND rule_code = 'MANUAL_UNMUTE'
      ) AS "unmute",
      COUNT(*) FILTER (
        WHERE action = 'NONE' AND rule_code = 'MANUAL_UNBAN'
      ) AS "unban",
      0 AS "affectedUsers"
    FROM moderation_events
    WHERE chat_id = ${chatId}
      AND created_at >= ${from}
      AND created_at <= ${to}
      ${edgeExclusion}
      AND (
        action IN ('WARN', 'DELETE_MESSAGE', 'MUTE', 'BAN', 'KICK')
        OR (
          action = 'NONE'
          AND rule_code IN ('MANUAL_UNMUTE', 'MANUAL_UNBAN')
        )
      )
  `;
  const rollupAffectedUsersSql = hasCompleteBuckets
    ? Prisma.sql`
        SELECT user_id
        FROM chat_moderation_affected_user_hours
        WHERE chat_id = ${chatId}
          AND bucket_start >= ${completeFrom}
          AND bucket_start < ${completeTo}
      `
    : Prisma.sql`SELECT NULL::TEXT AS user_id WHERE FALSE`;
  const affectedRowsPromise = prisma.$queryRaw<Array<{ affected_users: unknown }>>`
    WITH affected_user_ids AS (
      ${rollupAffectedUsersSql}

      UNION

      SELECT DISTINCT user_id
      FROM moderation_events
      WHERE chat_id = ${chatId}
        AND created_at >= ${from}
        AND created_at <= ${to}
        ${edgeExclusion}
        AND COALESCE(BTRIM(user_id), '') <> ''
        AND (
          action IN ('WARN', 'DELETE_MESSAGE', 'MUTE', 'BAN', 'KICK')
          OR (
            action = 'NONE'
            AND rule_code IN ('MANUAL_UNMUTE', 'MANUAL_UNBAN')
          )
        )
    )
    SELECT COUNT(DISTINCT user_id) AS affected_users
    FROM affected_user_ids
  `;
  const [rollupRows, edgeRows, affectedRows] = await Promise.all([
    rollupRowsPromise,
    edgeRowsPromise,
    affectedRowsPromise,
  ]);
  const rollupSource = rollupRows[0] ?? emptyModerationSummarySource();
  const edgeSource = edgeRows[0] ?? emptyModerationSummarySource();
  const affectedSource = affectedRows[0] ?? { affected_users: 0 };

  return {
    warn: toSafeInteger(rollupSource.warn) + toSafeInteger(edgeSource.warn),
    deleteMessage:
      toSafeInteger(rollupSource.deleteMessage) + toSafeInteger(edgeSource.deleteMessage),
    mute: toSafeInteger(rollupSource.mute) + toSafeInteger(edgeSource.mute),
    ban: toSafeInteger(rollupSource.ban) + toSafeInteger(edgeSource.ban),
    unmute: toSafeInteger(rollupSource.unmute) + toSafeInteger(edgeSource.unmute),
    unban: toSafeInteger(rollupSource.unban) + toSafeInteger(edgeSource.unban),
    affectedUsers: toSafeInteger(affectedSource.affected_users),
  };
}

function floorDateToHour(date: Date): Date {
  const result = new Date(date);
  result.setUTCMinutes(0, 0, 0);
  return result;
}

function ceilDateToHour(date: Date): Date {
  const floored = floorDateToHour(date);
  return floored.getTime() === date.getTime() ? floored : new Date(floored.getTime() + ONE_HOUR_MS);
}

function resolveCompleteRollupWindow(from: Date, to: Date): RollupWindow {
  const completeFrom = ceilDateToHour(from);
  const completeTo = floorDateToHour(to);
  return {
    completeFrom,
    completeTo,
    hasCompleteBuckets: completeFrom.getTime() < completeTo.getTime(),
  };
}

function resolveDashboardEdgeRanges(
  from: Date,
  to: Date,
  completeFrom: Date,
  completeTo: Date,
  hasCompleteBuckets: boolean,
): Array<{ from: Date; to: Date }> {
  if (!hasCompleteBuckets) {
    return from.getTime() <= to.getTime() ? [{ from, to }] : [];
  }

  const firstEdgeTo = new Date(completeFrom.getTime() - 1);
  return [
    { from, to: firstEdgeTo },
    { from: completeTo, to },
  ].filter((range) => range.from.getTime() <= range.to.getTime());
}

function buildMembershipEdgeSummarySql(
  chatId: string,
  edgeRanges: Array<{ from: Date; to: Date }>,
): Prisma.Sql {
  if (edgeRanges.length === 0) {
    return Prisma.sql`
      SELECT
        0::BIGINT AS joined_users,
        0::BIGINT AS left_users
      WHERE FALSE
    `;
  }

  return Prisma.join(
    edgeRanges.map(
      (range) => Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE event_type = 'user_added') AS joined_users,
          COUNT(*) FILTER (WHERE event_type = 'user_removed') AS left_users
        FROM chat_membership_activity_feed_items
        WHERE chat_id = ${chatId}
          AND event_type IN ('user_added', 'user_removed')
          AND event_at >= ${range.from}
          AND event_at <= ${range.to}
      `,
    ),
    ' UNION ALL ',
  );
}

function emptyModerationSummarySource(): LogsDashboardModerationSummary {
  return {
    warn: 0,
    deleteMessage: 0,
    mute: 0,
    ban: 0,
    unmute: 0,
    unban: 0,
    affectedUsers: 0,
  };
}

function toSafeInteger(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }

  if (typeof value === 'bigint') {
    return value > 0n ? Number(value) : 0;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : Math.max(0, parsed);
  }

  return 0;
}
