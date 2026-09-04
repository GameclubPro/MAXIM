import {
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  Prisma,
  PublicationDispatchProfile,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleMode,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE } from '../max/max-send-route-health';
import { buildManagedBroadcastAutoRetryableFailureWhere } from './admin-managed-broadcast-reconciliation';
import {
  buildPublicationDeliveryAutomatedVerificationWhere,
  buildPublicationDeliveryUnenrolledVerificationWhere,
  PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
} from './publication-delivery-verification-state';
import {
  MANAGED_BROADCAST_AUTO_RETRY_BACKOFF_MS,
  MANAGED_BROADCAST_DUE_BATCH_SIZE,
  MANAGED_BROADCAST_DUE_SLOW_BATCH_SIZE,
  MANAGED_BROADCAST_LOCK_STALE_MS,
  MANAGED_BROADCAST_MAX_AUTO_RETRY_ATTEMPTS,
  MANAGED_BROADCAST_RECOVERY_BATCH_SIZE,
  MANAGED_BROADCAST_RECOVERY_SLOW_BATCH_SIZE,
  PUBLICATION_HALF_OPEN_VERIFICATION_BATCH_SIZE,
  PUBLICATION_POST_SEND_VERIFY_DELAY_MS,
} from './admin.service.support';

type DueManagedBroadcastRow = { id: string };
type PriorityHalfOpenPublicationVerificationRow = DueManagedBroadcastRow & {
  deliveryId: string;
};

export type TargetedPublisherImmediatePublicationScope = {
  publicationId: string;
  occurrenceId?: string;
};

export function selectTargetedPublisherImmediatePublicationBroadcastBatch(
  prisma: Pick<PrismaService, 'managedBroadcast'>,
  scope: TargetedPublisherImmediatePublicationScope,
): Promise<{ dueRows: DueManagedBroadcastRow[]; staleLockBefore: Date }> {
  return selectTargetedPublisherPublicationBroadcastBatch(prisma, scope, [
    PublicationScheduleMode.NOW,
  ]);
}

export async function selectTargetedPublisherPublicationBroadcastBatch(
  prisma: Pick<PrismaService, 'managedBroadcast'>,
  scope: TargetedPublisherImmediatePublicationScope,
  scheduleModes: readonly PublicationScheduleMode[],
): Promise<{ dueRows: DueManagedBroadcastRow[]; staleLockBefore: Date }> {
  const publicationId = scope.publicationId.trim();
  const occurrenceId = scope.occurrenceId?.trim();
  if (!publicationId) {
    throw new Error('Targeted Publisher publication wake requires a publication id');
  }

  const now = new Date();
  const staleLockBefore = new Date(now.getTime() - MANAGED_BROADCAST_LOCK_STALE_MS);
  // FLAG: The wake queue may bypass an older global NOW backlog, but it may claim only the exact
  // active PUBLIK execution. The runtime rechecks revision/lifecycle state after its lease CAS.
  const dueRows = await prisma.managedBroadcast.findMany({
    where: {
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      status: ManagedBroadcastStatus.ACTIVE,
      nextSendAt: { lte: now },
      OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
      publicationOccurrence: {
        is: {
          ...(occurrenceId ? { id: occurrenceId } : {}),
          publicationId,
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          status: {
            in: [PublicationOccurrenceStatus.SCHEDULED, PublicationOccurrenceStatus.IN_PROGRESS],
          },
          publication: {
            is: {
              id: publicationId,
              lifecycle: PublicationLifecycle.ACTIVE,
              dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
            },
          },
          schedule: {
            is: {
              status: PublicationScheduleStatus.ACTIVE,
              mode: { in: [...scheduleModes] },
            },
          },
        },
      },
      deliveries: {
        some: {
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          OR: [
            {
              status: ManagedBroadcastDeliveryStatus.PENDING,
              dispatchBlockerCode: null,
              OR: [
                { lastErrorCode: null },
                { lastErrorCode: { not: PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE } },
              ],
            },
            {
              status: ManagedBroadcastDeliveryStatus.SENDING,
              OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
            },
          ],
        },
        none: {
          status: ManagedBroadcastDeliveryStatus.SENDING,
          lockedAt: { gte: staleLockBefore },
        },
      },
    },
    orderBy: [{ nextSendAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    take: MANAGED_BROADCAST_DUE_BATCH_SIZE,
    select: { id: true },
  });

  return { dueRows, staleLockBefore };
}

export type PendingPublisherPublicationDeadline = {
  id: string;
  nextSendAt: Date;
};

export async function selectNextPendingPublisherPublicationDeadline(
  prisma: Pick<PrismaService, 'managedBroadcast'>,
  now = new Date(),
): Promise<PendingPublisherPublicationDeadline | null> {
  const staleDeliveryLockBefore = new Date(now.getTime() - MANAGED_BROADCAST_LOCK_STALE_MS);
  // FLAG: Exact wakeups are only for ACTIVE executable delivery work. PARTIAL/FAILED anomalies,
  // blocked, verification-only, and fresh in-flight rows stay on the recovery poll so a
  // deterministic failure cannot create a rapid timer loop.
  const row = await prisma.managedBroadcast.findFirst({
    where: {
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      status: ManagedBroadcastStatus.ACTIVE,
      nextSendAt: { not: null },
      lockedAt: null,
      publicationOccurrence: {
        is: {
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          status: {
            in: [PublicationOccurrenceStatus.SCHEDULED, PublicationOccurrenceStatus.IN_PROGRESS],
          },
          publication: { is: { lifecycle: PublicationLifecycle.ACTIVE } },
          schedule: {
            is: {
              status: PublicationScheduleStatus.ACTIVE,
              mode: {
                in: [
                  PublicationScheduleMode.ONCE,
                  PublicationScheduleMode.SLOTS,
                  PublicationScheduleMode.RECURRENCE,
                ],
              },
            },
          },
        },
      },
      deliveries: {
        some: {
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          OR: [
            {
              status: ManagedBroadcastDeliveryStatus.PENDING,
              dispatchBlockerCode: null,
              OR: [
                { lastErrorCode: null },
                { lastErrorCode: { not: PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE } },
              ],
            },
            {
              status: ManagedBroadcastDeliveryStatus.SENDING,
              OR: [{ lockedAt: null }, { lockedAt: { lt: staleDeliveryLockBefore } }],
            },
          ],
        },
        none: {
          status: ManagedBroadcastDeliveryStatus.SENDING,
          lockedAt: { gte: staleDeliveryLockBefore },
        },
      },
    },
    orderBy: [{ nextSendAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, nextSendAt: true },
  });

  return row?.nextSendAt ? { id: row.id, nextSendAt: row.nextSendAt } : null;
}

export async function selectPriorityHalfOpenPublicationVerificationBatch(
  prisma: Pick<PrismaService, '$queryRaw'>,
  limit = PUBLICATION_HALF_OPEN_VERIFICATION_BATCH_SIZE,
): Promise<{
  dueRows: PriorityHalfOpenPublicationVerificationRow[];
  staleLockBefore: Date;
}> {
  const now = new Date();
  const staleLockBefore = new Date(now.getTime() - MANAGED_BROADCAST_LOCK_STALE_MS);
  const verifyReadyBefore = new Date(now.getTime() - PUBLICATION_POST_SEND_VERIFY_DELAY_MS);
  const boundedLimit = Math.min(
    PUBLICATION_HALF_OPEN_VERIFICATION_BATCH_SIZE,
    Math.max(0, Math.floor(limit)),
  );
  if (boundedLimit === 0) {
    return { dueRows: [], staleLockBefore };
  }

  // FLAG: This priority lane may select an envelope that also has PENDING deliveries. Its runtime
  // consumer must stay verification-only so a governor pause can never turn this query into sends.
  const dueRows = await prisma.$queryRaw<PriorityHalfOpenPublicationVerificationRow[]>(Prisma.sql`
    SELECT
      mb."id",
      (ARRAY_AGG(
        delivery."id"
        ORDER BY COALESCE(
          delivery."remote_message_verification_next_at",
          delivery."sent_at"
        ) ASC, delivery."id" ASC
      ))[1] AS "deliveryId"
    FROM "managed_broadcasts" AS mb
    INNER JOIN "managed_broadcast_deliveries" AS delivery
      ON delivery."broadcast_id" = mb."id"
      AND delivery."occurrence_index" = LEAST(
        GREATEST(1, mb."sent_count" + 1),
        GREATEST(1, mb."cycle_count")
      )
    INNER JOIN "chat_bot_memberships" AS membership
      ON membership."chat_id" = delivery."target_chat_id"
      AND membership."bot_id" = delivery."bot_id"
    INNER JOIN "publication_occurrences" AS occurrence
      ON occurrence."id" = mb."publication_occurrence_id"
    INNER JOIN "publication_schedules" AS schedule
      ON schedule."id" = occurrence."schedule_id"
    INNER JOIN "publications" AS publication
      ON publication."id" = occurrence."publication_id"
    WHERE mb."publication_occurrence_id" IS NOT NULL
      AND mb."status" IN (
        'ACTIVE'::"ManagedBroadcastStatus",
        'PARTIAL'::"ManagedBroadcastStatus",
        'FAILED'::"ManagedBroadcastStatus"
      )
      AND (mb."locked_at" IS NULL OR mb."locked_at" < ${staleLockBefore})
      AND occurrence."status" IN (
        'SCHEDULED'::"PublicationOccurrenceStatus",
        'IN_PROGRESS'::"PublicationOccurrenceStatus"
      )
      AND occurrence."content_revision_id" IS NOT DISTINCT FROM mb."publication_content_revision_id"
      AND occurrence."schedule_revision" = schedule."revision"
      AND schedule."status" = 'ACTIVE'::"PublicationScheduleStatus"
      AND publication."lifecycle" = 'ACTIVE'::"PublicationLifecycle"
      AND delivery."status" = 'SENT'::"ManagedBroadcastDeliveryStatus"
      AND delivery."sent_at" IS NOT NULL
      AND delivery."sent_at" <= ${verifyReadyBefore}
      AND delivery."remote_message_id" IS NOT NULL
      AND delivery."remote_message_verified_at" IS NULL
      AND (
        delivery."remote_message_verification_next_at" IS NULL
        OR delivery."remote_message_verification_next_at" <= ${now}
      )
      AND (
        delivery."remote_message_verification_next_at" IS NOT NULL
        OR delivery."remote_message_verification_attempted_at" IS NOT NULL
        OR delivery."remote_message_verification_source" IS NOT NULL
        OR delivery."remote_message_verification_attempt_count" > 0
        OR delivery."remote_message_verification_absent_count" > 0
        OR delivery."remote_message_verification_present_count" > 0
      )
      AND membership."status" = 'ACTIVE'::"ChatBotMembershipStatus"
      AND membership."send_route_failure_count" = 1
      AND membership."send_route_last_failure_code" = ${MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE}
      AND membership."send_route_quarantined_until" > ${now}
      AND membership."send_route_last_failure_at" IS NOT NULL
      AND delivery."sent_at" >= membership."send_route_last_failure_at"
      AND NOT EXISTS (
        SELECT 1
        FROM "managed_broadcast_deliveries" AS in_flight
        WHERE in_flight."broadcast_id" = mb."id"
          AND in_flight."status" = 'SENDING'::"ManagedBroadcastDeliveryStatus"
      )
    GROUP BY mb."id"
    ORDER BY MIN(
      COALESCE(delivery."remote_message_verification_next_at", delivery."sent_at")
    ) ASC, mb."id" ASC
    LIMIT ${boundedLimit}
  `);

  return { dueRows, staleLockBefore };
}

export async function selectPublicationManagedBroadcastDueBatch(
  prisma: Pick<PrismaService, 'managedBroadcast'>,
  scheduleModes: readonly PublicationScheduleMode[],
  limit: number,
  dispatchProfile: PublicationDispatchProfile = PublicationDispatchProfile.LEGACY_ROUTED,
): Promise<{ dueRows: DueManagedBroadcastRow[]; staleLockBefore: Date }> {
  const now = new Date();
  const staleLockBefore = new Date(now.getTime() - MANAGED_BROADCAST_LOCK_STALE_MS);
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) {
    return { dueRows: [], staleLockBefore };
  }

  const baseWhere: Prisma.ManagedBroadcastWhereInput = {
    dispatchProfile,
    nextSendAt: { lte: now },
    OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
    publicationOccurrence: {
      is: { schedule: { is: { mode: { in: [...scheduleModes] } } } },
    },
  };
  const orderBy = [{ nextSendAt: 'asc' as const }, { createdAt: 'asc' as const }];
  const unverifiedDeliveryWhere: Prisma.ManagedBroadcastDeliveryWhereInput = {
    status: ManagedBroadcastDeliveryStatus.SENT,
    remoteMessageId: { not: null },
    remoteMessageVerifiedAt: null,
    AND: [buildPublicationDeliveryAutomatedVerificationWhere()],
  };
  const unenrolledSentDeliveryWhere: Prisma.ManagedBroadcastDeliveryWhereInput = {
    status: ManagedBroadcastDeliveryStatus.SENT,
    remoteMessageId: { not: null },
    remoteMessageVerifiedAt: null,
    AND: [buildPublicationDeliveryUnenrolledVerificationWhere()],
  };
  const fallbackDeliveryWhere: Prisma.ManagedBroadcastDeliveryWhereInput = {
    OR: [
      {
        status: {
          in: [
            ManagedBroadcastDeliveryStatus.PENDING,
            ManagedBroadcastDeliveryStatus.SENDING,
            ManagedBroadcastDeliveryStatus.FAILED,
            ManagedBroadcastDeliveryStatus.AMBIGUOUS,
            ManagedBroadcastDeliveryStatus.CANCELED,
          ],
        },
      },
      {
        status: ManagedBroadcastDeliveryStatus.SENT,
        remoteMessageVerifiedAt: { not: null },
      },
      {
        status: ManagedBroadcastDeliveryStatus.SENT,
        remoteMessageId: null,
      },
      // DB-only recovery lane: the verifier ignores these rows and the runtime closes a stale
      // ACTIVE envelope from the already persisted delivery states.
      unenrolledSentDeliveryWhere,
      unverifiedDeliveryWhere,
    ],
  };
  const selectExecutionDueRows = () =>
    prisma.managedBroadcast.findMany({
      where: {
        ...baseWhere,
        status: ManagedBroadcastStatus.ACTIVE,
        deliveries: {
          some: {
            status: {
              in: [ManagedBroadcastDeliveryStatus.PENDING, ManagedBroadcastDeliveryStatus.SENDING],
            },
          },
        },
      },
      orderBy,
      take: boundedLimit,
      select: { id: true },
    });
  const selectVerificationDueRows = () =>
    prisma.managedBroadcast.findMany({
      where: {
        ...baseWhere,
        status: {
          in: [
            ManagedBroadcastStatus.ACTIVE,
            ManagedBroadcastStatus.PARTIAL,
            ManagedBroadcastStatus.FAILED,
          ],
        },
        deliveries: { some: unverifiedDeliveryWhere },
      },
      orderBy,
      take: boundedLimit,
      select: { id: true },
    });
  const selectFallbackDueRows = () =>
    prisma.managedBroadcast.findMany({
      where: {
        AND: [
          baseWhere,
          {
            OR: [
              {
                status: ManagedBroadcastStatus.ACTIVE,
                deliveries: { some: fallbackDeliveryWhere },
              },
              {
                status: {
                  in: [ManagedBroadcastStatus.PARTIAL, ManagedBroadcastStatus.FAILED],
                },
                deliveries: { some: unverifiedDeliveryWhere },
              },
            ],
          },
        ],
      },
      orderBy,
      take: Math.min(100, boundedLimit * 2),
      select: { id: true },
    });
  const [executionDueRows, verificationDueRows, fallbackDueRows] =
    dispatchProfile === PublicationDispatchProfile.PUBLIK_V1
      ? [
          await selectExecutionDueRows(),
          await selectVerificationDueRows(),
          await selectFallbackDueRows(),
        ]
      : await Promise.all([
          selectExecutionDueRows(),
          selectVerificationDueRows(),
          selectFallbackDueRows(),
        ]);

  const executionIds = new Set(executionDueRows.map((row) => row.id));
  const verificationOnlyRows = verificationDueRows.filter((row) => !executionIds.has(row.id));
  const verificationReservation = Math.min(
    verificationOnlyRows.length,
    MANAGED_BROADCAST_RECOVERY_BATCH_SIZE,
    executionDueRows.length > 0 ? Math.max(0, boundedLimit - 1) : boundedLimit,
  );
  const dueRows: DueManagedBroadcastRow[] = [
    ...executionDueRows.slice(0, boundedLimit - verificationReservation),
    ...verificationOnlyRows.slice(0, verificationReservation),
  ];
  const selectedIds = new Set(dueRows.map((row) => row.id));
  for (const row of [...executionDueRows, ...verificationOnlyRows, ...fallbackDueRows]) {
    if (dueRows.length >= boundedLimit) {
      break;
    }
    if (!selectedIds.has(row.id)) {
      dueRows.push(row);
      selectedIds.add(row.id);
    }
  }
  return { dueRows, staleLockBefore };
}

export async function selectLegacyManagedBroadcastDueBatch(
  prisma: Pick<PrismaService, 'managedBroadcast'>,
  governorAction: 'run' | 'slow',
  processedBroadcastIds: ReadonlySet<string>,
): Promise<{ dueRows: DueManagedBroadcastRow[]; staleLockBefore: Date }> {
  const dueBatchSize =
    governorAction === 'slow'
      ? MANAGED_BROADCAST_DUE_SLOW_BATCH_SIZE
      : MANAGED_BROADCAST_DUE_BATCH_SIZE;
  const recoveryBatchSize =
    governorAction === 'slow'
      ? MANAGED_BROADCAST_RECOVERY_SLOW_BATCH_SIZE
      : MANAGED_BROADCAST_RECOVERY_BATCH_SIZE;
  const now = new Date();
  const staleLockBefore = new Date(now.getTime() - MANAGED_BROADCAST_LOCK_STALE_MS);
  const autoRetryBefore = new Date(now.getTime() - MANAGED_BROADCAST_AUTO_RETRY_BACKOFF_MS);
  const [activeDueRows, retryableDueRows] = await Promise.all([
    prisma.managedBroadcast.findMany({
      where: {
        ...(processedBroadcastIds.size > 0 ? { id: { notIn: [...processedBroadcastIds] } } : {}),
        status: ManagedBroadcastStatus.ACTIVE,
        publicationOccurrenceId: null,
        nextSendAt: { lte: now },
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
      },
      orderBy: [{ nextSendAt: 'asc' }, { createdAt: 'asc' }],
      take: dueBatchSize,
      select: { id: true },
    }),
    prisma.managedBroadcast.findMany({
      where: {
        ...(processedBroadcastIds.size > 0 ? { id: { notIn: [...processedBroadcastIds] } } : {}),
        publicationOccurrenceId: null,
        status: {
          in: [ManagedBroadcastStatus.PARTIAL, ManagedBroadcastStatus.FAILED],
        },
        nextSendAt: { lte: now },
        updatedAt: { lte: autoRetryBefore },
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
        deliveries: {
          some: {
            status: ManagedBroadcastDeliveryStatus.FAILED,
            attemptCount: { lt: MANAGED_BROADCAST_MAX_AUTO_RETRY_ATTEMPTS },
            updatedAt: { lte: autoRetryBefore },
            OR: buildManagedBroadcastAutoRetryableFailureWhere(),
          },
        },
      },
      orderBy: [{ nextSendAt: 'asc' }, { createdAt: 'asc' }],
      take: dueBatchSize,
      select: { id: true },
    }),
  ]);
  const reservedRecoveryCount = Math.min(
    retryableDueRows.length,
    Math.min(recoveryBatchSize, dueBatchSize),
  );
  const dueRows = [
    ...activeDueRows.slice(0, dueBatchSize - reservedRecoveryCount),
    ...retryableDueRows.slice(0, reservedRecoveryCount),
  ].filter((row) => !processedBroadcastIds.has(row.id));
  if (dueRows.length < dueBatchSize) {
    const remainingSlots = dueBatchSize - dueRows.length;
    const activeOverflowOffset = dueBatchSize - reservedRecoveryCount;
    dueRows.push(
      ...activeDueRows
        .slice(activeOverflowOffset, activeOverflowOffset + remainingSlots)
        .filter((row) => !processedBroadcastIds.has(row.id)),
    );
  }
  if (dueRows.length < dueBatchSize) {
    const remainingSlots = dueBatchSize - dueRows.length;
    dueRows.push(
      ...retryableDueRows
        .slice(reservedRecoveryCount, reservedRecoveryCount + remainingSlots)
        .filter((row) => !processedBroadcastIds.has(row.id)),
    );
  }

  return { dueRows, staleLockBefore };
}
