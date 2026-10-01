import type Redis from 'ioredis';
import type { ChainableCommander } from 'ioredis';

export type MaxApiMetricsStorageLayout = 'legacy' | 'minute';

// FLAG: Rollback guards use this capability marker after minute writers are enabled.
// Publishing reader support alone does not activate any rollback floor.
export const MAX_API_METRICS_MINUTE_READER_VERSION = 1;

const COUNTER_PREFIXES = [
  ['maxapi:rps:service:v1', 'maxapi:rps:service:v2'],
  ['maxapi:rps:source:v1', 'maxapi:rps:source:v2'],
  ['maxapi:rate-limit:v1', 'maxapi:rate-limit:v2'],
  ['maxapi:rps:global', 'maxapi:rps:global:v2'],
  ['maxapi:rps:stack', 'maxapi:rps:stack:v2'],
] as const;

export type MaxApiMinuteCounterAddress = {
  key: string;
  field: string;
  minuteStartSec: number;
};

// FLAG: Only observational counters use this layout. Limiter reservations and safety
// fences retain their existing keys, TTLs and algorithms.
export function maxApiMinuteCounterAddress(legacyKey: string): MaxApiMinuteCounterAddress {
  const prefixes = COUNTER_PREFIXES.find(([legacy]) => legacyKey.startsWith(`${legacy}:`));
  const separator = legacyKey.lastIndexOf(':');
  const secRaw = legacyKey.slice(separator + 1);
  const sec = Number(secRaw);
  if (!prefixes || !/^\d+$/u.test(secRaw) || !Number.isSafeInteger(sec) || sec < 0) {
    throw new Error('Invalid MAX API observational counter key');
  }
  const minuteStartSec = Math.floor(sec / 60) * 60;
  const dimensionSuffix = legacyKey.slice(prefixes[0].length, separator);
  return {
    key: `${prefixes[1]}${dimensionSuffix}:${minuteStartSec}`,
    field: String(sec - minuteStartSec),
    minuteStartSec,
  };
}

export function maxApiLegacyCounterMinute(key: string): {
  legacyStem: string;
  minuteStartSec: number;
} | null {
  const prefixes = COUNTER_PREFIXES.find(([, minute]) => key.startsWith(`${minute}:`));
  if (!prefixes) {
    return null;
  }
  const separator = key.lastIndexOf(':');
  const secRaw = key.slice(separator + 1);
  const minuteStartSec = Number(secRaw);
  if (
    !/^\d+$/u.test(secRaw) ||
    !Number.isSafeInteger(minuteStartSec) ||
    minuteStartSec < 0 ||
    minuteStartSec % 60 !== 0
  ) {
    return null;
  }
  return {
    legacyStem: `${prefixes[0]}${key.slice(prefixes[1].length, separator)}`,
    minuteStartSec,
  };
}

export function appendMaxApiCounterIncrement(
  transaction: ChainableCommander,
  metric: { key: string; ttlSec: number },
  layout: MaxApiMetricsStorageLayout,
): void {
  // FLAG: Service counters retain their last-write-based 120s TTL in legacy storage.
  // A second can remain alive for part of the TTL boundary second; minute-level
  // expiry and second-only clipping cannot preserve that subsecond behavior.
  if (layout === 'legacy' || metric.key.startsWith('maxapi:rps:service:v1:')) {
    transaction.incr(metric.key).expire(metric.key, metric.ttlSec);
    return;
  }
  const address = maxApiMinuteCounterAddress(metric.key);
  // FLAG: A single event has one layout. Readers sum disjoint events during rolling
  // upgrades; dual writing would double counts and change governor decisions.
  transaction
    .hincrby(address.key, address.field, 1)
    .expireat(address.key, address.minuteStartSec + 60 + metric.ttlSec);
}

function positiveCounter(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
}

export async function readMaxApiMetricCounts(
  redis: Redis,
  legacyKeys: readonly string[],
  batchSize = 200,
): Promise<Map<string, number>> {
  if (MAX_API_METRICS_MINUTE_READER_VERSION !== 1) {
    throw new Error('Unsupported MAX API minute counter reader version');
  }
  const counts = new Map<string, number>();
  const nowSec = Math.floor(Date.now() / 1_000);
  const normalizedBatchSize = Number.isFinite(batchSize)
    ? Math.max(1, Math.min(2_000, Math.trunc(batchSize)))
    : 200;
  for (let index = 0; index < legacyKeys.length; index += normalizedBatchSize) {
    const chunk = legacyKeys.slice(index, index + normalizedBatchSize);
    const values = await redis.mget(...chunk);
    const minuteGroups = new Map<string, Array<{ legacyKey: string; field: string }>>();
    chunk.forEach((legacyKey, valueIndex) => {
      const count = positiveCounter(values[valueIndex]);
      if (count > 0) {
        counts.set(legacyKey, count);
      }
      const address = maxApiMinuteCounterAddress(legacyKey);
      const ttlSec = legacyKey.startsWith('maxapi:rps:service:v1:') ? 120 : 6 * 60 * 60;
      // FLAG: Minute expiry preserves the latest second in the bucket; readers must
      // still exclude older retained fields at the logical per-counter TTL edge.
      if (address.minuteStartSec + Number(address.field) >= nowSec - ttlSec + 1) {
        const entries = minuteGroups.get(address.key) ?? [];
        entries.push({ legacyKey, field: address.field });
        minuteGroups.set(address.key, entries);
      }
    });
    const groups = [...minuteGroups.entries()];
    if (groups.length === 0) {
      continue;
    }
    const pipeline = redis.pipeline();
    for (const [key, entries] of groups) {
      pipeline.hmget(key, ...entries.map((entry) => entry.field));
    }
    const results = await pipeline.exec();
    if (!results || results.length !== groups.length) {
      throw new Error('Incomplete MAX API minute counter read');
    }
    groups.forEach(([, entries], groupIndex) => {
      const [error, result] = results[groupIndex]!;
      if (error) {
        throw error;
      }
      if (!Array.isArray(result) || result.length !== entries.length) {
        throw new Error('Invalid MAX API minute counter read');
      }
      entries.forEach((entry, valueIndex) => {
        const count = positiveCounter(result[valueIndex]);
        if (count > 0) {
          counts.set(entry.legacyKey, (counts.get(entry.legacyKey) ?? 0) + count);
        }
      });
    });
  }
  return counts;
}
