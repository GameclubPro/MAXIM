import { InjectQueue, getQueueToken } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { WebhookStatus } from '@prisma/client';
import type { Job, Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsEnqueue } from '../runtime/app-role';
import {
  ALL_WEBHOOK_QUEUE_NAMES,
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  type DefaultWebhookQueueName,
  LEGACY_WEBHOOK_QUEUE,
  type AnyWebhookQueueName,
  type ProcessWebhookJob,
  resolveWebhookJobPriority,
  WEBHOOK_QUEUE_BACKGROUND,
  WEBHOOK_QUEUE_CRITICAL,
} from './webhook-queues';
import { WebhookRoutingService } from './webhook-routing.service';

const ANY_WEBHOOK_QUEUE_NAMES = new Set<string>(ALL_WEBHOOK_QUEUE_NAMES);

type WebhookEnqueueCandidate = {
  id: string;
  status: WebhookStatus;
  botId: string | null;
  queueName: string | null;
  enqueueAttempts: number;
  createdAt: Date;
  queuedAt: Date | null;
  normalizedPayload: unknown;
};

@Injectable()
export class WebhookOutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookOutboxService.name);
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly enqueueConcurrency: number;
  private readonly maxEnqueueAttempts: number;
  private readonly webhookRetentionDays: number;
  private readonly moderationRetentionDays: number;

  private poller: NodeJS.Timeout | null = null;
  private cleaner: NodeJS.Timeout | null = null;
  private draining = false;
  private cleaning = false;
  private readonly queuesByName: Record<AnyWebhookQueueName, Queue<ProcessWebhookJob>>;
  private readonly defaultShardQueuesByName: Record<
    DefaultWebhookQueueName,
    Queue<ProcessWebhookJob>
  >;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly moduleRef: ModuleRef,
    private readonly webhookRoutingService: WebhookRoutingService,
    @InjectQueue(WEBHOOK_QUEUE_CRITICAL)
    private readonly criticalQueue: Queue<ProcessWebhookJob>,
    @InjectQueue(WEBHOOK_QUEUE_BACKGROUND)
    private readonly backgroundQueue: Queue<ProcessWebhookJob>,
    @InjectQueue(LEGACY_WEBHOOK_QUEUE)
    private readonly legacyQueue: Queue<ProcessWebhookJob>,
  ) {
    this.enabled = roleRunsEnqueue(getAppRole());
    this.pollIntervalMs = this.configService.get<number>('ENQUEUE_POLL_INTERVAL_MS', 500);
    this.batchSize = this.configService.get<number>('ENQUEUE_BATCH_SIZE', 200);
    this.enqueueConcurrency = this.configService.get<number>('ENQUEUE_CONCURRENCY', 25);
    this.maxEnqueueAttempts = this.configService.get<number>('ENQUEUE_MAX_ATTEMPTS', 120);
    this.webhookRetentionDays = this.configService.get<number>('WEBHOOK_RETENTION_DAYS', 7);
    this.moderationRetentionDays = this.configService.get<number>('MODERATION_RETENTION_DAYS', 90);
    this.defaultShardQueuesByName = Object.fromEntries(
      DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName) => [queueName, this.resolveDefaultShardQueue(queueName)]),
    ) as Record<DefaultWebhookQueueName, Queue<ProcessWebhookJob>>;
    this.queuesByName = {
      [WEBHOOK_QUEUE_CRITICAL]: this.criticalQueue,
      ...this.defaultShardQueuesByName,
      [WEBHOOK_QUEUE_BACKGROUND]: this.backgroundQueue,
      [LEGACY_WEBHOOK_QUEUE]: this.legacyQueue,
    };
  }

  private resolveDefaultShardQueue(
    queueName: DefaultWebhookQueueName,
  ): Queue<ProcessWebhookJob> {
    try {
      return this.moduleRef.get<Queue<ProcessWebhookJob>>(getQueueToken(queueName), {
        strict: false,
      });
    } catch (error: unknown) {
      throw new Error(
        `Missing BullMQ queue provider for ${queueName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to enqueue webhook batch',
      );
    } finally {
      this.draining = false;
    }
  }

  private async enqueueBatch() {
    const now = new Date();
    const staleQueuedBefore = new Date(now.getTime() - 120_000);
    const candidates: WebhookEnqueueCandidate[] = await this.prisma.webhookEvent.findMany({
      where: {
        OR: [
          {
            status: WebhookStatus.RECEIVED,
            OR: [{ nextEnqueueAt: null }, { nextEnqueueAt: { lte: now } }],
          },
          {
            status: WebhookStatus.FAILED,
            nextEnqueueAt: { lte: now },
          },
          {
            status: WebhookStatus.QUEUED,
            OR: [{ queuedAt: { lte: staleQueuedBefore } }, { createdAt: { lte: staleQueuedBefore } }],
            processedAt: null,
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: this.batchSize,
      select: {
        id: true,
        status: true,
        botId: true,
        queueName: true,
        enqueueAttempts: true,
        createdAt: true,
        queuedAt: true,
        normalizedPayload: true,
      },
    });

    const prioritizedCandidates = [...candidates].sort((left, right) => {
      const priorityDiff =
        resolveWebhookJobPriority(left.normalizedPayload) -
        resolveWebhookJobPriority(right.normalizedPayload);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }

      return left.createdAt.getTime() - right.createdAt.getTime();
    });

    await this.enqueueCandidates(prioritizedCandidates);
  }

  private async enqueueCandidates(candidates: WebhookEnqueueCandidate[]) {
    if (candidates.length === 0) {
      return;
    }

    const workerCount = Math.max(1, Math.min(this.enqueueConcurrency, candidates.length));
    let nextIndex = 0;

    const runWorker = async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        const event = candidates[currentIndex];
        if (!event) {
          return;
        }

        const queueName = await this.webhookRoutingService.resolveQueueName(
          event.id,
          event.normalizedPayload,
          { botId: event.botId },
        );
        const targetQueueName =
          event.status === WebhookStatus.QUEUED &&
          typeof event.queueName === 'string' &&
          ANY_WEBHOOK_QUEUE_NAMES.has(event.queueName)
            ? (event.queueName as AnyWebhookQueueName)
            : queueName;
        await this.enqueueOne(
          event,
          resolveWebhookJobPriority(event.normalizedPayload),
          targetQueueName,
        );
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  }

  private async enqueueOne(
    event: WebhookEnqueueCandidate,
    priority: number,
    queueName: AnyWebhookQueueName,
  ) {
    const { id: webhookEventId, enqueueAttempts } = event;
    if (enqueueAttempts >= this.maxEnqueueAttempts) {
      await this.markExhausted(webhookEventId, enqueueAttempts);
      return;
    }

    const existingJob = await this.findExistingJob(webhookEventId, queueName);
    if (existingJob) {
      await this.handleExistingJob(event, existingJob.job);
      return;
    }

    try {
      if (event.status === WebhookStatus.QUEUED) {
        this.logger.warn(
          {
            webhookEventId,
            storedQueueName: event.queueName,
            preferredQueueName: queueName,
            queuedAt: event.queuedAt?.toISOString() ?? null,
            ageSec: Math.max(0, (Date.now() - event.createdAt.getTime()) / 1_000),
          },
          'Repairing stale queued webhook event without a live BullMQ job',
        );
      }
      await this.queuesByName[queueName].add(
        'process-webhook-event',
        { webhookEventId },
        {
          jobId: webhookEventId,
          priority,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: false,
        },
      );

      await this.markQueued(webhookEventId, true, true, queueName);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isAlreadyExistsError(message)) {
        await this.handleAlreadyExists(event, queueName);
        return;
      }

      await this.markFailedWithBackoff(webhookEventId, enqueueAttempts, message);
    }
  }

  private async handleAlreadyExists(
    event: WebhookEnqueueCandidate,
    queueName: AnyWebhookQueueName,
  ) {
    const { id: webhookEventId, enqueueAttempts } = event;
    const existingJob = await this.findExistingJob(webhookEventId, queueName);
    if (!existingJob) {
      await this.markFailedWithBackoff(
        webhookEventId,
        enqueueAttempts,
        'Moderation job already exists but cannot be loaded',
      );
      return;
    }

    await this.handleExistingJob(event, existingJob.job);
  }

  private async handleExistingJob(
    event: WebhookEnqueueCandidate,
    job: Job<ProcessWebhookJob>,
  ) {
    const { id: webhookEventId, enqueueAttempts } = event;
    const state = await job.getState();
    if (state === 'failed') {
      await this.retryFailedJob(webhookEventId, enqueueAttempts, job);
      return;
    }

    if (state === 'completed') {
      await this.markProcessedFromCompletedJob(webhookEventId);
      return;
    }

    if (
      state === 'waiting' ||
      state === 'active' ||
      state === 'delayed' ||
      state === 'prioritized' ||
      state === 'waiting-children'
    ) {
      await this.markQueued(
        webhookEventId,
        false,
        event.status !== WebhookStatus.QUEUED,
        job.queueName,
      );
      return;
    }

    await this.markFailedWithBackoff(
      webhookEventId,
      enqueueAttempts,
      `Moderation job exists in unsupported state: ${state}`,
    );
  }

  private async retryFailedJob(
    webhookEventId: string,
    enqueueAttempts: number,
    job: Job<ProcessWebhookJob>,
  ) {
    if (enqueueAttempts >= this.maxEnqueueAttempts) {
      await this.markExhausted(webhookEventId, enqueueAttempts);
      return;
    }

    try {
      await job.retry();
      await this.markQueued(webhookEventId, true, true, job.queueName);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.markFailedWithBackoff(
        webhookEventId,
        enqueueAttempts,
        `Failed to retry existing failed job: ${message}`,
      );
    }
  }

  private async markQueued(
    webhookEventId: string,
    incrementAttempts: boolean,
    touchQueuedAt: boolean,
    queueName?: string | null,
  ) {
    const data: {
      status: WebhookStatus;
      queuedAt?: Date;
      nextEnqueueAt: Date | null;
      errorMessage: string | null;
      queueName?: string | null;
      enqueueAttempts?: {
        increment: number;
      };
    } = {
      status: WebhookStatus.QUEUED,
      nextEnqueueAt: null,
      errorMessage: null,
      ...(queueName ? { queueName } : {}),
      ...(touchQueuedAt ? { queuedAt: new Date() } : {}),
      ...(incrementAttempts
        ? {
            enqueueAttempts: {
              increment: 1,
            },
          }
        : {}),
    };

    await this.prisma.webhookEvent.updateMany({
      where: {
        id: webhookEventId,
        status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED, WebhookStatus.QUEUED] },
      },
      data,
    });
  }

  private async markFailedWithBackoff(
    webhookEventId: string,
    enqueueAttempts: number,
    message: string,
  ) {
    const nextAttempts = enqueueAttempts + 1;
    const exhausted = nextAttempts >= this.maxEnqueueAttempts;
    const nextDelaySec = Math.min(300, 2 ** Math.min(nextAttempts, 8));

    await this.prisma.webhookEvent.updateMany({
      where: {
        id: webhookEventId,
        status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED, WebhookStatus.QUEUED] },
      },
      data: {
        status: WebhookStatus.FAILED,
        errorMessage: message.slice(0, 500),
        queueName: null,
        nextEnqueueAt: exhausted ? null : new Date(Date.now() + nextDelaySec * 1_000),
        enqueueAttempts: {
          increment: 1,
        },
      },
    });
  }

  private async markExhausted(webhookEventId: string, enqueueAttempts: number) {
    const message = `Enqueue attempts exhausted (${enqueueAttempts}/${this.maxEnqueueAttempts})`;
    await this.prisma.webhookEvent.updateMany({
      where: {
        id: webhookEventId,
        status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED, WebhookStatus.QUEUED] },
      },
      data: {
        status: WebhookStatus.FAILED,
        errorMessage: message.slice(0, 500),
        queueName: null,
        nextEnqueueAt: null,
      },
    });
  }

  private async markProcessedFromCompletedJob(webhookEventId: string) {
    await this.prisma.webhookEvent.updateMany({
      where: {
        id: webhookEventId,
        status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED, WebhookStatus.QUEUED] },
      },
      data: {
        status: WebhookStatus.PROCESSED,
        processedAt: new Date(),
        queueName: null,
        nextEnqueueAt: null,
        errorMessage: null,
      },
    });
  }

  private isAlreadyExistsError(message: string): boolean {
    return message.toLowerCase().includes('already exists');
  }

  private async findExistingJob(
    webhookEventId: string,
    preferredQueueName?: AnyWebhookQueueName,
  ): Promise<{
    queueName: AnyWebhookQueueName;
    job: Job<ProcessWebhookJob>;
  } | null> {
    if (preferredQueueName) {
      const preferredJob = await this.queuesByName[preferredQueueName].getJob(webhookEventId);
      if (preferredJob) {
        return {
          queueName: preferredQueueName,
          job: preferredJob,
        };
      }
    }

    const queueNames = preferredQueueName
      ? ALL_WEBHOOK_QUEUE_NAMES.filter((queueName) => queueName !== preferredQueueName)
      : ALL_WEBHOOK_QUEUE_NAMES;
    const jobs = await Promise.all(
      queueNames.map(async (queueName) => ({
        queueName,
        job: await this.queuesByName[queueName].getJob(webhookEventId),
      })),
    );

    const matches = jobs.filter(
      (item): item is { queueName: AnyWebhookQueueName; job: Job<ProcessWebhookJob> } =>
        item.job != null,
    );
    if (matches.length === 0) {
      return null;
    }

    if (matches.length > 1) {
      this.logger.warn(
        {
          webhookEventId,
          queues: matches.map((item) => item.queueName),
        },
        'Webhook event is present in multiple processing queues',
      );
    }

    for (const queueName of queueNames) {
      const match = matches.find((item) => item.queueName === queueName);
      if (match) {
        return match;
      }
    }

    return matches[0] ?? null;
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
