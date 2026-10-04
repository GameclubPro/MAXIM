import { Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { MaxClientService } from '../../max/max-client.service';
import {
  MarketplaceStateService,
  marketplaceLocalGrantSql,
  type MarketplaceBindingRow,
} from './marketplace-state.service';
import {
  parseMarketplacePost,
  MARKETPLACE_HORIZON_TOLERANCE_MS,
  utcHour,
} from './marketplace-statistics';
import { MarketplaceStatisticsService } from './marketplace-statistics.service';
import { MarketplaceNativeProjectionService } from './marketplace-native-projection.service';

@Injectable()
export class MarketplaceCollectorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly max: MaxClientService,
    private readonly state: MarketplaceStateService,
    private readonly statistics: MarketplaceStatisticsService,
    @Optional() private readonly native?: MarketplaceNativeProjectionService,
  ) {}
  async tick(profile?: 'moderation' | 'publisher'): Promise<void> {
    if (!this.state.enabled()) return;
    const lease = randomUUID();
    const rows = await this.prisma.$queryRaw<MarketplaceBindingRow[]>`
      UPDATE marketplace_bindings SET lease_id=${lease}::uuid,lease_until=now()+interval '2 minutes'
      WHERE id=(SELECT b.id FROM marketplace_bindings b WHERE ${marketplaceLocalGrantSql('b')}
        AND (${profile ?? null}::text IS NULL OR b.profile=${profile ?? null})
        AND b.next_collect_at<=now() AND (b.lease_until IS NULL OR b.lease_until<now())
        AND NOT EXISTS(SELECT 1 FROM marketplace_bindings busy WHERE busy.entity_id=b.entity_id AND busy.lease_until>now())
        AND NOT EXISTS(SELECT 1 FROM marketplace_bindings preferred WHERE preferred.entity_id=b.entity_id
          AND ${marketplaceLocalGrantSql('preferred')}
          AND (CASE WHEN preferred.collection_owner='MAXIM' THEN 0 ELSE 1 END,preferred.id)
            <(CASE WHEN b.collection_owner='MAXIM' THEN 0 ELSE 1 END,b.id))
        ORDER BY b.next_collect_at,b.id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`;
    const row = rows[0];
    if (!row) return;
    try {
      const metadata = this.state.present(row).metadata;
      if (metadata.audience !== null && row.checked_at) {
        await this.prisma
          .$executeRaw`INSERT INTO marketplace_audience_observations(binding_id,bucket,audience,observed_at)
          SELECT ${row.id}::uuid,${new Date(utcHour(row.checked_at))},${metadata.audience},${row.checked_at}
          WHERE EXISTS(SELECT 1 FROM marketplace_bindings WHERE id=${row.id}::uuid AND lease_id=${lease}::uuid AND ${marketplaceLocalGrantSql()} FOR UPDATE)
          ON CONFLICT(binding_id,bucket) DO UPDATE SET audience=EXCLUDED.audience,observed_at=EXCLUDED.observed_at
          WHERE marketplace_audience_observations.observed_at<EXCLUDED.observed_at`;
      }
      if (row.checked_at) await this.native?.audience(row.id, lease, row.checked_at, metadata);
      if (row.kind === 'CHANNEL') {
        await this.seedNativeMilestones(row, lease);
        await this.sampleDue(row, lease);
        await this.scanPage(row, lease);
      } else {
        await this.prisma
          .$executeRaw`UPDATE marketplace_bindings SET history_complete=true,history_cursor=NULL,history_to=now() WHERE id=${row.id}::uuid AND lease_id=${lease}::uuid AND lease_until>now() AND ${marketplaceLocalGrantSql()}`;
      }
      const fresh = await this.state.read(row.id);
      if (
        fresh?.lease_id === lease &&
        fresh.lease_until &&
        fresh.lease_until.getTime() > Date.now() &&
        fresh.statistics_consent &&
        (await this.state.hasActiveGrant(row.id, lease))
      ) {
        await this.statistics.createGeneration(fresh);
        await this.shareCollectedHistory(fresh, lease);
      }
    } finally {
      await this.prisma.$executeRaw`UPDATE marketplace_bindings SET lease_id=NULL,lease_until=NULL,
        next_collect_at=GREATEST(next_collect_at,now()+interval '1 minute') WHERE id=${row.id}::uuid AND lease_id=${lease}::uuid`;
    }
  }
  private async scanPage(binding: MarketplaceBindingRow, lease: string): Promise<void> {
    const current = await this.state.read(binding.id);
    if (
      current?.lease_id !== lease ||
      !current.lease_until ||
      current.lease_until.getTime() <= Date.now() ||
      current.state !== 'ACTIVE' ||
      !current.statistics_consent ||
      !current.valid_until ||
      current.valid_until.getTime() <= Date.now()
    )
      return;
    if (!(await this.state.hasActiveGrant(binding.id, lease))) return;
    const now = new Date();
    const oldest = new Date(now);
    oldest.setUTCHours(0, 0, 0, 0);
    oldest.setUTCDate(oldest.getUTCDate() - 89);
    const cursor = binding.history_cursor ?? now;
    const upper = binding.history_complete
      ? (binding.discovery_to ?? now)
      : (binding.history_to ?? now);
    // Refresh existing views/reactions hourly, while preserving bounded resumable discovery.
    const refreshFull =
      binding.history_complete &&
      !binding.history_cursor &&
      (!binding.native_full_checked_at ||
        binding.native_full_checked_at.getTime() <= now.getTime() - 3600_000);
    // Freeze each discovery interval: posts arriving while older pages load are read next cycle.
    const lower = binding.history_complete
      ? (binding.discovery_from ?? (refreshFull ? oldest : binding.history_to) ?? oldest)
      : (binding.history_from ?? oldest);
    const full = !binding.history_complete || refreshFull || lower.getTime() <= oldest.getTime();
    const raw = await this.max.listMessages(binding.entity_id, {
      count: 100,
      from: cursor,
      to: lower,
      botId: binding.bot_id,
      trafficClass: 'background',
      sourceTag: 'marketplace_history',
    });
    const parsed = raw.map(parseMarketplacePost);
    const posts = parsed
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .filter((post) => post.publishedAt >= oldest && post.publishedAt <= upper)
      .sort(
        (a, b) =>
          b.publishedAt.getTime() - a.publishedAt.getTime() ||
          a.messageId.localeCompare(b.messageId),
      );
    const observedAt = new Date();
    for (const post of posts) await this.storeSample(binding, lease, post, observedAt);
    if (this.native) {
      for (const rawPost of raw) {
        const parsedPost = parseMarketplacePost(rawPost);
        if (!parsedPost || parsedPost.publishedAt < oldest || parsedPost.publishedAt > upper)
          continue;
        const snapshot = this.max.parseChannelMessageSnapshot(binding.entity_id, rawPost);
        if (
          !snapshot ||
          snapshot.messageId !== parsedPost.messageId ||
          snapshot.publishedAtMs !== parsedPost.publishedAt.getTime()
        ) {
          await this.prisma
            .$executeRaw`UPDATE marketplace_bindings SET history_anomaly=true WHERE id=${binding.id}::uuid AND lease_id=${lease}::uuid`;
          continue;
        }
        await this.native.post(
          binding.id,
          lease,
          { ...snapshot, views: parsedPost.views },
          observedAt,
        );
      }
    }
    const last = parsed
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime())[0];
    const signature = posts.map((post) => post.messageId).join('|');
    const safe =
      raw.length <= 100 &&
      parsed.every((row) => row !== null && row.publishedAt.getTime() <= cursor.getTime() + 1000);
    const finished = safe && (raw.length < 100 || (!!last && last.publishedAt <= lower));
    const stalled = raw.length >= 100 && signature === binding.history_signature;
    await this.prisma.$executeRaw`UPDATE marketplace_bindings SET
      history_complete=${binding.history_complete || (finished && safe && !binding.history_anomaly)},history_cursor=${finished ? null : (last?.publishedAt ?? cursor)},
      history_signature=${signature.slice(0, 32000)},history_from=COALESCE(history_from,${oldest}),
      history_to=${finished ? upper : (binding.history_to ?? now)},
      discovery_from=${binding.history_complete && !finished ? lower : null},discovery_to=${binding.history_complete && !finished ? upper : null},
      history_anomaly=history_anomaly OR ${!safe || stalled},
      next_collect_at=${new Date(now.getTime() + (stalled ? 5 * 60_000 : 60_000))}
      WHERE id=${binding.id}::uuid AND lease_id=${lease}::uuid AND lease_until>now() AND ${marketplaceLocalGrantSql()}`;
    if (finished && !stalled)
      await this.native?.completeHistory(binding.id, lease, observedAt, { full });
  }
  private async sampleDue(binding: MarketplaceBindingRow, lease: string): Promise<void> {
    await this.prisma
      .$executeRaw`UPDATE marketplace_post_samples SET next_sample_at=NULL WHERE (binding_id,message_id) IN (
      SELECT binding_id,message_id FROM marketplace_post_samples WHERE binding_id=${binding.id}::uuid AND next_sample_at IS NOT NULL
      AND published_at<=now()-interval '48 hours 15 minutes' ORDER BY published_at,message_id LIMIT 1000)`;
    const due = await this.prisma.$queryRaw<
      Array<{ message_id: string }>
    >`SELECT message_id FROM marketplace_post_samples
      WHERE binding_id=${binding.id}::uuid AND next_sample_at<=now() AND published_at>now()-interval '48 hours 15 minutes' ORDER BY next_sample_at,message_id LIMIT 20`;
    for (const item of due) {
      const current = await this.state.read(binding.id);
      if (
        current?.lease_id !== lease ||
        current.state !== 'ACTIVE' ||
        !current.statistics_consent ||
        !current.lease_until ||
        current.lease_until.getTime() <= Date.now() ||
        !current.valid_until ||
        current.valid_until.getTime() <= Date.now()
      )
        return;
      if (!(await this.state.hasActiveGrant(binding.id, lease))) return;
      const snapshot = await this.max.getMessageSnapshot(binding.entity_id, item.message_id, {
        botId: binding.bot_id,
        trafficClass: 'background',
        sourceTag: 'marketplace_milestone',
        timeoutMs: 5_000,
      });
      if (snapshot && snapshot.messageId === item.message_id) {
        const observedAt = new Date();
        await this.storeSample(
          binding,
          lease,
          {
            messageId: snapshot.messageId,
            publishedAt: new Date(snapshot.publishedAt),
            views: snapshot.views,
          },
          observedAt,
        );
        await this.native?.post(binding.id, lease, snapshot, observedAt);
      } else
        await this.prisma
          .$executeRaw`UPDATE marketplace_post_samples SET next_sample_at=now()+interval '3 minutes' WHERE binding_id=${binding.id}::uuid AND message_id=${item.message_id}`;
    }
  }
  private async seedNativeMilestones(binding: MarketplaceBindingRow, lease: string): Promise<void> {
    // A new elected profile resumes native due posts without another MAX history request.
    await this.prisma
      .$executeRaw`INSERT INTO marketplace_post_samples(binding_id,message_id,published_at,views,observed_at,views_24,captured_24,views_48,captured_48,next_sample_at)
      SELECT ${binding.id}::uuid,p.message_id,p.published_at AT TIME ZONE 'UTC',
        CASE WHEN p.latest_snapshot_at IS NOT NULL THEN p.latest_views END,p.latest_snapshot_at AT TIME ZONE 'UTC',
        CASE WHEN p.views_at_24h_captured_at BETWEEN p.published_at+interval '24 hours' AND p.published_at+interval '24 hours 15 minutes' THEN p.views_at_24h END,
        CASE WHEN p.views_at_24h_captured_at BETWEEN p.published_at+interval '24 hours' AND p.published_at+interval '24 hours 15 minutes' THEN p.views_at_24h_captured_at AT TIME ZONE 'UTC' END,
        CASE WHEN p.views_at_48h_captured_at BETWEEN p.published_at+interval '48 hours' AND p.published_at+interval '48 hours 15 minutes' THEN p.views_at_48h END,
        CASE WHEN p.views_at_48h_captured_at BETWEEN p.published_at+interval '48 hours' AND p.published_at+interval '48 hours 15 minutes' THEN p.views_at_48h_captured_at AT TIME ZONE 'UTC' END,
        (p.published_at AT TIME ZONE 'UTC')+CASE WHEN p.published_at AT TIME ZONE 'UTC'>now()-interval '24 hours 15 minutes' THEN interval '24 hours' ELSE interval '48 hours' END
      FROM channel_posts p WHERE p.chat_id=${binding.entity_id} AND p.published_at>(now() AT TIME ZONE 'UTC')-interval '48 hours 15 minutes'
        AND NOT EXISTS(SELECT 1 FROM marketplace_post_samples s WHERE s.binding_id=${binding.id}::uuid AND s.message_id=p.message_id)
        AND EXISTS(SELECT 1 FROM marketplace_bindings WHERE id=${binding.id}::uuid AND lease_id=${lease}::uuid AND lease_until>now() AND ${marketplaceLocalGrantSql()} FOR UPDATE)
      ORDER BY p.published_at,p.message_id LIMIT 1000 ON CONFLICT DO NOTHING`;
  }
  private async shareCollectedHistory(
    binding: MarketplaceBindingRow,
    lease: string,
  ): Promise<void> {
    if (!this.native) return;
    // One elected collector per entity supplies both consented profiles through native MAXIM storage.
    const followers = await this.prisma.$queryRaw<MarketplaceBindingRow[]>`
      UPDATE marketplace_bindings b SET history_complete=s.history_complete,history_from=s.history_from,history_to=s.history_to,
        history_cursor=s.history_cursor,history_signature=s.history_signature,discovery_from=s.discovery_from,discovery_to=s.discovery_to,history_anomaly=s.history_anomaly,native_history_checked_at=s.native_history_checked_at,
        native_full_checked_at=s.native_full_checked_at,native_audience_checked_at=s.native_audience_checked_at,next_collect_at=now()+interval '1 minute'
      FROM marketplace_bindings s WHERE s.id=${binding.id}::uuid AND s.lease_id=${lease}::uuid AND s.lease_until>now()
        AND ${marketplaceLocalGrantSql('s')}
        AND b.entity_id=s.entity_id AND b.id<>s.id AND b.kind=s.kind
        AND ${marketplaceLocalGrantSql('b')}
        AND (b.lease_until IS NULL OR b.lease_until<now()) RETURNING b.*`;
    for (const follower of followers) {
      if (follower.kind === 'CHAT') {
        await this.prisma
          .$executeRaw`INSERT INTO marketplace_audience_observations(binding_id,bucket,audience,observed_at)
          SELECT ${follower.id}::uuid,s.bucket,s.audience,s.observed_at FROM marketplace_audience_observations s
          WHERE s.binding_id=${binding.id}::uuid
            AND EXISTS(SELECT 1 FROM marketplace_bindings WHERE id=${follower.id}::uuid AND ${marketplaceLocalGrantSql()} FOR UPDATE)
          ON CONFLICT(binding_id,bucket) DO UPDATE SET audience=EXCLUDED.audience,observed_at=EXCLUDED.observed_at
          WHERE marketplace_audience_observations.observed_at<EXCLUDED.observed_at`;
      }
      await this.statistics.createGeneration(follower);
    }
  }
  private async storeSample(
    binding: MarketplaceBindingRow,
    lease: string,
    post: { messageId: string; publishedAt: Date; views: number | null },
    observedAt: Date,
  ): Promise<void> {
    const age = observedAt.getTime() - post.publishedAt.getTime();
    const capture = (horizon: number) =>
      post.views !== null &&
      age >= horizon * 3600_000 &&
      age <= horizon * 3600_000 + MARKETPLACE_HORIZON_TOLERANCE_MS;
    const capture24 = capture(24),
      capture48 = capture(48);
    const next =
      age < 24 * 3600_000
        ? new Date(post.publishedAt.getTime() + 24 * 3600_000)
        : !capture24 && age < 24 * 3600_000 + MARKETPLACE_HORIZON_TOLERANCE_MS
          ? new Date(observedAt.getTime() + 3 * 60_000)
          : age < 48 * 3600_000
            ? new Date(post.publishedAt.getTime() + 48 * 3600_000)
            : !capture48 && age < 48 * 3600_000 + MARKETPLACE_HORIZON_TOLERANCE_MS
              ? new Date(observedAt.getTime() + 3 * 60_000)
              : null;
    const stored = await this.prisma
      .$executeRaw`INSERT INTO marketplace_post_samples(binding_id,message_id,published_at,views,observed_at,views_24,captured_24,views_48,captured_48,next_sample_at)
      SELECT ${binding.id}::uuid,${post.messageId},${post.publishedAt},${post.views},${post.views === null ? null : observedAt},
        ${capture24 ? post.views : null},${capture24 ? observedAt : null},${capture48 ? post.views : null},${capture48 ? observedAt : null},${next}
      WHERE EXISTS(SELECT 1 FROM marketplace_bindings WHERE id=${binding.id}::uuid AND lease_id=${lease}::uuid AND lease_until>now() AND ${marketplaceLocalGrantSql()} FOR UPDATE)
      ON CONFLICT(binding_id,message_id) DO UPDATE SET
        views=CASE WHEN EXCLUDED.observed_at>=marketplace_post_samples.observed_at OR marketplace_post_samples.observed_at IS NULL THEN EXCLUDED.views ELSE marketplace_post_samples.views END,
        observed_at=GREATEST(marketplace_post_samples.observed_at,EXCLUDED.observed_at),
        views_24=COALESCE(marketplace_post_samples.views_24,EXCLUDED.views_24),captured_24=COALESCE(marketplace_post_samples.captured_24,EXCLUDED.captured_24),
        views_48=COALESCE(marketplace_post_samples.views_48,EXCLUDED.views_48),captured_48=COALESCE(marketplace_post_samples.captured_48,EXCLUDED.captured_48),next_sample_at=EXCLUDED.next_sample_at
      WHERE marketplace_post_samples.published_at=EXCLUDED.published_at`;
    if (!stored)
      await this.prisma.$executeRaw`UPDATE marketplace_bindings SET history_anomaly=true
      WHERE id=${binding.id}::uuid AND lease_id=${lease}::uuid AND lease_until>now() AND ${marketplaceLocalGrantSql()}
      AND EXISTS(SELECT 1 FROM marketplace_post_samples WHERE binding_id=${binding.id}::uuid AND message_id=${post.messageId} AND published_at<>${post.publishedAt})`;
  }
}
