import { Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import {
  NativeTesseractOcrAdapter,
  type NativeTesseractQueueWaitSnapshot,
  type NativeTesseractRuntimeStatus,
} from '../moderation/commercial-ocr/native-tesseract-ocr.adapter';
import {
  CommercialOcrMetricsService,
  type CommercialOcrRolloutMetricsSnapshot,
} from '../moderation/commercial-ocr/commercial-ocr-metrics.service';
import { COMMERCIAL_OCR_QUEUE } from '../moderation/commercial-ocr/commercial-ocr.queue';
import { MaxApiMetricsService } from '../system/max-api-metrics.service';
import {
  QueueMetricsService,
  type QueueCounters,
  type QueueMetricsSnapshot,
} from '../system/queue-metrics.service';
import { RuntimeDiagnosticsService } from '../system/runtime-diagnostics.service';
import { SystemModeService, type SystemModeSnapshot } from '../system/system-mode.service';

const LOWER_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

type ReadinessBotMaxApiSnapshot = {
  windowSec: number;
  avgRps: number;
  peakRps: number;
  load: number;
};

export type ReadinessSnapshot = {
  ok: boolean;
  timestamp: string;
  burst?: {
    active: boolean;
    peakLagSec: number;
    peakBotId: string | null;
    startedAt: string | null;
    lastRecoveredAt: string | null;
    sampleAgeMs: number;
  };
  bots: Record<
    string,
    {
      queueLagSec: number;
      rawOk: boolean;
      queuedEvents: number;
      receivedEvents: number;
      failedEvents: number;
      failedEventsTotal?: number;
      staleFailedEvents?: number;
      failedEventsWindowSec?: number;
      action: SystemModeSnapshot['action'];
      maxApi?: ReadinessBotMaxApiSnapshot;
    }
  >;
  systemMode: SystemModeSnapshot & {
    degraded: boolean;
  };
  checks: {
    database: boolean;
    redis: boolean;
    ocr?: OcrReadinessSnapshot;
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

export type OcrReadinessSnapshot =
  | Readonly<
      Omit<NativeTesseractRuntimeStatus, 'queueWaitMs'> & {
        rolloutMetrics: CommercialOcrRolloutMetricsSnapshot | null;
        queues: Readonly<{
          bullMq: QueueCounters | null;
          native: Readonly<{
            depth: number;
            busy: number;
            workers: number;
            waitMs: NativeTesseractQueueWaitSnapshot;
          }>;
        }>;
      }
    >
  | Readonly<{
      state: 'unavailable';
      ready: false;
      workers: Readonly<{ configured: 0; live: 0; ready: 0; busy: 0 }>;
      queueDepth: 0;
      counters: Readonly<{
        completed: 0;
        failed: 0;
        restarts: 0;
        recycles: 0;
        failuresByReason: Readonly<Record<string, never>>;
      }>;
      latencyMs: Readonly<{ last: null; average: null; maximum: null }>;
      behaviorIdentity: Readonly<{
        fingerprintSha256: null;
        runtimeFingerprintSha256: null;
        buildManifestSha256: null;
        complete: false;
        required: true;
        verified: false;
        state: 'unavailable';
        mismatchFields: readonly [];
      }>;
      rolloutMetrics: null;
      queues: Readonly<{
        bullMq: null;
        native: Readonly<{
          depth: 0;
          busy: 0;
          workers: 0;
          waitMs: NativeTesseractQueueWaitSnapshot;
        }>;
      }>;
    }>;

export type OcrRuntimeReadinessSnapshot = Readonly<{
  ok: boolean;
  timestamp: string;
  scope: 'ocr';
  checks: Readonly<{
    ocr: OcrRuntimeReadinessCheck;
  }>;
}>;

type OcrRuntimeReadinessCheck = Readonly<{
  state: NativeTesseractRuntimeStatus['state'] | 'unavailable';
  ready: boolean;
  workers: Readonly<{ configured: number; live: number; ready: number; busy: number }>;
  queueDepth: number;
  behaviorIdentity: Readonly<{
    complete: boolean;
    required: boolean;
    verified: boolean;
    state: NativeTesseractRuntimeStatus['behaviorIdentity']['state'] | 'unavailable';
  }>;
}>;

export type BotLoadSnapshot = {
  ok: boolean;
  timestamp: string;
  windowSec: number;
  bots: Record<
    string,
    {
      load: number | null;
      avgRps: number;
      peakRps: number;
    }
  >;
};

const READINESS_CACHE_TTL_MS = 2_000;
const DEFAULT_READINESS_QUEUE_SNAPSHOT_MAX_AGE_MS = 2_000;
const DEFAULT_READINESS_BUILD_TIMEOUT_MS = 2_500;
const DEFAULT_READINESS_DEPENDENCY_TIMEOUT_MS = 1_500;
const DEFAULT_READINESS_OPTIONAL_DIAGNOSTICS_TIMEOUT_MS = 250;
const DEFAULT_READINESS_FRESH_HEALTHY_DEPENDENCY_MAX_AGE_MS = 10_000;
const DEFAULT_READINESS_STALE_FALLBACK_MAX_AGE_MS = 30_000;
const DEFAULT_READINESS_DEPENDENCY_FALLBACK_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_READINESS_MAX_API_WINDOW_SEC = 60;
const STALE_READY_SOFT_WARNING_CODE = 'stale-ready-fallback';
const READINESS_UNAVAILABLE_REASON = 'readiness snapshot unavailable';

type DependencyHealthKey = 'database' | 'redis';
type DependencyHealthState = {
  ok: boolean;
  checkedAtMs: number;
};

function unavailableOcrReadiness(): OcrReadinessSnapshot {
  return {
    state: 'unavailable',
    ready: false,
    workers: { configured: 0, live: 0, ready: 0, busy: 0 },
    queueDepth: 0,
    counters: {
      completed: 0,
      failed: 0,
      restarts: 0,
      recycles: 0,
      failuresByReason: {},
    },
    latencyMs: { last: null, average: null, maximum: null },
    behaviorIdentity: {
      fingerprintSha256: null,
      runtimeFingerprintSha256: null,
      buildManifestSha256: null,
      complete: false,
      required: true,
      verified: false,
      state: 'unavailable',
      mismatchFields: [],
    },
    rolloutMetrics: null,
    queues: {
      bullMq: null,
      native: { depth: 0, busy: 0, workers: 0, waitMs: emptyNativeQueueWaitSnapshot() },
    },
  };
}

function emptyNativeQueueWaitSnapshot(): NativeTesseractQueueWaitSnapshot {
  return {
    observed: 0,
    sampled: 0,
    capacity: 512,
    last: null,
    average: null,
    p95: null,
    p99: null,
    maximum: null,
  };
}

function isOcrRuntimeReady(status: NativeTesseractRuntimeStatus): boolean {
  return (
    status.ready &&
    status.behaviorIdentity.required &&
    status.behaviorIdentity.complete &&
    status.behaviorIdentity.verified &&
    status.behaviorIdentity.state === 'verified' &&
    status.behaviorIdentity.mismatchFields.length === 0 &&
    LOWER_SHA256_PATTERN.test(status.behaviorIdentity.fingerprintSha256) &&
    status.behaviorIdentity.runtimeFingerprintSha256 ===
      status.behaviorIdentity.fingerprintSha256 &&
    typeof status.behaviorIdentity.buildManifestSha256 === 'string' &&
    LOWER_SHA256_PATTERN.test(status.behaviorIdentity.buildManifestSha256)
  );
}

function mapOcrRuntimeReadiness(status: NativeTesseractRuntimeStatus): OcrRuntimeReadinessCheck {
  const ready = isOcrRuntimeReady(status);
  return {
    state: !ready && status.state === 'ready' ? 'degraded' : status.state,
    ready,
    workers: {
      configured: status.workers.configured,
      live: status.workers.live,
      ready: status.workers.ready,
      busy: status.workers.busy,
    },
    queueDepth: status.queueDepth,
    behaviorIdentity: {
      complete: status.behaviorIdentity.complete,
      required: status.behaviorIdentity.required,
      verified: status.behaviorIdentity.verified,
      state: status.behaviorIdentity.state,
    },
  };
}

function unavailableOcrRuntimeReadiness(): OcrRuntimeReadinessCheck {
  return {
    state: 'unavailable',
    ready: false,
    workers: { configured: 0, live: 0, ready: 0, busy: 0 },
    queueDepth: 0,
    behaviorIdentity: {
      complete: false,
      required: true,
      verified: false,
      state: 'unavailable',
    },
  };
}

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly queueLagThresholdSec: number;
  private readonly queueLagSustainSec: number;
  private readonly queueLagSevereSec: number;
  private readonly queueSnapshotMaxAgeMs: number;
  private readonly readinessBuildTimeoutMs: number;
  private readonly readinessDependencyTimeoutMs: number;
  private readonly readinessOptionalDiagnosticsTimeoutMs: number;
  private readonly readinessFreshHealthyDependencyMaxAgeMs: number;
  private readonly readinessStaleFallbackMaxAgeMs: number;
  private readonly readinessDependencyFallbackMaxAgeMs: number;
  private readonly readinessMaxApiWindowSec: number;
  private readonly ocrReadinessRequired: boolean;
  private readyCache: ReadinessSnapshot | null = null;
  private readyCacheAtMs = 0;
  private readyPromise: Promise<ReadinessSnapshot> | null = null;
  private backgroundQueueMetricsRefreshPromise: Promise<void> | null = null;
  private backgroundQueueMetricsRefreshStartedAtMs = 0;
  private readonly backgroundDependencyRefreshPromises = new Map<
    DependencyHealthKey,
    Promise<void>
  >();
  private readonly backgroundDependencyRefreshStartedAtMs = new Map<DependencyHealthKey, number>();
  private queueLagBreachStartedAtMs: number | null = null;
  private readonly dependencyHealth = new Map<DependencyHealthKey, DependencyHealthState>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueMetricsService: QueueMetricsService,
    private readonly systemModeService: SystemModeService,
    configService: ConfigService,
    private readonly runtimeDiagnosticsService?: RuntimeDiagnosticsService,
    private readonly maxApiMetricsService?: MaxApiMetricsService,
    @Optional()
    private readonly nativeTesseractOcr?: NativeTesseractOcrAdapter,
    @Optional()
    private readonly commercialOcrMetrics?: CommercialOcrMetricsService,
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
    this.readinessOptionalDiagnosticsTimeoutMs = Math.max(
      1,
      Math.min(
        this.readinessBuildTimeoutMs,
        configService.get<number>(
          'READINESS_OPTIONAL_DIAGNOSTICS_TIMEOUT_MS',
          DEFAULT_READINESS_OPTIONAL_DIAGNOSTICS_TIMEOUT_MS,
        ),
      ),
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
    this.readinessFreshHealthyDependencyMaxAgeMs = Math.max(
      READINESS_CACHE_TTL_MS,
      Math.min(
        this.readinessDependencyFallbackMaxAgeMs,
        configService.get<number>(
          'READINESS_FRESH_HEALTHY_DEPENDENCY_MAX_AGE_MS',
          DEFAULT_READINESS_FRESH_HEALTHY_DEPENDENCY_MAX_AGE_MS,
        ),
      ),
    );
    this.readinessMaxApiWindowSec = Math.max(
      10,
      configService.get<number>(
        'READINESS_MAX_API_WINDOW_SEC',
        DEFAULT_READINESS_MAX_API_WINDOW_SEC,
      ),
    );
    this.ocrReadinessRequired =
      configService.get<string>('APP_SERVICE_NAME') === 'api-media-analysis';
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

  ocrReady(): OcrRuntimeReadinessSnapshot {
    let ocr = unavailableOcrRuntimeReadiness();
    if (this.nativeTesseractOcr) {
      try {
        ocr = mapOcrRuntimeReadiness(this.nativeTesseractOcr.getRuntimeStatus());
      } catch {
        ocr = unavailableOcrRuntimeReadiness();
      }
    }

    return {
      ok: ocr.ready,
      timestamp: new Date().toISOString(),
      scope: 'ocr',
      checks: { ocr },
    };
  }

  async botLoad(botIds: readonly string[]): Promise<BotLoadSnapshot> {
    const normalizedBotIds = [...new Set(botIds.map((botId) => botId.trim()).filter(Boolean))];
    const maxApiBotSnapshots = await this.tryGetMaxApiBotSnapshots(normalizedBotIds);

    return {
      ok: true,
      timestamp: new Date().toISOString(),
      windowSec: this.readinessMaxApiWindowSec,
      bots: Object.fromEntries(
        normalizedBotIds.map((botId) => [
          botId,
          {
            load: maxApiBotSnapshots?.[botId]?.smoothedLoad ?? null,
            avgRps: maxApiBotSnapshots?.[botId]?.avgRps ?? 0,
            peakRps: maxApiBotSnapshots?.[botId]?.peakRps ?? 0,
          },
        ]),
      ),
    };
  }

  private mapQueueMetricsBots(
    queueMetrics: Pick<QueueMetricsSnapshot, 'bots'> | null | undefined,
    maxApiBotSnapshots: Awaited<
      ReturnType<MaxApiMetricsService['getBotRateLimitSnapshot']>
    > | null = null,
  ): ReadinessSnapshot['bots'] {
    return Object.fromEntries(
      Object.entries(queueMetrics?.bots ?? {}).map(([botId, botMetrics]) => {
        const maxApiSnapshot = maxApiBotSnapshots?.[botId];
        const activeFailedEvents =
          botMetrics.webhookEvents.failed.activeCount ?? botMetrics.webhookEvents.failed.count;
        const staleFailedEvents =
          botMetrics.webhookEvents.failed.staleCount ??
          Math.max(0, botMetrics.webhookEvents.failed.count - activeFailedEvents);
        return [
          botId,
          {
            queueLagSec: botMetrics.userFacingEffectiveLagSec ?? botMetrics.effectiveLagSec,
            rawOk:
              (botMetrics.userFacingEffectiveLagSec ?? botMetrics.effectiveLagSec) <=
              this.queueLagThresholdSec,
            queuedEvents:
              botMetrics.userFacingWebhookEvents?.queued.count ??
              botMetrics.webhookEvents.queued.count,
            receivedEvents:
              botMetrics.userFacingWebhookEvents?.received.count ??
              botMetrics.webhookEvents.received.count,
            failedEvents: activeFailedEvents,
            ...(botMetrics.webhookEvents.failed.count !== activeFailedEvents
              ? {
                  failedEventsTotal: botMetrics.webhookEvents.failed.count,
                  staleFailedEvents,
                  failedEventsWindowSec:
                    botMetrics.webhookEvents.failed.activeWindowSec ?? undefined,
                }
              : {}),
            action: botMetrics.actionHealth,
            ...(maxApiSnapshot
              ? {
                  maxApi: {
                    windowSec: maxApiSnapshot.windowSec,
                    avgRps: maxApiSnapshot.avgRps,
                    peakRps: maxApiSnapshot.peakRps,
                    load: maxApiSnapshot.smoothedLoad,
                  },
                }
              : {}),
          },
        ];
      }),
    );
  }

  async ready(): Promise<ReadinessSnapshot> {
    const cachedSnapshot = this.getCachedReadySnapshot();
    if (cachedSnapshot) {
      return this.withOcrReadiness(cachedSnapshot);
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
      const snapshot = await this.withTimeout(
        buildPromise,
        this.readinessBuildTimeoutMs,
        'readiness build',
      );
      return this.withOcrReadiness(snapshot);
    } catch (error: unknown) {
      if (this.readyPromise === buildPromise) {
        this.readyPromise = null;
      }

      const staleSnapshot = this.getStaleReadySnapshot();
      if (staleSnapshot) {
        return this.withOcrReadiness(
          this.decorateStaleReadySnapshot(staleSnapshot, this.describeReadinessFallback(error)),
        );
      }

      const bestEffortSnapshot = await this.buildBestEffortReadySnapshot(
        this.describeReadinessFallback(error),
      );
      if (bestEffortSnapshot) {
        return this.withOcrReadiness(bestEffortSnapshot);
      }

      return this.withOcrReadiness(
        this.buildUnavailableReadySnapshot(this.describeReadinessFallback(error)),
      );
    }
  }

  private async withOcrReadiness(snapshot: ReadinessSnapshot): Promise<ReadinessSnapshot> {
    if (!this.ocrReadinessRequired) {
      return snapshot;
    }

    const ocr = await this.readOcrReadiness();
    return {
      ...snapshot,
      ok: snapshot.ok && ocr.ready,
      checks: {
        ...snapshot.checks,
        ocr,
      },
    };
  }

  private async readOcrReadiness(): Promise<OcrReadinessSnapshot> {
    if (!this.nativeTesseractOcr) {
      return unavailableOcrReadiness();
    }

    try {
      const status = this.nativeTesseractOcr.getRuntimeStatus();
      const rolloutMetrics = this.commercialOcrMetrics
        ? await this.withTimeout(
            this.commercialOcrMetrics.getSnapshot(),
            this.readinessOptionalDiagnosticsTimeoutMs,
            'commercial OCR metrics snapshot',
          ).catch(() => null)
        : null;
      const queueMetrics = this.queueMetricsService.peekCachedSnapshot?.(
        this.readinessStaleFallbackMaxAgeMs,
      );
      const bullMqQueue = queueMetrics?.auxiliaryQueues?.[COMMERCIAL_OCR_QUEUE];
      const ready = isOcrRuntimeReady(status);
      return {
        state: !ready && status.state === 'ready' ? 'degraded' : status.state,
        ready,
        workers: {
          configured: status.workers.configured,
          live: status.workers.live,
          ready: status.workers.ready,
          busy: status.workers.busy,
        },
        queueDepth: status.queueDepth,
        counters: {
          completed: status.counters.completed,
          failed: status.counters.failed,
          restarts: status.counters.restarts,
          recycles: status.counters.recycles,
          failuresByReason: { ...status.counters.failuresByReason },
        },
        latencyMs: {
          last: status.latencyMs.last,
          average: status.latencyMs.average,
          maximum: status.latencyMs.maximum,
        },
        behaviorIdentity: {
          fingerprintSha256: status.behaviorIdentity.fingerprintSha256,
          runtimeFingerprintSha256: status.behaviorIdentity.runtimeFingerprintSha256,
          buildManifestSha256: status.behaviorIdentity.buildManifestSha256,
          complete: status.behaviorIdentity.complete,
          required: status.behaviorIdentity.required,
          verified: status.behaviorIdentity.verified,
          state: status.behaviorIdentity.state,
          mismatchFields: [...status.behaviorIdentity.mismatchFields],
        },
        rolloutMetrics,
        queues: {
          bullMq: bullMqQueue ? { ...bullMqQueue } : null,
          native: {
            depth: status.queueDepth,
            busy: status.workers.busy,
            workers: status.workers.configured,
            waitMs: { ...(status.queueWaitMs ?? emptyNativeQueueWaitSnapshot()) },
          },
        },
      };
    } catch {
      return unavailableOcrReadiness();
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
      this.resolveDependencyHealth('database', () => this.checkDatabase(), 'database check'),
      this.resolveDependencyHealth('redis', () => this.checkRedis(), 'redis check'),
      this.withTimeout(
        this.systemModeService.getEffectiveSnapshot(),
        this.readinessDependencyTimeoutMs,
        'system mode snapshot',
      ),
      this.tryGetQueueMetricsSnapshot(),
    ]);
    const queueMetrics = queueMetricsResult.snapshot;
    const cachedQueueMetrics =
      queueMetrics ??
      this.queueMetricsService.peekCachedSnapshot?.(this.readinessStaleFallbackMaxAgeMs) ??
      null;
    const queueMetricsFallbackDetail = queueMetricsResult.fallbackDetail;
    if (queueMetrics) {
      void this.runtimeDiagnosticsService
        ?.recordQueueLagSnapshot({
          queues: queueMetrics,
          mode: systemMode,
        })
        .catch(() => undefined);
    }
    const maxApiBotSnapshots = await this.tryGetMaxApiBotSnapshots(
      Object.keys(cachedQueueMetrics?.bots ?? {}),
    );
    const runtimeDiagnostics = await this.tryGetRuntimeReadinessSnapshot();

    const effectiveLagSec =
      queueMetrics?.userFacingEffectiveLagSec ??
      queueMetrics?.effectiveLagSec ??
      systemMode.queueLagSec ??
      0;
    const oldestQueuedEventId =
      queueMetrics?.userFacingOldestQueuedEventId ?? queueMetrics?.oldestQueuedEventId ?? null;
    const oldestQueuedCreatedAt =
      queueMetrics?.userFacingOldestQueuedCreatedAt ?? queueMetrics?.oldestQueuedCreatedAt ?? null;
    const oldestQueuedLagSec =
      queueMetrics?.userFacingOldestQueuedLagSec ?? queueMetrics?.oldestQueuedLagSec ?? 0;
    const oldestReceivedEventId =
      queueMetrics?.userFacingOldestReceivedEventId ?? queueMetrics?.oldestReceivedEventId ?? null;
    const oldestReceivedCreatedAt =
      queueMetrics?.userFacingOldestReceivedCreatedAt ??
      queueMetrics?.oldestReceivedCreatedAt ??
      null;
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
      ...(runtimeDiagnostics ? { burst: runtimeDiagnostics.burst } : {}),
      bots: this.mapQueueMetricsBots(cachedQueueMetrics, maxApiBotSnapshots),
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
      const refreshedSnapshot =
        (await this.tryRefreshStaleQueueMetricsSnapshot(staleCachedSnapshot)) ?? null;
      if (refreshedSnapshot) {
        return {
          snapshot: refreshedSnapshot,
          fallbackDetail: null,
        };
      }

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

  private async tryRefreshStaleQueueMetricsSnapshot(
    staleCachedSnapshot: QueueMetricsSnapshot,
  ): Promise<QueueMetricsSnapshot | null> {
    const refreshPromise = this.refreshQueueMetricsSnapshotInBackground();
    if (!refreshPromise) {
      return null;
    }

    try {
      await this.withTimeout(
        refreshPromise,
        this.readinessOptionalDiagnosticsTimeoutMs,
        'queue metrics stale refresh',
      );
    } catch {
      return null;
    }

    const refreshedSnapshot =
      this.queueMetricsService.peekCachedSnapshot?.(this.queueSnapshotMaxAgeMs) ?? null;
    if (
      refreshedSnapshot &&
      this.isQueueMetricsSnapshotFresher(staleCachedSnapshot, refreshedSnapshot)
    ) {
      return refreshedSnapshot;
    }

    return null;
  }

  private isQueueMetricsSnapshotFresher(
    previousSnapshot: QueueMetricsSnapshot,
    nextSnapshot: QueueMetricsSnapshot,
  ): boolean {
    const previousGeneratedAtMs = Date.parse(previousSnapshot.generatedAt);
    const nextGeneratedAtMs = Date.parse(nextSnapshot.generatedAt);
    if (!Number.isFinite(previousGeneratedAtMs) || !Number.isFinite(nextGeneratedAtMs)) {
      return nextSnapshot.generatedAt !== previousSnapshot.generatedAt;
    }

    return nextGeneratedAtMs > previousGeneratedAtMs;
  }

  private refreshQueueMetricsSnapshotInBackground(): Promise<void> | null {
    const now = Date.now();
    if (this.backgroundQueueMetricsRefreshPromise) {
      return this.backgroundQueueMetricsRefreshPromise;
    }
    if (now - this.backgroundQueueMetricsRefreshStartedAtMs < this.queueSnapshotMaxAgeMs) {
      return null;
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
    return refreshPromise;
  }

  private updateQueueLagBreachState(rawQueueLagOk: boolean, evaluatedAtMs: number): number | null {
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
    const maxApiBotSnapshots = await this.tryGetMaxApiBotSnapshots(
      Object.keys(cachedQueueSnapshot?.bots ?? {}),
    );

    return {
      ok: database && redis && queueLagOk,
      timestamp: new Date().toISOString(),
      bots: Object.keys(cachedQueueSnapshot?.bots ?? {}).length
        ? this.mapQueueMetricsBots(cachedQueueSnapshot, maxApiBotSnapshots)
        : (this.readyCache?.bots ?? {}),
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

  private async tryGetMaxApiBotSnapshots(): Promise<null>;
  private async tryGetMaxApiBotSnapshots(
    botIds: readonly string[],
  ): Promise<Awaited<ReturnType<MaxApiMetricsService['getBotRateLimitSnapshot']>> | null>;
  private async tryGetMaxApiBotSnapshots(
    botIds: readonly string[] = [],
  ): Promise<Awaited<ReturnType<MaxApiMetricsService['getBotRateLimitSnapshot']>> | null> {
    const normalizedBotIds = [...new Set(botIds.map((botId) => botId.trim()).filter(Boolean))];
    if (!this.maxApiMetricsService || normalizedBotIds.length === 0) {
      return null;
    }

    try {
      return await this.withTimeout(
        this.maxApiMetricsService.getBotRateLimitSnapshot(normalizedBotIds, {
          windowSec: this.readinessMaxApiWindowSec,
        }),
        this.readinessOptionalDiagnosticsTimeoutMs,
        'max api readiness bot snapshot',
      );
    } catch {
      return null;
    }
  }

  private async tryGetRuntimeReadinessSnapshot(): Promise<Awaited<
    ReturnType<RuntimeDiagnosticsService['getReadinessSnapshot']>
  > | null> {
    if (!this.runtimeDiagnosticsService) {
      return null;
    }

    try {
      return await this.withTimeout(
        this.runtimeDiagnosticsService.getReadinessSnapshot(),
        this.readinessOptionalDiagnosticsTimeoutMs,
        'runtime readiness diagnostics snapshot',
      );
    } catch {
      return null;
    }
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

  private async resolveDependencyHealth(
    dependency: DependencyHealthKey,
    check: () => Promise<boolean>,
    label: string,
  ): Promise<boolean> {
    if (this.readFreshHealthyDependencyHealth(dependency)) {
      this.refreshDependencyHealthInBackground(dependency, check, label);
      return true;
    }

    const result = await this.withTimeout(check(), this.readinessDependencyTimeoutMs, label);
    this.recordDependencyHealth(dependency, result);
    return result;
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

  private readFreshHealthyDependencyHealth(dependency: DependencyHealthKey): boolean {
    const cached = this.dependencyHealth.get(dependency);
    if (!cached) {
      return false;
    }

    if (!cached.ok) {
      return false;
    }

    return Date.now() - cached.checkedAtMs <= this.readinessFreshHealthyDependencyMaxAgeMs;
  }

  private refreshDependencyHealthInBackground(
    dependency: DependencyHealthKey,
    check: () => Promise<boolean>,
    label: string,
  ): void {
    if (this.backgroundDependencyRefreshPromises.has(dependency)) {
      return;
    }

    const now = Date.now();
    const lastStartedAtMs = this.backgroundDependencyRefreshStartedAtMs.get(dependency) ?? 0;
    if (now - lastStartedAtMs < READINESS_CACHE_TTL_MS) {
      return;
    }

    this.backgroundDependencyRefreshStartedAtMs.set(dependency, now);
    const refreshPromise = this.withTimeout(check(), this.readinessDependencyTimeoutMs, label)
      .then((result) => {
        this.recordDependencyHealth(dependency, result);
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.backgroundDependencyRefreshPromises.get(dependency) === refreshPromise) {
          this.backgroundDependencyRefreshPromises.delete(dependency);
        }
      });
    this.backgroundDependencyRefreshPromises.set(dependency, refreshPromise);
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
