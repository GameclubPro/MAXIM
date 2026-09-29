import { getPublicationTargetKey, type PublicationTarget } from './publication-model';

export type PublicationTargetToggleResult = {
  targets: PublicationTarget[];
  outcome: 'added' | 'removed' | 'blocked_unavailable';
};

export function canPreparePublisherPublicationTarget(
  target: Pick<PublicationTarget, 'readiness'>,
): boolean {
  const readiness = target.readiness;
  // FLAG: Selecting a stale target only permits preparation. Submission still
  // requires the server's fresh actor/bot checks after the explicit access refresh.
  return (
    readiness?.canPublish === true ||
    (readiness?.state === 'setup_required' &&
      (readiness.blockerCode === 'bot_access_expired' ||
        readiness.blockerCode === 'bot_access_unconfirmed'))
  );
}

export function togglePublicationTargetSelection(
  current: readonly PublicationTarget[],
  target: PublicationTarget,
): PublicationTargetToggleResult {
  const key = getPublicationTargetKey(target);
  const selected = current.some((item) => getPublicationTargetKey(item) === key);

  if (selected) {
    return {
      targets: current.filter((item) => getPublicationTargetKey(item) !== key),
      outcome: 'removed',
    };
  }
  if (target.readiness && !canPreparePublisherPublicationTarget(target)) {
    return { targets: [...current], outcome: 'blocked_unavailable' };
  }
  return { targets: [...current, target], outcome: 'added' };
}
