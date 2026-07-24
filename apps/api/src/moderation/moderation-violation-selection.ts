import type { RuleViolation } from './rule-engine.contract';

const MODERATION_VIOLATION_PRIORITY = [
  'PROFANITY',
  'MESSAGE_BLOCKED_WORD',
  'MESSAGE_BLOCKED_DOMAIN',
  'PHONE_NUMBER_BLOCKED',
  'MESSAGE_TOO_LONG',
  'MESSAGE_RATE_LIMIT',
  'MESSAGE_COUNT_LIMIT',
  'PHOTO_BLOCKED',
  'VIDEO_BLOCKED',
  'FILE_BLOCKED',
  'VOICE_BLOCKED',
  'PHOTO_RATE_LIMIT',
  'STICKER_RATE_LIMIT',
] as const;

function isActionableCommercialViolation(violation: RuleViolation): boolean {
  if (violation.ruleCode !== 'COMMERCIAL_AD') {
    return false;
  }

  const metadata = violation.metadata;
  const actionBand = typeof metadata?.actionBand === 'string' ? metadata.actionBand : null;
  const fallbackActionable =
    actionBand !== null && actionBand !== 'ALLOW' && actionBand !== 'REVIEW_ONLY';
  const recordable =
    typeof metadata?.recordable === 'boolean' ? metadata.recordable : fallbackActionable;
  const actionable =
    typeof metadata?.actionable === 'boolean' ? metadata.actionable : fallbackActionable;

  return recordable || actionable;
}

export function selectTopModerationViolation(
  violations: readonly RuleViolation[],
): RuleViolation | undefined {
  const commercialViolation = violations.find((item) => item.ruleCode === 'COMMERCIAL_AD');

  return (
    violations.find((item) => item.ruleCode === 'LINK_BLOCKED') ??
    (commercialViolation && isActionableCommercialViolation(commercialViolation)
      ? commercialViolation
      : undefined) ??
    MODERATION_VIOLATION_PRIORITY.map((ruleCode) =>
      violations.find((item) => item.ruleCode === ruleCode),
    ).find((item): item is RuleViolation => item !== undefined) ??
    violations.find((item) => item.ruleCode !== 'COMMERCIAL_AD') ??
    commercialViolation ??
    violations[0]
  );
}
