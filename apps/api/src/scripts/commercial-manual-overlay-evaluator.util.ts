import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

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

export const COMMERCIAL_MANUAL_OVERLAY_EVALUATION_SCHEMA_VERSION =
  'commercial-manual-overlay-evaluation/v3';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MANUAL_ACTIONS = new Set(['ALLOW', 'REVIEW_ONLY', 'WARN', 'DELETE', 'DELETE_AND_ESCALATE']);
const ACTION_ADJUDICATION_CLASSES = new Set(['A', 'B', 'C']);
const ACTION_ADJUDICATION_ACTIONS = new Set(['ALLOW', 'REVIEW_ONLY', 'WARN']);
const ACTION_ADJUDICATION_ACTION_BY_CLASS = {
  A: 'WARN',
  B: 'ALLOW',
  C: 'REVIEW_ONLY',
} as const satisfies Record<
  CommercialActionAdjudicationClass,
  CommercialActionAdjudicationRecommendedAction
>;
const ACTION_ADJUDICATION_REASON_CODE_PATTERN = /^[a-z]+(?:_[a-z]+)*$/u;
const ACTION_ADJUDICATION_REASON_CODE_MAX_LENGTH = 80;
const ACTION_ADJUDICATION_HEADERS = [
  'text_sha256',
  'instances',
  'source_manual_label',
  'adjudicated_class',
  'recommended_action',
  'reason_code',
] as const;
const REPLAYED_ACTIONS = new Set(['REVIEW_ONLY', 'WARN', 'DELETE', 'DELETE_AND_ESCALATE']);
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

export type CommercialManualRecommendationComparison = 'EXACT' | 'UNDER' | 'OVER' | 'UNSPECIFIED';

export type CommercialActionAdjudicationClass = 'A' | 'B' | 'C';

export type CommercialActionAdjudicationRecommendedAction = Extract<
  CommercialManualRecommendedAction,
  'ALLOW' | 'REVIEW_ONLY' | 'WARN'
>;

export type CommercialManualActionAdjudication = {
  adjudicatedClass: CommercialActionAdjudicationClass;
  reasonCode: string;
};

export type CommercialActionAdjudicationExpectation = {
  sha256: string;
  records: number;
  instances: number;
};

export type CommercialManualOverlayEvaluationRecord = {
  schemaVersion: typeof COMMERCIAL_MANUAL_OVERLAY_EVALUATION_SCHEMA_VERSION;
  inputSha256: string;
  overlaySha256: string;
  line: number;
  textSha256: string;
  contextFingerprint: string;
  text: string;
  manualLabel: string;
  confidence: string;
  baseRecommendedAction: CommercialManualRecommendedAction | null;
  recommendedAction: CommercialManualRecommendedAction | null;
  actionAdjudication: CommercialManualActionAdjudication | null;
  sourceFiles: string[];
  settings: CommercialManualOverlaySettings;
  commercialCampaignContext: CommercialManualOverlayCampaignContext | null;
  replayed: {
    hit: boolean;
    action: string;
    actionScore: number | null;
    confidenceScore: number | null;
    subtype: string | null;
    primarySubtype: string | null;
    supportingSubtypes: string[];
    matchedSignals: string[];
    negativeSignals: string[];
    classifierReasons: string[];
    reviewRecommended: boolean;
    reviewReasons: string[];
    reasonCodes: string[];
    safeContextBucket: string | null;
    deleteSuppressed: boolean;
    suppressionReasons: string[];
  };
  recommendationComparison: CommercialManualRecommendationComparison;
};

export type CommercialManualOverlayEvaluationSummary = {
  schemaVersion: typeof COMMERCIAL_MANUAL_OVERLAY_EVALUATION_SCHEMA_VERSION;
  provenance: CommercialRunProvenance;
  input: {
    corpusPath: string;
    corpusSha256: string;
    corpusRecords: number;
    overlayPath: string;
    overlaySha256: string;
    overlayRecords: number;
    actionAdjudication: {
      path: string;
      sha256: string;
      records: number;
      instances: number;
      expected: CommercialActionAdjudicationExpectation | null;
    } | null;
  };
  output: {
    resultsPath: string;
    summaryPath: string;
    resultsSha256: string;
    records: number;
  };
  manualLabelCounts: Record<string, number>;
  replayedActionCounts: Record<string, number>;
  recommendedActionCoverage: {
    specified: number;
    unspecified: number;
    byAction: Record<string, number>;
  };
  recommendationRankComparison: {
    exact: number;
    under: number;
    over: number;
    unspecified: number;
  };
  recommendedActionTransitions: Record<string, number>;
};

export type EvaluateCommercialManualOverlayOptions = {
  inputPath: string;
  overlayPath: string;
  actionAdjudicationPath?: string;
  actionAdjudicationExpected?: CommercialActionAdjudicationExpectation;
  allowPartialActionAdjudication?: boolean;
  resultsOutputPath: string;
  summaryOutputPath?: string;
  overwrite?: boolean;
  detector?: CommercialManualOverlayDetector;
  provenance?: CommercialRunProvenance;
};

export type CommercialManualOverlayDetector = Pick<CommercialAdDetector, 'detect'>;

type ParsedOverlay = {
  path: string;
  sha256: string;
  inputSha256: string;
  recordsByCorpusLine: Map<number, CommercialManualOverlayRecord>;
};

type ParsedActionAdjudicationRecord = CommercialManualActionAdjudication & {
  textSha256: string;
  instances: number;
  sourceManualLabel: string;
  recommendedAction: CommercialActionAdjudicationRecommendedAction;
};

type ParsedActionAdjudication = {
  path: string;
  sha256: string;
  records: number;
  instances: number;
  recordsByTextSha256: Map<string, ParsedActionAdjudicationRecord>;
};

function validateActionAdjudicationExpectation(
  value: CommercialActionAdjudicationExpectation,
): void {
  if (!SHA256_PATTERN.test(value.sha256)) {
    throw new Error('actionAdjudicationExpected.sha256 must be 64 lowercase hex characters');
  }
  for (const field of ['records', 'instances'] as const) {
    if (!Number.isSafeInteger(value[field]) || value[field] <= 0) {
      throw new Error(`actionAdjudicationExpected.${field} must be a safe positive integer`);
    }
  }
}

function assertExpectedActionAdjudication(
  actual: ParsedActionAdjudication,
  expected: CommercialActionAdjudicationExpectation,
): void {
  validateActionAdjudicationExpectation(expected);
  for (const field of ['sha256', 'records', 'instances'] as const) {
    if (actual[field] !== expected[field]) {
      throw new Error(
        `Action adjudication ${field} mismatch: expected ${expected[field]}, found ${actual[field]}`,
      );
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function readRequiredString(record: Record<string, unknown>, field: string, location: string) {
  const value = record[field];
  if (typeof value !== 'string' || !value) {
    throw new Error(`Invalid ${location}: ${field} must be a non-empty string`);
  }
  return value;
}

function readFiniteNumber(record: Record<string, unknown>, field: string, location: string) {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${location}: ${field} must be finite`);
  }
  return value;
}

function parseSettings(value: unknown, location: string): CommercialManualOverlaySettings {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`Invalid ${location}: settings are missing`);
  }
  const sensitivity = record.commercialAdsSensitivity;
  if (sensitivity !== 'BALANCED' && sensitivity !== 'STRICT') {
    throw new Error(`Invalid ${location}: unsupported commercialAdsSensitivity`);
  }
  return {
    commercialAdsSensitivity: sensitivity,
    commercialAdsWarnThreshold: readFiniteNumber(record, 'commercialAdsWarnThreshold', location),
    commercialAdsDeleteThreshold: readFiniteNumber(
      record,
      'commercialAdsDeleteThreshold',
      location,
    ),
  };
}

function parseCampaignContext(
  value: unknown,
  location: string,
): CommercialManualOverlayCampaignContext | null {
  if (value === null || value === undefined) {
    return null;
  }
  const record = asRecord(value);
  if (!record) {
    throw new Error(`Invalid ${location}: commercialCampaignContext must be an object or null`);
  }
  const context: Record<string, number> = {};
  for (const field of CAMPAIGN_CONTEXT_REQUIRED_FIELDS) {
    const number = readFiniteNumber(record, field, location);
    if (number < 0) {
      throw new Error(`Invalid ${location}: ${field} must be non-negative`);
    }
    context[field] = number;
  }
  for (const field of CAMPAIGN_CONTEXT_OPTIONAL_FIELDS) {
    if (record[field] === undefined) {
      continue;
    }
    const number = readFiniteNumber(record, field, location);
    if (number < 0) {
      throw new Error(`Invalid ${location}: ${field} must be non-negative`);
    }
    context[field] = number;
  }
  return context as CommercialManualOverlayCampaignContext;
}

function parseRecommendedAction(
  value: unknown,
  location: string,
): CommercialManualRecommendedAction | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !MANUAL_ACTIONS.has(value)) {
    throw new Error(`Invalid ${location}: unsupported recommendedAction`);
  }
  return value as CommercialManualRecommendedAction;
}

function readSourceFiles(value: unknown, location: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string' || !item)
  ) {
    throw new Error(`Invalid ${location}: sourceFiles must contain non-empty strings`);
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

function physicalLines(value: string): string[] {
  const lines = value.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

async function parseOverlay(overlayPath: string): Promise<ParsedOverlay> {
  const path = resolve(overlayPath);
  const body = await readFile(path, 'utf8');
  const lines = physicalLines(body);
  if (lines.length === 0) {
    throw new Error(`Invalid overlay ${path}: expected at least one JSONL record`);
  }
  const recordsByCorpusLine = new Map<number, CommercialManualOverlayRecord>();
  let expectedInputSha256: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const overlayLine = index + 1;
    const location = `overlay ${path}:${overlayLine}`;
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
    const record = asRecord(value);
    if (!record || record.schemaVersion !== COMMERCIAL_MANUAL_OVERLAY_SCHEMA_VERSION) {
      throw new Error(`Invalid ${location}: unsupported schemaVersion`);
    }
    const inputSha256 = readRequiredString(record, 'inputSha256', location);
    const textSha256 = readRequiredString(record, 'textSha256', location);
    const contextFingerprint = readRequiredString(record, 'contextFingerprint', location);
    if (
      !SHA256_PATTERN.test(inputSha256) ||
      !SHA256_PATTERN.test(textSha256) ||
      !SHA256_PATTERN.test(contextFingerprint)
    ) {
      throw new Error(`Invalid ${location}: SHA-256 fields must be 64 lowercase hex characters`);
    }
    expectedInputSha256 ??= inputSha256;
    if (expectedInputSha256 !== inputSha256) {
      throw new Error(`Invalid ${location}: inputSha256 conflicts with other overlay rows`);
    }
    const corpusLine = record.line;
    if (!Number.isSafeInteger(corpusLine) || (corpusLine as number) <= 0) {
      throw new Error(`Invalid ${location}: line must be a positive integer`);
    }
    if (recordsByCorpusLine.has(corpusLine as number)) {
      throw new Error(`Invalid ${location}: duplicate corpus line ${corpusLine}`);
    }
    const settings = parseSettings(record.settings, location);
    const commercialCampaignContext = parseCampaignContext(
      record.commercialCampaignContext,
      location,
    );
    const calculatedFingerprint = fingerprintCommercialManualOverlayContext(
      settings,
      commercialCampaignContext,
    );
    if (calculatedFingerprint !== contextFingerprint) {
      throw new Error(
        `Invalid ${location}: contextFingerprint ${contextFingerprint} does not match ${calculatedFingerprint}`,
      );
    }
    recordsByCorpusLine.set(corpusLine as number, {
      schemaVersion: COMMERCIAL_MANUAL_OVERLAY_SCHEMA_VERSION,
      inputSha256,
      line: corpusLine as number,
      textSha256,
      manualLabel: readRequiredString(record, 'manualLabel', location),
      confidence: readRequiredString(record, 'confidence', location),
      recommendedAction: parseRecommendedAction(record.recommendedAction, location),
      sourceFiles: readSourceFiles(record.sourceFiles, location),
      settings,
      commercialCampaignContext,
      contextFingerprint,
    });
  }

  return {
    path,
    sha256: sha256(body),
    inputSha256: expectedInputSha256 as string,
    recordsByCorpusLine,
  };
}

function readActionAdjudicationCell(
  cells: readonly string[],
  headers: ReadonlyMap<string, number>,
  field: (typeof ACTION_ADJUDICATION_HEADERS)[number],
  location: string,
): string {
  const index = headers.get(field);
  const value = index === undefined ? '' : (cells[index] ?? '').trim();
  if (!value) {
    throw new Error(`Invalid ${location}: ${field} is required`);
  }
  return value;
}

async function parseActionAdjudication(
  actionAdjudicationPath: string,
  overlay: ParsedOverlay,
): Promise<ParsedActionAdjudication> {
  const path = resolve(actionAdjudicationPath);
  const body = await readFile(path, 'utf8');
  const lines = physicalLines(body);
  if (lines.length < 2) {
    throw new Error(`Invalid action adjudication ${path}: expected a header and at least one row`);
  }

  const headerCells = lines[0].split('\t');
  const headers = new Map<string, number>();
  for (const [index, rawHeader] of headerCells.entries()) {
    const header = rawHeader.replace(/^\uFEFF/u, '').trim();
    if (!header || headers.has(header)) {
      throw new Error(`Invalid action adjudication ${path}: duplicate or empty header ${header}`);
    }
    headers.set(header, index);
  }
  const missingHeaders = ACTION_ADJUDICATION_HEADERS.filter((header) => !headers.has(header));
  const unknownHeaders = [...headers.keys()].filter(
    (header) => !(ACTION_ADJUDICATION_HEADERS as readonly string[]).includes(header),
  );
  if (missingHeaders.length > 0 || unknownHeaders.length > 0) {
    throw new Error(
      `Invalid action adjudication ${path}: expected exactly ${ACTION_ADJUDICATION_HEADERS.join(', ')} headers`,
    );
  }

  const overlayRecordsByTextSha256 = new Map<string, CommercialManualOverlayRecord[]>();
  for (const overlayRecord of overlay.recordsByCorpusLine.values()) {
    const records = overlayRecordsByTextSha256.get(overlayRecord.textSha256) ?? [];
    records.push(overlayRecord);
    overlayRecordsByTextSha256.set(overlayRecord.textSha256, records);
  }

  const recordsByTextSha256 = new Map<string, ParsedActionAdjudicationRecord>();
  let instances = 0;
  for (let index = 1; index < lines.length; index += 1) {
    const physicalLine = index + 1;
    const location = `action adjudication ${path}:${physicalLine}`;
    const line = lines[index];
    if (!line) {
      throw new Error(`Invalid ${location}: empty row`);
    }
    const cells = line.split('\t');
    if (cells.length !== headerCells.length) {
      throw new Error(
        `Invalid ${location}: expected ${headerCells.length} columns, found ${cells.length}`,
      );
    }

    const textSha256 = readActionAdjudicationCell(cells, headers, 'text_sha256', location);
    if (!SHA256_PATTERN.test(textSha256)) {
      throw new Error(`Invalid ${location}: text_sha256 must be 64 lowercase hex characters`);
    }
    if (recordsByTextSha256.has(textSha256)) {
      throw new Error(`Invalid ${location}: duplicate text_sha256 ${textSha256}`);
    }

    const instancesCell = readActionAdjudicationCell(cells, headers, 'instances', location);
    if (!/^[1-9]\d*$/u.test(instancesCell)) {
      throw new Error(`Invalid ${location}: instances must be a positive integer`);
    }
    const recordInstances = Number(instancesCell);
    if (!Number.isSafeInteger(recordInstances)) {
      throw new Error(`Invalid ${location}: instances must be a safe positive integer`);
    }

    const sourceManualLabel = readActionAdjudicationCell(
      cells,
      headers,
      'source_manual_label',
      location,
    );
    const adjudicatedClass = readActionAdjudicationCell(
      cells,
      headers,
      'adjudicated_class',
      location,
    );
    if (!ACTION_ADJUDICATION_CLASSES.has(adjudicatedClass)) {
      throw new Error(`Invalid ${location}: adjudicated_class must be A, B, or C`);
    }
    const recommendedAction = readActionAdjudicationCell(
      cells,
      headers,
      'recommended_action',
      location,
    );
    if (!ACTION_ADJUDICATION_ACTIONS.has(recommendedAction)) {
      throw new Error(
        `Invalid ${location}: recommended_action must be ALLOW, WARN, or REVIEW_ONLY`,
      );
    }
    const expectedAction =
      ACTION_ADJUDICATION_ACTION_BY_CLASS[adjudicatedClass as CommercialActionAdjudicationClass];
    if (recommendedAction !== expectedAction) {
      throw new Error(
        `Invalid ${location}: adjudicated_class ${adjudicatedClass} requires recommended_action ${expectedAction}`,
      );
    }
    const reasonCode = readActionAdjudicationCell(cells, headers, 'reason_code', location);
    if (
      reasonCode.length > ACTION_ADJUDICATION_REASON_CODE_MAX_LENGTH ||
      !ACTION_ADJUDICATION_REASON_CODE_PATTERN.test(reasonCode)
    ) {
      throw new Error(
        `Invalid ${location}: reason_code must contain lowercase words separated by underscores and be at most ${ACTION_ADJUDICATION_REASON_CODE_MAX_LENGTH} characters`,
      );
    }

    const overlayRecords = overlayRecordsByTextSha256.get(textSha256);
    if (!overlayRecords) {
      throw new Error(
        `Invalid ${location}: text_sha256 ${textSha256} is not present in the base overlay`,
      );
    }
    if (overlayRecords.length !== recordInstances) {
      throw new Error(
        `Invalid ${location}: instances ${recordInstances} does not match base overlay count ${overlayRecords.length}`,
      );
    }
    const overlayLabels = [...new Set(overlayRecords.map((record) => record.manualLabel))].sort();
    if (overlayLabels.length !== 1 || overlayLabels[0] !== sourceManualLabel) {
      throw new Error(
        `Invalid ${location}: source_manual_label ${sourceManualLabel} does not match base overlay label(s) ${overlayLabels.join(', ')}`,
      );
    }

    recordsByTextSha256.set(textSha256, {
      textSha256,
      instances: recordInstances,
      sourceManualLabel,
      adjudicatedClass: adjudicatedClass as CommercialActionAdjudicationClass,
      recommendedAction: recommendedAction as CommercialActionAdjudicationRecommendedAction,
      reasonCode,
    });
    instances += recordInstances;
  }

  return {
    path,
    sha256: sha256(body),
    records: recordsByTextSha256.size,
    instances,
    recordsByTextSha256,
  };
}

function replayedDecision(detection: CommercialDetection | null) {
  if (!detection) {
    return {
      hit: false,
      action: 'NONE',
      actionScore: null,
      confidenceScore: null,
      subtype: null,
      primarySubtype: null,
      supportingSubtypes: [],
      matchedSignals: [],
      negativeSignals: [],
      classifierReasons: [],
      reviewRecommended: false,
      reviewReasons: [],
      reasonCodes: [],
      safeContextBucket: null,
      deleteSuppressed: false,
      suppressionReasons: [],
    };
  }
  if (typeof detection.actionBand !== 'string' || !REPLAYED_ACTIONS.has(detection.actionBand)) {
    throw new Error('Commercial detector returned a hit without a supported actionBand');
  }
  return {
    hit: true,
    action: detection.actionBand,
    actionScore:
      typeof detection.actionScore === 'number' && Number.isFinite(detection.actionScore)
        ? detection.actionScore
        : null,
    confidenceScore: detection.confidenceScore,
    subtype: detection.subtype ?? detection.primarySubtype,
    primarySubtype: detection.primarySubtype,
    supportingSubtypes: [...detection.supportingSubtypes],
    matchedSignals: [...detection.matchedSignals],
    negativeSignals: [...detection.negativeSignals],
    classifierReasons: [...detection.classifierReasons],
    reviewRecommended: detection.reviewRecommended,
    reviewReasons: [...detection.reviewReasons],
    reasonCodes: [...(detection.reasonCodes ?? [])],
    safeContextBucket: detection.safeContextBucket ?? null,
    deleteSuppressed: detection.deleteSuppressed === true,
    suppressionReasons: [...(detection.suppressionReasons ?? [])],
  };
}

function actionRank(action: string): number {
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

function compareRecommendation(
  recommendedAction: CommercialManualRecommendedAction | null,
  replayedAction: string,
): CommercialManualRecommendationComparison {
  if (recommendedAction === null) {
    return 'UNSPECIFIED';
  }
  const recommendedRank = actionRank(recommendedAction);
  const replayedRank = actionRank(replayedAction);
  if (replayedRank === recommendedRank) {
    return 'EXACT';
  }
  return replayedRank < recommendedRank ? 'UNDER' : 'OVER';
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sortedCounts(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
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
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
  }
}

function outputAlreadyExistsError(pathname: string, cause: unknown): Error {
  return new Error(`Output already exists: ${pathname}. Pass --overwrite to replace it.`, {
    cause,
  });
}

async function publishNoClobberPair(params: {
  temporaryResultsPath: string;
  resultsOutputPath: string;
  temporarySummaryPath: string;
  summaryOutputPath: string;
}): Promise<void> {
  let resultsPublished = false;
  try {
    try {
      await link(params.temporaryResultsPath, params.resultsOutputPath);
      resultsPublished = true;
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        throw outputAlreadyExistsError(params.resultsOutputPath, error);
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
    if (resultsPublished) {
      try {
        await unlinkIfExists(params.resultsOutputPath);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Manual overlay evaluation publication failed and partial results remain',
        );
      }
    }
    throw error;
  }
}

async function backupOutput(pathname: string): Promise<string | null> {
  const backupPath = temporarySiblingPath(pathname, 'backup');
  let body: Buffer;
  try {
    body = await readFile(pathname);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
  await writeFile(backupPath, body, { flag: 'wx', mode: 0o600 });
  return backupPath;
}

async function publishOverwritePair(params: {
  temporaryResultsPath: string;
  resultsOutputPath: string;
  temporarySummaryPath: string;
  summaryOutputPath: string;
}): Promise<void> {
  const resultsBackupPath = await backupOutput(params.resultsOutputPath);
  let resultsPublished = false;
  let preserveBackup = false;
  try {
    await rename(params.temporaryResultsPath, params.resultsOutputPath);
    resultsPublished = true;
    await rename(params.temporarySummaryPath, params.summaryOutputPath);
  } catch (error) {
    if (resultsPublished) {
      try {
        if (resultsBackupPath) {
          await rename(resultsBackupPath, params.resultsOutputPath);
        } else {
          await unlinkIfExists(params.resultsOutputPath);
        }
      } catch (cleanupError) {
        preserveBackup = true;
        throw new AggregateError(
          [error, cleanupError],
          'Manual overlay evaluation overwrite failed and previous results were not restored',
        );
      }
    }
    throw error;
  } finally {
    if (resultsBackupPath && !preserveBackup) {
      await unlinkIfExists(resultsBackupPath).catch(() => undefined);
    }
  }
}

async function publishOutputPair(params: {
  temporaryResultsPath: string;
  resultsOutputPath: string;
  temporarySummaryPath: string;
  summaryOutputPath: string;
  overwrite: boolean;
}): Promise<void> {
  if (params.overwrite) {
    await publishOverwritePair(params);
  } else {
    await publishNoClobberPair(params);
  }
}

export async function evaluateCommercialManualOverlay(
  options: EvaluateCommercialManualOverlayOptions,
): Promise<CommercialManualOverlayEvaluationSummary> {
  const allowPartialActionAdjudication = options.allowPartialActionAdjudication === true;
  if (options.actionAdjudicationExpected && !options.actionAdjudicationPath) {
    throw new Error('actionAdjudicationExpected requires actionAdjudicationPath');
  }
  if (allowPartialActionAdjudication && !options.actionAdjudicationPath) {
    throw new Error('allowPartialActionAdjudication requires actionAdjudicationPath');
  }
  if (allowPartialActionAdjudication && options.actionAdjudicationExpected) {
    throw new Error(
      'allowPartialActionAdjudication cannot be combined with actionAdjudicationExpected',
    );
  }
  if (
    options.actionAdjudicationPath &&
    !options.actionAdjudicationExpected &&
    !allowPartialActionAdjudication
  ) {
    throw new Error(
      'actionAdjudicationPath requires a frozen identity gate or explicit partial-adjudication opt-in',
    );
  }
  if (options.actionAdjudicationExpected) {
    validateActionAdjudicationExpectation(options.actionAdjudicationExpected);
  }
  const provenance = options.provenance ?? (await resolveCommercialRunProvenance());
  const inputPath = resolve(options.inputPath);
  const overlayPath = resolve(options.overlayPath);
  const actionAdjudicationPath = options.actionAdjudicationPath
    ? resolve(options.actionAdjudicationPath)
    : null;
  const resultsOutputPath = resolve(options.resultsOutputPath);
  const summaryOutputPath = resolve(
    options.summaryOutputPath ?? `${options.resultsOutputPath}.summary.json`,
  );
  const overwrite = options.overwrite === true;
  const allPaths = [
    inputPath,
    overlayPath,
    ...(actionAdjudicationPath ? [actionAdjudicationPath] : []),
    resultsOutputPath,
    summaryOutputPath,
  ];
  if (new Set(allPaths).size !== allPaths.length) {
    throw new Error(
      'Input, overlay, action adjudication, results, and summary paths must be different',
    );
  }
  await assertCommercialOutputLockPathsSafe([resultsOutputPath, summaryOutputPath]);
  await mkdir(dirname(resultsOutputPath), { recursive: true });
  await mkdir(dirname(summaryOutputPath), { recursive: true });
  await assertCommercialPathsDistinct(allPaths);
  await assertOutputAvailable(resultsOutputPath, overwrite);
  await assertOutputAvailable(summaryOutputPath, overwrite);

  const overlay = await parseOverlay(overlayPath);
  const actionAdjudication = actionAdjudicationPath
    ? await parseActionAdjudication(actionAdjudicationPath, overlay)
    : null;
  if (actionAdjudication && options.actionAdjudicationExpected) {
    assertExpectedActionAdjudication(actionAdjudication, options.actionAdjudicationExpected);
  }
  const detector = options.detector ?? new CommercialAdDetector();
  const inputHash = createHash('sha256');
  const input = createReadStream(inputPath);
  input.on('data', (chunk) => inputHash.update(chunk));
  const reader = createInterface({ input, crlfDelay: Infinity });
  const evaluations: CommercialManualOverlayEvaluationRecord[] = [];
  const matchedLines = new Set<number>();
  let physicalLine = 0;
  let corpusRecords = 0;

  try {
    for await (const line of reader) {
      physicalLine += 1;
      if (!line.trim()) {
        continue;
      }
      corpusRecords += 1;
      const overlayRecord = overlay.recordsByCorpusLine.get(physicalLine);
      if (!overlayRecord) {
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch (error) {
        throw new Error(`Invalid corpus JSON at line ${physicalLine}: ${String(error)}`);
      }
      const corpusRecord = asRecord(value);
      if (!corpusRecord || typeof corpusRecord.text !== 'string' || !corpusRecord.text) {
        throw new Error(`Invalid corpus record at line ${physicalLine}: text is required`);
      }
      const textSha256 = sha256(corpusRecord.text);
      if (textSha256 !== overlayRecord.textSha256) {
        throw new Error(
          `Overlay textSha256 mismatch at corpus line ${physicalLine}: expected ${overlayRecord.textSha256}, found ${textSha256}`,
        );
      }
      const settings = parseSettings(corpusRecord.settings, `corpus line ${physicalLine}`);
      const commercialCampaignContext = parseCampaignContext(
        corpusRecord.commercialCampaignContext,
        `corpus line ${physicalLine}`,
      );
      const contextFingerprint = fingerprintCommercialManualOverlayContext(
        settings,
        commercialCampaignContext,
      );
      if (contextFingerprint !== overlayRecord.contextFingerprint) {
        throw new Error(
          `Overlay contextFingerprint mismatch at corpus line ${physicalLine}: expected ${overlayRecord.contextFingerprint}, found ${contextFingerprint}`,
        );
      }
      if (
        !isDeepStrictEqual(settings, overlayRecord.settings) ||
        !isDeepStrictEqual(commercialCampaignContext, overlayRecord.commercialCampaignContext)
      ) {
        throw new Error(
          `Overlay settings/campaign context mismatch at corpus line ${physicalLine}`,
        );
      }

      const detectionSettings = {
        commercialAdsFilterEnabled: true,
        ...settings,
      } as ChatSettings;
      const detectionContext = createRuleDetectionContext({
        text: corpusRecord.text,
        settings: detectionSettings,
      });
      const replayed = replayedDecision(
        detector.detect({
          normalizedText: detectionContext.normalizedText,
          rawLoweredText: detectionContext.rawLoweredText,
          settings: detectionSettings,
          commercialCampaignContext: commercialCampaignContext as CommercialCampaignContext | null,
        }),
      );
      const adjudicationRecord = actionAdjudication?.recordsByTextSha256.get(textSha256) ?? null;
      const baseRecommendedAction = overlayRecord.recommendedAction;
      const recommendedAction = adjudicationRecord?.recommendedAction ?? baseRecommendedAction;
      evaluations.push({
        schemaVersion: COMMERCIAL_MANUAL_OVERLAY_EVALUATION_SCHEMA_VERSION,
        inputSha256: overlayRecord.inputSha256,
        overlaySha256: overlay.sha256,
        line: physicalLine,
        textSha256,
        contextFingerprint,
        text: corpusRecord.text,
        manualLabel: overlayRecord.manualLabel,
        confidence: overlayRecord.confidence,
        baseRecommendedAction,
        recommendedAction,
        actionAdjudication: adjudicationRecord
          ? {
              adjudicatedClass: adjudicationRecord.adjudicatedClass,
              reasonCode: adjudicationRecord.reasonCode,
            }
          : null,
        sourceFiles: [...overlayRecord.sourceFiles],
        settings,
        commercialCampaignContext,
        replayed,
        recommendationComparison: compareRecommendation(recommendedAction, replayed.action),
      });
      matchedLines.add(physicalLine);
    }
  } catch (error) {
    input.destroy();
    throw error;
  } finally {
    reader.close();
    input.destroy();
  }

  const corpusSha256 = inputHash.digest('hex');
  if (corpusSha256 !== overlay.inputSha256) {
    throw new Error(
      `Overlay inputSha256 mismatch: expected ${overlay.inputSha256}, found ${corpusSha256}`,
    );
  }
  if (matchedLines.size !== overlay.recordsByCorpusLine.size) {
    const missing = [...overlay.recordsByCorpusLine.keys()]
      .filter((line) => !matchedLines.has(line))
      .sort((left, right) => left - right);
    throw new Error(`Overlay lines not found in corpus: ${missing.slice(0, 20).join(', ')}`);
  }

  const manualLabelCounts = new Map<string, number>();
  const replayedActionCounts = new Map<string, number>();
  const recommendedActionCounts = new Map<string, number>();
  const recommendedActionTransitions = new Map<string, number>();
  const comparisonCounts = {
    exact: 0,
    under: 0,
    over: 0,
    unspecified: 0,
  };
  let specifiedRecommendations = 0;
  for (const evaluation of evaluations) {
    increment(manualLabelCounts, evaluation.manualLabel);
    increment(replayedActionCounts, evaluation.replayed.action);
    const recommendation = evaluation.recommendedAction ?? 'UNSPECIFIED';
    increment(recommendedActionTransitions, `${recommendation}->${evaluation.replayed.action}`);
    if (evaluation.recommendedAction) {
      specifiedRecommendations += 1;
      increment(recommendedActionCounts, evaluation.recommendedAction);
    }
    switch (evaluation.recommendationComparison) {
      case 'EXACT':
        comparisonCounts.exact += 1;
        break;
      case 'UNDER':
        comparisonCounts.under += 1;
        break;
      case 'OVER':
        comparisonCounts.over += 1;
        break;
      default:
        comparisonCounts.unspecified += 1;
    }
  }

  const resultsBody = `${evaluations.map((evaluation) => JSON.stringify(evaluation)).join('\n')}\n`;
  const resultsSha256 = sha256(resultsBody);
  const summary: CommercialManualOverlayEvaluationSummary = {
    schemaVersion: COMMERCIAL_MANUAL_OVERLAY_EVALUATION_SCHEMA_VERSION,
    provenance,
    input: {
      corpusPath: inputPath,
      corpusSha256,
      corpusRecords,
      overlayPath,
      overlaySha256: overlay.sha256,
      overlayRecords: overlay.recordsByCorpusLine.size,
      actionAdjudication: actionAdjudication
        ? {
            path: actionAdjudication.path,
            sha256: actionAdjudication.sha256,
            records: actionAdjudication.records,
            instances: actionAdjudication.instances,
            expected: options.actionAdjudicationExpected
              ? { ...options.actionAdjudicationExpected }
              : null,
          }
        : null,
    },
    output: {
      resultsPath: resultsOutputPath,
      summaryPath: summaryOutputPath,
      resultsSha256,
      records: evaluations.length,
    },
    manualLabelCounts: sortedCounts(manualLabelCounts),
    replayedActionCounts: sortedCounts(replayedActionCounts),
    recommendedActionCoverage: {
      specified: specifiedRecommendations,
      unspecified: evaluations.length - specifiedRecommendations,
      byAction: sortedCounts(recommendedActionCounts),
    },
    recommendationRankComparison: comparisonCounts,
    recommendedActionTransitions: sortedCounts(recommendedActionTransitions),
  };

  const temporaryResultsPath = temporarySiblingPath(resultsOutputPath, 'results');
  const temporarySummaryPath = temporarySiblingPath(summaryOutputPath, 'summary');
  try {
    await writeFile(temporaryResultsPath, resultsBody, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(temporarySummaryPath, `${JSON.stringify(summary, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await withCommercialOutputLocks([resultsOutputPath, summaryOutputPath], async () => {
      await assertOutputAvailable(resultsOutputPath, overwrite);
      await assertOutputAvailable(summaryOutputPath, overwrite);
      await publishOutputPair({
        temporaryResultsPath,
        resultsOutputPath,
        temporarySummaryPath,
        summaryOutputPath,
        overwrite,
      });
    });
    return summary;
  } finally {
    await unlinkIfExists(temporaryResultsPath).catch(() => undefined);
    await unlinkIfExists(temporarySummaryPath).catch(() => undefined);
  }
}
