import { createHash } from 'node:crypto';
import { COMMERCIAL_CORPUS_PROVENANCE_VERSION } from './commercial-corpus-provenance';
import {
  commercialWilson95,
  commercialPairedImprovement,
  COMMERCIAL_TEXT_HOLDOUT_ARTIFACT_SCHEMA_VERSION,
  COMMERCIAL_TEXT_PROMOTABLE_COHORT,
  COMMERCIAL_TEXT_QUALITY_REQUIRED_PROFILES,
  validateCommercialTextHoldoutArtifact,
  validateCommercialTextQualityCompanionArtifacts,
  type CommercialTextHoldoutArtifact,
  type CommercialTextHoldoutRecord,
} from './commercial-text-holdout-artifact';
import {
  COMMERCIAL_INTENT_QUALITY_COHORT,
  COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
} from '../moderation/commercial/commercial-policy-cohorts';
import { COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE } from './validate-commercial-corpus';

const text = 'Проверочный текст без персональных данных';
const expected = {
  detectorSourceSha256: 'a'.repeat(64),
  decisionVersion: 'commercial-v5',
  settingsProfileDigest: 'b'.repeat(64),
  now: Date.parse('2026-08-21T10:00:00.000Z'),
};

// Synthetic independent units exercise the validator; they are never an operator quality artifact.
function artifact(
  cohortId = COMMERCIAL_TEXT_PROMOTABLE_COHORT as string,
): CommercialTextHoldoutArtifact {
  const holdoutRecords: CommercialTextHoldoutRecord[] = [];
  const count = 5_200;
  for (let index = 0; index < count; index += 1) {
    const positive = index >= 5_000;
    const sampleId = `${cohortId}:${index}`;
    holdoutRecords.push({
      cohortId,
      label: positive ? 'positive_candidate' : 'negative_candidate',
      labelSource: COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE,
      expectedAction: positive ? 'WARN' : 'ALLOW',
      expectedDisposition: positive ? 'DELETE' : 'KEEP',
      expectedSubtype: positive ? 'SERVICES' : null,
      text,
      current: {
        hit: positive,
        actionBand: positive ? 'WARN' : null,
        actionable: positive,
        messageDisposition: positive ? 'DELETE' : 'KEEP',
        primarySubtype: positive ? 'SERVICES' : null,
      },
      reviewProvenance: {
        schemaVersion: COMMERCIAL_CORPUS_PROVENANCE_VERSION,
        datasetRole: 'HOLDOUT',
        datasetId: `holdout-${cohortId}`,
        sampleId,
        sourceSnapshotSha256: createHash('sha256').update(sampleId).digest('hex'),
        authorGroupId: `author:${sampleId}`,
        campaignGroupId: `campaign:${sampleId}`,
        messageCreatedAt: new Date(
          Date.parse('2026-08-12T00:00:00.000Z') +
            Math.floor((index / (count - 1)) * 8 * 86_400_000),
        ).toISOString(),
        labelAuthorId: 'label-author',
        reviewerIds: ['independent-reviewer-1', 'independent-reviewer-2'],
        reviewedAt: '2026-08-21T09:00:00.000Z',
        reviewedTextSha256: createHash('sha256').update(text).digest('hex'),
      },
    });
  }
  return {
    schemaVersion: COMMERCIAL_TEXT_HOLDOUT_ARTIFACT_SCHEMA_VERSION,
    detectorSourceSha256: expected.detectorSourceSha256,
    decisionVersion: expected.decisionVersion,
    settingsProfileDigest: expected.settingsProfileDigest,
    evaluatedAt: '2026-08-21T09:30:00.000Z',
    expiresAt: '2026-08-22T09:30:00.000Z',
    holdoutCutoffAt: '2026-08-01T00:00:00.000Z',
    minHoldoutGapHours: 24,
    cohorts: [cohortId],
    developmentRecords: [
      {
        reviewProvenance: {
          schemaVersion: COMMERCIAL_CORPUS_PROVENANCE_VERSION,
          datasetRole: 'DEVELOPMENT',
          datasetId: 'frozen-development',
          sampleId: 'development-1',
          sourceSnapshotSha256: 'd'.repeat(64),
          authorGroupId: 'development-author',
          campaignGroupId: 'development-campaign',
          messageCreatedAt: '2026-07-31T00:00:00.000Z',
        },
      },
    ],
    holdoutRecords,
  };
}

function qualityArtifact(): CommercialTextHoldoutArtifact {
  const value = artifact(COMMERCIAL_INTENT_QUALITY_COHORT);
  const rows = [...value.holdoutRecords];
  for (let index = 0; index < 300; index += 1) {
    const original = rows[5_000]!;
    const sampleId = `extra-quality-offer-${index}`;
    rows.push({
      ...original,
      reviewProvenance: {
        ...(original.reviewProvenance as Record<string, unknown>),
        sampleId,
        authorGroupId: `author:${sampleId}`,
        campaignGroupId: `campaign:${sampleId}`,
        sourceSnapshotSha256: createHash('sha256').update(sampleId).digest('hex'),
      },
    });
  }
  for (const [index, row] of rows.entries()) {
    row.releasedBaseline =
      index < 6
        ? { actionBand: 'WARN', actionable: true, messageDisposition: 'DELETE' }
        : index >= 5_000 && index < 5_006
          ? { actionBand: null, actionable: false, messageDisposition: 'KEEP' }
          : row.current;
    row.current = {
      ...(row.current as Record<string, unknown>),
      decisionVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
    };
    row.releasedBaseline = {
      ...(row.releasedBaseline as Record<string, unknown>),
      decisionVersion: 'commercial-deterministic-v5',
    };
    row.reviewProvenance = {
      ...(row.reviewProvenance as Record<string, unknown>),
      pseudonymizationKeyId: 'f'.repeat(64),
      randomEvaluationIncluded: true,
      samplingProbability: 0.1,
      sourceExcerptComplete: true,
      campaignGroupingComplete: true,
    };
  }
  const development = value.developmentRecords[0]!;
  const developmentReview = {
    ...(development.reviewProvenance as Record<string, unknown>),
    labelAuthorId: 'label-author',
    reviewerIds: ['independent-reviewer-1', 'independent-reviewer-2'],
    reviewedAt: '2026-07-31T09:00:00.000Z',
    reviewedTextSha256: createHash('sha256').update(text).digest('hex'),
    pseudonymizationKeyId: 'f'.repeat(64),
    campaignGroupingComplete: true,
    sourceExcerptComplete: true,
  };
  return {
    ...value,
    decisionVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
    holdoutRecords: rows,
    samplingDesign: {
      schemaVersion: 'commercial-quality-holdout-sampling/v1',
      frameId: 'frozen-frame',
      declaredAt: '2026-08-01T00:00:00.000Z',
      frameSourceSnapshotSha256: 'e'.repeat(64),
      selection: 'INDEPENDENT_PROBABILITY_SAMPLE',
      inclusionProbability: 0.1,
      expectedSamples: rows.length,
      complete: true,
    },
    developmentRecords: [
      { ...development, text, reviewProvenance: developmentReview },
      {
        ...development,
        text,
        reviewProvenance: {
          ...developmentReview,
          sampleId: 'development-2',
          sourceSnapshotSha256: 'e'.repeat(64),
          messageCreatedAt: '2026-07-24T00:00:00.000Z',
        },
      },
    ],
  };
}
const qualityExpected = {
  ...expected,
  decisionVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
};
function qualityPair(): CommercialTextHoldoutArtifact[] {
  const selected = {
    ...qualityArtifact(),
    settingsProfileDigest: COMMERCIAL_TEXT_QUALITY_REQUIRED_PROFILES[0]!.digest,
  };
  return [
    selected,
    {
      ...structuredClone(selected),
      settingsProfileDigest: COMMERCIAL_TEXT_QUALITY_REQUIRED_PROFILES[1]!.digest,
    },
  ];
}
const pairedExpected = {
  ...qualityExpected,
  settingsProfileDigest: COMMERCIAL_TEXT_QUALITY_REQUIRED_PROFILES[0]!.digest,
};

describe('commercial text frozen holdout promotion evidence', () => {
  it('recomputes grouped confidence bounds and permits only the evaluated current cohort', () => {
    const result = validateCommercialTextHoldoutArtifact(artifact(), expected);
    expect(result.errors).toEqual([]);
    expect(result.approvedCohorts).toEqual([COMMERCIAL_TEXT_PROMOTABLE_COHORT]);
    expect(result.cohortMetrics[0]).toMatchObject({
      protectedNegativeUnits: 5_000,
      offerUnits: 200,
      unexpectedDeleteUnits: 0,
    });
    expect(result.cohortMetrics[0]!.protectedNegativeFalsePositiveUpper95).toBeLessThan(0.001);
    expect(result.cohortMetrics[0]!.offerCleanupRecallLower95).toBeGreaterThan(0.95);
  });

  it('counts a negative WARN cleanup in the confidence gate', () => {
    const value = artifact();
    value.holdoutRecords[0]!.current = {
      hit: true,
      actionBand: 'WARN',
      actionable: true,
      messageDisposition: 'DELETE',
    };
    const result = validateCommercialTextHoldoutArtifact(value, expected);
    expect(result.approvedCohorts).toEqual([]);
    expect(result.cohortMetrics[0]?.unexpectedDeleteUnits).toBe(1);
    expect(result.errors.join('\n')).toContain('upper 95% confidence bound');
  });

  it('rejects source sample duplication, development overlap, self review, and changed reviewed text', () => {
    const value = artifact();
    const provenance = value.holdoutRecords[0]!.reviewProvenance as Record<string, unknown>;
    provenance.authorGroupId = 'development-author';
    provenance.campaignGroupId = 'development-campaign';
    provenance.reviewerIds = ['label-author', 'independent-reviewer-2'];
    value.holdoutRecords[0]!.text = 'Измененный текст после независимой проверки';
    value.holdoutRecords[1]!.reviewProvenance = { ...provenance };
    const result = validateCommercialTextHoldoutArtifact(value, expected);
    expect(result.approvedCohorts).toEqual([]);
    expect(result.errors.join('\n')).toContain('author group overlaps');
    expect(result.errors.join('\n')).toContain('campaign group overlaps');
    expect(result.errors.join('\n')).toContain('reviewers separate from the label author');
    expect(result.errors.join('\n')).toContain('reviewedTextSha256');
    expect(result.errors.join('\n')).toContain('duplicate holdout sample');
  });

  it('cannot inflate confidence with correlated campaign or author repeats', () => {
    const value = artifact();
    for (const row of value.holdoutRecords) {
      (row.reviewProvenance as Record<string, unknown>).authorGroupId = 'one-repeating-author';
    }
    const result = validateCommercialTextHoldoutArtifact(value, expected);
    expect(result.approvedCohorts).toEqual([]);
    expect(result.cohortMetrics[0]).toMatchObject({ protectedNegativeUnits: 1, offerUnits: 1 });
  });

  it('requires a full observed week and adequate offer recall', () => {
    const value = artifact();
    for (const row of value.holdoutRecords) {
      (row.reviewProvenance as Record<string, unknown>).messageCreatedAt =
        '2026-08-20T00:00:00.000Z';
    }
    for (const row of value.holdoutRecords.slice(5_000, 5_020)) {
      row.current = { hit: false, actionBand: null, actionable: false, messageDisposition: 'KEEP' };
    }
    const result = validateCommercialTextHoldoutArtifact(value, expected);
    expect(result.approvedCohorts).toEqual([]);
    expect(result.errors.join('\n')).toContain('at least seven days');
    expect(result.errors.join('\n')).toContain('recall lower 95% confidence bound');
  });

  it('requires each promoted cohort to pass its own independent evidence', () => {
    const value = artifact();
    const missing = validateCommercialTextHoldoutArtifact(
      { ...value, cohorts: [COMMERCIAL_TEXT_PROMOTABLE_COHORT, 'sliding-campaign-v1'] },
      expected,
    );
    expect(missing.approvedCohorts).toEqual([]);
    const sliding = artifact('sliding-campaign-v1');
    const complete = validateCommercialTextHoldoutArtifact(
      {
        ...value,
        cohorts: [COMMERCIAL_TEXT_PROMOTABLE_COHORT, 'sliding-campaign-v1'],
        holdoutRecords: [...value.holdoutRecords, ...sliding.holdoutRecords],
      },
      expected,
    );
    expect(complete.errors).toEqual([]);
    expect(complete.approvedCohorts).toEqual([
      COMMERCIAL_TEXT_PROMOTABLE_COHORT,
      'sliding-campaign-v1',
    ]);
  });

  it.each([
    { detectorSourceSha256: 'f'.repeat(64) },
    { decisionVersion: 'unknown' },
    { settingsProfileDigest: 'f'.repeat(64) },
    { expiresAt: '2026-08-21T09:45:00.000Z' },
    { evaluatedAt: '2026-08-19T09:30:00.000Z' },
    { cohorts: ['unknown'] },
  ])('returns no promotion on unknown, mismatched, or expired evidence %p', (override) => {
    expect(
      validateCommercialTextHoldoutArtifact({ ...artifact(), ...override }, expected)
        .approvedCohorts,
    ).toEqual([]);
  });

  it('does not report confidence without a real independent denominator', () => {
    expect(commercialWilson95(0, 0)).toBeNull();
    expect(commercialWilson95(2, 1)).toBeNull();
    expect(commercialWilson95(0, 5_000)?.upper).toBeLessThan(0.001);
    expect(validateCommercialTextHoldoutArtifact(null, expected).approvedCohorts).toEqual([]);
  });
  it('requires sufficient units, two observed weeks and both paired error reductions for the new cohort', () => {
    const value = qualityArtifact();
    const result = validateCommercialTextHoldoutArtifact(value, qualityExpected);
    expect(result.errors).toEqual([]);
    expect(result.approvedCohorts).toEqual([COMMERCIAL_INTENT_QUALITY_COHORT]);
    expect(result.cohortMetrics[0]).toMatchObject({
      offerUnits: 500,
      pairedFalsePositive: { improvedUnits: 6, regressedUnits: 0, significantReduction: true },
      pairedFalseNegative: { improvedUnits: 6, regressedUnits: 0, significantReduction: true },
    });
    for (const row of value.holdoutRecords)
      row.releasedBaseline = {
        ...(row.current as Record<string, unknown>),
        decisionVersion: 'commercial-deterministic-v5',
      };
    const unchanged = validateCommercialTextHoldoutArtifact(value, qualityExpected);
    expect(unchanged.approvedCohorts).toEqual([]);
    expect(unchanged.errors.join('\n')).toContain('paired significant reduction');
  });

  it('rejects aliases linking development campaigns and collapses connected campaign groups', () => {
    const overlap = qualityArtifact();
    (overlap.holdoutRecords[0]!.reviewProvenance as Record<string, unknown>).campaignGroupIds = [
      'development-campaign',
    ];
    expect(
      validateCommercialTextHoldoutArtifact(overlap, qualityExpected).errors.join('\n'),
    ).toContain('campaign group overlaps');
    const repeated = qualityArtifact();
    for (const row of repeated.holdoutRecords)
      (row.reviewProvenance as Record<string, unknown>).campaignGroupIds = ['one-contact-bridge'];
    const result = validateCommercialTextHoldoutArtifact(repeated, qualityExpected);
    expect(result.approvedCohorts).toEqual([]);
    expect(result.cohortMetrics[0]).toMatchObject({ protectedNegativeUnits: 1, offerUnits: 1 });
    expect(result.errors.join('\n')).toContain('4000 protected negative and 500 offer');
  });

  it('rejects a short development period, missing independent development reviews or a shortened gap', () => {
    const value = qualityArtifact();
    const result = validateCommercialTextHoldoutArtifact(
      {
        ...value,
        developmentRecords: value.developmentRecords.slice(0, 1),
        minHoldoutGapHours: 12,
      },
      qualityExpected,
    );
    expect(result.approvedCohorts).toEqual([]);
    expect(result.errors.join('\n')).toContain('development corpus spanning at least seven days');
    expect(result.errors.join('\n')).toContain('gap of at least 24 hours');
    (value.developmentRecords[0]!.reviewProvenance as Record<string, unknown>).reviewerIds = [
      'label-author',
    ];
    expect(
      validateCommercialTextHoldoutArtifact(value, qualityExpected).errors.join('\n'),
    ).toContain('development line 1: two distinct reviewers');
  });

  it('uses the exact paired test instead of treating a smaller raw count as proof', () => {
    expect(commercialPairedImprovement(5, 0).significantReduction).toBe(false);
    expect(commercialPairedImprovement(6, 0).oneSidedExactP).toBeCloseTo(1 / 64, 12);
    expect(commercialPairedImprovement(6, 0).significantReduction).toBe(true);
    expect(commercialPairedImprovement(20, 1).significantReduction).toBe(true);
    expect(commercialPairedImprovement(0, 0).significantReduction).toBe(false);
    expect(commercialPairedImprovement(3, 4).significantReduction).toBe(false);
  });
  it.each([
    'rotated-key',
    'missing-key',
    'capture-probability',
    'retrospective-selection',
    'truncated-source',
    'incomplete-frame',
  ])('rejects uncertifiable quality evidence: %s', (failure) => {
    const value = qualityArtifact();
    const review = value.holdoutRecords[0]!.reviewProvenance as Record<string, unknown>;
    if (failure === 'rotated-key') review.pseudonymizationKeyId = '1'.repeat(64);
    else if (failure === 'missing-key') delete review.pseudonymizationKeyId;
    else if (failure === 'capture-probability') review.samplingProbability = 1;
    else if (failure === 'retrospective-selection') review.randomEvaluationIncluded = false;
    else if (failure === 'truncated-source') review.sourceExcerptComplete = false;
    else (value.samplingDesign as Record<string, unknown>).complete = false;
    const result = validateCommercialTextHoldoutArtifact(value, qualityExpected);
    expect(result.approvedCohorts).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('requires both prescribed profiles before promotion while preserving the selected settings binding', () => {
    const values = qualityPair();
    expect(validateCommercialTextQualityCompanionArtifacts(values, pairedExpected)).toMatchObject({
      valid: true,
      approvedCohorts: [COMMERCIAL_INTENT_QUALITY_COHORT],
    });
    expect(
      validateCommercialTextQualityCompanionArtifacts(values.slice(0, 1), pairedExpected).valid,
    ).toBe(false);
    expect(
      validateCommercialTextQualityCompanionArtifacts([values[0], values[0]], pairedExpected).valid,
    ).toBe(false);
    expect(validateCommercialTextQualityCompanionArtifacts(values, qualityExpected).valid).toBe(
      false,
    );
    const custom = { ...values[0]!, settingsProfileDigest: expected.settingsProfileDigest };
    expect(
      validateCommercialTextQualityCompanionArtifacts([custom, ...values], qualityExpected).valid,
    ).toBe(true);
    expect(
      validateCommercialTextQualityCompanionArtifacts(
        [custom, values[0]],
        qualityExpected,
      ).errors.join('\n'),
    ).toContain('STRICT 38/55');
  });

  it('permits reordered frozen evidence and different valid detector predictions across profiles', () => {
    const values = qualityPair();
    const companion = values[1]!;
    const row = companion.holdoutRecords[10]!;
    row.current = { ...(row.current as Record<string, unknown>), actionBand: 'REVIEW_ONLY' };
    (row.reviewProvenance as Record<string, unknown>).reviewerIds = [
      'independent-reviewer-2',
      'independent-reviewer-1',
    ];
    (companion.holdoutRecords as CommercialTextHoldoutRecord[]).reverse();
    (companion.developmentRecords as CommercialTextHoldoutRecord[]).reverse();
    expect(validateCommercialTextQualityCompanionArtifacts(values, pairedExpected).errors).toEqual(
      [],
    );
  });

  it.each([
    'source-version',
    'policy-version',
    'cutoff',
    'sampling-frame',
    'development-source',
    'holdout-source',
    'reviewer',
    'campaign',
    'source-text',
    'future-provenance',
    'future-header-provenance',
    'companion-expired',
    'quality-regression',
    'duplicate-development',
  ])('fails closed on companion disagreement or incomplete independent evidence: %s', (failure) => {
    const values = qualityPair();
    let companion = values[1]!;
    const row = companion.holdoutRecords[10]!;
    const provenance = row.reviewProvenance as Record<string, unknown>;
    if (failure === 'source-version')
      companion = { ...companion, detectorSourceSha256: '0'.repeat(64) };
    else if (failure === 'policy-version')
      companion = { ...companion, decisionVersion: 'commercial-deterministic-v5' };
    else if (failure === 'cutoff')
      companion = { ...companion, holdoutCutoffAt: '2026-08-02T00:00:00.000Z' };
    else if (failure === 'sampling-frame')
      (companion.samplingDesign as Record<string, unknown>).frameId = 'different-frame';
    else if (failure === 'development-source')
      (
        companion.developmentRecords[0]!.reviewProvenance as Record<string, unknown>
      ).sourceSnapshotSha256 = '0'.repeat(64);
    else if (failure === 'holdout-source') provenance.sourceSnapshotSha256 = '0'.repeat(64);
    else if (failure === 'reviewer')
      provenance.reviewerIds = ['other-independent-reviewer', 'independent-reviewer-2'];
    else if (failure === 'campaign') provenance.campaignGroupIds = ['additional-campaign-alias'];
    else if (failure === 'source-text') {
      row.text = 'Другой независимо проверенный источник';
      provenance.reviewedTextSha256 = createHash('sha256')
        .update(row.text as string)
        .digest('hex');
    } else if (failure === 'future-provenance')
      provenance.futureEvidence = 'different-private-source';
    else if (failure === 'future-header-provenance')
      companion = {
        ...companion,
        futureEvidence: 'different-private-source',
      } as CommercialTextHoldoutArtifact;
    else if (failure === 'companion-expired')
      companion = { ...companion, expiresAt: '2026-08-21T09:59:00.000Z' };
    else if (failure === 'duplicate-development')
      companion = {
        ...companion,
        developmentRecords: [...companion.developmentRecords, companion.developmentRecords[0]!],
      };
    else
      row.current = {
        ...(row.current as Record<string, unknown>),
        hit: true,
        actionable: true,
        actionBand: 'WARN',
        messageDisposition: 'DELETE',
      };
    values[1] = companion;
    const result = validateCommercialTextQualityCompanionArtifacts(values, pairedExpected);
    expect(result.valid).toBe(false);
    expect(result.approvedCohorts).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
