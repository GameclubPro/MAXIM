import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Optional } from '@nestjs/common';
import { WebhookStatus } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_WEBHOOK_WORKER_GROUP_NAMES,
  getDefaultWebhookWorkerGroupQueues,
  type DefaultWebhookWorkerGroupName,
} from '../runtime/moderation-runtime';
import { ActionHealthService, type ActionHealthSnapshot } from './action-health.service';
import {
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  type DefaultWebhookQueueName,
  LEGACY_WEBHOOK_QUEUE,
  WEBHOOK_QUEUE_BACKGROUND,
  WEBHOOK_QUEUE_CRITICAL,
  WEBHOOK_QUEUE_DEFAULT_SHARD_0,
  WEBHOOK_QUEUE_DEFAULT_SHARD_1,
  WEBHOOK_QUEUE_DEFAULT_SHARD_2,
  WEBHOOK_QUEUE_DEFAULT_SHARD_3,
  WEBHOOK_QUEUE_DEFAULT_SHARD_4,
  WEBHOOK_QUEUE_DEFAULT_SHARD_5,
  WEBHOOK_QUEUE_DEFAULT_SHARD_6,
  WEBHOOK_QUEUE_DEFAULT_SHARD_7,
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

export type WebhookDefaultWorkerGroupMetrics = {
  queues: DefaultWebhookQueueName[];
  counters: QueueCounters;
};

export type QueueMetricsSnapshot = {
  moderation: QueueCounters;
  webhookCritical: QueueCounters;
  webhookDefault: QueueCounters;
  webhookDefaultShards: Record<DefaultWebhookQueueName, QueueCounters>;
  webhookDefaultWorkerGroups: Record<
    DefaultWebhookWorkerGroupName,
    WebhookDefaultWorkerGroupMetrics
  >;
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
  private readonly webhookDefaultQueuesByName: Record<DefaultWebhookQueueName, Queue | undefined>;

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
    @Optional() @InjectQueue(WEBHOOK_QUEUE_DEFAULT_SHARD_4)
    private readonly webhookDefaultShard4Queue?: Queue,
    @Optional() @InjectQueue(WEBHOOK_QUEUE_DEFAULT_SHARD_5)
    private readonly webhookDefaultShard5Queue?: Queue,
    @Optional() @InjectQueue(WEBHOOK_QUEUE_DEFAULT_SHARD_6)
    private readonly webhookDefaultShard6Queue?: Queue,
    @Optional() @InjectQueue(WEBHOOK_QUEUE_DEFAULT_SHARD_7)
    private readonly webhookDefaultShard7Queue?: Queue,
    @Optional()
    @InjectQueue(WEBHOOK_QUEUE_BACKGROUND)
    private readonly webhookBackgroundQueue?: Queue,
    @Optional() @InjectQueue(LEGACY_WEBHOOK_QUEUE) private readonly webhookLegacyQueue?: Queue,
    @Optional() @InjectQueue('moderation-actions') private readonly actionQueue?: Queue,
  ) {
    this.webhookDefaultQueuesByName = {
      [WEBHOOK_QUEUE_DEFAULT_SHARD_0]: this.webhookDefaultShard0Queue,
      [WEBHOOK_QUEUE_DEFAULT_SHARD_1]: this.webhookDefaultShard1Queue,
      [WEBHOOK_QUEUE_DEFAULT_SHARD_2]: this.webhookDefaultShard2Queue,
      [WEBHOOK_QUEUE_DEFAULT_SHARD_3]: this.webhookDefaultShard3Queue,
      [WEBHOOK_QUEUE_DEFAULT_SHARD_4]: this.webhookDefaultShard4Queue,
      [WEBHOOK_QUEUE_DEFAULT_SHARD_5]: this.webhookDefaultShard5Queue,
      [WEBHOOK_QUEUE_DEFAULT_SHARD_6]: this.webhookDefaultShard6Queue,
      [WEBHOOK_QUEUE_DEFAULT_SHARD_7]: this.webhookDefaultShard7Queue,
    };
  }

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
      ...DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName) =>
        this.readQueueCounters(this.webhookDefaultQueuesByName[queueName]),
      ),
      this.readQueueCounters(this.webhookBackgroundQueue),
      this.readQueueCounters(this.webhookLegacyQueue),
      this.readQueueCounters(this.actionQueue),
    ]);
    const [received, queued, failed] = await Promise.all([
      this.readWebhookStatusMetrics(WebhookStatus.RECEIVED),
      this.readWebhookStatusMetrics(WebhookStatus.QUEUED),
      this.readWebhookStatusMetrics(WebhookStatus.FAILED),
    ]);

    const [webhookCritical, ...restSnapshots] = queueSnapshots;
    const webhookBackground = restSnapshots[DEFAULT_WEBHOOK_QUEUE_NAMES.length] ?? EMPTY_COUNTERS;
    const webhookLegacy = restSnapshots[DEFAULT_WEBHOOK_QUEUE_NAMES.length + 1] ?? EMPTY_COUNTERS;
    const actions = restSnapshots[DEFAULT_WEBHOOK_QUEUE_NAMES.length + 2] ?? EMPTY_COUNTERS;
    const webhookDefaultShardSnapshots = restSnapshots.slice(0, DEFAULT_WEBHOOK_QUEUE_NAMES.length);
    const webhookDefaultShards = Object.fromEntries(
      DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName, index) => [
        queueName,
        webhookDefaultShardSnapshots[index] ?? { ...EMPTY_COUNTERS },
      ]),
    ) as Record<DefaultWebhookQueueName, QueueCounters>;
    const webhookDefault = this.sumQueueCounters(...Object.values(webhookDefaultShards));
    const webhookDefaultWorkerGroups = this.buildWebhookDefaultWorkerGroups(webhookDefaultShards);

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
      webhookDefaultShards,
      webhookDefaultWorkerGroups,
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

  private buildWebhookDefaultWorkerGroups(
    webhookDefaultShards: Record<DefaultWebhookQueueName, QueueCounters>,
  ): Record<DefaultWebhookWorkerGroupName, WebhookDefaultWorkerGroupMetrics> {
    const workerGroupQueues = getDefaultWebhookWorkerGroupQueues();

    return Object.fromEntries(
      DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.map((groupName) => {
        const queues = [...workerGroupQueues[groupName]];
        return [
          groupName,
          {
            queues,
            counters: this.sumQueueCounters(
              ...queues.map((queueName) => webhookDefaultShards[queueName] ?? { ...EMPTY_COUNTERS }),
            ),
          },
        ];
      }),
    ) as Record<DefaultWebhookWorkerGroupName, WebhookDefaultWorkerGroupMetrics>;
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
