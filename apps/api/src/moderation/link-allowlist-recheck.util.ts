import type { ChatSettings } from '@maxim/contracts/settings';

import { isEnforceableLinkPolicyTarget } from './navigation/link-policy-target.util';
import type { NavigationTargetEvidence } from './navigation/navigation-evidence.types';
import type { RuleViolation } from './rule-engine.contract';
import type { MessageLimitsBlockedDomainDetector } from './rule-engine-blocked-domains.detector';
import { createAllowlistLinkMatcher, detectBlockedLink } from './rule-engine-link-detector';

export function serializeLinkPolicyEffectiveAt(value: unknown): string | null {
  const parsed =
    value instanceof Date
      ? value
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function needsFreshLinkAllowlistRecheck(
  linkPolicy: ChatSettings['linkPolicy'],
  violations: readonly RuleViolation[],
  navigationTargets?: readonly NavigationTargetEvidence[],
): boolean {
  if (violations.some((violation) => violation.ruleCode === 'MESSAGE_BLOCKED_DOMAIN')) {
    return true;
  }
  return (
    linkPolicy === 'ALLOWLIST_ONLY' &&
    (violations.some((violation) => violation.ruleCode === 'LINK_BLOCKED') ||
      Boolean(navigationTargets?.some(isEnforceableLinkPolicyTarget)))
  );
}

export function suppressUnverifiedAllowlistDependentViolations(
  linkPolicy: ChatSettings['linkPolicy'],
  violations: readonly RuleViolation[],
): RuleViolation[] {
  return violations.filter(
    (violation) =>
      violation.ruleCode !== 'MESSAGE_BLOCKED_DOMAIN' &&
      (violation.ruleCode !== 'LINK_BLOCKED' || linkPolicy !== 'ALLOWLIST_ONLY'),
  );
}

export function recalculateFreshLinkAllowlistViolations(params: {
  text: string;
  settings: Pick<ChatSettings, 'linkPolicy' | 'messageLimitsBlockedDomains'>;
  freshDomainAllowlist: string[];
  navigationTargets?: readonly NavigationTargetEvidence[];
  violations: readonly RuleViolation[];
  blockedDomainDetector: MessageLimitsBlockedDomainDetector;
}): RuleViolation[] {
  const freshAllowlistMatcher = createAllowlistLinkMatcher(params.freshDomainAllowlist);
  const linkViolation = detectBlockedLink(
    params.text,
    params.settings.linkPolicy,
    params.freshDomainAllowlist,
    freshAllowlistMatcher,
    params.navigationTargets,
  );
  const blockedDomain = params.blockedDomainDetector.detect(
    params.text,
    params.settings.messageLimitsBlockedDomains,
    { isLinkAllowlisted: freshAllowlistMatcher },
  );
  const hadLinkViolation = params.violations.some(
    (violation) => violation.ruleCode === 'LINK_BLOCKED',
  );
  const recalculatedViolations = params.violations.flatMap((violation) => {
    if (violation.ruleCode === 'LINK_BLOCKED') {
      return linkViolation ? [{ ...violation, reason: linkViolation }] : [];
    }
    if (violation.ruleCode !== 'MESSAGE_BLOCKED_DOMAIN') {
      return [violation];
    }
    return blockedDomain
      ? [
          {
            ...violation,
            reason: `Blocked domain detected: ${blockedDomain.blockedDomain}`,
            metadata: {
              ...(violation.metadata ?? {}),
              blockedDomain: blockedDomain.blockedDomain,
              matchedDomain: blockedDomain.matchedDomain,
              matchedLink: blockedDomain.matchedLink,
            },
          },
        ]
      : [];
  });
  if (linkViolation && !hadLinkViolation) {
    recalculatedViolations.push({
      ruleCode: 'LINK_BLOCKED',
      score: 0.9,
      reason: linkViolation,
    });
  }
  return recalculatedViolations;
}
