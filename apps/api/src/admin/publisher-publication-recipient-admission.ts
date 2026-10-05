import { Prisma, type ManagedBroadcastDelivery } from '../prisma/prisma-client';
import { PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE } from './publication-delivery-verification-state';
import { PUBLISHER_PUBLICATION_BLOCKED_RETRY_MS } from './publication-dispatch-issue';
import { MANAGED_BROADCAST_AUTOMATIC_DELIVERY_QUANTUM } from './admin.service.support';
import { selectManagedBroadcastDeliveryCandidates } from './publication-execution-recovery';

type AdmissionDelivery = Pick<
  ManagedBroadcastDelivery,
  'status' | 'targetChatId' | 'lastErrorCode' | 'updatedAt'
> &
  Partial<Pick<ManagedBroadcastDelivery, 'dispatchBlockerCode' | 'dispatchBlockedAt'>>;

export function isPublicationRecipientAdmissionComplete(
  deliveries: readonly Pick<ManagedBroadcastDelivery, 'status'>[],
): boolean {
  // FLAG: Receipts and terminal outcomes are DB recovery, not new sends. Recipient
  // authority is checked only within the bounded admission batch and before HTTP.
  return (
    deliveries.length > 0 &&
    deliveries.every((delivery) => delivery.status !== 'SENDING' && delivery.status !== 'PENDING')
  );
}

export function resolveManagedBroadcastRecipientAdmission<T extends AdmissionDelivery>(
  deliveries: readonly T[],
  options: {
    isPublikExecution: boolean;
    isPublicationExecution: boolean;
    reason: 'startup' | 'scheduled' | 'manual_retry' | 'immediate' | 'deadline';
    quantumOverride?: number;
  },
) {
  const automaticDeliveryQuantum =
    options.quantumOverride ??
    (options.isPublikExecution || ['startup', 'scheduled', 'deadline'].includes(options.reason)
      ? MANAGED_BROADCAST_AUTOMATIC_DELIVERY_QUANTUM
      : Number.POSITIVE_INFINITY);
  const admission = options.isPublikExecution
    ? selectPublisherPublicationAdmissionBatch(deliveries, automaticDeliveryQuantum)
    : {
        deliveries: selectManagedBroadcastDeliveryCandidates(
          deliveries,
          options.isPublicationExecution,
        ),
        pendingNotBefore: null,
      };
  return {
    automaticDeliveryQuantum,
    deliveryCandidates: admission.deliveries,
    pendingNotBefore: admission.pendingNotBefore,
  };
}

export function publisherPublicationRecipientRetryAt(
  delivery: Pick<AdmissionDelivery, 'dispatchBlockerCode' | 'dispatchBlockedAt'>,
  now: Date,
): Date | null {
  if (!delivery.dispatchBlockerCode || !delivery.dispatchBlockedAt) return null;
  const retryAt = new Date(
    delivery.dispatchBlockedAt.getTime() + PUBLISHER_PUBLICATION_BLOCKED_RETRY_MS,
  );
  return retryAt > now ? retryAt : null;
}

export function selectPublisherPublicationAdmissionBatch<T extends AdmissionDelivery>(
  deliveries: readonly T[],
  quantum: number,
  now = new Date(),
): { deliveries: T[]; pendingNotBefore: Date | null } {
  const candidates = deliveries.filter((delivery) => delivery.status === 'PENDING');
  let pendingNotBefore: Date | null = null;
  const ready: T[] = [];
  const blocked: T[] = [];
  for (const delivery of candidates) {
    const retryAt = publisherPublicationRecipientRetryAt(delivery, now);
    if (retryAt) {
      if (!pendingNotBefore || retryAt < pendingNotBefore) pendingNotBefore = retryAt;
      continue;
    }
    if (
      delivery.dispatchBlockerCode ||
      delivery.lastErrorCode === PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE
    )
      blocked.push(delivery);
    else ready.push(delivery);
  }
  // FLAG: A paused recipient consumes only its own admission slot. Untouched recipients run
  // first; due blockers and quarantines rotate together oldest-first. A permanent denied
  // author cannot exclude another target's route recovery. Route quarantine keeps its own
  // transport/reservation guard rather than borrowing the recipient's 60-second retry.
  blocked.sort(
    (left, right) =>
      (left.dispatchBlockedAt ?? left.updatedAt).getTime() -
        (right.dispatchBlockedAt ?? right.updatedAt).getTime() ||
      left.targetChatId.localeCompare(right.targetChatId),
  );
  return { deliveries: [...ready, ...blocked].slice(0, quantum), pendingNotBefore };
}

export function buildClearResolvedPublisherRecipientBlockerQuery(occurrenceId: string, now: Date) {
  // FLAG: Clear only resolved recipient signals. Preserve author retry authorization and
  // missed-window decisions, and inspect both envelopes through the partial blocker index.
  return Prisma.sql`
    UPDATE "publication_occurrences" AS occurrence
    SET "dispatch_blocker_code" = NULL, "dispatch_blocked_at" = NULL, "updated_at" = ${now}
    WHERE occurrence."id" = ${occurrenceId} AND occurrence."dispatch_profile" = 'PUBLIK_V1'
      AND occurrence."dispatch_blocker_code" IS NOT NULL
      AND occurrence."dispatch_blocker_code" NOT IN ('PUBLISHER_EXPLICIT_RETRY', 'PUBLISHER_MISSED_WINDOW_REVIEW')
      AND NOT EXISTS (
        SELECT 1 FROM "managed_broadcast_deliveries" AS delivery
        WHERE delivery."publication_occurrence_id" = occurrence."id"
          AND delivery."dispatch_profile" = 'PUBLIK_V1'
          AND delivery."status" IN ('PENDING', 'SENDING')
          AND delivery."dispatch_blocker_code" IS NOT NULL
      )
  `;
}
