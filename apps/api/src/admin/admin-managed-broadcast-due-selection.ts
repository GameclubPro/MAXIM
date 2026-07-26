import { ManagedBroadcastDeliveryStatus, ManagedBroadcastStatus } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { buildManagedBroadcastAutoRetryableFailureWhere } from './admin-managed-broadcast-reconciliation';
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
