import { PublicationScheduleMode } from '../prisma/prisma-client';
import { PUBLISHER_EXPLICIT_RETRY_CODE } from './publication-dispatch-issue';

export const PUBLICATION_SCHEDULED_LATE_GRACE_MS = 5 * 60_000;

type PublicationRetryAuthorization = {
  retryAuthorizedAt?: Date | null;
  dispatchBlockerCode?: string | null;
  dispatchBlockedAt?: Date | null;
};

export function readPublicationRetryAuthorizedAt(
  occurrence: PublicationRetryAuthorization,
): Date | null {
  return (
    occurrence.retryAuthorizedAt ??
    (occurrence.dispatchBlockerCode === PUBLISHER_EXPLICIT_RETRY_CODE
      ? (occurrence.dispatchBlockedAt ?? null)
      : null)
  );
}

export function isPublicationScheduledWindowExpired(
  occurrence: PublicationRetryAuthorization & {
    scheduledAt: Date;
    schedule: { mode: PublicationScheduleMode };
  },
  now = new Date(),
): boolean {
  if (
    occurrence.schedule.mode !== PublicationScheduleMode.ONCE &&
    occurrence.schedule.mode !== PublicationScheduleMode.SLOTS &&
    occurrence.schedule.mode !== PublicationScheduleMode.RECURRENCE
  )
    return false;
  // FLAG: Access deferrals must not replace or extend the author's explicit retry window.
  // The shared blocker marker is a read-only compatibility fallback for older retries.
  const retryAt = readPublicationRetryAuthorizedAt(occurrence)?.getTime();
  if (
    retryAt !== undefined &&
    retryAt <= now.getTime() &&
    retryAt >= now.getTime() - PUBLICATION_SCHEDULED_LATE_GRACE_MS
  ) {
    return false;
  }
  return occurrence.scheduledAt.getTime() < now.getTime() - PUBLICATION_SCHEDULED_LATE_GRACE_MS;
}
