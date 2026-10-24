import type { MaxActionFailureDiagnostic } from './max-action-failure-diagnostic';

export type MaxActionFailureLogEntry = MaxActionFailureDiagnostic & {
  botId: string;
  statusCode: number | null;
  errorCode: string | null;
  limitScope: string | null;
  trafficClass: 'critical' | 'interactive' | 'background';
  lane: 'critical' | 'interactive' | 'background';
  sourceTag: string | null;
};

export type MaxActionFailureLogSummary = {
  windowStartedAt: string;
  windowEndedAt: string;
  totalFailures: number;
  unclassifiedFailures: number;
  groups: Array<MaxActionFailureLogEntry & { count: number }>;
};

const WINDOW_MS = 30_000;
const MAX_GROUPS = 128;

// FLAG: Counts describe failures, never effects or retry authority. Keep the first warning
// prompt and all subsequent failures counted without retaining errors, payloads or URLs.
export class MaxActionFailureLog {
  private readonly groups = new Map<string, MaxActionFailureLogEntry & { count: number }>();
  private readonly warnedBots = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private total = 0;
  private overflow = 0;
  private closed = false;

  constructor(private readonly emit: (summary: MaxActionFailureLogSummary) => void) {}

  record(entry: MaxActionFailureLogEntry): boolean {
    if (this.closed || entry.trafficClass === 'background' || entry.lane === 'background')
      return false;
    if (!this.timer) {
      this.startedAt = Date.now();
      this.timer = setTimeout(() => this.flush(), WINDOW_MS);
      this.timer.unref();
    }
    const projected: MaxActionFailureLogEntry = {
      botId: entry.botId,
      statusCode: entry.statusCode,
      errorCode: entry.errorCode,
      limitScope: entry.limitScope,
      trafficClass: entry.trafficClass,
      lane: entry.lane,
      sourceTag: entry.sourceTag,
      ...(entry.failureOrigin === 'local_quota'
        ? { failureOrigin: 'local_quota' as const, isCritical: true as const }
        : { failureOrigin: 'unlinked' as const, isCritical: entry.isCritical }),
      ...(entry.requestAssociation === 'linked'
        ? {
            requestAssociation: 'linked',
            method: entry.method,
            endpointKind: entry.endpointKind,
            phase: entry.phase,
            receivedStatusCode: entry.receivedStatusCode,
          }
        : { requestAssociation: 'unlinked', method: 'unknown', endpointKind: 'unknown' }),
    };
    this.total++;
    const key = JSON.stringify(projected);
    const group = this.groups.get(key);
    if (group) group.count++;
    else if (this.groups.size < MAX_GROUPS) this.groups.set(key, { ...projected, count: 1 });
    else this.overflow++;
    const now = Date.now();
    for (const [botId, at] of this.warnedBots)
      if (now - at >= WINDOW_MS) this.warnedBots.delete(botId);
    if (this.warnedBots.has(entry.botId) || this.warnedBots.size >= MAX_GROUPS) return false;
    this.warnedBots.set(entry.botId, now);
    return true;
  }

  close(): void {
    this.closed = true;
    this.flush();
    this.warnedBots.clear();
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.total) return;
    const summary: MaxActionFailureLogSummary = {
      windowStartedAt: new Date(this.startedAt).toISOString(),
      windowEndedAt: new Date().toISOString(),
      totalFailures: this.total,
      unclassifiedFailures: this.overflow,
      groups: [...this.groups.values()],
    };
    this.groups.clear();
    this.total = 0;
    this.overflow = 0;
    this.emit(summary);
  }
}
