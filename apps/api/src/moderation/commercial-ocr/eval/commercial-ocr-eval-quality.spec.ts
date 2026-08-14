import type { CommercialOcrPass } from '../commercial-ocr-decision-policy';
import {
  aggregateCommercialOcrEvalQuality,
  emptyCommercialOcrEvalQualityCounts,
  evaluateCommercialOcrEvalCaseQuality,
} from './commercial-ocr-eval-quality';
import type { CommercialOcrEvalCaseV2 } from './commercial-ocr-eval.schema';

describe('commercial OCR eval quality aggregation', () => {
  it('reports exact two-pass recognition without retaining OCR or reference text', () => {
    const fixture = qualityFixture();
    const primary = recognized(fixture.images[0]!.transcript, 1_000);
    const confirmation = recognized(fixture.images[0]!.transcript, 1_000);

    const quality = evaluateCommercialOcrEvalCaseQuality({
      fixture,
      passes: [{ primary, confirmation }],
    });

    expect(quality).toMatchObject({
      expectedPasses: 2,
      attemptedPasses: 2,
      failedPasses: 0,
      expectedPrimaryPasses: 1,
      attemptedPrimaryPasses: 1,
      failedPrimaryPasses: 0,
      expectedConfirmationPasses: 1,
      attemptedConfirmationPasses: 1,
      failedConfirmationPasses: 0,
      characterEdits: 0,
      wordEdits: 0,
      criticalTokens: 2,
      criticalTokensMatchedPrimary: 2,
      criticalTokensMatchedConfirmation: 2,
      criticalTokensMatchedBoth: 2,
      confidenceObservations: 2,
      absoluteConfidenceCalibrationErrorPermille: 0,
      highConfidencePasses: 2,
      highConfidenceSevereErrorPasses: 0,
      characterErrorRate: 0,
      wordErrorRate: 0,
      criticalTokenRecall: 1,
      meanAbsoluteConfidenceCalibrationError: 0,
      highConfidenceSevereErrorRate: 0,
    });
    expect(quality.characterReferenceLength).toBeGreaterThan(0);
    expect(quality.wordReferenceLength).toBeGreaterThan(0);
    expect(JSON.stringify(quality)).not.toContain('Ремонт');
    expect(JSON.stringify(quality)).not.toContain('7999');
  });

  it('distinguishes an unattempted pass from an attempted empty result', () => {
    const fixture = qualityFixture();
    const quality = evaluateCommercialOcrEvalCaseQuality({
      fixture,
      passes: [
        { primary: recognized(fixture.images[0]!.transcript, 800), confirmation: undefined },
      ],
    });

    expect(quality.expectedPasses).toBe(2);
    expect(quality.attemptedPasses).toBe(1);
    expect(quality).toMatchObject({
      expectedPrimaryPasses: 1,
      attemptedPrimaryPasses: 1,
      failedPrimaryPasses: 0,
      expectedConfirmationPasses: 1,
      attemptedConfirmationPasses: 0,
      failedConfirmationPasses: 0,
    });
    expect(quality.characterEdits).toBe(0);
    expect(quality.criticalTokensMatchedPrimary).toBe(2);
    expect(quality.criticalTokensMatchedConfirmation).toBe(0);
    expect(quality.criticalTokensMatchedBoth).toBe(0);
    expect(quality.criticalTokenRecall).toBe(0);
    expect(quality.meanAbsoluteConfidenceCalibrationError).toBeCloseTo(0.2);

    const attemptedEmpty = evaluateCommercialOcrEvalCaseQuality({
      fixture,
      passes: [{ primary: null, confirmation: undefined }],
    });
    expect(attemptedEmpty.attemptedPasses).toBe(1);
    expect(attemptedEmpty).toMatchObject({
      failedPasses: 1,
      failedPrimaryPasses: 1,
      failedConfirmationPasses: 0,
    });
    expect(attemptedEmpty.characterErrorRate).toBe(1);
    expect(attemptedEmpty.wordErrorRate).toBe(1);
  });

  it('counts no-text and failed passes as full reference errors without confidence samples', () => {
    const fixture = qualityFixture();
    const quality = evaluateCommercialOcrEvalCaseQuality({
      fixture,
      passes: [
        {
          primary: { status: 'no_text', text: '', confidencePermille: 0 },
          confirmation: { status: 'failed', text: '', confidencePermille: 0 },
        },
      ],
    });

    expect(quality).toMatchObject({
      attemptedPasses: 2,
      failedPasses: 1,
      attemptedPrimaryPasses: 1,
      failedPrimaryPasses: 0,
      attemptedConfirmationPasses: 1,
      failedConfirmationPasses: 1,
      characterErrorRate: 1,
      wordErrorRate: 1,
      criticalTokenRecall: 0,
      confidenceObservations: 0,
      meanAbsoluteConfidenceCalibrationError: 0,
      highConfidencePasses: 0,
      highConfidenceSevereErrorRate: 0,
    });
  });

  it('uses bounded numeric candidates for critical-token recall', () => {
    const fixture = qualityFixture({
      transcript: 'Телефон 7 999',
      criticalTokens: [{ kind: 'phone', value: '7999' }],
    });
    const quality = evaluateCommercialOcrEvalCaseQuality({
      fixture,
      passes: [
        {
          primary: recognized('В наличии 7 товаров, осталось 999.', 950),
          confirmation: recognized('Телефон 7 999', 950),
        },
      ],
    });

    expect(quality.criticalTokensMatchedPrimary).toBe(0);
    expect(quality.criticalTokensMatchedConfirmation).toBe(1);
    expect(quality.criticalTokensMatchedBoth).toBe(0);
    expect(quality.criticalTokenRecall).toBe(0);
  });

  it('flags confidently severe recognition errors and calibrates against character accuracy', () => {
    const fixture = qualityFixture({
      transcript: 'ремонт',
      criticalTokens: [{ kind: 'commercial_anchor', value: 'ремонт' }],
    });
    const quality = evaluateCommercialOcrEvalCaseQuality({
      fixture,
      passes: [{ primary: recognized('товары', 950), confirmation: undefined }],
    });

    expect(quality.characterErrorRate).toBeGreaterThan(0.5);
    expect(quality.confidenceObservations).toBe(1);
    expect(quality.highConfidencePasses).toBe(1);
    expect(quality.highConfidenceSevereErrorPasses).toBe(1);
    expect(quality.highConfidenceSevereErrorRate).toBe(1);
    expect(quality.meanAbsoluteConfidenceCalibrationError).toBeGreaterThan(0.45);
  });

  it('computes exact character distance at the maximum annotated transcript length', () => {
    const transcript = 'я'.repeat(32_000);
    const fixture = qualityFixture({ transcript, criticalTokens: [] });
    const quality = evaluateCommercialOcrEvalCaseQuality({
      fixture,
      passes: [
        {
          primary: recognized(`${transcript.slice(0, -1)}ю`, 1_000),
          confirmation: undefined,
        },
      ],
    });

    expect(quality.characterEdits).toBe(1);
    expect(quality.characterReferenceLength).toBe(32_000);
    expect(quality.characterErrorRate).toBeCloseTo(1 / 32_000);
  });

  it('aggregates count denominators instead of averaging per-case rates', () => {
    const large = {
      ...emptyCommercialOcrEvalQualityCounts(),
      expectedPasses: 2,
      attemptedPasses: 2,
      expectedPrimaryPasses: 1,
      attemptedPrimaryPasses: 1,
      expectedConfirmationPasses: 1,
      attemptedConfirmationPasses: 1,
      characterEdits: 10,
      characterReferenceLength: 100,
      wordEdits: 5,
      wordReferenceLength: 20,
      criticalTokens: 10,
      criticalTokensMatchedPrimary: 9,
      criticalTokensMatchedConfirmation: 9,
      criticalTokensMatchedBoth: 9,
      confidenceObservations: 2,
      absoluteConfidenceCalibrationErrorPermille: 200,
      highConfidencePasses: 1,
    };
    const small = {
      ...emptyCommercialOcrEvalQualityCounts(),
      expectedPasses: 2,
      attemptedPasses: 1,
      expectedPrimaryPasses: 1,
      attemptedPrimaryPasses: 1,
      expectedConfirmationPasses: 1,
      attemptedConfirmationPasses: 0,
      characterEdits: 1,
      characterReferenceLength: 1,
      wordEdits: 1,
      wordReferenceLength: 2,
      criticalTokens: 1,
      confidenceObservations: 1,
      absoluteConfidenceCalibrationErrorPermille: 800,
      highConfidencePasses: 1,
      highConfidenceSevereErrorPasses: 1,
    };

    const quality = aggregateCommercialOcrEvalQuality([large, small]);

    expect(quality.expectedPasses).toBe(4);
    expect(quality.attemptedPasses).toBe(3);
    expect(quality).toMatchObject({
      failedPasses: 0,
      expectedPrimaryPasses: 2,
      attemptedPrimaryPasses: 2,
      failedPrimaryPasses: 0,
      expectedConfirmationPasses: 2,
      attemptedConfirmationPasses: 1,
      failedConfirmationPasses: 0,
    });
    expect(quality.characterErrorRate).toBeCloseTo(11 / 101);
    expect(quality.wordErrorRate).toBeCloseTo(6 / 22);
    expect(quality.criticalTokenRecall).toBeCloseTo(9 / 11);
    expect(quality.meanAbsoluteConfidenceCalibrationError).toBeCloseTo(1 / 3);
    expect(quality.highConfidenceSevereErrorRate).toBeCloseTo(1 / 2);
  });

  it('returns finite zero rates when no observations exist', () => {
    const quality = aggregateCommercialOcrEvalQuality([]);

    expect(quality).toEqual({
      ...emptyCommercialOcrEvalQualityCounts(),
      characterErrorRate: 0,
      wordErrorRate: 0,
      criticalTokenRecall: 0,
      meanAbsoluteConfidenceCalibrationError: 0,
      highConfidenceSevereErrorRate: 0,
    });
    expect(Object.values(quality).every(Number.isFinite)).toBe(true);
  });
});

function recognized(text: string, confidencePermille: number): CommercialOcrPass {
  return {
    status: 'recognized',
    text,
    confidencePermille,
    criticalEvidence: [],
  };
}

function qualityFixture(params?: {
  transcript?: string;
  criticalTokens?: CommercialOcrEvalCaseV2['images'][number]['criticalTokens'];
}): CommercialOcrEvalCaseV2 {
  const transcript = params?.transcript ?? 'Ремонт окон, телефон +7 999 123-45-67';
  const criticalTokens = params?.criticalTokens ?? [
    { kind: 'commercial_anchor' as const, value: 'Ремонт' },
    { kind: 'phone' as const, value: '+79991234567' },
  ];
  const expectations = [
    {
      settingsProfileId: 'balanced-45-65',
      expectedCommercialAction: 'NO_ACTION' as const,
      expectedEnforcementAction: 'NO_ACTION' as const,
    },
  ];
  return {
    id: 'quality-case-1',
    clusterId: 'quality-cluster-1',
    split: 'development',
    language: 'ru',
    captionLanguage: 'none',
    category: 'quality',
    statisticsRepresentative: false,
    expectations,
    caption: '',
    annotation: {
      annotatorIds: ['reviewer-a', 'reviewer-b'],
      adjudication: 'agreement',
      reviewedAt: '2026-08-09T00:00:00.000Z',
      reviewerDecisions: [
        {
          reviewerId: 'reviewer-a',
          evidenceSha256: 'a'.repeat(64),
          commercialSubtype: null,
          expectations,
        },
        {
          reviewerId: 'reviewer-b',
          evidenceSha256: 'b'.repeat(64),
          commercialSubtype: null,
          expectations,
        },
      ],
    },
    images: [
      {
        path: 'quality.png',
        sha256: 'c'.repeat(64),
        source: 'direct',
        imageTextScript: 'cyrillic_only',
        transcript,
        visualConditions: ['clean'],
        criticalTokens,
      },
    ],
  };
}
