import { ConflictException } from '@nestjs/common';
import {
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  type Prisma,
} from '../prisma/prisma-client';

type PublicationExecutionBroadcastLease = {
  id: string;
  lockedAt: Date | null;
  lockToken: string | null;
};

type PublicationExecutionMutationClient = {
  managedBroadcast: {
    updateMany(args: unknown): Promise<{ count: number }>;
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
};

const CANCELABLE_PUBLICATION_BROADCAST_STATUSES = [
  ManagedBroadcastStatus.ACTIVE,
  ManagedBroadcastStatus.PARTIAL,
  ManagedBroadcastStatus.FAILED,
];

export function buildUnsafePublicationExecutionDeliveryWhere() {
  return {
    OR: [
      { attemptCount: { gt: 0 } },
      { lockedAt: { not: null } },
      {
        status: {
          in: [
            ManagedBroadcastDeliveryStatus.SENDING,
            ManagedBroadcastDeliveryStatus.SENT,
            ManagedBroadcastDeliveryStatus.AMBIGUOUS,
          ],
        },
      },
    ],
  };
}

export async function reviseUnstartedPublicationExecutionBroadcasts(
  tx: PublicationExecutionMutationClient,
  broadcasts: readonly PublicationExecutionBroadcastLease[],
  data: Prisma.ManagedBroadcastUncheckedUpdateManyInput,
  message: string,
): Promise<void> {
  assertPublicationExecutionBroadcastsUnleased(broadcasts, message);
  const broadcastIds = broadcasts.map((broadcast) => broadcast.id);
  if (broadcastIds.length === 0) return;

  // FLAG: Update envelopes before their occurrences/deliveries in the same transaction. These
  // row locks serialize with the worker's envelope claim; any lease or attempted delivery
  // rejects the entire edit, even when the submitted content equals the previous revision.
  const revised = await tx.managedBroadcast.updateMany({
    where: {
      id: { in: broadcastIds },
      status: ManagedBroadcastStatus.ACTIVE,
      sentCount: 0,
      lockedAt: null,
      lockToken: null,
      deliveries: {
        none: {
          OR: [
            ...buildUnsafePublicationExecutionDeliveryWhere().OR,
            { lockToken: { not: null } },
            { remoteMessageId: { not: null } },
            { sentAt: { not: null } },
            { postActionsToken: { not: null } },
          ],
        },
      },
    },
    data,
  });
  if (revised.count !== broadcastIds.length) {
    throwPublicationExecutionRequiresManualReview(message);
  }
}

export function throwPublicationExecutionRequiresManualReview(message: string): never {
  throw new ConflictException({
    code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW',
    message,
  });
}

function assertPublicationExecutionBroadcastsUnleased(
  broadcasts: readonly PublicationExecutionBroadcastLease[],
  message: string,
): void {
  // FLAG: Destructive publication mutations must not clear any execution lease, including a
  // seemingly stale one. Stale ownership is resolved only by managed-broadcast recovery.
  if (broadcasts.some((broadcast) => Boolean(broadcast.lockedAt) || Boolean(broadcast.lockToken))) {
    throwPublicationExecutionRequiresManualReview(message);
  }
}

export async function cancelUnstartedPublicationExecutionBroadcasts(
  tx: PublicationExecutionMutationClient,
  broadcasts: readonly PublicationExecutionBroadcastLease[],
  message: string,
): Promise<string[]> {
  assertPublicationExecutionBroadcastsUnleased(broadcasts, message);
  const broadcastIds = broadcasts.map((broadcast) => broadcast.id);
  if (broadcastIds.length === 0) {
    return [];
  }

  const canceled = await tx.managedBroadcast.updateMany({
    where: {
      id: { in: broadcastIds },
      status: { in: CANCELABLE_PUBLICATION_BROADCAST_STATUSES },
      lockedAt: null,
      lockToken: null,
      deliveries: { none: buildUnsafePublicationExecutionDeliveryWhere() },
    },
    data: {
      status: ManagedBroadcastStatus.CANCELED,
      nextSendAt: null,
      lockedAt: null,
      lockToken: null,
    },
  });
  if (canceled.count !== broadcastIds.length) {
    throwPublicationExecutionRequiresManualReview(message);
  }
  return broadcastIds;
}

export async function deleteUnstartedPublicationExecutionBroadcasts(
  tx: PublicationExecutionMutationClient,
  broadcasts: readonly PublicationExecutionBroadcastLease[],
  message: string,
): Promise<void> {
  assertPublicationExecutionBroadcastsUnleased(broadcasts, message);
  const broadcastIds = broadcasts.map((broadcast) => broadcast.id);
  if (broadcastIds.length === 0) {
    return;
  }

  const deleted = await tx.managedBroadcast.deleteMany({
    where: {
      id: { in: broadcastIds },
      status: ManagedBroadcastStatus.ACTIVE,
      sentCount: 0,
      lockedAt: null,
      lockToken: null,
      deliveries: { none: buildUnsafePublicationExecutionDeliveryWhere() },
    },
  });
  if (deleted.count !== broadcastIds.length) {
    throwPublicationExecutionRequiresManualReview(message);
  }
}
