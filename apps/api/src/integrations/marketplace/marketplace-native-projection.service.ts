import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { MarketplaceBinding } from '@maxim/contracts/marketplace-integration';
import { PrismaService } from '../../prisma/prisma.service';
import type { Prisma } from '../../prisma/prisma-client';
import type { MaxChannelMessageSnapshot } from '../../max/max-client.service';
import { MARKETPLACE_HORIZON_TOLERANCE_MS } from './marketplace-statistics';
import { marketplaceLocalGrantSql } from './marketplace-state.service';

type NativeGrant = {
  entity_id: string;
  checked_at: Date | null;
  history_complete: boolean;
  history_cursor: Date | null;
  history_from: Date | null;
  history_to: Date | null;
  history_anomaly: boolean;
};
const count = (value: number | null) =>
  value !== null && Number.isInteger(value) && value >= 0 && value <= 2147483647 ? value : null;

@Injectable()
export class MarketplaceNativeProjectionService {
  constructor(private readonly prisma: PrismaService) {}

  // Only compact native statistics are projected. Message bodies never enter native retention.
  private async lock(
    tx: Prisma.TransactionClient,
    bindingId: string,
    lease: string,
  ): Promise<NativeGrant | null> {
    await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
    // FLAG: Serialize native writes with access/lifecycle updates in their Chat -> binding order.
    await tx.$queryRaw`SELECT c.id FROM chats c JOIN marketplace_bindings b ON b.entity_id=c.id
      WHERE b.id=${bindingId}::uuid FOR UPDATE OF c`;
    const rows = await tx.$queryRaw<NativeGrant[]>`SELECT entity_id,checked_at,history_complete,
      history_cursor,history_from,history_to,history_anomaly FROM marketplace_bindings
      WHERE id=${bindingId}::uuid AND lease_id=${lease}::uuid AND lease_until>now()
        AND kind='CHANNEL' AND ${marketplaceLocalGrantSql()}
      FOR UPDATE`;
    return rows[0] ?? null;
  }

  async audience(
    bindingId: string,
    lease: string,
    observedAt: Date,
    metadata: MarketplaceBinding['metadata'],
  ): Promise<void> {
    if (count(metadata.audience) === null || !Number.isFinite(observedAt.getTime())) return;
    await this.prisma.$transaction(async (tx) => {
      const grant = await this.lock(tx, bindingId, lease);
      if (!grant || grant.checked_at?.getTime() !== observedAt.getTime()) return;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'marketplace-native-audience:' + grant.entity_id},0))`;
      const latest = await tx.channelAudienceSnapshot.findFirst({
        where: { chatId: grant.entity_id },
        orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
        select: { capturedAt: true, status: true, lastEventAt: true },
      });
      // These native fields are deliberately absent from the shared wire; omission is not a reset.
      await tx.$executeRaw`INSERT INTO channel_audience_snapshots
        (id,chat_id,participants_count,is_public,link,status,last_event_at,captured_at)
        SELECT ${randomUUID()},${grant.entity_id},${metadata.audience},${metadata.isPublic},${metadata.publicUrl},
          ${latest?.status ?? null},${latest?.lastEventAt ?? null},${observedAt}
        WHERE NOT EXISTS(SELECT 1 FROM channel_audience_snapshots
          WHERE chat_id=${grant.entity_id} AND captured_at=${observedAt})`;
      if (!latest || latest.capturedAt <= observedAt)
        await tx.$executeRaw`UPDATE chats SET title=${metadata.title} WHERE id=${grant.entity_id}`;
      await tx.$executeRaw`INSERT INTO channel_stats_sync_states(id,chat_id,last_audience_sync_at,updated_at)
        VALUES(${randomUUID()},${grant.entity_id},${observedAt},now())
        ON CONFLICT(chat_id) DO UPDATE SET
          last_audience_sync_at=GREATEST(channel_stats_sync_states.last_audience_sync_at,EXCLUDED.last_audience_sync_at),updated_at=now()`;
      await tx.$executeRaw`UPDATE marketplace_bindings SET
        native_audience_checked_at=GREATEST(native_audience_checked_at,${observedAt}) WHERE id=${bindingId}::uuid`;
    });
  }

  async post(
    bindingId: string,
    lease: string,
    snapshot: MaxChannelMessageSnapshot,
    observedAt: Date,
  ): Promise<void> {
    const publishedAt = new Date(snapshot.publishedAt);
    if (!Number.isFinite(publishedAt.getTime()) || !Number.isFinite(observedAt.getTime())) return;
    if (publishedAt > observedAt || observedAt.getTime() > Date.now() + 30_000) return;
    const views = count(snapshot.views);
    const reactions = snapshot.reactions.filter(
      (item) => count(item.count) !== null && item.count > 0,
    );
    const reactionSum = reactions.reduce((sum, item) => sum + item.count, 0);
    const reactionsTotal =
      count(snapshot.reactionsTotal) === null && !reactions.length
        ? null
        : count(Math.max(snapshot.reactionsTotal ?? 0, reactionSum));
    const reactionsJson = reactions.length ? JSON.stringify(reactions) : null;
    await this.prisma.$transaction(async (tx) => {
      const grant = await this.lock(tx, bindingId, lease);
      if (!grant || grant.entity_id !== snapshot.chatId) return;
      const posts = await tx.$queryRaw<Array<{ id: string; latest_snapshot_at: Date | null }>>`
        INSERT INTO channel_posts(id,chat_id,message_id,published_at,url,preview_url,latest_views,
          latest_snapshot_at,latest_reactions,latest_reactions_total,updated_at)
        VALUES(${randomUUID()},${grant.entity_id},${snapshot.messageId},${publishedAt},${snapshot.url},${snapshot.previewUrl},
          COALESCE(${views}::int,0),${views === null ? null : observedAt},${reactionsJson}::jsonb,COALESCE(${reactionsTotal}::int,0),now())
        ON CONFLICT(chat_id,message_id) DO UPDATE SET
          url=CASE WHEN channel_posts.latest_snapshot_at IS NULL OR channel_posts.latest_snapshot_at<=${observedAt}
            THEN COALESCE(EXCLUDED.url,channel_posts.url) ELSE channel_posts.url END,
          preview_url=CASE WHEN channel_posts.latest_snapshot_at IS NULL OR channel_posts.latest_snapshot_at<=${observedAt}
            THEN COALESCE(EXCLUDED.preview_url,channel_posts.preview_url) ELSE channel_posts.preview_url END,
          latest_views=CASE WHEN ${views}::int IS NOT NULL AND (channel_posts.latest_snapshot_at IS NULL OR channel_posts.latest_snapshot_at<=${observedAt})
            THEN ${views}::int ELSE channel_posts.latest_views END,
          latest_snapshot_at=GREATEST(channel_posts.latest_snapshot_at,EXCLUDED.latest_snapshot_at),
          latest_reactions_total=CASE WHEN ${reactionsTotal}::int IS NOT NULL AND (channel_posts.latest_snapshot_at IS NULL OR channel_posts.latest_snapshot_at<=${observedAt})
            THEN ${reactionsTotal}::int ELSE channel_posts.latest_reactions_total END,
          latest_reactions=CASE WHEN ${reactionsTotal}::int IS NOT NULL AND (channel_posts.latest_snapshot_at IS NULL OR channel_posts.latest_snapshot_at<=${observedAt})
            AND (${reactionsJson}::jsonb IS NOT NULL OR ${reactionsTotal}::int=0)
            THEN ${reactionsJson}::jsonb ELSE channel_posts.latest_reactions END,updated_at=now()
        WHERE channel_posts.published_at=EXCLUDED.published_at RETURNING id,latest_snapshot_at`;
      const post = posts[0];
      if (!post) {
        await tx.$executeRaw`UPDATE marketplace_bindings SET history_anomaly=true WHERE id=${bindingId}::uuid`;
        return;
      }
      if (views === null) return;
      // Retain the legacy native reaction column; absence never overwrites a previous observation.
      if (!post.latest_snapshot_at || post.latest_snapshot_at <= observedAt)
        await tx.$executeRaw`INSERT INTO channel_post_view_snapshots(id,channel_post_id,views,reactions_total,captured_at)
        SELECT ${randomUUID()},id,${views},latest_reactions_total,${observedAt} FROM channel_posts WHERE id=${post.id}
        AND ${views} IS DISTINCT FROM (SELECT views FROM channel_post_view_snapshots
          WHERE channel_post_id=${post.id} ORDER BY captured_at DESC,id DESC LIMIT 1)`;
      const age = observedAt.getTime() - publishedAt.getTime();
      for (const horizon of [24, 48]) {
        if (age < horizon * 3600_000 || age > horizon * 3600_000 + MARKETPLACE_HORIZON_TOLERANCE_MS)
          continue;
        await tx.channelPost.updateMany({
          where: {
            id: post.id,
            // Improve legacy late milestones while retaining their original raw snapshots.
            OR:
              horizon === 24
                ? [
                    { viewsAt24h: null },
                    { viewsAt24hCapturedAt: null },
                    {
                      viewsAt24hCapturedAt: { lt: new Date(publishedAt.getTime() + 24 * 3600_000) },
                    },
                    {
                      viewsAt24hCapturedAt: {
                        gt: new Date(
                          publishedAt.getTime() + 24 * 3600_000 + MARKETPLACE_HORIZON_TOLERANCE_MS,
                        ),
                      },
                    },
                  ]
                : [
                    { viewsAt48h: null },
                    { viewsAt48hCapturedAt: null },
                    {
                      viewsAt48hCapturedAt: { lt: new Date(publishedAt.getTime() + 48 * 3600_000) },
                    },
                    {
                      viewsAt48hCapturedAt: {
                        gt: new Date(
                          publishedAt.getTime() + 48 * 3600_000 + MARKETPLACE_HORIZON_TOLERANCE_MS,
                        ),
                      },
                    },
                  ],
          },
          data:
            horizon === 24
              ? { viewsAt24h: views, viewsAt24hCapturedAt: observedAt }
              : { viewsAt48h: views, viewsAt48hCapturedAt: observedAt },
        });
      }
    });
  }

  async completeHistory(
    bindingId: string,
    lease: string,
    checkedAt: Date,
    options: { full: boolean },
  ): Promise<void> {
    if (!Number.isFinite(checkedAt.getTime()) || checkedAt.getTime() > Date.now() + 30_000) return;
    await this.prisma.$transaction(async (tx) => {
      const grant = await this.lock(tx, bindingId, lease);
      if (
        !grant?.history_complete ||
        grant.history_cursor ||
        grant.history_anomaly ||
        !grant.history_from ||
        !grant.history_to ||
        grant.history_from > grant.history_to
      )
        return;
      await tx.$executeRaw`INSERT INTO channel_stats_sync_states
        (id,chat_id,views_coverage_from,last_views_sync_at,last_views_discovery_at,last_views_attempt_at,updated_at)
        VALUES(${randomUUID()},${grant.entity_id},${grant.history_from},${options.full ? checkedAt : null},${checkedAt},${checkedAt},now())
        ON CONFLICT(chat_id) DO UPDATE SET
          views_coverage_from=LEAST(channel_stats_sync_states.views_coverage_from,EXCLUDED.views_coverage_from),
          last_views_sync_at=GREATEST(channel_stats_sync_states.last_views_sync_at,EXCLUDED.last_views_sync_at),
          last_views_discovery_at=GREATEST(channel_stats_sync_states.last_views_discovery_at,EXCLUDED.last_views_discovery_at),
          last_views_attempt_at=GREATEST(channel_stats_sync_states.last_views_attempt_at,EXCLUDED.last_views_attempt_at),updated_at=now()`;
      await tx.$executeRaw`UPDATE marketplace_bindings SET
        native_history_checked_at=GREATEST(native_history_checked_at,${checkedAt}),
        native_full_checked_at=GREATEST(native_full_checked_at,${options.full ? checkedAt : null}) WHERE id=${bindingId}::uuid`;
    });
  }
}
