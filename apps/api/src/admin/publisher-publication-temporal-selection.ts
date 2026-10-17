import {
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  Prisma,
  PublicationAudienceMode,
  PublicationDispatchProfile,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleMode,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import {
  PUBLISHER_EXPLICIT_RETRY_CODE,
  PUBLISHER_PUBLICATION_BLOCKED_RETRY_MS,
} from './publication-dispatch-issue';

export const PUBLISHER_TEMPORAL_PARENT_LOOKAHEAD = 64;
const PUBLISHER_TEMPORAL_DELIVERY_LIMIT = 64;

export type PublisherTemporalCandidate = {
  id: string;
  state: 'unsupported' | 'refused' | 'enrolled_kept' | 'excluded_waiting';
};

export type PublisherTemporalSelectionObservation = {
  candidates: number;
  unsupported: number;
  refused: number;
  enrolled: number;
  excludedWaiting: number;
  preferredReturned: number;
  fallbackReintroduced: number;
  comparisonBatches: number;
  changedDecisionBatches: number;
  changedPositions: number;
  newlySelected: number;
  displaced: number;
};

export type PublisherTemporalExecutionDueQueryOptions = {
  now: Date;
  staleLockBefore: Date;
  scheduleModes: readonly PublicationScheduleMode[];
  // FLAG: Enrollment must prove the stable whole-publication cohort and complete saved
  // audience materialization. It runs only for a complete delivery page of 1..64 rows.
  // Use temporal_delivery_page for coverage; broadcast, occurrence, publication and schedule
  // retain their original table aliases. JSON safety/size checks belong to this predicate.
  enrollment: Prisma.Sql;
};

export function buildPublisherTemporalExecutionDueQuery({
  now,
  staleLockBefore,
  scheduleModes,
  enrollment,
}: PublisherTemporalExecutionDueQueryOptions): Prisma.Sql {
  const blockerRetryBefore = new Date(now.getTime() - PUBLISHER_PUBLICATION_BLOCKED_RETRY_MS);
  const scheduleModeWhere = scheduleModes.length
    ? Prisma.sql`schedule."mode" IN (${Prisma.join(
        scheduleModes.map((mode) => Prisma.sql`${mode}::"PublicationScheduleMode"`),
      )})`
    : Prisma.sql`FALSE`;

  const supportedScope = Prisma.sql`
    schedule."mode" = ${PublicationScheduleMode.NOW}::"PublicationScheduleMode"
    AND publication."lifecycle" = ${PublicationLifecycle.ACTIVE}::"PublicationLifecycle"
    AND publication."audience_mode" = ${PublicationAudienceMode.SNAPSHOT}::"PublicationAudienceMode"
    AND publication."dispatch_profile" = ${PublicationDispatchProfile.PUBLIK_V1}::"PublicationDispatchProfile"
    AND schedule."status" = ${PublicationScheduleStatus.ACTIVE}::"PublicationScheduleStatus"
    AND schedule."publication_id" = publication."id"
    AND occurrence."dispatch_profile" = ${PublicationDispatchProfile.PUBLIK_V1}::"PublicationDispatchProfile"
    AND occurrence."status" IN (
      ${PublicationOccurrenceStatus.SCHEDULED}::"PublicationOccurrenceStatus",
      ${PublicationOccurrenceStatus.IN_PROGRESS}::"PublicationOccurrenceStatus"
    )
    AND occurrence."schedule_revision" = schedule."revision"
    AND occurrence."schedule_revision" > 0
    AND occurrence."content_revision_id" = broadcast."publication_content_revision_id"
    AND occurrence."required_bot_id" = broadcast."required_bot_id"
    AND publication."required_bot_id" = broadcast."required_bot_id"
    AND length(btrim(broadcast."required_bot_id")) > 0
    AND publication."actor_user_id" = broadcast."actor_user_id"
    AND broadcast."cycle_enabled" = FALSE
    AND broadcast."cycle_count" = 1
    AND broadcast."sent_count" = 0
    AND occurrence."delivery_deadline_at" > ${now}
    AND isfinite(occurrence."delivery_deadline_at")
    AND occurrence."delivery_deadline_at" > occurrence."scheduled_at"
    AND occurrence."scheduled_at" <= ${now}
    AND isfinite(occurrence."scheduled_at")
    AND occurrence."retry_authorized_at" IS NULL
    AND occurrence."retry_expires_at" IS NULL
    AND occurrence."dispatch_blocker_code" IS DISTINCT FROM ${PUBLISHER_EXPLICIT_RETRY_CODE}
    AND (
      (occurrence."dispatch_blocker_code" IS NULL AND occurrence."dispatch_blocked_at" IS NULL)
      OR (
        length(btrim(occurrence."dispatch_blocker_code")) > 0
        AND occurrence."dispatch_blocked_at" IS NOT NULL
        AND isfinite(occurrence."dispatch_blocked_at")
        AND occurrence."dispatch_blocked_at" <= ${now}
      )
    )
  `;
  const waitingDeliveryProof = Prisma.sql`
    waiting_delivery."occurrence_index" = 1
    AND waiting_delivery."publication_occurrence_id" = occurrence."id"
    AND waiting_delivery."content_revision_id" = occurrence."content_revision_id"
    AND waiting_delivery."dispatch_profile" = ${PublicationDispatchProfile.PUBLIK_V1}::"PublicationDispatchProfile"
    AND waiting_delivery."required_bot_id" = broadcast."required_bot_id"
    AND (
      waiting_delivery."bot_id" IS NULL
      OR waiting_delivery."bot_id" = broadcast."required_bot_id"
    )
    AND waiting_delivery."remote_message_id" IS NULL
    AND waiting_delivery."legacy_sent_without_remote_id" = FALSE
    AND waiting_delivery."sent_at" IS NULL
    AND waiting_delivery."remote_message_verified_at" IS NULL
    AND waiting_delivery."remote_message_verification_attempted_at" IS NULL
    AND waiting_delivery."remote_message_verification_attempt_count" = 0
    AND waiting_delivery."remote_message_verification_absent_count" = 0
    AND waiting_delivery."remote_message_verification_present_count" = 0
    AND waiting_delivery."remote_message_verification_next_at" IS NULL
    AND waiting_delivery."verification_error_absent" = TRUE
    AND waiting_delivery."remote_message_verification_source" IS NULL
    AND (
      waiting_delivery."next_attempt_at" IS NULL
      OR isfinite(waiting_delivery."next_attempt_at")
    )
    AND (
      (waiting_delivery."dispatch_blocker_code" IS NULL AND waiting_delivery."dispatch_blocked_at" IS NULL)
      OR (
        length(btrim(waiting_delivery."dispatch_blocker_code")) > 0
        AND waiting_delivery."dispatch_blocked_at" IS NOT NULL
        AND isfinite(waiting_delivery."dispatch_blocked_at")
        AND waiting_delivery."dispatch_blocked_at" <= ${now}
      )
    )
    AND (
      (
        waiting_delivery."status" = ${ManagedBroadcastDeliveryStatus.PENDING}::"ManagedBroadcastDeliveryStatus"
        AND waiting_delivery."attempt_count" = 0
        AND waiting_delivery."locked_at" IS NULL
        AND waiting_delivery."lock_token" IS NULL
        AND (
          waiting_delivery."next_attempt_at" > ${now}
          OR (
            waiting_delivery."dispatch_blocker_code" IS NOT NULL
            AND waiting_delivery."dispatch_blocked_at" > ${blockerRetryBefore}
          )
        )
      )
      OR (
        waiting_delivery."status" = ${ManagedBroadcastDeliveryStatus.SENDING}::"ManagedBroadcastDeliveryStatus"
        AND waiting_delivery."attempt_count" > 0
        AND waiting_delivery."locked_at" >= ${staleLockBefore}
        AND isfinite(waiting_delivery."locked_at")
        AND waiting_delivery."locked_at" <= ${now}
        AND length(btrim(waiting_delivery."lock_token")) > 0
      )
    )
  `;

  // FLAG: Page the existing execution candidates before temporal/cohort/audience probes.
  // This is a fixed head lookahead, not traversal: waiting work beyond the first 64 keeps
  // the existing fallback behavior. No cursor changes compatible publication ordering.
  // The old PENDING/SENDING existence probe still requires native retained-history plans.
  // FLAG: A covering occurrence-prefix index supplies only occurrence_index before the
  // 65th-row sentinel gate. Do not add target/id fields or target ordering here: those
  // can force a full scan or sort. A complete page proves the entire parent has at most
  // 64 deliveries in this statement's snapshot before any wider fields are read.
  // Return the complete bounded classification once: selection and exposure counters share
  // this snapshot. Callers apply their send budget without another eligibility scan.
  return Prisma.sql`
    WITH raw_execution_candidates AS MATERIALIZED (
      SELECT broadcast."id", broadcast."next_send_at", broadcast."created_at"
      FROM "managed_broadcasts" AS broadcast
      INNER JOIN "publication_occurrences" AS occurrence
        ON occurrence."id" = broadcast."publication_occurrence_id"
      INNER JOIN "publication_schedules" AS schedule
        ON schedule."id" = occurrence."schedule_id"
      WHERE broadcast."dispatch_profile" = ${PublicationDispatchProfile.PUBLIK_V1}::"PublicationDispatchProfile"
        AND broadcast."status" = ${ManagedBroadcastStatus.ACTIVE}::"ManagedBroadcastStatus"
        AND broadcast."next_send_at" <= ${now}
        AND (broadcast."locked_at" IS NULL OR broadcast."locked_at" < ${staleLockBefore})
        AND ${scheduleModeWhere}
        AND EXISTS (
          SELECT 1
          FROM "managed_broadcast_deliveries" AS execution_delivery
          WHERE execution_delivery."broadcast_id" = broadcast."id"
            AND execution_delivery."status" IN (
              ${ManagedBroadcastDeliveryStatus.PENDING}::"ManagedBroadcastDeliveryStatus",
              ${ManagedBroadcastDeliveryStatus.SENDING}::"ManagedBroadcastDeliveryStatus"
            )
        )
      ORDER BY broadcast."next_send_at" ASC, broadcast."created_at" ASC, broadcast."id" ASC
      LIMIT ${PUBLISHER_TEMPORAL_PARENT_LOOKAHEAD}
    )
    SELECT broadcast."id", CASE WHEN (${supportedScope}) IS TRUE THEN (
      WITH temporal_delivery_keys AS MATERIALIZED (
        SELECT delivery_key_source."occurrence_index"
        FROM "managed_broadcast_deliveries" AS delivery_key_source
        WHERE delivery_key_source."broadcast_id" = broadcast."id"
        ORDER BY delivery_key_source."occurrence_index"
        LIMIT ${PUBLISHER_TEMPORAL_DELIVERY_LIMIT + 1}
      )
      SELECT CASE
        WHEN COUNT(*) BETWEEN 1 AND ${PUBLISHER_TEMPORAL_DELIVERY_LIMIT}
          AND BOOL_AND("occurrence_index" = 1) THEN (
          WITH temporal_delivery_page AS MATERIALIZED (
            SELECT
                delivery."id", delivery."broadcast_id", delivery."occurrence_index",
                delivery."target_chat_id", delivery."status", delivery."attempt_count",
                delivery."next_attempt_at", delivery."locked_at", delivery."lock_token",
                delivery."publication_occurrence_id", delivery."content_revision_id",
                delivery."dispatch_profile", delivery."required_bot_id", delivery."bot_id",
                delivery."remote_message_id", delivery."legacy_sent_without_remote_id",
                delivery."sent_at", delivery."remote_message_verified_at",
                delivery."remote_message_verification_attempted_at",
                delivery."remote_message_verification_attempt_count",
                delivery."remote_message_verification_absent_count",
                delivery."remote_message_verification_present_count",
                delivery."remote_message_verification_next_at",
                (delivery."remote_message_verification_last_error" IS NULL) AS verification_error_absent,
                delivery."remote_message_verification_source",
                delivery."dispatch_blocker_code", delivery."dispatch_blocked_at"
            FROM "managed_broadcast_deliveries" AS delivery
            WHERE delivery."broadcast_id" = broadcast."id"
            ORDER BY delivery."occurrence_index"
            LIMIT ${PUBLISHER_TEMPORAL_DELIVERY_LIMIT}
          )
          SELECT CASE
            WHEN COUNT(*) <> (SELECT COUNT(*) FROM temporal_delivery_keys) THEN 'refused'
            WHEN (${enrollment}) IS TRUE
              THEN CASE WHEN COALESCE(BOOL_AND((${waitingDeliveryProof}) IS TRUE), FALSE)
                THEN 'excluded_waiting' ELSE 'enrolled_kept' END
              ELSE 'refused'
            END
          FROM temporal_delivery_page AS waiting_delivery
        )
        ELSE 'refused'
      END
      FROM temporal_delivery_keys
    ) ELSE 'unsupported' END AS state
    FROM raw_execution_candidates AS candidate
    INNER JOIN "managed_broadcasts" AS broadcast ON broadcast."id" = candidate."id"
    INNER JOIN "publication_occurrences" AS occurrence
      ON occurrence."id" = broadcast."publication_occurrence_id"
    INNER JOIN "publication_schedules" AS schedule
      ON schedule."id" = occurrence."schedule_id"
    INNER JOIN "publications" AS publication
      ON publication."id" = occurrence."publication_id"
    ORDER BY candidate."next_send_at" ASC, candidate."created_at" ASC, candidate."id" ASC
  `;
}
