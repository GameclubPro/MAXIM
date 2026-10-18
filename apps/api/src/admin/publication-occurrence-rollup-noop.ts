import type { Logger } from '@nestjs/common';
import { Prisma, PublicationOccurrenceStatus } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { PublicationOccurrenceRollupNoopObserver } from './publication-occurrence-rollup-noop-observer';

export type PublicationOccurrenceRollupNoopRollout = 'off' | 'test' | '5' | '25' | '100';
export type PublicationOccurrenceRollupNoopSnapshot = {
  status: PublicationOccurrenceStatus;
  scheduledAt: Date;
  enrolled: boolean;
  hasSending: boolean;
  hasActivePending: boolean;
};

const TEST_CHAT_ID = '-78271094414679';
const TEST_CHANNEL_ID = '-78271171091799';
const MAX_TEST_AUDIENCE_JSON_BYTES = 256;

export function parsePublicationOccurrenceRollupNoopRollout(
  value: unknown,
): PublicationOccurrenceRollupNoopRollout {
  return value === 'test' || value === '5' || value === '25' || value === '100' ? value : 'off';
}

function buildTestEnrollment(): Prisma.Sql {
  // FLAG: Enroll this saved occurrence, including every linked envelope and unfiltered
  // recipient page. Current editable targets and other occurrences are not its audience.
  return Prisma.sql`(
    WITH rollup_envelope_page AS MATERIALIZED (
      SELECT envelope."id"
      FROM "managed_broadcasts" AS envelope
      WHERE envelope."publication_occurrence_id" = occurrence."id"
      LIMIT 3
    )
    SELECT CASE WHEN COUNT(*) BETWEEN 1 AND 2 THEN NOT EXISTS (
      SELECT 1
      FROM rollup_envelope_page AS envelope_id
      CROSS JOIN LATERAL (
        SELECT "id", "dispatch_profile", "required_bot_id", "publication_content_revision_id",
          "apply_to_all_chats", "target_chat_ids", "entity_type"
        FROM "managed_broadcasts"
        WHERE "id" = envelope_id."id"
        OFFSET 0
      ) AS saved
      WHERE (CASE WHEN saved."dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
        AND saved."required_bot_id" = occurrence."required_bot_id"
        AND saved."publication_content_revision_id" = occurrence."content_revision_id"
        AND saved."apply_to_all_chats" = FALSE
      THEN (
        CASE WHEN pg_column_compression(saved."target_chat_ids") IS NULL
          AND pg_column_size(saved."target_chat_ids") <= ${MAX_TEST_AUDIENCE_JSON_BYTES}
        THEN saved."target_chat_ids" = jsonb_build_array(CASE saved."entity_type"
          WHEN 'CHAT'::"ChatEntityType" THEN ${TEST_CHAT_ID}
          WHEN 'CHANNEL'::"ChatEntityType" THEN ${TEST_CHANNEL_ID}
        END)
        ELSE FALSE END
      ) AND (
        WITH rollup_recipient_keys AS MATERIALIZED (
          SELECT recipient_key."broadcast_id", recipient_key."occurrence_index",
            recipient_key."target_chat_id"
          FROM "managed_broadcast_deliveries" AS recipient_key
          WHERE recipient_key."broadcast_id" >= saved."id"
          ORDER BY recipient_key."broadcast_id", recipient_key."occurrence_index",
            recipient_key."target_chat_id"
          LIMIT 3
        ), rollup_recipient_page AS MATERIALIZED (
          SELECT recipient."target_chat_id", recipient."publication_occurrence_id",
            recipient."content_revision_id", recipient."required_bot_id", recipient."dispatch_profile"
          FROM rollup_recipient_keys AS candidate
          CROSS JOIN LATERAL (
            SELECT recipient_saved."broadcast_id", recipient_saved."occurrence_index",
              recipient_saved."target_chat_id", recipient_saved."publication_occurrence_id",
              recipient_saved."content_revision_id", recipient_saved."required_bot_id",
              recipient_saved."dispatch_profile"
            FROM "managed_broadcast_deliveries" AS recipient_saved
            WHERE ROW(recipient_saved."broadcast_id", recipient_saved."occurrence_index",
              recipient_saved."target_chat_id") >= ROW(candidate."broadcast_id",
                candidate."occurrence_index", candidate."target_chat_id")
            ORDER BY recipient_saved."broadcast_id", recipient_saved."occurrence_index",
              recipient_saved."target_chat_id"
            LIMIT 1
          ) AS recipient
          WHERE candidate."broadcast_id" = saved."id"
            AND recipient."broadcast_id" = candidate."broadcast_id"
            AND recipient."occurrence_index" = candidate."occurrence_index"
            AND recipient."target_chat_id" = candidate."target_chat_id"
        )
        SELECT COUNT(*) <= 2 AND COALESCE(BOOL_AND((
          recipient."target_chat_id" = CASE saved."entity_type"
            WHEN 'CHAT'::"ChatEntityType" THEN ${TEST_CHAT_ID}
            WHEN 'CHANNEL'::"ChatEntityType" THEN ${TEST_CHANNEL_ID}
          END
          AND recipient."publication_occurrence_id" = occurrence."id"
          AND recipient."content_revision_id" = occurrence."content_revision_id"
          AND recipient."required_bot_id" = occurrence."required_bot_id"
          AND recipient."dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
        ) IS TRUE), TRUE)
        FROM rollup_recipient_page AS recipient
      ) ELSE FALSE END) IS NOT TRUE
    ) ELSE FALSE END
    FROM rollup_envelope_page
  )`;
}

export function buildPublicationOccurrenceRollupNoopQuery(
  occurrenceId: string,
  rollout: Exclude<PublicationOccurrenceRollupNoopRollout, 'off'>,
): Prisma.Sql {
  const enrollment =
    rollout === 'test'
      ? buildTestEnrollment()
      : rollout === '100'
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
