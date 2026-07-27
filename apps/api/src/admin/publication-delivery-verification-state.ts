import { PUBLICATION_POST_SEND_VERIFY_DELAY_MS } from './admin.service.support';

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

type PublicationDeliveryVerificationSchedule = {
  sentAt: Date | null;
  remoteMessageVerificationNextAt: Date | null;
};

export function resolvePublicationVerificationNextSendAt(
  deliveries: readonly PublicationDeliveryVerificationSchedule[],
  hasPendingDelivery: boolean,
  now = new Date(),
): Date {
  if (hasPendingDelivery) {
    return now;
  }

  const nextVerificationAt = deliveries.reduce<Date | null>((earliest, delivery) => {
    const candidate =
      delivery.remoteMessageVerificationNextAt ??
      (delivery.sentAt
        ? new Date(delivery.sentAt.getTime() + PUBLICATION_POST_SEND_VERIFY_DELAY_MS)
        : now);
    return earliest === null || candidate < earliest ? candidate : earliest;
  }, null);
  return !nextVerificationAt || nextVerificationAt <= now ? now : nextVerificationAt;
}
