import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { QueueMetricsService } from '../system/queue-metrics.service';
import { SystemModeService, type SystemModeSnapshot } from '../system/system-mode.service';

export type ReadinessSnapshot = {
  ok: boolean;
  timestamp: string;
  systemMode: SystemModeSnapshot & {
    degraded: boolean;
  };
  checks: {
    database: boolean;
    redis: boolean;
    queueLag: {
      ok: boolean;
      rawOk: boolean;
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

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly queueLagThresholdSec: number;
  private readonly queueLagSustainSec: number;
  private readonly queueLagSevereSec: number;
  private readonly queueSnapshotMaxAgeMs: number;
  private readyCache: ReadinessSnapshot | null = null;
  private readyCacheAtMs = 0;
  private readyPromise: Promise<ReadinessSnapshot> | null = null;
  private queueLagBreachStartedAtMs: number | null = null;

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

  async ready(): Promise<ReadinessSnapshot> {
    const cachedSnapshot = this.getCachedReadySnapshot();
    if (cachedSnapshot) {
      return cachedSnapshot;
    }

    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = this.buildReadySnapshot();

    try {
      const snapshot = await this.readyPromise;
      this.readyCache = snapshot;
      this.readyCacheAtMs = Date.now();
      return snapshot;
    } finally {
      this.readyPromise = null;
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
    const [database, redis, queueMetrics, systemMode] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.queueMetricsService.getSnapshot({ maxAgeMs: this.queueSnapshotMaxAgeMs }),
      this.systemModeService.getEffectiveSnapshot(),
    ]);

    const evaluatedAtMs = Date.now();
    const rawQueueLagOk = queueMetrics.effectiveLagSec <= this.queueLagThresholdSec;
    const severeQueueLag = queueMetrics.effectiveLagSec > this.queueLagSevereSec;
    const breachStartedAtMs = this.updateQueueLagBreachState(rawQueueLagOk, evaluatedAtMs);
    const breachDurationSec = breachStartedAtMs
      ? Math.max(0, (evaluatedAtMs - breachStartedAtMs) / 1_000)
      : 0;
    const queueLagOk =
      !severeQueueLag && (rawQueueLagOk || breachDurationSec < this.queueLagSustainSec);

    return {
      ok: database && redis && queueLagOk,
      timestamp: new Date().toISOString(),
      systemMode: {
        ...systemMode,
        queueLagSec: queueMetrics.effectiveLagSec,
        action: queueMetrics.actionHealth,
        degraded: systemMode.mode === 'degrade',
      },
      checks: {
        database,
        redis,
        queueLag: {
          ok: queueLagOk,
          rawOk: rawQueueLagOk,
          thresholdSec: this.queueLagThresholdSec,
          sustainSec: this.queueLagSustainSec,
          severeThresholdSec: this.queueLagSevereSec,
          effectiveLagSec: queueMetrics.effectiveLagSec,
          sampleGeneratedAt: queueMetrics.generatedAt,
          breachStartedAt: breachStartedAtMs ? new Date(breachStartedAtMs).toISOString() : null,
          breachDurationSec,
          oldestQueuedEventId: queueMetrics.oldestQueuedEventId,
          oldestQueuedCreatedAt: queueMetrics.oldestQueuedCreatedAt,
          oldestQueuedLagSec: queueMetrics.oldestQueuedLagSec,
          oldestReceivedEventId: queueMetrics.oldestReceivedEventId,
          oldestReceivedCreatedAt: queueMetrics.oldestReceivedCreatedAt,
          oldestReceivedLagSec: queueMetrics.oldestReceivedLagSec,
        },
      },
    };
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
}
