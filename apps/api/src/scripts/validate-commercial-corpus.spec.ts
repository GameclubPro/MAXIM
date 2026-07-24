import {
  analyzeCommercialCorpusRecords,
  COMMERCIAL_CORPUS_AUTO_LABEL_SOURCE,
  COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE,
  DEFAULT_COMMERCIAL_CORPUS_GATES,
  type CommercialCorpusRecord,
  validateCommercialCorpusRecords,
} from './validate-commercial-corpus';

function corpusRecord(params: {
  label: 'positive_candidate' | 'negative_candidate' | 'gray_candidate';
  labelSource?: string;
  expectedAction: 'ALLOW' | 'REVIEW_ONLY' | 'WARN' | 'DELETE' | 'DELETE_AND_ESCALATE';
  action: null | 'REVIEW_ONLY' | 'WARN' | 'DELETE' | 'DELETE_AND_ESCALATE';
  policyCategory?: string;
  expectedSubtype?: string | null;
  currentSubtype?: string | null;
  isHardNegative?: boolean;
}): CommercialCorpusRecord {
  return {
    label: params.label,
    labelSource: params.labelSource ?? COMMERCIAL_CORPUS_AUTO_LABEL_SOURCE,
    expectedAction: params.expectedAction,
    expectedSubtype:
      params.expectedSubtype ?? (params.label === 'positive_candidate' ? 'SERVICES' : null),
    isHardNegative: params.isHardNegative ?? false,
    policyCategory: params.policyCategory ?? 'none',
    segment: 'SERVICES',
    safeContextBucket: 'none',
    text: 'Проверочный текст без персональных данных',
    current: {
      hit: params.action !== null,
      actionBand: params.action,
      primarySubtype: params.currentSubtype ?? (params.action ? 'SERVICES' : null),
      subtype: params.currentSubtype ?? (params.action ? 'SERVICES' : null),
    },
    historical: {
      hit: false,
      actionBand: null,
      primarySubtype: null,
      subtype: null,
    },
  };
}

const SMALL_CORPUS_GATES = {
  ...DEFAULT_COMMERCIAL_CORPUS_GATES,
  minPositive: 0,
  minNegative: 0,
  minGray: 0,
  minHardRecall: 0,
  minEnforcementRecall: 0,
  maxFalsePositiveRate: 1,
  minSubtypeAccuracy: 0,
};

describe('commercial corpus trust-aware validation', () => {
  it('measures auto-label recall without enforcing the stale exact action rank', () => {
    const result = analyzeCommercialCorpusRecords([
      corpusRecord({
        label: 'positive_candidate',
        expectedAction: 'DELETE',
        action: 'WARN',
      }),
      corpusRecord({
        label: 'negative_candidate',
        expectedAction: 'ALLOW',
        action: 'WARN',
        isHardNegative: true,
      }),
    ]);

    expect(result.errors).toEqual([]);
    expect(result.metrics.autoPositiveDetectionRecall).toBe(1);
    expect(result.metrics.autoPositiveEnforcementRecall).toBe(1);
    expect(result.metrics.autoNegativeEnforcementCount).toBe(1);
    expect(result.metrics.trustedManualActionMismatchCount).toBe(0);
    expect(result.metrics.trustedManualHardNegativeNonAllowCount).toBe(0);
  });

  it('gates enforcement recall separately from detection recall', () => {
    const result = validateCommercialCorpusRecords(
      [
        corpusRecord({
          label: 'positive_candidate',
          expectedAction: 'WARN',
          action: 'REVIEW_ONLY',
        }),
      ],
      {
        ...SMALL_CORPUS_GATES,
        minHardRecall: 1,
        minEnforcementRecall: 1,
      },
    );

    expect(result.metrics.autoPositiveDetectionRecall).toBe(1);
    expect(result.metrics.autoPositiveEnforcementRecall).toBe(0);
    expect(result.errors).not.toContain('auto_positive_detection_recall=0 below min=1');
    expect(result.errors).toContain('auto_positive_enforcement_recall=0 below min=1');
  });

  it('marks trusted-manual negative gates as not evaluated for an automatic-only corpus', () => {
    const result = validateCommercialCorpusRecords(
      [
        corpusRecord({
          label: 'positive_candidate',
          expectedAction: 'WARN',
          action: 'WARN',
        }),
        corpusRecord({
          label: 'negative_candidate',
          expectedAction: 'ALLOW',
          action: null,
        }),
      ],
      SMALL_CORPUS_GATES,
    );

    expect(result.errors).toEqual([]);
    expect(result.metrics.trustedManualNegativeCount).toBe(0);
    expect(Number.isNaN(result.metrics.trustedManualEnforcementFalsePositiveRate)).toBe(true);
    expect(result.diagnostics).toContain(
      'trusted_manual_negative_gates=not_evaluated trusted_manual_negative_count=0',
    );
  });

  it('reports a zero trusted-manual false-positive rate only with a real negative denominator', () => {
    const result = validateCommercialCorpusRecords(
      [
        corpusRecord({
          label: 'positive_candidate',
          expectedAction: 'WARN',
          action: 'WARN',
        }),
        corpusRecord({
          label: 'negative_candidate',
          labelSource: COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE,
          expectedAction: 'ALLOW',
          action: null,
        }),
      ],
      SMALL_CORPUS_GATES,
    );

    expect(result.errors).toEqual([]);
    expect(result.metrics.trustedManualNegativeCount).toBe(1);
    expect(result.metrics.trustedManualEnforcementFalsePositiveRate).toBe(0);
    expect(result.diagnostics).toEqual([]);
  });

  it('enforces trusted manual actions and negatives while treating REVIEW_ONLY as non-enforcement', () => {
    const result = validateCommercialCorpusRecords(
      [
        corpusRecord({
          label: 'positive_candidate',
          expectedAction: 'WARN',
          action: 'WARN',
        }),
        corpusRecord({
          label: 'positive_candidate',
          labelSource: COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE,
          expectedAction: 'DELETE',
          action: 'WARN',
        }),
        corpusRecord({
          label: 'negative_candidate',
          labelSource: COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE,
          expectedAction: 'ALLOW',
          action: 'REVIEW_ONLY',
        }),
        corpusRecord({
          label: 'negative_candidate',
          labelSource: COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE,
          expectedAction: 'ALLOW',
          action: 'WARN',
        }),
        corpusRecord({
          label: 'gray_candidate',
          labelSource: COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE,
          expectedAction: 'REVIEW_ONLY',
          action: 'WARN',
          policyCategory: 'campaign_only',
          expectedSubtype: 'SERVICES',
        }),
      ],
      {
        ...SMALL_CORPUS_GATES,
        maxFalsePositiveRate: 0.4,
      },
    );

    expect(result.metrics.trustedManualActionMismatchCount).toBe(1);
    expect(result.metrics.trustedManualNegativeHitCount).toBe(2);
    expect(result.metrics.trustedManualNegativeEnforcementCount).toBe(1);
    expect(result.metrics.trustedManualEnforcementFalsePositiveRate).toBe(0.5);
    expect(result.diagnostics).toEqual([]);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'trusted_manual_action_mismatch_count=1',
        'trusted_manual_enforcement_false_positive_rate=0.5 above max=0.4',
        'trusted_manual_negative_enforcement_count=1',
      ]),
    );
  });

  it('rejects campaign-only delete and unknown label provenance', () => {
    const result = analyzeCommercialCorpusRecords([
      corpusRecord({
        label: 'gray_candidate',
        expectedAction: 'WARN',
        action: 'DELETE',
        policyCategory: 'campaign_only',
        expectedSubtype: 'SERVICES',
      }),
      corpusRecord({
        label: 'negative_candidate',
        labelSource: 'unreviewed-import',
        expectedAction: 'ALLOW',
        action: null,
      }),
    ]);

    expect(result.metrics.campaignOnlyDeleteCount).toBe(1);
    expect(result.errors).toContain('line 2: unknown labelSource unreviewed-import');
  });
});
