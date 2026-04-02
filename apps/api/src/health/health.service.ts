import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { QueueMetricsService, type QueueMetricsSnapshot } from '../system/queue-metrics.service';
import { SystemModeService, type SystemModeSnapshot } from '../system/system-mode.service';

export type ReadinessSnapshot = {
  ok: boolean;
  timestamp: string;
  bots: Record<
    string,
    {
      queueLagSec: number;
      rawOk: boolean;
      queuedEvents: number;
      receivedEvents: number;
      failedEvents: number;
      action: SystemModeSnapshot['action'];
    }
  >;
  systemMode: SystemModeSnapshot & {
    degraded: boolean;
  };
  checks: {
    database: boolean;
    redis: boolean;
    queueLag: {
      ok: boolean;
      rawOk: boolean;
      softWarning: boolean;
      softWarningCode: string | null;
      softWarningDetail: string | null;
      thresholdSec: number;
      sustainSec: number;
      severeThresholdSec: number;
      effectiveLagSec: number;
      sampleGeneratedAt: string;
      breachStartedAt: string | null;
      breachDurationSec: number;
      oldestQueuedEventId: string | null;
      oldestQueuedCreatedAt: string | null;
      oldestQueuedLagSec: number;
      oldestReceivedEventId: string | null;
      oldestReceivedCreatedAt: string | null;
      oldestReceivedLagSec: number;
    };
  };
};

const READINESS_CACHE_TTL_MS = 2_000;
const DEFAULT_READINESS_QUEUE_SNAPSHOT_MAX_AGE_MS = 2_000;
const DEFAULT_READINESS_BUILD_TIMEOUT_MS = 2_500;
const DEFAULT_READINESS_DEPENDENCY_TIMEOUT_MS = 1_500;
const DEFAULT_READINESS_STALE_FALLBACK_MAX_AGE_MS = 30_000;
const DEFAULT_READINESS_DEPENDENCY_FALLBACK_MAX_AGE_MS = 5 * 60_000;
const STALE_READY_SOFT_WARNING_CODE = 'stale-ready-fallback';
const READINESS_UNAVAILABLE_REASON = 'readiness snapshot unavailable';

type DependencyHealthKey = 'database' | 'redis';
type DependencyHealthState = {
  ok: boolean;
  checkedAtMs: number;
};

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly queueLagThresholdSec: number;
  private readonly queueLagSustainSec: number;
  private readonly queueLagSevereSec: number;
  private readonly queueSnapshotMaxAgeMs: number;
  private readonly readinessBuildTimeoutMs: number;
  private readonly readinessDependencyTimeoutMs: number;
  private readonly readinessStaleFallbackMaxAgeMs: number;
  private readonly readinessDependencyFallbackMaxAgeMs: number;
  private readyCache: ReadinessSnapshot | null = null;
  private readyCacheAtMs = 0;
  private readyPromise: Promise<ReadinessSnapshot> | null = null;
  private backgroundQueueMetricsRefreshPromise: Promise<void> | null = null;
  private backgroundQueueMetricsRefreshStartedAtMs = 0;
  private queueLagBreachStartedAtMs: number | null = null;
  private readonly dependencyHealth = new Map<DependencyHealthKey, DependencyHealthState>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueMetricsService: QueueMetricsService,
    private readonly systemModeService: SystemModeService,
    configService: ConfigService,
  ) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.queueLagThresholdSec = configService.get<number>('QUEUE_LAG_DEGRADE_SEC', 10);
    this.queueLagSustainSec = Math.max(
      this.queueLagThresholdSec,
      configService.get<number>('READY_QUEUE_LAG_SUSTAIN_SEC', 20),
    );
    this.queueLagSevereSec = Math.max(
      this.queueLagSustainSec,
      configService.get<number>('READY_QUEUE_LAG_SEVERE_SEC', 30),
    );
    this.queueSnapshotMaxAgeMs = configService.get<number>(
      'READINESS_QUEUE_SNAPSHOT_MAX_AGE_MS',
      DEFAULT_READINESS_QUEUE_SNAPSHOT_MAX_AGE_MS,
    );
    this.readinessBuildTimeoutMs = configService.get<number>(
      'READINESS_BUILD_TIMEOUT_MS',
      DEFAULT_READINESS_BUILD_TIMEOUT_MS,
    );
    this.readinessDependencyTimeoutMs = configService.get<number>(
      'READINESS_DEPENDENCY_TIMEOUT_MS',
      DEFAULT_READINESS_DEPENDENCY_TIMEOUT_MS,
    );
    this.readinessStaleFallbackMaxAgeMs = configService.get<number>(
      'READINESS_STALE_FALLBACK_MAX_AGE_MS',
      DEFAULT_READINESS_STALE_FALLBACK_MAX_AGE_MS,
    );
    this.readinessDependencyFallbackMaxAgeMs = Math.max(
      this.readinessStaleFallbackMaxAgeMs,
      configService.get<number>(
        'READINESS_DEPENDENCY_FALLBACK_MAX_AGE_MS',
        DEFAULT_READINESS_DEPENDENCY_FALLBACK_MAX_AGE_MS,
      ),
    );
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  live() {
    return {
      ok: true,
      timestamp: new Date().toISOString(),
    };
  }

  private mapQueueMetricsBots(
    queueMetrics: Pick<QueueMetricsSnapshot, 'bots'> | null | undefined,
  ): ReadinessSnapshot['bots'] {
    return Object.fromEntries(
      Object.entries(queueMetrics?.bots ?? {}).map(([botId, botMetrics]) => [
        botId,
        {
          queueLagSec: botMetrics.userFacingEffectiveLagSec ?? botMetrics.effectiveLagSec,
          rawOk:
            (botMetrics.userFacingEffectiveLagSec ?? botMetrics.effectiveLagSec) <=
            this.queueLagThresholdSec,
          queuedEvents:
            botMetrics.userFacingWebhookEvents?.queued.count ?? botMetrics.webhookEvents.queued.count,
          receivedEvents:
            botMetrics.userFacingWebhookEvents?.received.count ??
            botMetrics.webhookEvents.received.count,
          failedEvents: botMetrics.webhookEvents.failed.count,
          action: botMetrics.actionHealth,
        },
      ]),
    );
  }

  async ready(): Promise<ReadinessSnapshot> {
    const cachedSnapshot = this.getCachedReadySnapshot();
    if (cachedSnapshot) {
      return cachedSnapshot;
    }

    let buildPromise = this.readyPromise;
    if (!buildPromise) {
      buildPromise = this.buildReadySnapshot();
      this.readyPromise = buildPromise;
      void buildPromise
        .then((snapshot) => {
          this.readyCache = snapshot;
          this.readyCacheAtMs = Date.now();
        })
        .catch(() => undefined)
        .finally(() => {
          if (this.readyPromise === buildPromise) {
            this.readyPromise = null;
          }
        });
    }

    try {
      return await this.withTimeout(
        buildPromise,
        this.readinessBuildTimeoutMs,
        'readiness build',
      );
    } catch (error: unknown) {
      if (this.readyPromise === buildPromise) {
        this.readyPromise = null;
      }

      const staleSnapshot = this.getStaleReadySnapshot();
      if (staleSnapshot) {
        return this.decorateStaleReadySnapshot(
          staleSnapshot,
          this.describeReadinessFallback(error),
        );
      }

      const bestEffortSnapshot = await this.buildBestEffortReadySnapshot(
        this.describeReadinessFallback(error),
      );
      if (bestEffortSnapshot) {
        return bestEffortSnapshot;
      }

      return this.buildUnavailableReadySnapshot(this.describeReadinessFallback(error));
    }
  }

  private getCachedReadySnapshot(): ReadinessSnapshot | null {
    if (!this.readyCache) {
      return null;
    }

    if (Date.now() - this.readyCacheAtMs > READINESS_CACHE_TTL_MS) {
      return null;
    }

    return this.readyCache;
  }

  private async buildReadySnapshot(): Promise<ReadinessSnapshot> {
    const [database, redis, systemMode, queueMetricsResult] = await Promise.all([
      this.withTimeout(this.checkDatabase(), this.readinessDependencyTimeoutMs, 'database check'),
      this.withTimeout(this.checkRedis(), this.readinessDependencyTimeoutMs, 'redis check'),
      this.withTimeout(
        this.systemModeService.getEffectiveSnapshot(),
        this.readinessDependencyTimeoutMs,
        'system mode snapshot',
      ),
      this.tryGetQueueMetricsSnapshot(),
    ]);
    this.recordDependencyHealth('database', database);
    this.recordDependencyHealth('redis', redis);
    const queueMetrics = queueMetricsResult.snapshot;
    const cachedQueueMetrics =
      queueMetrics ??
      this.queueMetricsService.peekCachedSnapshot?.(this.readinessStaleFallbackMaxAgeMs) ??
      null;
    const queueMetricsFallbackDetail = queueMetricsResult.fallbackDetail;

    const effectiveLagSec =
      queueMetrics?.userFacingEffectiveLagSec ?? queueMetrics?.effectiveLagSec ?? systemMode.queueLagSec ?? 0;
    const queuedMetrics = queueMetrics
      ? queueMetrics.userFacingWebhookEvents?.queued ?? queueMetrics.webhookEvents.queued
      : { count: 0 };
    const receivedMetrics = queueMetrics
      ? queueMetrics.userFacingWebhookEvents?.received ?? queueMetrics.webhookEvents.received
      : { count: 0 };
    const oldestQueuedEventId =
      queueMetrics?.userFacingOldestQueuedEventId ?? queueMetrics?.oldestQueuedEventId ?? null;
    const oldestQueuedCreatedAt =
      queueMetrics?.userFacingOldestQueuedCreatedAt ?? queueMetrics?.oldestQueuedCreatedAt ?? null;
    const oldestQueuedLagSec =
      queueMetrics?.userFacingOldestQueuedLagSec ?? queueMetrics?.oldestQueuedLagSec ?? 0;
    const oldestReceivedEventId =
      queueMetrics?.userFacingOldestReceivedEventId ?? queueMetrics?.oldestReceivedEventId ?? null;
    const oldestReceivedCreatedAt =
      queueMetrics?.userFacingOldestReceivedCreatedAt ?? queueMetrics?.oldestReceivedCreatedAt ?? null;
    const oldestReceivedLagSec =
      queueMetrics?.userFacingOldestReceivedLagSec ?? queueMetrics?.oldestReceivedLagSec ?? 0;
    const evaluatedAtMs = Date.now();
    const rawQueueLagOk = effectiveLagSec <= this.queueLagThresholdSec;
    const severeQueueLag = effectiveLagSec > this.queueLagSevereSec;
    const breachStartedAtMs = this.updateQueueLagBreachState(rawQueueLagOk, evaluatedAtMs);
    const breachDurationSec = breachStartedAtMs
      ? Math.max(0, (evaluatedAtMs - breachStartedAtMs) / 1_000)
      : 0;
    const queueLagOk =
      !severeQueueLag && (rawQueueLagOk || breachDurationSec < this.queueLagSustainSec);
    const hysteresisSoftWarning = !rawQueueLagOk && queueLagOk;
    const softWarning = hysteresisSoftWarning || Boolean(queueMetricsFallbackDetail);
    const softWarningCode = queueMetricsFallbackDetail
      ? STALE_READY_SOFT_WARNING_CODE
      : hysteresisSoftWarning
        ? 'queue-lag-hysteresis'
        : null;
    const softWarningDetail = queueMetricsFallbackDetail
      ? hysteresisSoftWarning
        ? `Raw user-facing queue lag ${effectiveLagSec.toFixed(1)}s already breached the ${this.queueLagThresholdSec}s threshold, but readiness stays green until the ${this.queueLagSustainSec}s sustain window is exceeded. ${queueMetricsFallbackDetail}`
        : queueMetricsFallbackDetail
      : hysteresisSoftWarning
        ? `Raw user-facing queue lag ${effectiveLagSec.toFixed(1)}s already breached the ${this.queueLagThresholdSec}s threshold, but readiness stays green until the ${this.queueLagSustainSec}s sustain window is exceeded.`
        : null;

    return {
      ok: database && redis && queueLagOk,
      timestamp: new Date().toISOString(),
      bots: this.mapQueueMetricsBots(cachedQueueMetrics),
      systemMode: {
        ...systemMode,
        queueLagSec: effectiveLagSec,
        action: systemMode.action,
        degraded: systemMode.mode === 'degrade',
      },
      checks: {
        database,
        redis,
        queueLag: {
          ok: queueLagOk,
          rawOk: rawQueueLagOk,
          softWarning,
          softWarningCode,
          softWarningDetail,
          thresholdSec: this.queueLagThresholdSec,
          sustainSec: this.queueLagSustainSec,
          severeThresholdSec: this.queueLagSevereSec,
          effectiveLagSec,
          sampleGeneratedAt: queueMetrics?.generatedAt ?? systemMode.updatedAt,
          breachStartedAt: breachStartedAtMs ? new Date(breachStartedAtMs).toISOString() : null,
          breachDurationSec,
          oldestQueuedEventId,
          oldestQueuedCreatedAt,
          oldestQueuedLagSec,
          oldestReceivedEventId,
          oldestReceivedCreatedAt,
          oldestReceivedLagSec,
        },
      },
    };
  }

  private async tryGetQueueMetricsSnapshot(): Promise<{
    snapshot: Awaited<ReturnType<QueueMetricsService['getSnapshot']>> | null;
    fallbackDetail: string | null;
  }> {
    const staleCachedSnapshot =
      this.queueMetricsService.peekCachedSnapshot?.(this.readinessStaleFallbackMaxAgeMs) ?? null;
    const freshCachedSnapshot =
      staleCachedSnapshot &&
      Date.now() - new Date(staleCachedSnapshot.generatedAt).getTime() <= this.queueSnapshotMaxAgeMs
        ? staleCachedSnapshot
        : null;

    if (freshCachedSnapshot) {
      return {
        snapshot: freshCachedSnapshot,
        fallbackDetail: null,
      };
    }

    if (staleCachedSnapshot) {
      this.refreshQueueMetricsSnapshotInBackground();
      return {
        snapshot: staleCachedSnapshot,
        fallbackDetail:
          'Queue metrics detail is temporarily stale, so readiness served a recent cached snapshot while refreshing metrics in the background.',
      };
    }

    try {
      const snapshot = await this.withTimeout(
        this.queueMetricsService.getSnapshot({ maxAgeMs: this.queueSnapshotMaxAgeMs }),
        this.readinessDependencyTimeoutMs,
        'queue metrics snapshot',
      );
      return {
        snapshot,
        fallbackDetail: null,
      };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        snapshot: null,
        fallbackDetail: `Queue metrics detail is temporarily stale, so readiness fell back to the latest system-mode queue lag sample: ${detail}.`,
      };
    }
  }

  private refreshQueueMetricsSnapshotInBackground(): void {
    const now = Date.now();
    if (
      this.backgroundQueueMetricsRefreshPromise ||
      now - this.backgroundQueueMetricsRefreshStartedAtMs < this.queueSnapshotMaxAgeMs
    ) {
      return;
    }

    this.backgroundQueueMetricsRefreshStartedAtMs = now;
    const refreshPromise = this.queueMetricsService
      .getSnapshot({ maxAgeMs: 0 })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        if (this.backgroundQueueMetricsRefreshPromise === refreshPromise) {
          this.backgroundQueueMetricsRefreshPromise = null;
        }
      });
    this.backgroundQueueMetricsRefreshPromise = refreshPromise;
  }

  private updateQueueLagBreachState(
    rawQueueLagOk: boolean,
    evaluatedAtMs: number,
  ): number | null {
    if (rawQueueLagOk) {
      this.queueLagBreachStartedAtMs = null;
      return null;
    }

    if (!this.queueLagBreachStartedAtMs) {
      this.queueLagBreachStartedAtMs = evaluatedAtMs;
    }

    return this.queueLagBreachStartedAtMs;
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  private async checkRedis(): Promise<boolean> {
    try {
      const pong = await this.redis.ping();
      return pong.toUpperCase() === 'PONG';
    } catch {
      return false;
    }
  }

  private getStaleReadySnapshot(): ReadinessSnapshot | null {
    if (!this.readyCache) {
      return null;
    }

    if (Date.now() - this.readyCacheAtMs > this.readinessStaleFallbackMaxAgeMs) {
      return null;
    }

    return this.readyCache;
  }

  private decorateStaleReadySnapshot(
    snapshot: ReadinessSnapshot,
    fallbackDetail: string,
  ): ReadinessSnapshot {
    const existingDetail = snapshot.checks.queueLag.softWarningDetail;
    return {
      ...snapshot,
      timestamp: new Date().toISOString(),
      checks: {
        ...snapshot.checks,
        queueLag: {
          ...snapshot.checks.queueLag,
          softWarning: true,
          softWarningCode: STALE_READY_SOFT_WARNING_CODE,
          softWarningDetail: existingDetail
            ? `${existingDetail} ${fallbackDetail}`
            : fallbackDetail,
        },
      },
    };
  }

  private async buildBestEffortReadySnapshot(
    fallbackDetail: string,
  ): Promise<ReadinessSnapshot | null> {
    const systemMode =
      this.systemModeService.peekCachedSnapshot?.(this.readinessStaleFallbackMaxAgeMs) ?? null;
    if (!systemMode) {
      return null;
    }

    const [database, redis] = await Promise.all([
      this.safeDependencyFallbackCheck('database', () => this.checkDatabase(), 'database check'),
      this.safeDependencyFallbackCheck('redis', () => this.checkRedis(), 'redis check'),
    ]);

    const effectiveLagSec = systemMode.queueLagSec ?? 0;
    const evaluatedAtMs = Date.now();
    const rawQueueLagOk = effectiveLagSec <= this.queueLagThresholdSec;
    const severeQueueLag = effectiveLagSec > this.queueLagSevereSec;
    const breachStartedAtMs = this.updateQueueLagBreachState(rawQueueLagOk, evaluatedAtMs);
    const breachDurationSec = breachStartedAtMs
      ? Math.max(0, (evaluatedAtMs - breachStartedAtMs) / 1_000)
      : 0;
    const queueLagOk =
      !severeQueueLag && (rawQueueLagOk || breachDurationSec < this.queueLagSustainSec);
    const cachedQueueSnapshot =
      this.queueMetricsService.peekCachedSnapshot?.(this.readinessStaleFallbackMaxAgeMs) ?? null;

    return {
      ok: database && redis && queueLagOk,
      timestamp: new Date().toISOString(),
      bots: Object.keys(cachedQueueSnapshot?.bots ?? {}).length
        ? this.mapQueueMetricsBots(cachedQueueSnapshot)
        : this.readyCache?.bots ?? {},
      systemMode: {
        ...systemMode,
        degraded: systemMode.mode === 'degrade',
      },
      checks: {
        database,
        redis,
        queueLag: {
          ok: queueLagOk,
          rawOk: rawQueueLagOk,
          softWarning: true,
          softWarningCode: STALE_READY_SOFT_WARNING_CODE,
          softWarningDetail: fallbackDetail,
          thresholdSec: this.queueLagThresholdSec,
          sustainSec: this.queueLagSustainSec,
          severeThresholdSec: this.queueLagSevereSec,
          effectiveLagSec,
          sampleGeneratedAt: systemMode.updatedAt,
          breachStartedAt: breachStartedAtMs ? new Date(breachStartedAtMs).toISOString() : null,
          breachDurationSec,
          oldestQueuedEventId: null,
          oldestQueuedCreatedAt: null,
          oldestQueuedLagSec: 0,
          oldestReceivedEventId: null,
          oldestReceivedCreatedAt: null,
          oldestReceivedLagSec: 0,
        },
      },
    };
  }

  private buildUnavailableReadySnapshot(fallbackDetail: string): ReadinessSnapshot {
    const timestamp = new Date().toISOString();
    const systemMode = this.systemModeService.peekCachedSnapshot?.() ?? {
      mode: 'degrade',
      source: 'auto',
      reason: READINESS_UNAVAILABLE_REASON,
      updatedAt: timestamp,
      manualMode: null,
      queueLagSec: 0,
      action: {
        windowSec: 60,
        total: 0,
        success: 0,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      },
    };

    return {
      ok: false,
      timestamp,
      bots: {},
      systemMode: {
        ...systemMode,
        degraded: true,
      },
      checks: {
        database: false,
        redis: false,
        queueLag: {
          ok: false,
          rawOk: false,
          softWarning: true,
          softWarningCode: STALE_READY_SOFT_WARNING_CODE,
          softWarningDetail: fallbackDetail,
          thresholdSec: this.queueLagThresholdSec,
          sustainSec: this.queueLagSustainSec,
          severeThresholdSec: this.queueLagSevereSec,
          effectiveLagSec: 0,
          sampleGeneratedAt: timestamp,
          breachStartedAt: null,
          breachDurationSec: 0,
          oldestQueuedEventId: null,
          oldestQueuedCreatedAt: null,
          oldestQueuedLagSec: 0,
          oldestReceivedEventId: null,
          oldestReceivedCreatedAt: null,
          oldestReceivedLagSec: 0,
        },
      },
    };
  }

  private describeReadinessFallback(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    return `Serving stale readiness data because live readiness evaluation did not finish in ${this.readinessBuildTimeoutMs}ms: ${detail}`;
  }

  private async safeDependencyFallbackCheck(
    dependency: DependencyHealthKey,
    check: () => Promise<boolean>,
    label: string,
  ): Promise<boolean> {
    try {
      const result = await this.withTimeout(check(), this.readinessDependencyTimeoutMs, label);
      this.recordDependencyHealth(dependency, result);
      return result;
    } catch {
      return this.readCachedDependencyHealth(dependency) ?? false;
    }
  }

  private recordDependencyHealth(dependency: DependencyHealthKey, ok: boolean): void {
    this.dependencyHealth.set(dependency, {
      ok,
      checkedAtMs: Date.now(),
    });
  }

  private readCachedDependencyHealth(dependency: DependencyHealthKey): boolean | null {
    const cached = this.dependencyHealth.get(dependency);
    if (!cached) {
      return null;
    }

    if (Date.now() - cached.checkedAtMs > this.readinessDependencyFallbackMaxAgeMs) {
      this.dependencyHealth.delete(dependency);
      return null;
    }

    return cached.ok;
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`${label} exceeded ${timeoutMs}ms`));
      }, timeoutMs);
      timeoutId.unref?.();

      promise.then(
        (value) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      );
    });
  }
}
