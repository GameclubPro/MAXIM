import { Prisma, type PublicationScheduleMode } from '../prisma/prisma-client';
import {
  PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE,
  PUBLISHER_PUBLICATION_BLOCKED_RETRY_MS,
} from './publication-dispatch-issue';
import { PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE } from './publication-delivery-verification-state';

function scheduleModesWhere(modes: readonly PublicationScheduleMode[]): Prisma.Sql {
  return modes.length
    ? Prisma.sql`schedule."mode" IN (${Prisma.join(
        modes.map((mode) => Prisma.sql`${mode}::"PublicationScheduleMode"`),
      )})`
    : Prisma.sql`FALSE`;
}

export function buildPublisherExecutionParentJoins(): Prisma.Sql {
  // FLAG: Preserve the due-broadcast stream before exact parent lookups. Without
  // these barriers, stale statistics can reverse the joins and repeatedly scan
  // the whole pending history while trying to avoid a recipient-wide sort.
  // Each lookup is unique; the executor still owns final dispatch authority.
  return Prisma.sql`
    INNER JOIN LATERAL (
      SELECT source."id", source."publication_id", source."schedule_id", source."dispatch_profile",
        source."status", source."content_revision_id", source."schedule_revision", source."required_bot_id",
        source."delivery_deadline_at", source."scheduled_at", source."retry_authorized_at",
        source."retry_expires_at", source."dispatch_blocker_code", source."dispatch_blocked_at"
      FROM "publication_occurrences" AS source
      WHERE source."id" = broadcast."publication_occurrence_id"
      LIMIT 1 OFFSET 0
    ) AS occurrence ON TRUE
    INNER JOIN LATERAL (
      SELECT source."id", source."publication_id", source."mode", source."status", source."revision"
      FROM "publication_schedules" AS source
      WHERE source."id" = occurrence."schedule_id"
      LIMIT 1 OFFSET 0
    ) AS schedule ON TRUE
    INNER JOIN LATERAL (
      SELECT source."id", source."actor_user_id", source."audience_mode", source."dispatch_profile",
        source."lifecycle", source."required_bot_id"
      FROM "publications" AS source
      WHERE source."id" = occurrence."publication_id"
      LIMIT 1 OFFSET 0
    ) AS publication ON TRUE
  `;
}

export function buildPublisherCurrentExecutionScope(): Prisma.Sql {
  // FLAG: A stale content envelope only releases its lease at execution. Reject it before
  // LIMIT so it cannot indefinitely occupy the send budget; recovery keeps its own lanes.
  // These are eligibility hints, not authority: the executor rechecks after its lease CAS.
  return Prisma.sql`
    occurrence."dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
    AND occurrence."status" IN (
      'SCHEDULED'::"PublicationOccurrenceStatus", 'IN_PROGRESS'::"PublicationOccurrenceStatus"
    )
    AND occurrence."content_revision_id" IS NOT DISTINCT FROM broadcast."publication_content_revision_id"
    AND occurrence."schedule_revision" = schedule."revision"
    AND schedule."status" = 'ACTIVE'::"PublicationScheduleStatus"
    AND publication."lifecycle" = 'ACTIVE'::"PublicationLifecycle"
  `;
}

function buildPublisherFreshDeliveryExists(staleLockBefore: Date): Prisma.Sql {
  // FLAG: EXISTS is order-independent. The retained OFFSET and occurrence-prefix order
  // give its LIMIT a streaming index path instead of preloading a large audience bitmap.
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "managed_broadcast_deliveries" AS fresh_delivery
    WHERE fresh_delivery."broadcast_id" = broadcast."id"
      AND fresh_delivery."status" = 'SENDING'::"ManagedBroadcastDeliveryStatus"
      AND fresh_delivery."locked_at" >= ${staleLockBefore}
    ORDER BY fresh_delivery."occurrence_index"
    LIMIT 1 OFFSET 0
  )`;
}

export function buildPublisherExecutionDeliveryPredicate(staleLockBefore: Date): Prisma.Sql {
  return Prisma.sql`
    EXISTS (
      SELECT 1 FROM "managed_broadcast_deliveries" AS execution_delivery
      WHERE execution_delivery."broadcast_id" = broadcast."id"
        AND execution_delivery."status" IN (
          'PENDING'::"ManagedBroadcastDeliveryStatus", 'SENDING'::"ManagedBroadcastDeliveryStatus"
        )
      ORDER BY execution_delivery."occurrence_index"
      LIMIT 1 OFFSET 0
    )
    AND NOT ${buildPublisherFreshDeliveryExists(staleLockBefore)}
  `;
}

export function buildPublisherExecutionDueQuery(options: {
  now: Date;
  staleLockBefore: Date;
  scheduleModes: readonly PublicationScheduleMode[];
  limit: number;
}): Prisma.Sql {
  return Prisma.sql`
    SELECT broadcast."id"
    FROM "managed_broadcasts" AS broadcast
    ${buildPublisherExecutionParentJoins()}
    WHERE broadcast."dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
      AND broadcast."status" = 'ACTIVE'::"ManagedBroadcastStatus"
      AND broadcast."next_send_at" <= ${options.now}
      AND (broadcast."locked_at" IS NULL OR broadcast."locked_at" < ${options.staleLockBefore})
      AND ${scheduleModesWhere(options.scheduleModes)}
      AND ${buildPublisherCurrentExecutionScope()}
      -- FLAG: The CASE keeps probes after all current-parent joins; OFFSET 0 prevents
      -- recipient-wide semi/anti plans. Correlation alone can probe every stale parent.
      AND CASE WHEN (${buildPublisherCurrentExecutionScope()}) THEN (
        ${buildPublisherExecutionDeliveryPredicate(options.staleLockBefore)}
      ) ELSE FALSE END
    ORDER BY broadcast."next_send_at" ASC, broadcast."created_at" ASC, broadcast."id" ASC
    LIMIT ${options.limit}
  `;
}

export function buildPublisherPendingExecutionDeadlineQuery(options: {
  now: Date;
  staleLockBefore: Date;
  scheduleModes: readonly PublicationScheduleMode[];
}): Prisma.Sql {
  const blockedRetryBefore = new Date(
    options.now.getTime() - PUBLISHER_PUBLICATION_BLOCKED_RETRY_MS,
  );
  // FLAG: Wake only current executable envelopes. A retained mismatch must not arm the
  // 250ms overdue timer forever; its receipts and cleanup remain on the recovery poll.
  // FLAG: Keep profile/blocker filters outside the per-broadcast barrier so stale stats
  // cannot choose a global dispatch-status scan. Status stays inside for a large audience.
  return Prisma.sql`
    SELECT broadcast."id", broadcast."next_send_at" AS "nextSendAt"
    FROM "managed_broadcasts" AS broadcast
    ${buildPublisherExecutionParentJoins()}
    WHERE broadcast."dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
      AND broadcast."status" = 'ACTIVE'::"ManagedBroadcastStatus"
      AND broadcast."next_send_at" IS NOT NULL AND broadcast."locked_at" IS NULL
      AND ${scheduleModesWhere(options.scheduleModes)}
      AND ${buildPublisherCurrentExecutionScope()}
      AND CASE WHEN (${buildPublisherCurrentExecutionScope()}) THEN (
        (
          EXISTS (
            SELECT 1 FROM (
              SELECT pending_delivery_source."status", pending_delivery_source."dispatch_profile",
                pending_delivery_source."last_error_code", pending_delivery_source."dispatch_blocker_code",
                pending_delivery_source."dispatch_blocked_at"
              FROM "managed_broadcast_deliveries" AS pending_delivery_source
              WHERE pending_delivery_source."broadcast_id" = broadcast."id"
                AND pending_delivery_source."status" = 'PENDING'::"ManagedBroadcastDeliveryStatus"
              ORDER BY pending_delivery_source."occurrence_index"
              OFFSET 0
            ) AS pending_delivery
            WHERE pending_delivery."dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
              AND pending_delivery."last_error_code" IS DISTINCT FROM ${PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE}
              AND (
                pending_delivery."dispatch_blocker_code" IS NULL
                OR (
                  pending_delivery."dispatch_blocker_code" = ${PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE}
                  AND pending_delivery."dispatch_blocked_at" <= ${blockedRetryBefore}
                )
              )
            LIMIT 1 OFFSET 0
          )
          OR EXISTS (
            SELECT 1 FROM (
              SELECT stale_delivery_source."status", stale_delivery_source."dispatch_profile", stale_delivery_source."locked_at"
              FROM "managed_broadcast_deliveries" AS stale_delivery_source
              WHERE stale_delivery_source."broadcast_id" = broadcast."id"
                AND stale_delivery_source."status" = 'SENDING'::"ManagedBroadcastDeliveryStatus"
              ORDER BY stale_delivery_source."occurrence_index"
              OFFSET 0
            ) AS stale_delivery
            WHERE stale_delivery."dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
              AND (stale_delivery."locked_at" IS NULL OR stale_delivery."locked_at" < ${options.staleLockBefore})
            LIMIT 1 OFFSET 0
          )
        )
        AND NOT ${buildPublisherFreshDeliveryExists(options.staleLockBefore)}
      ) ELSE FALSE END
    ORDER BY broadcast."next_send_at" ASC, broadcast."created_at" ASC, broadcast."id" ASC
    LIMIT 1
  `;
}
