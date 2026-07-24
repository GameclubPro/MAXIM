import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { isCommercialCorpusTextSanitized } from './commercial-corpus-sanitization.util';

export type CommercialCorpusLabel = 'positive_candidate' | 'negative_candidate' | 'gray_candidate';

type CommercialSnapshot = {
  hit?: unknown;
  actionBand?: unknown;
  primarySubtype?: unknown;
  subtype?: unknown;
};

export type CommercialCorpusRecord = {
  label?: unknown;
  labelSource?: unknown;
  expectedAction?: unknown;
  expectedSubtype?: unknown;
  isHardNegative?: unknown;
  policyCategory?: unknown;
  segment?: unknown;
  safeContextBucket?: unknown;
  text?: unknown;
  current?: unknown;
  historical?: unknown;
  sanitizedBaseline?: unknown;
};

type CliOptions = CommercialCorpusGateOptions & {
  inputPath: string;
};

export type CommercialCorpusGateOptions = {
  minPositive: number;
  minNegative: number;
  minGray: number;
  minHardRecall: number;
  minEnforcementRecall: number;
  maxFalsePositiveRate: number;
  minSubtypeAccuracy: number;
};

export type CommercialCorpusMetrics = {
  records: number;
  positiveCount: number;
  negativeCount: number;
  grayCount: number;
  autoPositiveCount: number;
  autoPositiveHitCount: number;
  autoPositiveEnforcementEligibleCount: number;
  autoPositiveEnforcementHitCount: number;
  autoPositiveDetectionRecall: number;
  autoPositiveEnforcementRecall: number;
  autoNegativeCount: number;
  autoNegativeHitCount: number;
  autoNegativeEnforcementCount: number;
  autoNegativeHitRate: number;
  autoSubtypeComparableCount: number;
  autoSubtypeMatchCount: number;
  autoSubtypeAccuracy: number;
  trustedManualCount: number;
  trustedManualActionComparableCount: number;
  trustedManualActionMismatchCount: number;
  trustedManualNegativeCount: number;
  trustedManualNegativeHitCount: number;
  trustedManualNegativeEnforcementCount: number;
  trustedManualNegativeDeleteCount: number;
  trustedManualEnforcementFalsePositiveRate: number;
  trustedManualHardNegativeNonAllowCount: number;
  trustedManualSubtypeComparableCount: number;
  trustedManualSubtypeMismatchCount: number;
  campaignOnlyDeleteCount: number;
  labelCounts: Map<string, number>;
  labelSourceCounts: Map<string, number>;
  actionCounts: Map<string, number>;
  segmentCounts: Map<string, number>;
  safeContextBucketCounts: Map<string, number>;
  safeContextHitCounts: Map<string, number>;
};

export type CommercialCorpusValidationResult = {
  errors: string[];
  diagnostics: string[];
  metrics: CommercialCorpusMetrics;
};

export const COMMERCIAL_CORPUS_AUTO_LABEL_SOURCE = 'commercial-audit-policy-v1';
export const COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE = 'commercial-manual-review-v1';

export const DEFAULT_COMMERCIAL_CORPUS_GATES: CommercialCorpusGateOptions = {
  minPositive: 1000,
  minNegative: 5000,
  minGray: 500,
  minHardRecall: 0.98,
  minEnforcementRecall: 0.98,
  maxFalsePositiveRate: 0.001,
  minSubtypeAccuracy: 0.93,
};

const DELETE_ACTIONS = new Set(['DELETE', 'DELETE_AND_ESCALATE']);
const ENFORCEMENT_ACTIONS = new Set(['WARN', ...DELETE_ACTIONS]);
const LABELS = new Set<CommercialCorpusLabel>([
  'positive_candidate',
  'negative_candidate',
  'gray_candidate',
]);
const LABEL_SOURCES = new Set([
  COMMERCIAL_CORPUS_AUTO_LABEL_SOURCE,
  COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE,
]);

function readCliOptions(argv: readonly string[]): CliOptions {
  const inputPath = readStringOption(argv, '--input');
  if (!inputPath) {
    throw new Error(
      'Usage: npm run moderation:validate-commercial-corpus -- --input <commercial-corpus.jsonl>',
    );
  }

  return {
    inputPath,
    minPositive:
      readNumberOption(argv, '--min-positive') ?? DEFAULT_COMMERCIAL_CORPUS_GATES.minPositive,
    minNegative:
      readNumberOption(argv, '--min-negative') ?? DEFAULT_COMMERCIAL_CORPUS_GATES.minNegative,
    minGray: readNumberOption(argv, '--min-gray') ?? DEFAULT_COMMERCIAL_CORPUS_GATES.minGray,
    minHardRecall:
      readNumberOption(argv, '--min-hard-recall') ?? DEFAULT_COMMERCIAL_CORPUS_GATES.minHardRecall,
    minEnforcementRecall:
      readNumberOption(argv, '--min-enforcement-recall') ??
      DEFAULT_COMMERCIAL_CORPUS_GATES.minEnforcementRecall,
    maxFalsePositiveRate:
      readNumberOption(argv, '--max-false-positive-rate') ??
      DEFAULT_COMMERCIAL_CORPUS_GATES.maxFalsePositiveRate,
    minSubtypeAccuracy:
      readNumberOption(argv, '--min-subtype-accuracy') ??
      DEFAULT_COMMERCIAL_CORPUS_GATES.minSubtypeAccuracy,
  };
}

function readStringOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.findIndex((arg) => arg === name);
  if (index < 0) {
    return undefined;
  }

  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }

  return value;
}

function readNumberOption(argv: readonly string[], name: string): number | undefined {
  const value = readStringOption(argv, name);
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }

  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readSnapshot(value: unknown): CommercialSnapshot {
  const record = asRecord(value);
  if (!record) {
    return {};
  }

  return {
    hit: record.hit,
    actionBand: record.actionBand,
    primarySubtype: record.primarySubtype,
    subtype: record.subtype,
  };
}

function readCorpusRecord(value: unknown): CommercialCorpusRecord | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  return {
    label: record.label,
    labelSource: record.labelSource,
    expectedAction: record.expectedAction,
    expectedSubtype: record.expectedSubtype,
    isHardNegative: record.isHardNegative,
    policyCategory: record.policyCategory,
    segment: record.segment,
    safeContextBucket: record.safeContextBucket,
    text: record.text,
    current: record.current,
    historical: record.historical,
    sanitizedBaseline: record.sanitizedBaseline,
  };
}

function isDeleteAction(action: unknown): boolean {
  return typeof action === 'string' && DELETE_ACTIONS.has(action);
}

function isEnforcementAction(action: unknown): boolean {
  return typeof action === 'string' && ENFORCEMENT_ACTIONS.has(action);
}

function actionRank(action: string | null): number | null {
  switch (action) {
    case null:
    case 'NONE':
    case 'ALLOW':
      return 0;
    case 'REVIEW_ONLY':
      return 1;
    case 'WARN':
      return 2;
    case 'DELETE':
      return 3;
    case 'DELETE_AND_ESCALATE':
      return 4;
    default:
      return null;
  }
}

function pushCount(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : Number.NaN;
}

function isAllowedCampaignOnlyWarn(params: {
  label: CommercialCorpusLabel;
  policyCategory: string | null;
  expectedAction: string | null;
  currentAction: string | null;
}): boolean {
  return (
    params.label === 'gray_candidate' &&
    params.policyCategory === 'campaign_only' &&
    params.expectedAction === 'REVIEW_ONLY' &&
    params.currentAction === 'WARN'
  );
}

export function analyzeCommercialCorpusRecords(
  records: readonly CommercialCorpusRecord[],
): CommercialCorpusValidationResult {
  const errors: string[] = [];
  const diagnostics: string[] = [];
  const labelCounts = new Map<string, number>();
  const labelSourceCounts = new Map<string, number>();
  const actionCounts = new Map<string, number>();
  const segmentCounts = new Map<string, number>();
  const safeContextBucketCounts = new Map<string, number>();
  const safeContextHitCounts = new Map<string, number>();
  let positiveCount = 0;
  let negativeCount = 0;
  let grayCount = 0;
  let autoPositiveCount = 0;
  let autoPositiveHitCount = 0;
  let autoPositiveEnforcementEligibleCount = 0;
  let autoPositiveEnforcementHitCount = 0;
  let autoNegativeCount = 0;
  let autoNegativeHitCount = 0;
  let autoNegativeEnforcementCount = 0;
  let autoSubtypeComparableCount = 0;
  let autoSubtypeMatchCount = 0;
  let trustedManualCount = 0;
  let trustedManualActionComparableCount = 0;
  let trustedManualActionMismatchCount = 0;
  let trustedManualNegativeCount = 0;
  let trustedManualNegativeHitCount = 0;
  let trustedManualNegativeEnforcementCount = 0;
  let trustedManualNegativeDeleteCount = 0;
  let trustedManualHardNegativeNonAllowCount = 0;
  let trustedManualSubtypeComparableCount = 0;
  let trustedManualSubtypeMismatchCount = 0;
  let campaignOnlyDeleteCount = 0;

  for (const [index, record] of records.entries()) {
    const lineNumber = index + 1;
    const label = readString(record.label);
    const labelSource = readString(record.labelSource);
    const expectedAction = readString(record.expectedAction);
    const expectedSubtype = readString(record.expectedSubtype);
    const policyCategory = readString(record.policyCategory);
    const segment = readString(record.segment) ?? 'UNKNOWN';
    const safeContextBucket = readString(record.safeContextBucket) ?? 'none';
    const text = readString(record.text);
    const current = readSnapshot(record.sanitizedBaseline ?? record.current);
    const historical = readSnapshot(record.historical);
    const currentAction = readString(current.actionBand);
    const currentActionRank = actionRank(currentAction);
    const expectedActionRank = actionRank(expectedAction);
    const currentSubtype = readString(current.primarySubtype) ?? readString(current.subtype);
    const currentHit = current.hit === true;
    const historicalHit = historical.hit === true;

    if (!label || !LABELS.has(label as CommercialCorpusLabel)) {
      errors.push(`line ${lineNumber}: unknown label ${label ?? 'null'}`);
      continue;
    }
    const typedLabel = label as CommercialCorpusLabel;
    if (!labelSource || !LABEL_SOURCES.has(labelSource)) {
      errors.push(`line ${lineNumber}: unknown labelSource ${labelSource ?? 'null'}`);
    }
    if (!text || !isCommercialCorpusTextSanitized(text)) {
      errors.push(`line ${lineNumber}: text is missing or not sanitized`);
    }
    if (current.hit !== true && current.hit !== false) {
      errors.push(`line ${lineNumber}: current hit must be boolean`);
    }
    if (currentActionRank === null) {
      errors.push(`line ${lineNumber}: unsupported current action ${currentAction}`);
    }
    if (expectedActionRank === null) {
      errors.push(`line ${lineNumber}: unsupported expectedAction ${expectedAction ?? 'null'}`);
    }

    pushCount(labelCounts, label);
    pushCount(labelSourceCounts, labelSource ?? 'UNKNOWN');
    pushCount(segmentCounts, segment);
    pushCount(safeContextBucketCounts, safeContextBucket);
    if (currentAction) {
      pushCount(actionCounts, currentAction);
    }
    if (currentHit && safeContextBucket !== 'none') {
      pushCount(safeContextHitCounts, safeContextBucket);
    }

    const isAuto = labelSource === COMMERCIAL_CORPUS_AUTO_LABEL_SOURCE;
    const isTrustedManual = labelSource === COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE;
    if (isTrustedManual) {
      trustedManualCount += 1;
    }

    if (typedLabel === 'positive_candidate') {
      positiveCount += 1;
      if (!expectedSubtype) {
        errors.push(`line ${lineNumber}: positive candidate requires expectedSubtype`);
      }
      if (expectedActionRank !== null && expectedActionRank < 2) {
        errors.push(
          `line ${lineNumber}: positive candidate expectedAction must be WARN or stronger`,
        );
      }
      if (isAuto && !currentHit && !historicalHit) {
        errors.push(`line ${lineNumber}: auto positive candidate has no current or historical hit`);
      }
      if (record.isHardNegative === true) {
        errors.push(`line ${lineNumber}: positive candidate cannot be marked hard-negative`);
      }

      if (isAuto) {
        autoPositiveCount += 1;
        if (currentHit) {
          autoPositiveHitCount += 1;
        }
        if (expectedActionRank !== null && expectedActionRank >= 2) {
          autoPositiveEnforcementEligibleCount += 1;
          if (isEnforcementAction(currentAction)) {
            autoPositiveEnforcementHitCount += 1;
          }
        }
        if (currentHit && expectedSubtype && currentSubtype) {
          autoSubtypeComparableCount += 1;
          if (currentSubtype === expectedSubtype) {
            autoSubtypeMatchCount += 1;
          }
        }
      } else if (isTrustedManual) {
        trustedManualActionComparableCount += 1;
        if (currentActionRank !== expectedActionRank) {
          trustedManualActionMismatchCount += 1;
        }
        if (expectedSubtype) {
          trustedManualSubtypeComparableCount += 1;
          if (!currentHit || currentSubtype !== expectedSubtype) {
            trustedManualSubtypeMismatchCount += 1;
          }
        }
      }
    } else if (typedLabel === 'negative_candidate') {
      negativeCount += 1;
      if (expectedAction !== 'ALLOW') {
        errors.push(`line ${lineNumber}: negative candidate expectedAction must be ALLOW`);
      }

      if (isAuto) {
        autoNegativeCount += 1;
        if (currentHit) {
          autoNegativeHitCount += 1;
        }
        if (isEnforcementAction(currentAction)) {
          autoNegativeEnforcementCount += 1;
        }
      } else if (isTrustedManual) {
        trustedManualNegativeCount += 1;
        if (currentHit) {
          trustedManualNegativeHitCount += 1;
        }
        if (isEnforcementAction(currentAction)) {
          trustedManualNegativeEnforcementCount += 1;
        }
        if (isDeleteAction(currentAction)) {
          trustedManualNegativeDeleteCount += 1;
        }
        if (record.isHardNegative === true && currentActionRank !== null && currentActionRank > 0) {
          trustedManualHardNegativeNonAllowCount += 1;
        }
      }
    } else {
      grayCount += 1;
      if (expectedAction !== 'WARN' && expectedAction !== 'REVIEW_ONLY') {
        errors.push(`line ${lineNumber}: gray candidate expectedAction must be WARN/REVIEW_ONLY`);
      }

      if (isTrustedManual) {
        trustedManualActionComparableCount += 1;
        if (
          currentActionRank !== expectedActionRank &&
          !isAllowedCampaignOnlyWarn({
            label: typedLabel,
            policyCategory,
            expectedAction,
            currentAction,
          })
        ) {
          trustedManualActionMismatchCount += 1;
        }
        if (expectedSubtype) {
          trustedManualSubtypeComparableCount += 1;
          if (!currentHit || currentSubtype !== expectedSubtype) {
            trustedManualSubtypeMismatchCount += 1;
          }
        }
      }
    }

    if (policyCategory === 'campaign_only' && isDeleteAction(currentAction)) {
      campaignOnlyDeleteCount += 1;
    }
  }

  if (trustedManualNegativeCount === 0) {
    diagnostics.push(
      'trusted_manual_negative_gates=not_evaluated trusted_manual_negative_count=0',
    );
  }

  return {
    errors,
    diagnostics,
    metrics: {
      records: records.length,
      positiveCount,
      negativeCount,
      grayCount,
      autoPositiveCount,
      autoPositiveHitCount,
      autoPositiveEnforcementEligibleCount,
      autoPositiveEnforcementHitCount,
      autoPositiveDetectionRecall: ratio(autoPositiveHitCount, autoPositiveCount),
      autoPositiveEnforcementRecall: ratio(
        autoPositiveEnforcementHitCount,
        autoPositiveEnforcementEligibleCount,
      ),
      autoNegativeCount,
      autoNegativeHitCount,
      autoNegativeEnforcementCount,
      autoNegativeHitRate: ratio(autoNegativeHitCount, autoNegativeCount),
      autoSubtypeComparableCount,
      autoSubtypeMatchCount,
      autoSubtypeAccuracy: ratio(autoSubtypeMatchCount, autoSubtypeComparableCount),
      trustedManualCount,
      trustedManualActionComparableCount,
      trustedManualActionMismatchCount,
      trustedManualNegativeCount,
      trustedManualNegativeHitCount,
      trustedManualNegativeEnforcementCount,
      trustedManualNegativeDeleteCount,
      trustedManualEnforcementFalsePositiveRate:
        trustedManualNegativeCount > 0
          ? trustedManualNegativeEnforcementCount / trustedManualNegativeCount
          : Number.NaN,
      trustedManualHardNegativeNonAllowCount,
      trustedManualSubtypeComparableCount,
      trustedManualSubtypeMismatchCount,
      campaignOnlyDeleteCount,
      labelCounts,
      labelSourceCounts,
      actionCounts,
      segmentCounts,
      safeContextBucketCounts,
      safeContextHitCounts,
    },
  };
}

export function validateCommercialCorpusRecords(
  records: readonly CommercialCorpusRecord[],
  options: CommercialCorpusGateOptions = DEFAULT_COMMERCIAL_CORPUS_GATES,
): CommercialCorpusValidationResult {
  const analysis = analyzeCommercialCorpusRecords(records);
  const errors = [...analysis.errors];
  const diagnostics = [...analysis.diagnostics];
  const { metrics } = analysis;

  if (metrics.positiveCount < options.minPositive) {
    errors.push(`positive_count=${metrics.positiveCount} below min=${options.minPositive}`);
  }
  if (metrics.negativeCount < options.minNegative) {
    errors.push(`negative_count=${metrics.negativeCount} below min=${options.minNegative}`);
  }
  if (metrics.grayCount < options.minGray) {
    errors.push(`gray_count=${metrics.grayCount} below min=${options.minGray}`);
  }
  if (
    Number.isNaN(metrics.autoPositiveDetectionRecall) ||
    metrics.autoPositiveDetectionRecall < options.minHardRecall
  ) {
    errors.push(
      `auto_positive_detection_recall=${metrics.autoPositiveDetectionRecall || 0} below min=${options.minHardRecall}`,
    );
  }
  if (
    Number.isNaN(metrics.autoPositiveEnforcementRecall) ||
    metrics.autoPositiveEnforcementRecall < options.minEnforcementRecall
  ) {
    errors.push(
      `auto_positive_enforcement_recall=${metrics.autoPositiveEnforcementRecall || 0} below min=${options.minEnforcementRecall}`,
    );
  }
  if (
    Number.isNaN(metrics.autoSubtypeAccuracy) ||
    metrics.autoSubtypeAccuracy < options.minSubtypeAccuracy
  ) {
    errors.push(
      `auto_subtype_accuracy=${metrics.autoSubtypeAccuracy || 0} below min=${options.minSubtypeAccuracy}`,
    );
  }
  if (
    !Number.isNaN(metrics.trustedManualEnforcementFalsePositiveRate) &&
    metrics.trustedManualEnforcementFalsePositiveRate > options.maxFalsePositiveRate
  ) {
    errors.push(
      `trusted_manual_enforcement_false_positive_rate=${metrics.trustedManualEnforcementFalsePositiveRate} above max=${options.maxFalsePositiveRate}`,
    );
  }
  if (metrics.trustedManualActionMismatchCount > 0) {
    errors.push(`trusted_manual_action_mismatch_count=${metrics.trustedManualActionMismatchCount}`);
  }
  if (metrics.trustedManualSubtypeMismatchCount > 0) {
    errors.push(
      `trusted_manual_subtype_mismatch_count=${metrics.trustedManualSubtypeMismatchCount}`,
    );
  }
  if (metrics.trustedManualNegativeDeleteCount > 0) {
    errors.push(`trusted_manual_negative_delete_count=${metrics.trustedManualNegativeDeleteCount}`);
  }
  if (metrics.trustedManualNegativeEnforcementCount > 0) {
    errors.push(
      `trusted_manual_negative_enforcement_count=${metrics.trustedManualNegativeEnforcementCount}`,
    );
  }
  if (metrics.trustedManualHardNegativeNonAllowCount > 0) {
    errors.push(
      `trusted_manual_hard_negative_non_allow_count=${metrics.trustedManualHardNegativeNonAllowCount}`,
    );
  }
  if (metrics.campaignOnlyDeleteCount > 0) {
    errors.push(`campaign_only_delete_count=${metrics.campaignOnlyDeleteCount}`);
  }

  return { errors, diagnostics, metrics };
}

function formatCounts(counts: Map<string, number>): string {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

function formatRate(value: number): string {
  return Number.isNaN(value) ? 'n/a' : value.toFixed(4);
}

async function readJsonl(pathname: string): Promise<CommercialCorpusRecord[]> {
  const payload = await readFile(resolve(pathname), 'utf8');
  const records: CommercialCorpusRecord[] = [];

  for (const [index, line] of payload.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Invalid JSONL at line ${index + 1}: ${String(error)}`);
    }

    const record = readCorpusRecord(parsed);
    if (!record) {
      throw new Error(`Invalid corpus record at line ${index + 1}`);
    }
    records.push(record);
  }

  return records;
}

async function main() {
  const options = readCliOptions(process.argv.slice(2));
  const records = await readJsonl(options.inputPath);
  const { diagnostics, errors, metrics } = validateCommercialCorpusRecords(records, options);

  console.log('Commercial corpus validation');
  console.log(`records=${metrics.records}`);
  console.log(`labels=${formatCounts(metrics.labelCounts) || 'none'}`);
  console.log(`label_sources=${formatCounts(metrics.labelSourceCounts) || 'none'}`);
  console.log(`actions=${formatCounts(metrics.actionCounts) || 'none'}`);
  console.log(`segments=${formatCounts(metrics.segmentCounts) || 'none'}`);
  console.log(`safe_context_buckets=${formatCounts(metrics.safeContextBucketCounts) || 'none'}`);
  console.log(`safe_context_hits=${formatCounts(metrics.safeContextHitCounts) || 'none'}`);
  console.log(`auto_positive_detection_recall=${formatRate(metrics.autoPositiveDetectionRecall)}`);
  console.log(
    `auto_positive_enforcement_recall=${formatRate(metrics.autoPositiveEnforcementRecall)}`,
  );
  console.log(`auto_negative_hit_rate=${formatRate(metrics.autoNegativeHitRate)}`);
  console.log(`auto_negative_enforcement_count=${metrics.autoNegativeEnforcementCount}`);
  console.log(`auto_subtype_accuracy=${formatRate(metrics.autoSubtypeAccuracy)}`);
  console.log(`trusted_manual_count=${metrics.trustedManualCount}`);
  console.log(
    `trusted_manual_negative_gate_status=${
      metrics.trustedManualNegativeCount > 0 ? 'evaluated' : 'not_evaluated'
    }`,
  );
  console.log(
    `trusted_manual_enforcement_false_positive_rate=${formatRate(
      metrics.trustedManualEnforcementFalsePositiveRate,
    )}`,
  );
  console.log(`trusted_manual_action_mismatch_count=${metrics.trustedManualActionMismatchCount}`);
  console.log(`trusted_manual_subtype_mismatch_count=${metrics.trustedManualSubtypeMismatchCount}`);
  console.log(`campaign_only_delete_count=${metrics.campaignOnlyDeleteCount}`);

  if (diagnostics.length > 0) {
    console.warn('');
    console.warn('Validation diagnostics');
    for (const diagnostic of diagnostics) {
      console.warn(`- ${diagnostic}`);
    }
  }

  if (errors.length > 0) {
    console.error('');
    console.error('Validation failed');
    for (const error of errors.slice(0, 50)) {
      console.error(`- ${error}`);
    }
    if (errors.length > 50) {
      console.error(`... ${errors.length - 50} more errors`);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
