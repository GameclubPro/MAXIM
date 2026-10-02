import type { PublisherBindingRefreshJob } from './publisher-binding-refresh.queue';
import { PUBLISHER_BOT_EXPIRY_URGENCY_MS } from './publisher-access-refresh-policy';

export const PUBLISHER_REFRESH_QUEUE_AGE_BASIS = 'all_urgent_refresh_boundaries_v3';

export function publisherRefreshTiming(job: PublisherBindingRefreshJob, now: number) {
  const requestedAt = Date.parse(job.requestedAt);
  const publication =
    job.publicationRequested ||
    job.reason === 'publication_due' ||
    job.reason === 'publication_actor_due';
  const publicationAt = publication
    ? Date.parse(job.publicationUrgentAt ?? job.publicationRequestedAt ?? job.requestedAt)
    : Number.NaN;
  const botAt =
    !job.candidateUserId &&
    (publication || job.reason === 'scheduled_bot_access' || job.reason === 'stale_access')
      ? Date.parse(job.requiredBefore ?? '') - PUBLISHER_BOT_EXPIRY_URGENCY_MS
      : Number.NaN;
  const boundaries = [publicationAt, botAt].filter(Number.isFinite);
  const boundary = boundaries.length ? Math.min(...boundaries) : Number.NaN;
  const immediate = [
    'bot_added',
    'webhook_observed',
    'forwarded_private',
    'historical_actor_recovery',
    'send_access_lost',
    'manual_recheck',
    'policy_enablement_recheck',
  ].includes(job.reason);
  const workClass =
    immediate || (Number.isFinite(boundary) && boundary <= now)
      ? 'urgent'
      : publication
        ? Number.isFinite(boundary) && boundary > now
          ? 'preparation'
          : 'urgent'
        : 'background';
  // FLAG: This timestamp is observation only. Never replace requestedAt in the execution
  // envelope: candidate identity, proof reuse and send keys depend on its original semantics.
  const measuredFrom =
    workClass === 'urgent' && !immediate && Number.isFinite(boundary) ? boundary : requestedAt;
  return {
    workClass,
    queueAgeMs: Number.isFinite(measuredFrom) ? Math.max(0, now - measuredFrom) : null,
  } as const;
}
