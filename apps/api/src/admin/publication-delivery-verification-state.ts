import {
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  PublicationOccurrenceStatus,
  type Prisma,
} from '../prisma/prisma-client';
import { PUBLICATION_POST_SEND_VERIFY_DELAY_MS } from './admin.service.support';

export const PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE =
  'PUBLICATION_ROUTE_QUARANTINED' as const;

export const buildPublicationRouteAdvisoryLockKey = (targetChatId: string): string =>
  `publication-route:${targetChatId.trim()}`;

export const PUBLICATION_DELIVERY_VERIFICATION_RESET_DATA = {
  remoteMessageVerifiedAt: null,
  remoteMessageVerificationAttemptCount: 0,
  remoteMessageVerificationAbsentCount: 0,
  remoteMessageVerificationPresentCount: 0,
  remoteMessageVerificationAttemptedAt: null,
  remoteMessageVerificationNextAt: null,
  remoteMessageVerificationLastError: null,
  remoteMessageVerificationSource: null,
} as const;

export const buildPublicationDeliveryVerificationScheduledData = (sentAt: Date) => ({
  ...PUBLICATION_DELIVERY_VERIFICATION_RESET_DATA,
  remoteMessageVerificationNextAt: new Date(
    sentAt.getTime() + PUBLICATION_POST_SEND_VERIFY_DELAY_MS,
  ),
});

type PublicationDeliveryAutomatedVerificationState = {
  remoteMessageVerificationAttemptCount?: number | null;
  remoteMessageVerificationAbsentCount?: number | null;
  remoteMessageVerificationPresentCount?: number | null;
  remoteMessageVerificationAttemptedAt?: Date | null;
  remoteMessageVerificationNextAt?: Date | null;
  remoteMessageVerificationSource?: string | null;
};

type PublicationOccurrenceRollupDelivery = PublicationDeliveryAutomatedVerificationState & {
  status: ManagedBroadcastDeliveryStatus;
  remoteMessageId: string | null;
  remoteMessageVerifiedAt: Date | null;
};

type PublicationOccurrenceRollupBroadcast = {
  status: ManagedBroadcastStatus;
  deliveries: readonly PublicationOccurrenceRollupDelivery[];
};

const PUBLICATION_VERIFICATION_RUNNABLE_BROADCAST_STATUSES = new Set<ManagedBroadcastStatus>([
  ManagedBroadcastStatus.ACTIVE,
  ManagedBroadcastStatus.PARTIAL,
  ManagedBroadcastStatus.FAILED,
]);

// FLAG: The all-null/all-zero state is not automatically enrolled. It contains historical rows
// and may contain a reviewed rollout-gap cohort; classify or enroll those only through a bounded
// operator flow. Every new send must set remoteMessageVerificationNextAt explicitly.
export function hasPublicationDeliveryAutomatedVerificationState(
  delivery: PublicationDeliveryAutomatedVerificationState,
): boolean {
  return Boolean(
    delivery.remoteMessageVerificationNextAt ||
    delivery.remoteMessageVerificationAttemptedAt ||
    delivery.remoteMessageVerificationSource ||
    (delivery.remoteMessageVerificationAttemptCount ?? 0) > 0 ||
    (delivery.remoteMessageVerificationAbsentCount ?? 0) > 0 ||
    (delivery.remoteMessageVerificationPresentCount ?? 0) > 0,
  );
}

export function buildPublicationDeliveryUnenrolledVerificationWhere(): Prisma.ManagedBroadcastDeliveryWhereInput {
  return {
    remoteMessageVerificationNextAt: null,
    remoteMessageVerificationAttemptedAt: null,
    remoteMessageVerificationSource: null,
    remoteMessageVerificationAttemptCount: 0,
    remoteMessageVerificationAbsentCount: 0,
    remoteMessageVerificationPresentCount: 0,
  };
}

export function buildPublicationDeliveryAutomatedVerificationWhere(): Prisma.ManagedBroadcastDeliveryWhereInput {
  return {
    OR: [
      { remoteMessageVerificationNextAt: { not: null } },
      { remoteMessageVerificationAttemptedAt: { not: null } },
      { remoteMessageVerificationSource: { not: null } },
      { remoteMessageVerificationAttemptCount: { gt: 0 } },
      { remoteMessageVerificationAbsentCount: { gt: 0 } },
      { remoteMessageVerificationPresentCount: { gt: 0 } },
    ],
  };
}

export function resolvePublicationOccurrenceRollupStatus(
  broadcasts: readonly PublicationOccurrenceRollupBroadcast[],
  scheduledAt: Date,
  now = new Date(),
): PublicationOccurrenceStatus {
  const deliveries = broadcasts.flatMap((broadcast) => broadcast.deliveries);
  const count = (status: ManagedBroadcastDeliveryStatus) =>
    deliveries.filter((delivery) => delivery.status === status).length;
  const sent = count(ManagedBroadcastDeliveryStatus.SENT);
  const failed = count(ManagedBroadcastDeliveryStatus.FAILED);
  const ambiguous = count(ManagedBroadcastDeliveryStatus.AMBIGUOUS);
  const canceled = count(ManagedBroadcastDeliveryStatus.CANCELED);
  const pending = deliveries.length - sent - failed - ambiguous - canceled;
  const broadcastsWithArmedVerification = broadcasts.filter((broadcast) =>
    broadcast.deliveries.some(
      (delivery) =>
        delivery.status === ManagedBroadcastDeliveryStatus.SENT &&
        delivery.remoteMessageId !== null &&
        delivery.remoteMessageVerifiedAt === null &&
        hasPublicationDeliveryAutomatedVerificationState(delivery),
    ),
  );
  const verificationStillActive = broadcastsWithArmedVerification.some((broadcast) =>
    PUBLICATION_VERIFICATION_RUNNABLE_BROADCAST_STATUSES.has(broadcast.status),
  );
  const stoppedWithUnverifiedDelivery = broadcastsWithArmedVerification.some(
    (broadcast) => !PUBLICATION_VERIFICATION_RUNNABLE_BROADCAST_STATUSES.has(broadcast.status),
  );

  if (pending > 0 || verificationStillActive) {
    return scheduledAt > now
      ? PublicationOccurrenceStatus.SCHEDULED
      : PublicationOccurrenceStatus.IN_PROGRESS;
  }
  if (ambiguous > 0 || stoppedWithUnverifiedDelivery) {
    return PublicationOccurrenceStatus.AMBIGUOUS;
  }
  if (failed + canceled > 0) {
    return sent > 0 ? PublicationOccurrenceStatus.PARTIAL : PublicationOccurrenceStatus.FAILED;
  }
  return sent === deliveries.length
    ? PublicationOccurrenceStatus.SENT
    : PublicationOccurrenceStatus.IN_PROGRESS;
}

type PublicationDeliveryVerificationSchedule = {
  sentAt: Date | null;
  remoteMessageVerificationAttemptCount?: number | null;
  remoteMessageVerificationAbsentCount?: number | null;
  remoteMessageVerificationPresentCount?: number | null;
  remoteMessageVerificationAttemptedAt?: Date | null;
  remoteMessageVerificationNextAt: Date | null;
  remoteMessageVerificationSource?: string | null;
};

export function resolvePublicationVerificationNextSendAt(
  deliveries: readonly PublicationDeliveryVerificationSchedule[],
  hasPendingDelivery: boolean,
  now = new Date(),
): Date {
  if (hasPendingDelivery) {
    return now;
  }

  const nextVerificationAt = deliveries
    .filter(hasPublicationDeliveryAutomatedVerificationState)
    .reduce<Date | null>((earliest, delivery) => {
      const candidate =
        delivery.remoteMessageVerificationNextAt ??
        (delivery.sentAt
          ? new Date(delivery.sentAt.getTime() + PUBLICATION_POST_SEND_VERIFY_DELAY_MS)
          : now);
      return earliest === null || candidate < earliest ? candidate : earliest;
    }, null);
  return !nextVerificationAt || nextVerificationAt <= now ? now : nextVerificationAt;
}
