import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { QueueMetricsService } from '../system/queue-metrics.service';

export type ReadinessSnapshot = {
  ok: boolean;
  timestamp: string;
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

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly queueLagThresholdSec: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueMetricsService: QueueMetricsService,
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
    const now = new Date().toISOString();
    let database = false;
    let redis = false;

    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
      database = true;
    } catch {
      database = false;
    }

    try {
      const pong = await this.redis.ping();
      redis = pong.toUpperCase() === 'PONG';
    } catch {
      redis = false;
    }

    const queueMetrics = await this.queueMetricsService.getSnapshot();
    const queueLagOk = queueMetrics.effectiveLagSec <= this.queueLagThresholdSec;

    return {
      ok: database && redis && queueLagOk,
      timestamp: now,
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
}
