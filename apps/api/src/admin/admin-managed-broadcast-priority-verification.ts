import { randomUUID } from 'node:crypto';
import { ManagedBroadcastStatus } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AdminManagedBroadcastRuntimeContext } from './admin-managed-broadcast-runtime-context';
import { getCurrentManagedBroadcastOccurrence } from './admin-managed-broadcast-planner';
import type {
  AdminManagedBroadcastPublicationVerification,
  ManagedBroadcastPublicationVerificationBudget,
} from './admin-managed-broadcast-publication-verification';
import { selectPriorityHalfOpenPublicationVerificationBatch } from './admin-managed-broadcast-due-selection';
import {
  PUBLICATION_HALF_OPEN_VERIFICATION_BATCH_SIZE,
  type ManagedBroadcastMaxApiOptions,
} from './admin.service.support';

const PRIORITY_VERIFICATION_STATUSES: ManagedBroadcastStatus[] = [
  ManagedBroadcastStatus.ACTIVE,
  ManagedBroadcastStatus.PARTIAL,
  ManagedBroadcastStatus.FAILED,
];

export async function processPriorityHalfOpenPublicationVerifications(params: {
  prisma: Pick<PrismaService, '$queryRaw' | 'managedBroadcast'>;
  logger: AdminManagedBroadcastRuntimeContext['logger'];
  verification: AdminManagedBroadcastPublicationVerification;
  maxApiOptions: ManagedBroadcastMaxApiOptions;
  budget: ManagedBroadcastPublicationVerificationBudget;
}): Promise<void> {
  try {
    await processPriorityHalfOpenPublicationVerificationsPersisted(params);
  } catch (error: unknown) {
    params.logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'Priority half-open publication verification was deferred',
    );
  }
}

async function processPriorityHalfOpenPublicationVerificationsPersisted(params: {
  prisma: Pick<PrismaService, '$queryRaw' | 'managedBroadcast'>;
  verification: AdminManagedBroadcastPublicationVerification;
  maxApiOptions: ManagedBroadcastMaxApiOptions;
  budget: ManagedBroadcastPublicationVerificationBudget;
}): Promise<void> {
  if (params.budget.remaining <= 0) {
    return;
  }
  const { dueRows, staleLockBefore } = await selectPriorityHalfOpenPublicationVerificationBatch(
    params.prisma,
    Math.min(PUBLICATION_HALF_OPEN_VERIFICATION_BATCH_SIZE, params.budget.remaining),
  );

  for (const candidate of dueRows) {
    if (params.budget.remaining <= 0) {
      break;
    }
    const claimedAt = new Date();
    const lockToken = randomUUID();
    const claimed = await params.prisma.managedBroadcast.updateMany({
      where: {
        id: candidate.id,
        status: { in: PRIORITY_VERIFICATION_STATUSES },
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
      },
      data: { lockedAt: claimedAt, lockToken },
    });
    if (claimed.count === 0) {
      continue;
    }

    try {
      const broadcast = await params.prisma.managedBroadcast.findUnique({
        where: { id: candidate.id },
      });
      if (
        !broadcast?.publicationOccurrenceId ||
        !PRIORITY_VERIFICATION_STATUSES.includes(broadcast.status)
      ) {
        continue;
      }
      await params.verification.verifyAfterSend(
        broadcast,
        getCurrentManagedBroadcastOccurrence(broadcast),
        params.maxApiOptions,
        async () => undefined,
        params.budget,
        [candidate.deliveryId],
      );
    } finally {
      await params.prisma.managedBroadcast.updateMany({
        where: { id: candidate.id, lockedAt: claimedAt, lockToken },
        data: { lockedAt: null, lockToken: null },
      });
    }
  }
}
