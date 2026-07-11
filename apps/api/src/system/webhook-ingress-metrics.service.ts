import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export type WebhookIngressBotMetrics = {
  attemptedReceipts: number;
  persistedReceipts: number;
  failedReceipts: number;
};

export type WebhookIngressMetricsSnapshot = {
  available: boolean;
  targetMs: number;
  attemptedReceipts: number;
  persistedReceipts: number;
  failedReceipts: number;
  sampledReceipts: number;
  p95LatencyMs: number | null;
  p99LatencyMs: number | null;
  underTargetRatio: number | null;
  bots: Record<string, WebhookIngressBotMetrics>;
};

export type WebhookReceiptPersistenceMetric = {
  botId: string;
  outcome: 'persisted' | 'failed';
  latencyMs: number;
};

const METRICS_KEY_PREFIX = 'system:webhook-ingress:metrics:v1';
const METRICS_BUCKET_SEC = 10;
const DEFAULT_INGRESS_TARGET_MS = 2_000;
const DEFAULT_SLO_WINDOW_SEC = 15 * 60;
const MIN_RETENTION_SEC = 60 * 60;
const MAX_RETENTION_SEC = 24 * 60 * 60;
const METRICS_FAILURE_LOG_INTERVAL_MS = 30_000;
const LATENCY_BUCKET_UPPER_BOUNDS_MS = [
  25, 50, 100, 200, 400, 750, 1_000, 1_500, 2_000, 3_000, 5_000, 10_000, 20_000, 30_000,
] as const;

const RECORD_RECEIPT_LUA = `
local key = KEYS[1]
local outcome = ARGV[1]
local bot = ARGV[2]
local latencyBucket = ARGV[3]
local latencyMs = tonumber(ARGV[4]) or 0
local underTarget = ARGV[5]
local ttlSec = tonumber(ARGV[6]) or 3600

redis.call('HINCRBY', key, 'attempted', 1)
redis.call('HINCRBY', key, 'bot:' .. bot .. ':attempted', 1)

if outcome == 'persisted' then
  redis.call('HINCRBY', key, 'persisted', 1)
  redis.call('HINCRBY', key, 'latency:' .. latencyBucket, 1)
  redis.call('HINCRBY', key, 'bot:' .. bot .. ':persisted', 1)
  if underTarget == '1' then
    redis.call('HINCRBY', key, 'under_target', 1)
  end
  local currentMax = tonumber(redis.call('HGET', key, 'max_latency_ms') or '0')
  if latencyMs > currentMax then
    redis.call('HSET', key, 'max_latency_ms', tostring(latencyMs))
  end
else
  redis.call('HINCRBY', key, 'failed', 1)
  redis.call('HINCRBY', key, 'bot:' .. bot .. ':failed', 1)
end

redis.call('EXPIRE', key, ttlSec)
return 1
`;

@Injectable()
export class WebhookIngressMetricsService implements OnModuleDestroy {
  private readonly logger = new Logger(WebhookIngressMetricsService.name);
  private readonly redis: Redis;
  private readonly targetMs: number;
  private readonly retentionSec: number;
  private lastWriteFailureLogAtMs = 0;
  private lastReadFailureLogAtMs = 0;

  constructor(configService: ConfigService) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.targetMs = this.readPositiveInt(
      configService.get('SYSTEM_WEBHOOK_INGRESS_SLO_TARGET_MS'),
      DEFAULT_INGRESS_TARGET_MS,
    );
    const sloWindowSec = this.readPositiveInt(
      configService.get('SYSTEM_WEBHOOK_SLO_WINDOW_SEC'),
      DEFAULT_SLO_WINDOW_SEC,
    );
    this.retentionSec = Math.min(MAX_RETENTION_SEC, Math.max(MIN_RETENTION_SEC, sloWindowSec * 2));
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  async recordReceiptPersistence(metric: WebhookReceiptPersistenceMetric): Promise<void> {
    const botId = metric.botId.trim();
    if (!botId) {
      return;
    }

    const nowMs = Date.now();
    const latencyMs = this.normalizeLatency(metric.latencyMs);
    const latencyBucket = this.resolveLatencyBucketIndex(latencyMs);
    const key = this.buildBucketKey(nowMs);
    try {
      await this.redis.eval(
        RECORD_RECEIPT_LUA,
        1,
        key,
        metric.outcome,
        Buffer.from(botId, 'utf8').toString('base64url'),
        String(latencyBucket),
        String(latencyMs),
        latencyMs <= this.targetMs ? '1' : '0',
        String(this.retentionSec),
      );
    } catch {
      this.logWriteFailure();
    }
  }

  async getSnapshot(options: { windowSec: number }): Promise<WebhookIngressMetricsSnapshot> {
    const windowSec = this.readPositiveInt(options.windowSec, DEFAULT_SLO_WINDOW_SEC);
    const nowMs = Date.now();
    const keys = this.buildWindowKeys(nowMs, windowSec);
    try {
      const pipeline = this.redis.pipeline();
      for (const key of keys) {
        pipeline.hgetall(key);
      }
      const results = await pipeline.exec();
      if (!results) {
        throw new Error('Redis ingress metrics pipeline returned no result');
      }

      const rows = results.map(([error, value]) => {
        if (error) {
          throw error;
        }
        return this.isStringRecord(value) ? value : {};
      });
      return this.aggregateRows(rows);
    } catch {
      this.logReadFailure();
      return this.emptySnapshot(false);
    }
  }

  private aggregateRows(
    rows: ReadonlyArray<Record<string, string>>,
  ): WebhookIngressMetricsSnapshot {
    let attemptedReceipts = 0;
    let persistedReceipts = 0;
    let failedReceipts = 0;
    let underTargetReceipts = 0;
    let maxLatencyMs = 0;
    const latencyBuckets = LATENCY_BUCKET_UPPER_BOUNDS_MS.map(() => 0).concat(0);
    const bots = new Map<string, WebhookIngressBotMetrics>();

    for (const row of rows) {
      attemptedReceipts += this.readCounter(row.attempted);
      persistedReceipts += this.readCounter(row.persisted);
      failedReceipts += this.readCounter(row.failed);
      underTargetReceipts += this.readCounter(row.under_target);
      maxLatencyMs = Math.max(maxLatencyMs, this.readCounter(row.max_latency_ms));

      for (let index = 0; index < latencyBuckets.length; index += 1) {
        latencyBuckets[index] =
          (latencyBuckets[index] ?? 0) + this.readCounter(row[`latency:${index}`]);
      }

      for (const [field, rawCount] of Object.entries(row)) {
        const match = /^bot:([^:]+):(attempted|persisted|failed)$/u.exec(field);
        if (!match) {
          continue;
        }
        const botId = this.decodeBotId(match[1] ?? '');
        if (!botId) {
          continue;
        }
        const counters = bots.get(botId) ?? {
          attemptedReceipts: 0,
          persistedReceipts: 0,
          failedReceipts: 0,
        };
        const count = this.readCounter(rawCount);
        if (match[2] === 'attempted') {
          counters.attemptedReceipts += count;
        } else if (match[2] === 'persisted') {
          counters.persistedReceipts += count;
        } else {
          counters.failedReceipts += count;
        }
        bots.set(botId, counters);
      }
    }

    const sampledReceipts = latencyBuckets.reduce((sum, count) => sum + count, 0);
    return {
      available: true,
      targetMs: this.targetMs,
      attemptedReceipts,
      persistedReceipts,
      failedReceipts,
      sampledReceipts,
      p95LatencyMs: this.percentile(latencyBuckets, sampledReceipts, 0.95, maxLatencyMs),
      p99LatencyMs: this.percentile(latencyBuckets, sampledReceipts, 0.99, maxLatencyMs),
      underTargetRatio:
        sampledReceipts > 0
          ? Number((Math.min(sampledReceipts, underTargetReceipts) / sampledReceipts).toFixed(3))
          : null,
      bots: Object.fromEntries(
        [...bots.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
    };
  }

  private percentile(
    buckets: readonly number[],
    total: number,
    percentile: number,
    maxLatencyMs: number,
  ): number | null {
    if (total <= 0) {
      return null;
    }
    const rank = Math.max(1, Math.ceil(total * percentile));
    let cumulative = 0;
    for (let index = 0; index < buckets.length; index += 1) {
      cumulative += buckets[index] ?? 0;
      if (cumulative < rank) {
        continue;
      }
      return index < LATENCY_BUCKET_UPPER_BOUNDS_MS.length
        ? (LATENCY_BUCKET_UPPER_BOUNDS_MS[index] ?? maxLatencyMs)
        : Math.max(
            maxLatencyMs,
            LATENCY_BUCKET_UPPER_BOUNDS_MS[LATENCY_BUCKET_UPPER_BOUNDS_MS.length - 1] ?? 0,
          );
    }
    return maxLatencyMs;
  }

  private buildWindowKeys(nowMs: number, windowSec: number): string[] {
    const nowBucket = Math.floor(nowMs / (METRICS_BUCKET_SEC * 1_000));
    const firstBucket = Math.floor((nowMs - windowSec * 1_000) / (METRICS_BUCKET_SEC * 1_000));
    const keys: string[] = [];
    for (let bucket = firstBucket; bucket <= nowBucket; bucket += 1) {
      keys.push(`${METRICS_KEY_PREFIX}:${this.targetMs}:${bucket}`);
    }
    return keys;
  }

  private buildBucketKey(nowMs: number): string {
    return `${METRICS_KEY_PREFIX}:${this.targetMs}:${Math.floor(
      nowMs / (METRICS_BUCKET_SEC * 1_000),
    )}`;
  }

  private resolveLatencyBucketIndex(latencyMs: number): number {
    const index = LATENCY_BUCKET_UPPER_BOUNDS_MS.findIndex((upperBound) => latencyMs <= upperBound);
    return index >= 0 ? index : LATENCY_BUCKET_UPPER_BOUNDS_MS.length;
  }

  private normalizeLatency(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }

  private decodeBotId(value: string): string | null {
    try {
      const decoded = Buffer.from(value, 'base64url').toString('utf8').trim();
      return decoded.length > 0 ? decoded : null;
    } catch {
      return null;
    }
  }

  private readCounter(value: string | undefined): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
  }

  private readPositiveInt(value: unknown, fallback: number): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.trunc(parsed)) : fallback;
  }

  private isStringRecord(value: unknown): value is Record<string, string> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private emptySnapshot(available: boolean): WebhookIngressMetricsSnapshot {
    return {
      available,
      targetMs: this.targetMs,
      attemptedReceipts: 0,
      persistedReceipts: 0,
      failedReceipts: 0,
      sampledReceipts: 0,
      p95LatencyMs: null,
      p99LatencyMs: null,
      underTargetRatio: null,
      bots: {},
    };
  }

  private logWriteFailure(): void {
    const nowMs = Date.now();
    if (nowMs - this.lastWriteFailureLogAtMs < METRICS_FAILURE_LOG_INTERVAL_MS) {
      return;
    }
    this.lastWriteFailureLogAtMs = nowMs;
    this.logger.warn('Webhook ingress metrics write failed; webhook ACK was not affected');
  }

  private logReadFailure(): void {
    const nowMs = Date.now();
    if (nowMs - this.lastReadFailureLogAtMs < METRICS_FAILURE_LOG_INTERVAL_MS) {
      return;
    }
    this.lastReadFailureLogAtMs = nowMs;
    this.logger.warn('Webhook ingress metrics snapshot is temporarily unavailable');
  }
}
