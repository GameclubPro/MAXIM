import type { Logger } from '@nestjs/common';
import {
  type ManagedBroadcast,
  type ManagedBroadcastDelivery,
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  Prisma,
  PublicationOccurrenceStatus,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { isMaxApiThrottleError } from './admin-legacy-utils';
import type { AdminManagedBroadcastRuntimeContext } from './admin-managed-broadcast-runtime-context';
import { MANAGED_BROADCAST_LOCK_STALE_MS } from './admin.service.support';

export class ManagedBroadcastPublicationExecutionStopped extends Error {
  constructor() {
    super('Managed broadcast publication execution is no longer active');
    this.name = 'ManagedBroadcastPublicationExecutionStopped';
  }
}

export async function deferPublicationDeliveryAfterPreDispatchThrottle(options: {
  context: Pick<AdminManagedBroadcastRuntimeContext, 'prisma' | 'logger'>;
  row: Pick<ManagedBroadcast, 'id' | 'publicationOccurrenceId'>;
  delivery: Pick<ManagedBroadcastDelivery, 'id' | 'targetChatId'>;
  reason: 'startup' | 'scheduled' | 'manual_retry' | 'immediate' | 'deadline';
  occurrenceIndex: number;
  deliveryLockToken: string;
  error: unknown;
}): Promise<boolean> {
  // FLAG: Only capacity errors proven to precede the HTTP send may recycle this attempt.
  // An attempted or ambiguous send must remain terminal until an operator reviews it.
  if (
    !options.row.publicationOccurrenceId ||
    options.reason !== 'deadline' ||
    (options.error as { managedBroadcastSendStarted?: unknown })?.managedBroadcastSendStarted !==
      false ||
    !isMaxApiThrottleError(options.error)
  ) {
    return false;
  }

  const deferred = await options.context.prisma.managedBroadcastDelivery.updateMany({
    where: {
      id: options.delivery.id,
      status: ManagedBroadcastDeliveryStatus.SENDING,
      lockToken: options.deliveryLockToken,
      attemptCount: { gt: 0 },
    },
    data: {
      status: ManagedBroadcastDeliveryStatus.PENDING,
      attemptCount: { decrement: 1 },
      botId: null,
      remoteMessageId: null,
      remoteMessageVerifiedAt: null,
      legacySentWithoutRemoteId: false,
      sentAt: null,
      lockedAt: null,
      lockToken: null,
      lastError: null,
    },
  });
  if (deferred.count === 0) {
    return false;
  }

  options.context.logger.warn(
    {
      broadcastId: options.row.id,
      occurrenceIndex: options.occurrenceIndex,
      deliveryId: options.delivery.id,
      targetChatId: options.delivery.targetChatId,
      err: options.error instanceof Error ? options.error.message : String(options.error),
    },
    'Deferred publication delivery after pre-dispatch MAX capacity pressure',
  );
  return true;
}

export async function deferManagedBroadcastWithFreshDeliveryLocks(
  prisma: PrismaService,
  broadcastId: string,
  occurrenceIndex: number,
  leaseLockToken: string,
): Promise<boolean> {
  const staleLockBefore = new Date(Date.now() - MANAGED_BROADCAST_LOCK_STALE_MS);
  const inFlightCount = await prisma.managedBroadcastDelivery.count({
    where: {
      broadcastId,
      occurrenceIndex,
      status: ManagedBroadcastDeliveryStatus.SENDING,
      lockedAt: { gte: staleLockBefore },
    },
  });
  if (inFlightCount === 0) {
    return false;
  }

  await prisma.managedBroadcast.updateMany({
    where: { id: broadcastId, lockToken: leaseLockToken },
    data: { lockedAt: null, lockToken: null },
  });
  return true;
}

export async function reconcileOrphanedPublicationOccurrences(options: {
  prisma: PrismaService;
  logger: Logger;
  limit: number;
  maxBatch: number;
  staleBefore: Date;
}): Promise<void> {
  if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
    return;
  }
  const boundedLimit = Math.min(options.limit, options.maxBatch);
  // FLAG: An old IN_PROGRESS occurrence without any execution envelope must never be put back
  // into SCHEDULED automatically. Only the explicit retry flow may authorize a late send.
  const rows = await options.prisma.$queryRaw<
    Array<{ id: string; status: PublicationOccurrenceStatus }>
  >(Prisma.sql`
    WITH "orphan_candidates" AS (
      SELECT
        po."id",
        CASE
          WHEN po."schedule_revision" <> ps."revision"
            OR ps."status" IN (
              'DRAFT'::"PublicationScheduleStatus",
              'PAUSED'::"PublicationScheduleStatus",
              'COMPLETED'::"PublicationScheduleStatus",
              'CANCELED'::"PublicationScheduleStatus"
            )
            OR p."lifecycle" IN (
              'DRAFT'::"PublicationLifecycle",
              'PAUSED'::"PublicationLifecycle",
              'COMPLETED'::"PublicationLifecycle",
              'CANCELED'::"PublicationLifecycle"
            )
          THEN 'CANCELED'::"PublicationOccurrenceStatus"
          ELSE 'FAILED'::"PublicationOccurrenceStatus"
        END AS "next_status"
      FROM "publication_occurrences" AS po
      INNER JOIN "publication_schedules" AS ps ON ps."id" = po."schedule_id"
      INNER JOIN "publications" AS p ON p."id" = po."publication_id"
      WHERE po."status" = 'IN_PROGRESS'::"PublicationOccurrenceStatus"
        AND po."scheduled_at" < ${options.staleBefore}
        AND po."legacy_broadcast_id" IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "managed_broadcasts" AS mb
          WHERE mb."publication_occurrence_id" = po."id"
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "managed_broadcast_deliveries" AS d
          WHERE d."publication_occurrence_id" = po."id"
        )
      ORDER BY po."scheduled_at" ASC, po."id" ASC
      LIMIT ${boundedLimit}
      FOR UPDATE OF po SKIP LOCKED
    )
    UPDATE "publication_occurrences" AS po
    SET
      "status" = candidate."next_status",
      "updated_at" = CURRENT_TIMESTAMP
    FROM "orphan_candidates" AS candidate
    WHERE po."id" = candidate."id"
      AND po."status" = 'IN_PROGRESS'::"PublicationOccurrenceStatus"
    RETURNING po."id", po."status"
  `);
  if (rows.length === 0) {
    return;
  }

  options.logger.warn(
    {
      recovered: rows.length,
      canceled: rows.filter((row) => row.status === PublicationOccurrenceStatus.CANCELED).length,
      failed: rows.filter((row) => row.status === PublicationOccurrenceStatus.FAILED).length,
      cutoff: options.staleBefore.toISOString(),
    },
    'Reconciled publication occurrences without execution envelopes',
  );
}

export async function syncPublicationBroadcastAfterDeliveryResolution(
  tx: any,
  broadcastId: string,
  occurrenceIndex: number,
): Promise<void> {
  const deliveries = await tx.managedBroadcastDelivery.findMany({
    where: { broadcastId, occurrenceIndex },
    select: {
      status: true,
      remoteMessageId: true,
      remoteMessageVerifiedAt: true,
    },
  });
  if (deliveries.length === 0) {
    return;
  }
  const unresolved = deliveries.some((delivery: { status: ManagedBroadcastDeliveryStatus }) =>
    new Set<ManagedBroadcastDeliveryStatus>([
      ManagedBroadcastDeliveryStatus.SENDING,
      ManagedBroadcastDeliveryStatus.AMBIGUOUS,
    ]).has(delivery.status),
  );
  if (unresolved) {
    return;
  }
  const hasPendingOrUnverified = deliveries.some(
    (delivery: {
      status: ManagedBroadcastDeliveryStatus;
      remoteMessageId: string | null;
      remoteMessageVerifiedAt: Date | null;
    }) =>
      delivery.status === ManagedBroadcastDeliveryStatus.PENDING ||
      (delivery.status === ManagedBroadcastDeliveryStatus.SENT &&
        delivery.remoteMessageId !== null &&
        delivery.remoteMessageVerifiedAt === null),
  );
  if (hasPendingOrUnverified) {
    await tx.managedBroadcast.updateMany({
      where: { id: broadcastId, status: { not: ManagedBroadcastStatus.CANCELED } },
      data: {
        status: ManagedBroadcastStatus.ACTIVE,
        nextSendAt: new Date(),
        lockedAt: null,
        lockToken: null,
        lastError: null,
      },
    });
    return;
  }

  const sent = deliveries.filter(
    (delivery: { status: ManagedBroadcastDeliveryStatus }) =>
      delivery.status === ManagedBroadcastDeliveryStatus.SENT,
  ).length;
  const failed = deliveries.length - sent;
  const status =
    failed === 0
      ? ManagedBroadcastStatus.COMPLETED
      : sent > 0
        ? ManagedBroadcastStatus.PARTIAL
        : ManagedBroadcastStatus.FAILED;
  await tx.managedBroadcast.updateMany({
    where: { id: broadcastId, status: { not: ManagedBroadcastStatus.CANCELED } },
    data: {
      status,
      ...(status === ManagedBroadcastStatus.COMPLETED
        ? { sentCount: occurrenceIndex, nextSendAt: null, lastError: null }
        : { lastError: 'Не все получатели получили публикацию.' }),
      lockedAt: null,
      lockToken: null,
    },
  });
  if (status === ManagedBroadcastStatus.COMPLETED) {
    await tx.managedBroadcastCalendarReservation.deleteMany({
      where: { broadcastId, occurrenceIndex },
    });
    await tx.managedBroadcastOccurrence.updateMany({
      where: { broadcastId, occurrenceIndex },
      data: { status: ManagedBroadcastStatus.COMPLETED },
    });
  }
}
