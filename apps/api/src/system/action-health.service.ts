import { Injectable } from '@nestjs/common';

type TimedCounters = {
  success: number[];
  failure: number[];
  critical: number[];
};

export type ActionHealthSnapshot = {
  windowSec: number;
  total: number;
  success: number;
  failure: number;
  critical: number;
  errorRate: number;
  criticalRate: number;
};

@Injectable()
export class ActionHealthService {
  private readonly counters: TimedCounters = {
    success: [],
    failure: [],
    critical: [],
  };

  recordSuccess(nowMs = Date.now()) {
    this.counters.success.push(nowMs);
  }

  recordFailure(isCritical: boolean, nowMs = Date.now()) {
    this.counters.failure.push(nowMs);
    if (isCritical) {
      this.counters.critical.push(nowMs);
    }
  }

  getSnapshot(windowSec: number): ActionHealthSnapshot {
    const now = Date.now();
    const windowMs = windowSec * 1_000;
    const cutoff = now - windowMs;

    this.prune(this.counters.success, cutoff);
    this.prune(this.counters.failure, cutoff);
    this.prune(this.counters.critical, cutoff);

    const success = this.counters.success.length;
    const failure = this.counters.failure.length;
    const critical = this.counters.critical.length;
    const total = success + failure;

    return {
      windowSec,
      total,
      success,
      failure,
      critical,
      errorRate: total > 0 ? failure / total : 0,
      criticalRate: total > 0 ? critical / total : 0,
    };
  }

  private prune(values: number[], cutoff: number) {
    while (values.length > 0 && values[0] < cutoff) {
      values.shift();
    }
  }
}
