import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

type TimedCounters = {
  success: number[];
  failure: number[];
  critical: number[];
};

type TimedCountersByBot = Map<string, TimedCounters>;

type ActionCounterField = 'success' | 'failure' | 'critical';

type CachedSnapshot = {
  snapshot: ActionHealthSnapshot;
  updatedAtMs: number;
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
export class ActionHealthService implements OnModuleDestroy {
  private readonly logger = new Logger(ActionHealthService.name);
  private readonly redis: Redis;
  private readonly counters: TimedCounters = {
    success: [],
    failure: [],
    critical: [],
  };
  private readonly countersByBot: TimedCountersByBot = new Map();
  private readonly sharedSnapshotCache = new Map<string, CachedSnapshot>();
  private readonly sharedSnapshotMaxAgeMs: number;
  private sharedWriteWarnAtMs = 0;

  constructor(configService: ConfigService) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.sharedSnapshotMaxAgeMs = 2_000;
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  recordSuccess(botId?: string | null, nowMs = Date.now()) {
    this.counters.success.push(nowMs);
    if (botId) {
      this.getBotCounters(botId).success.push(nowMs);
    }
    this.recordSharedCounter('success', botId, nowMs);
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
    this.recordSharedCounter('failure', botId, nowMs);
    if (isCritical) {
      this.recordSharedCounter('critical', botId, nowMs);
    }
  }

  getSnapshot(windowSec: number, botId?: string | null): ActionHealthSnapshot {
    const cachedSnapshot = this.readCachedSharedSnapshot(windowSec, botId);
    if (cachedSnapshot) {
      return cachedSnapshot;
    }

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

  async refreshSnapshots(windowSec: number, botIds: readonly string[] = []): Promise<void> {
    const scopes = [null, ...botIds]
      .map((botId) => this.normalizeBotId(botId))
      .filter((botId, index, values) => values.indexOf(botId) === index);

    if (scopes.length === 0) {
      return;
    }

    const nowSec = Math.floor(Date.now() / 1_000);
    const pipeline = this.redis.pipeline();
    for (const botId of scopes) {
      pipeline.hgetall(this.buildSharedKey(botId));
    }

    try {
      const results = await pipeline.exec();
      if (!results) {
        return;
      }

      scopes.forEach((botId, index) => {
        const payload = results[index]?.[1];
        const fields =
          payload && typeof payload === 'object' && !Array.isArray(payload)
            ? (payload as Record<string, string>)
            : {};
        this.sharedSnapshotCache.set(this.buildCacheKey(windowSec, botId), {
          snapshot: this.buildSnapshotFromSharedFields(fields, windowSec, nowSec),
          updatedAtMs: Date.now(),
        });
      });
    } catch (error: unknown) {
      const now = Date.now();
      if (now - this.sharedWriteWarnAtMs >= 60_000) {
        this.sharedWriteWarnAtMs = now;
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'Failed to refresh shared action health snapshot',
        );
      }
    }
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

  private recordSharedCounter(field: ActionCounterField, botId: string | null | undefined, nowMs: number) {
    const bucketSec = Math.floor(nowMs / 1_000);
    const fieldName = `${field}:${bucketSec}`;
    const keys = [this.buildSharedKey(null)];
    const normalizedBotId = this.normalizeBotId(botId);
    if (normalizedBotId) {
      keys.push(this.buildSharedKey(normalizedBotId));
    }

    const pipeline = this.redis.pipeline();
    for (const key of keys) {
      pipeline.hincrby(key, fieldName, 1);
      pipeline.pexpire(key, 180_000);
    }

    void pipeline.exec().catch((error: unknown) => {
      const now = Date.now();
      if (now - this.sharedWriteWarnAtMs >= 60_000) {
        this.sharedWriteWarnAtMs = now;
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'Failed to persist shared action health counters',
        );
      }
    });
  }

  private buildSharedKey(botId: string | null): string {
    return botId ? `system:action-health:v1:bot:${botId}` : 'system:action-health:v1:global';
  }

  private buildCacheKey(windowSec: number, botId: string | null): string {
    return `${windowSec}:${botId ?? 'global'}`;
  }

  private normalizeBotId(botId: string | null | undefined): string | null {
    if (typeof botId !== 'string') {
      return null;
    }
    const normalized = botId.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private readCachedSharedSnapshot(
    windowSec: number,
    botId: string | null | undefined,
  ): ActionHealthSnapshot | null {
    const cached = this.sharedSnapshotCache.get(
      this.buildCacheKey(windowSec, this.normalizeBotId(botId)),
    );
    if (!cached) {
      return null;
    }
    if (Date.now() - cached.updatedAtMs > this.sharedSnapshotMaxAgeMs) {
      return null;
    }
    return cached.snapshot;
  }

  private buildSnapshotFromSharedFields(
    fields: Record<string, string>,
    windowSec: number,
    nowSec: number,
  ): ActionHealthSnapshot {
    const cutoffSec = nowSec - windowSec + 1;
    let success = 0;
    let failure = 0;
    let critical = 0;

    for (const [rawField, rawValue] of Object.entries(fields)) {
      const separatorIndex = rawField.lastIndexOf(':');
      if (separatorIndex <= 0) {
        continue;
      }
      const field = rawField.slice(0, separatorIndex) as ActionCounterField;
      const bucketSec = Number(rawField.slice(separatorIndex + 1));
      const value = Number(rawValue);
      if (!Number.isFinite(bucketSec) || !Number.isFinite(value) || bucketSec < cutoffSec) {
        continue;
      }

      if (field === 'success') {
        success += value;
      } else if (field === 'failure') {
        failure += value;
      } else if (field === 'critical') {
        critical += value;
      }
    }

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
}
