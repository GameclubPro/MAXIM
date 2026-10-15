export type CatalogLatencyTargets = Readonly<{ p95Ms: number; p99Ms: number }>;

export function parseCatalogLatencyTargets(value?: string): CatalogLatencyTargets | null {
  if (value === undefined) return null;
  if (!/^[1-9][0-9]*,[1-9][0-9]*$/u.test(value))
    throw new Error('Use --latency=2000,10000 for positive p95,p99 millisecond limits');
  const [p95Ms, p99Ms] = value.split(',').map(Number);
  if (!Number.isSafeInteger(p95Ms) || !Number.isSafeInteger(p99Ms) || p99Ms! < p95Ms!)
    throw new Error('Latency limits must be safe integers with p99 >= p95');
  return { p95Ms: p95Ms!, p99Ms: p99Ms! };
}

export function evaluateCatalogLatency(
  latencies: readonly number[],
  expectedSamples: number,
  targets: CatalogLatencyTargets | null,
) {
  // FLAG: Missing or invalid completion clocks cannot become zero-latency successes.
  // This finite fixture gate does not certify production capacity or external MAX latency.
  const invalidClocks = latencies.filter((value) => !Number.isFinite(value) || value < 0).length;
  const complete =
    Number.isSafeInteger(expectedSamples) &&
    expectedSamples > 0 &&
    latencies.length === expectedSamples &&
    invalidClocks === 0;
  const sorted = complete ? [...latencies].sort((a, b) => a - b) : [];
  const p95Ms = sorted[Math.floor(sorted.length * 0.95)] ?? null;
  const p99Ms = sorted[Math.floor(sorted.length * 0.99)] ?? null;
  return {
    status: !targets
      ? 'not_evaluated'
      : complete && p95Ms! <= targets.p95Ms && p99Ms! <= targets.p99Ms
        ? 'passed'
        : 'failed',
    basis: 'all_processed_receipts_in_completed_fixture',
    expectedSamples,
    samples: latencies.length,
    invalidClocks,
    complete,
    targets,
    p95Ms,
    p99Ms,
  };
}
