import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { createInterface } from 'node:readline';
import {
  access,
  link,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { ChatSettings } from '../prisma/prisma-client';
import type { CommercialCampaignContext } from '../moderation/commercial-campaign.util';
import {
  CommercialAdDetector,
  type CommercialDetection,
} from '../moderation/commercial/commercial-ad.detector';
import { createRuleDetectionContext } from '../moderation/rule-engine-detection-context';
import {
  COMMERCIAL_MANUAL_OVERLAY_SCHEMA_VERSION,
  fingerprintCommercialManualOverlayContext,
  type CommercialManualOverlayCampaignContext,
  type CommercialManualOverlayRecord,
  type CommercialManualOverlaySettings,
  type CommercialManualRecommendedAction,
} from './commercial-manual-overlay.util';
import {
  assertCommercialOutputLockPathsSafe,
  assertCommercialPathsDistinct,
  withCommercialOutputLocks,
} from './commercial-output-lock.util';
import {
  resolveCommercialRunProvenance,
  type CommercialRunProvenance,
} from './commercial-run-provenance.util';

export const COMMERCIAL_CORPUS_REPLAY_SCHEMA_VERSION = 'commercial-corpus-replay/v4';
export const COMMERCIAL_REPLAY_MAX_DECISION_COHORTS = 128;
export const COMMERCIAL_REPLAY_MAX_DECISION_TRANSITIONS = 64;

const OUTPUT_BUFFER_SIZE = 1024 * 1024;
const SANITIZED_PLACEHOLDER_PATTERN = /(?:\[(?:phone|url|email|card|account)\]|@\[handle\])/iu;
const ENFORCEMENT_ACTIONS = new Set(['WARN', 'DELETE', 'DELETE_AND_ESCALATE']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MANUAL_RECOMMENDED_ACTIONS = new Set([
  'ALLOW',
  'REVIEW_ONLY',
  'WARN',
  'DELETE',
  'DELETE_AND_ESCALATE',
]);
const CAMPAIGN_CONTEXT_REQUIRED_FIELDS = [
  'senderDistinctChatCount',
  'sameTextDistinctChatCount',
  'repeatedPhoneDistinctChatCount',
  'repeatedLinkDistinctChatCount',
] as const;
const CAMPAIGN_CONTEXT_OPTIONAL_FIELDS = [
  'nearTextDistinctChatCount',
  'repeatedDomainDistinctChatCount',
  'repeatedHandleDistinctChatCount',
  'senderDistinctChatCount5m',
  'senderDistinctChatCount30m',
  'senderDistinctChatCount120m',
] as const;

export type CommercialCorpusDetector = Pick<CommercialAdDetector, 'detect'>;

export type CommercialReplaySnapshot = {
  hit: boolean;
  score: number | null;
  actionScore: number | null;
  confidenceScore: number | null;
  decisionBand: string | null;
  primarySubtype: string | null;
  supportingSubtypes: string[];
  evidenceStrength: string | null;
  classifierVersion: string | null;
  commercialProbability: number | null;
  reviewProbability: number | null;
  classifierReasons: string[];
  reviewRecommended: boolean;
  reviewReasons: string[];
  matchedSignals: string[];
  negativeSignals: string[];
  decisionVersion: string | null;
  fpRisk: number | null;
  evidenceTier: string | null;
  subtype: string | null;
  actionBand: string | null;
  reviewPriority: string | null;
  campaignStrength: string | null;
  safeContextBucket: string | null;
  actionable: boolean;
  recordable: boolean;
  deleteSuppressed: boolean;
  suppressionReasons: string[];
  reasonCodes: string[];
  featureVector: Record<string, number>;
};

export type CommercialReplayChangeKind =
  | 'NEW_HIT'
  | 'CLEARED_HIT'
  | 'ACTION_CHANGED'
  | 'SUBTYPE_CHANGED'
  | 'DECISION_METADATA_CHANGED'
  | 'EXPLANATION_ONLY';

export type CommercialReplayLabelImpact =
  | 'POSSIBLE_FALSE_POSITIVE_REGRESSION'
  | 'FALSE_POSITIVE_REDUCTION'
  | 'POSSIBLE_RECALL_REGRESSION'
  | 'RECALL_GAIN'
  | 'NEUTRAL';

export type CommercialReplayTrustBucket = 'TRUSTED' | 'UNTRUSTED_SANITIZED_PLACEHOLDER';

export type CommercialReplayBaselineSource = 'CURRENT_SNAPSHOT' | 'SANITIZED_BASELINE';

export type CommercialReplayExpectedActionSource = 'CORPUS' | 'MANUAL_OVERLAY';

export type CommercialReplayManualOverlayProvenance = {
  manualLabel: string;
  confidence: string;
  recommendedAction: CommercialManualRecommendedAction | null;
  sourceFiles: string[];
  contextFingerprint: string;
};

export type CommercialCorpusReplayDiff = {
  schemaVersion: typeof COMMERCIAL_CORPUS_REPLAY_SCHEMA_VERSION;
  line: number;
  textHash: string;
  text: string;
  containsSanitizedPlaceholders: boolean;
  trustBucket: CommercialReplayTrustBucket;
  baselineSource: CommercialReplayBaselineSource;
  label: string | null;
  category: string | null;
  policyCategory: string | null;
  segment: string | null;
  expectedAction: string | null;
  effectiveLabel: string | null;
  effectiveExpectedAction: string | null;
  expectedActionSource: CommercialReplayExpectedActionSource;
  manualOverlay: CommercialReplayManualOverlayProvenance | null;
  expectedSubtype: string | null;
  isHardNegative: boolean;
  settings: {
    commercialAdsSensitivity: 'BALANCED' | 'STRICT';
    commercialAdsWarnThreshold: number;
    commercialAdsDeleteThreshold: number;
  };
  commercialCampaignContext: CommercialCampaignContext | null;
  changeKind: CommercialReplayChangeKind;
  labelImpact: CommercialReplayLabelImpact;
  materialChanged: boolean;
  changedFields: (keyof CommercialReplaySnapshot)[];
  materialChangedFields: (keyof CommercialReplaySnapshot)[];
  hitTransition: string;
  actionTransition: string;
  changes: Record<
    string,
    {
      stored: unknown;
      replayed: unknown;
    }
  >;
};

export type CommercialCorpusReplayEvaluation = {
  changed: boolean;
  materialChanged: boolean;
  containsSanitizedPlaceholders: boolean;
  trustBucket: CommercialReplayTrustBucket;
  diff: CommercialCorpusReplayDiff | null;
  equivalence: CommercialReplayDecisionEquivalence;
};

export type CommercialReplayDecisionSignature = {
  hit: boolean;
  decisionBand: string | null;
  primarySubtype: string | null;
  subtype: string | null;
  evidenceTier: string | null;
  actionBand: string | null;
  reviewPriority: string | null;
  safeContextBucket: string | null;
  reviewRecommended: boolean;
  actionable: boolean;
  recordable: boolean;
  deleteSuppressed: boolean;
};

export type CommercialReplayDecisionEquivalence = {
  exact: boolean;
  stored: CommercialReplayDecisionSignature;
  replayed: CommercialReplayDecisionSignature;
  hitTransition: string;
  actionTransition: string;
  subtypeTransition: string;
  cohorts: string[];
};

export type CommercialReplayDecisionCohortSummary = {
  recordsCompared: number;
  exactDecisionRecords: number;
  decisionTransitionRecords: number;
  hitTransitions: Record<string, number>;
  actionTransitions: Record<string, number>;
  subtypeTransitions: Record<string, number>;
};

export type CommercialReplayDecisionEquivalenceSummary = CommercialReplayDecisionCohortSummary & {
  cohorts: Record<string, CommercialReplayDecisionCohortSummary>;
};

export type CommercialCorpusReplayAggregateSummary = {
  recordsProcessed: number;
  unchangedRecords: number;
  changedRecords: number;
  materialChangedRecords: number;
  explanationOnlyRecords: number;
  emittedDiffRecords: number;
  hitTransitions: Record<string, number>;
  actionTransitions: Record<string, number>;
  changeKinds: Record<string, number>;
  labelImpacts: Record<string, number>;
  changedFields: Record<string, number>;
  decisionEquivalence: CommercialReplayDecisionEquivalenceSummary;
};

export type CommercialCorpusReplaySummary = {
  schemaVersion: typeof COMMERCIAL_CORPUS_REPLAY_SCHEMA_VERSION;
  provenance: CommercialRunProvenance;
  replay: {
    textMode: 'CORPUS_TEXT_AS_STORED';
    trustPolicy: 'SANITIZED_PLACEHOLDERS_REQUIRE_SANITIZED_BASELINE';
  };
  input: {
    path: string;
    sha256: string;
    manualOverlay: {
      path: string;
      sha256: string;
      records: number;
    } | null;
  };
  output: {
    diffPath: string;
    summaryPath: string;
    diffSha256: string;
    includeExplanationOnly: boolean;
    includeUntrustedPlaceholderDiffs: boolean;
  };
  recordsProcessed: number;
  emittedDiffRecords: number;
  trustBuckets: {
    TRUSTED: CommercialCorpusReplayAggregateSummary;
    UNTRUSTED_SANITIZED_PLACEHOLDER: CommercialCorpusReplayAggregateSummary;
  };
};

export type ReplayCommercialCorpusFileOptions = {
  inputPath: string;
  manualOverlayPath?: string;
  diffOutputPath: string;
  summaryOutputPath?: string;
  includeExplanationOnly?: boolean;
  includeUntrustedPlaceholderDiffs?: boolean;
  overwrite?: boolean;
  detector?: CommercialCorpusDetector;
  provenance?: CommercialRunProvenance;
  onProgress?: (recordsProcessed: number) => void;
};

type ParsedCommercialCorpusRecord = {
  text: string;
  label: string | null;
  category: string | null;
  policyCategory: string | null;
  segment: string | null;
  expectedAction: string | null;
  expectedSubtype: string | null;
  isHardNegative: boolean;
  settings: CommercialCorpusReplayDiff['settings'];
  detectionSettings: ChatSettings;
  commercialCampaignContext: CommercialCampaignContext | null;
  current: CommercialReplaySnapshot;
  trustBucket: CommercialReplayTrustBucket;
  baselineSource: CommercialReplayBaselineSource;
  containsSanitizedPlaceholders: boolean;
};

type ParsedManualOverlay = {
  path: string;
  sha256: string;
  inputSha256: string;
  recordsByCorpusLine: Map<number, CommercialManualOverlayRecord>;
};

type EffectiveReplayTarget = {
  label: string | null;
  expectedAction: string | null;
  source: CommercialReplayExpectedActionSource;
};

type CommercialCorpusReplayAggregateState = Omit<
  CommercialCorpusReplayAggregateSummary,
  | 'hitTransitions'
  | 'actionTransitions'
  | 'changeKinds'
  | 'labelImpacts'
  | 'changedFields'
  | 'decisionEquivalence'
> & {
  hitTransitions: Map<string, number>;
  actionTransitions: Map<string, number>;
  changeKinds: Map<string, number>;
  labelImpacts: Map<string, number>;
  changedFields: Map<string, number>;
  decisionEquivalence: CommercialReplayDecisionAggregateState;
};

type CommercialReplayDecisionCohortState = Omit<
  CommercialReplayDecisionCohortSummary,
  'hitTransitions' | 'actionTransitions' | 'subtypeTransitions'
> & {
  hitTransitions: Map<string, number>;
  actionTransitions: Map<string, number>;
  subtypeTransitions: Map<string, number>;
};

type CommercialReplayDecisionAggregateState = CommercialReplayDecisionCohortState & {
  cohorts: Map<string, CommercialReplayDecisionCohortState>;
};

const SNAPSHOT_FIELDS: readonly (keyof CommercialReplaySnapshot)[] = [
  'hit',
  'score',
  'actionScore',
  'confidenceScore',
  'decisionBand',
  'primarySubtype',
  'supportingSubtypes',
  'evidenceStrength',
  'classifierVersion',
  'commercialProbability',
  'reviewProbability',
  'classifierReasons',
  'reviewRecommended',
  'reviewReasons',
  'matchedSignals',
  'negativeSignals',
  'decisionVersion',
  'fpRisk',
  'evidenceTier',
  'subtype',
  'actionBand',
  'reviewPriority',
  'campaignStrength',
  'safeContextBucket',
  'actionable',
  'recordable',
  'deleteSuppressed',
  'suppressionReasons',
  'reasonCodes',
  'featureVector',
];

const EXPLANATION_FIELDS = new Set<keyof CommercialReplaySnapshot>([
  'classifierReasons',
  'reviewReasons',
  'matchedSignals',
  'negativeSignals',
  'suppressionReasons',
  'reasonCodes',
  'featureVector',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readRequiredString(value: unknown, field: string, line: number): string {
  const result = readOptionalString(value);
  if (!result) {
    throw new Error(`Invalid corpus record at line ${line}: ${field} must be a non-empty string`);
  }
  return result;
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readRequiredNumber(value: unknown, field: string, line: number): number {
  const result = readOptionalNumber(value);
  if (result === null) {
    throw new Error(`Invalid corpus record at line ${line}: ${field} must be a finite number`);
  }
  return result;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readNumericRecord(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(record)
      .filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isFinite(entry[1]),
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function readManualOverlayString(
  record: Record<string, unknown>,
  field: string,
  location: string,
): string {
  const value = record[field];
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new Error(`Invalid ${location}: ${field} must be a trimmed non-empty string`);
  }
  return value;
}

function readManualOverlayNumber(
  record: Record<string, unknown>,
  field: string,
  location: string,
): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${location}: ${field} must be finite`);
  }
  return value;
}

function validateCommercialThresholds(
  settings: CommercialManualOverlaySettings,
  errorPrefix: string,
): void {
  if (
    !Number.isSafeInteger(settings.commercialAdsWarnThreshold) ||
    settings.commercialAdsWarnThreshold < 10 ||
    settings.commercialAdsWarnThreshold > 90
  ) {
    throw new Error(`${errorPrefix}: commercialAdsWarnThreshold must be an integer in [10, 90]`);
  }
  if (
    !Number.isSafeInteger(settings.commercialAdsDeleteThreshold) ||
    settings.commercialAdsDeleteThreshold < 20 ||
    settings.commercialAdsDeleteThreshold > 100
  ) {
    throw new Error(`${errorPrefix}: commercialAdsDeleteThreshold must be an integer in [20, 100]`);
  }
  if (settings.commercialAdsDeleteThreshold <= settings.commercialAdsWarnThreshold) {
    throw new Error(
      `${errorPrefix}: commercialAdsDeleteThreshold must be greater than commercialAdsWarnThreshold`,
    );
  }
}

function parseManualOverlaySettings(
  value: unknown,
  location: string,
): CommercialManualOverlaySettings {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`Invalid ${location}: settings are missing`);
  }
  const sensitivity = record.commercialAdsSensitivity;
  if (sensitivity !== 'BALANCED' && sensitivity !== 'STRICT') {
    throw new Error(`Invalid ${location}: unsupported commercialAdsSensitivity`);
  }
  const settings: CommercialManualOverlaySettings = {
    commercialAdsSensitivity: sensitivity,
    commercialAdsWarnThreshold: readManualOverlayNumber(
      record,
      'commercialAdsWarnThreshold',
      location,
    ),
    commercialAdsDeleteThreshold: readManualOverlayNumber(
      record,
      'commercialAdsDeleteThreshold',
      location,
    ),
  };
  validateCommercialThresholds(settings, `Invalid ${location}`);
  return settings;
}

function parseManualOverlayCampaignContext(
  value: unknown,
  location: string,
): CommercialManualOverlayCampaignContext | null {
  if (value === null) {
    return null;
  }
  const record = asRecord(value);
  if (!record) {
    throw new Error(`Invalid ${location}: commercialCampaignContext must be an object or null`);
  }
  const context: Record<string, number> = {};
  for (const field of CAMPAIGN_CONTEXT_REQUIRED_FIELDS) {
    const number = readManualOverlayNumber(record, field, location);
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new Error(
        `Invalid ${location}: commercialCampaignContext.${field} must be a non-negative integer`,
      );
    }
    context[field] = number;
  }
  for (const field of CAMPAIGN_CONTEXT_OPTIONAL_FIELDS) {
    if (record[field] === undefined) {
      continue;
    }
    const number = readManualOverlayNumber(record, field, location);
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new Error(
        `Invalid ${location}: commercialCampaignContext.${field} must be a non-negative integer`,
      );
    }
    context[field] = number;
  }
  return context as CommercialManualOverlayCampaignContext;
}

function parseManualRecommendedAction(
  value: unknown,
  location: string,
): CommercialManualRecommendedAction | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !MANUAL_RECOMMENDED_ACTIONS.has(value)) {
    throw new Error(`Invalid ${location}: unsupported recommendedAction`);
  }
  return value as CommercialManualRecommendedAction;
}

function parseManualOverlaySourceFiles(value: unknown, location: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string' || !item.trim() || item !== item.trim())
  ) {
    throw new Error(`Invalid ${location}: sourceFiles must contain trimmed non-empty strings`);
  }
  const files = value as string[];
  if (new Set(files).size !== files.length) {
    throw new Error(`Invalid ${location}: sourceFiles must be unique`);
  }
  if (
    files.some((file) => file === '.' || file === '..' || file.includes('/') || file.includes('\\'))
  ) {
    throw new Error(`Invalid ${location}: sourceFiles must contain logical basenames only`);
  }
  return [...files];
}

function parseManualOverlayRecord(value: unknown, location: string): CommercialManualOverlayRecord {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== COMMERCIAL_MANUAL_OVERLAY_SCHEMA_VERSION) {
    throw new Error(`Invalid ${location}: unsupported schemaVersion`);
  }
  const inputSha256 = readManualOverlayString(record, 'inputSha256', location);
  const textSha256 = readManualOverlayString(record, 'textSha256', location);
  const contextFingerprint = readManualOverlayString(record, 'contextFingerprint', location);
  if (
    !SHA256_PATTERN.test(inputSha256) ||
    !SHA256_PATTERN.test(textSha256) ||
    !SHA256_PATTERN.test(contextFingerprint)
  ) {
    throw new Error(`Invalid ${location}: SHA-256 fields must be 64 lowercase hex characters`);
  }
  if (!Number.isSafeInteger(record.line) || (record.line as number) <= 0) {
    throw new Error(`Invalid ${location}: line must be a positive integer`);
  }
  const settings = parseManualOverlaySettings(record.settings, location);
  const commercialCampaignContext = parseManualOverlayCampaignContext(
    record.commercialCampaignContext,
    location,
  );
  const calculatedFingerprint = fingerprintCommercialManualOverlayContext(
    settings,
    commercialCampaignContext,
  );
  if (calculatedFingerprint !== contextFingerprint) {
    throw new Error(
      `Invalid ${location}: contextFingerprint does not match overlay settings/context`,
    );
  }
  return {
    schemaVersion: COMMERCIAL_MANUAL_OVERLAY_SCHEMA_VERSION,
    inputSha256,
    line: record.line as number,
    textSha256,
    manualLabel: readManualOverlayString(record, 'manualLabel', location),
    confidence: readManualOverlayString(record, 'confidence', location),
    recommendedAction: parseManualRecommendedAction(record.recommendedAction, location),
    sourceFiles: parseManualOverlaySourceFiles(record.sourceFiles, location),
    settings,
    commercialCampaignContext,
    contextFingerprint,
  };
}

function physicalJsonlLines(value: string): string[] {
  const lines = value.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

async function parseManualOverlay(pathname: string): Promise<ParsedManualOverlay> {
  const path = resolve(pathname);
  const body = await readFile(path, 'utf8');
  const lines = physicalJsonlLines(body);
  if (lines.length === 0) {
    throw new Error(`Invalid manual overlay ${path}: expected at least one JSONL record`);
  }
  const recordsByCorpusLine = new Map<number, CommercialManualOverlayRecord>();
  let inputSha256: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const overlayLine = index + 1;
    const location = `manual overlay ${path}:${overlayLine}`;
    const line = lines[index];
    if (!line) {
      throw new Error(`Invalid ${location}: empty JSONL record`);
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`Invalid ${location}: ${String(error)}`);
    }
    const record = parseManualOverlayRecord(value, location);
    inputSha256 ??= record.inputSha256;
    if (inputSha256 !== record.inputSha256) {
      throw new Error(`Invalid ${location}: inputSha256 conflicts with other overlay rows`);
    }
    if (recordsByCorpusLine.has(record.line)) {
      throw new Error(`Invalid ${location}: duplicate corpus line ${record.line}`);
    }
    recordsByCorpusLine.set(record.line, record);
  }
  return {
    path,
    sha256: sha256(body),
    inputSha256: inputSha256 as string,
    recordsByCorpusLine,
  };
}

export function emptyCommercialReplaySnapshot(): CommercialReplaySnapshot {
  return {
    hit: false,
    score: null,
    actionScore: null,
    confidenceScore: null,
    decisionBand: null,
    primarySubtype: null,
    supportingSubtypes: [],
    evidenceStrength: null,
    classifierVersion: null,
    commercialProbability: null,
    reviewProbability: null,
    classifierReasons: [],
    reviewRecommended: false,
    reviewReasons: [],
    matchedSignals: [],
    negativeSignals: [],
    decisionVersion: null,
    fpRisk: null,
    evidenceTier: null,
    subtype: null,
    actionBand: null,
    reviewPriority: null,
    campaignStrength: null,
    safeContextBucket: null,
    actionable: false,
    recordable: false,
    deleteSuppressed: false,
    suppressionReasons: [],
    reasonCodes: [],
    featureVector: {},
  };
}

function snapshotFromStored(
  value: unknown,
  line: number,
  field = 'current',
): CommercialReplaySnapshot {
  const record = asRecord(value);
  if (!record || typeof record.hit !== 'boolean') {
    throw new Error(`Invalid corpus record at line ${line}: ${field} snapshot is missing`);
  }

  return {
    hit: record.hit,
    score: readOptionalNumber(record.score),
    actionScore: readOptionalNumber(record.actionScore),
    confidenceScore: readOptionalNumber(record.confidenceScore),
    decisionBand: readOptionalString(record.decisionBand),
    primarySubtype: readOptionalString(record.primarySubtype),
    supportingSubtypes: readStringArray(record.supportingSubtypes),
    evidenceStrength: readOptionalString(record.evidenceStrength),
    classifierVersion: readOptionalString(record.classifierVersion),
    commercialProbability: readOptionalNumber(record.commercialProbability),
    reviewProbability: readOptionalNumber(record.reviewProbability),
    classifierReasons: readStringArray(record.classifierReasons),
    reviewRecommended: record.reviewRecommended === true,
    reviewReasons: readStringArray(record.reviewReasons),
    matchedSignals: readStringArray(record.matchedSignals),
    negativeSignals: readStringArray(record.negativeSignals),
    decisionVersion: readOptionalString(record.decisionVersion),
    fpRisk: readOptionalNumber(record.fpRisk),
    evidenceTier: readOptionalString(record.evidenceTier),
    subtype: readOptionalString(record.subtype),
    actionBand: readOptionalString(record.actionBand),
    reviewPriority: readOptionalString(record.reviewPriority),
    campaignStrength: readOptionalString(record.campaignStrength),
    safeContextBucket: readOptionalString(record.safeContextBucket),
    actionable: record.actionable === true,
    recordable: record.recordable === true,
    deleteSuppressed: record.deleteSuppressed === true,
    suppressionReasons: readStringArray(record.suppressionReasons),
    reasonCodes: readStringArray(record.reasonCodes),
    featureVector: readNumericRecord(record.featureVector),
  };
}

function strictSnapshotError(line: number, field: string, message: string): Error {
  return new Error(`Invalid corpus record at line ${line}: ${field} ${message}`);
}

function readStrictNullableString(
  record: Record<string, unknown>,
  key: keyof CommercialReplaySnapshot,
  line: number,
  field: string,
): string | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw strictSnapshotError(
      line,
      `${field}.${key}`,
      'must be null or a trimmed non-empty string',
    );
  }
  return value;
}

function readStrictNullableNumber(
  record: Record<string, unknown>,
  key: keyof CommercialReplaySnapshot,
  line: number,
  field: string,
  minimum: number,
  maximum: number,
): number | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw strictSnapshotError(
      line,
      `${field}.${key}`,
      `must be null or a finite number in [${minimum}, ${maximum}]`,
    );
  }
  return value;
}

function readStrictBoolean(
  record: Record<string, unknown>,
  key: keyof CommercialReplaySnapshot,
  line: number,
  field: string,
): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw strictSnapshotError(line, `${field}.${key}`, 'must be a boolean');
  }
  return value;
}

function readStrictStringArray(
  record: Record<string, unknown>,
  key: keyof CommercialReplaySnapshot,
  line: number,
  field: string,
): string[] {
  const value = record[key];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !item.trim() || item !== item.trim())
  ) {
    throw strictSnapshotError(
      line,
      `${field}.${key}`,
      'must be an array of trimmed non-empty strings',
    );
  }
  return [...value] as string[];
}

function readStrictFeatureVector(
  record: Record<string, unknown>,
  line: number,
  field: string,
): Record<string, number> {
  const value = asRecord(record.featureVector);
  if (
    !value ||
    Object.entries(value).some(
      ([key, item]) =>
        !key.trim() || key !== key.trim() || typeof item !== 'number' || !Number.isFinite(item),
    )
  ) {
    throw strictSnapshotError(
      line,
      `${field}.featureVector`,
      'must be an object of trimmed keys and finite numbers',
    );
  }
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  ) as Record<string, number>;
}

function strictSnapshotFromStored(
  value: unknown,
  line: number,
  field: string,
): CommercialReplaySnapshot {
  const record = asRecord(value);
  if (!record) {
    throw strictSnapshotError(line, field, 'must be an object');
  }
  for (const key of SNAPSHOT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw strictSnapshotError(line, `${field}.${key}`, 'is required');
    }
  }

  const hit = readStrictBoolean(record, 'hit', line, field);
  const actionBand = readStrictNullableString(record, 'actionBand', line, field);
  if (
    (hit &&
      actionBand !== 'REVIEW_ONLY' &&
      actionBand !== 'WARN' &&
      actionBand !== 'DELETE' &&
      actionBand !== 'DELETE_AND_ESCALATE') ||
    (!hit && actionBand !== null)
  ) {
    throw strictSnapshotError(line, `${field}.actionBand`, 'is inconsistent with hit');
  }

  return {
    hit,
    score: readStrictNullableNumber(record, 'score', line, field, 0, 1),
    actionScore: readStrictNullableNumber(record, 'actionScore', line, field, 0, 100),
    confidenceScore: readStrictNullableNumber(record, 'confidenceScore', line, field, 0, 100),
    decisionBand: readStrictNullableString(record, 'decisionBand', line, field),
    primarySubtype: readStrictNullableString(record, 'primarySubtype', line, field),
    supportingSubtypes: readStrictStringArray(record, 'supportingSubtypes', line, field),
    evidenceStrength: readStrictNullableString(record, 'evidenceStrength', line, field),
    classifierVersion: readStrictNullableString(record, 'classifierVersion', line, field),
    commercialProbability: readStrictNullableNumber(
      record,
      'commercialProbability',
      line,
      field,
      0,
      1,
    ),
    reviewProbability: readStrictNullableNumber(record, 'reviewProbability', line, field, 0, 1),
    classifierReasons: readStrictStringArray(record, 'classifierReasons', line, field),
    reviewRecommended: readStrictBoolean(record, 'reviewRecommended', line, field),
    reviewReasons: readStrictStringArray(record, 'reviewReasons', line, field),
    matchedSignals: readStrictStringArray(record, 'matchedSignals', line, field),
    negativeSignals: readStrictStringArray(record, 'negativeSignals', line, field),
    decisionVersion: readStrictNullableString(record, 'decisionVersion', line, field),
    fpRisk: readStrictNullableNumber(record, 'fpRisk', line, field, 0, 100),
    evidenceTier: readStrictNullableString(record, 'evidenceTier', line, field),
    subtype: readStrictNullableString(record, 'subtype', line, field),
    actionBand,
    reviewPriority: readStrictNullableString(record, 'reviewPriority', line, field),
    campaignStrength: readStrictNullableString(record, 'campaignStrength', line, field),
    safeContextBucket: readStrictNullableString(record, 'safeContextBucket', line, field),
    actionable: readStrictBoolean(record, 'actionable', line, field),
    recordable: readStrictBoolean(record, 'recordable', line, field),
    deleteSuppressed: readStrictBoolean(record, 'deleteSuppressed', line, field),
    suppressionReasons: readStrictStringArray(record, 'suppressionReasons', line, field),
    reasonCodes: readStrictStringArray(record, 'reasonCodes', line, field),
    featureVector: readStrictFeatureVector(record, line, field),
  };
}

export function snapshotFromCommercialDetection(
  detection: CommercialDetection | null,
): CommercialReplaySnapshot {
  if (!detection) {
    return emptyCommercialReplaySnapshot();
  }

  return {
    hit: true,
    score: detection.confidenceScore / 100,
    actionScore: readOptionalNumber(detection.actionScore),
    confidenceScore: readOptionalNumber(detection.confidenceScore),
    decisionBand: readOptionalString(detection.decisionBand),
    primarySubtype: readOptionalString(detection.primarySubtype),
    supportingSubtypes: readStringArray(detection.supportingSubtypes),
    evidenceStrength: readOptionalString(detection.evidenceStrength),
    classifierVersion: readOptionalString(detection.classifierVersion),
    commercialProbability: readOptionalNumber(detection.commercialProbability),
    reviewProbability: readOptionalNumber(detection.reviewProbability),
    classifierReasons: readStringArray(detection.classifierReasons),
    reviewRecommended: detection.reviewRecommended === true,
    reviewReasons: readStringArray(detection.reviewReasons),
    matchedSignals: readStringArray(detection.matchedSignals),
    negativeSignals: readStringArray(detection.negativeSignals),
    decisionVersion: readOptionalString(detection.decisionVersion),
    fpRisk: readOptionalNumber(detection.fpRisk),
    evidenceTier: readOptionalString(detection.evidenceTier),
    subtype: readOptionalString(detection.subtype),
    actionBand: readOptionalString(detection.actionBand),
    reviewPriority: readOptionalString(detection.reviewPriority),
    campaignStrength: readOptionalString(detection.campaignStrength),
    safeContextBucket: readOptionalString(detection.safeContextBucket),
    actionable: detection.actionable === true,
    recordable: detection.recordable === true,
    deleteSuppressed: detection.deleteSuppressed === true,
    suppressionReasons: readStringArray(detection.suppressionReasons),
    reasonCodes: readStringArray(detection.reasonCodes),
    featureVector: readNumericRecord(detection.featureVector),
  };
}

function parseSettings(
  value: unknown,
  line: number,
): {
  summary: CommercialCorpusReplayDiff['settings'];
  detection: ChatSettings;
} {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`Invalid corpus record at line ${line}: settings are missing`);
  }
  const sensitivity = readRequiredString(
    record.commercialAdsSensitivity,
    'settings.commercialAdsSensitivity',
    line,
  );
  if (sensitivity !== 'BALANCED' && sensitivity !== 'STRICT') {
    throw new Error(
      `Invalid corpus record at line ${line}: unsupported commercialAdsSensitivity ${sensitivity}`,
    );
  }
  const summary: CommercialCorpusReplayDiff['settings'] = {
    commercialAdsSensitivity: sensitivity,
    commercialAdsWarnThreshold: readRequiredNumber(
      record.commercialAdsWarnThreshold,
      'settings.commercialAdsWarnThreshold',
      line,
    ),
    commercialAdsDeleteThreshold: readRequiredNumber(
      record.commercialAdsDeleteThreshold,
      'settings.commercialAdsDeleteThreshold',
      line,
    ),
  };
  validateCommercialThresholds(summary, `Invalid corpus record at line ${line}`);

  return {
    summary,
    detection: {
      commercialAdsFilterEnabled: true,
      ...summary,
    } as ChatSettings,
  };
}

function parseCampaignContext(value: unknown, line: number): CommercialCampaignContext | null {
  if (value === null || value === undefined) {
    return null;
  }
  const record = asRecord(value);
  if (!record) {
    throw new Error(
      `Invalid corpus record at line ${line}: commercialCampaignContext must be an object or null`,
    );
  }

  const requiredFields = [
    'senderDistinctChatCount',
    'sameTextDistinctChatCount',
    'repeatedPhoneDistinctChatCount',
    'repeatedLinkDistinctChatCount',
  ] as const;
  const optionalFields = [
    'nearTextDistinctChatCount',
    'repeatedDomainDistinctChatCount',
    'repeatedHandleDistinctChatCount',
    'senderDistinctChatCount5m',
    'senderDistinctChatCount30m',
    'senderDistinctChatCount120m',
  ] as const;
  const context: Record<string, number> = {};

  for (const field of requiredFields) {
    const numeric = readRequiredNumber(record[field], `commercialCampaignContext.${field}`, line);
    if (!Number.isSafeInteger(numeric) || numeric < 0) {
      throw new Error(
        `Invalid corpus record at line ${line}: commercialCampaignContext.${field} must be a non-negative integer`,
      );
    }
    context[field] = numeric;
  }
  for (const field of optionalFields) {
    if (record[field] === undefined) {
      continue;
    }
    const numeric = readRequiredNumber(record[field], `commercialCampaignContext.${field}`, line);
    if (!Number.isSafeInteger(numeric) || numeric < 0) {
      throw new Error(
        `Invalid corpus record at line ${line}: commercialCampaignContext.${field} must be a non-negative integer`,
      );
    }
    context[field] = numeric;
  }

  return context as CommercialCampaignContext;
}

function parseCorpusRecord(value: unknown, line: number): ParsedCommercialCorpusRecord {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`Invalid corpus record at line ${line}: expected an object`);
  }
  const settings = parseSettings(record.settings, line);
  const text = readRequiredString(record.text, 'text', line);
  const containsSanitizedPlaceholders = SANITIZED_PLACEHOLDER_PATTERN.test(text);
  const hasSanitizedBaseline =
    record.sanitizedBaseline !== undefined && record.sanitizedBaseline !== null;
  const baselineSource: CommercialReplayBaselineSource = hasSanitizedBaseline
    ? 'SANITIZED_BASELINE'
    : 'CURRENT_SNAPSHOT';
  const current = hasSanitizedBaseline
    ? strictSnapshotFromStored(record.sanitizedBaseline, line, 'sanitizedBaseline')
    : snapshotFromStored(record.current, line);

  return {
    text,
    label: readOptionalString(record.label),
    category: readOptionalString(record.category),
    policyCategory: readOptionalString(record.policyCategory),
    segment: readOptionalString(record.segment),
    expectedAction: readOptionalString(record.expectedAction),
    expectedSubtype: readOptionalString(record.expectedSubtype),
    isHardNegative: record.isHardNegative === true,
    settings: settings.summary,
    detectionSettings: settings.detection,
    commercialCampaignContext: parseCampaignContext(record.commercialCampaignContext, line),
    current,
    trustBucket:
      containsSanitizedPlaceholders && !hasSanitizedBaseline
        ? 'UNTRUSTED_SANITIZED_PLACEHOLDER'
        : 'TRUSTED',
    baselineSource,
    containsSanitizedPlaceholders,
  };
}

function validateManualOverlayMatch(
  overlay: CommercialManualOverlayRecord,
  record: ParsedCommercialCorpusRecord,
  line: number,
): void {
  const location = `manual overlay for corpus line ${line}`;
  if (overlay.line !== line) {
    throw new Error(`Invalid ${location}: references corpus line ${overlay.line}`);
  }
  const textSha256 = sha256(record.text);
  if (overlay.textSha256 !== textSha256) {
    throw new Error(
      `Invalid ${location}: textSha256 ${overlay.textSha256} does not match corpus text ${textSha256}`,
    );
  }
  if (!isDeepStrictEqual(overlay.settings, record.settings)) {
    throw new Error(`Invalid ${location}: settings do not match the corpus record`);
  }
  if (!isDeepStrictEqual(overlay.commercialCampaignContext, record.commercialCampaignContext)) {
    throw new Error(
      `Invalid ${location}: commercialCampaignContext does not match the corpus record`,
    );
  }
  const contextFingerprint = fingerprintCommercialManualOverlayContext(
    record.settings,
    record.commercialCampaignContext as CommercialManualOverlayCampaignContext | null,
  );
  if (overlay.contextFingerprint !== contextFingerprint) {
    throw new Error(
      `Invalid ${location}: contextFingerprint does not match the corpus settings/context`,
    );
  }
}

function deriveEffectiveReplayTarget(
  record: ParsedCommercialCorpusRecord,
  overlay: CommercialManualOverlayRecord | null,
): EffectiveReplayTarget {
  switch (overlay?.recommendedAction) {
    case 'ALLOW':
      return {
        label: 'negative_candidate',
        expectedAction: 'ALLOW',
        source: 'MANUAL_OVERLAY',
      };
    case 'REVIEW_ONLY':
      return {
        label: 'gray_candidate',
        expectedAction: 'REVIEW_ONLY',
        source: 'MANUAL_OVERLAY',
      };
    case 'WARN':
    case 'DELETE':
    case 'DELETE_AND_ESCALATE':
      return {
        label: 'positive_candidate',
        expectedAction: overlay.recommendedAction,
        source: 'MANUAL_OVERLAY',
      };
    default:
      return {
        label: record.label,
        expectedAction: record.expectedAction,
        source: 'CORPUS',
      };
  }
}

function manualOverlayProvenance(
  overlay: CommercialManualOverlayRecord | null,
): CommercialReplayManualOverlayProvenance | null {
  if (!overlay) {
    return null;
  }
  return {
    manualLabel: overlay.manualLabel,
    confidence: overlay.confidence,
    recommendedAction: overlay.recommendedAction,
    sourceFiles: [...overlay.sourceFiles],
    contextFingerprint: overlay.contextFingerprint,
  };
}

function actionName(snapshot: CommercialReplaySnapshot): string {
  return snapshot.actionBand ?? 'NONE';
}

function subtypeName(snapshot: CommercialReplaySnapshot): string {
  return snapshot.primarySubtype ?? snapshot.subtype ?? 'NONE';
}

function decisionSignature(snapshot: CommercialReplaySnapshot): CommercialReplayDecisionSignature {
  return {
    hit: snapshot.hit,
    decisionBand: snapshot.decisionBand,
    primarySubtype: snapshot.primarySubtype,
    subtype: snapshot.subtype,
    evidenceTier: snapshot.evidenceTier,
    actionBand: snapshot.actionBand,
    reviewPriority: snapshot.reviewPriority,
    safeContextBucket: snapshot.safeContextBucket,
    reviewRecommended: snapshot.reviewRecommended,
    actionable: snapshot.actionable,
    recordable: snapshot.recordable,
    deleteSuppressed: snapshot.deleteSuppressed,
  };
}

function cohortName(prefix: string, value: string | null | undefined): string {
  const normalized = value?.trim() || 'NONE';
  return `${prefix}:${normalized.slice(0, 120)}`;
}

function campaignCohort(context: CommercialCampaignContext | null): string {
  if (!context) {
    return 'campaign:absent';
  }
  return Object.values(context).some((value) => value > 0) ? 'campaign:nonzero' : 'campaign:zero';
}

function buildDecisionEquivalence(
  record: ParsedCommercialCorpusRecord,
  replayed: CommercialReplaySnapshot,
  effectiveTarget: EffectiveReplayTarget,
): CommercialReplayDecisionEquivalence {
  const stored = decisionSignature(record.current);
  const replayedDecision = decisionSignature(replayed);
  const cohorts = [
    cohortName('label', effectiveTarget.label),
    cohortName('expected-action', effectiveTarget.expectedAction),
    `target-source:${effectiveTarget.source}`,
    cohortName('category', record.category),
    cohortName('policy', record.policyCategory),
    cohortName('segment', record.segment),
    `hard-negative:${record.isHardNegative}`,
    `settings:${record.settings.commercialAdsSensitivity}-${record.settings.commercialAdsWarnThreshold}-${record.settings.commercialAdsDeleteThreshold}`,
    campaignCohort(record.commercialCampaignContext),
    cohortName('stored-action', actionName(record.current)),
  ];
  return {
    exact: isDeepStrictEqual(stored, replayedDecision),
    stored,
    replayed: replayedDecision,
    hitTransition: `${record.current.hit}->${replayed.hit}`,
    actionTransition: `${actionName(record.current)}->${actionName(replayed)}`,
    subtypeTransition: `${subtypeName(record.current)}->${subtypeName(replayed)}`,
    cohorts: [...new Set(cohorts)].sort(),
  };
}

function actionRank(action: string | null): number {
  switch (action) {
    case 'REVIEW_ONLY':
      return 1;
    case 'WARN':
      return 2;
    case 'DELETE':
      return 3;
    case 'DELETE_AND_ESCALATE':
      return 4;
    default:
      return 0;
  }
}

function expectedActionRank(action: string | null): number | null {
  if (action === 'ALLOW') {
    return 0;
  }
  if (
    action === 'REVIEW_ONLY' ||
    action === 'WARN' ||
    action === 'DELETE' ||
    action === 'DELETE_AND_ESCALATE'
  ) {
    return actionRank(action);
  }
  return null;
}

function isEnforcement(snapshot: CommercialReplaySnapshot): boolean {
  return snapshot.actionBand !== null && ENFORCEMENT_ACTIONS.has(snapshot.actionBand);
}

function deriveChangeKind(
  stored: CommercialReplaySnapshot,
  replayed: CommercialReplaySnapshot,
  materialChangedFields: readonly (keyof CommercialReplaySnapshot)[],
): CommercialReplayChangeKind {
  if (!stored.hit && replayed.hit) {
    return 'NEW_HIT';
  }
  if (stored.hit && !replayed.hit) {
    return 'CLEARED_HIT';
  }
  if (stored.actionBand !== replayed.actionBand) {
    return 'ACTION_CHANGED';
  }
  if (stored.primarySubtype !== replayed.primarySubtype || stored.subtype !== replayed.subtype) {
    return 'SUBTYPE_CHANGED';
  }
  return materialChangedFields.length > 0 ? 'DECISION_METADATA_CHANGED' : 'EXPLANATION_ONLY';
}

function deriveLabelImpact(
  label: string | null,
  expectedAction: string | null,
  stored: CommercialReplaySnapshot,
  replayed: CommercialReplaySnapshot,
): CommercialReplayLabelImpact {
  const storedRank = actionRank(stored.actionBand);
  const replayedRank = actionRank(replayed.actionBand);
  const expectedRank = expectedActionRank(expectedAction);

  if (expectedRank !== null && label === 'negative_candidate') {
    const storedOverage = Math.max(0, storedRank - expectedRank);
    const replayedOverage = Math.max(0, replayedRank - expectedRank);
    if (replayedOverage > storedOverage) {
      return 'POSSIBLE_FALSE_POSITIVE_REGRESSION';
    }
    if (replayedOverage < storedOverage) {
      return 'FALSE_POSITIVE_REDUCTION';
    }
    return 'NEUTRAL';
  }

  if (expectedRank !== null && label === 'positive_candidate') {
    const storedShortfall = Math.max(0, expectedRank - storedRank);
    const replayedShortfall = Math.max(0, expectedRank - replayedRank);
    if (replayedShortfall > storedShortfall) {
      return 'POSSIBLE_RECALL_REGRESSION';
    }
    if (replayedShortfall < storedShortfall) {
      return 'RECALL_GAIN';
    }
    return 'NEUTRAL';
  }

  if (expectedRank !== null && label === 'gray_candidate') {
    const storedOverage = Math.max(0, storedRank - expectedRank);
    const replayedOverage = Math.max(0, replayedRank - expectedRank);
    const storedShortfall = Math.max(0, expectedRank - storedRank);
    const replayedShortfall = Math.max(0, expectedRank - replayedRank);

    if (replayedOverage > storedOverage) {
      return 'POSSIBLE_FALSE_POSITIVE_REGRESSION';
    }
    if (replayedShortfall > storedShortfall) {
      return 'POSSIBLE_RECALL_REGRESSION';
    }
    if (replayedOverage < storedOverage) {
      return 'FALSE_POSITIVE_REDUCTION';
    }
    if (replayedShortfall < storedShortfall) {
      return 'RECALL_GAIN';
    }
    return 'NEUTRAL';
  }

  const storedEnforcement = isEnforcement(stored);
  const replayedEnforcement = isEnforcement(replayed);

  if (label === 'negative_candidate') {
    if (replayedEnforcement && (!storedEnforcement || replayedRank > storedRank)) {
      return 'POSSIBLE_FALSE_POSITIVE_REGRESSION';
    }
    if (storedEnforcement && (!replayedEnforcement || replayedRank < storedRank)) {
      return 'FALSE_POSITIVE_REDUCTION';
    }
  }
  if (label === 'positive_candidate') {
    if (storedEnforcement && (!replayedEnforcement || replayedRank < storedRank)) {
      return 'POSSIBLE_RECALL_REGRESSION';
    }
    if (replayedEnforcement && (!storedEnforcement || replayedRank > storedRank)) {
      return 'RECALL_GAIN';
    }
  }
  return 'NEUTRAL';
}

export function replayCommercialCorpusRecord(params: {
  value: unknown;
  line: number;
  detector: CommercialCorpusDetector;
  manualOverlayRecord?: unknown;
}): CommercialCorpusReplayEvaluation {
  const record = parseCorpusRecord(params.value, params.line);
  const manualOverlay =
    params.manualOverlayRecord === undefined || params.manualOverlayRecord === null
      ? null
      : parseManualOverlayRecord(
          params.manualOverlayRecord,
          `manual overlay for corpus line ${params.line}`,
        );
  if (manualOverlay) {
    validateManualOverlayMatch(manualOverlay, record, params.line);
  }
  const effectiveTarget = deriveEffectiveReplayTarget(record, manualOverlay);
  const detectionContext = createRuleDetectionContext({
    text: record.text,
    settings: record.detectionSettings,
  });
  const replayed = snapshotFromCommercialDetection(
    params.detector.detect({
      normalizedText: detectionContext.normalizedText,
      rawLoweredText: detectionContext.rawLoweredText,
      settings: record.detectionSettings,
      commercialCampaignContext: record.commercialCampaignContext,
    }),
  );
  const equivalence = buildDecisionEquivalence(record, replayed, effectiveTarget);
  const changedFields = SNAPSHOT_FIELDS.filter(
    (field) => !isDeepStrictEqual(record.current[field], replayed[field]),
  );
  const materialChangedFields = changedFields.filter((field) => !EXPLANATION_FIELDS.has(field));

  if (changedFields.length === 0) {
    return {
      changed: false,
      materialChanged: false,
      containsSanitizedPlaceholders: record.containsSanitizedPlaceholders,
      trustBucket: record.trustBucket,
      diff: null,
      equivalence,
    };
  }

  const changes = Object.fromEntries(
    changedFields.map((field) => [
      field,
      {
        stored: record.current[field],
        replayed: replayed[field],
      },
    ]),
  );

  return {
    changed: true,
    materialChanged: materialChangedFields.length > 0,
    containsSanitizedPlaceholders: record.containsSanitizedPlaceholders,
    trustBucket: record.trustBucket,
    equivalence,
    diff: {
      schemaVersion: COMMERCIAL_CORPUS_REPLAY_SCHEMA_VERSION,
      line: params.line,
      textHash: createHash('sha256').update(record.text).digest('hex'),
      text: record.text,
      containsSanitizedPlaceholders: record.containsSanitizedPlaceholders,
      trustBucket: record.trustBucket,
      baselineSource: record.baselineSource,
      label: record.label,
      category: record.category,
      policyCategory: record.policyCategory,
      segment: record.segment,
      expectedAction: record.expectedAction,
      effectiveLabel: effectiveTarget.label,
      effectiveExpectedAction: effectiveTarget.expectedAction,
      expectedActionSource: effectiveTarget.source,
      manualOverlay: manualOverlayProvenance(manualOverlay),
      expectedSubtype: record.expectedSubtype,
      isHardNegative: record.isHardNegative,
      settings: record.settings,
      commercialCampaignContext: record.commercialCampaignContext,
      changeKind: deriveChangeKind(record.current, replayed, materialChangedFields),
      labelImpact: deriveLabelImpact(
        effectiveTarget.label,
        effectiveTarget.expectedAction,
        record.current,
        replayed,
      ),
      materialChanged: materialChangedFields.length > 0,
      changedFields,
      materialChangedFields,
      hitTransition: `${record.current.hit}->${replayed.hit}`,
      actionTransition: `${actionName(record.current)}->${actionName(replayed)}`,
      changes,
    },
  };
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function incrementBounded(map: Map<string, number>, key: string, maximumKeys: number): void {
  const overflowKey = 'overflow:OTHER';
  const resolvedKey =
    map.has(key) || map.size < maximumKeys - 1 || key === overflowKey ? key : overflowKey;
  increment(map, resolvedKey);
}

function sortedCounts(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...map.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function createAggregateState(): CommercialCorpusReplayAggregateState {
  return {
    recordsProcessed: 0,
    unchangedRecords: 0,
    changedRecords: 0,
    materialChangedRecords: 0,
    explanationOnlyRecords: 0,
    emittedDiffRecords: 0,
    hitTransitions: new Map(),
    actionTransitions: new Map(),
    changeKinds: new Map(),
    labelImpacts: new Map(),
    changedFields: new Map(),
    decisionEquivalence: createDecisionAggregateState(),
  };
}

function createDecisionCohortState(): CommercialReplayDecisionCohortState {
  return {
    recordsCompared: 0,
    exactDecisionRecords: 0,
    decisionTransitionRecords: 0,
    hitTransitions: new Map(),
    actionTransitions: new Map(),
    subtypeTransitions: new Map(),
  };
}

function createDecisionAggregateState(): CommercialReplayDecisionAggregateState {
  return {
    ...createDecisionCohortState(),
    cohorts: new Map(),
  };
}

function recordDecisionCohort(
  state: CommercialReplayDecisionCohortState,
  equivalence: CommercialReplayDecisionEquivalence,
): void {
  state.recordsCompared += 1;
  if (equivalence.exact) {
    state.exactDecisionRecords += 1;
  } else {
    state.decisionTransitionRecords += 1;
  }
  increment(state.hitTransitions, equivalence.hitTransition);
  incrementBounded(
    state.actionTransitions,
    equivalence.actionTransition,
    COMMERCIAL_REPLAY_MAX_DECISION_TRANSITIONS,
  );
  incrementBounded(
    state.subtypeTransitions,
    equivalence.subtypeTransition,
    COMMERCIAL_REPLAY_MAX_DECISION_TRANSITIONS,
  );
}

function recordDecisionEquivalence(
  state: CommercialReplayDecisionAggregateState,
  equivalence: CommercialReplayDecisionEquivalence,
): void {
  recordDecisionCohort(state, equivalence);
  const resolvedCohorts = new Set<string>();
  for (const requestedCohort of equivalence.cohorts) {
    const overflowCohort = 'overflow:OTHER';
    const cohort =
      state.cohorts.has(requestedCohort) ||
      state.cohorts.size < COMMERCIAL_REPLAY_MAX_DECISION_COHORTS - 1
        ? requestedCohort
        : overflowCohort;
    resolvedCohorts.add(cohort);
  }
  for (const cohort of resolvedCohorts) {
    const cohortState = state.cohorts.get(cohort) ?? createDecisionCohortState();
    recordDecisionCohort(cohortState, equivalence);
    state.cohorts.set(cohort, cohortState);
  }
}

function summarizeDecisionCohort(
  state: CommercialReplayDecisionCohortState,
): CommercialReplayDecisionCohortSummary {
  return {
    recordsCompared: state.recordsCompared,
    exactDecisionRecords: state.exactDecisionRecords,
    decisionTransitionRecords: state.decisionTransitionRecords,
    hitTransitions: sortedCounts(state.hitTransitions),
    actionTransitions: sortedCounts(state.actionTransitions),
    subtypeTransitions: sortedCounts(state.subtypeTransitions),
  };
}

function summarizeDecisionEquivalence(
  state: CommercialReplayDecisionAggregateState,
): CommercialReplayDecisionEquivalenceSummary {
  return {
    ...summarizeDecisionCohort(state),
    cohorts: Object.fromEntries(
      [...state.cohorts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([cohort, cohortState]) => [cohort, summarizeDecisionCohort(cohortState)]),
    ),
  };
}

function recordAggregateEvaluation(
  state: CommercialCorpusReplayAggregateState,
  evaluation: CommercialCorpusReplayEvaluation,
  emitted: boolean,
): void {
  state.recordsProcessed += 1;
  recordDecisionEquivalence(state.decisionEquivalence, evaluation.equivalence);
  if (!evaluation.changed || !evaluation.diff) {
    state.unchangedRecords += 1;
    return;
  }

  state.changedRecords += 1;
  if (evaluation.materialChanged) {
    state.materialChangedRecords += 1;
  } else {
    state.explanationOnlyRecords += 1;
  }
  if (emitted) {
    state.emittedDiffRecords += 1;
  }
  increment(state.hitTransitions, evaluation.diff.hitTransition);
  increment(state.actionTransitions, evaluation.diff.actionTransition);
  increment(state.changeKinds, evaluation.diff.changeKind);
  increment(state.labelImpacts, evaluation.diff.labelImpact);
  for (const field of evaluation.diff.changedFields) {
    increment(state.changedFields, field);
  }
}

function summarizeAggregate(
  state: CommercialCorpusReplayAggregateState,
): CommercialCorpusReplayAggregateSummary {
  return {
    recordsProcessed: state.recordsProcessed,
    unchangedRecords: state.unchangedRecords,
    changedRecords: state.changedRecords,
    materialChangedRecords: state.materialChangedRecords,
    explanationOnlyRecords: state.explanationOnlyRecords,
    emittedDiffRecords: state.emittedDiffRecords,
    hitTransitions: sortedCounts(state.hitTransitions),
    actionTransitions: sortedCounts(state.actionTransitions),
    changeKinds: sortedCounts(state.changeKinds),
    labelImpacts: sortedCounts(state.labelImpacts),
    changedFields: sortedCounts(state.changedFields),
    decisionEquivalence: summarizeDecisionEquivalence(state.decisionEquivalence),
  };
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return null;
  }
  return typeof error.code === 'string' ? error.code : null;
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function assertOutputAvailable(pathname: string, overwrite: boolean): Promise<void> {
  if (!overwrite && (await pathExists(pathname))) {
    throw new Error(`Output already exists: ${pathname}. Pass --overwrite to replace it.`);
  }
}

function temporarySiblingPath(pathname: string, label: string): string {
  return `${pathname}.${process.pid}.${randomUUID()}.${label}.tmp`;
}

async function unlinkIfExists(pathname: string): Promise<void> {
  try {
    await unlink(pathname);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return;
    }
    throw error;
  }
}

async function appendUtf8(output: FileHandle, value: string): Promise<void> {
  const buffer = Buffer.from(value, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    const result = await output.write(buffer, offset, buffer.length - offset, null);
    if (result.bytesWritten <= 0) {
      throw new Error('Unable to make progress while writing commercial replay diff');
    }
    offset += result.bytesWritten;
  }
}

async function hashFile(pathname: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(pathname)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function outputAlreadyExistsError(pathname: string, cause: unknown): Error {
  return new Error(`Output already exists: ${pathname}. Pass --overwrite to replace it.`, {
    cause,
  });
}

async function publishNoClobberPair(params: {
  temporaryDiffPath: string;
  diffOutputPath: string;
  temporarySummaryPath: string;
  summaryOutputPath: string;
}): Promise<void> {
  let diffPublished = false;
  try {
    try {
      await link(params.temporaryDiffPath, params.diffOutputPath);
      diffPublished = true;
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        throw outputAlreadyExistsError(params.diffOutputPath, error);
      }
      throw error;
    }

    try {
      await link(params.temporarySummaryPath, params.summaryOutputPath);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        throw outputAlreadyExistsError(params.summaryOutputPath, error);
      }
      throw error;
    }
  } catch (error) {
    if (!diffPublished) {
      throw error;
    }
    try {
      await unlinkIfExists(params.diffOutputPath);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Commercial replay publication failed and the partial diff could not be removed',
      );
    }
    throw error;
  }
}

async function backupOutput(pathname: string): Promise<string | null> {
  const backupPath = temporarySiblingPath(pathname, 'backup');
  try {
    await link(pathname, backupPath);
    return backupPath;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function publishOverwritePair(params: {
  temporaryDiffPath: string;
  diffOutputPath: string;
  temporarySummaryPath: string;
  summaryOutputPath: string;
}): Promise<void> {
  const diffBackupPath = await backupOutput(params.diffOutputPath);
  let diffPublished = false;
  let preserveBackup = false;
  try {
    await rename(params.temporaryDiffPath, params.diffOutputPath);
    diffPublished = true;
    await rename(params.temporarySummaryPath, params.summaryOutputPath);
  } catch (error) {
    if (diffPublished) {
      try {
        if (diffBackupPath) {
          await rename(diffBackupPath, params.diffOutputPath);
        } else {
          await unlinkIfExists(params.diffOutputPath);
        }
      } catch (cleanupError) {
        preserveBackup = true;
        throw new AggregateError(
          [error, cleanupError],
          'Commercial replay overwrite failed and the previous diff could not be restored',
        );
      }
    }
    throw error;
  } finally {
    if (diffBackupPath && !preserveBackup) {
      await unlinkIfExists(diffBackupPath).catch(() => undefined);
    }
  }
}

async function publishOutputPair(params: {
  temporaryDiffPath: string;
  diffOutputPath: string;
  temporarySummaryPath: string;
  summaryOutputPath: string;
  overwrite: boolean;
}): Promise<void> {
  if (params.overwrite) {
    await publishOverwritePair(params);
    return;
  }
  await publishNoClobberPair(params);
}

export async function replayCommercialCorpusFile(
  options: ReplayCommercialCorpusFileOptions,
): Promise<CommercialCorpusReplaySummary> {
  const provenance = options.provenance ?? (await resolveCommercialRunProvenance());
  const inputPath = resolve(options.inputPath);
  const diffOutputPath = resolve(options.diffOutputPath);
  const summaryOutputPath = resolve(
    options.summaryOutputPath ?? `${options.diffOutputPath}.summary.json`,
  );
  const manualOverlay = options.manualOverlayPath
    ? await parseManualOverlay(options.manualOverlayPath)
    : null;
  const overwrite = options.overwrite === true;
  const includeExplanationOnly = options.includeExplanationOnly === true;
  const includeUntrustedPlaceholderDiffs = options.includeUntrustedPlaceholderDiffs === true;

  const allPaths = [
    inputPath,
    ...(manualOverlay ? [manualOverlay.path] : []),
    diffOutputPath,
    summaryOutputPath,
  ];
  if (new Set(allPaths).size !== allPaths.length) {
    throw new Error(
      'Input, manual overlay, diff output, and summary output paths must be different',
    );
  }
  await assertCommercialOutputLockPathsSafe([diffOutputPath, summaryOutputPath]);
  await mkdir(dirname(diffOutputPath), { recursive: true });
  await mkdir(dirname(summaryOutputPath), { recursive: true });
  await assertCommercialPathsDistinct(allPaths);
  await assertOutputAvailable(diffOutputPath, overwrite);
  await assertOutputAvailable(summaryOutputPath, overwrite);

  const detector = options.detector ?? new CommercialAdDetector();
  const temporaryDiffPath = temporarySiblingPath(diffOutputPath, 'diff');
  const temporarySummaryPath = temporarySiblingPath(summaryOutputPath, 'summary');
  const output = await open(temporaryDiffPath, 'wx', 0o600);
  const input = createReadStream(inputPath);
  const inputHash = createHash('sha256');
  input.on('data', (chunk) => {
    inputHash.update(chunk);
  });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const trustedAggregates = createAggregateState();
  const untrustedPlaceholderAggregates = createAggregateState();
  let recordsProcessed = 0;
  let emittedDiffRecords = 0;
  let lineNumber = 0;
  let outputBuffer = '';
  let outputClosed = false;
  const matchedManualOverlayLines = new Set<number>();

  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) {
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch (error) {
        throw new Error(`Invalid JSONL at line ${lineNumber}: ${String(error)}`);
      }

      const manualOverlayRecord = manualOverlay?.recordsByCorpusLine.get(lineNumber);
      const evaluation = replayCommercialCorpusRecord({
        value,
        line: lineNumber,
        detector,
        manualOverlayRecord,
      });
      if (manualOverlayRecord) {
        matchedManualOverlayLines.add(lineNumber);
      }
      recordsProcessed += 1;
      const shouldEmit = Boolean(
        evaluation.changed &&
        evaluation.diff &&
        (evaluation.materialChanged || includeExplanationOnly) &&
        (evaluation.trustBucket === 'TRUSTED' || includeUntrustedPlaceholderDiffs),
      );
      const aggregate =
        evaluation.trustBucket === 'TRUSTED' ? trustedAggregates : untrustedPlaceholderAggregates;
      recordAggregateEvaluation(aggregate, evaluation, shouldEmit);

      if (shouldEmit && evaluation.diff) {
        outputBuffer += `${JSON.stringify(evaluation.diff)}\n`;
        emittedDiffRecords += 1;
        if (outputBuffer.length >= OUTPUT_BUFFER_SIZE) {
          await appendUtf8(output, outputBuffer);
          outputBuffer = '';
        }
      }
      options.onProgress?.(recordsProcessed);
    }

    if (
      manualOverlay &&
      matchedManualOverlayLines.size !== manualOverlay.recordsByCorpusLine.size
    ) {
      const missingLines = [...manualOverlay.recordsByCorpusLine.keys()]
        .filter((line) => !matchedManualOverlayLines.has(line))
        .sort((left, right) => left - right);
      throw new Error(
        `Invalid manual overlay ${manualOverlay.path}: corpus lines not found: ${missingLines.join(', ')}`,
      );
    }
    const inputSha256 = inputHash.digest('hex');
    if (manualOverlay && manualOverlay.inputSha256 !== inputSha256) {
      throw new Error(
        `Invalid manual overlay ${manualOverlay.path}: inputSha256 ${manualOverlay.inputSha256} does not match corpus SHA-256 ${inputSha256}`,
      );
    }

    if (outputBuffer) {
      await appendUtf8(output, outputBuffer);
    }
    await output.close();
    outputClosed = true;
    const diffSha256 = await hashFile(temporaryDiffPath);

    const summary: CommercialCorpusReplaySummary = {
      schemaVersion: COMMERCIAL_CORPUS_REPLAY_SCHEMA_VERSION,
      provenance,
      replay: {
        textMode: 'CORPUS_TEXT_AS_STORED',
        trustPolicy: 'SANITIZED_PLACEHOLDERS_REQUIRE_SANITIZED_BASELINE',
      },
      input: {
        path: inputPath,
        sha256: inputSha256,
        manualOverlay: manualOverlay
          ? {
              path: manualOverlay.path,
              sha256: manualOverlay.sha256,
              records: manualOverlay.recordsByCorpusLine.size,
            }
          : null,
      },
      output: {
        diffPath: diffOutputPath,
        summaryPath: summaryOutputPath,
        diffSha256,
        includeExplanationOnly,
        includeUntrustedPlaceholderDiffs,
      },
      recordsProcessed,
      emittedDiffRecords,
      trustBuckets: {
        TRUSTED: summarizeAggregate(trustedAggregates),
        UNTRUSTED_SANITIZED_PLACEHOLDER: summarizeAggregate(untrustedPlaceholderAggregates),
      },
    };
    await writeFile(temporarySummaryPath, `${JSON.stringify(summary, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await withCommercialOutputLocks([diffOutputPath, summaryOutputPath], async () => {
      await assertOutputAvailable(diffOutputPath, overwrite);
      await assertOutputAvailable(summaryOutputPath, overwrite);
      await publishOutputPair({
        temporaryDiffPath,
        diffOutputPath,
        temporarySummaryPath,
        summaryOutputPath,
        overwrite,
      });
    });
    return summary;
  } catch (error) {
    lines.close();
    input.destroy();
    throw error;
  } finally {
    input.destroy();
    if (!outputClosed) {
      await output.close().catch(() => undefined);
    }
    await unlinkIfExists(temporaryDiffPath).catch(() => undefined);
    await unlinkIfExists(temporarySummaryPath).catch(() => undefined);
  }
}
