import {
  evaluateRetentionWindow,
  RETENTION_MAX_ARRIVALS_PER_MINUTE,
  RETENTION_MAX_NON_RETENTION_HTTP_PER_MINUTE,
  type RetentionObservation,
} from './message-retention-admission.policy';

const nowMs = Date.UTC(2026, 9, 21, 12);
function samples(atMs = nowMs): RetentionObservation[] {
  return Array.from({ length: 61 }, (_, index) => ({
    atMs: atMs - 60_000 + index * 1_000,
    complete: true,
    cumulativeArrivals: index,
    cumulativeHttp: index * 2,
    resourcesHealthy: true,
  }));
}

describe('retention admission current window', () => {
  it('allows after one complete quiet healthy minute without persistent history', () => {
    expect(evaluateRetentionWindow(samples(), nowMs)).toMatchObject({
      ready: true,
      reason: 'allowed',
      quietSinceMs: nowMs - 60_000,
      healthySinceMs: nowMs - 60_000,
      window: {
        coverage: 1,
        complete: true,
        coveredMs: 60_000,
        samples: 61,
        arrivalsPerMinute: 60,
        httpPerMinute: 120,
      },
    });
    expect(evaluateRetentionWindow(samples().slice(1), nowMs).ready).toBe(false);
  });

  it('keeps queue occupancy out of independently observed traffic and resource windows', () => {
    // Queue occupancy is checked for each attempt, outside this traffic/resource function.
    for (const at of [nowMs, nowMs + 1_000, nowMs + 60_000]) {
      expect(evaluateRetentionWindow(samples(at), at)).toMatchObject({
        ready: true,
        quietSinceMs: at - 60_000,
        healthySinceMs: at - 60_000,
      });
    }
  });

  it('has separate conservative 300-per-minute arrival and non-retention HTTP limits', () => {
    expect(RETENTION_MAX_ARRIVALS_PER_MINUTE).toBe(300);
    expect(RETENTION_MAX_NON_RETENTION_HTTP_PER_MINUTE).toBe(300);
    const boundary = samples().map((row, index) => ({
      ...row,
      cumulativeArrivals: index * 5,
      cumulativeHttp: index * 5,
    }));
    expect(evaluateRetentionWindow(boundary, nowMs).ready).toBe(true);
    for (const field of ['cumulativeArrivals', 'cumulativeHttp'] as const) {
      const busy = boundary.map((row, index) => ({ ...row, [field]: index * 6 }));
      expect(evaluateRetentionWindow(busy, nowMs)).toMatchObject({
        ready: false,
        reason: 'traffic_busy',
        quietSinceMs: null,
        healthySinceMs: nowMs - 60_000,
      });
    }
  });

  it('requires healthy resources throughout the current minute while retaining quiet traffic evidence', () => {
    const resources = samples();
    resources[30]!.resourcesHealthy = false;
    expect(evaluateRetentionWindow(resources, nowMs)).toMatchObject({
      ready: false,
      reason: 'resources_busy',
      quietSinceMs: nowMs - 60_000,
      healthySinceMs: null,
    });
  });

  it('fails closed on missing, stale, future, incomplete and reversed-clock observations', () => {
    const reversed = samples();
    reversed[30]!.atMs = reversed[29]!.atMs;
    const decreased = samples();
    decreased[30]!.cumulativeArrivals = 0;
    for (const invalid of [
      [],
      samples().filter((_, index) => index < 20 || index > 23),
      samples(nowMs - 3_000),
      samples(nowMs + 1_000),
      reversed,
      decreased,
      samples().map((row, index) => ({ ...row, complete: index !== 30 })),
    ]) {
      expect(evaluateRetentionWindow(invalid, nowMs)).toMatchObject({
        ready: false,
        quietSinceMs: null,
        healthySinceMs: null,
        window: { complete: false },
      });
    }
  });

  it('retains the boundary observation under scheduler jitter and never assumes missing time is quiet', () => {
    const jittered = samples().map((row, index) => ({
      ...row,
      atMs: row.atMs + (index > 0 && index < 60 ? 100 : 0),
    }));
    expect(evaluateRetentionWindow(jittered, nowMs).ready).toBe(true);
    expect(evaluateRetentionWindow(jittered.slice(1), nowMs).ready).toBe(false);
  });
});
