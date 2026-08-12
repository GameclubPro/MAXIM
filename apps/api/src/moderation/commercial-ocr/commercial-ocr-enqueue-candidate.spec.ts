import type { RuleViolation } from '../rule-engine.contract';
import { hasActionableCompetingViolation } from './commercial-ocr-enqueue-candidate';

describe('commercial OCR enqueue candidate policy', () => {
  it.each([
    { violations: [], expected: false },
    {
      violations: [{ ruleCode: 'LINK_BLOCKED', score: 1, reason: 'link' }],
      expected: true,
    },
    {
      violations: [commercialViolation({ actionBand: 'REVIEW_ONLY', actionable: false })],
      expected: false,
    },
    {
      violations: [commercialViolation({ actionBand: 'DELETE', actionable: true })],
      expected: true,
    },
    {
      violations: [commercialViolation({ actionBand: 'DELETE', actionable: false })],
      expected: false,
    },
  ])('returns $expected for competing violations', ({ violations, expected }) => {
    expect(hasActionableCompetingViolation(violations)).toBe(expected);
  });
});

function commercialViolation(metadata: Record<string, unknown>): RuleViolation {
  return { ruleCode: 'COMMERCIAL_AD', score: 1, reason: 'commercial', metadata };
}
