import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type CommercialCorpusLabel = 'positive_candidate' | 'negative_candidate' | 'gray_candidate';

type CommercialSnapshot = {
  hit?: unknown;
  actionBand?: unknown;
  primarySubtype?: unknown;
  subtype?: unknown;
};

type CommercialCorpusRecord = {
  label?: unknown;
  expectedAction?: unknown;
  expectedSubtype?: unknown;
  isHardNegative?: unknown;
  policyCategory?: unknown;
  segment?: unknown;
  text?: unknown;
  current?: unknown;
  historical?: unknown;
};

const CORPUS_PATH = join(__dirname, 'commercial-corpus.fixture.jsonl');

const LABELS = new Set<CommercialCorpusLabel>([
  'positive_candidate',
  'negative_candidate',
  'gray_candidate',
]);
const DELETE_ACTIONS = new Set(['DELETE', 'DELETE_AND_ESCALATE']);
const AMBIGUOUS_ACTIONS = new Set(['WARN', 'REVIEW_ONLY']);

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

function parseCorpusFixture(): CommercialCorpusRecord[] {
  return readFileSync(CORPUS_PATH, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line, index) => {
      const parsed = JSON.parse(line) as unknown;
      const record = asRecord(parsed);
      if (!record) {
        throw new Error(`Invalid commercial corpus fixture record at line ${index + 1}`);
      }
      return record;
    });
}

describe('commercial sanitized corpus fixture', () => {
  it('meets production corpus volume, sanitization, and policy gates', () => {
    const records = parseCorpusFixture();
    const errors: string[] = [];
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

      if (record.isHardNegative === true && label === 'positive_candidate') {
        errors.push(`line ${lineNumber}: positive candidate cannot be marked hard-negative`);
      }
    }

    const hardRecall = hardPositiveHitCount / hardPositiveCount;
    const falsePositiveRate = negativeHitCount / negativeCount;
    const subtypeAccuracy = subtypeMatchCount / subtypeComparableCount;

    expect(errors.slice(0, 20)).toEqual([]);
    expect(errors).toHaveLength(0);
    expect(records.length).toBeGreaterThanOrEqual(6500);
    expect(positiveCount).toBeGreaterThanOrEqual(1000);
    expect(negativeCount).toBeGreaterThanOrEqual(5000);
    expect(grayCount).toBeGreaterThanOrEqual(500);
    expect(hardRecall).toBeGreaterThanOrEqual(0.98);
    expect(falsePositiveRate).toBeLessThanOrEqual(0.001);
    expect(subtypeAccuracy).toBeGreaterThanOrEqual(0.93);
    expect(deleteFalsePositiveCount).toBe(0);
    expect(grayDeleteCount).toBe(0);
    expect(campaignOnlyDeleteCount).toBe(0);
  });
});
