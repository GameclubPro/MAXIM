import type { Logger } from '@nestjs/common';
import { Prisma, PublicationOccurrenceStatus } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { PublicationOccurrenceRollupNoopObserver } from './publication-occurrence-rollup-noop-observer';

export type PublicationOccurrenceRollupNoopRollout = 'off' | 'test' | '5' | '25' | '100';
export type PublicationOccurrenceRollupNoopQueryRollout = Exclude<
  PublicationOccurrenceRollupNoopRollout,
  'off' | 'test'
>;
export type PublicationOccurrenceRollupNoopSnapshot = {
  status: PublicationOccurrenceStatus;
  scheduledAt: Date;
  enrolled: boolean;
  hasSending: boolean;
  hasActivePending: boolean;
};

export function parsePublicationOccurrenceRollupNoopRollout(
  value: unknown,
): PublicationOccurrenceRollupNoopRollout {
  return value === 'test' || value === '5' || value === '25' || value === '100' ? value : 'off';
}

export function buildPublicationOccurrenceRollupNoopQuery(
  occurrenceId: string,
  rollout: PublicationOccurrenceRollupNoopQueryRollout,
): Prisma.Sql {
  if (rollout !== '5' && rollout !== '25' && rollout !== '100') {
    throw new TypeError('Unsupported publication occurrence rollup query mode');
  }
  const enrollment =
    rollout === '100'
      ? Prisma.sql`TRUE`
      : Prisma.sql`(
            ('x' || substr(md5(
              'publisher-occurrence-rollup-noop-v1:'
              || octet_length(publication."required_bot_id")::text || ':'
              || publication."required_bot_id" || ':'
              || octet_length(publication."id")::text || ':' || publication."id"
            ), 1, 8))::bit(32)::bigint % 100
          ) < ${rollout === '5' ? 5 : 25}`;

  // FLAG: One statement proves only a sufficient unchanged-status condition. Use the
  // real envelope relation and index-1 PENDING/SENDING witness, never the legacy pointer.
  // Numeric cohorts do not inspect audience JSON or scan recipient/history pages.
  // Refuse the shortcut when occurrence statistics are unknown or empty. Keep the
  // first seek inside CASE and filter its null result before reading metadata.
  // A positive estimate admits the probe; it does not prove bounded physical work.
  // Native plan checks must cover both occurrence seeks: ORDER/LIMIT alone cannot
  // exclude a non-leading index scan under stale statistics. Check exact IDs after
  // the limits; a neighboring occurrence proves nothing. Seek the first composite
  // key at/after the witness, then check exact identity after LIMIT. Scalar status
  // filters or unordered tuple windows can scan history under skewed/stale statistics.
  // Read linked envelopes before ACTIVE filtering for the same reason; their existing
  // occurrence/entity unique key bounds this materialized set to at most two rows.
  return Prisma.sql`
    WITH rollup_scope AS MATERIALIZED (
      WITH rollup_occurrence_admission AS MATERIALIZED (
        SELECT CASE WHEN (
          SELECT reltuples > 0
          FROM pg_catalog.pg_class
          WHERE oid = 'publication_occurrences'::regclass
        ) THEN (
          SELECT "id" FROM "publication_occurrences"
          WHERE "id" >= ${occurrenceId}
          ORDER BY "id"
          LIMIT 1
        ) ELSE NULL END AS "id"
      ), rollup_occurrence_key AS MATERIALIZED (
        SELECT "id" FROM rollup_occurrence_admission
        WHERE "id" IS NOT NULL
      ), rollup_occurrence AS MATERIALIZED (
        SELECT occurrence."id", occurrence."publication_id", occurrence."status",
          occurrence."scheduled_at", occurrence."required_bot_id",
          occurrence."dispatch_profile", occurrence."content_revision_id"
        FROM rollup_occurrence_key AS candidate
        CROSS JOIN LATERAL (
          SELECT "id", "publication_id", "status", "scheduled_at", "required_bot_id",
            "dispatch_profile", "content_revision_id"
          FROM "publication_occurrences"
          WHERE "id" >= candidate."id"
          ORDER BY "id"
          LIMIT 1
        ) AS occurrence
        WHERE occurrence."id" = candidate."id"
      )
      SELECT occurrence."id", occurrence."status", occurrence."scheduled_at" AS "scheduledAt",
        CASE WHEN publication."dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
          AND publication."audience_mode" = 'SNAPSHOT'::"PublicationAudienceMode"
          AND publication."required_bot_id" = occurrence."required_bot_id"
          AND length(btrim(publication."required_bot_id")) > 0
        THEN (${enrollment}) IS TRUE ELSE FALSE END AS "enrolled"
      FROM rollup_occurrence AS occurrence
      INNER JOIN "publications" AS publication ON publication."id" = occurrence."publication_id"
      WHERE occurrence."id" = ${occurrenceId}
        AND occurrence."dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
        AND occurrence."status" IN (
          'SCHEDULED'::"PublicationOccurrenceStatus", 'IN_PROGRESS'::"PublicationOccurrenceStatus"
        )
    ), rollup_linked_envelopes AS MATERIALIZED (
      SELECT envelope."id", envelope."status"
      FROM "managed_broadcasts" AS envelope
      WHERE envelope."publication_occurrence_id" = (
        SELECT "id" FROM rollup_scope WHERE "enrolled"
      )
    )
    SELECT scope."status", scope."scheduledAt", scope."enrolled",
      CASE WHEN scope."enrolled" THEN EXISTS (
        SELECT 1 FROM rollup_linked_envelopes AS envelope
        WHERE EXISTS (
            WITH rollup_delivery_probe AS MATERIALIZED (
              SELECT delivery."broadcast_id", delivery."occurrence_index", delivery."status"
              FROM "managed_broadcast_deliveries" AS delivery
              WHERE ROW(delivery."broadcast_id", delivery."occurrence_index", delivery."status")
                >= ROW(envelope."id", 1, 'SENDING'::"ManagedBroadcastDeliveryStatus")
              ORDER BY delivery."broadcast_id", delivery."occurrence_index", delivery."status"
              LIMIT 1
            )
            SELECT 1 FROM rollup_delivery_probe AS candidate
            WHERE candidate."broadcast_id" = envelope."id"
              AND candidate."occurrence_index" = 1
              AND candidate."status" = 'SENDING'::"ManagedBroadcastDeliveryStatus"
          )
      ) ELSE FALSE END AS "hasSending",
      CASE WHEN scope."enrolled" THEN EXISTS (
        SELECT 1 FROM rollup_linked_envelopes AS envelope
        WHERE envelope."status" = 'ACTIVE'::"ManagedBroadcastStatus"
          AND EXISTS (
            WITH rollup_delivery_probe AS MATERIALIZED (
              SELECT delivery."broadcast_id", delivery."occurrence_index", delivery."status"
              FROM "managed_broadcast_deliveries" AS delivery
              WHERE ROW(delivery."broadcast_id", delivery."occurrence_index", delivery."status")
                >= ROW(envelope."id", 1, 'PENDING'::"ManagedBroadcastDeliveryStatus")
              ORDER BY delivery."broadcast_id", delivery."occurrence_index", delivery."status"
              LIMIT 1
            )
            SELECT 1 FROM rollup_delivery_probe AS candidate
            WHERE candidate."broadcast_id" = envelope."id"
              AND candidate."occurrence_index" = 1
              AND candidate."status" = 'PENDING'::"ManagedBroadcastDeliveryStatus"
          )
      ) ELSE FALSE END AS "hasActivePending"
    FROM rollup_scope AS scope
  `;
}

export function isUnchangedPublicationOccurrenceRollup(
  snapshot: PublicationOccurrenceRollupNoopSnapshot | null | undefined,
  decisionNow: Date,
): boolean {
  if (
    snapshot?.enrolled !== true ||
    (snapshot.hasSending !== true && snapshot.hasActivePending !== true) ||
    !Number.isFinite(snapshot.scheduledAt.getTime()) ||
    !Number.isFinite(decisionNow.getTime())
  ) {
    return false;
  }
  const expected =
    snapshot.scheduledAt > decisionNow
      ? PublicationOccurrenceStatus.SCHEDULED
      : PublicationOccurrenceStatus.IN_PROGRESS;
  return snapshot.status === expected;
}

export class PublicationOccurrenceRollupNoopReader {
  private readonly observer: PublicationOccurrenceRollupNoopObserver;

  constructor(
    private readonly prisma: Pick<PrismaService, '$queryRaw'>,
    private readonly rollout: PublicationOccurrenceRollupNoopRollout,
    logger: Pick<Logger, 'log'>,
  ) {
    this.observer = new PublicationOccurrenceRollupNoopObserver(logger);
  }

  async canSkip(occurrenceId: string): Promise<boolean> {
    if (this.rollout === 'off') return false;
    // FLAG: Test enrollment has no accepted bounded recipient plan. Decline before
    // any SQL so the caller executes the canonical full rollup, including uncertainty.
    if (this.rollout === 'test') {
      this.observer.record(this.rollout, false, 'fallback');
      return false;
    }
    try {
      const rows = await this.prisma.$queryRaw<PublicationOccurrenceRollupNoopSnapshot[]>(
        buildPublicationOccurrenceRollupNoopQuery(occurrenceId, this.rollout),
      );
      // FLAG: Sample after the SQL await. A slot can become due while this reader waits;
      // transaction-start time or a cached pre-query clock cannot prove an unchanged status.
      const decisionNow = new Date();
      const snapshot = rows.length === 1 ? rows[0] : undefined;
      const unchanged = isUnchangedPublicationOccurrenceRollup(snapshot, decisionNow);
      this.observer.record(
        this.rollout,
        snapshot?.enrolled === true,
        unchanged ? 'unchanged' : 'fallback',
      );
      return unchanged;
    } catch (error) {
      this.observer.record(this.rollout, false, 'error');
      throw error;
    }
  }
}
