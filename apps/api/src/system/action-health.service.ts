import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

type TimedCounters = {
  success: number[];
  failure: number[];
  critical: number[];
};

type TimedCountersByBot = Map<string, TimedCounters>;
type TimedCountersByLane = Map<ActionHealthLane, TimedCounters>;
type TimedCountersByBotLane = Map<string, TimedCountersByLane>;

type ActionCounterField = 'success' | 'failure' | 'critical';
export type ActionHealthLane = 'critical' | 'interactive' | 'background';

type SharedWindowField = {
  bucketMinute: number;
  field: ActionCounterField;
  name: string;
};

type ActionHealthSharedStoragePhase =
  | 'bridge_v1_read_dual_write'
  | 'switch_v2_read_dual_write'
  | 'contract_v2_only';

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

const ACTION_HEALTH_LANES = [
  'critical',
  'interactive',
  'background',
] as const satisfies readonly ActionHealthLane[];
const ACTION_COUNTER_FIELDS = [
  'success',
  'failure',
  'critical',
] as const satisfies readonly ActionCounterField[];
const ACTION_HEALTH_SHARED_BUCKET_TTL_MS = 180_000;

// FLAG: Advance only bridge -> switch -> contract across separate full API releases. Never skip a
// phase: adjacent phases are deliberately read/write compatible during rollout and rollback.
function resolveActionHealthSharedStoragePhase(): ActionHealthSharedStoragePhase {
  return 'bridge_v1_read_dual_write';
}

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
  private readonly countersByLane: TimedCountersByLane = new Map();
  private readonly countersByBotLane: TimedCountersByBotLane = new Map();
  private readonly sharedSnapshotCache = new Map<string, CachedSnapshot>();
  private readonly sharedSnapshotMaxAgeMs: number;
  private readonly sharedStoragePhase = resolveActionHealthSharedStoragePhase();
  private sharedRefreshPromise: Promise<void> | null = null;
  private sharedRefreshWindowSec: number | null = null;
  private sharedWriteWarnAtMs = 0;

  constructor(configService: ConfigService) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.sharedSnapshotMaxAgeMs = 2_000;
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  recordSuccess(botId?: string | null, nowMs = Date.now()) {
    this.recordSuccessForLane('interactive', botId, nowMs);
  }

  recordSuccessForLane(lane: ActionHealthLane, botId?: string | null, nowMs = Date.now()) {
    this.counters.success.push(nowMs);
    this.getLaneCounters(lane).success.push(nowMs);
    if (botId) {
      this.getBotCounters(botId).success.push(nowMs);
      this.getBotLaneCounters(botId, lane).success.push(nowMs);
    }
    this.recordSharedCounter('success', botId, nowMs, lane);
  }

  recordFailure(isCritical: boolean, botId?: string | null, nowMs = Date.now()) {
    this.recordFailureForLane('interactive', isCritical, botId, nowMs);
  }

  recordFailureForLane(
    lane: ActionHealthLane,
    isCritical: boolean,
    botId?: string | null,
    nowMs = Date.now(),
  ) {
    this.counters.failure.push(nowMs);
    const laneCounters = this.getLaneCounters(lane);
    laneCounters.failure.push(nowMs);
    if (isCritical) {
      this.counters.critical.push(nowMs);
      laneCounters.critical.push(nowMs);
    }
    if (botId) {
      const botCounters = this.getBotCounters(botId);
      botCounters.failure.push(nowMs);
      const botLaneCounters = this.getBotLaneCounters(botId, lane);
      botLaneCounters.failure.push(nowMs);
      if (isCritical) {
        botCounters.critical.push(nowMs);
        botLaneCounters.critical.push(nowMs);
      }
    }
    this.recordSharedCounter('failure', botId, nowMs, lane);
    if (isCritical) {
      this.recordSharedCounter('critical', botId, nowMs, lane);
    }
  }

  getSnapshot(windowSec: number, botId?: string | null): ActionHealthSnapshot {
    const cachedSnapshot = this.readCachedSharedSnapshot(windowSec, botId, null);
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

  getLaneSnapshot(
    windowSec: number,
    lane: ActionHealthLane,
    botId?: string | null,
  ): ActionHealthSnapshot {
    const cachedSnapshot = this.readCachedSharedSnapshot(windowSec, botId, lane);
    if (cachedSnapshot) {
      return cachedSnapshot;
    }

    const now = Date.now();
    const windowMs = windowSec * 1_000;
    const cutoff = now - windowMs;
    const counters = botId ? this.getBotLaneCounters(botId, lane) : this.getLaneCounters(lane);

    this.prune(counters.success, cutoff);
    this.prune(counters.failure, cutoff);
    this.prune(counters.critical, cutoff);

    return this.buildSnapshotFromCounters(windowSec, counters);
  }

  getCombinedSnapshot(
    windowSec: number,
    lanes: readonly ActionHealthLane[],
    botId?: string | null,
  ): ActionHealthSnapshot {
    return lanes.reduce<ActionHealthSnapshot>(
      (total, lane) => this.sumSnapshots(total, this.getLaneSnapshot(windowSec, lane, botId)),
      {
        windowSec,
        total: 0,
        success: 0,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      },
    );
  }

  async refreshSnapshots(windowSec: number, botIds: readonly string[] = []): Promise<void> {
    const scopes = [null, ...botIds]
      .map((botId) => this.normalizeBotId(botId))
      .filter((botId, index, values) => values.indexOf(botId) === index);

    if (scopes.length === 0) {
      return;
    }

    const refreshTargets = scopes.flatMap((botId) => [
      { botId, lane: null as ActionHealthLane | null },
      ...ACTION_HEALTH_LANES.map((lane) => ({ botId, lane })),
    ]);
    if (this.hasFreshSharedSnapshots(windowSec, refreshTargets)) {
      return;
    }

    if (this.sharedRefreshPromise && this.sharedRefreshWindowSec === windowSec) {
      await this.sharedRefreshPromise;
      if (this.hasFreshSharedSnapshots(windowSec, refreshTargets)) {
        return;
      }
    }

    const refreshPromise = this.refreshSnapshotsFromRedis(windowSec, refreshTargets);
    this.sharedRefreshPromise = refreshPromise;
    this.sharedRefreshWindowSec = windowSec;
    try {
      await refreshPromise;
    } finally {
      if (this.sharedRefreshPromise === refreshPromise) {
        this.sharedRefreshPromise = null;
        this.sharedRefreshWindowSec = null;
      }
    }
  }

  private async refreshSnapshotsFromRedis(
    windowSec: number,
    refreshTargets: ReadonlyArray<{ botId: string | null; lane: ActionHealthLane | null }>,
  ): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1_000);
    const windowFields = this.buildWindowFields(windowSec, nowSec);
    const fieldsByBucketMinute = new Map<number, SharedWindowField[]>();
    for (const field of windowFields) {
      const bucketFields = fieldsByBucketMinute.get(field.bucketMinute) ?? [];
      bucketFields.push(field);
      fieldsByBucketMinute.set(field.bucketMinute, bucketFields);
    }
    const pipeline = this.redis.pipeline();
    const readCommands: Array<{
      fields: readonly SharedWindowField[];
      targetIndex: number;
    }> = [];
    refreshTargets.forEach((target, targetIndex) => {
      if (this.sharedStoragePhase === 'bridge_v1_read_dual_write') {
        pipeline.hmget(
          this.buildLegacySharedKey(target.botId, target.lane),
          ...windowFields.map((field) => field.name),
        );
        readCommands.push({ fields: windowFields, targetIndex });
      } else {
        for (const [bucketMinute, bucketFields] of fieldsByBucketMinute) {
          pipeline.hmget(
            this.buildSharedBucketKey(target.botId, target.lane, bucketMinute),
            ...bucketFields.map((field) => field.name),
          );
          readCommands.push({ fields: bucketFields, targetIndex });
        }
      }
    });

    try {
      const results = await pipeline.exec();
      if (!results) {
        return;
      }
      const commandError = results.find(([error]) => error)?.[0];
      if (commandError) {
        throw commandError;
      }

      const snapshots = refreshTargets.map(() => this.buildEmptySnapshot(windowSec));
      readCommands.forEach((command, index) => {
        const payload = results[index]?.[1];
        snapshots[command.targetIndex] = this.sumSnapshots(
          snapshots[command.targetIndex]!,
          this.buildSnapshotFromSharedValues(
            Array.isArray(payload) ? payload : [],
            windowSec,
            command.fields,
          ),
        );
      });

      refreshTargets.forEach((target, index) => {
        this.sharedSnapshotCache.set(this.buildCacheKey(windowSec, target.botId, target.lane), {
          snapshot: snapshots[index]!,
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

  private hasFreshSharedSnapshots(
    windowSec: number,
    refreshTargets: ReadonlyArray<{ botId: string | null; lane: ActionHealthLane | null }>,
  ): boolean {
    return refreshTargets.every((target) =>
      Boolean(this.readCachedSharedSnapshot(windowSec, target.botId, target.lane)),
    );
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

  private getLaneCounters(lane: ActionHealthLane): TimedCounters {
    const existing = this.countersByLane.get(lane);
    if (existing) {
      return existing;
    }

    const created: TimedCounters = {
      success: [],
      failure: [],
      critical: [],
    };
    this.countersByLane.set(lane, created);
    return created;
  }

  private getBotLaneCounters(botId: string, lane: ActionHealthLane): TimedCounters {
    const existingByLane = this.countersByBotLane.get(botId);
    if (existingByLane?.has(lane)) {
      return existingByLane.get(lane)!;
    }

    const byLane =
      existingByLane ??
      (() => {
        const created = new Map<ActionHealthLane, TimedCounters>();
        this.countersByBotLane.set(botId, created);
        return created;
      })();
    const created: TimedCounters = {
      success: [],
      failure: [],
      critical: [],
    };
    byLane.set(lane, created);
    return created;
  }

  private recordSharedCounter(
    field: ActionCounterField,
    botId: string | null | undefined,
    nowMs: number,
    lane: ActionHealthLane,
  ) {
    const bucketSec = Math.floor(nowMs / 1_000);
    const fieldName = `${field}:${bucketSec}`;
    const bucketMinute = Math.floor(bucketSec / 60);
    const keys = [
      this.buildSharedBucketKey(null, null, bucketMinute),
      this.buildSharedBucketKey(null, lane, bucketMinute),
    ];
    if (this.sharedStoragePhase !== 'contract_v2_only') {
      keys.push(this.buildLegacySharedKey(null, null), this.buildLegacySharedKey(null, lane));
    }
    const normalizedBotId = this.normalizeBotId(botId);
    if (normalizedBotId) {
      keys.push(
        this.buildSharedBucketKey(normalizedBotId, null, bucketMinute),
        this.buildSharedBucketKey(normalizedBotId, lane, bucketMinute),
      );
      if (this.sharedStoragePhase !== 'contract_v2_only') {
        keys.push(
          this.buildLegacySharedKey(normalizedBotId, null),
          this.buildLegacySharedKey(normalizedBotId, lane),
        );
      }
    }

    const pipeline = this.redis.pipeline();
    for (const key of keys) {
      pipeline.hincrby(key, fieldName, 1);
      pipeline.pexpire(key, ACTION_HEALTH_SHARED_BUCKET_TTL_MS);
    }

    void pipeline
      .exec()
      .then((results) => {
        const commandError = results?.find(([error]) => error)?.[0];
        if (commandError) {
          throw commandError;
        }
      })
      .catch((error: unknown) => {
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

  private buildLegacySharedKey(botId: string | null, lane: ActionHealthLane | null): string {
    const base = botId ? `system:action-health:v1:bot:${botId}` : 'system:action-health:v1:global';
    return lane ? `${base}:lane:${lane}` : base;
  }

  private buildSharedBucketKey(
    botId: string | null,
    lane: ActionHealthLane | null,
    bucketMinute: number,
  ): string {
    // FLAG: Time partitioning bounds every hash even when traffic continuously renews its TTL.
    const base = botId ? `system:action-health:v2:bot:${botId}` : 'system:action-health:v2:global';
    const scope = lane ? `${base}:lane:${lane}` : base;
    return `${scope}:minute:${bucketMinute}`;
  }

  private buildCacheKey(
    windowSec: number,
    botId: string | null,
    lane: ActionHealthLane | null,
  ): string {
    return `${windowSec}:${botId ?? 'global'}:${lane ?? 'all'}`;
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
    lane: ActionHealthLane | null,
  ): ActionHealthSnapshot | null {
    const cached = this.sharedSnapshotCache.get(
      this.buildCacheKey(windowSec, this.normalizeBotId(botId), lane),
    );
    if (!cached) {
      return null;
    }
    if (Date.now() - cached.updatedAtMs > this.sharedSnapshotMaxAgeMs) {
      return null;
    }
    return cached.snapshot;
  }

  private buildSnapshotFromCounters(
    windowSec: number,
    counters: TimedCounters,
  ): ActionHealthSnapshot {
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

  private buildEmptySnapshot(windowSec: number): ActionHealthSnapshot {
    return {
      windowSec,
      total: 0,
      success: 0,
      failure: 0,
      critical: 0,
      errorRate: 0,
      criticalRate: 0,
    };
  }

  private sumSnapshots(
    left: ActionHealthSnapshot,
    right: ActionHealthSnapshot,
  ): ActionHealthSnapshot {
    const success = left.success + right.success;
    const failure = left.failure + right.failure;
    const critical = left.critical + right.critical;
    const total = success + failure;

    return {
      windowSec: left.windowSec,
      total,
      success,
      failure,
      critical,
      errorRate: total > 0 ? failure / total : 0,
      criticalRate: total > 0 ? critical / total : 0,
    };
  }

  private buildWindowFields(windowSec: number, nowSec: number): SharedWindowField[] {
    const windowStartSec = nowSec - windowSec + 1;
    const fields: SharedWindowField[] = [];

    for (let bucketSec = windowStartSec; bucketSec <= nowSec; bucketSec += 1) {
      ACTION_COUNTER_FIELDS.forEach((field) => {
        fields.push({
          bucketMinute: Math.floor(bucketSec / 60),
          field,
          name: `${field}:${bucketSec}`,
        });
      });
    }

    return fields;
  }

  private buildSnapshotFromSharedValues(
    values: readonly unknown[],
    windowSec: number,
    windowFields: readonly Pick<SharedWindowField, 'field'>[],
  ): ActionHealthSnapshot {
    let success = 0;
    let failure = 0;
    let critical = 0;

    values.forEach((rawValue, index) => {
      const field = windowFields[index]?.field;
      if (!field) {
        return;
      }

      const value =
        typeof rawValue === 'number'
          ? rawValue
          : typeof rawValue === 'string'
            ? Number(rawValue)
            : Number.NaN;
      if (!Number.isFinite(value) || value <= 0) {
        return;
      }

      if (field === 'success') {
        success += value;
      } else if (field === 'failure') {
        failure += value;
      } else if (field === 'critical') {
        critical += value;
      }
    });

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
