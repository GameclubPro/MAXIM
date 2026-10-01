import { Injectable, Logger } from '@nestjs/common';

export const REPORT_TELEMETRY_EVENTS = [
  'accepted',
  'rejected',
  'rejectedSource',
  'rejectedMembership',
  'rejectedSanction',
  'rejectedProtected',
  'rejectedPolicy',
  'rejectedClosed',
  'rejectedRateLimit',
  'threshold',
  'mute',
  'muteSkipped',
  'delete',
  'deleteAbsent',
  'deleteFailed',
  'cancelled',
  'permanentRefusal',
  'counterAmbiguous',
  'historyPage',
  'executionDelay',
  'stalled',
  'journalPage',
  'journalDetail',
  'detailArchived',
] as const;
export type ReportTelemetryEvent = (typeof REPORT_TELEMETRY_EVENTS)[number];
const BOUNDS_MS = [100, 500, 2000, 5000, 30_000, 60_000] as const;

@Injectable()
export class ReportTelemetryService {
  private readonly logger = new Logger(ReportTelemetryService.name);
  private readonly counts = Object.fromEntries(REPORT_TELEMETRY_EVENTS.map((event) => [event, 0]));
  private readonly durations = new Map<ReportTelemetryEvent, number[]>();
  private nextLogAt = Date.now() + 60_000;

  record(event: ReportTelemetryEvent, durationMs?: number): void {
    if (!Object.hasOwn(this.counts, event)) return;
    this.counts[event]++;
    if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) {
      const buckets = this.durations.get(event) ?? Array<number>(BOUNDS_MS.length + 1).fill(0);
      const index = BOUNDS_MS.findIndex((bound) => durationMs <= bound);
      buckets[index < 0 ? BOUNDS_MS.length : index]!++;
      this.durations.set(event, buckets);
    }
    if (Date.now() >= this.nextLogAt) {
      this.nextLogAt = Date.now() + 60_000;
      this.logger.log(this.snapshot(), 'Participant report aggregate metrics');
    }
  }

  // FLAG: Observation is process-local and contains no chat, participant, case or message identity.
  snapshot() {
    return {
      counts: { ...this.counts },
      durationBoundsMs: [...BOUNDS_MS],
      durationBuckets: Object.fromEntries(
        [...this.durations].map(([key, value]) => [key, [...value]]),
      ),
    };
  }
}
