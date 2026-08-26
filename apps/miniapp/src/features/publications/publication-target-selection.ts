import { MAX_PUBLICATION_TARGETS } from '@maxim/contracts/publication';
import { getPublicationTargetKey, type PublicationTarget } from './publication-model';

export type PublicationTargetToggleResult = {
  targets: PublicationTarget[];
  outcome: 'added' | 'removed' | 'blocked_unavailable' | 'blocked_limit';
};

export function togglePublicationTargetSelection(
  current: readonly PublicationTarget[],
  target: PublicationTarget,
  maxTargets = MAX_PUBLICATION_TARGETS,
): PublicationTargetToggleResult {
  const key = getPublicationTargetKey(target);
  const selected = current.some((item) => getPublicationTargetKey(item) === key);

  if (selected) {
    return {
      targets: current.filter((item) => getPublicationTargetKey(item) !== key),
      outcome: 'removed',
    };
  }
  if (target.readiness && !target.readiness.canPublish) {
    return { targets: [...current], outcome: 'blocked_unavailable' };
  }
  if (current.length >= maxTargets) {
    return { targets: [...current], outcome: 'blocked_limit' };
  }
  return { targets: [...current, target], outcome: 'added' };
}
