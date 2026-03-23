import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Optional } from '@nestjs/common';
import { WebhookStatus } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  LEGACY_WEBHOOK_QUEUE,
  WEBHOOK_QUEUE_BACKGROUND,
  WEBHOOK_QUEUE_CRITICAL,
  WEBHOOK_QUEUE_DEFAULT,
} from '../webhook/webhook-queues';

export type QueueCounters = {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
};

export type QueueMetricsSnapshot = {
  moderation: QueueCounters;
  webhookCritical: QueueCounters;
  webhookDefault: QueueCounters;
  webhookBackground: QueueCounters;
  webhookLegacy: QueueCounters;
  actions: QueueCounters;
  oldestQueuedEventId: string | null;
  oldestQueuedCreatedAt: string | null;
  oldestQueuedLagSec: number;
  oldestReceivedEventId: string | null;
  oldestReceivedCreatedAt: string | null;
  oldestReceivedLagSec: number;
  effectiveLagSec: number;
  generatedAt: string;
};

const EMPTY_COUNTERS: QueueCounters = {
  waiting: 0,
  active: 0,
  delayed: 0,
  failed: 0,
  completed: 0,
};

@Injectable()
export class QueueMetricsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @InjectQueue(WEBHOOK_QUEUE_CRITICAL) private readonly webhookCriticalQueue?: Queue,
    @Optional() @InjectQueue(WEBHOOK_QUEUE_DEFAULT) private readonly webhookDefaultQueue?: Queue,
    @Optional()
    @InjectQueue(WEBHOOK_QUEUE_BACKGROUND)
    private readonly webhookBackgroundQueue?: Queue,
    @Optional() @InjectQueue(LEGACY_WEBHOOK_QUEUE) private readonly webhookLegacyQueue?: Queue,
    @Optional() @InjectQueue('moderation-actions') private readonly actionQueue?: Queue,
  ) {}

  async getSnapshot(): Promise<QueueMetricsSnapshot> {
    const [webhookCritical, webhookDefault, webhookBackground, webhookLegacy, actions, oldestQueued, oldestReceived] = await Promise.all([
      this.readQueueCounters(this.webhookCriticalQueue),
      this.readQueueCounters(this.webhookDefaultQueue),
      this.readQueueCounters(this.webhookBackgroundQueue),
      this.readQueueCounters(this.webhookLegacyQueue),
      this.readQueueCounters(this.actionQueue),
      this.prisma.webhookEvent.findFirst({
        where: { status: WebhookStatus.QUEUED },
        orderBy: { createdAt: 'asc' },
        select: { id: true, createdAt: true },
      }),
      this.prisma.webhookEvent.findFirst({
        where: { status: WebhookStatus.RECEIVED },
        orderBy: { createdAt: 'asc' },
        select: { id: true, createdAt: true },
      }),
    ]);

    const now = Date.now();
    const oldestQueuedLagSec = oldestQueued ? Math.max(0, (now - oldestQueued.createdAt.getTime()) / 1_000) : 0;
    const oldestReceivedLagSec = oldestReceived
      ? Math.max(0, (now - oldestReceived.createdAt.getTime()) / 1_000)
      : 0;
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
      oldestQueuedEventId: oldestQueued?.id ?? null,
      oldestQueuedCreatedAt: oldestQueued ? oldestQueued.createdAt.toISOString() : null,
      oldestQueuedLagSec,
      oldestReceivedEventId: oldestReceived?.id ?? null,
      oldestReceivedCreatedAt: oldestReceived ? oldestReceived.createdAt.toISOString() : null,
      oldestReceivedLagSec,
      effectiveLagSec,
      generatedAt: new Date(now).toISOString(),
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
}
