import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  COMMERCIAL_CORPUS_AUTO_LABEL_SOURCE,
  COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE,
  analyzeCommercialCorpusRecords,
  type CommercialCorpusRecord,
  validateCommercialCorpusRecords,
} from '../scripts/validate-commercial-corpus';

const CORPUS_PATH = join(__dirname, 'commercial-corpus.fixture.jsonl');

function asRecord(value: unknown): CommercialCorpusRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as CommercialCorpusRecord)
    : null;
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
  it('preserves historical automatic evidence and reports unresolved cleanup quality', () => {
    const records = parseCorpusFixture();
    const { errors, metrics } = validateCommercialCorpusRecords(records);

    expect(analyzeCommercialCorpusRecords(records).errors).toEqual([]);
    // Historical labels are regression evidence. They are not an independently reviewed holdout;
    // canonical WARN cleanup exposes seven campaign-only predictions that must stay visible.
    expect(errors).toEqual(['campaign_only_delete_count=7']);
    expect(metrics.records).toBeGreaterThanOrEqual(6500);
    expect(metrics.positiveCount).toBeGreaterThanOrEqual(1000);
    expect(metrics.negativeCount).toBeGreaterThanOrEqual(5000);
    expect(metrics.grayCount).toBeGreaterThanOrEqual(500);

    expect(metrics.labelSourceCounts.get(COMMERCIAL_CORPUS_AUTO_LABEL_SOURCE)).toBe(
      metrics.records,
    );
    expect(metrics.labelSourceCounts.get(COMMERCIAL_CORPUS_TRUSTED_MANUAL_LABEL_SOURCE) ?? 0).toBe(
      0,
    );
    expect(metrics.autoPositiveDetectionRecall).toBeGreaterThanOrEqual(0.98);
    expect(metrics.autoPositiveEnforcementEligibleCount).toBeGreaterThan(0);
    expect(metrics.autoPositiveEnforcementRecall).toBeGreaterThan(0);
    expect(metrics.autoSubtypeAccuracy).toBeGreaterThanOrEqual(0.93);

    expect(metrics.trustedManualActionMismatchCount).toBe(0);
    expect(metrics.trustedManualNegativeEnforcementCount).toBe(0);
    expect(metrics.trustedManualNegativeDeleteCount).toBe(0);
    expect(metrics.trustedManualHardNegativeNonAllowCount).toBe(0);
    expect(metrics.trustedManualSubtypeMismatchCount).toBe(0);
    expect(metrics.campaignOnlyDeleteCount).toBe(7);
  });
});
