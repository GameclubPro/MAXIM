import { Injectable } from '@nestjs/common';

type TimedCounters = {
  success: number[];
  failure: number[];
  critical: number[];
};

type TimedCountersByBot = Map<string, TimedCounters>;

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
  private readonly countersByBot: TimedCountersByBot = new Map();

  recordSuccess(botId?: string | null, nowMs = Date.now()) {
    this.counters.success.push(nowMs);
    if (botId) {
      this.getBotCounters(botId).success.push(nowMs);
    }
  }

  recordFailure(isCritical: boolean, botId?: string | null, nowMs = Date.now()) {
    this.counters.failure.push(nowMs);
    if (isCritical) {
      this.counters.critical.push(nowMs);
    }
    if (botId) {
      const botCounters = this.getBotCounters(botId);
      botCounters.failure.push(nowMs);
      if (isCritical) {
        botCounters.critical.push(nowMs);
      }
    }
  }

  getSnapshot(windowSec: number, botId?: string | null): ActionHealthSnapshot {
    const now = Date.now();
    const windowMs = windowSec * 1_000;
    const cutoff = now - windowMs;
    const counters = botId ? this.getBotCounters(botId) : this.counters;

    this.prune(counters.success, cutoff);
    this.prune(counters.failure, cutoff);
    this.prune(counters.critical, cutoff);

    const success = counters.success.length;
    const failure = counters.failure.length;
    const critical = counters.critical.length;
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

  private getBotCounters(botId: string): TimedCounters {
    const existing = this.countersByBot.get(botId);
    if (existing) {
      return existing;
    }

    const created: TimedCounters = {
      success: [],
      failure: [],
      critical: [],
    };
    this.countersByBot.set(botId, created);
    return created;
  }
}
