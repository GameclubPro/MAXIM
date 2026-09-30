import { ConfigService } from '@nestjs/config';
import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';
import {
  sanitizeStorageRuntimeSnapshot,
  STORAGE_DELETE_RECONCILER_PHASES,
  StorageRuntimeMetricsService,
} from './storage-runtime-metrics.service';

const mockRedis = {
  on: jest.fn(),
  connect: jest.fn().mockResolvedValue(undefined),
  set: jest.fn().mockResolvedValue('OK'),
  mget: jest.fn(),
  disconnect: jest.fn(),
};
jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn(() => mockRedis) }));

function deleteReconcilerSnapshot() {
  return {
    tickCalls: 1,
    skippedInFlight: 0,
    completedTicks: 1,
    phases: Object.fromEntries(
      STORAGE_DELETE_RECONCILER_PHASES.map((phase) => [
        phase,
        {
          calls: 1,
          succeeded: 1,
          errors: 0,
          returnedCount: 0,
          durationBuckets: { under100Ms: 1, under500Ms: 0, under2000Ms: 0, atLeast2000Ms: 0 },
        },
      ]),
    ),
  };
}

describe('bounded storage-runtime metrics', () => {
  let metrics: StorageRuntimeMetricsService;
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.set.mockResolvedValue('OK');
    metrics = new StorageRuntimeMetricsService(
      new ConfigService({
        APP_SERVICE_NAME: 'api-admin',
        REDIS_URL: 'redis://127.0.0.1:6379',
      }),
    );
  });
  afterEach(async () => {
    await metrics.onModuleDestroy();
  });

  it('persists only fixed scalars and bounds the lifetime of every report', async () => {
    metrics.increment('deleteLeaseChecks');
    metrics.registerChatContextCacheSnapshot(() => ({
      entries: 2,
      estimatedBytes: 100,
      hits: 1,
      maxEntries: 2048,
      maxBytes: 33554432,
      maxEntryBytes: 16777216,
      misses: 0,
      writes: 0,
      oversizedSkips: 0,
      capacityEvictions: 0,
      expiredEvictions: 0,
      invalidations: 0,
      sweepInspected: 0,
      payload: 'private-content-fixture',
      chatId: 'private-id-fixture',
    }));
    metrics.registerVkPersistenceSnapshot(() => ({
      batches: 1,
      postsAttempted: 1,
      rowsWritten: 1,
      rowsSkippedOrFenced: 0,
      failedBatches: 0,
      durationBuckets: {
        under100Ms: 1,
        under500Ms: 0,
        under2000Ms: 0,
        atLeast2000Ms: 0,
        sql: 'private-sql-fixture',
      },
    }));
    await metrics.publish();
    const [key, encoded, expiration, ttl] = mockRedis.set.mock.calls[0];
    expect(key).toBe('runtime:storage-cost:v1:api-admin');
    expect(expiration).toBe('PX');
    expect(ttl).toBe(90_000);
    expect(encoded).not.toContain('private-');
    const snapshot = JSON.parse(encoded);
    expect(snapshot.counters.deleteLeaseChecks).toBe(1);
    expect(snapshot.chatContextCache.entries).toBe(2);
    expect(snapshot.vkPersistence.durationBuckets.under100Ms).toBe(1);
  });
  it('coalesces slow reporting without queuing reports or affecting work', async () => {
    let resolve!: (value: string) => void;
    mockRedis.set.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = metrics.publish();
    expect(metrics.publish()).toBe(first);
    await Promise.resolve();
    expect(mockRedis.set).toHaveBeenCalledTimes(1);
    resolve('OK');
    await first;
  });
  it('publishes only fixed reconciliation phases with the existing process epoch and report', async () => {
    const fixture = deleteReconcilerSnapshot();
    fixture.phases.privateLabel = { ...fixture.phases.dueSweep };
    metrics.registerDeleteReconcilerSnapshot(() => ({
      ...fixture,
      error: 'private-error-fixture',
      phases: {
        ...fixture.phases,
        dueSweep: { ...fixture.phases.dueSweep, payload: 'private-content-fixture' },
      },
    }));
    const before = metrics.getLocalSnapshot()!;
    await metrics.publish();
    expect(mockRedis.set).toHaveBeenCalledTimes(1);
    const encoded = mockRedis.set.mock.calls[0][1];
    const snapshot = JSON.parse(encoded);
    expect(snapshot.startedAt).toBe(before.startedAt);
    expect(Object.keys(snapshot.deleteReconciler.phases)).toEqual(STORAGE_DELETE_RECONCILER_PHASES);
    expect(snapshot.deleteReconciler.phases.dueSweep.returnedCount).toBe(0);
    expect(encoded).not.toContain('private');
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(8192);
  });
  it('rejects invalid reconciliation counts and allows reports from roles without this provider', () => {
    const valid = metrics.getLocalSnapshot()!;
    expect(valid.deleteReconciler).toBeNull();
    const older = Object.fromEntries(
      Object.entries(valid).filter(([field]) => field !== 'deleteReconciler'),
    );
    expect(sanitizeStorageRuntimeSnapshot(older)?.deleteReconciler).toBeNull();
    const fixture = deleteReconcilerSnapshot();
    for (const value of [-1, Infinity, NaN, '1', undefined])
      expect(
        sanitizeStorageRuntimeSnapshot({
          ...valid,
          deleteReconciler: {
            ...fixture,
            phases: {
              ...fixture.phases,
              dueSweep: { ...fixture.phases.dueSweep, returnedCount: value },
            },
          },
        }),
      ).toBeNull();
  });
  it('keeps a failing reconciliation provider independent of other local measurements', () => {
    metrics.increment('deleteLeaseChecks');
    metrics.registerDeleteReconcilerSnapshot(() => {
      throw new Error('private-error-fixture');
    });
    expect(metrics.getLocalSnapshot()).toMatchObject({
      deleteReconciler: null,
      counters: { deleteLeaseChecks: 1 },
    });
  });
  it('fails softly on Redis and on a local provider exception', async () => {
    metrics.registerChatContextCacheSnapshot(() => {
      throw new Error('private-error-fixture');
    });
    mockRedis.set.mockRejectedValueOnce(new Error('private-error-fixture'));
    await expect(metrics.publish()).resolves.toBeUndefined();
    expect(metrics.getLocalSnapshot()?.chatContextCache).toBeNull();
    mockRedis.mget.mockRejectedValueOnce(new Error('private-error-fixture'));
    await expect(metrics.getFleetSnapshot()).resolves.toMatchObject({
      available: false,
      services: [],
    });
  });
  it('marks missing, malformed, too large and stale reports as missing coverage', async () => {
    const healthy = JSON.stringify(metrics.getLocalSnapshot());
    const stale = JSON.stringify({
      ...metrics.getLocalSnapshot(),
      observedAt: Date.now() - 100_000,
    });
    mockRedis.mget.mockResolvedValueOnce([
      healthy,
      stale,
      '{',
      'x'.repeat(10_000),
      ...Array(11).fill(null),
    ]);
    const fleet = await metrics.getFleetSnapshot();
    expect(mockRedis.mget.mock.calls[0]).toHaveLength(RUNTIME_SERVICE_NAMES.length);
    expect(fleet.services[0].snapshot).not.toBeNull();
    expect(fleet.services.slice(1).every((entry) => entry.snapshot === null)).toBe(true);
  });
  it('publishes an independent process start so a restarted role cannot inherit its old counters', async () => {
    jest.spyOn(Date, 'now').mockReturnValueOnce(100_000);
    const restarted = new StorageRuntimeMetricsService(
      new ConfigService({
        APP_SERVICE_NAME: 'api-publisher',
        REDIS_URL: 'redis://127.0.0.1:6379',
      }),
    );
    try {
      expect(restarted.getLocalSnapshot()?.startedAt).toBe(100_000);
      expect(restarted.getLocalSnapshot()?.counters.deleteLeaseChecks).toBe(0);
    } finally {
      jest.restoreAllMocks();
      await restarted.onModuleDestroy();
    }
  });
  it('does not allow configuration to create arbitrary metric keys', async () => {
    const invalid = new StorageRuntimeMetricsService(
      new ConfigService({
        APP_SERVICE_NAME: 'unknown-user-value',
        REDIS_URL: 'redis://127.0.0.1:6379',
      }),
    );
    try {
      await invalid.publish();
      expect(mockRedis.set).not.toHaveBeenCalled();
    } finally {
      await invalid.onModuleDestroy();
    }
  });
  it('rejects unknown report versions without exposing their content', () => {
    expect(sanitizeStorageRuntimeSnapshot({ schemaVersion: 2, payload: 'private' })).toBeNull();
  });
  it('rejects corrupt counters and epochs rather than presenting them as zero savings', () => {
    const valid = metrics.getLocalSnapshot()!;
    for (const value of [-1, Infinity, NaN, '1', undefined])
      expect(
        sanitizeStorageRuntimeSnapshot({
          ...valid,
          counters: { ...valid.counters, deleteLeaseChecks: value },
        }),
      ).toBeNull();
    expect(sanitizeStorageRuntimeSnapshot({ ...valid, startedAt: 0 })).toBeNull();
    expect(
      sanitizeStorageRuntimeSnapshot({ ...valid, startedAt: valid.observedAt + 1 }),
    ).toBeNull();
  });
});
