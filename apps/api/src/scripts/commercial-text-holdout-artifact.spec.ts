import { createHash } from 'node:crypto';
import { COMMERCIAL_CORPUS_PROVENANCE_VERSION } from './commercial-corpus-provenance';
import {
  commercialWilson95,
  COMMERCIAL_TEXT_HOLDOUT_ARTIFACT_SCHEMA_VERSION,
  COMMERCIAL_TEXT_PROMOTABLE_COHORT,
  validateCommercialTextHoldoutArtifact,
  type CommercialTextHoldoutArtifact,
  type CommercialTextHoldoutRecord,
} from './commercial-text-holdout-artifact';
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
});
