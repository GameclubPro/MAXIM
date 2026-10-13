import {
  publicationLatePolicySchema,
  DEFAULT_PUBLICATION_LATE_POLICY,
  type PublicationScheduleInput,
} from '@maxim/contracts/publication';
import type { PrismaService } from '../prisma/prisma.service';
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
    schedule: { mode: PublicationScheduleMode; rule?: unknown };
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
  const policy = readPublicationLatePolicy(occurrence.schedule.rule);
  const grace = policy ? policy.maxDelayMinutes * 60_000 : PUBLICATION_SCHEDULED_LATE_GRACE_MS;
  return occurrence.scheduledAt.getTime() < now.getTime() - grace;
}

export function readPublicationLatePolicy(rule: unknown) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
  const result = publicationLatePolicySchema.safeParse(
    (rule as Record<string, unknown>).latePolicy,
  );
  return result.success ? result.data : null;
}

export async function isPublicationOccurrenceWindowClosed(
  prisma: Pick<PrismaService, 'publicationOccurrence'>,
  occurrence: Parameters<typeof isPublicationScheduledWindowExpired>[0] & {
    scheduleRevision: number;
    schedule: { id?: string; mode: PublicationScheduleMode; rule?: unknown };
  },
  now = new Date(),
): Promise<boolean> {
  if (isPublicationScheduledWindowExpired(occurrence, now)) return true;
  const retryAt = readPublicationRetryAuthorizedAt(occurrence)?.getTime();
  if (
    retryAt !== undefined &&
    retryAt <= now.getTime() &&
    retryAt >= now.getTime() - PUBLICATION_SCHEDULED_LATE_GRACE_MS
  )
    return false;
  const policy = readPublicationLatePolicy(occurrence.schedule.rule);
  if (
    occurrence.schedule.mode !== 'RECURRENCE' ||
    policy?.mode !== 'recover' ||
    policy.catchUp !== 'latest' ||
    !occurrence.schedule.id
  )
    return false;
  // FLAG: Only another durable occurrence of this revision supersedes the old slot.
  // Never invent an occurrence beyond maxOccurrences or repeat an uncertain SEND.
  return Boolean(
    await prisma.publicationOccurrence.findFirst({
      where: {
        scheduleId: occurrence.schedule.id,
        scheduleRevision: occurrence.scheduleRevision,
        scheduledAt: { gt: occurrence.scheduledAt, lte: now },
        status: { not: 'CANCELED' },
      },
      orderBy: { scheduledAt: 'desc' },
      select: { id: true },
    }),
  );
}

export function withDefaultPublicationLatePolicy(
  schedule: PublicationScheduleInput,
): PublicationScheduleInput {
  return schedule.mode === 'now'
    ? schedule
    : { ...schedule, latePolicy: schedule.latePolicy ?? DEFAULT_PUBLICATION_LATE_POLICY };
}

export function resolvePublicationRecurrenceFrom(
  rule: PublicationScheduleInput,
  schedule: { lastMaterializedAt?: Date | null; createdAt?: Date },
  latest: { scheduledAt: Date } | null,
  now: Date,
): Date {
  const modern = readPublicationLatePolicy(rule);
  return latest?.scheduledAt && (latest.scheduledAt > now || modern)
    ? new Date(latest.scheduledAt.getTime() + 1)
    : modern
      ? (schedule.lastMaterializedAt ?? schedule.createdAt ?? now)
      : now;
}
