import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookStatus } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsEnqueue } from '../runtime/app-role';

type ProcessWebhookJob = {
  webhookEventId: string;
};

@Injectable()
export class WebhookOutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookOutboxService.name);
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly webhookRetentionDays: number;
  private readonly moderationRetentionDays: number;

  private poller: NodeJS.Timeout | null = null;
  private cleaner: NodeJS.Timeout | null = null;
  private draining = false;
  private cleaning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @InjectQueue('moderation') private readonly queue: Queue<ProcessWebhookJob>,
  ) {
    this.enabled = roleRunsEnqueue(getAppRole());
    this.pollIntervalMs = this.configService.get<number>('ENQUEUE_POLL_INTERVAL_MS', 500);
    this.batchSize = this.configService.get<number>('ENQUEUE_BATCH_SIZE', 200);
    this.webhookRetentionDays = this.configService.get<number>('WEBHOOK_RETENTION_DAYS', 7);
    this.moderationRetentionDays = this.configService.get<number>('MODERATION_RETENTION_DAYS', 90);
  }

  onModuleInit() {
    if (!this.enabled) {
      return;
    }

    this.poller = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.poller.unref();

    this.cleaner = setInterval(() => {
      void this.cleanupRetention();
    }, 60 * 60 * 1_000);
    this.cleaner.unref();

    void this.tick();
  }

  onModuleDestroy() {
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
    if (this.cleaner) {
      clearInterval(this.cleaner);
      this.cleaner = null;
    }
  }

  private async tick() {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      await this.enqueueBatch();
    } finally {
      this.draining = false;
    }
  }

  private async enqueueBatch() {
    const now = new Date();
    const staleQueuedBefore = new Date(now.getTime() - 120_000);
    const candidates = await this.prisma.webhookEvent.findMany({
      where: {
        OR: [
          {
            status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED] },
            OR: [{ nextEnqueueAt: null }, { nextEnqueueAt: { lte: now } }],
          },
          {
            status: WebhookStatus.QUEUED,
            queuedAt: { lte: staleQueuedBefore },
            processedAt: null,
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: this.batchSize,
      select: { id: true, enqueueAttempts: true },
    });

    for (const event of candidates) {
      await this.enqueueOne(event.id, event.enqueueAttempts);
    }
  }

  private async enqueueOne(webhookEventId: string, enqueueAttempts: number) {
    try {
      await this.queue.add(
        'process-webhook-event',
        { webhookEventId },
        {
          jobId: webhookEventId,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: false,
        },
      );

      await this.prisma.webhookEvent.updateMany({
        where: {
          id: webhookEventId,
          status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED, WebhookStatus.QUEUED] },
        },
        data: {
          status: WebhookStatus.QUEUED,
          queuedAt: new Date(),
          nextEnqueueAt: null,
          errorMessage: null,
          enqueueAttempts: {
            increment: 1,
          },
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const alreadyExists = message.toLowerCase().includes('already exists');
      if (alreadyExists) {
        await this.prisma.webhookEvent.updateMany({
          where: {
            id: webhookEventId,
            status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED, WebhookStatus.QUEUED] },
          },
          data: {
            status: WebhookStatus.QUEUED,
            queuedAt: new Date(),
            nextEnqueueAt: null,
            errorMessage: null,
            enqueueAttempts: {
              increment: 1,
            },
          },
        });
        return;
      }

      const nextDelaySec = Math.min(300, 2 ** Math.min(enqueueAttempts + 1, 8));
      await this.prisma.webhookEvent.updateMany({
        where: {
          id: webhookEventId,
          status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED, WebhookStatus.QUEUED] },
        },
        data: {
          status: WebhookStatus.FAILED,
          errorMessage: message.slice(0, 500),
          nextEnqueueAt: new Date(Date.now() + nextDelaySec * 1_000),
          enqueueAttempts: {
            increment: 1,
          },
        },
      });
    }
  }

  private async cleanupRetention() {
    if (this.cleaning) {
      return;
    }
    this.cleaning = true;
    try {
      const webhookCutoff = new Date(Date.now() - this.webhookRetentionDays * 24 * 60 * 60 * 1_000);
      const moderationCutoff = new Date(
        Date.now() - this.moderationRetentionDays * 24 * 60 * 60 * 1_000,
      );
      const [webhookDeleted, moderationDeleted, violationsDeleted] = await Promise.all([
        this.prisma.webhookEvent.deleteMany({
          where: {
            createdAt: { lt: webhookCutoff },
            status: { in: [WebhookStatus.PROCESSED, WebhookStatus.DUPLICATE, WebhookStatus.FAILED] },
          },
        }),
        this.prisma.moderationEvent.deleteMany({
          where: { createdAt: { lt: moderationCutoff } },
        }),
        this.prisma.violation.deleteMany({
          where: { createdAt: { lt: moderationCutoff } },
        }),
      ]);

      this.logger.log(
        {
          webhookEvents: webhookDeleted.count,
          moderationEvents: moderationDeleted.count,
          violations: violationsDeleted.count,
          webhookRetentionDays: this.webhookRetentionDays,
          moderationRetentionDays: this.moderationRetentionDays,
        },
        'Retention cleanup finished',
      );
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Retention cleanup failed',
      );
    } finally {
      this.cleaning = false;
    }
  }
}
