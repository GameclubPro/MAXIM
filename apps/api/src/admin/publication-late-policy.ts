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
  retryExpiresAt?: Date | null;
  deliveryDeadlineAt?: Date | null;
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

export function isPublicationRetryAuthorized(
  occurrence: PublicationRetryAuthorization,
  now: Date,
): boolean {
  const grantedAt = readPublicationRetryAuthorizedAt(occurrence)?.getTime();
  if (grantedAt === undefined || !Number.isFinite(grantedAt) || grantedAt > now.getTime())
    return false;
  // FLAG: New explicit grants have an immutable expiry. Existing grants retain their original
  // five-minute authority; neither a technical retry nor migration renews it.
  const expiresAt =
    occurrence.retryExpiresAt?.getTime() ?? grantedAt + PUBLICATION_SCHEDULED_LATE_GRACE_MS;
  return Number.isFinite(expiresAt) && expiresAt >= grantedAt && now.getTime() <= expiresAt;
}

export function isPublicationScheduledWindowExpired(
  occurrence: PublicationRetryAuthorization & {
    scheduledAt: Date;
    schedule: { mode: PublicationScheduleMode; rule?: unknown };
  },
  now = new Date(),
): boolean {
  if (isPublicationRetryAuthorized(occurrence, now)) return false;
  const deadline = resolvePublicationDeliveryDeadline(occurrence, now);
  return deadline !== null && deadline.getTime() < now.getTime();
}

export function snapshotPublicationDeliveryDeadline(
  scheduledAt: Date,
  rule: PublicationScheduleInput,
): Date {
  const delay =
    rule.mode === 'now'
      ? 24 * 60 * 60_000
      : (readPublicationLatePolicy(rule)?.maxDelayMinutes ?? 5) * 60_000;
  return new Date(scheduledAt.getTime() + delay);
}

export function resolvePublicationDeliveryDeadline(
  occurrence: PublicationRetryAuthorization & {
    scheduledAt: Date;
    schedule: { mode: PublicationScheduleMode; rule?: unknown };
  },
  now = new Date(),
): Date | null {
  // FLAG: No migration or worker clock renews existing intent. Legacy NOW retains its
  // previous behavior; newly accepted work carries an immutable deadline snapshot.
  const original =
    occurrence.deliveryDeadlineAt ??
    (occurrence.schedule.mode === PublicationScheduleMode.NOW
      ? null
      : new Date(
          occurrence.scheduledAt.getTime() +
            (readPublicationLatePolicy(occurrence.schedule.rule)?.maxDelayMinutes ?? 5) * 60_000,
        ));
  const authorizedAt = readPublicationRetryAuthorizedAt(occurrence);
  const retryDeadline =
    authorizedAt && authorizedAt <= now
      ? (occurrence.retryExpiresAt ??
        new Date(authorizedAt.getTime() + PUBLICATION_SCHEDULED_LATE_GRACE_MS))
      : null;
  if (!original) return occurrence.retryExpiresAt ? retryDeadline : null;
  return retryDeadline && retryDeadline > original ? retryDeadline : original;
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
  if (isPublicationRetryAuthorized(occurrence, now)) return false;
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
