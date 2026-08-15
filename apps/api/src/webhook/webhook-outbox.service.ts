import { InjectQueue, getQueueToken } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { Prisma, WebhookExecutionClaimStatus, WebhookStatus } from '../prisma/prisma-client';
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
import { WebhookService } from './webhook.service';
import {
  isPendingWebhookTimeoutQuarantineMessage,
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX,
} from './webhook-timeout-quarantine';

const ANY_WEBHOOK_QUEUE_NAMES = new Set<string>(ALL_WEBHOOK_QUEUE_NAMES);
const USER_FACING_STALE_QUEUED_REPAIR_MS = 20_000;
const BACKGROUND_STALE_QUEUED_REPAIR_MS = 120_000;
const PRIORITY_SELECTION_WINDOW_MULTIPLIER = 3;
const MAX_PRIORITY_SELECTION_WINDOW = 1_000;
const RECEIVED_BATCH_SHARE = 0.75;
const RECENT_RECEIPT_BATCH_SHARE = 0.25;
const MANUAL_CLOSE_PRIORITY_CACHE_TTL_MS = 5_000;
const MANUAL_CLOSE_PRIORITY_CACHE_PRUNE_THRESHOLD = 4_096;
const WEBHOOK_FAILED_JOB_RETENTION = {
  age: 7 * 24 * 60 * 60,
  count: 5_000,
} as const;
const RETENTION_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const RETENTION_CLEANUP_BATCH_SIZE = 500;
const RETENTION_CLEANUP_BATCH_DELAY_MS = 500;
const WEBHOOK_RETENTION_MAX_BATCHES = 80;
const DEFAULT_RETENTION_MAX_BATCHES = 10;
const WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER = `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`;
const WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_LENGTH_SQL = Prisma.raw(
  String(WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER.length),
);
const WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_SQL = Prisma.raw(
  `'${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER.replaceAll("'", "''")}'`,
);

type RetentionCleanupPhase = {
  name: string;
  maxBatches: number;
  deleteBatch: () => Promise<number>;
};

type RetentionCleanupPhaseResult = {
  rows: number;
  batches: number;
  durationMs: number;
  budgetExhausted: boolean;
};

type WebhookEnqueueCandidate = {
  id: string;
  status: WebhookStatus;
  botId: string | null;
  queueName: string | null;
  enqueueAttempts: number;
  createdAt: Date;
  queuedAt: Date | null;
  nextEnqueueAt: Date | null;
  timeoutQuarantineExpiresAt: Date | null;
  errorMessage: string | null;
  normalizedPayload: unknown;
  isRecentReceipt?: boolean;
};

type WebhookEnqueueStateSnapshot = Pick<
  WebhookEnqueueCandidate,
  | 'id'
  | 'status'
  | 'queueName'
  | 'enqueueAttempts'
  | 'queuedAt'
  | 'nextEnqueueAt'
  | 'timeoutQuarantineExpiresAt'
  | 'errorMessage'
>;

type PrioritizedWebhookEnqueueCandidate = WebhookEnqueueCandidate & {
  priority: number;
};

type OrderedWebhookHead = Pick<WebhookEnqueueCandidate, 'id' | 'createdAt'>;
type OrderedWebhookHeadByChat = OrderedWebhookHead & { chatId: string };

type WebhookEnqueueWorkUnit = {
  chatId: string | null;
  candidates: PrioritizedWebhookEnqueueCandidate[];
};

type CandidatePreparationOutcome = 'ready' | 'advance' | 'block';
type CandidateEnqueueOutcome = 'terminal' | 'outstanding' | 'block';

type ManualClosePriorityCacheEntry = {
  prioritized: boolean;
  expiresAtMs: number;
};

type TimeoutExecutionClaim = {
  status?: string;
  completedAt?: Date | null;
};

type WebhookOutboxPersistenceClient = {
  webhookEvent: {
    updateMany: (args: unknown) => Promise<{ count: number }>;
  };
  webhookExecutionClaim?: {
    findFirst?: (args: unknown) => Promise<TimeoutExecutionClaim | null>;
  };
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
  private readonly userDisplayNameRetentionDays: number;
  private readonly retentionBatchDelayMs = RETENTION_CLEANUP_BATCH_DELAY_MS;

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
    private readonly webhookService: WebhookService,
    @InjectQueue(WEBHOOK_QUEUE_CRITICAL)
    private readonly criticalQueue: Queue<ProcessWebhookJob>,
    @InjectQueue(WEBHOOK_QUEUE_BACKGROUND)
    private readonly backgroundQueue: Queue<ProcessWebhookJob>,
    @InjectQueue(LEGACY_WEBHOOK_QUEUE)
    private readonly legacyQueue: Queue<ProcessWebhookJob>,
  ) {
    this.enabled = roleRunsEnqueue(getAppRole());
    this.pollIntervalMs = this.configService.get<number>('ENQUEUE_POLL_INTERVAL_MS', 200);
    this.batchSize = this.configService.get<number>('ENQUEUE_BATCH_SIZE', 400);
    this.enqueueConcurrency = this.configService.get<number>('ENQUEUE_CONCURRENCY', 32);
    this.maxEnqueueAttempts = this.configService.get<number>('ENQUEUE_MAX_ATTEMPTS', 120);
    this.webhookRetentionDays = this.configService.get<number>('WEBHOOK_RETENTION_DAYS', 7);
    this.webhookFailedRetentionHours = this.configService.get<number>(
      'WEBHOOK_FAILED_RETENTION_HOURS',
      24,
    );
    this.moderationRetentionDays = this.configService.get<number>('MODERATION_RETENTION_DAYS', 90);
    this.userDisplayNameRetentionDays = this.configService.get<number>(
      'USER_DISPLAY_NAME_RETENTION_DAYS',
      180,
    );
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

    this.cleaner = setInterval(() => {
      void this.cleanupRetention();
    }, RETENTION_CLEANUP_INTERVAL_MS);
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
    const candidates = await this.selectEnqueueCandidates(now);

    const prioritizedCandidates = await this.prioritizeCandidates(candidates, now);

    await this.enqueueCandidates(prioritizedCandidates);
  }

  private async selectEnqueueCandidates(now: Date): Promise<WebhookEnqueueCandidate[]> {
    const selectionWindowSize = this.resolvePrioritySelectionWindowSize();
    const recentReceiptTake = this.resolveRecentReceiptTake(selectionWindowSize);
    const backlogReceiptTake = selectionWindowSize - recentReceiptTake;
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
            {
              queuedAt: null,
              createdAt: { lte: staleUserFacingQueuedBefore },
            },
          ],
        },
        {
          OR: [{ nextEnqueueAt: null }, { nextEnqueueAt: { lte: now } }],
        },
      ],
    };
    const staleBackgroundQueuedWhere: Prisma.WebhookEventWhereInput = {
      status: WebhookStatus.QUEUED,
      processedAt: null,
      queueName: WEBHOOK_QUEUE_BACKGROUND,
      AND: [
        {
          OR: [
            { queuedAt: { lte: staleBackgroundQueuedBefore } },
            {
              queuedAt: null,
              createdAt: { lte: staleBackgroundQueuedBefore },
            },
          ],
        },
        {
          OR: [{ nextEnqueueAt: null }, { nextEnqueueAt: { lte: now } }],
        },
      ],
    };

    const receivedWhere: Prisma.WebhookEventWhereInput = {
      status: WebhookStatus.RECEIVED,
      OR: [{ nextEnqueueAt: null }, { nextEnqueueAt: { lte: now } }],
    };
    const [
      backlogReceiptCandidates,
      recentReceiptCandidates,
      failedCandidates,
      staleUserFacingQueuedCandidates,
      staleBackgroundQueuedCandidates,
    ] = await Promise.all([
      backlogReceiptTake > 0
        ? this.findEnqueueCandidates(receivedWhere, backlogReceiptTake)
        : Promise.resolve([]),
      this.findEnqueueCandidates(receivedWhere, recentReceiptTake, 'desc').then((candidates) =>
        candidates.map((candidate) => ({ ...candidate, isRecentReceipt: true })),
      ),
      this.findEnqueueCandidates(
        {
          status: WebhookStatus.FAILED,
          OR: [
            { nextEnqueueAt: { lte: now } },
            {
              nextEnqueueAt: null,
              errorMessage: { startsWith: WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER },
              executionClaims: {
                some: {
                  kind: 'EXECUTION',
                  status: WebhookExecutionClaimStatus.COMPLETED,
                },
              },
            },
          ],
        },
        selectionWindowSize,
      ),
      this.findEnqueueCandidates(staleUserFacingQueuedWhere, selectionWindowSize),
      this.findEnqueueCandidates(staleBackgroundQueuedWhere, selectionWindowSize),
    ]);

    return this.mergeEnqueueCandidates(
      [
        ...backlogReceiptCandidates,
        ...recentReceiptCandidates,
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
    orderDirection: 'asc' | 'desc' = 'asc',
  ): Promise<WebhookEnqueueCandidate[]> {
    return this.prisma.webhookEvent.findMany({
      where,
      orderBy: [{ createdAt: orderDirection }, { id: orderDirection }],
      take,
      select: {
        id: true,
        status: true,
        botId: true,
        queueName: true,
        enqueueAttempts: true,
        createdAt: true,
        queuedAt: true,
        nextEnqueueAt: true,
        timeoutQuarantineExpiresAt: true,
        errorMessage: true,
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
      const existing = uniqueById.get(candidate.id);
      if (!existing || candidate.isRecentReceipt) {
        uniqueById.set(candidate.id, candidate);
      }
    }

    return this.selectCandidatesWithReceiptReserve(Array.from(uniqueById.values()), take)
      .sort((left, right) => this.compareCandidateSequence(left, right))
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

    const prioritizedCandidates = enqueueableCandidates
      .map((candidate) => ({
        ...candidate,
        priority: this.resolveCandidatePriority(candidate, manualCloseChatIds),
      }))
      .sort((left, right) => this.comparePrioritizedCandidates(left, right));
    return this.selectCandidatesWithReceiptReserve(prioritizedCandidates, this.batchSize).sort(
      (left, right) => this.comparePrioritizedCandidates(left, right),
    );
  }

  private selectCandidatesWithReceiptReserve<T extends WebhookEnqueueCandidate>(
    candidates: readonly T[],
    take: number,
  ): T[] {
    const recentReceipts = candidates.filter(
      (candidate) => candidate.status === WebhookStatus.RECEIVED && candidate.isRecentReceipt,
    );
    const backlogReceipts = candidates.filter(
      (candidate) => candidate.status === WebhookStatus.RECEIVED && !candidate.isRecentReceipt,
    );
    const recoveryCandidates = candidates.filter(
      (candidate) => candidate.status !== WebhookStatus.RECEIVED,
    );
    const receivedTake = this.resolveReceivedTake(
      recentReceipts.length + backlogReceipts.length,
      take,
    );
    const recentReceiptTake = Math.min(
      this.resolveRecentReceiptTake(take),
      receivedTake,
      recentReceipts.length,
    );
    const selectedReceipts = [
      ...recentReceipts.slice(0, recentReceiptTake),
      ...backlogReceipts.slice(0, Math.max(0, receivedTake - recentReceiptTake)),
    ];
    const unselectedReceipts = [
      ...recentReceipts.slice(recentReceiptTake),
      ...backlogReceipts.slice(Math.max(0, receivedTake - recentReceiptTake)),
    ];

    if (selectedReceipts.length < receivedTake) {
      selectedReceipts.push(
        ...unselectedReceipts.splice(0, receivedTake - selectedReceipts.length),
      );
    }

    const selected = [
      ...selectedReceipts,
      ...recoveryCandidates.slice(0, Math.max(0, take - selectedReceipts.length)),
    ];
    if (selected.length < take) {
      selected.push(...unselectedReceipts.slice(0, take - selected.length));
    }

    return selected;
  }

  private comparePrioritizedCandidates(
    left: PrioritizedWebhookEnqueueCandidate,
    right: PrioritizedWebhookEnqueueCandidate,
  ): number {
    const priorityDiff = left.priority - right.priority;
    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    return this.compareCandidateSequence(left, right);
  }

  private compareCandidateSequence(
    left: Pick<WebhookEnqueueCandidate, 'id' | 'createdAt'>,
    right: Pick<WebhookEnqueueCandidate, 'id' | 'createdAt'>,
  ): number {
    const createdAtDiff = left.createdAt.getTime() - right.createdAt.getTime();
    if (createdAtDiff !== 0) {
      return createdAtDiff;
    }

    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  }

  private resolveReceivedTake(receivedCount: number, take: number): number {
    if (receivedCount === 0) {
      return 0;
    }

    return Math.min(receivedCount, Math.max(1, Math.ceil(take * RECEIVED_BATCH_SHARE)));
  }

  private resolveRecentReceiptTake(take: number): number {
    return Math.min(take, Math.max(1, Math.ceil(take * RECENT_RECEIPT_BATCH_SHARE)));
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
    const updateType = extractWebhookType(payload);
    if (updateType !== 'message_created' && updateType !== 'message_edited') {
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

    if (candidate.nextEnqueueAt && candidate.nextEnqueueAt > now) {
      return false;
    }

    const thresholdMs = this.resolveStaleQueuedRepairThresholdMs(candidate.queueName);
    const referenceMs = candidate.queuedAt?.getTime() ?? candidate.createdAt.getTime();
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

    const workUnits = this.buildEnqueueWorkUnits(candidates);
    const orderedHeadsByChatId = await this.findOrderedWebhookHeadsForChats(
      workUnits.flatMap((workUnit) => (workUnit.chatId ? [workUnit.chatId] : [])),
    );
    const workerCount = Math.max(1, Math.min(this.enqueueConcurrency, workUnits.length));
    let nextIndex = 0;

    const runWorker = async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        const workUnit = workUnits[currentIndex];
        if (!workUnit) {
          return;
        }

        await this.enqueueCandidateSequence(
          workUnit,
          workUnit.chatId ? (orderedHeadsByChatId.get(workUnit.chatId) ?? null) : null,
        );
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  }

  private buildEnqueueWorkUnits(
    candidates: PrioritizedWebhookEnqueueCandidate[],
  ): WebhookEnqueueWorkUnit[] {
    const workUnitsByKey = new Map<string, WebhookEnqueueWorkUnit>();

    for (const candidate of candidates) {
      const chatId = this.extractPriorityChatId(candidate.normalizedPayload);
      const key = chatId === null ? `event:${candidate.id}` : `chat:${chatId}`;
      const existing = workUnitsByKey.get(key);
      if (existing) {
        existing.candidates.push(candidate);
        continue;
      }

      workUnitsByKey.set(key, {
        chatId,
        candidates: [candidate],
      });
    }

    for (const workUnit of workUnitsByKey.values()) {
      workUnit.candidates.sort((left, right) => this.compareCandidateSequence(left, right));
    }

    return Array.from(workUnitsByKey.values());
  }

  private async enqueueCandidateSequence(
    workUnit: WebhookEnqueueWorkUnit,
    initialOrderedHead: OrderedWebhookHead | null,
  ): Promise<void> {
    let orderedHead = initialOrderedHead;

    for (const event of workUnit.candidates) {
      if (workUnit.chatId) {
        if (!orderedHead) {
          return;
        }
        const headOrder = this.compareCandidateSequence(orderedHead, event);
        if (headOrder < 0) {
          return;
        }
        if (headOrder > 0) {
          continue;
        }
      }

      const preparationOutcome = await this.prepareCandidateForCanonicalExecution(event);
      if (preparationOutcome === 'block') {
        return;
      }
      if (preparationOutcome === 'advance') {
        if (workUnit.chatId) {
          orderedHead = await this.findOrderedWebhookHeadForChat(workUnit.chatId, event);
        }
        continue;
      }

      const queueName = await this.webhookRoutingService.resolveQueueName(
        event.id,
        event.normalizedPayload,
      );
      const isManualCloseMessage = event.priority === WEBHOOK_JOB_PRIORITY.manualCloseMessage;
      const targetQueueName = isManualCloseMessage
        ? WEBHOOK_QUEUE_CRITICAL
        : event.status === WebhookStatus.QUEUED &&
            typeof event.queueName === 'string' &&
            ANY_WEBHOOK_QUEUE_NAMES.has(event.queueName)
          ? (event.queueName as AnyWebhookQueueName)
          : queueName;
      const enqueueOutcome = await this.enqueueOne(event, event.priority, targetQueueName);
      if (enqueueOutcome === 'block') {
        return;
      }
      if (enqueueOutcome === 'outstanding') {
        return;
      }
      if (workUnit.chatId) {
        orderedHead = await this.findOrderedWebhookHeadForChat(workUnit.chatId, event);
      }
    }
  }

  private async findOrderedWebhookHeadsForChats(
    chatIds: readonly string[],
  ): Promise<Map<string, OrderedWebhookHead>> {
    if (chatIds.length === 0) {
      return new Map();
    }

    const requestedChats = Prisma.join(chatIds.map((chatId) => Prisma.sql`(${chatId})`));
    const rows = await this.prisma.$queryRaw<OrderedWebhookHeadByChat[]>(Prisma.sql`
      WITH requested_chats("chatId") AS (
        VALUES ${requestedChats}
      )
      SELECT requested_chats."chatId", head."id", head."createdAt"
      FROM requested_chats
      CROSS JOIN LATERAL (
        SELECT "id", "created_at" AS "createdAt"
        FROM "webhook_events"
        WHERE (
            "status" = ANY(ARRAY['RECEIVED', 'QUEUED']::"WebhookStatus"[])
            OR (
              "status" = 'FAILED'::"WebhookStatus"
              AND (
                "next_enqueue_at" IS NOT NULL
                OR LEFT(COALESCE("error_message", ''), ${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_LENGTH_SQL}) = ${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_SQL}
              )
            )
          )
          AND LOWER(
            COALESCE(
              NULLIF(BTRIM("normalized_payload"->>'type'), ''),
              NULLIF(BTRIM("normalized_payload"->>'update_type'), '')
            )
          ) = ANY(ARRAY['message_created', 'message_edited'])
          AND COALESCE(
            NULLIF(BTRIM("normalized_payload"->'message'->>'chatId'), ''),
            NULLIF(BTRIM("normalized_payload"->>'chatId'), '')
          ) = requested_chats."chatId"
        ORDER BY "created_at" ASC, "id" ASC
        LIMIT 1
      ) head ON TRUE
    `);

    return new Map(rows.map(({ chatId, id, createdAt }) => [chatId, { id, createdAt }]));
  }

  private async findOrderedWebhookHeadForChat(
    chatId: string,
    after?: OrderedWebhookHead,
  ): Promise<OrderedWebhookHead | null> {
    const cursor = after
      ? Prisma.sql`
          AND (
            "created_at" > ${after.createdAt}
            OR ("created_at" = ${after.createdAt} AND "id" > ${after.id})
          )
        `
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<OrderedWebhookHead[]>(Prisma.sql`
      SELECT "id", "created_at" AS "createdAt"
      FROM "webhook_events"
      WHERE (
          "status" = ANY(ARRAY['RECEIVED', 'QUEUED']::"WebhookStatus"[])
          OR (
            "status" = 'FAILED'::"WebhookStatus"
            AND (
              "next_enqueue_at" IS NOT NULL
              OR LEFT(COALESCE("error_message", ''), ${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_LENGTH_SQL}) = ${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_SQL}
            )
          )
        )
        AND LOWER(
          COALESCE(
            NULLIF(BTRIM("normalized_payload"->>'type'), ''),
            NULLIF(BTRIM("normalized_payload"->>'update_type'), '')
          )
        ) = ANY(ARRAY['message_created', 'message_edited'])
        AND COALESCE(
          NULLIF(BTRIM("normalized_payload"->'message'->>'chatId'), ''),
          NULLIF(BTRIM("normalized_payload"->>'chatId'), '')
        ) = ${chatId}
        ${cursor}
      ORDER BY "created_at" ASC, "id" ASC
      LIMIT 1
    `);

    return rows[0] ?? null;
  }

  private async enqueueOne(
    event: WebhookEnqueueCandidate,
    priority: number,
    queueName: AnyWebhookQueueName,
  ): Promise<CandidateEnqueueOutcome> {
    const { id: webhookEventId, enqueueAttempts } = event;
    const existingJob = await this.findExistingJob(webhookEventId, queueName);
    if (existingJob) {
      return this.handleExistingJob(event, existingJob.job, {
        queueName: existingJob.queueName,
      });
    }
    if (enqueueAttempts >= this.maxEnqueueAttempts) {
      return this.markExhausted(event);
    }

    let claimedEvent: WebhookEnqueueCandidate | null = null;
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
      const activationClaim = await this.claimQueueActivation(event, queueName);
      if (!activationClaim.event) {
        return activationClaim.outcome;
      }
      claimedEvent = activationClaim.event;
      await this.queuesByName[queueName].add(
        'process-webhook-event',
        { webhookEventId },
        {
          jobId: webhookEventId,
          priority,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: WEBHOOK_FAILED_JOB_RETENTION,
        },
      );

      return 'outstanding';
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isAlreadyExistsError(message)) {
        return this.handleAlreadyExists(claimedEvent ?? event, queueName, {
          activationClaimed: claimedEvent !== null,
        });
      }

      return claimedEvent
        ? this.markClaimedQueueActivationFailed(claimedEvent, message)
        : this.markFailedWithBackoff(event, message);
    }
  }

  private async prepareCandidateForCanonicalExecution(
    event: WebhookEnqueueCandidate,
  ): Promise<CandidatePreparationOutcome> {
    if (isPendingWebhookTimeoutQuarantineMessage(event.errorMessage)) {
      const timeoutOutcome = await this.settlePendingTimeoutQuarantine(event);
      return timeoutOutcome === 'terminal' ? 'advance' : 'block';
    }

    try {
      const prepared = await this.webhookService.preparePersistedWebhookEvent(event.id);
      if (!prepared.canonical) {
        await this.removeNonCanonicalQueuedJob(event);
        return 'advance';
      }
      if (!prepared.prepared) {
        return 'block';
      }
      event.normalizedPayload = prepared.normalizedPayload;
      return 'ready';
    } catch (error: unknown) {
      const failureOutcome = await this.markFailedWithBackoff(
        event,
        `Webhook preparation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return failureOutcome === 'terminal' ? 'advance' : 'block';
    }
  }

  private async removeNonCanonicalQueuedJob(event: WebhookEnqueueCandidate): Promise<void> {
    const existingJob = await this.findExistingJob(
      event.id,
      typeof event.queueName === 'string' && ANY_WEBHOOK_QUEUE_NAMES.has(event.queueName)
        ? (event.queueName as AnyWebhookQueueName)
        : undefined,
    );
    if (!existingJob) {
      return;
    }

    const state = await existingJob.job.getState();
    if (state === 'active') {
      this.logger.warn(
        {
          webhookEventId: event.id,
          queueName: existingJob.queueName,
        },
        'Non-canonical mirrored webhook job is already active',
      );
      return;
    }
    await existingJob.job.remove();
  }

  private async handleAlreadyExists(
    event: WebhookEnqueueCandidate,
    queueName: AnyWebhookQueueName,
    options?: { activationClaimed?: boolean },
  ): Promise<CandidateEnqueueOutcome> {
    const { id: webhookEventId } = event;
    const existingJob = await this.findExistingJob(webhookEventId, queueName);
    if (!existingJob) {
      const message = 'Moderation job already exists but cannot be loaded';
      return options?.activationClaimed
        ? this.markClaimedQueueActivationFailed(event, message)
        : this.markFailedWithBackoff(event, message);
    }

    return this.handleExistingJob(event, existingJob.job, {
      ...options,
      queueName: existingJob.queueName,
    });
  }

  private async handleExistingJob(
    event: WebhookEnqueueCandidate,
    job: Job<ProcessWebhookJob>,
    options?: { activationClaimed?: boolean; queueName?: AnyWebhookQueueName },
  ): Promise<CandidateEnqueueOutcome> {
    const state = await job.getState();
    if (state === 'failed') {
      return this.retryFailedJob(event, job, options);
    }

    if (state === 'completed') {
      return this.markProcessedFromCompletedJob(event);
    }

    if (
      state === 'waiting' ||
      state === 'active' ||
      state === 'delayed' ||
      state === 'prioritized' ||
      state === 'waiting-children'
    ) {
      if (options?.activationClaimed) {
        return 'outstanding';
      }
      return this.markQueued(
        event,
        false,
        event.status !== WebhookStatus.QUEUED,
        options?.queueName ?? job.queueName,
        state === 'delayed'
          ? new Date(Date.now() + this.resolveStaleQueuedRepairThresholdMs(event.queueName))
          : null,
      );
    }

    const message = `Moderation job exists in unsupported state: ${state}`;
    return options?.activationClaimed
      ? this.markClaimedQueueActivationFailed(event, message)
      : this.markFailedWithBackoff(event, message);
  }

  private async retryFailedJob(
    event: WebhookEnqueueCandidate,
    job: Job<ProcessWebhookJob>,
    options?: { activationClaimed?: boolean; queueName?: AnyWebhookQueueName },
  ): Promise<CandidateEnqueueOutcome> {
    if (!options?.activationClaimed && event.enqueueAttempts >= this.maxEnqueueAttempts) {
      return this.markExhausted(event, job);
    }

    let claimedEvent = event;
    if (!options?.activationClaimed) {
      const activationClaim = await this.claimQueueActivation(
        event,
        options?.queueName ?? (job.queueName as AnyWebhookQueueName),
      );
      if (!activationClaim.event) {
        return activationClaim.outcome;
      }
      claimedEvent = activationClaim.event;
    }

    try {
      await job.retry();
      return 'outstanding';
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return this.markClaimedQueueActivationFailed(
        claimedEvent,
        `Failed to retry existing failed job: ${message}`,
      );
    }
  }

  private async claimQueueActivation(
    event: WebhookEnqueueCandidate,
    queueName: AnyWebhookQueueName,
  ): Promise<{
    event: WebhookEnqueueCandidate | null;
    outcome: CandidateEnqueueOutcome;
  }> {
    const queuedAt = new Date();
    const enqueueAttempts = event.enqueueAttempts + 1;
    const result = await this.prisma.webhookEvent.updateMany({
      where: this.buildEnqueueStateWhere(event),
      data: {
        status: WebhookStatus.QUEUED,
        queueName,
        queuedAt,
        enqueueAttempts: { increment: 1 },
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
        errorMessage: null,
      },
    });
    if (result.count !== 1) {
      return {
        event: null,
        outcome: await this.resolveCurrentCandidateOutcome(event.id),
      };
    }

    return {
      event: {
        ...event,
        status: WebhookStatus.QUEUED,
        queueName,
        queuedAt,
        enqueueAttempts,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
        errorMessage: null,
      },
      outcome: 'outstanding',
    };
  }

  private async markQueued(
    event: WebhookEnqueueStateSnapshot,
    incrementAttempts: boolean,
    touchQueuedAt: boolean,
    queueName?: string | null,
    nextEnqueueAt: Date | null = null,
  ): Promise<CandidateEnqueueOutcome> {
    const data: {
      status: WebhookStatus;
      queuedAt?: Date;
      nextEnqueueAt: Date | null;
      timeoutQuarantineExpiresAt: null;
      errorMessage: string | null;
      queueName?: string | null;
      enqueueAttempts?: {
        increment: number;
      };
    } = {
      status: WebhookStatus.QUEUED,
      nextEnqueueAt,
      timeoutQuarantineExpiresAt: null,
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

    const result = await this.prisma.webhookEvent.updateMany({
      where: this.buildEnqueueStateWhere(event),
      data,
    });
    return result.count === 1 ? 'outstanding' : this.resolveCurrentCandidateOutcome(event.id);
  }

  private async markFailedWithBackoff(
    event: WebhookEnqueueStateSnapshot,
    message: string,
  ): Promise<CandidateEnqueueOutcome> {
    const nextAttempts = event.enqueueAttempts + 1;
    const exhausted = nextAttempts >= this.maxEnqueueAttempts;
    const nextDelaySec = Math.min(300, 2 ** Math.min(nextAttempts, 8));

    const result = await this.prisma.webhookEvent.updateMany({
      where: this.buildEnqueueStateWhere(event),
      data: {
        status: WebhookStatus.FAILED,
        errorMessage: message.slice(0, 500),
        queueName: null,
        nextEnqueueAt: exhausted ? null : new Date(Date.now() + nextDelaySec * 1_000),
        timeoutQuarantineExpiresAt: null,
        enqueueAttempts: {
          increment: 1,
        },
      },
    });
    return result.count === 1
      ? exhausted
        ? 'terminal'
        : 'block'
      : this.resolveCurrentCandidateOutcome(event.id);
  }

  private async markClaimedQueueActivationFailed(
    event: WebhookEnqueueStateSnapshot,
    message: string,
  ): Promise<CandidateEnqueueOutcome> {
    const exhausted = event.enqueueAttempts >= this.maxEnqueueAttempts;
    const nextDelaySec = Math.min(300, 2 ** Math.min(event.enqueueAttempts, 8));
    const result = await this.prisma.webhookEvent.updateMany({
      where: this.buildEnqueueStateWhere(event),
      data: {
        status: WebhookStatus.FAILED,
        errorMessage: message.slice(0, 500),
        queueName: null,
        nextEnqueueAt: exhausted ? null : new Date(Date.now() + nextDelaySec * 1_000),
        timeoutQuarantineExpiresAt: null,
      },
    });
    return result.count === 1
      ? exhausted
        ? 'terminal'
        : 'block'
      : this.resolveCurrentCandidateOutcome(event.id);
  }

  private async markExhausted(
    event: WebhookEnqueueStateSnapshot,
    job?: Pick<Job<ProcessWebhookJob>, 'failedReason'> | null,
  ): Promise<CandidateEnqueueOutcome> {
    const failedReason = this.readFailedJobReason(job);
    const message = failedReason
      ? `Enqueue attempts exhausted (${event.enqueueAttempts}/${this.maxEnqueueAttempts}); terminal BullMQ failure: ${failedReason}`
      : `Enqueue attempts exhausted (${event.enqueueAttempts}/${this.maxEnqueueAttempts})`;
    const result = await this.prisma.webhookEvent.updateMany({
      where: this.buildEnqueueStateWhere(event),
      data: {
        status: WebhookStatus.FAILED,
        errorMessage: message.slice(0, 500),
        queueName: null,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
      },
    });
    return result.count === 1 ? 'terminal' : this.resolveCurrentCandidateOutcome(event.id);
  }

  private readFailedJobReason(job?: Pick<Job<ProcessWebhookJob>, 'failedReason'> | null): string {
    if (!job || typeof job.failedReason !== 'string') {
      return '';
    }

    return job.failedReason.trim().replace(/\s+/gu, ' ').slice(0, 300);
  }

  private async markProcessedFromCompletedJob(
    event: WebhookEnqueueStateSnapshot,
  ): Promise<CandidateEnqueueOutcome> {
    const result = await this.prisma.webhookEvent.updateMany({
      where: this.buildEnqueueStateWhere(event),
      data: {
        status: WebhookStatus.PROCESSED,
        processedAt: new Date(),
        queueName: null,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
        errorMessage: null,
      },
    });
    return result.count === 1 ? 'terminal' : this.resolveCurrentCandidateOutcome(event.id);
  }

  private buildEnqueueStateWhere(
    event: WebhookEnqueueStateSnapshot,
  ): Prisma.WebhookEventWhereInput {
    return {
      id: event.id,
      status: event.status,
      queueName: event.queueName,
      enqueueAttempts: event.enqueueAttempts,
      queuedAt: event.queuedAt,
      nextEnqueueAt: event.nextEnqueueAt,
      timeoutQuarantineExpiresAt: event.timeoutQuarantineExpiresAt,
      errorMessage: event.errorMessage,
    };
  }

  private async settlePendingTimeoutQuarantine(
    event: WebhookEnqueueCandidate,
  ): Promise<CandidateEnqueueOutcome> {
    const now = new Date();
    const transition = await this.runInTransaction(async (client) => {
      const claim =
        typeof client.webhookExecutionClaim?.findFirst === 'function'
          ? await client.webhookExecutionClaim.findFirst({
              where: {
                webhookEventId: event.id,
                kind: 'EXECUTION',
              },
              orderBy: { createdAt: 'desc' },
              select: {
                status: true,
                completedAt: true,
              },
            })
          : null;

      if (claim?.status === 'COMPLETED') {
        const repaired = await client.webhookEvent.updateMany({
          where: this.buildEnqueueStateWhere(event),
          data: {
            status: WebhookStatus.PROCESSED,
            processedAt: claim.completedAt ?? now,
            queueName: null,
            nextEnqueueAt: null,
            timeoutQuarantineExpiresAt: null,
            errorMessage: null,
          },
        });
        return repaired.count === 1 ? 'terminal' : null;
      }

      // FLAG: A lease deadline cannot prove that detached work stopped. Only the worker that
      // observed settlement, or a durably COMPLETED claim, may release this ordered chat head.
      return 'outstanding';
    });

    return transition ?? this.resolveCurrentCandidateOutcome(event.id);
  }

  private async resolveCurrentCandidateOutcome(
    webhookEventId: string,
  ): Promise<CandidateEnqueueOutcome> {
    const current = await this.prisma.webhookEvent.findUnique({
      where: { id: webhookEventId },
      select: {
        status: true,
        nextEnqueueAt: true,
        errorMessage: true,
      },
    });
    if (
      !current ||
      current.status === WebhookStatus.PROCESSED ||
      current.status === WebhookStatus.DUPLICATE ||
      (current.status === WebhookStatus.FAILED &&
        current.nextEnqueueAt === null &&
        !isPendingWebhookTimeoutQuarantineMessage(current.errorMessage))
    ) {
      return 'terminal';
    }

    return 'outstanding';
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
      const userDisplayNameCutoff = new Date(
        Date.now() - this.userDisplayNameRetentionDays * 24 * 60 * 60 * 1_000,
      );
      const phases: RetentionCleanupPhase[] = [
        {
          name: 'webhookProcessedOrDuplicate',
          maxBatches: WEBHOOK_RETENTION_MAX_BATCHES,
          deleteBatch: () => this.deleteCompletedWebhookBatch(webhookCutoff),
        },
        {
          name: 'webhookFailedTerminal',
          maxBatches: DEFAULT_RETENTION_MAX_BATCHES,
          deleteBatch: () => this.deleteTerminalFailedWebhookBatch(failedWebhookCutoff),
        },
        {
          name: 'moderationEvents',
          maxBatches: DEFAULT_RETENTION_MAX_BATCHES,
          deleteBatch: () => this.deleteModerationEventBatch(moderationCutoff),
        },
        {
          name: 'violations',
          maxBatches: DEFAULT_RETENTION_MAX_BATCHES,
          deleteBatch: () => this.deleteViolationBatch(moderationCutoff),
        },
        {
          name: 'violationMessageClaims',
          maxBatches: DEFAULT_RETENTION_MAX_BATCHES,
          deleteBatch: () => this.deleteViolationMessageClaimBatch(moderationCutoff),
        },
        {
          name: 'userDisplayNames',
          maxBatches: DEFAULT_RETENTION_MAX_BATCHES,
          deleteBatch: () => this.deleteUserDisplayNameBatch(userDisplayNameCutoff),
        },
      ];
      const cleanupSummary: Record<string, RetentionCleanupPhaseResult> = {};
      for (const phase of phases) {
        cleanupSummary[phase.name] = await this.runRetentionCleanupPhase(phase);
      }

      this.logger.log(
        {
          phases: cleanupSummary,
          webhookRetentionDays: this.webhookRetentionDays,
          webhookFailedRetentionHours: this.webhookFailedRetentionHours,
          moderationRetentionDays: this.moderationRetentionDays,
          userDisplayNameRetentionDays: this.userDisplayNameRetentionDays,
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

  private async runRetentionCleanupPhase(
    phase: RetentionCleanupPhase,
  ): Promise<RetentionCleanupPhaseResult> {
    const startedAtMs = Date.now();
    let rows = 0;
    let batches = 0;
    let lastBatchRows = 0;

    try {
      while (batches < phase.maxBatches) {
        lastBatchRows = Math.max(0, await phase.deleteBatch());
        rows += lastBatchRows;
        batches += 1;
        if (lastBatchRows < RETENTION_CLEANUP_BATCH_SIZE) {
          break;
        }
        if (batches < phase.maxBatches) {
          await this.waitForRetentionBatchDelay();
        }
      }

      const result: RetentionCleanupPhaseResult = {
        rows,
        batches,
        durationMs: Date.now() - startedAtMs,
        budgetExhausted:
          batches === phase.maxBatches && lastBatchRows === RETENTION_CLEANUP_BATCH_SIZE,
      };
      this.logger.log(
        {
          phase: phase.name,
          ...result,
          maxBatches: phase.maxBatches,
          batchSize: RETENTION_CLEANUP_BATCH_SIZE,
        },
        'Retention cleanup phase finished',
      );
      return result;
    } catch (error: unknown) {
      this.logger.warn(
        {
          phase: phase.name,
          rows,
          batches,
          durationMs: Date.now() - startedAtMs,
          maxBatches: phase.maxBatches,
          batchSize: RETENTION_CLEANUP_BATCH_SIZE,
          err: error instanceof Error ? error.message : String(error),
        },
        'Retention cleanup phase failed',
      );
      throw error;
    }
  }

  private async waitForRetentionBatchDelay(): Promise<void> {
    if (this.retentionBatchDelayMs <= 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, this.retentionBatchDelayMs);
    });
  }

  private async deleteCompletedWebhookBatch(cutoff: Date): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      WITH expired AS (
        SELECT "id"
        FROM "webhook_events"
        WHERE "status" IN ('PROCESSED'::"WebhookStatus", 'DUPLICATE'::"WebhookStatus")
          AND "created_at" < ${cutoff}
        ORDER BY "created_at" ASC, "id" ASC
        LIMIT ${RETENTION_CLEANUP_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "webhook_events" target
      USING expired
      WHERE target."id" = expired."id"
    `);
  }

  private async deleteTerminalFailedWebhookBatch(cutoff: Date): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      WITH expired AS (
        SELECT "id"
        FROM "webhook_events"
        WHERE "status" = CAST(${WebhookStatus.FAILED} AS "WebhookStatus")
          AND "next_enqueue_at" IS NULL
          AND LEFT(COALESCE("error_message", ''), ${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_LENGTH_SQL}) <> ${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_SQL}
          AND "created_at" < ${cutoff}
        ORDER BY "created_at" ASC, "id" ASC
        LIMIT ${RETENTION_CLEANUP_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "webhook_events" target
      USING expired
      WHERE target."id" = expired."id"
    `);
  }

  private async runInTransaction<T>(
    operation: (client: WebhookOutboxPersistenceClient) => Promise<T>,
  ): Promise<T> {
    const transaction = (
      this.prisma as PrismaService & {
        $transaction?: <R>(
          callback: (client: WebhookOutboxPersistenceClient) => Promise<R>,
        ) => Promise<R>;
      }
    ).$transaction;
    if (typeof transaction !== 'function') {
      return operation(this.prisma as unknown as WebhookOutboxPersistenceClient);
    }
    return transaction.call(this.prisma, operation) as Promise<T>;
  }

  private async deleteModerationEventBatch(cutoff: Date): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      WITH expired AS (
        SELECT "id"
        FROM "moderation_events"
        WHERE "created_at" < ${cutoff}
        ORDER BY "created_at" ASC, "id" ASC
        LIMIT ${RETENTION_CLEANUP_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "moderation_events" target
      USING expired
      WHERE target."id" = expired."id"
    `);
  }

  private async deleteViolationBatch(cutoff: Date): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      WITH expired AS (
        SELECT "id"
        FROM "violations"
        WHERE "created_at" < ${cutoff}
        ORDER BY "created_at" ASC, "id" ASC
        LIMIT ${RETENTION_CLEANUP_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "violations" target
      USING expired
      WHERE target."id" = expired."id"
    `);
  }

  private async deleteViolationMessageClaimBatch(cutoff: Date): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      WITH expired AS (
        SELECT "id"
        FROM "moderation_violation_message_claims"
        WHERE "created_at" < ${cutoff}
        ORDER BY "created_at" ASC, "id" ASC
        LIMIT ${RETENTION_CLEANUP_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "moderation_violation_message_claims" target
      USING expired
      WHERE target."id" = expired."id"
    `);
  }

  private async deleteUserDisplayNameBatch(cutoff: Date): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      WITH expired AS (
        SELECT "chat_id", "user_id"
        FROM "chat_user_display_names"
        WHERE "observed_at" < ${cutoff}
        ORDER BY "observed_at" ASC, "chat_id" ASC, "user_id" ASC
        LIMIT ${RETENTION_CLEANUP_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "chat_user_display_names" target
      USING expired
      WHERE target."chat_id" = expired."chat_id"
        AND target."user_id" = expired."user_id"
    `);
  }
}
