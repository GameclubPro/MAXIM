import {
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  Prisma,
  PublicationOccurrenceStatus,
} from '../prisma/prisma-client';
import { buildRetryableFailedPublicationDeliveryWhere } from './publication-legacy-automated-absence';

export const RETRYABLE_PUBLICATION_BROADCAST_STATUSES: ManagedBroadcastStatus[] = [
  ManagedBroadcastStatus.PARTIAL,
  ManagedBroadcastStatus.FAILED,
];

export function isRetryablePublicationOccurrenceStatus(
  status: PublicationOccurrenceStatus,
): boolean {
  return (
    status === PublicationOccurrenceStatus.FAILED || status === PublicationOccurrenceStatus.PARTIAL
  );
}

export function buildRetryableUntouchedPublicationDeliveryWhere(): Prisma.ManagedBroadcastDeliveryWhereInput {
  return {
    status: ManagedBroadcastDeliveryStatus.PENDING,
    attemptCount: 0,
    remoteMessageId: null,
    sentAt: null,
    lockedAt: null,
    lockToken: null,
  };
}

export function buildRetryablePublicationDeliveryWhere(): Prisma.ManagedBroadcastDeliveryWhereInput {
  return {
    OR: [
      buildRetryableFailedPublicationDeliveryWhere(),
      buildRetryableUntouchedPublicationDeliveryWhere(),
    ],
  };
}

export function buildUnsafePendingPublicationDeliveryWhere(): Prisma.ManagedBroadcastDeliveryWhereInput {
  return {
    status: ManagedBroadcastDeliveryStatus.PENDING,
    OR: [
      { attemptCount: { not: 0 } },
      { remoteMessageId: { not: null } },
      { sentAt: { not: null } },
      { lockedAt: { not: null } },
      { lockToken: { not: null } },
    ],
  };
}
