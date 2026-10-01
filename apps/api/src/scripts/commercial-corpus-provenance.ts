import { createHash } from 'node:crypto';

export const COMMERCIAL_CORPUS_PROVENANCE_VERSION = 'commercial-corpus-provenance/v1' as const;
export const DEFAULT_COMMERCIAL_HOLDOUT_GAP_HOURS = 24;

export type CommercialCorpusReviewProvenance = Readonly<{
  schemaVersion: typeof COMMERCIAL_CORPUS_PROVENANCE_VERSION;
  datasetRole: 'DEVELOPMENT' | 'HOLDOUT';
  datasetId: string;
  sampleId: string;
  sourceSnapshotSha256: string;
  authorGroupId: string;
  campaignGroupId: string;
  messageCreatedAt: string;
  labelAuthorId?: string;
  reviewerIds?: readonly string[];
  reviewedAt?: string;
  reviewedTextSha256?: string;
}>;

type ProvenanceRecord = Readonly<{ reviewProvenance?: unknown; text?: unknown }>;

// FLAG: This checks declared evidence, not the truth of labels or human independence. Never mint
// provenance from detector output or invent reviewer IDs to make a quality gate pass.
export function validateCommercialHoldoutProvenance(params: {
  holdoutRecords: readonly ProvenanceRecord[];
  developmentRecords?: readonly ProvenanceRecord[];
  holdoutCutoffAt?: string;
  minHoldoutGapHours?: number;
}): { errors: string[]; diagnostics: string[] } {
  const errors: string[] = [];
  const diagnostics: string[] = [];
  const cutoffAtMs = parseIso(params.holdoutCutoffAt);
  const gapHours = params.minHoldoutGapHours ?? DEFAULT_COMMERCIAL_HOLDOUT_GAP_HOURS;
  if (cutoffAtMs === null) {
    errors.push('quality_gate_provenance: holdoutCutoffAt must be an explicit ISO timestamp');
  }
  if (!Number.isFinite(gapHours) || gapHours < 1 || gapHours > 24 * 90) {
    errors.push('quality_gate_provenance: minHoldoutGapHours must be in [1, 2160]');
  }
  const development = params.developmentRecords ?? [];
  if (development.length === 0) {
    errors.push(
      'quality_gate_provenance: a frozen development corpus is required for split checks',
    );
  }
  const developmentAuthors = new Set<string>();
  const developmentCampaigns = new Set<string>();
  const developmentSamples = new Set<string>();
  const developmentSnapshots = new Set<string>();
  const developmentDatasets = new Set<string>();
  const labelAuthors = new Set<string>();
  for (const record of [...development, ...params.holdoutRecords]) {
    const labelAuthorId = readId(asRecord(record.reviewProvenance)?.labelAuthorId);
    if (labelAuthorId) labelAuthors.add(labelAuthorId);
  }
  for (const [index, record] of development.entries()) {
    const label = `development line ${index + 1}`;
    const provenance = readProvenance(record.reviewProvenance, 'DEVELOPMENT', label, errors);
    if (!provenance) continue;
    developmentAuthors.add(provenance.authorGroupId);
    developmentCampaigns.add(provenance.campaignGroupId);
    developmentSamples.add(provenance.sampleId);
    developmentSnapshots.add(provenance.sourceSnapshotSha256);
    developmentDatasets.add(provenance.datasetId);
    if (cutoffAtMs !== null && Date.parse(provenance.messageCreatedAt) > cutoffAtMs) {
      errors.push(`${label}: development sample is newer than the holdout cutoff`);
    }
  }

  const holdoutSamples = new Set<string>();
  const holdoutSnapshots = new Set<string>();
  let earliestHoldoutMs = Number.POSITIVE_INFINITY;
  let latestHoldoutMs = Number.NEGATIVE_INFINITY;
  for (const [index, record] of params.holdoutRecords.entries()) {
    const label = `holdout line ${index + 1}`;
    const provenance = readProvenance(record.reviewProvenance, 'HOLDOUT', label, errors);
    if (!provenance) continue;
    if (developmentDatasets.has(provenance.datasetId)) {
      errors.push(`${label}: holdout dataset overlaps the development corpus`);
    }
    if (
      developmentSamples.has(provenance.sampleId) ||
      developmentSnapshots.has(provenance.sourceSnapshotSha256)
    ) {
      errors.push(`${label}: holdout sample overlaps the development corpus`);
    }
    if (developmentAuthors.has(provenance.authorGroupId)) {
      errors.push(`${label}: author group overlaps the development corpus`);
    }
    if (developmentCampaigns.has(provenance.campaignGroupId)) {
      errors.push(`${label}: campaign group overlaps the development corpus`);
    }
    if (
      holdoutSamples.has(provenance.sampleId) ||
      holdoutSnapshots.has(provenance.sourceSnapshotSha256)
    ) {
      errors.push(`${label}: duplicate holdout sample or source snapshot`);
    }
    holdoutSamples.add(provenance.sampleId);
    holdoutSnapshots.add(provenance.sourceSnapshotSha256);
    const messageCreatedAtMs = Date.parse(provenance.messageCreatedAt);
    earliestHoldoutMs = Math.min(earliestHoldoutMs, messageCreatedAtMs);
    latestHoldoutMs = Math.max(latestHoldoutMs, messageCreatedAtMs);
    if (
      cutoffAtMs !== null &&
      Number.isFinite(gapHours) &&
      messageCreatedAtMs < cutoffAtMs + gapHours * 60 * 60_000
    ) {
      errors.push(`${label}: sample violates the temporal holdout gap`);
    }
    const labelAuthorId = readId(provenance.labelAuthorId);
    const reviewerIds = Array.isArray(provenance.reviewerIds)
      ? provenance.reviewerIds.map(readId)
      : [];
    if (
      !labelAuthorId ||
      reviewerIds.length < 2 ||
      reviewerIds.length > 8 ||
      reviewerIds.some((reviewerId) => reviewerId === null || labelAuthors.has(reviewerId)) ||
      new Set(reviewerIds).size !== reviewerIds.length
    ) {
      errors.push(`${label}: two distinct reviewers separate from the label author are required`);
    }
    const reviewedAtMs = parseIso(provenance.reviewedAt);
    if (reviewedAtMs === null || reviewedAtMs < messageCreatedAtMs) {
      errors.push(`${label}: reviewedAt must be an ISO timestamp after source creation`);
    }
    if (
      typeof record.text !== 'string' ||
      provenance.reviewedTextSha256 !== createHash('sha256').update(record.text).digest('hex')
    ) {
      errors.push(
        `${label}: reviewedTextSha256 must bind the exact independently reviewed sanitized text`,
      );
    }
  }

  if (errors.length === 0) {
    diagnostics.push(
      `quality_gate_provenance=declared_split_validated development_records=${development.length} holdout_records=${params.holdoutRecords.length} gap_hours=${gapHours}`,
    );
    if (Number.isFinite(earliestHoldoutMs) && Number.isFinite(latestHoldoutMs)) {
      diagnostics.push(
        `quality_gate_temporal_holdout=${new Date(earliestHoldoutMs).toISOString()}..${new Date(latestHoldoutMs).toISOString()}`,
      );
    }
  }
  return { errors, diagnostics };
}

function readProvenance(
  value: unknown,
  role: CommercialCorpusReviewProvenance['datasetRole'],
  label: string,
  errors: string[],
): CommercialCorpusReviewProvenance | null {
  const provenance = asRecord(value);
  if (
    !provenance ||
    provenance.schemaVersion !== COMMERCIAL_CORPUS_PROVENANCE_VERSION ||
    provenance.datasetRole !== role ||
    !readId(provenance.datasetId) ||
    !readId(provenance.sampleId) ||
    !readId(provenance.authorGroupId) ||
    !readId(provenance.campaignGroupId) ||
    typeof provenance.sourceSnapshotSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(provenance.sourceSnapshotSha256) ||
    parseIso(provenance.messageCreatedAt) === null
  ) {
    errors.push(`${label}: valid ${role} reviewProvenance with frozen source identity is required`);
    return null;
  }
  return provenance as unknown as CommercialCorpusReviewProvenance;
}

function parseIso(value: unknown): number | null {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)
  ) {
    return null;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) return null;
  const canonical = value.includes('.')
    ? value.replace(/\.(\d{1,3})Z$/u, (_, digits: string) => `.${digits.padEnd(3, '0')}Z`)
    : value.replace(/Z$/u, '.000Z');
  return new Date(milliseconds).toISOString() === canonical ? milliseconds : null;
}

function readId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
    ? value
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
