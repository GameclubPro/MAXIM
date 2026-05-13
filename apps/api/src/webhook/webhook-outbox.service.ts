import { InjectQueue, getQueueToken } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { Prisma, WebhookStatus } from '@prisma/client';
import type { Job, Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsEnqueue } from '../runtime/app-role';
import {
  ALL_WEBHOOK_QUEUE_NAMES,
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  type DefaultWebhookQueueName,
  extractWebhookChatId,
  extractWebhookType,
  JOIN_WEBHOOK_QUEUE_NAMES,
  type JoinWebhookQueueName,
  LEGACY_WEBHOOK_QUEUE,
  type AnyWebhookQueueName,
  type ProcessWebhookJob,
  WEBHOOK_JOB_PRIORITY,
  resolveWebhookJobPriority,
  WEBHOOK_QUEUE_BACKGROUND,
  WEBHOOK_QUEUE_CRITICAL,
} from './webhook-queues';
import { WebhookRoutingService } from './webhook-routing.service';

const ANY_WEBHOOK_QUEUE_NAMES = new Set<string>(ALL_WEBHOOK_QUEUE_NAMES);
const USER_FACING_STALE_QUEUED_REPAIR_MS = 20_000;
const BACKGROUND_STALE_QUEUED_REPAIR_MS = 120_000;
const PRIORITY_SELECTION_WINDOW_MULTIPLIER = 3;
const MAX_PRIORITY_SELECTION_WINDOW = 1_000;
const MANUAL_CLOSE_PRIORITY_CACHE_TTL_MS = 5_000;
const MANUAL_CLOSE_PRIORITY_CACHE_PRUNE_THRESHOLD = 4_096;

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

type PrioritizedWebhookEnqueueCandidate = WebhookEnqueueCandidate & {
  priority: number;
};

type ManualClosePriorityCacheEntry = {
  prioritized: boolean;
  expiresAtMs: number;
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
  private readonly webhookFailedRetentionHours: number;
  private readonly moderationRetentionDays: number;

  private poller: NodeJS.Timeout | null = null;
  private cleaner: NodeJS.Timeout | null = null;
  private draining = false;
  private cleaning = false;
  private readonly queuesByName: Record<AnyWebhookQueueName, Queue<ProcessWebhookJob>>;
  private readonly joinShardQueuesByName: Record<JoinWebhookQueueName, Queue<ProcessWebhookJob>>;
  private readonly defaultShardQueuesByName: Record<
    DefaultWebhookQueueName,
    Queue<ProcessWebhookJob>
  >;
  private readonly manualClosePriorityCache = new Map<string, ManualClosePriorityCacheEntry>();

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
    this.webhookFailedRetentionHours = this.configService.get<number>(
      'WEBHOOK_FAILED_RETENTION_HOURS',
      24,
    );
    this.moderationRetentionDays = this.configService.get<number>('MODERATION_RETENTION_DAYS', 90);
    this.joinShardQueuesByName = Object.fromEntries(
      JOIN_WEBHOOK_QUEUE_NAMES.map((queueName) => [queueName, this.resolveShardQueue(queueName)]),
    ) as Record<JoinWebhookQueueName, Queue<ProcessWebhookJob>>;
    this.defaultShardQueuesByName = Object.fromEntries(
      DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName) => [
        queueName,
        this.resolveShardQueue(queueName),
      ]),
    ) as Record<DefaultWebhookQueueName, Queue<ProcessWebhookJob>>;
    this.queuesByName = {
      [WEBHOOK_QUEUE_CRITICAL]: this.criticalQueue,
      ...this.joinShardQueuesByName,
      ...this.defaultShardQueuesByName,
      [WEBHOOK_QUEUE_BACKGROUND]: this.backgroundQueue,
      [LEGACY_WEBHOOK_QUEUE]: this.legacyQueue,
    };
  }

  private resolveShardQueue(
    queueName: DefaultWebhookQueueName | JoinWebhookQueueName,
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

    this.cleaner = setInterval(
      () => {
        void this.cleanupRetention();
      },
      60 * 60 * 1_000,
    );
    this.cleaner.unref();

    void this.tick();
    void this.cleanupRetention();
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
    const candidates = await this.selectEnqueueCandidates(now);

    const prioritizedCandidates = await this.prioritizeCandidates(candidates, now);

    await this.enqueueCandidates(prioritizedCandidates);
  }

  private async selectEnqueueCandidates(now: Date): Promise<WebhookEnqueueCandidate[]> {
    const selectionWindowSize = this.resolvePrioritySelectionWindowSize();
    const staleUserFacingQueuedBefore = new Date(
      now.getTime() - USER_FACING_STALE_QUEUED_REPAIR_MS,
    );
    const staleBackgroundQueuedBefore = new Date(now.getTime() - BACKGROUND_STALE_QUEUED_REPAIR_MS);
    const staleUserFacingQueuedWhere: Prisma.WebhookEventWhereInput = {
      status: WebhookStatus.QUEUED,
      processedAt: null,
      AND: [
        {
          OR: [{ queueName: null }, { queueName: { not: WEBHOOK_QUEUE_BACKGROUND } }],
        },
        {
          OR: [
            { queuedAt: { lte: staleUserFacingQueuedBefore } },
            { createdAt: { lte: staleUserFacingQueuedBefore } },
          ],
        },
      ],
    };
    const staleBackgroundQueuedWhere: Prisma.WebhookEventWhereInput = {
      status: WebhookStatus.QUEUED,
      processedAt: null,
      queueName: WEBHOOK_QUEUE_BACKGROUND,
      OR: [
        { queuedAt: { lte: staleBackgroundQueuedBefore } },
        { createdAt: { lte: staleBackgroundQueuedBefore } },
      ],
    };

    const [
      receivedCandidates,
      failedCandidates,
      staleUserFacingQueuedCandidates,
      staleBackgroundQueuedCandidates,
    ] = await Promise.all([
      this.findEnqueueCandidates(
        {
          status: WebhookStatus.RECEIVED,
          OR: [{ nextEnqueueAt: null }, { nextEnqueueAt: { lte: now } }],
        },
        selectionWindowSize,
      ),
      this.findEnqueueCandidates(
        {
          status: WebhookStatus.FAILED,
          nextEnqueueAt: { lte: now },
        },
        selectionWindowSize,
      ),
      this.findEnqueueCandidates(staleUserFacingQueuedWhere, selectionWindowSize),
      this.findEnqueueCandidates(staleBackgroundQueuedWhere, selectionWindowSize),
    ]);

    return this.mergeEnqueueCandidates(
      [
        ...receivedCandidates,
        ...failedCandidates,
        ...staleUserFacingQueuedCandidates,
        ...staleBackgroundQueuedCandidates,
      ],
      selectionWindowSize,
    );
  }

  private async findEnqueueCandidates(
    where: Prisma.WebhookEventWhereInput,
    take: number,
  ): Promise<WebhookEnqueueCandidate[]> {
    return this.prisma.webhookEvent.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take,
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
  }

  private mergeEnqueueCandidates(
    candidates: readonly WebhookEnqueueCandidate[],
    take: number,
  ): WebhookEnqueueCandidate[] {
    const uniqueById = new Map<string, WebhookEnqueueCandidate>();
    for (const candidate of candidates) {
      if (!uniqueById.has(candidate.id)) {
        uniqueById.set(candidate.id, candidate);
      }
    }

    return Array.from(uniqueById.values())
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .slice(0, take);
  }

  private resolvePrioritySelectionWindowSize(): number {
    return Math.max(
      this.batchSize,
      Math.min(
        this.batchSize * PRIORITY_SELECTION_WINDOW_MULTIPLIER,
        MAX_PRIORITY_SELECTION_WINDOW,
      ),
    );
  }

  private async prioritizeCandidates(
    candidates: WebhookEnqueueCandidate[],
    now: Date,
  ): Promise<PrioritizedWebhookEnqueueCandidate[]> {
    const enqueueableCandidates = candidates.filter((candidate) =>
      this.shouldEnqueueCandidate(candidate, now),
    );
    if (enqueueableCandidates.length === 0) {
      return [];
    }

    const manualCloseChatIds = await this.resolveManualClosePriorityChatIds(
      enqueueableCandidates,
      now,
    );

    return enqueueableCandidates
      .map((candidate) => ({
        ...candidate,
        priority: this.resolveCandidatePriority(candidate, manualCloseChatIds),
      }))
      .sort((left, right) => {
        const priorityDiff = left.priority - right.priority;
        if (priorityDiff !== 0) {
          return priorityDiff;
        }

        return left.createdAt.getTime() - right.createdAt.getTime();
      })
      .slice(0, this.batchSize);
  }

  private resolveCandidatePriority(
    candidate: WebhookEnqueueCandidate,
    manualCloseChatIds: ReadonlySet<string>,
  ): number {
    const chatId = this.extractPriorityChatId(candidate.normalizedPayload);
    return resolveWebhookJobPriority(candidate.normalizedPayload, {
      manualCloseMessage: chatId !== null && manualCloseChatIds.has(chatId),
    });
  }

  private extractPriorityChatId(payload: unknown): string | null {
    if (extractWebhookType(payload) !== 'message_created') {
      return null;
    }

    const chatId = extractWebhookChatId(payload);
    return chatId.length > 0 ? chatId : null;
  }

  private async resolveManualClosePriorityChatIds(
    candidates: WebhookEnqueueCandidate[],
    now: Date,
  ): Promise<Set<string>> {
    const nowMs = now.getTime();
    this.pruneManualClosePriorityCache(nowMs);

    const prioritizedChatIds = new Set<string>();
    const uncachedChatIds = new Set<string>();

    for (const candidate of candidates) {
      const chatId = this.extractPriorityChatId(candidate.normalizedPayload);
      if (!chatId) {
        continue;
      }

      const cached = this.manualClosePriorityCache.get(chatId);
      if (cached && cached.expiresAtMs > nowMs) {
        if (cached.prioritized) {
          prioritizedChatIds.add(chatId);
        }
        continue;
      }

      this.manualClosePriorityCache.delete(chatId);
      uncachedChatIds.add(chatId);
    }

    if (uncachedChatIds.size === 0) {
      return prioritizedChatIds;
    }

    const activeManualCloseChats = await this.prisma.chatSettings.findMany({
      where: {
        chatId: { in: Array.from(uncachedChatIds) },
        nightModeForceCloseEnabled: true,
      },
      select: {
        chatId: true,
      },
    });

    const activeManualCloseChatIds = new Set(activeManualCloseChats.map((row) => row.chatId));
    const expiresAtMs = nowMs + MANUAL_CLOSE_PRIORITY_CACHE_TTL_MS;

    for (const chatId of uncachedChatIds) {
      const prioritized = activeManualCloseChatIds.has(chatId);
      this.manualClosePriorityCache.set(chatId, { prioritized, expiresAtMs });
      if (prioritized) {
        prioritizedChatIds.add(chatId);
      }
    }

    return prioritizedChatIds;
  }

  private pruneManualClosePriorityCache(nowMs: number) {
    if (this.manualClosePriorityCache.size < MANUAL_CLOSE_PRIORITY_CACHE_PRUNE_THRESHOLD) {
      return;
    }

    for (const [chatId, entry] of this.manualClosePriorityCache) {
      if (entry.expiresAtMs <= nowMs) {
        this.manualClosePriorityCache.delete(chatId);
      }
    }
  }

  private shouldEnqueueCandidate(candidate: WebhookEnqueueCandidate, now: Date): boolean {
    if (candidate.status !== WebhookStatus.QUEUED) {
      return true;
    }

    const thresholdMs = this.resolveStaleQueuedRepairThresholdMs(candidate.queueName);
    const referenceMs = Math.min(
      candidate.createdAt.getTime(),
      candidate.queuedAt?.getTime() ?? Number.POSITIVE_INFINITY,
    );
    return now.getTime() - referenceMs >= thresholdMs;
  }

  private resolveStaleQueuedRepairThresholdMs(queueName: string | null): number {
    if (queueName === WEBHOOK_QUEUE_BACKGROUND) {
      return BACKGROUND_STALE_QUEUED_REPAIR_MS;
    }

    return USER_FACING_STALE_QUEUED_REPAIR_MS;
  }

  private async enqueueCandidates(candidates: PrioritizedWebhookEnqueueCandidate[]) {
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
        const isManualCloseMessage = event.priority === WEBHOOK_JOB_PRIORITY.manualCloseMessage;
        const targetQueueName = isManualCloseMessage
          ? WEBHOOK_QUEUE_CRITICAL
          : event.status === WebhookStatus.QUEUED &&
              typeof event.queueName === 'string' &&
              ANY_WEBHOOK_QUEUE_NAMES.has(event.queueName)
            ? (event.queueName as AnyWebhookQueueName)
            : queueName;
        await this.enqueueOne(event, event.priority, targetQueueName);
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

    if (await this.trySkipStandbySharedChatMessage(event, queueName)) {
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

  private async handleExistingJob(event: WebhookEnqueueCandidate, job: Job<ProcessWebhookJob>) {
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
      await this.markExhausted(webhookEventId, enqueueAttempts, job);
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

  private async markExhausted(
    webhookEventId: string,
    enqueueAttempts: number,
    job?: Pick<Job<ProcessWebhookJob>, 'failedReason'> | null,
  ) {
    const failedReason = this.readFailedJobReason(job);
    const message = failedReason
      ? `Enqueue attempts exhausted (${enqueueAttempts}/${this.maxEnqueueAttempts}); terminal BullMQ failure: ${failedReason}`
      : `Enqueue attempts exhausted (${enqueueAttempts}/${this.maxEnqueueAttempts})`;
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

  private readFailedJobReason(job?: Pick<Job<ProcessWebhookJob>, 'failedReason'> | null): string {
    if (!job || typeof job.failedReason !== 'string') {
      return '';
    }

    return job.failedReason.trim().replace(/\s+/gu, ' ').slice(0, 300);
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

  private async trySkipStandbySharedChatMessage(
    event: WebhookEnqueueCandidate,
    queueName: AnyWebhookQueueName,
  ): Promise<boolean> {
    if (!this.isStandbySharedChatEvent(event)) {
      return false;
    }

    const existingJob = await this.findExistingJob(event.id, queueName);
    if (existingJob) {
      const state = await existingJob.job.getState();
      if (state === 'active') {
        return false;
      }

      try {
        await existingJob.job.remove();
      } catch (error: unknown) {
        this.logger.warn(
          {
            webhookEventId: event.id,
            queueName: existingJob.queueName,
            state,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to remove queued standby shared chat webhook job before skipping it',
        );
        return false;
      }
    }

    await this.markSkippedSharedStandbyEvent(event.id);
    return true;
  }

  private isStandbySharedChatEvent(event: WebhookEnqueueCandidate): boolean {
    const payload =
      event.normalizedPayload && typeof event.normalizedPayload === 'object'
        ? (event.normalizedPayload as Record<string, unknown>)
        : null;
    if (!payload) {
      return false;
    }

    const updateType = this.readLowerString(payload.type);
    if (
      updateType !== 'message_created' &&
      updateType !== 'user_added' &&
      updateType !== 'user_removed'
    ) {
      return false;
    }

    const ownerBotId = this.readTrimmedString(payload.executionOwnerBotId);
    const activeBotId =
      this.readTrimmedString(event.botId) ?? this.readTrimmedString(payload.botId);
    if (!ownerBotId || !activeBotId || ownerBotId === activeBotId) {
      return false;
    }

    const message =
      payload.message && typeof payload.message === 'object'
        ? (payload.message as Record<string, unknown>)
        : null;
    const joinedUser =
      payload.user && typeof payload.user === 'object'
        ? (payload.user as Record<string, unknown>)
        : null;
    const chatId =
      this.readTrimmedString(message?.chatId) ??
      this.readTrimmedString(payload.chatId) ??
      this.readTrimmedString(joinedUser?.chatId);
    return Boolean(chatId && chatId.startsWith('-'));
  }

  private async markSkippedSharedStandbyEvent(webhookEventId: string) {
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

  private readTrimmedString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private readLowerString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null;
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
      const failedWebhookCutoff = new Date(
        Date.now() - this.webhookFailedRetentionHours * 60 * 60 * 1_000,
      );
      const moderationCutoff = new Date(
        Date.now() - this.moderationRetentionDays * 24 * 60 * 60 * 1_000,
      );
      const [webhookDeleted, failedWebhookDeleted, moderationDeleted, violationsDeleted] =
        await Promise.all([
          this.prisma.webhookEvent.deleteMany({
            where: {
              createdAt: { lt: webhookCutoff },
              status: { in: [WebhookStatus.PROCESSED, WebhookStatus.DUPLICATE] },
            },
          }),
          this.prisma.webhookEvent.deleteMany({
            where: {
              createdAt: { lt: failedWebhookCutoff },
              status: WebhookStatus.FAILED,
              nextEnqueueAt: null,
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
          failedWebhookEvents: failedWebhookDeleted.count,
          moderationEvents: moderationDeleted.count,
          violations: violationsDeleted.count,
          webhookRetentionDays: this.webhookRetentionDays,
          webhookFailedRetentionHours: this.webhookFailedRetentionHours,
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
