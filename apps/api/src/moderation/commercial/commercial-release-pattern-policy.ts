import { findCommercialPatternRules } from './commercial-patterns';

// FLAG: This reviewed manifest is deliberately independent of the live rule registry. A newly
// declared structured pattern cannot acquire released cleanup authority by being appended there.
// Legacy freeform feature signals remain governed by their release source identity/cohorts.
export const COMMERCIAL_RELEASED_PATTERN_RULE_IDS = [
  'services-specialist-offer',
  'goods-retail-order-flow',
  'channel-placement-traffic',
  'property-agent-commission',
  'high-risk-casino-crypto-loans',
  'private-one-off-goods',
  'request-recommendation',
] as const;
const releasedIds: ReadonlySet<string> = new Set(COMMERCIAL_RELEASED_PATTERN_RULE_IDS);

export function resolveCommercialReleasedPatternEvidence(text: string): {
  matchedRuleIds: string[];
  unreleasedRuleIds: string[];
} {
  const matchedRuleIds = findCommercialPatternRules({ text }).map((rule) => rule.id);
  return { matchedRuleIds, unreleasedRuleIds: matchedRuleIds.filter((id) => !releasedIds.has(id)) };
}
