import {
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  Prisma,
  PublicationScheduleMode,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { buildManagedBroadcastAutoRetryableFailureWhere } from './admin-managed-broadcast-reconciliation';
import {
  buildPublicationDeliveryAutomatedVerificationWhere,
  buildPublicationDeliveryUnenrolledVerificationWhere,
} from './publication-delivery-verification-state';
import {
  MANAGED_BROADCAST_AUTO_RETRY_BACKOFF_MS,
  MANAGED_BROADCAST_DUE_BATCH_SIZE,
  MANAGED_BROADCAST_DUE_SLOW_BATCH_SIZE,
  MANAGED_BROADCAST_LOCK_STALE_MS,
  MANAGED_BROADCAST_MAX_AUTO_RETRY_ATTEMPTS,
  MANAGED_BROADCAST_RECOVERY_BATCH_SIZE,
  MANAGED_BROADCAST_RECOVERY_SLOW_BATCH_SIZE,
} from './admin.service.support';

type DueManagedBroadcastRow = { id: string };

export async function selectPublicationManagedBroadcastDueBatch(
  prisma: Pick<PrismaService, 'managedBroadcast'>,
  scheduleModes: readonly PublicationScheduleMode[],
  limit: number,
): Promise<{ dueRows: DueManagedBroadcastRow[]; staleLockBefore: Date }> {
  const now = new Date();
  const staleLockBefore = new Date(now.getTime() - MANAGED_BROADCAST_LOCK_STALE_MS);
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) {
    return { dueRows: [], staleLockBefore };
  }

  const baseWhere: Prisma.ManagedBroadcastWhereInput = {
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
  const [executionDueRows, verificationDueRows, fallbackDueRows] = await Promise.all([
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
    }),
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
    }),
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
    }),
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
