import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Optional } from '@nestjs/common';
import { WebhookStatus } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';

export type QueueCounters = {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
};

export type QueueMetricsSnapshot = {
  moderation: QueueCounters;
  actions: QueueCounters;
  oldestQueuedLagSec: number;
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
    @Optional() @InjectQueue('moderation') private readonly moderationQueue?: Queue,
    @Optional() @InjectQueue('moderation-actions') private readonly actionQueue?: Queue,
  ) {}

  async getSnapshot(): Promise<QueueMetricsSnapshot> {
    const [moderation, actions, oldestQueued, oldestReceived] = await Promise.all([
      this.readQueueCounters(this.moderationQueue),
      this.readQueueCounters(this.actionQueue),
      this.prisma.webhookEvent.findFirst({
        where: { status: WebhookStatus.QUEUED },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.prisma.webhookEvent.findFirst({
        where: { status: WebhookStatus.RECEIVED },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);

    const now = Date.now();
    const oldestQueuedLagSec = oldestQueued ? Math.max(0, (now - oldestQueued.createdAt.getTime()) / 1_000) : 0;
    const oldestReceivedLagSec = oldestReceived
      ? Math.max(0, (now - oldestReceived.createdAt.getTime()) / 1_000)
      : 0;
    const effectiveLagSec = Math.max(oldestQueuedLagSec, oldestReceivedLagSec);

    return {
      moderation,
      actions,
      oldestQueuedLagSec,
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
}
