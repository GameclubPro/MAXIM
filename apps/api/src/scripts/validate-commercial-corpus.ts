import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type CommercialCorpusLabel = 'positive_candidate' | 'negative_candidate' | 'gray_candidate';

type CommercialSnapshot = {
  hit?: unknown;
  actionBand?: unknown;
  primarySubtype?: unknown;
  subtype?: unknown;
};

type CommercialCorpusRecord = {
  label?: unknown;
  labelSource?: unknown;
  expectedAction?: unknown;
  expectedSubtype?: unknown;
  isHardNegative?: unknown;
  policyCategory?: unknown;
  segment?: unknown;
  text?: unknown;
  current?: unknown;
  historical?: unknown;
};

type CliOptions = {
  inputPath: string;
  minPositive: number;
  minNegative: number;
  minGray: number;
  minHardRecall: number;
  maxFalsePositiveRate: number;
  minSubtypeAccuracy: number;
};

const DEFAULTS = {
  minPositive: 1000,
  minNegative: 5000,
  minGray: 500,
  minHardRecall: 0.98,
  maxFalsePositiveRate: 0.001,
  minSubtypeAccuracy: 0.93,
} as const;

const DELETE_ACTIONS = new Set(['DELETE', 'DELETE_AND_ESCALATE']);
const AMBIGUOUS_ACTIONS = new Set(['WARN', 'REVIEW_ONLY']);
const LABELS = new Set<CommercialCorpusLabel>([
  'positive_candidate',
  'negative_candidate',
  'gray_candidate',
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
    minPositive: readNumberOption(argv, '--min-positive') ?? DEFAULTS.minPositive,
    minNegative: readNumberOption(argv, '--min-negative') ?? DEFAULTS.minNegative,
    minGray: readNumberOption(argv, '--min-gray') ?? DEFAULTS.minGray,
    minHardRecall: readNumberOption(argv, '--min-hard-recall') ?? DEFAULTS.minHardRecall,
    maxFalsePositiveRate:
      readNumberOption(argv, '--max-false-positive-rate') ?? DEFAULTS.maxFalsePositiveRate,
    minSubtypeAccuracy:
      readNumberOption(argv, '--min-subtype-accuracy') ?? DEFAULTS.minSubtypeAccuracy,
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

function readBoolean(value: unknown): boolean {
  return value === true;
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
    text: record.text,
    current: record.current,
    historical: record.historical,
  };
}

function isDeleteAction(action: unknown): boolean {
  return typeof action === 'string' && DELETE_ACTIONS.has(action);
}

function isAmbiguousAction(action: unknown): boolean {
  return typeof action === 'string' && AMBIGUOUS_ACTIONS.has(action);
}

function isSanitizedText(value: string): boolean {
  const rawLinkPattern =
    /\b(?:https?:\/\/|t\.me\/|max\.ru\/|vk\.com\/|wa\.me\/|clck\.ru\/|bit\.ly\/|goo\.su\/|tinyurl\.com\/)/iu;
  const rawPhonePattern =
    /(?:^|[^\d])(?:\+?7|8)[\s-]*\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?=$|[^\d])/u;
  const rawEmailPattern = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/iu;
  const rawHandlePattern = /(?:^|[^\p{L}\p{N}_])@[a-z0-9_]{4,32}(?=$|[^\p{L}\p{N}_])/iu;

  return (
    !rawLinkPattern.test(value) &&
    !rawPhonePattern.test(value) &&
    !rawEmailPattern.test(value) &&
    !rawHandlePattern.test(value)
  );
}

function pushCount(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function formatCounts(counts: Map<string, number>): string {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
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
  const errors: string[] = [];
  const labelCounts = new Map<string, number>();
  const actionCounts = new Map<string, number>();
  const segmentCounts = new Map<string, number>();
  let positiveCount = 0;
  let negativeCount = 0;
  let grayCount = 0;
  let hardPositiveCount = 0;
  let hardPositiveHitCount = 0;
  let negativeHitCount = 0;
  let deleteFalsePositiveCount = 0;
  let grayDeleteCount = 0;
  let campaignOnlyDeleteCount = 0;
  let subtypeComparableCount = 0;
  let subtypeMatchCount = 0;

  for (const [index, record] of records.entries()) {
    const lineNumber = index + 1;
    const label = readString(record.label);
    const expectedAction = readString(record.expectedAction);
    const expectedSubtype = readString(record.expectedSubtype);
    const policyCategory = readString(record.policyCategory);
    const segment = readString(record.segment) ?? 'UNKNOWN';
    const text = readString(record.text);
    const current = readSnapshot(record.current);
    const historical = readSnapshot(record.historical);
    const currentAction = readString(current.actionBand);
    const currentSubtype = readString(current.primarySubtype) ?? readString(current.subtype);
    const currentHit = current.hit === true;
    const historicalHit = historical.hit === true;

    if (!label || !LABELS.has(label as CommercialCorpusLabel)) {
      errors.push(`line ${lineNumber}: unknown label ${label ?? 'null'}`);
      continue;
    }
    if (!text || !isSanitizedText(text)) {
      errors.push(`line ${lineNumber}: text is missing or not sanitized`);
    }
    if (currentAction) {
      pushCount(actionCounts, currentAction);
    }
    pushCount(labelCounts, label);
    pushCount(segmentCounts, segment);

    if (label === 'positive_candidate') {
      positiveCount += 1;
      if (!expectedSubtype) {
        errors.push(`line ${lineNumber}: positive candidate requires expectedSubtype`);
      }
      if (!currentHit && !historicalHit) {
        errors.push(`line ${lineNumber}: positive candidate has no current or historical hit`);
      }
      if (!isAmbiguousAction(expectedAction) && expectedAction !== 'ALLOW') {
        hardPositiveCount += 1;
        if (currentHit) {
          hardPositiveHitCount += 1;
        }
      }
      if (currentHit && expectedSubtype && currentSubtype) {
        subtypeComparableCount += 1;
        if (currentSubtype === expectedSubtype) {
          subtypeMatchCount += 1;
        }
      }
    } else if (label === 'negative_candidate') {
      negativeCount += 1;
      if (expectedAction !== 'ALLOW') {
        errors.push(`line ${lineNumber}: negative candidate expectedAction must be ALLOW`);
      }
      if (currentHit) {
        negativeHitCount += 1;
      }
      if (isDeleteAction(currentAction)) {
        deleteFalsePositiveCount += 1;
      }
    } else if (label === 'gray_candidate') {
      grayCount += 1;
      if (!isAmbiguousAction(expectedAction)) {
        errors.push(`line ${lineNumber}: gray candidate expectedAction must be WARN/REVIEW_ONLY`);
      }
      if (isDeleteAction(currentAction)) {
        grayDeleteCount += 1;
      }
    }

    if (policyCategory === 'campaign_only' && isDeleteAction(currentAction)) {
      campaignOnlyDeleteCount += 1;
    }

    if (readBoolean(record.isHardNegative) && label === 'positive_candidate') {
      errors.push(`line ${lineNumber}: positive candidate cannot be marked hard-negative`);
    }
  }

  const falsePositiveRate = negativeCount > 0 ? negativeHitCount / negativeCount : 0;
  const hardRecall = hardPositiveCount > 0 ? hardPositiveHitCount / hardPositiveCount : Number.NaN;
  const subtypeAccuracy =
    subtypeComparableCount > 0 ? subtypeMatchCount / subtypeComparableCount : Number.NaN;

  if (positiveCount < options.minPositive) {
    errors.push(`positive_count=${positiveCount} below min=${options.minPositive}`);
  }
  if (negativeCount < options.minNegative) {
    errors.push(`negative_count=${negativeCount} below min=${options.minNegative}`);
  }
  if (grayCount < options.minGray) {
    errors.push(`gray_count=${grayCount} below min=${options.minGray}`);
  }
  if (Number.isNaN(hardRecall) || hardRecall < options.minHardRecall) {
    errors.push(`hard_recall=${hardRecall || 0} below min=${options.minHardRecall}`);
  }
  if (falsePositiveRate > options.maxFalsePositiveRate) {
    errors.push(
      `false_positive_rate=${falsePositiveRate} above max=${options.maxFalsePositiveRate}`,
    );
  }
  if (Number.isNaN(subtypeAccuracy) || subtypeAccuracy < options.minSubtypeAccuracy) {
    errors.push(`subtype_accuracy=${subtypeAccuracy || 0} below min=${options.minSubtypeAccuracy}`);
  }
  if (deleteFalsePositiveCount > 0) {
    errors.push(`delete_false_positive_count=${deleteFalsePositiveCount}`);
  }
  if (grayDeleteCount > 0) {
    errors.push(`gray_delete_count=${grayDeleteCount}`);
  }
  if (campaignOnlyDeleteCount > 0) {
    errors.push(`campaign_only_delete_count=${campaignOnlyDeleteCount}`);
  }

  console.log('Commercial corpus validation');
  console.log(`records=${records.length}`);
  console.log(`labels=${formatCounts(labelCounts) || 'none'}`);
  console.log(`actions=${formatCounts(actionCounts) || 'none'}`);
  console.log(`segments=${formatCounts(segmentCounts) || 'none'}`);
  console.log(`hard_recall=${Number.isNaN(hardRecall) ? 'n/a' : hardRecall.toFixed(4)}`);
  console.log(`false_positive_rate=${falsePositiveRate.toFixed(4)}`);
  console.log(
    `subtype_accuracy=${Number.isNaN(subtypeAccuracy) ? 'n/a' : subtypeAccuracy.toFixed(4)}`,
  );
  console.log(`delete_false_positive_count=${deleteFalsePositiveCount}`);
  console.log(`gray_delete_count=${grayDeleteCount}`);
  console.log(`campaign_only_delete_count=${campaignOnlyDeleteCount}`);

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

void main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
