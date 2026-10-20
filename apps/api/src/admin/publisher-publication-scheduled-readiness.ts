import { Prisma } from '../prisma/prisma-client';
import {
  PUBLISHER_EXPLICIT_RETRY_CODE,
  PUBLISHER_PUBLICATION_BLOCKED_RETRY_MS,
} from './publication-dispatch-issue';

export const PUBLISHER_SCHEDULED_READINESS_DELIVERY_LIMIT = 64;

export function buildPublisherScheduledRecipientPriorityHint(now: Date): Prisma.Sql {
  // FLAG: A positive bounded prefix is sufficient for send priority, including a large
  // or legacy audience. Unknown effects and due blockers retain the recovery reservation;
  // this hint grants no execution authority and never relaxes legacy actor fences.
  return Prisma.sql`CASE WHEN schedule."mode" = 'NOW'::"PublicationScheduleMode"
    THEN TRUE ELSE (
      schedule."publication_id" = publication."id"
      AND occurrence."required_bot_id" = broadcast."required_bot_id"
      AND publication."required_bot_id" = broadcast."required_bot_id"
      AND length(btrim(broadcast."required_bot_id")) > 0
      AND occurrence."scheduled_at" <= ${now} AND isfinite(occurrence."scheduled_at")
      AND (occurrence."delivery_deadline_at" IS NULL OR (
        occurrence."delivery_deadline_at" > ${now}
        AND isfinite(occurrence."delivery_deadline_at")
      ))
      AND EXISTS (
        SELECT 1 FROM (
          SELECT recipient."status", recipient."attempt_count", recipient."occurrence_index",
            recipient."publication_occurrence_id", recipient."content_revision_id",
            recipient."dispatch_profile", recipient."required_bot_id", recipient."bot_id",
            recipient."remote_message_id", recipient."sent_at", recipient."legacy_sent_without_remote_id",
            recipient."locked_at", recipient."lock_token", recipient."next_attempt_at",
            recipient."dispatch_blocker_code", recipient."dispatch_blocked_at",
            recipient."remote_message_verified_at", recipient."remote_message_verification_attempted_at",
            recipient."remote_message_verification_attempt_count",
            recipient."remote_message_verification_absent_count",
            recipient."remote_message_verification_present_count",
            recipient."remote_message_verification_next_at", recipient."remote_message_verification_source",
            (recipient."last_error_code" IS NULL) AS delivery_error_absent,
            (recipient."remote_message_verification_last_error" IS NULL) AS verification_error_absent
          FROM "managed_broadcast_deliveries" AS recipient
          WHERE recipient."broadcast_id" = broadcast."id"
            AND recipient."occurrence_index" = 1
            AND recipient."status" = 'PENDING'::"ManagedBroadcastDeliveryStatus"
          ORDER BY recipient."occurrence_index"
          LIMIT ${PUBLISHER_SCHEDULED_READINESS_DELIVERY_LIMIT} OFFSET 0
        ) AS ready_recipient
        WHERE ready_recipient."status" = 'PENDING'::"ManagedBroadcastDeliveryStatus"
          AND ready_recipient."attempt_count" = 0 AND ready_recipient."occurrence_index" = 1
          AND ready_recipient."publication_occurrence_id" = occurrence."id"
          AND ready_recipient."content_revision_id" = occurrence."content_revision_id"
          AND ready_recipient."dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
          AND ready_recipient."required_bot_id" = broadcast."required_bot_id"
          AND (ready_recipient."bot_id" IS NULL OR ready_recipient."bot_id" = broadcast."required_bot_id")
          AND ready_recipient."remote_message_id" IS NULL AND ready_recipient."sent_at" IS NULL
          AND ready_recipient."legacy_sent_without_remote_id" = FALSE
          AND ready_recipient."locked_at" IS NULL AND ready_recipient."lock_token" IS NULL
          AND ready_recipient."delivery_error_absent" = TRUE
          AND ready_recipient."dispatch_blocker_code" IS NULL AND ready_recipient."dispatch_blocked_at" IS NULL
          AND (ready_recipient."next_attempt_at" IS NULL OR (
            ready_recipient."next_attempt_at" <= ${now} AND isfinite(ready_recipient."next_attempt_at")
          ))
          AND ready_recipient."remote_message_verified_at" IS NULL
          AND ready_recipient."remote_message_verification_attempted_at" IS NULL
          AND ready_recipient."remote_message_verification_attempt_count" = 0
          AND ready_recipient."remote_message_verification_absent_count" = 0
          AND ready_recipient."remote_message_verification_present_count" = 0
          AND ready_recipient."remote_message_verification_next_at" IS NULL
          AND ready_recipient."remote_message_verification_source" IS NULL
          AND ready_recipient."verification_error_absent" = TRUE
      )
    ) END`;
}

export function buildPublisherScheduledRecipientReadyHint(now: Date): Prisma.Sql {
  const limit = PUBLISHER_SCHEDULED_READINESS_DELIVERY_LIMIT;
  const blockerRetryBefore = new Date(now.getTime() - PUBLISHER_PUBLICATION_BLOCKED_RETRY_MS);
  // FLAG: Only a complete small audience of untouched future waits may leave the send
  // lane. Unknown effects, legacy intent, expired deadlines and larger audiences keep
  // recovery eligibility. This hint grants no authority and changes no durable retry time.
  return Prisma.sql`CASE WHEN (
    schedule."mode" <> 'NOW'::"PublicationScheduleMode"
    AND schedule."publication_id" = publication."id"
    AND occurrence."required_bot_id" = broadcast."required_bot_id"
    AND publication."required_bot_id" = broadcast."required_bot_id"
    AND length(btrim(broadcast."required_bot_id")) > 0
    AND broadcast."cycle_enabled" = FALSE
    AND broadcast."cycle_count" = 1
    AND broadcast."sent_count" = 0
    AND broadcast."apply_to_all_chats" = FALSE
    AND broadcast."next_send_at" <= ${now}
    AND occurrence."scheduled_at" <= ${now}
    AND isfinite(occurrence."scheduled_at")
    AND occurrence."delivery_deadline_at" > ${now}
    AND occurrence."delivery_deadline_at" > occurrence."scheduled_at"
    AND isfinite(occurrence."delivery_deadline_at")
    AND occurrence."retry_authorized_at" IS NULL
    AND occurrence."retry_expires_at" IS NULL
    AND occurrence."dispatch_blocker_code" IS DISTINCT FROM ${PUBLISHER_EXPLICIT_RETRY_CODE}
    AND (
      (occurrence."dispatch_blocker_code" IS NULL AND occurrence."dispatch_blocked_at" IS NULL)
      OR (
        length(btrim(occurrence."dispatch_blocker_code")) > 0
        AND occurrence."dispatch_blocked_at" <= ${now}
        AND isfinite(occurrence."dispatch_blocked_at")
      )
    )
  ) THEN (
    WITH scheduled_delivery_keys AS MATERIALIZED (
      SELECT delivery_key."occurrence_index"
      FROM "managed_broadcast_deliveries" AS delivery_key
      WHERE delivery_key."broadcast_id" = broadcast."id"
      ORDER BY delivery_key."occurrence_index"
      LIMIT ${limit + 1} OFFSET 0
    )
    SELECT CASE WHEN COUNT(*) BETWEEN 1 AND ${limit}
      AND BOOL_AND("occurrence_index" = 1) THEN (
      WITH scheduled_delivery_page AS MATERIALIZED (
        SELECT delivery."target_chat_id", delivery."status", delivery."attempt_count",
          delivery."occurrence_index", delivery."publication_occurrence_id",
          delivery."content_revision_id", delivery."dispatch_profile", delivery."required_bot_id",
          delivery."bot_id", delivery."remote_message_id", delivery."sent_at",
          delivery."legacy_sent_without_remote_id", delivery."locked_at", delivery."lock_token",
          delivery."remote_message_verified_at", delivery."remote_message_verification_attempted_at",
          delivery."remote_message_verification_attempt_count",
          delivery."remote_message_verification_absent_count",
          delivery."remote_message_verification_present_count",
          delivery."remote_message_verification_next_at",
          (delivery."remote_message_verification_last_error" IS NULL) AS verification_error_absent,
          delivery."remote_message_verification_source",
          delivery."next_attempt_at", delivery."dispatch_blocker_code", delivery."dispatch_blocked_at",
          (delivery."last_error_code" IS NULL) AS delivery_error_absent
        FROM "managed_broadcast_deliveries" AS delivery
        WHERE delivery."broadcast_id" = broadcast."id"
        ORDER BY delivery."occurrence_index"
        LIMIT ${limit} OFFSET 0
      )
      SELECT CASE WHEN COUNT(*) = (SELECT COUNT(*) FROM scheduled_delivery_keys)
        -- FLAG: Check storage before expanding JSON. A complete delivery prefix alone
        -- does not prove that every saved recipient was materialized.
        AND (CASE WHEN pg_column_compression(broadcast."target_chat_ids") IS NULL
          AND pg_column_size(broadcast."target_chat_ids") <= 16384
        THEN CASE WHEN jsonb_typeof(broadcast."target_chat_ids") = 'array'
        THEN CASE WHEN jsonb_array_length(broadcast."target_chat_ids") BETWEEN 1 AND ${limit}
        THEN (
          WITH scheduled_saved_targets AS MATERIALIZED (
            SELECT element."value", element."value" #>> '{}' AS "target_chat_id"
            FROM jsonb_array_elements(broadcast."target_chat_ids") AS element("value")
          )
          SELECT COUNT(*) = (SELECT COUNT(*) FROM scheduled_delivery_page)
            AND COUNT(*) = COUNT(DISTINCT saved."target_chat_id")
            AND BOOL_AND(jsonb_typeof(saved."value") = 'string')
            AND NOT EXISTS (
              SELECT 1 FROM scheduled_saved_targets AS saved_target
              WHERE NOT EXISTS (
                SELECT 1 FROM scheduled_delivery_page AS actual
                WHERE actual."target_chat_id" = saved_target."target_chat_id"
              )
            )
          FROM scheduled_saved_targets AS saved
        ) ELSE FALSE END ELSE FALSE END ELSE FALSE END) IS TRUE
      THEN NOT COALESCE(BOOL_AND(COALESCE(
        waiting."status" = 'PENDING'::"ManagedBroadcastDeliveryStatus"
        AND waiting."attempt_count" = 0
        AND waiting."occurrence_index" = 1
        AND waiting."publication_occurrence_id" = occurrence."id"
        AND waiting."content_revision_id" = occurrence."content_revision_id"
        AND waiting."dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
        AND waiting."required_bot_id" = broadcast."required_bot_id"
        AND (waiting."bot_id" IS NULL OR waiting."bot_id" = broadcast."required_bot_id")
        AND waiting."remote_message_id" IS NULL
        AND waiting."sent_at" IS NULL
        AND waiting."legacy_sent_without_remote_id" = FALSE
        AND waiting."locked_at" IS NULL AND waiting."lock_token" IS NULL
        AND waiting."remote_message_verification_attempt_count" = 0
        AND waiting."remote_message_verification_attempted_at" IS NULL
        AND waiting."remote_message_verification_absent_count" = 0
        AND waiting."remote_message_verification_present_count" = 0
        AND waiting."remote_message_verified_at" IS NULL
        AND waiting."remote_message_verification_next_at" IS NULL
        AND waiting."verification_error_absent" = TRUE
        AND waiting."delivery_error_absent" = TRUE
        AND waiting."remote_message_verification_source" IS NULL
        AND (waiting."next_attempt_at" IS NULL OR isfinite(waiting."next_attempt_at"))
        AND (
          (waiting."dispatch_blocker_code" IS NULL AND waiting."dispatch_blocked_at" IS NULL)
          OR (
            length(btrim(waiting."dispatch_blocker_code")) > 0
            AND waiting."dispatch_blocked_at" <= ${now}
            AND isfinite(waiting."dispatch_blocked_at")
          )
        )
        AND (
          (waiting."next_attempt_at" > ${now} AND isfinite(waiting."next_attempt_at"))
          OR (
            length(btrim(waiting."dispatch_blocker_code")) > 0
            AND waiting."dispatch_blocked_at" > ${blockerRetryBefore}
            AND waiting."dispatch_blocked_at" <= ${now}
            AND isfinite(waiting."dispatch_blocked_at")
          )
        ), FALSE)), FALSE) ELSE TRUE END
      FROM scheduled_delivery_page AS waiting
    ) ELSE TRUE END
    FROM scheduled_delivery_keys
  ) ELSE TRUE END`;
}
