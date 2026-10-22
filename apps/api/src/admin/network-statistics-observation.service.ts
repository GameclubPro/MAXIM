import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ManagedEntityType } from '@maxim/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '../prisma/prisma-client';
import {
  advanceNetworkViewObservation,
  type NetworkViewObservationState,
} from './network-view-observation';
import type { MaxChannelMessageSnapshot, MaxClientService } from '../max/max-client.service';

type ObservationStateRow = {
  baseline_at: Date;
  observed_at: Date;
  observed_views: number;
  high_water_views: number;
  anomaly_at: Date | null;
};

@Injectable()
export class NetworkStatisticsObservationService {
  constructor(private readonly prisma: PrismaService) {}

  async archivePage(
    chatId: string,
    source: string,
    max: MaxClientService,
    options: {
      botId?: string;
      authorized?: () => Promise<boolean>;
      store: (message: MaxChannelMessageSnapshot, observedAt: Date) => Promise<void>;
    },
  ): Promise<void> {
    if (options.authorized && !(await options.authorized())) return;
    const startedAt = new Date();
    const deadline = startedAt.getTime() + 30_000;
    // FLAG: This is one bounded page inside the elected owner's existing work, not
    // another collector. An interrupted page is retried; its observations are idempotent.
    const claimed = await this.prisma.$queryRaw<
      Array<{ cursor_at: Date | null; cursor_signature: string | null }>
    >`
      INSERT INTO channel_view_archive_states(chat_id,last_attempt_at)
      VALUES (${chatId},${startedAt}) ON CONFLICT(chat_id) DO UPDATE SET last_attempt_at=EXCLUDED.last_attempt_at
      WHERE channel_view_archive_states.last_attempt_at IS NULL
        OR channel_view_archive_states.last_attempt_at < ${new Date(startedAt.getTime() - 60_000)}
      RETURNING cursor_at,cursor_signature
    `;
    const state = claimed[0];
    if (!state) return;
    const rows = await max.listMessages(chatId, {
      count: 100,
      from: state.cursor_at ?? startedAt,
      to: new Date(0),
      botId: options.botId,
      trafficClass: 'background',
      sourceTag: source === 'major' ? 'channel_stats_sync' : 'marketplace_history',
    });
    const snapshots = rows.map((row) => max.parseChannelMessageSnapshot(chatId, row));
    const safe = snapshots.every(
      (snapshot) =>
        snapshot &&
        snapshot.chatId === chatId &&
        Number.isFinite(new Date(snapshot.publishedAt).getTime()) &&
        new Date(snapshot.publishedAt).getTime() <= (state.cursor_at ?? startedAt).getTime() + 1000,
    );
    if (!safe) {
      await this.prisma.$executeRaw`UPDATE channel_view_archive_states SET stalled_at=${new Date()}
        WHERE chat_id=${chatId} AND last_attempt_at=${startedAt}`;
      return;
    }
    const messages = snapshots.filter((row): row is MaxChannelMessageSnapshot => row !== null);
    const signature = createHash('sha256')
      .update(messages.map((row) => `${row.messageId}:${row.publishedAt}`).join('|'))
      .digest('hex');
    const oldest = messages.reduce<Date | null>((current, row) => {
      const at = new Date(row.publishedAt);
      return !current || at < current ? at : current;
    }, null);
    if (
      rows.length >= 100 &&
      (!oldest ||
        signature === state.cursor_signature ||
        (state.cursor_at && oldest.getTime() >= state.cursor_at.getTime()))
    ) {
      await this.prisma.$executeRaw`UPDATE channel_view_archive_states SET stalled_at=${new Date()}
        WHERE chat_id=${chatId} AND last_attempt_at=${startedAt}`;
      return;
    }
    const observedAt = new Date();
    for (const snapshot of messages) {
      if (Date.now() >= deadline || (options.authorized && !(await options.authorized()))) return;
      await options.store(snapshot, observedAt);
    }
    if (options.authorized && !(await options.authorized())) return;
    const completed = rows.length < 100;
    await this.prisma.$executeRaw`UPDATE channel_view_archive_states SET
      cursor_at=${completed ? null : oldest},cursor_signature=${completed ? null : signature},
      discovered_from=CASE WHEN ${oldest}::timestamptz IS NULL THEN discovered_from ELSE LEAST(discovered_from,${oldest}) END,
      discovery_complete_at=CASE WHEN ${completed} THEN COALESCE(discovery_complete_at,${observedAt}) ELSE discovery_complete_at END,
      full_refresh_at=CASE WHEN ${completed} THEN ${observedAt} ELSE full_refresh_at END,
      last_success_at=${new Date()},stalled_at=NULL
      WHERE chat_id=${chatId} AND last_attempt_at=${startedAt}`;
  }

  async audience(
    chatId: string,
    entityType: ManagedEntityType,
    participantsCount: number | null,
    observedAt: Date,
    source: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    if (
      participantsCount === null ||
      !Number.isSafeInteger(participantsCount) ||
      participantsCount < 0 ||
      participantsCount > 2_147_483_647 ||
      !Number.isFinite(observedAt.getTime()) ||
      observedAt.getTime() > Date.now() + 30_000
    )
      return;
    await tx.$executeRaw`
      INSERT INTO managed_entity_audience_observations
        (chat_id, entity_type, participants_count, observed_at, source)
      VALUES (${chatId}, ${entityType === 'chat' ? 'CHAT' : 'CHANNEL'}::"ChatEntityType",
        ${participantsCount}, ${observedAt}, ${source})
      ON CONFLICT(chat_id, entity_type) DO UPDATE SET
        participants_count=EXCLUDED.participants_count, observed_at=EXCLUDED.observed_at,
        source=EXCLUDED.source
      WHERE managed_entity_audience_observations.observed_at < EXCLUDED.observed_at
    `;
  }

  // FLAG: Caller owns the existing collection lease and transaction. The parent row lock
  // serializes owners and protects retries even when an unchanged poll has no raw snapshot.
  async views(
    tx: Prisma.TransactionClient,
    postId: string,
    views: number | null,
    observedAt: Date,
    source: string,
  ): Promise<void> {
    if (
      views === null ||
      !Number.isSafeInteger(views) ||
      views < 0 ||
      views > 2_147_483_647 ||
      !Number.isFinite(observedAt.getTime()) ||
      observedAt.getTime() > Date.now() + 30_000
    )
      return;
    const parents = await tx.$queryRaw<Array<{ id: string; chat_id: string }>>`
      SELECT id,chat_id FROM channel_posts WHERE id=${postId} FOR UPDATE
    `;
    if (!parents.length) return;
    const rows = await tx.$queryRaw<ObservationStateRow[]>`
      SELECT baseline_at, observed_at, observed_views, high_water_views, anomaly_at
      FROM channel_view_observation_states WHERE channel_post_id=${postId}
    `;
    const row = rows[0];
    const previous: NetworkViewObservationState | null = row
      ? {
          baselineAt: row.baseline_at,
          observedAt: row.observed_at,
          observedViews: row.observed_views,
          highWaterViews: row.high_water_views,
          anomalyAt: row.anomaly_at,
        }
      : null;
    const transition = advanceNetworkViewObservation(previous, { observedAt, views });
    if (!transition) return;
    const next = transition.state;
    await tx.$executeRaw`
      INSERT INTO channel_view_archive_states(chat_id,observed_post_count,first_observed_at,last_observed_at)
      SELECT chat_id,${previous ? 0 : 1},${next.baselineAt},${next.observedAt} FROM channel_posts WHERE id=${postId}
      ON CONFLICT(chat_id) DO UPDATE SET
        observed_post_count=channel_view_archive_states.observed_post_count+EXCLUDED.observed_post_count,
        first_observed_at=LEAST(channel_view_archive_states.first_observed_at,EXCLUDED.first_observed_at),
        last_observed_at=GREATEST(channel_view_archive_states.last_observed_at,EXCLUDED.last_observed_at)
    `;
    await tx.$executeRaw`
      INSERT INTO channel_view_observation_states
        (channel_post_id,baseline_at,observed_at,observed_views,high_water_views,anomaly_at,source)
      VALUES (${postId},${next.baselineAt},${next.observedAt},${next.observedViews},
        ${next.highWaterViews},${next.anomalyAt},${source})
      ON CONFLICT(channel_post_id) DO UPDATE SET
        observed_at=EXCLUDED.observed_at,observed_views=EXCLUDED.observed_views,
        high_water_views=EXCLUDED.high_water_views,anomaly_at=EXCLUDED.anomaly_at,source=EXCLUDED.source
    `;
    const interval = transition.interval;
    if (interval)
      await tx.$executeRaw`
      INSERT INTO channel_view_observed_intervals
        (channel_post_id,chat_id,from_at,to_at,delta,quality,source)
      VALUES (${postId},${parents[0].chat_id},${interval.fromAt},${interval.toAt},${interval.delta},${interval.quality},${source})
      ON CONFLICT(channel_post_id,to_at) DO NOTHING
    `;
  }
}
