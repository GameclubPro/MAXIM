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
      thresholdSec: number;
      effectiveLagSec: number;
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
const READINESS_QUEUE_SNAPSHOT_MAX_AGE_MS = 5_000;

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly queueLagThresholdSec: number;
  private readyCache: ReadinessSnapshot | null = null;
  private readyCacheAtMs = 0;
  private readyPromise: Promise<ReadinessSnapshot> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueMetricsService: QueueMetricsService,
    private readonly systemModeService: SystemModeService,
    configService: ConfigService,
  ) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.queueLagThresholdSec = configService.get<number>('QUEUE_LAG_DEGRADE_SEC', 10);
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
      this.queueMetricsService.getSnapshot({ maxAgeMs: READINESS_QUEUE_SNAPSHOT_MAX_AGE_MS }),
      this.systemModeService.getEffectiveSnapshot(),
    ]);

    const queueLagOk = queueMetrics.effectiveLagSec <= this.queueLagThresholdSec;

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
          thresholdSec: this.queueLagThresholdSec,
          effectiveLagSec: queueMetrics.effectiveLagSec,
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
