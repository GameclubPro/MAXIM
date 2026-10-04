import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  marketplaceStatisticsManifestSchema,
  marketplaceStatisticsPageSchema,
  type MarketplaceStatisticRow,
} from '@maxim/contracts/marketplace-integration';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MarketplaceStateService,
  marketplaceLocalGrantSql,
  type MarketplaceBindingRow,
} from './marketplace-state.service';
import { canonicalMarketplaceRows, marketplaceRowsHash, utcDay } from './marketplace-statistics';

const pageQuery = z
  .object({ generationId: z.string().uuid().optional(), cursor: z.string().max(200).optional() })
  .strict();
const cursorSchema = z
  .object({ g: z.string().uuid(), o: z.number().int().min(0).max(3000) })
  .strict();
@Injectable()
export class MarketplaceStatisticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly state: MarketplaceStateService,
  ) {}
  async createGeneration(requested: MarketplaceBindingRow, asOf = new Date()): Promise<string> {
    return this.prisma.$transaction(
      async (tx) => {
        // Prisma's PostgreSQL adapter normalizes offset timestamps as UTC; pin this snapshot explicitly.
        await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
        const current = await tx.$queryRaw<
          MarketplaceBindingRow[]
        >`SELECT * FROM marketplace_bindings WHERE id=${requested.id}::uuid AND ${marketplaceLocalGrantSql()} FOR UPDATE`;
        const binding = current[0];
        if (
          !binding ||
          binding.state !== 'ACTIVE' ||
          !binding.statistics_consent ||
          !binding.valid_until ||
          binding.valid_until <= asOf
        )
          throw new ConflictException('Доступ к статистике изменился');
        const from = new Date(asOf);
        from.setUTCHours(0, 0, 0, 0);
        from.setUTCDate(from.getUTCDate() - 89);
        const conflicts = await tx.$queryRaw<
          Array<{ message_id: string }>
        >`SELECT s.message_id FROM marketplace_post_samples s JOIN channel_posts p ON p.chat_id=${binding.entity_id} AND p.message_id=s.message_id WHERE s.binding_id=${binding.id}::uuid AND s.published_at<>(p.published_at AT TIME ZONE 'UTC') LIMIT 1`;
        if (conflicts.length)
          throw new ConflictException('Время публикации расходится между источниками');
        const complete =
          binding.history_complete && !binding.history_cursor && !binding.history_anomaly;
        const aggregates = await tx.$queryRaw<
          Array<{
            bucket: Date;
            horizon: number;
            posts: bigint;
            samples: bigint;
            views: bigint;
            observed: Date | null;
            delay: number | null;
          }>
        >`
      WITH merged AS (
        SELECT COALESCE(s.published_at,p.published_at AT TIME ZONE 'UTC') AS published_at,
          CASE WHEN p.latest_snapshot_at IS NULL OR s.observed_at>=(p.latest_snapshot_at AT TIME ZONE 'UTC') THEN s.views ELSE p.latest_views END AS views,
          GREATEST(s.observed_at,(p.latest_snapshot_at AT TIME ZONE 'UTC')) AS observed,
          COALESCE(s.views_24,CASE WHEN p.views_at_24h_captured_at BETWEEN p.published_at+interval '24 hours' AND p.published_at+interval '24 hours 15 minutes' THEN p.views_at_24h END) AS v24,
          COALESCE(s.captured_24,CASE WHEN p.views_at_24h_captured_at BETWEEN p.published_at+interval '24 hours' AND p.published_at+interval '24 hours 15 minutes' THEN (p.views_at_24h_captured_at AT TIME ZONE 'UTC') END) AS t24,
          COALESCE(s.views_48,CASE WHEN p.views_at_48h_captured_at BETWEEN p.published_at+interval '48 hours' AND p.published_at+interval '48 hours 15 minutes' THEN p.views_at_48h END) AS v48,
          COALESCE(s.captured_48,CASE WHEN p.views_at_48h_captured_at BETWEEN p.published_at+interval '48 hours' AND p.published_at+interval '48 hours 15 minutes' THEN (p.views_at_48h_captured_at AT TIME ZONE 'UTC') END) AS t48
        FROM (SELECT * FROM channel_posts WHERE chat_id=${binding.entity_id} AND published_at>=${from} AND published_at<=${asOf}) p
        FULL JOIN (SELECT * FROM marketplace_post_samples WHERE binding_id=${binding.id}::uuid AND published_at>=${from} AND published_at<=${asOf}) s
          ON p.message_id=s.message_id AND (p.published_at AT TIME ZONE 'UTC')=s.published_at
      ), samples AS (
        SELECT published_at,0 AS horizon,views,observed,0 AS delay FROM merged
        UNION ALL SELECT published_at,24,v24,t24,ceil(extract(epoch FROM t24-published_at-interval '24 hours'))::int FROM merged WHERE published_at<=${asOf}::timestamptz-interval '24 hours'
        UNION ALL SELECT published_at,48,v48,t48,ceil(extract(epoch FROM t48-published_at-interval '48 hours'))::int FROM merged WHERE published_at<=${asOf}::timestamptz-interval '48 hours'
      ) SELECT date_trunc('day',published_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,horizon,count(*)::bigint AS posts,
        count(views)::bigint AS samples,COALESCE(sum(views),0)::bigint AS views,max(observed) AS observed,max(delay) FILTER(WHERE views IS NOT NULL) AS delay
      FROM samples GROUP BY 1,2 ORDER BY 1,2`;
        const rows: MarketplaceStatisticRow[] = aggregates.map((row) => ({
          metric: 'REACH',
          bucket: row.bucket.toISOString(),
          horizon: z.union([z.literal(0), z.literal(24), z.literal(48)]).parse(row.horizon),
          posts: Number(row.posts),
          samples: Number(row.samples),
          views: Number(row.views),
          observedAt: row.observed?.toISOString() ?? null,
          incomplete: !complete || row.posts !== row.samples,
          maxDelaySeconds: row.delay,
        }));
        const hours = await tx.$queryRaw<Array<{ bucket: Date; posts: bigint }>>`
      SELECT date_trunc('hour',published_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,count(*)::bigint AS posts FROM (
        SELECT message_id,published_at AT TIME ZONE 'UTC' AS published_at FROM channel_posts WHERE chat_id=${binding.entity_id} AND published_at>=${from} AND published_at<=${asOf}
        UNION SELECT message_id,published_at FROM marketplace_post_samples WHERE binding_id=${binding.id}::uuid AND published_at>=${from} AND published_at<=${asOf}
      ) p GROUP BY 1 ORDER BY 1`;
        for (const point of hours)
          rows.push({
            metric: 'PUBLICATION_HOUR',
            bucket: point.bucket.toISOString(),
            posts: Number(point.posts),
            complete,
            observedAt: null,
          });
        const audience = await tx.$queryRaw<Array<{ observed_at: Date; audience: number }>>`
      SELECT DISTINCT ON (date_trunc('day',observed_at AT TIME ZONE 'UTC')) observed_at,audience FROM (
        SELECT observed_at,audience FROM marketplace_audience_observations WHERE binding_id=${binding.id}::uuid AND observed_at>=${from} AND observed_at<=${asOf}
        UNION ALL SELECT captured_at AT TIME ZONE 'UTC',participants_count FROM channel_audience_snapshots WHERE chat_id=${binding.entity_id}
          AND participants_count IS NOT NULL AND captured_at>=${from} AND captured_at<=${asOf}
      ) a ORDER BY date_trunc('day',observed_at AT TIME ZONE 'UTC'),observed_at DESC`;
        for (const point of audience)
          rows.push({
            metric: 'AUDIENCE',
            bucket: utcDay(point.observed_at),
            value: point.audience,
            observedAt: point.observed_at.toISOString(),
          });
        const membership = await tx.$queryRaw<
          Array<{ bucket: Date; joined: bigint; left: bigint; observed: Date }>
        >`
      SELECT date_trunc('day',bucket_start) AT TIME ZONE 'UTC' AS bucket,sum(joined_users)::bigint AS joined,sum(left_users)::bigint AS left,max(updated_at) AT TIME ZONE 'UTC' AS observed
      FROM chat_membership_activity_rollups WHERE chat_id=${binding.entity_id} AND bucket_start>=${from} AND bucket_start<=${asOf} GROUP BY 1 ORDER BY 1`;
        for (const point of membership)
          rows.push({
            metric: 'MEMBERSHIP',
            bucket: point.bucket.toISOString(),
            joined: Number(point.joined),
            left: Number(point.left),
            complete: false,
            observedAt: point.observed.toISOString(),
          });
        if (complete && binding.kind === 'CHANNEL') {
          const present = new Set(
            rows.map((row) => `${row.metric}:${row.bucket}:${'horizon' in row ? row.horizon : ''}`),
          );
          for (let day = from.getTime(); day <= asOf.getTime(); day += 86400_000) {
            const bucket = new Date(day).toISOString();
            for (const horizon of [0, 24, 48] as const)
              if (!present.has(`REACH:${bucket}:${horizon}`))
                rows.push({
                  metric: 'REACH',
                  bucket,
                  horizon,
                  posts: 0,
                  samples: 0,
                  views: 0,
                  incomplete: false,
                  observedAt: null,
                  maxDelaySeconds: null,
                });
          }
          for (let hour = from.getTime(); hour <= asOf.getTime(); hour += 3600_000) {
            const bucket = new Date(hour).toISOString();
            if (!present.has(`PUBLICATION_HOUR:${bucket}:`))
              rows.push({
                metric: 'PUBLICATION_HOUR',
                bucket,
                posts: 0,
                complete: true,
                observedAt: null,
              });
          }
        }
        const canonical = canonicalMarketplaceRows(rows);
        const hash = marketplaceRowsHash(canonical);
        if (binding.generation_id) {
          const existing = await tx.$queryRaw<
            Array<{ manifest: unknown }>
          >`SELECT manifest FROM marketplace_statistics_generations WHERE id=${binding.generation_id}::uuid AND binding_id=${binding.id}::uuid`;
          const previous =
            existing[0] && marketplaceStatisticsManifestSchema.parse(existing[0].manifest);
          if (
            previous &&
            previous.sha256 === hash &&
            previous.complete === complete &&
            previous.from === from.toISOString()
          ) {
            await tx.$executeRaw`UPDATE marketplace_bindings SET statistics_checked_at=${binding.history_anomaly ? binding.statistics_checked_at : asOf},updated_at=now() WHERE id=${binding.id}::uuid`;
            return previous.generationId;
          }
        }
        const id = randomUUID();
        const manifest = marketplaceStatisticsManifestSchema.parse({
          generationId: id,
          bindingId: binding.id,
          entityId: binding.entity_id,
          kind: binding.kind,
          source: 'MAXIM',
          method: 'utc-buckets-v1',
          from: from.toISOString(),
          to: asOf.toISOString(),
          asOf: asOf.toISOString(),
          rowCount: canonical.length,
          sha256: hash,
          complete,
          horizonToleranceSeconds: 900,
        });
        await tx.$executeRaw`INSERT INTO marketplace_statistics_generations(id,binding_id,manifest,rows) VALUES(${id}::uuid,${binding.id}::uuid,${JSON.stringify(manifest)}::jsonb,${JSON.stringify(canonical)}::jsonb)`;
        await tx.$executeRaw`UPDATE marketplace_bindings SET generation_id=${id}::uuid,statistics_checked_at=${binding.history_anomaly ? binding.statistics_checked_at : asOf},updated_at=now(),revision=revision+1 WHERE id=${binding.id}::uuid`;
        return id;
      },
      { isolationLevel: 'RepeatableRead', timeout: 20_000 },
    );
  }
  async page(id: string, raw: unknown) {
    const query = pageQuery.parse(raw);
    const binding = await this.state.read(id);
    if (
      !binding ||
      binding.state !== 'ACTIVE' ||
      !binding.statistics_consent ||
      !binding.valid_until ||
      binding.valid_until.getTime() <= Date.now() ||
      !(await this.state.hasActiveGrant(id))
    )
      throw new NotFoundException('Статистика недоступна');
    let cursor: z.infer<typeof cursorSchema> | null = null;
    if (query.cursor) {
      try {
        cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString()));
      } catch {
        throw new ConflictException('Некорректный курсор');
      }
    }
    const generationId = query.generationId ?? cursor?.g ?? binding.generation_id;
    if (!generationId) throw new ConflictException('Первичная статистика ещё собирается');
    if (cursor && cursor.g !== generationId)
      throw new ConflictException('Курсор относится к другой выгрузке');
    const rows = await this.prisma.$queryRaw<
      Array<{ manifest: unknown; rows: unknown }>
    >`SELECT manifest,rows FROM marketplace_statistics_generations WHERE id=${generationId}::uuid AND binding_id=${id}::uuid`;
    if (!rows[0]) throw new NotFoundException('Выгрузка устарела');
    const manifest = marketplaceStatisticsManifestSchema.parse(rows[0].manifest);
    const all = z.array(z.unknown()).max(3000).parse(rows[0].rows);
    const offset = cursor?.o ?? 0;
    if (offset > all.length) throw new ConflictException('Курсор вне выгрузки');
    return marketplaceStatisticsPageSchema.parse({
      manifest,
      rows: all.slice(offset, offset + 200),
      nextCursor:
        offset + 200 < all.length
          ? Buffer.from(JSON.stringify({ g: generationId, o: offset + 200 })).toString('base64url')
          : null,
    });
  }
}
