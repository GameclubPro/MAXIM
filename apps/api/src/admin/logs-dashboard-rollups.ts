import { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';

const ONE_HOUR_MS = 60 * 60 * 1000;

type MembershipEdgeRow = {
  event_type: string | null;
};

type MembershipEdgeRowsFetcher = (
  chatId: string,
  from: Date,
  to: Date,
  eventTypes: readonly string[],
) => Promise<readonly MembershipEdgeRow[]>;

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
  fetchEdgeRows: MembershipEdgeRowsFetcher,
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
  const [rollupRows, edgeRowsByRange] = await Promise.all([
    rollupRowsPromise,
    Promise.all(
      edgeRanges.map((range) =>
        fetchEdgeRows(chatId, range.from, range.to, ['user_added', 'user_removed']),
      ),
    ),
  ]);

  const rollupSource = rollupRows[0] ?? { joined_users: 0, left_users: 0 };
  const summary: LogsDashboardMembershipSummary = {
    joinedUsers: toSafeInteger(rollupSource.joined_users),
    leftUsers: toSafeInteger(rollupSource.left_users),
  };

  for (const row of edgeRowsByRange.flat()) {
    if (row.event_type === 'user_added') {
      summary.joinedUsers += 1;
    } else if (row.event_type === 'user_removed') {
      summary.leftUsers += 1;
    }
  }

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
    ? prisma.$queryRaw<Array<LogsDashboardModerationSummary & { affected_user_ids: unknown }>>`
        WITH rollups AS (
          SELECT
            warn,
            delete_message,
            mute,
            ban,
            unmute,
            unban,
            affected_user_ids
          FROM chat_moderation_stats_rollups
          WHERE chat_id = ${chatId}
            AND bucket_start >= ${completeFrom}
            AND bucket_start < ${completeTo}
        ),
        counts AS (
          SELECT
            COALESCE(SUM(warn), 0) AS "warn",
            COALESCE(SUM(delete_message), 0) AS "deleteMessage",
            COALESCE(SUM(mute), 0) AS "mute",
            COALESCE(SUM(ban), 0) AS "ban",
            COALESCE(SUM(unmute), 0) AS "unmute",
            COALESCE(SUM(unban), 0) AS "unban"
          FROM rollups
        ),
        affected AS (
          SELECT COALESCE(
            ARRAY_AGG(DISTINCT affected_user_id) FILTER (
              WHERE COALESCE(BTRIM(affected_user_id), '') <> ''
            ),
            ARRAY[]::TEXT[]
          ) AS affected_user_ids
          FROM rollups, unnest(affected_user_ids) AS affected_user_id
        )
        SELECT
          counts."warn",
          counts."deleteMessage",
          counts."mute",
          counts."ban",
          counts."unmute",
          counts."unban",
          affected.affected_user_ids
        FROM counts, affected
      `
    : Promise.resolve([
        {
          warn: 0,
          deleteMessage: 0,
          mute: 0,
          ban: 0,
          unmute: 0,
          unban: 0,
          affected_user_ids: [],
        },
      ]);
  const edgeExclusion = hasCompleteBuckets
    ? Prisma.sql`AND NOT (created_at >= ${completeFrom} AND created_at < ${completeTo})`
    : Prisma.empty;
  const edgeRowsPromise = prisma.$queryRaw<
    Array<LogsDashboardModerationSummary & { affected_user_ids: unknown }>
  >`
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
      COALESCE(
        ARRAY_AGG(DISTINCT user_id) FILTER (
          WHERE COALESCE(BTRIM(user_id), '') <> ''
            AND (
              action IN ('WARN', 'DELETE_MESSAGE', 'MUTE', 'BAN', 'KICK')
              OR (
                action = 'NONE'
                AND rule_code IN ('MANUAL_UNMUTE', 'MANUAL_UNBAN')
              )
            )
        ),
        ARRAY[]::TEXT[]
      ) AS affected_user_ids
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
  const [rollupRows, edgeRows] = await Promise.all([rollupRowsPromise, edgeRowsPromise]);
  const rollupSource = rollupRows[0] ?? emptyModerationSummarySource();
  const edgeSource = edgeRows[0] ?? emptyModerationSummarySource();
  const affectedUserIds = new Set<string>();
  for (const source of [rollupSource.affected_user_ids, edgeSource.affected_user_ids]) {
    if (!Array.isArray(source)) {
      continue;
    }
    for (const userId of source) {
      if (typeof userId === 'string' && userId.trim()) {
        affectedUserIds.add(userId.trim());
      }
    }
  }

  return {
    warn: toSafeInteger(rollupSource.warn) + toSafeInteger(edgeSource.warn),
    deleteMessage:
      toSafeInteger(rollupSource.deleteMessage) + toSafeInteger(edgeSource.deleteMessage),
    mute: toSafeInteger(rollupSource.mute) + toSafeInteger(edgeSource.mute),
    ban: toSafeInteger(rollupSource.ban) + toSafeInteger(edgeSource.ban),
    unmute: toSafeInteger(rollupSource.unmute) + toSafeInteger(edgeSource.unmute),
    unban: toSafeInteger(rollupSource.unban) + toSafeInteger(edgeSource.unban),
    affectedUsers: affectedUserIds.size,
  };
}

function floorDateToHour(date: Date): Date {
  const result = new Date(date);
  result.setUTCMinutes(0, 0, 0);
  return result;
}

function ceilDateToHour(date: Date): Date {
  const floored = floorDateToHour(date);
  return floored.getTime() === date.getTime()
    ? floored
    : new Date(floored.getTime() + ONE_HOUR_MS);
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

function emptyModerationSummarySource(): LogsDashboardModerationSummary & {
  affected_user_ids: unknown;
} {
  return {
    warn: 0,
    deleteMessage: 0,
    mute: 0,
    ban: 0,
    unmute: 0,
    unban: 0,
    affectedUsers: 0,
    affected_user_ids: [],
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
