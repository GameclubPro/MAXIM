import type { DetectionResult, RuleViolation } from './rule-engine.contract';

export function hasCompetingModerationViolation(violations: readonly RuleViolation[]): boolean {
  // FLAG: Explicit review telemetry owns no reaction or strike. WARN, recordable and
  // incomplete commercial decisions still exclude independent stateful moderation.
  return violations.some(
    (violation) =>
      violation.ruleCode !== 'COMMERCIAL_AD' ||
      violation.metadata?.actionable !== false ||
      violation.metadata?.recordable !== false,
  );
}

export function resolveDuplicateRuleEligibility(
  violations: readonly RuleViolation[],
  detection: Pick<DetectionResult, 'duplicateDecision' | 'duplicateHit'>,
): { track: boolean; actionEligible: boolean } {
  const track = !hasCompetingModerationViolation(violations);
  return {
    track,
    actionEligible: track && !detection.duplicateDecision && !detection.duplicateHit,
  };
}
