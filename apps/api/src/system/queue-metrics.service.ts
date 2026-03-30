import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Optional } from '@nestjs/common';
import { WebhookStatus } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { ActionHealthService, type ActionHealthSnapshot } from './action-health.service';
import {
  LEGACY_WEBHOOK_QUEUE,
  WEBHOOK_QUEUE_BACKGROUND,
  WEBHOOK_QUEUE_CRITICAL,
  WEBHOOK_QUEUE_DEFAULT_SHARD_0,
  WEBHOOK_QUEUE_DEFAULT_SHARD_1,
  WEBHOOK_QUEUE_DEFAULT_SHARD_2,
  WEBHOOK_QUEUE_DEFAULT_SHARD_3,
} from '../webhook/webhook-queues';

export type QueueCounters = {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
};

export type WebhookStatusMetrics = {
  count: number;
  oldestEventId: string | null;
  oldestCreatedAt: string | null;
  oldestLagSec: number;
};

export type QueueMetricsSnapshot = {
  moderation: QueueCounters;
  webhookCritical: QueueCounters;
  webhookDefault: QueueCounters;
  webhookBackground: QueueCounters;
  webhookLegacy: QueueCounters;
  actions: QueueCounters;
  webhookEvents: {
    received: WebhookStatusMetrics;
    queued: WebhookStatusMetrics;
    failed: WebhookStatusMetrics;
  };
  actionHealth: ActionHealthSnapshot;
  oldestQueuedEventId: string | null;
  oldestQueuedCreatedAt: string | null;
  oldestQueuedLagSec: number;
  oldestReceivedEventId: string | null;
  oldestReceivedCreatedAt: string | null;
  oldestReceivedLagSec: number;
  effectiveLagSec: number;
  generatedAt: string;
};

type QueueMetricsSnapshotOptions = {
  maxAgeMs?: number;
};

const EMPTY_COUNTERS: QueueCounters = {
  waiting: 0,
  active: 0,
  delayed: 0,
  failed: 0,
  completed: 0,
};

const EMPTY_WEBHOOK_STATUS_METRICS: WebhookStatusMetrics = {
  count: 0,
  oldestEventId: null,
  oldestCreatedAt: null,
  oldestLagSec: 0,
};

@Injectable()
export class QueueMetricsService {
  private snapshotCache: QueueMetricsSnapshot | null = null;
  private snapshotCacheAtMs = 0;
  private snapshotPromise: Promise<QueueMetricsSnapshot> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly actionHealthService: ActionHealthService,
    @Optional() @InjectQueue(WEBHOOK_QUEUE_CRITICAL) private readonly webhookCriticalQueue?: Queue,
    @Optional() @InjectQueue(WEBHOOK_QUEUE_DEFAULT_SHARD_0)
    private readonly webhookDefaultShard0Queue?: Queue,
    @Optional() @InjectQueue(WEBHOOK_QUEUE_DEFAULT_SHARD_1)
    private readonly webhookDefaultShard1Queue?: Queue,
    @Optional() @InjectQueue(WEBHOOK_QUEUE_DEFAULT_SHARD_2)
    private readonly webhookDefaultShard2Queue?: Queue,
    @Optional() @InjectQueue(WEBHOOK_QUEUE_DEFAULT_SHARD_3)
    private readonly webhookDefaultShard3Queue?: Queue,
    @Optional()
    @InjectQueue(WEBHOOK_QUEUE_BACKGROUND)
    private readonly webhookBackgroundQueue?: Queue,
    @Optional() @InjectQueue(LEGACY_WEBHOOK_QUEUE) private readonly webhookLegacyQueue?: Queue,
    @Optional() @InjectQueue('moderation-actions') private readonly actionQueue?: Queue,
  ) {}

  async getSnapshot(options: QueueMetricsSnapshotOptions = {}): Promise<QueueMetricsSnapshot> {
    const maxAgeMs = options.maxAgeMs ?? 0;
    const cachedSnapshot = this.getCachedSnapshot(maxAgeMs);
    if (cachedSnapshot) {
      return cachedSnapshot;
    }

    if (this.snapshotPromise) {
      return this.snapshotPromise;
    }

    this.snapshotPromise = this.buildSnapshot();

    try {
      const snapshot = await this.snapshotPromise;
      this.snapshotCache = snapshot;
      this.snapshotCacheAtMs = Date.now();
      return snapshot;
    } finally {
      this.snapshotPromise = null;
    }
  }

  private getCachedSnapshot(maxAgeMs: number): QueueMetricsSnapshot | null {
    if (!this.snapshotCache || maxAgeMs <= 0) {
      return null;
    }

    if (Date.now() - this.snapshotCacheAtMs > maxAgeMs) {
      return null;
    }

    return this.snapshotCache;
  }

  private async buildSnapshot(): Promise<QueueMetricsSnapshot> {
    const queueSnapshots = await Promise.all([
      this.readQueueCounters(this.webhookCriticalQueue),
      ...this.getDefaultWebhookQueues().map((queue) => this.readQueueCounters(queue)),
      this.readQueueCounters(this.webhookBackgroundQueue),
      this.readQueueCounters(this.webhookLegacyQueue),
      this.readQueueCounters(this.actionQueue),
    ]);
    const [received, queued, failed] = await Promise.all([
      this.readWebhookStatusMetrics(WebhookStatus.RECEIVED),
      this.readWebhookStatusMetrics(WebhookStatus.QUEUED),
      this.readWebhookStatusMetrics(WebhookStatus.FAILED),
    ]);

    const [
      webhookCritical,
      webhookDefaultShard0,
      webhookDefaultShard1,
      webhookDefaultShard2,
      webhookDefaultShard3,
      webhookBackground,
      webhookLegacy,
      actions,
    ] = queueSnapshots;
    const webhookDefault = this.sumQueueCounters(
      webhookDefaultShard0,
      webhookDefaultShard1,
      webhookDefaultShard2,
      webhookDefaultShard3,
    );

    const actionHealth = this.actionHealthService.getSnapshot(60);
    const oldestQueuedLagSec = queued.oldestLagSec;
    const oldestReceivedLagSec = received.oldestLagSec;
    const effectiveLagSec = Math.max(oldestQueuedLagSec, oldestReceivedLagSec);
    const moderation = this.sumQueueCounters(
      webhookCritical,
      webhookDefault,
      webhookBackground,
      webhookLegacy,
    );

    return {
      moderation,
      webhookCritical,
      webhookDefault,
      webhookBackground,
      webhookLegacy,
      actions,
      webhookEvents: {
        received,
        queued,
        failed,
      },
      actionHealth,
      oldestQueuedEventId: queued.oldestEventId,
      oldestQueuedCreatedAt: queued.oldestCreatedAt,
      oldestQueuedLagSec,
      oldestReceivedEventId: received.oldestEventId,
      oldestReceivedCreatedAt: received.oldestCreatedAt,
      oldestReceivedLagSec,
      effectiveLagSec,
      generatedAt: new Date().toISOString(),
    };
  }

  private getDefaultWebhookQueues(): Array<Queue | undefined> {
    return [
      this.webhookDefaultShard0Queue,
      this.webhookDefaultShard1Queue,
      this.webhookDefaultShard2Queue,
      this.webhookDefaultShard3Queue,
    ];
  }

  private async readQueueCounters(queue?: Queue): Promise<QueueCounters> {
    if (!queue) {
      return EMPTY_COUNTERS;
    }

    const [waiting, active, delayed, failed, completed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getDelayedCount(),
      queue.getFailedCount(),
      queue.getCompletedCount(),
    ]);

    return { waiting, active, delayed, failed, completed };
  }

  private sumQueueCounters(...counters: QueueCounters[]): QueueCounters {
    return counters.reduce<QueueCounters>(
      (total, current) => ({
        waiting: total.waiting + current.waiting,
        active: total.active + current.active,
        delayed: total.delayed + current.delayed,
        failed: total.failed + current.failed,
        completed: total.completed + current.completed,
      }),
      { ...EMPTY_COUNTERS },
    );
  }

  private async readWebhookStatusMetrics(status: WebhookStatus): Promise<WebhookStatusMetrics> {
    const [count, oldestEvent] = await Promise.all([
      this.prisma.webhookEvent.count({
        where: { status },
      }),
      this.prisma.webhookEvent.findFirst({
        where: { status },
        orderBy: { createdAt: 'asc' },
        select: { id: true, createdAt: true },
      }),
    ]);

    if (!oldestEvent) {
      return {
        ...EMPTY_WEBHOOK_STATUS_METRICS,
        count,
      };
    }

    const oldestLagSec = Math.max(0, (Date.now() - oldestEvent.createdAt.getTime()) / 1_000);
    return {
      count,
      oldestEventId: oldestEvent.id,
      oldestCreatedAt: oldestEvent.createdAt.toISOString(),
      oldestLagSec,
    };
  }
}
