import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

type MaxApiTrafficClass = 'critical' | 'interactive' | 'background';

type SourceCounterBucket = {
  perSecond: Map<number, number>;
  trafficClassBuckets: Record<MaxApiTrafficClass, Map<number, number>>;
};

const MAX_API_SOURCE_METRICS_KEY_PREFIX = 'maxapi:rps:source:v1';
const DEFAULT_MAX_API_SOURCE_METRICS_WINDOW_SEC = 10 * 60;
const MAX_API_SOURCE_METRICS_WINDOW_SEC_LIMIT = 6 * 60 * 60;
const MAX_API_SOURCE_METRICS_SCAN_COUNT = 500;
const MAX_API_TRAFFIC_CLASSES: readonly MaxApiTrafficClass[] = [
  'critical',
  'interactive',
  'background',
] as const;

@Injectable()
export class MaxApiMetricsService implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(configService: ConfigService) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  async getSourceSnapshot(options: { windowSec?: number } = {}) {
    const nowSec = Math.floor(Date.now() / 1_000);
    const windowSec = this.normalizeWindowSec(options.windowSec);
    const startSec = nowSec - windowSec + 1;
    const keys = await this.scanKeys(`${MAX_API_SOURCE_METRICS_KEY_PREFIX}:*`);
    const parsedEntries = keys
      .map((key) => this.parseMetricKey(key))
      .filter(
        (entry): entry is NonNullable<ReturnType<typeof this.parseMetricKey>> =>
          entry !== null && entry.sec >= startSec && entry.sec <= nowSec,
      );

    if (parsedEntries.length === 0) {
      return {
        generatedAt: new Date().toISOString(),
        windowSec,
        windowStartAt: new Date(startSec * 1_000).toISOString(),
        windowEndAt: new Date(nowSec * 1_000).toISOString(),
        overall: this.buildEmptyStats(windowSec),
        sources: {},
        bots: {},
      };
    }

    const countsByKey = await this.readCounts(parsedEntries.map((entry) => entry.key));
    const overallBucket = this.createSourceCounterBucket();
    const sourceBuckets = new Map<string, SourceCounterBucket>();
    const botBuckets = new Map<
      string,
      {
        overall: SourceCounterBucket;
        sources: Map<string, SourceCounterBucket>;
      }
    >();

    for (const entry of parsedEntries) {
      const count = countsByKey.get(entry.key) ?? 0;
      if (count <= 0) {
        continue;
      }

      this.incrementBucket(overallBucket, entry.trafficClass, entry.sec, count);

      const sourceBucket = sourceBuckets.get(entry.sourceTag) ?? this.createSourceCounterBucket();
      this.incrementBucket(sourceBucket, entry.trafficClass, entry.sec, count);
      sourceBuckets.set(entry.sourceTag, sourceBucket);

      const botEntry =
        botBuckets.get(entry.botId) ??
        (() => {
          const next = {
            overall: this.createSourceCounterBucket(),
            sources: new Map<string, SourceCounterBucket>(),
          };
          botBuckets.set(entry.botId, next);
          return next;
        })();
      this.incrementBucket(botEntry.overall, entry.trafficClass, entry.sec, count);
      const botSourceBucket =
        botEntry.sources.get(entry.sourceTag) ?? this.createSourceCounterBucket();
      this.incrementBucket(botSourceBucket, entry.trafficClass, entry.sec, count);
      botEntry.sources.set(entry.sourceTag, botSourceBucket);
    }

    return {
      generatedAt: new Date().toISOString(),
      windowSec,
      windowStartAt: new Date(startSec * 1_000).toISOString(),
      windowEndAt: new Date(nowSec * 1_000).toISOString(),
      overall: this.buildStats(overallBucket, windowSec),
      sources: Object.fromEntries(
        [...sourceBuckets.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([sourceTag, bucket]) => [sourceTag, this.buildStats(bucket, windowSec)]),
      ),
      bots: Object.fromEntries(
        [...botBuckets.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([botId, bucket]) => [
            botId,
            {
              overall: this.buildStats(bucket.overall, windowSec),
              sources: Object.fromEntries(
                [...bucket.sources.entries()]
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([sourceTag, sourceBucket]) => [
                    sourceTag,
                    this.buildStats(sourceBucket, windowSec),
                  ]),
              ),
            },
          ]),
      ),
    };
  }

  private normalizeWindowSec(value: number | undefined): number {
    const numericValue = typeof value === 'number' ? value : Number.NaN;
    if (!Number.isFinite(numericValue)) {
      return DEFAULT_MAX_API_SOURCE_METRICS_WINDOW_SEC;
    }

    return Math.max(60, Math.min(MAX_API_SOURCE_METRICS_WINDOW_SEC_LIMIT, Math.trunc(numericValue)));
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';

    do {
      const [nextCursor, chunk] = await this.redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        String(MAX_API_SOURCE_METRICS_SCAN_COUNT),
      );
      cursor = nextCursor;
      if (Array.isArray(chunk) && chunk.length > 0) {
        keys.push(...chunk);
      }
    } while (cursor !== '0');

    return keys;
  }

  private async readCounts(keys: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();

    for (let index = 0; index < keys.length; index += 200) {
      const chunk = keys.slice(index, index + 200);
      const values = await this.redis.mget(...chunk);
      chunk.forEach((key, valueIndex) => {
        const count = Number(values[valueIndex] ?? 0);
        if (Number.isFinite(count) && count > 0) {
          counts.set(key, Math.trunc(count));
        }
      });
    }

    return counts;
  }

  private parseMetricKey(key: string): {
    key: string;
    botId: string;
    trafficClass: MaxApiTrafficClass;
    sourceTag: string;
    sec: number;
  } | null {
    const prefix = `${MAX_API_SOURCE_METRICS_KEY_PREFIX}:`;
    if (!key.startsWith(prefix)) {
      return null;
    }

    const [botId, trafficClassRaw, sourceTag, secRaw, ...rest] = key.slice(prefix.length).split(':');
    if (!botId || !sourceTag || rest.length > 0) {
      return null;
    }
    if (!MAX_API_TRAFFIC_CLASSES.includes(trafficClassRaw as MaxApiTrafficClass)) {
      return null;
    }

    const sec = Number.parseInt(secRaw ?? '', 10);
    if (!Number.isFinite(sec)) {
      return null;
    }

    return {
      key,
      botId,
      trafficClass: trafficClassRaw as MaxApiTrafficClass,
      sourceTag,
      sec,
    };
  }

  private createSourceCounterBucket(): SourceCounterBucket {
    return {
      perSecond: new Map(),
      trafficClassBuckets: {
        critical: new Map(),
        interactive: new Map(),
        background: new Map(),
      },
    };
  }

  private incrementBucket(
    bucket: SourceCounterBucket,
    trafficClass: MaxApiTrafficClass,
    sec: number,
    amount: number,
  ): void {
    bucket.perSecond.set(sec, (bucket.perSecond.get(sec) ?? 0) + amount);
    const trafficClassBucket = bucket.trafficClassBuckets[trafficClass];
    trafficClassBucket.set(sec, (trafficClassBucket.get(sec) ?? 0) + amount);
  }

  private buildStats(bucket: SourceCounterBucket, windowSec: number) {
    return {
      ...this.buildTrafficClassStats(bucket.perSecond, windowSec),
      trafficClasses: {
        critical: this.buildTrafficClassStats(bucket.trafficClassBuckets.critical, windowSec),
        interactive: this.buildTrafficClassStats(
          bucket.trafficClassBuckets.interactive,
          windowSec,
        ),
        background: this.buildTrafficClassStats(bucket.trafficClassBuckets.background, windowSec),
      },
    };
  }

  private buildEmptyStats(windowSec: number) {
    return {
      ...this.buildTrafficClassStats(new Map(), windowSec),
      trafficClasses: {
        critical: this.buildTrafficClassStats(new Map(), windowSec),
        interactive: this.buildTrafficClassStats(new Map(), windowSec),
        background: this.buildTrafficClassStats(new Map(), windowSec),
      },
    };
  }

  private buildTrafficClassStats(bucket: Map<number, number>, windowSec: number) {
    const counts = [...bucket.values()];
    const totalRequests = counts.reduce((sum, value) => sum + value, 0);
    const peakRps = counts.reduce((max, value) => Math.max(max, value), 0);
    const activeSeconds = counts.filter((value) => value > 0).length;

    return {
      totalRequests,
      avgRps: Number((totalRequests / windowSec).toFixed(3)),
      peakRps,
      activeSeconds,
    };
  }
}
