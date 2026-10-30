import { Injectable } from '@nestjs/common';
import type {
  StatsCoverage,
  StatsEntity,
  StatsHealth,
  StatsMetricKey,
  StatsReachValue,
} from '@maxim/contracts/statistics-central';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type { StatsCandidate } from './stats-types';
import { compareTimes } from './stats-common';
import { unionStatsCoverage } from './stats-coverage';

const DAY_MS = 86_400_000;
const iso = (value: Date | null) => value?.toISOString() ?? null;
const day = (value: Date) => value.toISOString().slice(0, 10);
const count = (value: bigint) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > 2_147_483_647) return null;
  return result;
};
const validViews = (value: string | null) =>
  value === null ||
  (/^(0|[1-9][0-9]*)$/u.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n);
// FLAG: Numeric-limit placeholders stay internal; the selector emits UNKNOWN/UNAVAILABLE.
const limited = (candidate: StatsCandidate, invalid: boolean): StatsCandidate =>
  invalid
    ? {
        ...candidate,
        unavailableReason: 'NUMERIC_LIMIT',
        coverage: { state: 'UNKNOWN', intervals: [], populationComplete: false },
      }
    : candidate;
const health = (success: Date | null, attempt: Date | null = null): StatsHealth => ({
  state: success ? 'OK' : 'UNKNOWN',
  lastAttemptAt: iso(attempt),
  lastSuccessAt: iso(success),
  nextExpectedAt: null,
  errorCode: null,
});
type PostAggregate = {
  bucket: Date;
  horizon: number;
  posts: bigint;
  samples: bigint;
  views: string | null;
  observed_from: Date | null;
  observed_to: Date | null;
  attempted_at: Date | null;
  delay: number | null;
  missed: bigint;
};
type Proof = { from_at: Date; to_at: Date; from_exact?: string; to_exact?: string };

/** Reads native observations only; the caller authorizes every returned source candidate. */
@Injectable()
export class MaximNativeStatsAdapter {
  constructor(private readonly prisma: PrismaService) {}

  async read(
    entity: StatsEntity,
    scopes: StatsMetricKey[],
    fromDay: string,
    toDay: string,
  ): Promise<StatsCandidate[]> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
        await tx.$executeRaw`SET LOCAL statement_timeout='2500ms'`;
        // FLAG: Acquire the MVCC snapshot before choosing the cutoff for latest-only facts.
        const [clock] = await tx.$queryRaw<
          Array<{ as_of: Date }>
        >`SELECT clock_timestamp() AS as_of`;
        const retentionFloor = new Date(
          Date.UTC(
            clock.as_of.getUTCFullYear(),
            clock.as_of.getUTCMonth(),
            clock.as_of.getUTCDate(),
          ) -
            89 * DAY_MS,
        )
          .toISOString()
          .slice(0, 10);
        return this.readInSnapshot(tx, entity, scopes, fromDay, toDay, {
          asOf: clock.as_of,
          retentionFloor,
        });
      },
      { isolationLevel: 'RepeatableRead', timeout: 15_000 },
    );
  }

  async readInSnapshot(
    tx: Prisma.TransactionClient,
    entity: StatsEntity,
    scopes: StatsMetricKey[],
    fromDay: string,
    toDay: string,
    snapshot: { asOf: Date; retentionFloor: string },
  ): Promise<StatsCandidate[]> {
    const from = new Date(`${fromDay}T00:00:00.000Z`);
    const end = new Date(`${toDay}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(fromDay) ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(toDay) ||
      !Number.isFinite(from.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      day(from) !== fromDay ||
      day(end) !== toDay ||
      end < from ||
      end.getTime() - from.getTime() >= 90 * DAY_MS
    )
      throw new RangeError('Native statistics require at most 90 inclusive UTC days');
    const now = snapshot.asOf;
    const requested = (metric: string, method: string) =>
      scopes.some((scope) => scope.metric === metric && scope.method.id === method);
    from.setTime(Math.max(from.getTime(), Date.parse(`${snapshot.retentionFloor}T00:00:00.000Z`)));
    const to = new Date(Math.min(end.getTime() + DAY_MS, now.getTime()));
    if (to <= from) return [];
    const rows: StatsCandidate[] = [];
    if (requested('AUDIENCE', 'AUDIENCE_SNAPSHOT'))
      rows.push(...(await this.audience(tx, entity, from, to)));
    if (requested('MEMBERSHIP', 'OBSERVED_MEMBER_EVENTS'))
      rows.push(...(await this.membership(tx, entity, from, to)));
    if (entity.kind !== 'CHANNEL') return rows;
    const horizons = [
      ...new Set(
        scopes.flatMap((scope) =>
          scope.metric === 'REACH' &&
          (scope.method.id === 'POST_PUBLICATION_DAY' ||
            scope.method.id === 'TIMED_POST_PUBLICATION_DAY')
            ? [scope.horizon]
            : [],
        ),
      ),
    ];
    const publication = requested('PUBLICATION_HOUR', 'PUBLICATION_DAY_HOURS');
    const proofs =
      horizons.length || publication ? await this.proofs(tx, entity, from, to, now) : [];
    if (horizons.length)
      rows.push(...(await this.reach(tx, entity, from, to, now, horizons, proofs)));
    if (publication) rows.push(...(await this.publications(tx, entity, from, to, now, proofs)));
    if (requested('REACH', 'RECENT_POST_SAMPLE_20'))
      rows.push(...(await this.recent(tx, entity, fromDay, toDay, now)));
    return rows;
  }

  private async audience(
    tx: Prisma.TransactionClient,
    entity: StatsEntity,
    from: Date,
    to: Date,
  ): Promise<StatsCandidate[]> {
    const points = await tx.$queryRaw<Array<{ observed_at: Date; value: number }>>`
      SELECT DISTINCT ON (date_trunc('day',observed_at)) observed_at,value FROM (
        SELECT observed_at,participants_count AS value FROM managed_entity_audience_observations
          WHERE chat_id=${entity.maxId} AND entity_type=${entity.kind}::"ChatEntityType"
            AND observed_at>=${from} AND observed_at<${to}
        UNION ALL
        SELECT captured_at AT TIME ZONE 'UTC',participants_count FROM channel_audience_snapshots
          WHERE ${entity.kind}='CHANNEL' AND chat_id=${entity.maxId} AND participants_count IS NOT NULL
            AND captured_at>=${from} AND captured_at<${to}
        UNION ALL
        SELECT a.observed_at,a.audience FROM marketplace_audience_observations a
          JOIN marketplace_bindings b ON b.id=a.binding_id
          WHERE b.entity_id=${entity.maxId} AND b.kind=${entity.kind}
            AND a.bucket>=${from} AND a.bucket<${to} AND a.observed_at>=${from} AND a.observed_at<${to}
      ) native ORDER BY date_trunc('day',observed_at),observed_at DESC,value DESC`;
    return points.map((point) =>
      limited(
        {
          producer: 'MAXIM',
          scope: {
            metric: 'AUDIENCE',
            horizon: 0,
            method: { id: 'AUDIENCE_SNAPSHOT', version: 1 },
            day: day(point.observed_at),
          },
          value: { value: count(BigInt(point.value)), observedAt: point.observed_at.toISOString() },
          coverage: { state: 'COMPLETE', intervals: [], populationComplete: true },
          health: health(point.observed_at),
          dependencies: [],
        },
        count(BigInt(point.value)) === null,
      ),
    );
  }

  private async membership(
    tx: Prisma.TransactionClient,
    entity: StatsEntity,
    from: Date,
    to: Date,
  ): Promise<StatsCandidate[]> {
    const completeTo = new Date(Math.floor(to.getTime() / 3_600_000) * 3_600_000);
    const points = await tx.$queryRaw<
      Array<{
        bucket: Date;
        joined: bigint;
        left_count: bigint;
        observed_from: Date;
        observed_to: Date;
        captured_at: Date;
      }>
    >`
      WITH observed AS (
        SELECT bucket_start AT TIME ZONE 'UTC' AS at,joined_users::bigint AS joined,
          left_users::bigint AS left_count,updated_at AT TIME ZONE 'UTC' AS captured_at
        FROM chat_membership_activity_rollups WHERE chat_id=${entity.maxId}
          AND bucket_start>=${from} AND bucket_start<${completeTo}
        UNION ALL
        SELECT event_at AT TIME ZONE 'UTC',CASE WHEN event_type='user_added' THEN 1 ELSE 0 END,
          CASE WHEN event_type='user_removed' THEN 1 ELSE 0 END,source_created_at AT TIME ZONE 'UTC'
        FROM chat_membership_activity_feed_items WHERE chat_id=${entity.maxId}
          AND event_type IN ('user_added','user_removed') AND event_at>=${completeTo} AND event_at<${to}
      ) SELECT date_trunc('day',at) AS bucket,sum(joined)::bigint AS joined,
        sum(left_count)::bigint AS left_count,min(captured_at) AS observed_from,max(captured_at) AS observed_to,
        max(captured_at) AS captured_at FROM observed GROUP BY 1 ORDER BY 1`;
    return points.map((point) =>
      limited(
        {
          producer: 'MAXIM',
          scope: {
            metric: 'MEMBERSHIP',
            horizon: 0,
            method: { id: 'OBSERVED_MEMBER_EVENTS', version: 1 },
            day: day(point.bucket),
          },
          value: {
            joined: count(point.joined),
            left: count(point.left_count),
            observedFrom: iso(point.observed_from),
            observedTo: iso(point.observed_to),
          },
          // FLAG: A retained event/rollup is not proof of uninterrupted webhook delivery.
          coverage: { state: 'PARTIAL', intervals: [], populationComplete: false },
          health: health(point.captured_at),
          dependencies: [],
        },
        count(point.joined) === null || count(point.left_count) === null,
      ),
    );
  }

  private posts(entity: StatsEntity, from: Date, to: Date, now: Date): Prisma.Sql {
    return Prisma.sql`
      WITH raw AS (
        SELECT p.message_id,p.published_at AT TIME ZONE 'UTC' AS published_at,
          CASE WHEN p.latest_snapshot_at IS NOT NULL THEN p.latest_views END AS views,
          p.latest_snapshot_at AT TIME ZONE 'UTC' AS observed_at,
          p.views_at_24h AS v24,p.views_at_24h_captured_at AT TIME ZONE 'UTC' AS t24,
          p.views_at_48h AS v48,p.views_at_48h_captured_at AT TIME ZONE 'UTC' AS t48,
          p.view_milestone_last_attempt_at AT TIME ZONE 'UTC' AS attempted_at,0 AS source_rank
        FROM channel_posts p WHERE p.chat_id=${entity.maxId}
          AND p.published_at>=${from} AND p.published_at<${to}
        UNION ALL
        SELECT s.message_id,s.published_at,s.views,s.observed_at,s.views_24,s.captured_24,
          s.views_48,s.captured_48,NULL::timestamptz,1
        FROM marketplace_post_samples s JOIN marketplace_bindings b ON b.id=s.binding_id
        WHERE b.entity_id=${entity.maxId} AND b.kind='CHANNEL'
          AND s.published_at>=${from} AND s.published_at<${to}
      ), identity_candidates AS (
        SELECT message_id,min(published_at) AS published_at,max(published_at) AS latest_published_at,
          max(attempted_at) AS attempted_at FROM raw GROUP BY message_id
      ), identity_conflicts AS (
        SELECT c.message_id FROM identity_candidates c
        WHERE c.published_at<>c.latest_published_at
          OR EXISTS (SELECT 1 FROM channel_posts p WHERE p.chat_id=${entity.maxId}
            AND p.message_id=c.message_id AND p.published_at AT TIME ZONE 'UTC'<>c.published_at)
          OR EXISTS (SELECT 1 FROM marketplace_bindings b
            CROSS JOIN LATERAL (SELECT s.published_at FROM marketplace_post_samples s
              WHERE s.binding_id=b.id AND s.message_id=c.message_id LIMIT 1) s
            WHERE b.entity_id=${entity.maxId} AND b.kind='CHANNEL' AND s.published_at<>c.published_at)
      ), identities AS (
        SELECT c.message_id,c.published_at,c.attempted_at FROM identity_candidates c
        WHERE NOT EXISTS (SELECT 1 FROM identity_conflicts x WHERE x.message_id=c.message_id)
      ), current_samples AS (
        SELECT DISTINCT ON(message_id) message_id,views,observed_at FROM raw
        WHERE views IS NOT NULL AND observed_at>=published_at AND observed_at<=${now}
        ORDER BY message_id,observed_at DESC,source_rank,views DESC
      ), timed24 AS (
        SELECT DISTINCT ON(message_id) message_id,v24,t24 FROM raw
        WHERE v24 IS NOT NULL AND t24 BETWEEN published_at+interval '24 hours'
          AND published_at+interval '24 hours 15 minutes' AND t24<=${now}
        ORDER BY message_id,t24,source_rank,v24 DESC
      ), timed48 AS (
        SELECT DISTINCT ON(message_id) message_id,v48,t48 FROM raw
        WHERE v48 IS NOT NULL AND t48 BETWEEN published_at+interval '48 hours'
          AND published_at+interval '48 hours 15 minutes' AND t48<=${now}
        ORDER BY message_id,t48,source_rank,v48 DESC
      ), posts AS (
        SELECT i.*,c.views,c.observed_at,a.v24,a.t24,b.v48,b.t48 FROM identities i
        LEFT JOIN current_samples c USING(message_id) LEFT JOIN timed24 a USING(message_id)
        LEFT JOIN timed48 b USING(message_id)
      )`;
  }

  private async proofs(
    tx: Prisma.TransactionClient,
    entity: StatsEntity,
    from: Date,
    to: Date,
    now: Date,
  ): Promise<Proof[]> {
    const [conflict] = await tx.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
      ${this.posts(entity, from, to, now)}
      SELECT EXISTS(SELECT 1 FROM identity_conflicts) AS present`);
    // FLAG: A rejected publication identity cannot become a proven empty/full day.
    if (conflict?.present) return [];
    return tx.$queryRaw<Proof[]>`
      SELECT from_at,to_at,
        to_char(from_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS from_exact,
        to_char(to_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS to_exact
      FROM (
      SELECT ${from}::timestamptz AS from_at,full_refresh_at AS to_at FROM channel_view_archive_states
        WHERE chat_id=${entity.maxId} AND discovery_complete_at IS NOT NULL AND full_refresh_at>=${from}
          AND full_refresh_at<=${now}
      UNION ALL
      SELECT history_from,history_to FROM marketplace_bindings WHERE entity_id=${entity.maxId}
        AND kind='CHANNEL' AND history_complete AND history_cursor IS NULL AND NOT history_anomaly
        AND history_from IS NOT NULL AND history_to>=${from} AND history_from<${to}
        AND history_to<=${now}) proof`;
  }

  private coverage(bucket: Date, proofs: Proof[], mature = true): StatsCoverage {
    const from = bucket.toISOString();
    const to = new Date(bucket.getTime() + DAY_MS).toISOString();
    const intervals = unionStatsCoverage(
      proofs.map((proof) => ({
        from: proof.from_exact ?? proof.from_at.toISOString(),
        to: proof.to_exact ?? proof.to_at.toISOString(),
      })),
      from,
      to,
    );
    const complete =
      intervals.length === 1 &&
      compareTimes(intervals[0]!.from, from) === 0 &&
      compareTimes(intervals[0]!.to, to) === 0;
    return {
      state: complete && mature ? 'COMPLETE' : 'PARTIAL',
      intervals,
      populationComplete: complete && mature,
    };
  }

  private async reach(
    tx: Prisma.TransactionClient,
    entity: StatsEntity,
    from: Date,
    to: Date,
    now: Date,
    horizons: number[],
    proofs: Proof[],
  ): Promise<StatsCandidate[]> {
    const points = await tx.$queryRaw<PostAggregate[]>(Prisma.sql`
      ${this.posts(entity, from, to, now)}
      SELECT date_trunc('day',p.published_at) AS bucket,s.horizon,count(*)::bigint AS posts,
        count(s.views)::bigint AS samples,sum(s.views::numeric)::text AS views,
        min(s.observed_at) AS observed_from,max(s.observed_at) AS observed_to,
        max(p.attempted_at) AS attempted_at,
        count(*) FILTER(WHERE s.horizon>0 AND s.views IS NULL
          AND p.published_at+s.horizon*interval '1 hour'+interval '15 minutes'<${now})::bigint AS missed,
        max(ceil(extract(epoch FROM s.observed_at-p.published_at)-s.horizon*3600)::int) AS delay
      FROM posts p CROSS JOIN LATERAL (VALUES
        (0,p.views,p.observed_at),(24,p.v24,p.t24),(48,p.v48,p.t48)
      ) s(horizon,views,observed_at)
      WHERE s.horizon IN (${Prisma.join(horizons)})
        AND p.published_at+s.horizon*interval '1 hour'<=${now}
      GROUP BY 1,2 ORDER BY 1,2`);
    const present = new Set(points.map((point) => `${day(point.bucket)}:${point.horizon}`));
    // Only a completed scan may establish an empty publication day.
    for (let at = from.getTime(); at < to.getTime(); at += DAY_MS) {
      const bucket = new Date(at);
      for (const horizon of horizons)
        if (
          !present.has(`${day(bucket)}:${horizon}`) &&
          this.coverage(bucket, proofs, at + DAY_MS + horizon * 3_600_000 <= now.getTime())
            .populationComplete
        )
          points.push({
            bucket,
            horizon,
            posts: 0n,
            samples: 0n,
            views: '0',
            observed_from: null,
            observed_to: null,
            attempted_at: null,
            delay: null,
            missed: 0n,
          });
    }
    return points.map((point) => {
      const horizon = point.horizon as 0 | 24 | 48;
      const coverage = this.coverage(
        point.bucket,
        proofs,
        point.bucket.getTime() + DAY_MS + horizon * 3_600_000 <= now.getTime(),
      );
      if (point.samples !== point.posts) coverage.state = 'PARTIAL';
      const metricHealth = health(point.observed_to, horizon === 0 ? null : point.attempted_at);
      if (horizon > 0 && point.missed > 0n) {
        metricHealth.state = 'ERROR';
        metricHealth.errorCode = 'MISSED_HORIZON';
      }
      const samples = count(point.samples),
        posts = count(point.posts);
      return limited(
        {
          producer: 'MAXIM',
          scope: {
            metric: 'REACH',
            horizon,
            method: {
              id: horizon === 0 ? 'POST_PUBLICATION_DAY' : 'TIMED_POST_PUBLICATION_DAY',
              version: 1,
            },
            day: day(point.bucket),
          } as StatsCandidate['scope'],
          value: {
            views: validViews(point.views) ? point.views : null,
            samples: samples ?? 0,
            posts,
            observedFrom: iso(point.observed_from),
            observedTo: iso(point.observed_to),
            maxDelaySeconds: horizon === 0 ? null : point.delay,
          },
          coverage,
          health: metricHealth,
          dependencies: [],
        },
        samples === null || posts === null || !validViews(point.views),
      );
    });
  }

  private async publications(
    tx: Prisma.TransactionClient,
    entity: StatsEntity,
    from: Date,
    to: Date,
    now: Date,
    proofs: Proof[],
  ): Promise<StatsCandidate[]> {
    const points = await tx.$queryRaw<Array<{ bucket: Date; hour: number; posts: bigint }>>(
      Prisma.sql`${this.posts(entity, from, to, now)}
        SELECT date_trunc('day',published_at) AS bucket,extract(hour FROM published_at)::int AS hour,
          count(*)::bigint AS posts FROM posts GROUP BY 1,2 ORDER BY 1,2`,
    );
    const buckets = new Map<string, Array<number | null>>();
    const invalidDays = new Set<string>();
    for (const point of points) {
      const key = day(point.bucket);
      const hours = buckets.get(key) ?? Array<number | null>(24).fill(null);
      hours[point.hour] = count(point.posts);
      if (hours[point.hour] === null) invalidDays.add(key);
      buckets.set(key, hours);
    }
    for (let at = from.getTime(); at < to.getTime(); at += DAY_MS) {
      const bucket = new Date(at);
      if (this.coverage(bucket, proofs).populationComplete && !buckets.has(day(bucket)))
        buckets.set(day(bucket), Array<number | null>(24).fill(0));
    }
    return [...buckets].map(([key, hours]) => {
      const coverage = this.coverage(new Date(`${key}T00:00:00.000Z`), proofs);
      if (coverage.populationComplete) hours = hours.map((value) => value ?? 0);
      const proof = proofs
        .filter((row) => row.from_at <= new Date(`${key}T00:00:00.000Z`))
        .sort((a, b) => b.to_at.getTime() - a.to_at.getTime())[0];
      return limited(
        {
          producer: 'MAXIM',
          scope: {
            metric: 'PUBLICATION_HOUR',
            horizon: 0,
            method: { id: 'PUBLICATION_DAY_HOURS', version: 1 },
            day: key,
          },
          value: { hours, observedFrom: null, observedTo: iso(proof?.to_at ?? null) },
          coverage,
          health: health(proof?.to_at ?? null),
          dependencies: [],
        },
        invalidDays.has(key),
      );
    });
  }

  private async recent(
    tx: Prisma.TransactionClient,
    entity: StatsEntity,
    fromDay: string,
    toDay: string,
    now: Date,
  ): Promise<StatsCandidate[]> {
    const points = await tx.$queryRaw<
      Array<{
        posts: bigint;
        samples: bigint;
        views: string | null;
        observed_from: Date | null;
        observed_to: Date | null;
        publication_from: Date | null;
        publication_to: Date | null;
      }>
    >(Prisma.sql`${this.posts(entity, new Date(now.getTime() - 30 * DAY_MS), new Date(now.getTime() - DAY_MS), now)},
      recent AS (SELECT * FROM posts ORDER BY published_at DESC,message_id LIMIT 20)
      SELECT count(*)::bigint AS posts,count(views)::bigint AS samples,sum(views::numeric)::text AS views,
        min(observed_at) AS observed_from,max(observed_at) AS observed_to,
        min(published_at) AS publication_from,max(published_at) AS publication_to FROM recent`);
    const point = points[0];
    // Latest-only post state cannot reconstruct past daily recent-post samples.
    if (!point?.observed_to || day(point.observed_to) < fromDay || day(point.observed_to) > toDay)
      return [];
    const samples = count(point.samples),
      posts = count(point.posts);
    const value: StatsReachValue = {
      views: validViews(point.views) ? point.views : null,
      samples: samples ?? 0,
      posts,
      observedFrom: iso(point.observed_from),
      observedTo: iso(point.observed_to),
      maxDelaySeconds: null,
    };
    return [
      limited(
        {
          producer: 'MAXIM',
          scope: {
            metric: 'REACH',
            horizon: 0,
            method: { id: 'RECENT_POST_SAMPLE_20', version: 1 },
            day: day(point.observed_to),
          },
          value: {
            ...value,
            publicationFrom: iso(point.publication_from),
            publicationTo: iso(point.publication_to),
          },
          coverage: { state: 'PARTIAL', intervals: [], populationComplete: false },
          health: health(point.observed_to),
          dependencies: [],
        },
        samples === null || posts === null || !validViews(point.views),
      ),
    ];
  }
}
