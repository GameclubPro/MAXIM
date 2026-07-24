import type { RuleViolation } from './rule-engine.contract';
import { selectTopModerationViolation } from './moderation-violation-selection';

const violation = (ruleCode: string, metadata?: Record<string, unknown>): RuleViolation => ({
  ruleCode,
  score: 1,
  reason: ruleCode,
  ...(metadata ? { metadata } : {}),
});

describe('selectTopModerationViolation', () => {
  it('keeps blocked links at the highest priority', () => {
    expect(
      selectTopModerationViolation([
        violation('COMMERCIAL_AD', { actionBand: 'DELETE', actionable: true }),
        violation('LINK_BLOCKED'),
      ])?.ruleCode,
    ).toBe('LINK_BLOCKED');
  });

  it('prioritizes actionable commercial ads over ordinary content violations', () => {
    expect(
      selectTopModerationViolation([
        violation('PROFANITY'),
        violation('COMMERCIAL_AD', { actionBand: 'WARN', recordable: true }),
      ])?.ruleCode,
    ).toBe('COMMERCIAL_AD');
  });

  it.each([
    ['explicit flags', { actionBand: 'REVIEW_ONLY', actionable: false, recordable: false }],
    ['action-band fallback', { actionBand: 'REVIEW_ONLY' }],
  ])('does not let review-only commercial telemetry mask another violation: %s', (_label, metadata) => {
    expect(
      selectTopModerationViolation([
        violation('COMMERCIAL_AD', metadata),
        violation('MESSAGE_BLOCKED_WORD'),
      ])?.ruleCode,
    ).toBe('MESSAGE_BLOCKED_WORD');
  });

  it('falls back to an unknown non-commercial violation before review telemetry', () => {
    expect(
      selectTopModerationViolation([
        violation('COMMERCIAL_AD', { actionBand: 'REVIEW_ONLY', actionable: false }),
        violation('FUTURE_RULE'),
      ])?.ruleCode,
    ).toBe('FUTURE_RULE');
  });

  it('returns a standalone review-only commercial violation for telemetry handling', () => {
    expect(
      selectTopModerationViolation([
        violation('COMMERCIAL_AD', { actionBand: 'REVIEW_ONLY', recordable: false }),
      ])?.ruleCode,
    ).toBe('COMMERCIAL_AD');
  });

  it('returns undefined for an empty result', () => {
    expect(selectTopModerationViolation([])).toBeUndefined();
  });
});
