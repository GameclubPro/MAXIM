import { isDeepStrictEqual } from 'node:util';

export const COMMERCIAL_DETECTOR_BENCHMARK_SCHEMA_VERSION =
  'commercial-detector-benchmark/v1' as const;
export const COMMERCIAL_DETECTOR_BENCHMARK_CLOCK = 'process.hrtime.bigint' as const;

export type CommercialDetectorTimingSummary = {
  samples: number;
  minNs: number;
  p50Ns: number;
  p95Ns: number;
  p99Ns: number;
  maxNs: number;
  meanNs: number;
};

export type CommercialDetectorTimingObservation = {
  durationNs: number;
  cohorts: readonly string[];
};

export type CommercialDetectorQualityObservation = {
  cohorts: readonly string[];
  expected: 'POSITIVE' | 'NEGATIVE';
  detected: boolean;
  expectedSubtype?: string | null;
  actualSubtype?: string | null;
  actionBand?: string | null;
};

export type CommercialDetectorQualitySummary = {
  samples: number;
  positives: number;
  negatives: number;
  detectedPositives: number;
  missedPositives: number;
  falsePositiveHits: number;
  unexpectedDeletes: number;
  expectedSubtypeCases: number;
  subtypeMatches: number;
  recall: number | null;
  falsePositiveRate: number | null;
  subtypeAccuracy: number | null;
  actions: Record<string, number>;
};

export type CommercialDetectorBenchmarkEvidence = {
  schemaVersion: typeof COMMERCIAL_DETECTOR_BENCHMARK_SCHEMA_VERSION;
  clock: typeof COMMERCIAL_DETECTOR_BENCHMARK_CLOCK;
  initialization: {
    detectorConstructionAndFirstCallNs: number;
    fullPathConstructionAndFirstCallNs: number;
    fullPathPatternState: 'PROCESS_PATTERNS_ALREADY_WARM';
  };
  warm: {
    detectorOnly: CommercialDetectorTimingSummary;
    fullPath: CommercialDetectorTimingSummary;
    adversarialFullPath: CommercialDetectorTimingSummary;
  };
  timingCohorts: {
    detectorOnly: Record<string, CommercialDetectorTimingSummary>;
    fullPath: Record<string, CommercialDetectorTimingSummary>;
  };
  qualityCohorts: Record<string, CommercialDetectorQualitySummary>;
  detectorToFullPathEquivalence: {
    samples: number;
    exactMatches: number;
    mismatches: number;
  };
};

export function measureCommercialSync<T>(operation: () => T): {
  value: T;
  durationNs: number;
} {
  const startedAt = process.hrtime.bigint();
  const value = operation();
  return {
    value,
    durationNs: elapsedNanoseconds(startedAt),
  };
}

export async function measureCommercialAsync<T>(operation: () => Promise<T>): Promise<{
  value: T;
  durationNs: number;
}> {
  const startedAt = process.hrtime.bigint();
  const value = await operation();
  return {
    value,
    durationNs: elapsedNanoseconds(startedAt),
  };
}

export function summarizeCommercialTimings(
  durationsNs: readonly number[],
): CommercialDetectorTimingSummary {
  if (durationsNs.length === 0) {
    throw new Error('Cannot summarize commercial detector timings without samples');
  }
  if (durationsNs.some((durationNs) => !Number.isSafeInteger(durationNs) || durationNs < 0)) {
    throw new Error('Commercial detector timings must be non-negative safe-integer nanoseconds');
  }

  const sorted = [...durationsNs].sort((left, right) => left - right);
  const total = sorted.reduce((sum, durationNs) => sum + durationNs, 0);
  return {
    samples: sorted.length,
    minNs: sorted[0] ?? 0,
    p50Ns: percentile(sorted, 0.5),
    p95Ns: percentile(sorted, 0.95),
    p99Ns: percentile(sorted, 0.99),
    maxNs: sorted.at(-1) ?? 0,
    meanNs: Math.round(total / sorted.length),
  };
}

export function summarizeCommercialTimingCohorts(
  observations: readonly CommercialDetectorTimingObservation[],
): Record<string, CommercialDetectorTimingSummary> {
  const byCohort = new Map<string, number[]>();
  for (const observation of observations) {
    assertDuration(observation.durationNs);
    for (const cohort of normalizedCohorts(observation.cohorts)) {
      const durations = byCohort.get(cohort) ?? [];
      durations.push(observation.durationNs);
      byCohort.set(cohort, durations);
    }
  }
  return Object.fromEntries(
    [...byCohort.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([cohort, durations]) => [cohort, summarizeCommercialTimings(durations)]),
  );
}

export function summarizeCommercialQualityCohorts(
  observations: readonly CommercialDetectorQualityObservation[],
): Record<string, CommercialDetectorQualitySummary> {
  const byCohort = new Map<string, CommercialDetectorQualityObservation[]>();
  for (const observation of observations) {
    for (const cohort of normalizedCohorts(observation.cohorts)) {
      const cohortObservations = byCohort.get(cohort) ?? [];
      cohortObservations.push(observation);
      byCohort.set(cohort, cohortObservations);
    }
  }
  return Object.fromEntries(
    [...byCohort.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([cohort, cohortObservations]) => [cohort, summarizeQuality(cohortObservations)]),
  );
}

export function timingSummaryToMilliseconds(summary: CommercialDetectorTimingSummary): {
  p95Ms: number;
  p99Ms: number;
} {
  return {
    p95Ms: summary.p95Ns / 1_000_000,
    p99Ms: summary.p99Ns / 1_000_000,
  };
}

export function parseCommercialDetectorBenchmarkEvidence(
  value: unknown,
): CommercialDetectorBenchmarkEvidence {
  const evidence = readRecord(value, 'evidence');
  if (evidence.schemaVersion !== COMMERCIAL_DETECTOR_BENCHMARK_SCHEMA_VERSION) {
    throw new Error('Unsupported commercial detector benchmark evidence schemaVersion');
  }
  if (evidence.clock !== COMMERCIAL_DETECTOR_BENCHMARK_CLOCK) {
    throw new Error('Unsupported commercial detector benchmark clock');
  }
  const initialization = readRecord(evidence.initialization, 'evidence.initialization');
  if (initialization.fullPathPatternState !== 'PROCESS_PATTERNS_ALREADY_WARM') {
    throw new Error('Invalid commercial detector benchmark fullPathPatternState');
  }
  const warm = readRecord(evidence.warm, 'evidence.warm');
  const timingCohorts = readRecord(evidence.timingCohorts, 'evidence.timingCohorts');
  const equivalence = readRecord(
    evidence.detectorToFullPathEquivalence,
    'evidence.detectorToFullPathEquivalence',
  );
  const samples = readNonNegativeInteger(equivalence.samples, 'equivalence.samples');
  const exactMatches = readNonNegativeInteger(equivalence.exactMatches, 'equivalence.exactMatches');
  const mismatches = readNonNegativeInteger(equivalence.mismatches, 'equivalence.mismatches');
  if (exactMatches + mismatches !== samples) {
    throw new Error('Commercial detector benchmark equivalence counts do not add up');
  }

  const detectorOnly = readTimingSummary(warm.detectorOnly, 'warm.detectorOnly');
  const fullPath = readTimingSummary(warm.fullPath, 'warm.fullPath');
  const detectorOnlyCohorts = readTimingCohorts(
    timingCohorts.detectorOnly,
    'timingCohorts.detectorOnly',
  );
  const fullPathCohorts = readTimingCohorts(timingCohorts.fullPath, 'timingCohorts.fullPath');
  if (!isDeepStrictEqual(Object.keys(detectorOnlyCohorts), Object.keys(fullPathCohorts))) {
    throw new Error('Commercial detector benchmark detector/full-path timing cohorts disagree');
  }
  for (const cohort of Object.keys(detectorOnlyCohorts)) {
    if (detectorOnlyCohorts[cohort]?.samples !== fullPathCohorts[cohort]?.samples) {
      throw new Error(
        `Commercial detector benchmark timing cohort ${cohort} sample counts disagree`,
      );
    }
  }
  if (
    !isDeepStrictEqual(detectorOnly, detectorOnlyCohorts.all) ||
    !isDeepStrictEqual(fullPath, fullPathCohorts.all)
  ) {
    throw new Error('Commercial detector benchmark warm/all timing summaries disagree');
  }
  const qualityCohorts = readQualityCohorts(evidence.qualityCohorts);
  if (qualityCohorts.all?.samples !== samples) {
    throw new Error('Commercial detector benchmark quality/equivalence sample counts disagree');
  }

  return {
    schemaVersion: COMMERCIAL_DETECTOR_BENCHMARK_SCHEMA_VERSION,
    clock: COMMERCIAL_DETECTOR_BENCHMARK_CLOCK,
    initialization: {
      detectorConstructionAndFirstCallNs: readNonNegativeInteger(
        initialization.detectorConstructionAndFirstCallNs,
        'initialization.detectorConstructionAndFirstCallNs',
      ),
      fullPathConstructionAndFirstCallNs: readNonNegativeInteger(
        initialization.fullPathConstructionAndFirstCallNs,
        'initialization.fullPathConstructionAndFirstCallNs',
      ),
      fullPathPatternState: 'PROCESS_PATTERNS_ALREADY_WARM',
    },
    warm: {
      detectorOnly,
      fullPath,
      adversarialFullPath: readTimingSummary(warm.adversarialFullPath, 'warm.adversarialFullPath'),
    },
    timingCohorts: {
      detectorOnly: detectorOnlyCohorts,
      fullPath: fullPathCohorts,
    },
    qualityCohorts,
    detectorToFullPathEquivalence: { samples, exactMatches, mismatches },
  };
}

export function aggregateCommercialDetectorBenchmarkEvidence(
  attempts: readonly CommercialDetectorBenchmarkEvidence[],
): CommercialDetectorBenchmarkEvidence {
  if (attempts.length === 0) {
    throw new Error('Cannot aggregate commercial detector evidence without attempts');
  }
  const first = attempts[0];
  if (!first) {
    throw new Error('Cannot aggregate commercial detector evidence without a first attempt');
  }
  for (const attempt of attempts.slice(1)) {
    if (!isDeepStrictEqual(attempt.qualityCohorts, first.qualityCohorts)) {
      throw new Error('Commercial detector quality cohorts changed between benchmark attempts');
    }
    if (
      !isDeepStrictEqual(attempt.detectorToFullPathEquivalence, first.detectorToFullPathEquivalence)
    ) {
      throw new Error('Commercial detector path equivalence changed between benchmark attempts');
    }
  }

  return {
    schemaVersion: COMMERCIAL_DETECTOR_BENCHMARK_SCHEMA_VERSION,
    clock: COMMERCIAL_DETECTOR_BENCHMARK_CLOCK,
    initialization: {
      detectorConstructionAndFirstCallNs: medianInteger(
        attempts.map((attempt) => attempt.initialization.detectorConstructionAndFirstCallNs),
      ),
      fullPathConstructionAndFirstCallNs: medianInteger(
        attempts.map((attempt) => attempt.initialization.fullPathConstructionAndFirstCallNs),
      ),
      fullPathPatternState: 'PROCESS_PATTERNS_ALREADY_WARM',
    },
    warm: {
      detectorOnly: aggregateTimingSummaries(attempts.map((attempt) => attempt.warm.detectorOnly)),
      fullPath: aggregateTimingSummaries(attempts.map((attempt) => attempt.warm.fullPath)),
      adversarialFullPath: aggregateTimingSummaries(
        attempts.map((attempt) => attempt.warm.adversarialFullPath),
      ),
    },
    timingCohorts: {
      detectorOnly: aggregateTimingCohorts(
        attempts.map((attempt) => attempt.timingCohorts.detectorOnly),
      ),
      fullPath: aggregateTimingCohorts(attempts.map((attempt) => attempt.timingCohorts.fullPath)),
    },
    qualityCohorts: first.qualityCohorts,
    detectorToFullPathEquivalence: first.detectorToFullPathEquivalence,
  };
}

function elapsedNanoseconds(startedAt: bigint): number {
  const durationNs = process.hrtime.bigint() - startedAt;
  const numeric = Number(durationNs);
  assertDuration(numeric);
  return numeric;
}

function assertDuration(durationNs: number): void {
  if (!Number.isSafeInteger(durationNs) || durationNs < 0) {
    throw new Error('Commercial detector duration must be non-negative safe-integer nanoseconds');
  }
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function normalizedCohorts(cohorts: readonly string[]): string[] {
  const unique = new Set(['all']);
  for (const cohort of cohorts) {
    const normalized = cohort.trim();
    if (!normalized || normalized.length > 120) {
      throw new Error('Commercial detector cohort names must contain 1..120 characters');
    }
    unique.add(normalized);
  }
  return [...unique];
}

function summarizeQuality(
  observations: readonly CommercialDetectorQualityObservation[],
): CommercialDetectorQualitySummary {
  let positives = 0;
  let negatives = 0;
  let detectedPositives = 0;
  let falsePositiveHits = 0;
  let unexpectedDeletes = 0;
  let expectedSubtypeCases = 0;
  let subtypeMatches = 0;
  const actions = new Map<string, number>();
  for (const observation of observations) {
    if (observation.expected === 'POSITIVE') {
      positives += 1;
      if (observation.detected) {
        detectedPositives += 1;
      }
      if (observation.expectedSubtype) {
        expectedSubtypeCases += 1;
        if (observation.detected && observation.actualSubtype === observation.expectedSubtype) {
          subtypeMatches += 1;
        }
      }
    } else {
      negatives += 1;
      if (observation.detected) {
        falsePositiveHits += 1;
      }
      if (observation.actionBand === 'DELETE' || observation.actionBand === 'DELETE_AND_ESCALATE') {
        unexpectedDeletes += 1;
      }
    }
    const action = observation.actionBand ?? 'ALLOW';
    actions.set(action, (actions.get(action) ?? 0) + 1);
  }
  return {
    samples: observations.length,
    positives,
    negatives,
    detectedPositives,
    missedPositives: positives - detectedPositives,
    falsePositiveHits,
    unexpectedDeletes,
    expectedSubtypeCases,
    subtypeMatches,
    recall: positives > 0 ? detectedPositives / positives : null,
    falsePositiveRate: negatives > 0 ? falsePositiveHits / negatives : null,
    subtypeAccuracy: expectedSubtypeCases > 0 ? subtypeMatches / expectedSubtypeCases : null,
    actions: Object.fromEntries(
      [...actions.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Commercial detector benchmark ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Commercial detector benchmark ${label} must be a non-negative integer`);
  }
  return value;
}

function readNullableRate(value: unknown, label: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Commercial detector benchmark ${label} must be null or a rate in [0, 1]`);
  }
  return value;
}

function readTimingSummary(value: unknown, label: string): CommercialDetectorTimingSummary {
  const summary = readRecord(value, label);
  const result: CommercialDetectorTimingSummary = {
    samples: readNonNegativeInteger(summary.samples, `${label}.samples`),
    minNs: readNonNegativeInteger(summary.minNs, `${label}.minNs`),
    p50Ns: readNonNegativeInteger(summary.p50Ns, `${label}.p50Ns`),
    p95Ns: readNonNegativeInteger(summary.p95Ns, `${label}.p95Ns`),
    p99Ns: readNonNegativeInteger(summary.p99Ns, `${label}.p99Ns`),
    maxNs: readNonNegativeInteger(summary.maxNs, `${label}.maxNs`),
    meanNs: readNonNegativeInteger(summary.meanNs, `${label}.meanNs`),
  };
  if (result.samples === 0) {
    throw new Error(`Commercial detector benchmark ${label}.samples must be positive`);
  }
  if (
    !(
      result.minNs <= result.p50Ns &&
      result.p50Ns <= result.p95Ns &&
      result.p95Ns <= result.p99Ns &&
      result.p99Ns <= result.maxNs
    )
  ) {
    throw new Error(`Commercial detector benchmark ${label} percentiles are not monotonic`);
  }
  if (result.meanNs < result.minNs || result.meanNs > result.maxNs) {
    throw new Error(`Commercial detector benchmark ${label}.meanNs is outside min/max`);
  }
  return result;
}

function readTimingCohorts(
  value: unknown,
  label: string,
): Record<string, CommercialDetectorTimingSummary> {
  const cohorts = readRecord(value, label);
  if (!('all' in cohorts)) {
    throw new Error(`Commercial detector benchmark ${label} must contain the all cohort`);
  }
  const result = Object.fromEntries(
    Object.keys(cohorts)
      .sort()
      .map((cohort) => [cohort, readTimingSummary(cohorts[cohort], `${label}.${cohort}`)]),
  );
  const allSamples = result.all?.samples ?? 0;
  if (Object.values(result).some((summary) => summary.samples > allSamples)) {
    throw new Error(`Commercial detector benchmark ${label} cohort exceeds all sample count`);
  }
  return result;
}

function readQualityCohorts(value: unknown): Record<string, CommercialDetectorQualitySummary> {
  const cohorts = readRecord(value, 'qualityCohorts');
  if (!('all' in cohorts)) {
    throw new Error('Commercial detector benchmark qualityCohorts must contain the all cohort');
  }
  const result = Object.fromEntries(
    Object.keys(cohorts)
      .sort()
      .map((cohort) => [cohort, readQualitySummary(cohorts[cohort], cohort)]),
  );
  const allSamples = result.all?.samples ?? 0;
  if (Object.values(result).some((summary) => summary.samples > allSamples)) {
    throw new Error('Commercial detector benchmark quality cohort exceeds all sample count');
  }
  return result;
}

function readQualitySummary(value: unknown, cohort: string): CommercialDetectorQualitySummary {
  const label = `qualityCohorts.${cohort}`;
  const summary = readRecord(value, label);
  const result: CommercialDetectorQualitySummary = {
    samples: readNonNegativeInteger(summary.samples, `${label}.samples`),
    positives: readNonNegativeInteger(summary.positives, `${label}.positives`),
    negatives: readNonNegativeInteger(summary.negatives, `${label}.negatives`),
    detectedPositives: readNonNegativeInteger(
      summary.detectedPositives,
      `${label}.detectedPositives`,
    ),
    missedPositives: readNonNegativeInteger(summary.missedPositives, `${label}.missedPositives`),
    falsePositiveHits: readNonNegativeInteger(
      summary.falsePositiveHits,
      `${label}.falsePositiveHits`,
    ),
    unexpectedDeletes: readNonNegativeInteger(
      summary.unexpectedDeletes,
      `${label}.unexpectedDeletes`,
    ),
    expectedSubtypeCases: readNonNegativeInteger(
      summary.expectedSubtypeCases,
      `${label}.expectedSubtypeCases`,
    ),
    subtypeMatches: readNonNegativeInteger(summary.subtypeMatches, `${label}.subtypeMatches`),
    recall: readNullableRate(summary.recall, `${label}.recall`),
    falsePositiveRate: readNullableRate(summary.falsePositiveRate, `${label}.falsePositiveRate`),
    subtypeAccuracy: readNullableRate(summary.subtypeAccuracy, `${label}.subtypeAccuracy`),
    actions: readCountRecord(summary.actions, `${label}.actions`),
  };
  if (
    result.samples === 0 ||
    result.positives + result.negatives !== result.samples ||
    result.detectedPositives + result.missedPositives !== result.positives ||
    result.falsePositiveHits > result.negatives ||
    result.unexpectedDeletes > result.negatives ||
    result.expectedSubtypeCases > result.positives ||
    result.subtypeMatches > result.expectedSubtypeCases ||
    Object.values(result.actions).reduce((sum, count) => sum + count, 0) !== result.samples
  ) {
    throw new Error(`Commercial detector benchmark ${label} counts do not add up`);
  }
  if (
    result.recall !== rateOrNull(result.detectedPositives, result.positives) ||
    result.falsePositiveRate !== rateOrNull(result.falsePositiveHits, result.negatives) ||
    result.subtypeAccuracy !== rateOrNull(result.subtypeMatches, result.expectedSubtypeCases)
  ) {
    throw new Error(`Commercial detector benchmark ${label} rates do not match counts`);
  }
  return result;
}

function rateOrNull(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function readCountRecord(value: unknown, label: string): Record<string, number> {
  const record = readRecord(value, label);
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, readNonNegativeInteger(record[key], `${label}.${key}`)]),
  );
}

function medianInteger(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

function aggregateTimingSummaries(
  summaries: readonly CommercialDetectorTimingSummary[],
): CommercialDetectorTimingSummary {
  const sampleCounts = new Set(summaries.map((summary) => summary.samples));
  if (sampleCounts.size !== 1) {
    throw new Error('Commercial detector timing sample counts changed between attempts');
  }
  return {
    samples: summaries[0]?.samples ?? 0,
    minNs: medianInteger(summaries.map((summary) => summary.minNs)),
    p50Ns: medianInteger(summaries.map((summary) => summary.p50Ns)),
    p95Ns: medianInteger(summaries.map((summary) => summary.p95Ns)),
    p99Ns: medianInteger(summaries.map((summary) => summary.p99Ns)),
    maxNs: medianInteger(summaries.map((summary) => summary.maxNs)),
    meanNs: medianInteger(summaries.map((summary) => summary.meanNs)),
  };
}

function aggregateTimingCohorts(
  attempts: readonly Record<string, CommercialDetectorTimingSummary>[],
): Record<string, CommercialDetectorTimingSummary> {
  const keys = Object.keys(attempts[0] ?? {}).sort();
  for (const attempt of attempts.slice(1)) {
    if (!isDeepStrictEqual(Object.keys(attempt).sort(), keys)) {
      throw new Error('Commercial detector timing cohorts changed between attempts');
    }
  }
  return Object.fromEntries(
    keys.map((key) => [
      key,
      aggregateTimingSummaries(
        attempts.map((attempt) => {
          const summary = attempt[key];
          if (!summary) {
            throw new Error(`Commercial detector timing cohort ${key} is missing`);
          }
          return summary;
        }),
      ),
    ]),
  );
}
