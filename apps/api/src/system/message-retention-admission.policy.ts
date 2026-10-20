export const RETENTION_SAMPLE_MAX_GAP_MS = 2_000;
export const RETENTION_STABILITY_MS = 60_000;
export const RETENTION_MAX_ARRIVALS_PER_MINUTE = 300;
export const RETENTION_MAX_NON_RETENTION_HTTP_PER_MINUTE = 300;

export type RetentionAdmissionReason =
  | 'allowed'
  | 'metrics_unavailable'
  | 'current_window_incomplete'
  | 'traffic_busy'
  | 'resources_busy'
  | 'higher_priority_ready'
  | 'higher_priority_active'
  | 'permit_expired'
  | 'collector_unavailable';

export type RetentionObservation = {
  atMs: number;
  complete: boolean;
  cumulativeArrivals: number;
  cumulativeHttp: number;
  resourcesHealthy: boolean;
};

export type RetentionWindowSummary = {
  coveredMs: number;
  samples: number;
  coverage: number;
  complete: boolean;
  arrivalsPerMinute: number | null;
  httpPerMinute: number | null;
};

export function evaluateRetentionWindow(
  samples: readonly RetentionObservation[],
  nowMs: number,
): {
  quietSinceMs: number | null;
  healthySinceMs: number | null;
  ready: boolean;
  reason: RetentionAdmissionReason;
  window: RetentionWindowSummary;
} {
  const boundary = nowMs - RETENTION_STABILITY_MS;
  let start = samples.length - 1;
  while (start >= 0 && samples[start]!.atMs > boundary) start -= 1;
  const window = start >= 0 ? samples.slice(start) : samples;
  const first = window[0];
  const last = window.at(-1);
  const coveredMs = first && last ? Math.max(0, last.atMs - first.atMs) : 0;
  const complete =
    !!first &&
    !!last &&
    first.atMs <= boundary &&
    nowMs - first.atMs <= RETENTION_STABILITY_MS + RETENTION_SAMPLE_MAX_GAP_MS &&
    coveredMs >= RETENTION_STABILITY_MS &&
    last.atMs <= nowMs &&
    nowMs - last.atMs <= RETENTION_SAMPLE_MAX_GAP_MS &&
    window.every(
      (sample, index) =>
        Number.isSafeInteger(sample.atMs) &&
        sample.complete &&
        Number.isSafeInteger(sample.cumulativeArrivals) &&
        sample.cumulativeArrivals >= 0 &&
        Number.isSafeInteger(sample.cumulativeHttp) &&
        sample.cumulativeHttp >= 0 &&
        (!index ||
          (sample.atMs > window[index - 1]!.atMs &&
            sample.atMs - window[index - 1]!.atMs <= RETENTION_SAMPLE_MAX_GAP_MS &&
            sample.cumulativeArrivals >= window[index - 1]!.cumulativeArrivals &&
            sample.cumulativeHttp >= window[index - 1]!.cumulativeHttp)),
    );
  // FLAG: Keep the observation immediately before the 60s boundary. Its full
  // counter delta is a conservative upper bound; missing time is never zero traffic.
  const arrivalsPerMinute = complete ? last!.cumulativeArrivals - first!.cumulativeArrivals : null;
  const httpPerMinute = complete ? last!.cumulativeHttp - first!.cumulativeHttp : null;
  const observedMs = window.reduce((total, sample, index) => {
    const previous = window[index - 1];
    if (
      !previous ||
      !sample.complete ||
      !previous.complete ||
      sample.atMs > nowMs ||
      sample.atMs <= previous.atMs ||
      sample.atMs - previous.atMs > RETENTION_SAMPLE_MAX_GAP_MS
    )
      return total;
    return total + Math.max(0, sample.atMs - Math.max(previous.atMs, boundary));
  }, 0);
  const summary: RetentionWindowSummary = {
    coveredMs,
    samples: window.length,
    coverage: Math.min(1, observedMs / RETENTION_STABILITY_MS),
    complete,
    arrivalsPerMinute,
    httpPerMinute,
  };
  if (!complete)
    return {
      quietSinceMs: null,
      healthySinceMs: null,
      ready: false,
      reason: 'current_window_incomplete',
      window: summary,
    };
  const quiet =
    arrivalsPerMinute! <= RETENTION_MAX_ARRIVALS_PER_MINUTE &&
    httpPerMinute! <= RETENTION_MAX_NON_RETENTION_HTTP_PER_MINUTE;
  const healthy = window.every((sample) => sample.resourcesHealthy);
  // FLAG: Queue occupancy blocks the individual transport permit only. It does
  // not restart independently observed current traffic or host resource evidence.
  return {
    quietSinceMs: quiet ? first!.atMs : null,
    healthySinceMs: healthy ? first!.atMs : null,
    ready: quiet && healthy,
    reason: !quiet ? 'traffic_busy' : !healthy ? 'resources_busy' : 'allowed',
    window: summary,
  };
}
