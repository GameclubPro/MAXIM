import { collectCommercialSignals } from './commercial-features';
import { normalizeCommercialText } from './commercial-normalization';
import { CommercialSecondStageScorer } from './commercial-scorer';
import type { CommercialSecondStageInput } from '../rule-engine-commercial-second-stage-cache';

function input(text: string): CommercialSecondStageInput {
  const rawLoweredText = text.toLowerCase();
  const normalizedText = normalizeCommercialText(text);
  const appliedThresholds = {
    warnThreshold: 45,
    deleteThreshold: 65,
    sensitivity: 'BALANCED' as const,
    strictness: 0.5,
  };
  return {
    rawLoweredText,
    normalizedText,
    appliedThresholds,
    state: collectCommercialSignals({ rawLoweredText, normalizedText, profile: appliedThresholds }),
    confidenceScore: 50,
    decisionBand: 'MEDIUM',
    classification: {
      primarySubtype: 'SERVICES',
      supportingSubtypes: [],
      evidenceStrength: 'STRUCTURED',
      reviewRecommended: false,
      reviewReasons: [],
    },
  };
}

describe('commercial scorer contact evidence', () => {
  it.each(['\n', ' / ', '; '])('counts separate canonical contacts across %j', (separator) => {
    const domestic = input(`Ремонт обуви. Звоните: 8 900 000 10 42${separator}8 900 000 10 43`);
    const international = input('Ремонт обуви. Звоните: +7 900 000 10 42; +7 900 000 10 43');
    expect(new CommercialSecondStageScorer().evaluate(domestic)).toEqual(
      new CommercialSecondStageScorer().evaluate(international),
    );
  });

  it('does not boost the same contact repeated in national and international format', () => {
    const single = input('Ремонт обуви. Звоните: +7 900 000 10 42');
    const repeated = input('Ремонт обуви. Звоните: 8 900 000 10 42; +7 900 000 10 42');
    expect(new CommercialSecondStageScorer().evaluate(repeated)).toEqual(
      new CommercialSecondStageScorer().evaluate(single),
    );
  });

  it('keeps review context independent of preceding calls with the same text', () => {
    const baseline = input('Ремонт обуви. Звоните: +7 900 000 10 42');
    const review = {
      ...baseline,
      classification: {
        ...baseline.classification,
        reviewRecommended: true,
        reviewReasons: ['campaign-dependent'],
      },
    };
    for (const [first, second] of [
      [baseline, review],
      [review, baseline],
    ]) {
      const scorer = new CommercialSecondStageScorer();
      scorer.evaluate(first!);
      expect(scorer.evaluate(second!)).toEqual(new CommercialSecondStageScorer().evaluate(second!));
    }
  });
});
