import { isCommercialMessageDeleteEligible } from '../moderation/commercial/commercial-action-policy';
import {
  validateCommercialHoldoutProvenance,
  type CommercialCorpusReviewProvenance,
} from './commercial-corpus-provenance';
import {
  analyzeCommercialCorpusRecords,
  COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE,
  type CommercialCorpusRecord,
} from './validate-commercial-corpus';

export const COMMERCIAL_TEXT_HOLDOUT_ARTIFACT_SCHEMA_VERSION =
  'commercial-text-holdout/v1' as const;
export const COMMERCIAL_TEXT_PROMOTABLE_COHORT = 'owned-service-contrast-v1' as const;
export const COMMERCIAL_TEXT_PROMOTABLE_COHORTS = [
  COMMERCIAL_TEXT_PROMOTABLE_COHORT,
  'sliding-campaign-v1',
] as const;
const MAX_ARTIFACT_AGE_MS = 24 * 60 * 60_000;
const MIN_HOLDOUT_SPAN_MS = 7 * 24 * 60 * 60_000;
const MAX_CORPUS_ROWS = 100_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type CommercialTextHoldoutRecord = CommercialCorpusRecord & { cohortId?: unknown };

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
  });
  errors.push(...provenance.errors);
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
  }
  return result(errors, cohortMetrics);
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
    const author = find(`author:${provenance.authorGroupId}`);
    const campaign = find(`campaign:${provenance.campaignGroupId}`);
    if (author !== campaign) parents.set(author, campaign);
  }
  const units = new Map<
    string,
    { negative: boolean; unexpectedDelete: boolean; offer: boolean; missedOffer: boolean }
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
    };
    const snapshot = asRecord(row.sanitizedBaseline ?? row.current)!;
    const deleteEligible = isCommercialMessageDeleteEligible(
      typeof snapshot.actionBand === 'string' ? snapshot.actionBand : null,
      snapshot.actionable === true,
      snapshot.messageDisposition,
    );
    if (row.expectedDisposition === 'KEEP') {
      unit.negative = true;
      unit.unexpectedDelete ||= deleteEligible;
    } else {
      unit.offer = true;
      unit.missedOffer ||= !deleteEligible;
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
