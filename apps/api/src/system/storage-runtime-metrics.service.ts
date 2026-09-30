import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { isRuntimeServiceName, RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';

export const STORAGE_RUNTIME_METRICS_PREFIX = 'runtime:storage-cost:v1:';
export const STORAGE_RUNTIME_COUNTERS = [
  'deleteLeaseChecks',
  'deleteLeaseRenewals',
  'deleteLeaseReads',
  'deleteLeaseLost',
  'deleteLeaseErrors',
] as const;
export type StorageRuntimeCounter = (typeof STORAGE_RUNTIME_COUNTERS)[number];
export const STORAGE_DELETE_RECONCILER_PHASES = [
  'staleSendFences',
  'replacementRecovery',
  'dueSweep',
  'retainedPurge',
] as const;
export type StorageDeleteReconcilerPhase = (typeof STORAGE_DELETE_RECONCILER_PHASES)[number];
const DELETE_RECONCILER_FIELDS = ['tickCalls', 'skippedInFlight', 'completedTicks'] as const;
const DELETE_RECONCILER_PHASE_FIELDS = ['calls', 'succeeded', 'errors', 'returnedCount'] as const;
const CACHE_FIELDS = [
  'entries',
  'estimatedBytes',
  'maxEntries',
  'maxBytes',
  'maxEntryBytes',
  'hits',
  'misses',
  'writes',
  'oversizedSkips',
  'capacityEvictions',
  'expiredEvictions',
  'invalidations',
  'sweepInspected',
] as const;
const VK_FIELDS = [
  'batches',
  'postsAttempted',
  'rowsWritten',
  'rowsSkippedOrFenced',
  'failedBatches',
] as const;
const DURATION_FIELDS = ['under100Ms', 'under500Ms', 'under2000Ms', 'atLeast2000Ms'] as const;
const REPORT_INTERVAL_MS = 30_000;
const REPORT_TTL_MS = 90_000;

function fixedNumbers(value: unknown, fields: readonly string[]): Record<string, number> {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    fields.map((field) => {
      const number = source[field];
      return [
        field,
        typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : 0,
      ];
    }),
  );
}

function checkedNumbers(value: unknown, fields: readonly string[]): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (
    fields.some(
      (field) =>
        typeof source[field] !== 'number' ||
        !Number.isSafeInteger(source[field]) ||
        (source[field] as number) < 0,
    )
  )
    return null;
  return Object.fromEntries(fields.map((field) => [field, source[field] as number]));
}

function sanitizeDeleteReconcilerSnapshot(value: unknown) {
  const counters = checkedNumbers(value, DELETE_RECONCILER_FIELDS);
  if (!counters) return null;
  const source = value as Record<string, unknown>;
  if (!source.phases || typeof source.phases !== 'object' || Array.isArray(source.phases))
    return null;
  const phases = source.phases as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const phase of STORAGE_DELETE_RECONCILER_PHASES) {
    const counters = checkedNumbers(phases[phase], DELETE_RECONCILER_PHASE_FIELDS);
    const value = phases[phase] as Record<string, unknown> | undefined;
    const durationBuckets = checkedNumbers(value?.durationBuckets, DURATION_FIELDS);
    if (!counters || !durationBuckets) return null;
    sanitized[phase] = { ...counters, durationBuckets };
  }
  return { ...counters, phases: sanitized };
}

export function sanitizeStorageRuntimeSnapshot(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  if (
    source.schemaVersion !== 1 ||
    typeof source.startedAt !== 'number' ||
    !Number.isSafeInteger(source.startedAt) ||
    typeof source.observedAt !== 'number' ||
    !Number.isSafeInteger(source.observedAt) ||
    source.startedAt <= 0 ||
    source.startedAt > source.observedAt
  )
    return null;
  const vk = source.vkPersistence as Record<string, unknown> | undefined;
  const counters = checkedNumbers(source.counters, STORAGE_RUNTIME_COUNTERS);
  const cache =
    source.chatContextCache == null ? null : checkedNumbers(source.chatContextCache, CACHE_FIELDS);
  const vkCounters = source.vkPersistence == null ? null : checkedNumbers(vk, VK_FIELDS);
  const durations =
    source.vkPersistence == null ? null : checkedNumbers(vk?.durationBuckets, DURATION_FIELDS);
  const deleteReconciler =
    source.deleteReconciler == null
      ? null
      : sanitizeDeleteReconcilerSnapshot(source.deleteReconciler);
  if (
    !counters ||
    (source.chatContextCache != null && !cache) ||
    (source.vkPersistence != null && (!vkCounters || !durations)) ||
    (source.deleteReconciler != null && !deleteReconciler)
  )
    return null;
  return {
    schemaVersion: 1,
    startedAt: source.startedAt,
    observedAt: source.observedAt,
    counters,
    chatContextCache: cache,
    deleteReconciler,
    vkPersistence: vk
      ? {
          ...vkCounters,
          durationBuckets: durations,
        }
      : null,
  };
}

export async function readStorageRuntimeFleet(redis: Pick<Redis, 'mget'>) {
  try {
    const values = await redis.mget(
      ...RUNTIME_SERVICE_NAMES.map((service) => `${STORAGE_RUNTIME_METRICS_PREFIX}${service}`),
    );
    return {
      available: true,
      observedAt: Date.now(),
      // Each role has an independent cumulative epoch; missing reports are
      // missing coverage, never healthy zeroes or an inferred process restart.
      services: RUNTIME_SERVICE_NAMES.map((service, index) => {
        let snapshot = null;
        try {
          const raw = values[index];
          if (raw && Buffer.byteLength(raw) <= 8_192)
            snapshot = sanitizeStorageRuntimeSnapshot(JSON.parse(raw));
        } catch {
          /* Missing coverage. */
        }
        if (
          snapshot &&
          (Date.now() - snapshot.observedAt > REPORT_TTL_MS ||
            snapshot.observedAt > Date.now() + 5_000)
        )
          snapshot = null;
        return { service, snapshot };
      }),
    };
  } catch {
    return { available: false, observedAt: Date.now(), services: [] };
  }
}

// FLAG: Only fixed scalar metrics leave a worker. No chat/bot IDs, payloads,
// error text, credentials, arbitrary labels, SQL, or environment are persisted.
@Injectable()
export class StorageRuntimeMetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly redis: Redis;
  private readonly startedAt = Date.now();
  private readonly serviceName: string | null;
  private readonly counters = fixedNumbers({}, STORAGE_RUNTIME_COUNTERS);
  private cacheProvider: (() => unknown) | null = null;
  private vkProvider: (() => unknown) | null = null;
  private deleteReconcilerProvider: (() => unknown) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(config: ConfigService) {
    const name = config.get<string>('APP_SERVICE_NAME');
    this.serviceName = isRuntimeServiceName(name) ? name : null;
    this.redis = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 1_000,
      commandTimeout: 1_000,
    });
    this.redis.on('error', () => undefined);
  }

  onModuleInit(): void {
    void this.redis.connect().catch(() => undefined);
    if (!this.serviceName) return;
    this.timer = setInterval(() => void this.publish(), REPORT_INTERVAL_MS);
    this.timer.unref();
  }

  increment(counter: StorageRuntimeCounter): void {
    if (this.counters[counter] < Number.MAX_SAFE_INTEGER) this.counters[counter]++;
  }

  registerChatContextCacheSnapshot(provider: () => unknown): void {
    this.cacheProvider = provider;
  }
  registerVkPersistenceSnapshot(provider: () => unknown): void {
    this.vkProvider = provider;
  }
  registerDeleteReconcilerSnapshot(provider: () => unknown): void {
    this.deleteReconcilerProvider = provider;
  }

  getLocalSnapshot() {
    const readProvider = (provider: (() => unknown) | null) => {
      try {
        return provider?.();
      } catch {
        return null;
      }
    };
    return sanitizeStorageRuntimeSnapshot({
      schemaVersion: 1,
      startedAt: this.startedAt,
      observedAt: Date.now(),
      counters: this.counters,
      chatContextCache: readProvider(this.cacheProvider),
      vkPersistence: readProvider(this.vkProvider),
      deleteReconciler: readProvider(this.deleteReconcilerProvider),
    });
  }

  publish(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!this.serviceName) return Promise.resolve();
    this.inFlight = Promise.resolve()
      .then(() =>
        this.redis.set(
          `${STORAGE_RUNTIME_METRICS_PREFIX}${this.serviceName}`,
          JSON.stringify(this.getLocalSnapshot()),
          'PX',
          REPORT_TTL_MS,
        ),
      )
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  getFleetSnapshot() {
    return readStorageRuntimeFleet(this.redis);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
    this.redis.disconnect();
  }
}
