import { createHash } from 'node:crypto';
import { isCommercialMessageDeleteEligible } from '../moderation/commercial/commercial-action-policy';
import { fingerprintCommercialTextSettingsProfile } from '../moderation/commercial/commercial-text-runtime-policy.service';
import {
  validateCommercialHoldoutProvenance,
  type CommercialCorpusReviewProvenance,
  commercialProvenanceCampaignGroups,
} from './commercial-corpus-provenance';
import {
  COMMERCIAL_INTENT_QUALITY_COHORT,
  COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
  COMMERCIAL_TEXT_POLICY_COHORTS,
} from '../moderation/commercial/commercial-policy-cohorts';
import { COMMERCIAL_ENGINE_CONFIG } from '../moderation/commercial/commercial-config';
import {
  analyzeCommercialCorpusRecords,
  COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE,
  type CommercialCorpusRecord,
} from './validate-commercial-corpus';

export const COMMERCIAL_TEXT_HOLDOUT_ARTIFACT_SCHEMA_VERSION =
  'commercial-text-holdout/v1' as const;
export const COMMERCIAL_TEXT_PROMOTABLE_COHORT = 'owned-service-contrast-v1' as const;
export const COMMERCIAL_TEXT_PROMOTABLE_COHORTS = COMMERCIAL_TEXT_POLICY_COHORTS;
export const COMMERCIAL_TEXT_QUALITY_REQUIRED_PROFILES = [
  { sensitivity: 'BALANCED' as const, warn: 45, remove: 65 },
  { sensitivity: 'STRICT' as const, warn: 38, remove: 55 },
].map((profile) => ({
  ...profile,
  digest: fingerprintCommercialTextSettingsProfile({
    commercialAdsSensitivity: profile.sensitivity,
    commercialAdsWarnThreshold: profile.warn,
    commercialAdsDeleteThreshold: profile.remove,
  }),
}));
const MAX_ARTIFACT_AGE_MS = 24 * 60 * 60_000;
const MIN_HOLDOUT_SPAN_MS = 7 * 24 * 60 * 60_000;
const MAX_CORPUS_ROWS = 100_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type CommercialTextHoldoutRecord = CommercialCorpusRecord & {
  cohortId?: unknown;
  releasedBaseline?: unknown;
};

export type CommercialTextHoldoutArtifact = Readonly<{
  schemaVersion: typeof COMMERCIAL_TEXT_HOLDOUT_ARTIFACT_SCHEMA_VERSION;
  detectorSourceSha256: string;
  decisionVersion: string;
  settingsProfileDigest: string;
  evaluatedAt: string;
  expiresAt: string;
  holdoutCutoffAt: string;
  minHoldoutGapHours: number;
  cohorts: readonly string[];
  developmentRecords: readonly CommercialCorpusRecord[];
  holdoutRecords: readonly CommercialTextHoldoutRecord[];
  samplingDesign?: Readonly<{
    schemaVersion: 'commercial-quality-holdout-sampling/v1';
    frameId: string;
    declaredAt: string;
    frameSourceSnapshotSha256: string;
    selection: 'INDEPENDENT_PROBABILITY_SAMPLE';
    inclusionProbability: number;
    expectedSamples: number;
    complete: true;
  }>;
}>;

export type CommercialTextHoldoutCohortMetrics = Readonly<{
  cohortId: string;
  samples: number;
  holdoutSpanMs: number;
  protectedNegativeUnits: number;
  unexpectedDeleteUnits: number;
  protectedNegativeFalsePositiveUpper95: number | null;
  offerUnits: number;
  cleanedOfferUnits: number;
  offerCleanupRecallLower95: number | null;
  pairedFalsePositive?: CommercialPairedImprovement;
  pairedFalseNegative?: CommercialPairedImprovement;
}>;

export type CommercialPairedImprovement = Readonly<{
  improvedUnits: number;
  regressedUnits: number;
  oneSidedExactP: number;
  significantReduction: boolean;
}>;

export type CommercialTextHoldoutValidationResult = Readonly<{
  valid: boolean;
  approvedCohorts: readonly string[];
  errors: readonly string[];
  cohortMetrics: readonly CommercialTextHoldoutCohortMetrics[];
}>;

// FLAG: A frozen, independently reviewed artifact SHA is a separate operator requirement.
// Passing this validator checks its declared provenance and recalculated quality, not human truth.
// Missing/expired/unknown evidence always returns no promoted cohorts.
export function validateCommercialTextHoldoutArtifact(
  value: unknown,
  expected: Readonly<{
    detectorSourceSha256: string;
    decisionVersion: string;
    settingsProfileDigest: string;
    now?: number;
  }>,
): CommercialTextHoldoutValidationResult {
  const errors: string[] = [];
  const cohortMetrics: CommercialTextHoldoutCohortMetrics[] = [];
  const artifact = asRecord(value);
  if (!artifact || artifact.schemaVersion !== COMMERCIAL_TEXT_HOLDOUT_ARTIFACT_SCHEMA_VERSION) {
    return result(['Unsupported commercial text holdout artifact schema'], cohortMetrics);
  }
  if (
    !SHA256_PATTERN.test(expected.detectorSourceSha256) ||
    artifact.detectorSourceSha256 !== expected.detectorSourceSha256 ||
    typeof expected.decisionVersion !== 'string' ||
    !expected.decisionVersion.trim() ||
    artifact.decisionVersion !== expected.decisionVersion ||
    !SHA256_PATTERN.test(expected.settingsProfileDigest) ||
    artifact.settingsProfileDigest !== expected.settingsProfileDigest
  ) {
    errors.push(
      'Holdout artifact does not match the current detector, decision version, and exact settings profile',
    );
  }
  const now = expected.now ?? Date.now();
  const evaluatedAtMs = readIsoTimestamp(artifact.evaluatedAt);
  const expiresAtMs = readIsoTimestamp(artifact.expiresAt);
  if (
    !Number.isSafeInteger(now) ||
    evaluatedAtMs === null ||
    expiresAtMs === null ||
    evaluatedAtMs > now ||
    now - evaluatedAtMs > MAX_ARTIFACT_AGE_MS ||
    expiresAtMs <= now ||
    expiresAtMs <= evaluatedAtMs ||
    expiresAtMs - evaluatedAtMs > MAX_ARTIFACT_AGE_MS
  ) {
    errors.push('Holdout artifact must be current, unexpired, and valid for at most 24 hours');
  }
  const cohorts = artifact.cohorts;
  if (
    !Array.isArray(cohorts) ||
    cohorts.length < 1 ||
    cohorts.length > COMMERCIAL_TEXT_PROMOTABLE_COHORTS.length ||
    new Set(cohorts).size !== cohorts.length ||
    cohorts.some(
      (cohort) =>
        !COMMERCIAL_TEXT_PROMOTABLE_COHORTS.includes(
          cohort as (typeof COMMERCIAL_TEXT_PROMOTABLE_COHORTS)[number],
        ),
    )
  ) {
    errors.push('Holdout artifact contains an unknown or empty promotion cohort');
  }
  const development = readRows(artifact.developmentRecords);
  const holdout = readRows(artifact.holdoutRecords);
  if (!development || !holdout) {
    errors.push(
      'Holdout artifact requires bounded non-empty developmentRecords and holdoutRecords',
    );
    return result(errors, cohortMetrics);
  }
  if (holdout.some((row) => row.labelSource !== COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE)) {
    errors.push('Every holdout row requires an independent manual label');
  }
  const analysis = analyzeCommercialCorpusRecords(holdout);
  errors.push(...analysis.errors);
  const provenance = validateCommercialHoldoutProvenance({
    holdoutRecords: holdout,
    developmentRecords: development,
    holdoutCutoffAt:
      typeof artifact.holdoutCutoffAt === 'string' ? artifact.holdoutCutoffAt : undefined,
    minHoldoutGapHours:
      typeof artifact.minHoldoutGapHours === 'number' ? artifact.minHoldoutGapHours : Number.NaN,
    requireDevelopmentReviews:
      Array.isArray(cohorts) && cohorts.includes(COMMERCIAL_INTENT_QUALITY_COHORT),
  });
  errors.push(...provenance.errors);
  if (Array.isArray(cohorts) && cohorts.includes(COMMERCIAL_INTENT_QUALITY_COHORT)) {
    if (
      [...development, ...holdout].some((row) => {
        const review = row.reviewProvenance as CommercialCorpusReviewProvenance;
        return review?.campaignGroupingComplete !== true || review?.sourceExcerptComplete !== true;
      })
    )
      errors.push(
        'Intent quality development and holdout require complete source excerpts and campaign grouping',
      );
    const design = asRecord(artifact.samplingDesign);
    const declaredAt = readIsoTimestamp(design?.declaredAt);
    const cutoff = readIsoTimestamp(artifact.holdoutCutoffAt);
    if (
      !design ||
      design.schemaVersion !== 'commercial-quality-holdout-sampling/v1' ||
      typeof design.frameId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(design.frameId) ||
      typeof design.frameSourceSnapshotSha256 !== 'string' ||
      !SHA256_PATTERN.test(design.frameSourceSnapshotSha256) ||
      design.selection !== 'INDEPENDENT_PROBABILITY_SAMPLE' ||
      design.complete !== true ||
      design.expectedSamples !== holdout.length ||
      declaredAt === null ||
      cutoff === null ||
      declaredAt > cutoff ||
      typeof design.inclusionProbability !== 'number' ||
      !Number.isFinite(design.inclusionProbability) ||
      design.inclusionProbability <= 0 ||
      design.inclusionProbability > 1
    )
      errors.push(
        'Intent quality promotion requires a complete predeclared independent probability samplingDesign',
      );
    if (
      holdout.some(
        (row) =>
          (row.reviewProvenance as CommercialCorpusReviewProvenance)?.samplingProbability !==
          design?.inclusionProbability,
      )
    )
      errors.push(
        'Intent quality holdout probability must be the uniform evaluation sampling probability, not hit/no-hit capture probability',
      );
    const keyIds = new Set(
      [...development, ...holdout].map(
        (row) => (row.reviewProvenance as CommercialCorpusReviewProvenance)?.pseudonymizationKeyId,
      ),
    );
    if (
      keyIds.size !== 1 ||
      [...keyIds].some((key) => typeof key !== 'string' || !SHA256_PATTERN.test(key))
    )
      errors.push(
        'Intent quality promotion requires one nonmissing pseudonymizationKeyId across development and holdout',
      );
    const developmentDates = development.map((row) =>
      Date.parse((row.reviewProvenance as CommercialCorpusReviewProvenance)?.messageCreatedAt),
    );
    if (
      developmentDates.some((date) => !Number.isFinite(date)) ||
      Math.max(...developmentDates) - Math.min(...developmentDates) < MIN_HOLDOUT_SPAN_MS
    )
      errors.push(
        'Intent quality promotion requires a development corpus spanning at least seven days',
      );
    if (typeof artifact.minHoldoutGapHours !== 'number' || artifact.minHoldoutGapHours < 24)
      errors.push('Intent quality promotion requires a holdout gap of at least 24 hours');
  }
  for (const [index, row] of holdout.entries()) {
    const snapshot = asRecord(row.sanitizedBaseline ?? row.current);
    if (
      (row.expectedDisposition !== 'KEEP' && row.expectedDisposition !== 'DELETE') ||
      !snapshot ||
      typeof snapshot.actionable !== 'boolean' ||
      (snapshot.messageDisposition !== 'KEEP' && snapshot.messageDisposition !== 'DELETE')
    ) {
      errors.push(
        `holdout line ${index + 1}: explicit expectedDisposition and actual cleanup decision are required`,
      );
    }
    if (row.label === 'negative_candidate' && row.expectedDisposition !== 'KEEP') {
      errors.push(`holdout line ${index + 1}: a protected negative must be labelled KEEP`);
    }
    if (!Array.isArray(cohorts) || !cohorts.includes(row.cohortId)) {
      errors.push(`holdout line ${index + 1}: unknown cohort`);
    }
    if (row.cohortId === COMMERCIAL_INTENT_QUALITY_COHORT) {
      const baseline = asRecord(row.releasedBaseline);
      if (
        !baseline ||
        typeof baseline.actionable !== 'boolean' ||
        !['KEEP', 'DELETE'].includes(String(baseline.messageDisposition))
      )
        errors.push(
          `holdout line ${index + 1}: quality cohort requires the frozen releasedBaseline cleanup snapshot`,
        );
      if (
        baseline?.decisionVersion !== COMMERCIAL_ENGINE_CONFIG.decisionVersion ||
        snapshot?.decisionVersion !== COMMERCIAL_INTENT_QUALITY_DECISION_VERSION
      )
        errors.push(
          `holdout line ${index + 1}: released and candidate snapshots require their exact policy versions`,
        );
      const review = row.reviewProvenance as CommercialCorpusReviewProvenance;
      // FLAG: All-hit plus 10% no-hit discovery is biased. Only the predeclared random
      // evaluation frame (chosen before either decision/review) may supply these denominators.
      if (
        review.randomEvaluationIncluded !== true ||
        review.sourceExcerptComplete !== true ||
        review.campaignGroupingComplete !== true ||
        typeof review.samplingProbability !== 'number' ||
        !Number.isFinite(review.samplingProbability) ||
        review.samplingProbability <= 0 ||
        review.samplingProbability > 1
      )
        errors.push(
          `holdout line ${index + 1}: quality evidence requires the complete preselected random evaluation frame and a valid capture probability`,
        );
    }
    const review = asRecord(row.reviewProvenance);
    const sourceAtMs = readIsoTimestamp(review?.messageCreatedAt);
    const reviewedAtMs = readIsoTimestamp(review?.reviewedAt);
    if (
      evaluatedAtMs !== null &&
      (sourceAtMs === null ||
        reviewedAtMs === null ||
        sourceAtMs > evaluatedAtMs ||
        reviewedAtMs > evaluatedAtMs)
    ) {
      errors.push(
        `holdout line ${index + 1}: source and independent review must precede evaluation`,
      );
    }
  }
  if (errors.length > 0) return result(errors, cohortMetrics);

  for (const cohortId of cohorts as string[]) {
    const metrics = summarizeCohort(
      holdout.filter((row) => row.cohortId === cohortId),
      cohortId,
    );
    cohortMetrics.push(metrics);
    if (
      cohortId === COMMERCIAL_INTENT_QUALITY_COHORT &&
      (metrics.protectedNegativeUnits < 4_000 || metrics.offerUnits < 500)
    )
      errors.push(
        `${cohortId}: at least 4000 protected negative and 500 offer independent units are required`,
      );
    if (metrics.holdoutSpanMs < MIN_HOLDOUT_SPAN_MS) {
      errors.push(
        `${cohortId}: promotion cohort must contain observed sources spanning at least seven days`,
      );
    }
    if (
      metrics.protectedNegativeFalsePositiveUpper95 === null ||
      metrics.protectedNegativeFalsePositiveUpper95 > 0.001
    ) {
      errors.push(
        `${cohortId}: protected negative cleanup false-positive upper 95% confidence bound must be <= 0.1%`,
      );
    }
    if (metrics.offerCleanupRecallLower95 === null || metrics.offerCleanupRecallLower95 < 0.95) {
      errors.push(
        `${cohortId}: independent offer cleanup recall lower 95% confidence bound must be >= 95%`,
      );
    }
    if (
      cohortId === COMMERCIAL_INTENT_QUALITY_COHORT &&
      (!metrics.pairedFalsePositive?.significantReduction ||
        !metrics.pairedFalseNegative?.significantReduction)
    )
      errors.push(
        `${cohortId}: both cleanup error rates require paired significant reduction (one-sided exact p <= 0.025 each)`,
      );
  }
  return result(errors, cohortMetrics);
}

// FLAG: Every promoted quality profile needs its own independently reviewed artifact. Both
// required profiles must pass on the identical frozen sources, labels and sampling frame;
// only their detector predictions may differ. Extra settings also require their own evaluation.
export function validateCommercialTextQualityCompanionArtifacts(
  values: readonly unknown[],
  expected: Readonly<{
    detectorSourceSha256: string;
    decisionVersion: string;
    settingsProfileDigest: string;
    now?: number;
  }>,
): CommercialTextHoldoutValidationResult {
  if (
    values.length < 2 ||
    values.length > 3 ||
    expected.decisionVersion !== COMMERCIAL_INTENT_QUALITY_DECISION_VERSION
  )
    return result(
      [
        'Intent quality promotion requires selected and companion artifacts covering BALANCED 45/65 and STRICT 38/55',
      ],
      [],
    );
  const errors: string[] = [];
  const profiles = new Set<string>();
  const now = expected.now ?? Date.now();
  const validations = values.map((value, index) => {
    const artifact = asRecord(value);
    const digest = index === 0 ? expected.settingsProfileDigest : artifact?.settingsProfileDigest;
    const validation = validateCommercialTextHoldoutArtifact(value, {
      ...expected,
      settingsProfileDigest: typeof digest === 'string' ? digest : '',
      now,
    });
    errors.push(...validation.errors.map((error) => `profile ${index + 1}: ${error}`));
    if (!validation.approvedCohorts.includes(COMMERCIAL_INTENT_QUALITY_COHORT))
      errors.push(`profile ${index + 1}: independent intent quality approval is required`);
    if (typeof digest !== 'string' || profiles.has(digest))
      errors.push('Intent quality companion profiles must be distinct');
    else profiles.add(digest);
    return validation;
  });
  for (const profile of COMMERCIAL_TEXT_QUALITY_REQUIRED_PROFILES)
    if (!profiles.has(profile.digest))
      errors.push(
        `Intent quality promotion requires independent ${profile.sensitivity} ${profile.warn}/${profile.remove} evidence`,
      );
  if (errors.length > 0) return result(errors, []);

  try {
    const primary = frozenQualityEvidenceFingerprint(values[0]);
    for (const [index, value] of values.entries())
      if (index > 0 && frozenQualityEvidenceFingerprint(value) !== primary)
        errors.push(
          `profile ${index + 1}: companion must match frozen development/holdout sources, independent labels/provenance, cohorts, cutoff, gap and samplingDesign`,
        );
  } catch {
    errors.push('Intent quality companion frozen evidence is invalid or duplicated');
  }
  return result(errors, errors.length === 0 ? validations[0]!.cohortMetrics : []);
}

function frozenQualityEvidenceFingerprint(value: unknown): string {
  const artifact = asRecord(value)!;
  const rowsFingerprint = (value: unknown) => {
    const rows = readRows(value)!;
    const identities = new Set<string>();
    const signatures = rows.map((row) => {
      const review = asRecord(row.reviewProvenance)!;
      const identity = canonicalEvidenceJson([
        review.datasetRole,
        review.datasetId,
        review.sampleId,
        review.sourceSnapshotSha256,
      ]);
      if (identities.has(identity)) throw new Error('Duplicated frozen source');
      identities.add(identity);
      const evidence = Object.fromEntries(
        Object.entries(row).filter(
          ([key]) =>
            !['current', 'sanitizedBaseline', 'historical', 'releasedBaseline'].includes(key),
        ),
      );
      evidence.reviewProvenance = {
        ...review,
        ...(Array.isArray(review.reviewerIds)
          ? { reviewerIds: [...review.reviewerIds].sort() }
          : {}),
        ...(Array.isArray(review.campaignGroupIds)
          ? { campaignGroupIds: [...review.campaignGroupIds].sort() }
          : {}),
      };
      return createHash('sha256').update(canonicalEvidenceJson(evidence)).digest('hex');
    });
    return signatures.sort();
  };
  return createHash('sha256')
    .update(
      canonicalEvidenceJson({
        ...Object.fromEntries(
          Object.entries(artifact).filter(
            ([key]) =>
              ![
                'settingsProfileDigest',
                'evaluatedAt',
                'expiresAt',
                'developmentRecords',
                'holdoutRecords',
                'cohorts',
              ].includes(key),
          ),
        ),
        cohorts: [...(artifact.cohorts as string[])].sort(),
        developmentRecords: rowsFingerprint(artifact.developmentRecords),
        holdoutRecords: rowsFingerprint(artifact.holdoutRecords),
      }),
    )
    .digest('hex');
}

function canonicalEvidenceJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalEvidenceJson).join(',')}]`;
  const record = asRecord(value);
  if (record)
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalEvidenceJson(record[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

export function commercialWilson95(
  successes: number,
  samples: number,
): Readonly<{
  lower: number;
  upper: number;
}> | null {
  if (
    !Number.isSafeInteger(samples) ||
    samples < 1 ||
    !Number.isSafeInteger(successes) ||
    successes < 0 ||
    successes > samples
  ) {
    return null;
  }
  const z = 1.959963984540054;
  const squaredZ = z * z;
  const rate = successes / samples;
  const denominator = 1 + squaredZ / samples;
  const center = (rate + squaredZ / (2 * samples)) / denominator;
  const radius =
    (z * Math.sqrt((rate * (1 - rate)) / samples + squaredZ / (4 * samples * samples))) /
    denominator;
  return { lower: Math.max(0, center - radius), upper: Math.min(1, center + radius) };
}

// FLAG: Improvements use paired independent units, not repeated rows. Bonferroni alpha 0.025
// per error endpoint keeps their joint confidence at 95%; equal zero errors proves no reduction.
export function commercialPairedImprovement(
  improvedUnits: number,
  regressedUnits: number,
): CommercialPairedImprovement {
  const total = improvedUnits + regressedUnits;
  if (
    !Number.isSafeInteger(improvedUnits) ||
    !Number.isSafeInteger(regressedUnits) ||
    improvedUnits < 0 ||
    regressedUnits < 0 ||
    total === 0 ||
    improvedUnits <= regressedUnits
  )
    return { improvedUnits, regressedUnits, oneSidedExactP: 1, significantReduction: false };
  let logTerm = -total * Math.log(2);
  let logSum = logTerm;
  for (let index = 1; index <= regressedUnits; index += 1) {
    logTerm += Math.log(total - index + 1) - Math.log(index);
    const high = Math.max(logSum, logTerm);
    logSum = high + Math.log(Math.exp(logSum - high) + Math.exp(logTerm - high));
  }
  const oneSidedExactP = Math.min(1, Math.exp(logSum));
  return {
    improvedUnits,
    regressedUnits,
    oneSidedExactP,
    significantReduction: oneSidedExactP <= 0.025,
  };
}

function summarizeCohort(
  rows: readonly CommercialTextHoldoutRecord[],
  cohortId: string,
): CommercialTextHoldoutCohortMetrics {
  const parents = new Map<string, string>();
  const find = (value: string): string => {
    if (!parents.has(value)) parents.set(value, value);
    let root = value;
    while (parents.get(root) !== root) root = parents.get(root)!;
    let node = value;
    while (node !== root) {
      const next = parents.get(node)!;
      parents.set(node, root);
      node = next;
    }
    return root;
  };
  // FLAG: Shared author/campaign groups are correlated. Collapse connected groups before CI
  // calculation so repeated campaign messages cannot inflate the independent sample denominator.
  for (const row of rows) {
    const provenance = row.reviewProvenance as CommercialCorpusReviewProvenance;
    for (const group of commercialProvenanceCampaignGroups(provenance)) {
      const author = find(`author:${provenance.authorGroupId}`);
      const campaign = find(`campaign:${group}`);
      if (author !== campaign) parents.set(author, campaign);
    }
  }
  const units = new Map<
    string,
    {
      negative: boolean;
      unexpectedDelete: boolean;
      offer: boolean;
      missedOffer: boolean;
      baselineUnexpectedDelete: boolean;
      baselineMissedOffer: boolean;
    }
  >();
  let earliestAt = Number.POSITIVE_INFINITY;
  let latestAt = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const provenance = row.reviewProvenance as CommercialCorpusReviewProvenance;
    const root = find(`author:${provenance.authorGroupId}`);
    const unit = units.get(root) ?? {
      negative: false,
      unexpectedDelete: false,
      offer: false,
      missedOffer: false,
      baselineUnexpectedDelete: false,
      baselineMissedOffer: false,
    };
    const snapshot = asRecord(row.sanitizedBaseline ?? row.current)!;
    const deleteEligible = isCommercialMessageDeleteEligible(
      typeof snapshot.actionBand === 'string' ? snapshot.actionBand : null,
      snapshot.actionable === true,
      snapshot.messageDisposition,
    );
    const baseline = asRecord(row.releasedBaseline);
    const baselineDeleteEligible =
      baseline &&
      isCommercialMessageDeleteEligible(
        typeof baseline.actionBand === 'string' ? baseline.actionBand : null,
        baseline.actionable === true,
        baseline.messageDisposition,
      );
    if (row.expectedDisposition === 'KEEP') {
      unit.negative = true;
      unit.unexpectedDelete ||= deleteEligible;
      unit.baselineUnexpectedDelete ||= baselineDeleteEligible === true;
    } else {
      unit.offer = true;
      unit.missedOffer ||= !deleteEligible;
      unit.baselineMissedOffer ||= baselineDeleteEligible === false;
    }
    units.set(root, unit);
    const createdAt = Date.parse(provenance.messageCreatedAt);
    earliestAt = Math.min(earliestAt, createdAt);
    latestAt = Math.max(latestAt, createdAt);
  }
  const values = [...units.values()];
  const protectedNegativeUnits = values.filter((unit) => unit.negative).length;
  const unexpectedDeleteUnits = values.filter(
    (unit) => unit.negative && unit.unexpectedDelete,
  ).length;
  const offerUnits = values.filter((unit) => unit.offer).length;
  const cleanedOfferUnits = values.filter((unit) => unit.offer && !unit.missedOffer).length;
  return {
    cohortId,
    samples: rows.length,
    holdoutSpanMs: latestAt - earliestAt,
    protectedNegativeUnits,
    unexpectedDeleteUnits,
    protectedNegativeFalsePositiveUpper95:
      commercialWilson95(unexpectedDeleteUnits, protectedNegativeUnits)?.upper ?? null,
    offerUnits,
    cleanedOfferUnits,
    offerCleanupRecallLower95: commercialWilson95(cleanedOfferUnits, offerUnits)?.lower ?? null,
    ...(cohortId === COMMERCIAL_INTENT_QUALITY_COHORT
      ? {
          pairedFalsePositive: commercialPairedImprovement(
            values.filter(
              (unit) => unit.negative && unit.baselineUnexpectedDelete && !unit.unexpectedDelete,
            ).length,
            values.filter(
              (unit) => unit.negative && !unit.baselineUnexpectedDelete && unit.unexpectedDelete,
            ).length,
          ),
          pairedFalseNegative: commercialPairedImprovement(
            values.filter((unit) => unit.offer && unit.baselineMissedOffer && !unit.missedOffer)
              .length,
            values.filter((unit) => unit.offer && !unit.baselineMissedOffer && unit.missedOffer)
              .length,
          ),
        }
      : {}),
  };
}

function result(
  errors: readonly string[],
  cohortMetrics: readonly CommercialTextHoldoutCohortMetrics[],
): CommercialTextHoldoutValidationResult {
  return {
    valid: errors.length === 0,
    approvedCohorts: errors.length === 0 ? cohortMetrics.map((metrics) => metrics.cohortId) : [],
    errors: errors.slice(0, 200),
    cohortMetrics,
  };
}

function readRows(value: unknown): CommercialTextHoldoutRecord[] | null {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_CORPUS_ROWS ||
    value.some((row) => !asRecord(row))
  ) {
    return null;
  }
  return value as CommercialTextHoldoutRecord[];
}

function readIsoTimestamp(value: unknown): number | null {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)
  )
    return null;
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) return null;
  const canonical = value.includes('.')
    ? value.replace(/\.(\d{1,3})Z$/u, (_, digits: string) => `.${digits.padEnd(3, '0')}Z`)
    : value.replace(/Z$/u, '.000Z');
  return new Date(milliseconds).toISOString() === canonical ? milliseconds : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
