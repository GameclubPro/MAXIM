import { createHash } from 'node:crypto';
import { COMMERCIAL_CORPUS_PROVENANCE_VERSION } from './commercial-corpus-provenance';
import {
  analyzeCommercialCorpusRecords,
  COMMERCIAL_CORPUS_AUTO_LABEL_SOURCE,
  COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE,
  DEFAULT_COMMERCIAL_CORPUS_GATES,
  type CommercialCorpusRecord,
  validateCommercialCorpusRecords,
} from './validate-commercial-corpus';

let sampleSequence = 0;
const sanitizedText = 'Проверочный текст без персональных данных';

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
  const sampleId = `sample-${++sampleSequence}`;
  return {
    label: params.label,
    labelSource: params.labelSource ?? COMMERCIAL_CORPUS_AUTO_LABEL_SOURCE,
    expectedAction: params.expectedAction,
    expectedDisposition:
      params.expectedAction === 'ALLOW' || params.expectedAction === 'REVIEW_ONLY'
        ? 'KEEP'
        : 'DELETE',
    reviewProvenance: {
      schemaVersion: COMMERCIAL_CORPUS_PROVENANCE_VERSION,
      datasetRole: 'HOLDOUT',
      datasetId: 'holdout-dataset',
      sampleId,
      sourceSnapshotSha256: createHash('sha256').update(sampleId).digest('hex'),
      authorGroupId: `author-${sampleId}`,
      campaignGroupId: `campaign-${sampleId}`,
      messageCreatedAt: '2026-08-12T08:00:00.000Z',
      labelAuthorId: 'label-author',
      reviewerIds: ['reviewer-one', 'reviewer-two'],
      reviewedAt: '2026-08-13T08:00:00.000Z',
      reviewedTextSha256: createHash('sha256').update(sanitizedText).digest('hex'),
    },
    expectedSubtype:
      params.expectedSubtype ?? (params.label === 'positive_candidate' ? 'SERVICES' : null),
    isHardNegative: params.isHardNegative ?? false,
    policyCategory: params.policyCategory ?? 'none',
    segment: 'SERVICES',
    safeContextBucket: 'none',
    text: sanitizedText,
    current: {
      hit: params.action !== null,
      actionBand: params.action,
      actionable:
        params.action === 'WARN' ||
        params.action === 'DELETE' ||
        params.action === 'DELETE_AND_ESCALATE',
      messageDisposition:
        params.action === 'WARN' ||
        params.action === 'DELETE' ||
        params.action === 'DELETE_AND_ESCALATE'
          ? 'DELETE'
          : 'KEEP',
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
  holdoutCutoffAt: '2026-08-01T00:00:00.000Z',
  developmentRecords: [
    {
      reviewProvenance: {
        schemaVersion: COMMERCIAL_CORPUS_PROVENANCE_VERSION,
        datasetRole: 'DEVELOPMENT',
        datasetId: 'development-dataset',
        sampleId: 'development-sample',
        sourceSnapshotSha256: 'd'.repeat(64),
        authorGroupId: 'development-author',
        campaignGroupId: 'development-campaign',
        messageCreatedAt: '2026-07-31T00:00:00.000Z',
      },
    },
  ],
};

describe('commercial corpus trust-aware validation', () => {
  it('counts legacy WARN as cleanup and rejects explicit KEEP mismatches without rewriting labels', () => {
    const kept = corpusRecord({
      label: 'positive_candidate',
      labelSource: COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE,
      expectedAction: 'WARN',
      action: 'WARN',
    });
    (kept.current as Record<string, unknown>).messageDisposition = 'KEEP';
    const warned = corpusRecord({
      label: 'negative_candidate',
      labelSource: COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE,
      expectedAction: 'ALLOW',
      action: 'WARN',
    });
    const result = analyzeCommercialCorpusRecords([kept, warned]);
    expect(result.metrics.trustedManualNegativeDeleteCount).toBe(1);
    expect(result.metrics.trustedManualNegativeEnforcementCount).toBe(1);
    expect(result.metrics.trustedManualDispositionMismatchCount).toBe(2);
    expect(kept.expectedDisposition).toBe('DELETE');
  });

  it('cannot certify a manual label string without frozen provenance and expected disposition', () => {
    const record = corpusRecord({
      label: 'positive_candidate',
      labelSource: COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE,
      expectedAction: 'WARN',
      action: 'WARN',
    });
    delete record.expectedDisposition;
    delete record.reviewProvenance;
    const result = validateCommercialCorpusRecords([record], {
      ...SMALL_CORPUS_GATES,
      qualityGate: true,
    });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'holdout line 1: valid HOLDOUT reviewProvenance with frozen source identity is required',
        'line 1: quality gate requires independently labelled expectedDisposition KEEP/DELETE',
      ]),
    );
  });
  it('requires independent positive and negative labels in quality-gate mode', () => {
    const records = [
      corpusRecord({ label: 'positive_candidate', expectedAction: 'WARN', action: 'WARN' }),
      corpusRecord({ label: 'negative_candidate', expectedAction: 'ALLOW', action: null }),
    ];
    expect(validateCommercialCorpusRecords(records, SMALL_CORPUS_GATES).errors).toEqual([]);
    expect(
      validateCommercialCorpusRecords(records, { ...SMALL_CORPUS_GATES, qualityGate: true }).errors,
    ).toEqual(
      expect.arrayContaining([
        'quality_gate_trusted_positive_candidate=0 below min=1',
        'quality_gate_trusted_negative_candidate=0 below min=1',
      ]),
    );
    for (const record of records)
      record.labelSource = COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE;
    expect(
      validateCommercialCorpusRecords(records, { ...SMALL_CORPUS_GATES, qualityGate: true }).errors,
    ).toEqual([]);
  });

  it('does not certify a private corpus with residual contact candidates', () => {
    const record = corpusRecord({
      label: 'negative_candidate',
      expectedAction: 'ALLOW',
      action: null,
      labelSource: COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE,
    });
    record.text = 'Код заказа 89000001042 12345';
    expect(
      validateCommercialCorpusRecords([record], { ...SMALL_CORPUS_GATES, qualityGate: true })
        .errors,
    ).toContain('quality_gate_residual_contact_candidates=1');
  });

  it('rejects auto-label quality claims when sanitization changes the original decision', () => {
    const record = corpusRecord({
      label: 'negative_candidate',
      expectedAction: 'ALLOW',
      action: null,
    });
    record.sanitizedBaseline = { hit: true, actionBand: 'WARN', primarySubtype: 'SERVICES' };
    const analysis = analyzeCommercialCorpusRecords([record]);
    expect(analysis.metrics.autoLabelSanitizationDriftCount).toBe(1);
    expect(analysis.metrics.autoNegativeCount).toBe(0);
    expect(
      validateCommercialCorpusRecords([record], {
        ...SMALL_CORPUS_GATES,
        requireSanitizationParity: true,
      }).errors,
    ).toContain('auto_label_sanitization_drift=1; independent manual labels are required');
  });

  it('allows independently reviewed sanitized decisions despite original action drift', () => {
    const record = corpusRecord({
      label: 'positive_candidate',
      labelSource: COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE,
      expectedAction: 'WARN',
      action: 'WARN',
    });
    record.sanitizedBaseline = record.current;
    record.current = { hit: false, actionBand: null, primarySubtype: null };
    expect(analyzeCommercialCorpusRecords([record]).errors).toEqual([]);
  });

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
    expect(result.metrics.trustedManualDispositionMismatchCount).toBe(2);
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
