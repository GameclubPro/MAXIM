import { getPublicationTargetKey, type PublicationTarget } from './publication-model';
import { canPreparePublisherPublicationTarget } from '../../lib/publisher-readiness';

export { canPreparePublisherPublicationTarget } from '../../lib/publisher-readiness';

export type PublicationTargetToggleResult = {
  targets: PublicationTarget[];
  outcome: 'added' | 'removed' | 'blocked_unavailable';
};

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
