import {
  aggregateCommercialDetectorBenchmarkEvidence,
  COMMERCIAL_DETECTOR_BENCHMARK_CLOCK,
  COMMERCIAL_DETECTOR_BENCHMARK_SCHEMA_VERSION,
  measureCommercialAsync,
  measureCommercialSync,
  parseCommercialDetectorBenchmarkEvidence,
  summarizeCommercialQualityCohorts,
  summarizeCommercialTimingCohorts,
  summarizeCommercialTimings,
  timingSummaryToMilliseconds,
  type CommercialDetectorBenchmarkEvidence,
  type CommercialDetectorTimingSummary,
} from './commercial-detector-harness.util';

function timing(offset = 0): CommercialDetectorTimingSummary {
  return {
    samples: 3,
    minNs: 1_000 + offset,
    p50Ns: 2_000 + offset,
    p95Ns: 3_000 + offset,
    p99Ns: 4_000 + offset,
    maxNs: 5_000 + offset,
    meanNs: 2_500 + offset,
  };
}

function evidence(offset = 0): CommercialDetectorBenchmarkEvidence {
  const quality = summarizeCommercialQualityCohorts([
    {
      cohorts: ['class:positive', 'subtype:SERVICES'],
      expected: 'POSITIVE',
      detected: true,
      expectedSubtype: 'SERVICES',
      actualSubtype: 'SERVICES',
      actionBand: 'WARN',
    },
    {
      cohorts: ['class:negative'],
      expected: 'NEGATIVE',
      detected: false,
      actionBand: null,
    },
  ]);
  return {
    schemaVersion: COMMERCIAL_DETECTOR_BENCHMARK_SCHEMA_VERSION,
    clock: COMMERCIAL_DETECTOR_BENCHMARK_CLOCK,
    initialization: {
      detectorConstructionAndFirstCallNs: 10_000 + offset,
      fullPathConstructionAndFirstCallNs: 20_000 + offset,
      fullPathPatternState: 'PROCESS_PATTERNS_ALREADY_WARM',
    },
    warm: {
      detectorOnly: timing(offset),
      fullPath: timing(offset),
      adversarialFullPath: timing(offset),
    },
    timingCohorts: {
      detectorOnly: { all: timing(offset), 'class:positive': timing(offset) },
      fullPath: { all: timing(offset), 'class:positive': timing(offset) },
    },
    qualityCohorts: quality,
    detectorToFullPathEquivalence: { samples: 2, exactMatches: 2, mismatches: 0 },
  };
}

describe('commercial detector evidence harness', () => {
  it('measures sync and async operations with the monotonic nanosecond clock', async () => {
    const sync = measureCommercialSync(() => 42);
    const asyncResult = await measureCommercialAsync(async () => 'done');

    expect(sync.value).toBe(42);
    expect(asyncResult.value).toBe('done');
    expect(sync.durationNs).toEqual(expect.any(Number));
    expect(asyncResult.durationNs).toEqual(expect.any(Number));
    expect(Number.isSafeInteger(sync.durationNs)).toBe(true);
    expect(Number.isSafeInteger(asyncResult.durationNs)).toBe(true);
  });

  it('uses nearest-rank percentiles without discarding nanosecond precision', () => {
    const summary = summarizeCommercialTimings([9_000_000, 1_000_000, 3_000_000, 2_000_000]);

    expect(summary).toEqual({
      samples: 4,
      minNs: 1_000_000,
      p50Ns: 2_000_000,
      p95Ns: 9_000_000,
      p99Ns: 9_000_000,
      maxNs: 9_000_000,
      meanNs: 3_750_000,
    });
    expect(timingSummaryToMilliseconds(summary)).toEqual({ p95Ms: 9, p99Ms: 9 });
  });

  it('stratifies timing and quality while always retaining an all cohort', () => {
    const timings = summarizeCommercialTimingCohorts([
      { durationNs: 100, cohorts: ['class:positive', 'length:short'] },
      { durationNs: 300, cohorts: ['class:negative', 'length:short'] },
    ]);
    const quality = summarizeCommercialQualityCohorts([
      {
        cohorts: ['class:positive', 'subtype:SERVICES'],
        expected: 'POSITIVE',
        detected: true,
        expectedSubtype: 'SERVICES',
        actualSubtype: 'SERVICES',
        actionBand: 'WARN',
      },
      {
        cohorts: ['class:negative'],
        expected: 'NEGATIVE',
        detected: true,
        actionBand: 'DELETE',
      },
    ]);

    expect(timings.all.samples).toBe(2);
    expect(timings['class:positive']?.samples).toBe(1);
    expect(quality.all).toEqual(
      expect.objectContaining({
        samples: 2,
        recall: 1,
        falsePositiveRate: 1,
        subtypeAccuracy: 1,
        unexpectedDeletes: 1,
        actions: { DELETE: 1, WARN: 1 },
      }),
    );
  });

  it('validates the evidence artifact and aggregates fresh-process attempts by median', () => {
    expect(parseCommercialDetectorBenchmarkEvidence(evidence())).toEqual(evidence());

    const aggregate = aggregateCommercialDetectorBenchmarkEvidence([
      evidence(0),
      evidence(1_000),
      evidence(10),
    ]);
    expect(aggregate.initialization.detectorConstructionAndFirstCallNs).toBe(10_010);
    expect(aggregate.warm.fullPath.p95Ns).toBe(3_010);
    expect(aggregate.qualityCohorts).toEqual(evidence().qualityCohorts);
  });

  it('fails closed when evidence counts or attempt cohort shapes disagree', () => {
    expect(() =>
      parseCommercialDetectorBenchmarkEvidence({
        ...evidence(),
        detectorToFullPathEquivalence: { samples: 2, exactMatches: 2, mismatches: 1 },
      }),
    ).toThrow('counts do not add up');

    const changed = evidence();
    changed.timingCohorts.fullPath = { all: timing() };
    expect(() => aggregateCommercialDetectorBenchmarkEvidence([evidence(), changed])).toThrow(
      'timing cohorts changed',
    );
  });

  it('rejects internally inconsistent timing and quality evidence', () => {
    const inconsistentTiming = evidence();
    inconsistentTiming.warm.fullPath = timing(10);
    expect(() => parseCommercialDetectorBenchmarkEvidence(inconsistentTiming)).toThrow(
      'warm/all timing summaries disagree',
    );

    const inconsistentQuality = evidence();
    inconsistentQuality.qualityCohorts.all = {
      ...inconsistentQuality.qualityCohorts.all!,
      falsePositiveHits: 1,
      falsePositiveRate: 0,
    };
    expect(() => parseCommercialDetectorBenchmarkEvidence(inconsistentQuality)).toThrow(
      'rates do not match counts',
    );
  });
});
