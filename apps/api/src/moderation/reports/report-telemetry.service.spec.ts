import { REPORT_TELEMETRY_EVENTS, ReportTelemetryService } from './report-telemetry.service';

describe('report aggregate observations', () => {
  it('keeps fixed bounded counters and duration buckets without retaining identities', () => {
    const service = new ReportTelemetryService();
    service.record('accepted');
    service.record('historyPage', 1000);
    service.record('historyPage', 90_000);
    const snapshot = service.snapshot();
    expect(Object.keys(snapshot.counts)).toEqual([...REPORT_TELEMETRY_EVENTS]);
    expect(snapshot.counts.accepted).toBe(1);
    expect(snapshot.durationBuckets.historyPage).toEqual([0, 0, 1, 0, 0, 0, 1]);
    snapshot.counts.accepted = 999;
    expect(service.snapshot().counts.accepted).toBe(1);
  });
});
