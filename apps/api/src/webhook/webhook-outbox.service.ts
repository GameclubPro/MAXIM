import { InjectQueue, getQueueToken } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import {
  WebhookCanonicalExecutionService,
  WebhookTimeoutSettlementCasLostError,
} from '../moderation/webhook-canonical-execution.service';
import { Prisma, WebhookStatus } from '../prisma/prisma-client';
import type { Job, Queue } from 'bullmq';
import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsEnqueue } from '../runtime/app-role';
import { SystemModeService } from '../system/system-mode.service';
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
const WEBHOOK_WORK_UNIT_OVERSCAN_SIZE = 5_000;
const DEGRADED_WEBHOOK_WORK_UNIT_OVERSCAN_SIZE = 1_000;
const DEGRADED_ENQUEUE_BATCH_SIZE = 100;
const DEGRADED_ENQUEUE_CONCURRENCY = 4;
const DEGRADED_QUEUED_REPAIR_INTERVAL_MS = 5_000;
const ENQUEUE_ADMISSION_MODE_CACHE_MS = 5_000;
const RECEIVED_BATCH_SHARE = 0.75;
const RECENT_RECEIPT_BATCH_SHARE = 0.25;
const MEMBERSHIP_LEAVE_WEBHOOK_TYPES = new Set([
  'user_removed',
  'bot_removed',
  'bot_stopped',
  'dialog_removed',
  'message_removed',
]);
const MANUAL_CLOSE_PRIORITY_CACHE_TTL_MS = 5_000;
const MANUAL_CLOSE_PRIORITY_CACHE_PRUNE_THRESHOLD = 4_096;
const WEBHOOK_FAILED_JOB_RETENTION = {
  age: 7 * 24 * 60 * 60,
  count: 5_000,
} as const;
const WEBHOOK_RETENTION_CLEANUP_INTERVAL_MS = 30 * 1_000;
const RETENTION_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1_000;
const RETENTION_CLEANUP_BATCH_SIZE = 500;
const RETENTION_CLEANUP_BATCH_DELAY_MS = 500;
const WEBHOOK_RETENTION_MAX_BATCHES_PER_TICK = 1;
const DEFAULT_RETENTION_MAX_BATCHES = 10;
const WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER = `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`;
const WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_LENGTH_SQL = Prisma.raw(
  String(WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER.length),
);
const WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_SQL = Prisma.raw(
  `'${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER.replaceAll("'", "''")}'`,
);
const WEBHOOK_ENQUEUE_CANDIDATE_DB_COLUMNS_SQL = Prisma.raw(`
  "id",
  "status",
  "bot_id",
  "queue_name",
  "enqueue_attempts",
  "created_at",
  "queued_at",
  "next_enqueue_at",
  "timeout_quarantine_expires_at",
  "error_message",
  "processed_at",
  "normalized_payload"
`);
const ORDERED_WEBHOOK_UPDATE_TYPE_SQL = Prisma.raw(`
  LOWER(
    COALESCE(
      NULLIF(BTRIM("webhook_events"."normalized_payload"->>'type'), ''),
      NULLIF(BTRIM("webhook_events"."normalized_payload"->>'update_type'), '')
    )
  )
`);
const ORDERED_WEBHOOK_CHAT_ID_SQL = Prisma.raw(`
  COALESCE(
    NULLIF(BTRIM("webhook_events"."normalized_payload"->'message'->>'chatId'), ''),
    NULLIF(BTRIM("webhook_events"."normalized_payload"->>'chatId'), '')
  )
`);
const SEMANTIC_WEBHOOK_CHAT_ID_SQL = Prisma.raw(`
  COALESCE(
    NULLIF(BTRIM("webhook_events"."normalized_payload"->'message'->>'chatId'), ''),
    NULLIF(BTRIM("webhook_events"."normalized_payload"->'message'->>'chat_id'), ''),
    NULLIF(BTRIM("webhook_events"."normalized_payload"->>'chatId'), ''),
    NULLIF(BTRIM("webhook_events"."normalized_payload"->>'chat_id'), '')
  )
`);
const ORDERED_WEBHOOK_MESSAGE_ID_SQL = Prisma.raw(`
  COALESCE(
    NULLIF(BTRIM("webhook_events"."normalized_payload"->'message'->>'messageId'), ''),
    NULLIF(BTRIM("webhook_events"."normalized_payload"->'message'->>'message_id'), ''),
    NULLIF(BTRIM("webhook_events"."normalized_payload"->>'messageId'), ''),
    NULLIF(BTRIM("webhook_events"."normalized_payload"->>'message_id'), '')
  )
`);
const COMPLETED_MESSAGE_CREATED_SEMANTIC_OWNER_SQL = Prisma.sql`
  ${ORDERED_WEBHOOK_UPDATE_TYPE_SQL} = 'message_created'
  AND ${SEMANTIC_WEBHOOK_CHAT_ID_SQL} IS NOT NULL
  AND ${ORDERED_WEBHOOK_MESSAGE_ID_SQL} IS NOT NULL
  AND "processed_at" IS NULL
  AND "timeout_quarantine_expires_at" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "webhook_execution_claims" own_claim
    WHERE own_claim."webhook_event_id" = "webhook_events"."id"
      AND own_claim."kind" = 'EXECUTION'
  )
  AND EXISTS (
    SELECT 1
    FROM "webhook_execution_claims" semantic_claim
    JOIN "webhook_events" semantic_owner
      ON semantic_owner."id" = semantic_claim."webhook_event_id"
    WHERE semantic_claim."kind" = 'EXECUTION'
      AND semantic_claim."semantic_key" = CONCAT(
        'message:message_created:',
        ${SEMANTIC_WEBHOOK_CHAT_ID_SQL},
        ':',
        ${ORDERED_WEBHOOK_MESSAGE_ID_SQL}
      )
      AND semantic_claim."webhook_event_id" <> "webhook_events"."id"
      AND semantic_claim."status" = 'COMPLETED'::"WebhookExecutionClaimStatus"
      AND semantic_claim."prepared_at" IS NOT NULL
      AND semantic_claim."completed_at" IS NOT NULL
      AND semantic_claim."lease_token" IS NULL
      AND semantic_claim."lease_expires_at" IS NULL
      AND semantic_owner."status" = 'PROCESSED'::"WebhookStatus"
      AND semantic_owner."processed_at" IS NOT NULL
      AND semantic_owner."error_message" IS NULL
      AND semantic_owner."next_enqueue_at" IS NULL
      AND semantic_owner."timeout_quarantine_expires_at" IS NULL
      AND LOWER(
        COALESCE(
          NULLIF(BTRIM(semantic_owner."normalized_payload"->>'type'), ''),
          NULLIF(BTRIM(semantic_owner."normalized_payload"->>'update_type'), '')
        )
      ) = 'message_created'
      AND COALESCE(
        NULLIF(BTRIM(semantic_owner."normalized_payload"->'message'->>'chatId'), ''),
        NULLIF(BTRIM(semantic_owner."normalized_payload"->'message'->>'chat_id'), ''),
        NULLIF(BTRIM(semantic_owner."normalized_payload"->>'chatId'), ''),
        NULLIF(BTRIM(semantic_owner."normalized_payload"->>'chat_id'), '')
      ) = ${SEMANTIC_WEBHOOK_CHAT_ID_SQL}
      AND COALESCE(
        NULLIF(BTRIM(semantic_owner."normalized_payload"->'message'->>'messageId'), ''),
        NULLIF(BTRIM(semantic_owner."normalized_payload"->'message'->>'message_id'), ''),
        NULLIF(BTRIM(semantic_owner."normalized_payload"->>'messageId'), ''),
        NULLIF(BTRIM(semantic_owner."normalized_payload"->>'message_id'), '')
      ) = ${ORDERED_WEBHOOK_MESSAGE_ID_SQL}
  )
`;
const ORDERED_WEBHOOK_HEAD_STATUS_SQL = Prisma.sql`
  (
    "status" = ANY(ARRAY['RECEIVED', 'QUEUED']::"WebhookStatus"[])
    OR (
      "status" = 'FAILED'::"WebhookStatus"
      AND (
        "next_enqueue_at" IS NOT NULL
        OR LEFT(
          COALESCE("error_message", ''),
          ${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_LENGTH_SQL}
        ) = ${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_SQL}
      )
    )
  )
`;
const ORDERED_WEBHOOK_MESSAGE_SQL = Prisma.sql`
  ${ORDERED_WEBHOOK_UPDATE_TYPE_SQL} = ANY(ARRAY['message_created', 'message_edited'])
  AND ${ORDERED_WEBHOOK_CHAT_ID_SQL} IS NOT NULL
`;
const FAIR_WEBHOOK_WORK_UNIT_KEY_SQL = Prisma.sql`
  CASE
    WHEN ${ORDERED_WEBHOOK_MESSAGE_SQL}
      THEN CONCAT('chat:', ${ORDERED_WEBHOOK_CHAT_ID_SQL})
    ELSE CONCAT('event:', "webhook_events"."id")
  END
`;

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

type WebhookEnqueueAdmission = {
  degraded: boolean;
  batchSize: number;
  enqueueConcurrency: number;
  includeQueuedRepair: boolean;
  expandSelectedChats: boolean;
};

type CandidatePreparationOutcome = 'ready' | 'advance' | 'block';
type CandidateEnqueueOutcome = 'terminal' | 'outstanding' | 'block';

type ManualClosePriorityCacheEntry = {
  prioritized: boolean;
  expiresAtMs: number;
};

type TimeoutExecutionClaim = {
  id?: string;
  semanticKey?: string;
  webhookEventId?: string;
  executionBotId?: string | null;
  enforced?: boolean;
  status?: string;
  preparedAt?: Date | null;
  completedAt?: Date | null;
  leaseToken?: string | null;
  leaseExpiresAt?: Date | null;
};

type WebhookOutboxPersistenceClient = {
  webhookEvent: {
    findUnique?: (args: unknown) => Promise<{
      id: string;
      status: WebhookStatus;
      normalizedPayload: unknown;
      errorMessage: string | null;
      processedAt: Date | null;
      nextEnqueueAt: Date | null;
      timeoutQuarantineExpiresAt: Date | null;
    } | null>;
    updateMany: (args: unknown) => Promise<{ count: number }>;
  };
  webhookExecutionClaim?: {
    findFirst?: (args: unknown) => Promise<TimeoutExecutionClaim | null>;
    findUnique?: (args: unknown) => Promise<TimeoutExecutionClaim | null>;
    updateMany?: (args: unknown) => Promise<{ count?: number }>;
  };
};

function buildEnqueueEligibilitySql(now: Date) {
  const staleUserFacingQueuedBefore = new Date(now.getTime() - USER_FACING_STALE_QUEUED_REPAIR_MS);
  const staleBackgroundQueuedBefore = new Date(now.getTime() - BACKGROUND_STALE_QUEUED_REPAIR_MS);

  return {
    received: Prisma.sql`
      "status" = 'RECEIVED'::"WebhookStatus"
      AND ("next_enqueue_at" IS NULL OR "next_enqueue_at" <= ${now})
    `,
    failed: Prisma.sql`
      "status" = 'FAILED'::"WebhookStatus"
      AND (
        "next_enqueue_at" <= ${now}
        OR (
          "next_enqueue_at" IS NULL
          AND LEFT(
            COALESCE("error_message", ''),
            ${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_LENGTH_SQL}
          ) = ${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_SQL}
          AND EXISTS (
            SELECT 1
            FROM "webhook_execution_claims"
            WHERE "webhook_event_id" = "webhook_events"."id"
              AND "kind" = 'EXECUTION'
              AND "status" = 'COMPLETED'::"WebhookExecutionClaimStatus"
          )
        )
        OR (
          "next_enqueue_at" IS NULL
          AND LEFT(
            COALESCE("error_message", ''),
            ${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_LENGTH_SQL}
          ) = ${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_SQL}
          AND ${COMPLETED_MESSAGE_CREATED_SEMANTIC_OWNER_SQL}
        )
      )
    `,
    staleUserFacingQueued: Prisma.sql`
      "status" = 'QUEUED'::"WebhookStatus"
      AND "processed_at" IS NULL
      AND ("queue_name" IS NULL OR "queue_name" <> ${WEBHOOK_QUEUE_BACKGROUND})
      AND (
        "queued_at" <= ${staleUserFacingQueuedBefore}
        OR ("queued_at" IS NULL AND "created_at" <= ${staleUserFacingQueuedBefore})
      )
      AND ("next_enqueue_at" IS NULL OR "next_enqueue_at" <= ${now})
    `,
    staleBackgroundQueued: Prisma.sql`
      "status" = 'QUEUED'::"WebhookStatus"
      AND "processed_at" IS NULL
      AND "queue_name" = ${WEBHOOK_QUEUE_BACKGROUND}
      AND (
        "queued_at" <= ${staleBackgroundQueuedBefore}
        OR ("queued_at" IS NULL AND "created_at" <= ${staleBackgroundQueuedBefore})
      )
      AND ("next_enqueue_at" IS NULL OR "next_enqueue_at" <= ${now})
    `,
  };
}

function buildBoundedEnqueueWorkUnitsSql(params: {
  eligibility: Prisma.Sql;
  scanDirection: 'ASC' | 'DESC';
  resultDirection: 'ASC' | 'DESC';
  overscanTake: number;
  candidateTake: number;
}): Prisma.Sql {
  const scanDirection = Prisma.raw(params.scanDirection);
  const resultDirection = Prisma.raw(params.resultDirection);

  return Prisma.sql`
    SELECT ${WEBHOOK_ENQUEUE_CANDIDATE_DB_COLUMNS_SQL}
    FROM (
      SELECT DISTINCT ON ("work_unit_key") bounded_pool.*
      FROM (
        SELECT
          ${WEBHOOK_ENQUEUE_CANDIDATE_DB_COLUMNS_SQL},
          ${FAIR_WEBHOOK_WORK_UNIT_KEY_SQL} AS "work_unit_key"
        FROM "webhook_events"
        WHERE ${params.eligibility}
        ORDER BY "created_at" ${scanDirection}, "id" ${scanDirection}
        LIMIT ${params.overscanTake}
      ) bounded_pool
      ORDER BY "work_unit_key" ASC, "created_at" ASC, "id" ASC
    ) collapsed_work_units
    ORDER BY "created_at" ${resultDirection}, "id" ${resultDirection}
    LIMIT ${params.candidateTake}
  `;
}

function buildEmptyEnqueueCandidatesSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT ${WEBHOOK_ENQUEUE_CANDIDATE_DB_COLUMNS_SQL}
    FROM "webhook_events"
    WHERE FALSE
  `;
}

@Injectable()
export class WebhookOutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookOutboxService.name);
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly enqueueConcurrency: number;
  private readonly maxEnqueueAttempts: number;
  private readonly webhookCompletedRetentionEnabled: boolean;
  private readonly webhookRetentionDays: number;
  private readonly webhookFailedRetentionHours: number;
  private readonly moderationRetentionDays: number;
  private readonly userDisplayNameRetentionDays: number;
  private readonly retentionBatchDelayMs = RETENTION_CLEANUP_BATCH_DELAY_MS;

  private poller: NodeJS.Timeout | null = null;
  private cleaner: NodeJS.Timeout | null = null;
  private maintenanceScheduler: NodeJS.Timeout | null = null;
  private retentionMaintenanceDue = false;
  private draining = false;
  private cleaning = false;
  private enqueueAdmissionModeCheckedAtMs = 0;
  private enqueueAdmissionModeKnown = false;
  private enqueueAdmissionDegraded = false;
  private nextDegradedQueuedRepairAtMs = 0;
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
    private readonly systemModeService: SystemModeService,
  ) {
    this.enabled = roleRunsEnqueue(getAppRole());
    this.pollIntervalMs = this.configService.get<number>('ENQUEUE_POLL_INTERVAL_MS', 200);
    this.batchSize = this.configService.get<number>('ENQUEUE_BATCH_SIZE', 400);
    this.enqueueConcurrency = this.configService.get<number>('ENQUEUE_CONCURRENCY', 32);
    this.maxEnqueueAttempts = this.configService.get<number>('ENQUEUE_MAX_ATTEMPTS', 120);
    this.webhookCompletedRetentionEnabled = this.configService.get<boolean>(
      'WEBHOOK_COMPLETED_RETENTION_ENABLED',
      false,
    );
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

    this.maintenanceScheduler = setInterval(() => {
      this.retentionMaintenanceDue = true;
    }, RETENTION_MAINTENANCE_INTERVAL_MS);
    this.maintenanceScheduler.unref();

    this.cleaner = setInterval(() => {
      void this.cleanupRetention();
    }, WEBHOOK_RETENTION_CLEANUP_INTERVAL_MS);
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
    if (this.maintenanceScheduler) {
      clearInterval(this.maintenanceScheduler);
      this.maintenanceScheduler = null;
    }
    this.retentionMaintenanceDue = false;
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
    const admission = await this.resolveEnqueueAdmission(now);
    const candidates = await this.selectEnqueueCandidates(now, admission);

    const prioritizedCandidates = await this.prioritizeCandidates(
      candidates,
      now,
      admission.batchSize,
    );
    let expandedCandidates = prioritizedCandidates;
    if (admission.expandSelectedChats) {
      try {
        expandedCandidates = await this.expandSelectedChatCandidates(prioritizedCandidates, now);
      } catch (error: unknown) {
        this.logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            selectedCandidateCount: prioritizedCandidates.length,
            selectedChatCount: new Set(
              prioritizedCandidates.flatMap((candidate) => {
                const chatId = this.extractPriorityChatId(candidate.normalizedPayload);
                return chatId ? [chatId] : [];
              }),
            ).size,
          },
          'Failed to expand selected webhook chats; enqueueing the selected heads only',
        );
      }
    }

    await this.enqueueCandidates(expandedCandidates, admission.enqueueConcurrency);
  }

  private defaultEnqueueAdmission(): WebhookEnqueueAdmission {
    return {
      degraded: false,
      batchSize: this.batchSize,
      enqueueConcurrency: this.enqueueConcurrency,
      includeQueuedRepair: true,
      expandSelectedChats: true,
    };
  }

  private async resolveEnqueueAdmission(now: Date): Promise<WebhookEnqueueAdmission> {
    const nowMs = now.getTime();
    if (nowMs - this.enqueueAdmissionModeCheckedAtMs >= ENQUEUE_ADMISSION_MODE_CACHE_MS) {
      this.enqueueAdmissionModeCheckedAtMs = nowMs;
      try {
        await this.systemModeService.getEffectiveSnapshot();
        const sharedSnapshot = this.systemModeService.peekCachedSnapshot(
          ENQUEUE_ADMISSION_MODE_CACHE_MS,
        );
        if (!sharedSnapshot) {
          throw new Error('System mode shared snapshot was unavailable');
        }
        this.enqueueAdmissionDegraded = sharedSnapshot.mode === 'degrade';
        this.enqueueAdmissionModeKnown = true;
      } catch (error: unknown) {
        // FLAG: Keep ingesting if no shared mode has ever been observed, but never lift a known
        // degraded admission state because a later shared snapshot read failed.
        if (!this.enqueueAdmissionModeKnown) {
          this.enqueueAdmissionDegraded = false;
        }
        this.logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            keptDegradedAdmission: this.enqueueAdmissionDegraded,
          },
          'Failed to read system mode for webhook enqueue admission',
        );
      }
    }

    if (!this.enqueueAdmissionDegraded) {
      return this.defaultEnqueueAdmission();
    }

    const includeQueuedRepair = nowMs >= this.nextDegradedQueuedRepairAtMs;
    if (includeQueuedRepair) {
      this.nextDegradedQueuedRepairAtMs = nowMs + DEGRADED_QUEUED_REPAIR_INTERVAL_MS;
    }

    return {
      degraded: true,
      batchSize: Math.min(this.batchSize, DEGRADED_ENQUEUE_BATCH_SIZE),
      enqueueConcurrency: Math.min(this.enqueueConcurrency, DEGRADED_ENQUEUE_CONCURRENCY),
      includeQueuedRepair,
      // Queue repairs and exact-head fences keep order; the optional expansion is throughput work.
      expandSelectedChats: false,
    };
  }

  private async selectEnqueueCandidates(
    now: Date,
    admission: WebhookEnqueueAdmission = this.defaultEnqueueAdmission(),
  ): Promise<WebhookEnqueueCandidate[]> {
    const selectionWindowSize = this.resolvePrioritySelectionWindowSize(admission.batchSize);
    const recentReceiptTake = this.resolveRecentReceiptTake(selectionWindowSize);
    const backlogReceiptTake = selectionWindowSize - recentReceiptTake;
    const eligibility = buildEnqueueEligibilitySql(now);
    const overscanTake = Math.max(
      selectionWindowSize,
      admission.degraded
        ? DEGRADED_WEBHOOK_WORK_UNIT_OVERSCAN_SIZE
        : WEBHOOK_WORK_UNIT_OVERSCAN_SIZE,
    );
    const backlogReceiptCandidatesSql = buildBoundedEnqueueWorkUnitsSql({
      eligibility: eligibility.received,
      scanDirection: 'ASC',
      resultDirection: 'ASC',
      overscanTake,
      candidateTake: backlogReceiptTake,
    });
    const recentReceiptCandidatesSql = buildBoundedEnqueueWorkUnitsSql({
      eligibility: eligibility.received,
      scanDirection: 'DESC',
      resultDirection: 'DESC',
      overscanTake,
      candidateTake: recentReceiptTake,
    });
    const failedCandidatesSql = buildBoundedEnqueueWorkUnitsSql({
      eligibility: eligibility.failed,
      scanDirection: 'ASC',
      resultDirection: 'ASC',
      overscanTake,
      candidateTake: selectionWindowSize,
    });
    const staleUserFacingQueuedCandidatesSql = admission.includeQueuedRepair
      ? buildBoundedEnqueueWorkUnitsSql({
          eligibility: eligibility.staleUserFacingQueued,
          scanDirection: 'ASC',
          resultDirection: 'ASC',
          overscanTake,
          candidateTake: selectionWindowSize,
        })
      : buildEmptyEnqueueCandidatesSql();
    const staleBackgroundQueuedCandidatesSql = admission.includeQueuedRepair
      ? buildBoundedEnqueueWorkUnitsSql({
          eligibility: eligibility.staleBackgroundQueued,
          scanDirection: 'ASC',
          resultDirection: 'ASC',
          overscanTake,
          candidateTake: selectionWindowSize,
        })
      : buildEmptyEnqueueCandidatesSql();

    // Collapse a bounded raw pool into chat/event work units; exact ordered heads are fenced before CAS.
    const candidates = await this.prisma.$queryRaw<WebhookEnqueueCandidate[]>(Prisma.sql`
      /* fair_enqueue_candidates */
      WITH backlog_receipt_candidates AS (
        ${backlogReceiptCandidatesSql}
      ),
      recent_receipt_candidates AS (
        ${recentReceiptCandidatesSql}
      ),
      failed_candidates AS (
        ${failedCandidatesSql}
      ),
      stale_user_facing_queued_candidates AS (
        ${staleUserFacingQueuedCandidatesSql}
      ),
      stale_background_queued_candidates AS (
        ${staleBackgroundQueuedCandidatesSql}
      )
      SELECT
        "id",
        "status",
        "bot_id" AS "botId",
        "queue_name" AS "queueName",
        "enqueue_attempts" AS "enqueueAttempts",
        "created_at" AS "createdAt",
        "queued_at" AS "queuedAt",
        "next_enqueue_at" AS "nextEnqueueAt",
        "timeout_quarantine_expires_at" AS "timeoutQuarantineExpiresAt",
        "error_message" AS "errorMessage",
        "normalized_payload" AS "normalizedPayload",
        "isRecentReceipt"
      FROM (
        SELECT backlog_receipt_candidates.*, FALSE AS "isRecentReceipt", 0 AS "selectionGroup"
        FROM backlog_receipt_candidates
        UNION ALL
        SELECT recent_receipt_candidates.*, TRUE AS "isRecentReceipt", 1 AS "selectionGroup"
        FROM recent_receipt_candidates
        UNION ALL
        SELECT failed_candidates.*, FALSE AS "isRecentReceipt", 2 AS "selectionGroup"
        FROM failed_candidates
        UNION ALL
        SELECT
          stale_user_facing_queued_candidates.*,
          FALSE AS "isRecentReceipt",
          3 AS "selectionGroup"
        FROM stale_user_facing_queued_candidates
        UNION ALL
        SELECT
          stale_background_queued_candidates.*,
          FALSE AS "isRecentReceipt",
          4 AS "selectionGroup"
        FROM stale_background_queued_candidates
      ) selected
      ORDER BY
        "selectionGroup" ASC,
        CASE WHEN "selectionGroup" = 1 THEN "created_at" END DESC,
        CASE WHEN "selectionGroup" <> 1 THEN "created_at" END ASC,
        CASE WHEN "selectionGroup" = 1 THEN "id" END DESC,
        CASE WHEN "selectionGroup" <> 1 THEN "id" END ASC
    `);

    return this.mergeEnqueueCandidates(candidates, selectionWindowSize);
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

    const uniqueWorkUnits = new Map<string, WebhookEnqueueCandidate>();
    for (const candidate of uniqueById.values()) {
      const chatId = this.extractPriorityChatId(candidate.normalizedPayload);
      const workUnitKey = chatId ? `chat:${chatId}` : `event:${candidate.id}`;
      const existing = uniqueWorkUnits.get(workUnitKey);
      if (!existing || this.compareCandidateSequence(candidate, existing) < 0) {
        uniqueWorkUnits.set(workUnitKey, candidate);
      }
    }

    return this.selectCandidatesWithReceiptReserve(Array.from(uniqueWorkUnits.values()), take)
      .sort((left, right) => this.compareCandidateSequence(left, right))
      .slice(0, take);
  }

  private resolvePrioritySelectionWindowSize(batchSize = this.batchSize): number {
    return Math.max(
      batchSize,
      Math.min(batchSize * PRIORITY_SELECTION_WINDOW_MULTIPLIER, MAX_PRIORITY_SELECTION_WINDOW),
    );
  }

  private async prioritizeCandidates(
    candidates: WebhookEnqueueCandidate[],
    now: Date,
    take = this.batchSize,
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
    const selectedCandidates = this.selectCandidatesWithReceiptReserve(prioritizedCandidates, take);
    return this.ensureMembershipLeaveReserve(prioritizedCandidates, selectedCandidates, take).sort(
      (left, right) => this.comparePrioritizedCandidates(left, right),
    );
  }

  private ensureMembershipLeaveReserve<T extends WebhookEnqueueCandidate>(
    candidates: readonly T[],
    selectedCandidates: readonly T[],
    take: number,
  ): T[] {
    const selected = [...selectedCandidates];
    if (take < 2 || selected.some((candidate) => this.isMembershipLeaveCandidate(candidate))) {
      return selected;
    }

    const selectedIds = new Set(selected.map((candidate) => candidate.id));
    const reservedCandidate = candidates.find(
      (candidate) => !selectedIds.has(candidate.id) && this.isMembershipLeaveCandidate(candidate),
    );
    if (!reservedCandidate) {
      return selected;
    }

    if (selected.length < take) {
      selected.push(reservedCandidate);
      return selected;
    }

    const reservedIsReceipt = reservedCandidate.status === WebhookStatus.RECEIVED;
    let sameLaneReplacementIndex = -1;
    let fallbackReplacementIndex = -1;
    for (let index = selected.length - 1; index >= 0; index -= 1) {
      const candidate = selected[index]!;
      if (this.isMembershipLeaveCandidate(candidate)) {
        continue;
      }
      if (fallbackReplacementIndex < 0) {
        fallbackReplacementIndex = index;
      }
      if ((candidate.status === WebhookStatus.RECEIVED) === reservedIsReceipt) {
        sameLaneReplacementIndex = index;
        break;
      }
    }
    const replacementIndex =
      sameLaneReplacementIndex >= 0 ? sameLaneReplacementIndex : fallbackReplacementIndex;
    if (replacementIndex >= 0) {
      selected[replacementIndex] = reservedCandidate;
    }
    return selected;
  }

  private isMembershipLeaveCandidate(candidate: WebhookEnqueueCandidate): boolean {
    return MEMBERSHIP_LEAVE_WEBHOOK_TYPES.has(extractWebhookType(candidate.normalizedPayload));
  }

  private async expandSelectedChatCandidates(
    selectedCandidates: PrioritizedWebhookEnqueueCandidate[],
    now: Date,
  ): Promise<PrioritizedWebhookEnqueueCandidate[]> {
    const selectedChatIds = Array.from(
      new Set(
        selectedCandidates.flatMap((candidate) => {
          const chatId = this.extractPriorityChatId(candidate.normalizedPayload);
          return chatId ? [chatId] : [];
        }),
      ),
    );
    if (selectedChatIds.length === 0) {
      return selectedCandidates;
    }

    const eligibility = buildEnqueueEligibilitySql(now);
    // Expand only after work-unit quota selection so terminal heads can advance without starving peers.
    const expandedCandidates = await this.prisma.$queryRaw<WebhookEnqueueCandidate[]>(Prisma.sql`
      /* selected_chat_candidates */
      SELECT
        "id",
        "status",
        "bot_id" AS "botId",
        "queue_name" AS "queueName",
        "enqueue_attempts" AS "enqueueAttempts",
        "created_at" AS "createdAt",
        "queued_at" AS "queuedAt",
        "next_enqueue_at" AS "nextEnqueueAt",
        "timeout_quarantine_expires_at" AS "timeoutQuarantineExpiresAt",
        "error_message" AS "errorMessage",
        "normalized_payload" AS "normalizedPayload",
        FALSE AS "isRecentReceipt"
      FROM "webhook_events"
      WHERE ${ORDERED_WEBHOOK_HEAD_STATUS_SQL}
        AND ${ORDERED_WEBHOOK_MESSAGE_SQL}
        AND ${ORDERED_WEBHOOK_CHAT_ID_SQL} IN (${Prisma.join(selectedChatIds)})
        AND (
          (${eligibility.received})
          OR (${eligibility.failed})
          OR (${eligibility.staleUserFacingQueued})
          OR (${eligibility.staleBackgroundQueued})
        )
      ORDER BY "created_at" ASC, "id" ASC
      LIMIT ${this.resolvePrioritySelectionWindowSize()}
    `);
    if (expandedCandidates.length === 0) {
      return selectedCandidates;
    }

    const manualCloseChatIds = await this.resolveManualClosePriorityChatIds(
      expandedCandidates,
      now,
    );
    const candidatesById = new Map(
      selectedCandidates.map((candidate) => [candidate.id, candidate] as const),
    );
    for (const candidate of expandedCandidates) {
      if (candidatesById.has(candidate.id)) {
        continue;
      }
      candidatesById.set(candidate.id, {
        ...candidate,
        priority: this.resolveCandidatePriority(candidate, manualCloseChatIds),
      });
    }

    return Array.from(candidatesById.values());
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

  private async enqueueCandidates(
    candidates: PrioritizedWebhookEnqueueCandidate[],
    enqueueConcurrency = this.enqueueConcurrency,
  ) {
    if (candidates.length === 0) {
      return;
    }

    const workUnits = this.buildEnqueueWorkUnits(candidates);
    const orderedHeadsByChatId = await this.findOrderedWebhookHeadsForChats(
      workUnits.flatMap((workUnit) => (workUnit.chatId ? [workUnit.chatId] : [])),
    );
    const workerCount = Math.max(1, Math.min(enqueueConcurrency, workUnits.length));
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
      JOIN LATERAL (
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
    // FLAG: Queue activation is committed before Queue.add, so this exact state cannot own a job.
    const existingJob = this.canSkipExistingJobLookupForPristineReceivedEvent(event)
      ? null
      : await this.findExistingJob(webhookEventId, queueName);
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

  private canSkipExistingJobLookupForPristineReceivedEvent(
    event: WebhookEnqueueCandidate,
  ): boolean {
    return (
      event.status === WebhookStatus.RECEIVED &&
      event.enqueueAttempts === 0 &&
      event.queueName === null &&
      event.queuedAt === null &&
      event.nextEnqueueAt === null &&
      event.timeoutQuarantineExpiresAt === null &&
      event.errorMessage === null
    );
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
      if (error instanceof WebhookPreparationDeferredError) {
        const deferOutcome = await this.deferPreparationWithoutExhaustion(event, error);
        return deferOutcome === 'terminal' ? 'advance' : 'block';
      }
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

  private async deferPreparationWithoutExhaustion(
    event: WebhookEnqueueStateSnapshot,
    error: WebhookPreparationDeferredError,
  ): Promise<CandidateEnqueueOutcome> {
    // FLAG: RECEIVED keeps the persisted envelope outside terminal-failure retention and attempt caps.
    const result = await this.prisma.webhookEvent.updateMany({
      where: this.buildEnqueueStateWhere(event),
      data: {
        status: WebhookStatus.RECEIVED,
        errorMessage: `Webhook preparation deferred: ${error.message}`.slice(0, 500),
        queueName: null,
        queuedAt: null,
        nextEnqueueAt: new Date(Date.now() + error.retryAfterMs),
        timeoutQuarantineExpiresAt: null,
      },
    });
    return result.count === 1 ? 'block' : this.resolveCurrentCandidateOutcome(event.id);
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
    let transition: CandidateEnqueueOutcome | null;
    try {
      transition = await this.runInTransaction(async (client) => {
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

        const mirrorSettlement =
          await WebhookCanonicalExecutionService.trySettleCompletedShadowMirrorWithClient(
            client,
            {
              webhookEvent: { id: event.id },
              update: event.normalizedPayload,
              businessLeaseToken: null,
            },
            {
              ...this.buildEnqueueStateWhere(event),
              processedAt: null,
            },
          );
        if (mirrorSettlement === 'settled') {
          return 'terminal';
        }

        // FLAG: A lease deadline cannot prove that detached work stopped. Only the worker that
        // observed settlement, or a fully proven COMPLETED semantic owner, may release this head.
        return 'outstanding';
      });
    } catch (error: unknown) {
      if (error instanceof WebhookTimeoutSettlementCasLostError) {
        return 'outstanding';
      }
      throw error;
    }

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
    if (!this.webhookCompletedRetentionEnabled && !this.retentionMaintenanceDue) {
      return;
    }
    this.cleaning = true;
    let runMaintenance = false;
    try {
      const nowMs = Date.now();
      runMaintenance = this.retentionMaintenanceDue;
      if (runMaintenance) {
        this.retentionMaintenanceDue = false;
      }

      const webhookCutoff = new Date(nowMs - this.webhookRetentionDays * 24 * 60 * 60 * 1_000);
      const failedWebhookCutoff = new Date(
        nowMs - this.webhookFailedRetentionHours * 60 * 60 * 1_000,
      );
      const moderationCutoff = new Date(
        nowMs - this.moderationRetentionDays * 24 * 60 * 60 * 1_000,
      );
      const userDisplayNameCutoff = new Date(
        nowMs - this.userDisplayNameRetentionDays * 24 * 60 * 60 * 1_000,
      );
      const phases: RetentionCleanupPhase[] = [];
      if (this.webhookCompletedRetentionEnabled) {
        phases.push({
          name: 'webhookProcessedOrDuplicate',
          maxBatches: WEBHOOK_RETENTION_MAX_BATCHES_PER_TICK,
          deleteBatch: () => this.deleteCompletedWebhookBatch(webhookCutoff),
        });
      }
      if (runMaintenance) {
        phases.push(
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
        );
      }
      const cleanupSummary: Record<string, RetentionCleanupPhaseResult> = {};
      for (const phase of phases) {
        cleanupSummary[phase.name] = await this.runRetentionCleanupPhase(phase);
      }
      this.logger.log(
        {
          phases: cleanupSummary,
          webhookCompletedRetentionEnabled: this.webhookCompletedRetentionEnabled,
          webhookRetentionDays: this.webhookRetentionDays,
          webhookFailedRetentionHours: this.webhookFailedRetentionHours,
          moderationRetentionDays: this.moderationRetentionDays,
          userDisplayNameRetentionDays: this.userDisplayNameRetentionDays,
          maintenanceRun: runMaintenance,
          maintenancePending: this.retentionMaintenanceDue,
        },
        'Retention cleanup finished',
      );
    } catch (error: unknown) {
      if (runMaintenance) {
        this.retentionMaintenanceDue = true;
      }
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
