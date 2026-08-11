import type { NavigationTargetEvidence } from './navigation-evidence.types';

export function isEnforceableLinkPolicyTarget(target: NavigationTargetEvidence): boolean {
  // FLAG: MAX user_mention markup targets a User, not an arbitrary hyperlink.
  return target.enforceable && target.kind !== 'profile_mention';
}
