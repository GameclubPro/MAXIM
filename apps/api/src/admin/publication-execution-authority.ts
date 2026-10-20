import type { ManagedEntityType } from '@maxim/contracts';
import { readPublicationRetryAuthorizedAt } from './publication-late-policy';

export const PUBLISHER_ENTITY_EXECUTION_AUTHORITY_VERSION = 1;

export type PublisherDeliveryAuthority =
  | {
      kind: 'publication';
      occurrenceId: string;
      contentRevisionId: string | null;
      actorUserId: string;
      entityType: ManagedEntityType;
    }
  | { kind: 'legacy_actor'; actorUserId: string; entityType: ManagedEntityType };

type PublicationIntent = {
  deliveryDeadlineAt?: Date | null;
  retryAuthorizedAt?: Date | null;
  retryExpiresAt?: Date | null;
  dispatchBlockerCode?: string | null;
  dispatchBlockedAt?: Date | null;
};

export type PublicationExecutionIntent =
  | { kind: 'entity'; deadlineAt: Date }
  | { kind: 'legacy_actor' }
  | { kind: 'invalid' };

function finiteDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export function resolvePublicationExecutionIntent(
  occurrence: PublicationIntent,
  now = new Date(),
): PublicationExecutionIntent {
  // FLAG: Only persisted bounded intent changes execution authority. A computed legacy
  // grace period, worker clock or returning bot access must never revive indefinite work.
  const original = occurrence.deliveryDeadlineAt;
  const retryExpiry = occurrence.retryExpiresAt;
  if (
    (original != null && !finiteDate(original)) ||
    (retryExpiry != null && !finiteDate(retryExpiry))
  )
    return { kind: 'invalid' };
  const authorizedAt = readPublicationRetryAuthorizedAt(occurrence);
  if (retryExpiry && (!finiteDate(authorizedAt) || retryExpiry.getTime() < authorizedAt.getTime()))
    return { kind: 'invalid' };
  const retryDeadline = retryExpiry && authorizedAt && authorizedAt <= now ? retryExpiry : null;
  const deadlineAt =
    original && (!retryDeadline || original >= retryDeadline) ? original : retryDeadline;
  if (deadlineAt) return { kind: 'entity', deadlineAt };
  // A future/incomplete explicit retry is not permission to use legacy authority.
  return retryExpiry ? { kind: 'invalid' } : { kind: 'legacy_actor' };
}
