import {
  buildBoundedEnqueueWorkUnitsSql,
  type OutboxScanState,
  type OutboxScanProgress,
} from './webhook-outbox-scan';
import { InjectQueue, getQueueToken } from '@nestjs/bullmq';
import type { MaxUpdate } from '@maxim/contracts';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { WebhookLegacyHoldService, legacyOrderReleasedSql } from './webhook-legacy-hold.service';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { SanctionHistoryRetention } from '../moderation/sanction-history-retention';
import {
  WebhookCanonicalExecutionService,
  WebhookTimeoutSettlementCasLostError,
} from '../moderation/webhook-canonical-execution.service';
import { Prisma, WebhookStatus } from '../prisma/prisma-client';
import type { Job, Queue } from 'bullmq';
import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import { expireUnclaimedGroupStarts } from '../common/group-command-start-expiry';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsEnqueue } from '../runtime/app-role';
import { RuntimeWorkerOwner, type RuntimeWorker } from '../runtime/runtime-worker-shutdown';
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
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { MULTIBOT_EXECUTION_AUTHORITY_VERSION } from './webhook-semantic-authority';
import { describeWebhookPreparationFailure } from './webhook-preparation-diagnostic';
import {
  isPendingWebhookTimeoutQuarantineMessage,
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX,
} from './webhook-timeout-quarantine';

const ANY_WEBHOOK_QUEUE_NAMES = new Set<string>(ALL_WEBHOOK_QUEUE_NAMES);
const USER_FACING_STALE_QUEUED_REPAIR_MS = 20_000;
const BACKGROUND_STALE_QUEUED_REPAIR_MS = 120_000;
const PRIORITY_SELECTION_WINDOW_MULTIPLIER = 3;
const MAX_PRIORITY_SELECTION_WINDOW = 1_000;
const SELECTED_CHAT_EXPANSION_MAX_PER_CHAT = 16;
const WEBHOOK_WORK_UNIT_OVERSCAN_SIZE = 5_000;
const DEGRADED_WEBHOOK_WORK_UNIT_OVERSCAN_SIZE = 1_000;
const DEGRADED_ENQUEUE_BATCH_SIZE = 100;
// FLAG: Keep pressure-mode fanout at the api-enqueue DB pool width. A higher ceiling increased
// production I/O wait without improving receipt cursor throughput.
const DEGRADED_ENQUEUE_CONCURRENCY = 4;
const DEGRADED_QUEUED_REPAIR_INTERVAL_MS = 5_000;
const ENQUEUE_ADMISSION_MODE_CACHE_MS = 5_000;
const COMPLETED_TIMEOUT_REPAIR_INTERVAL_MS = 5_000;
const COMPLETED_TIMEOUT_REPAIR_RAW_ROWS = 200;
const FINISHED_HEAD_RECOVERY_BUDGET_MS = 250;
const FINISHED_HEAD_RECOVERY_INTERVAL_MS = 1_000;
const SLOW_ENQUEUE_BATCH_MS = 1_000;
const ENQUEUE_DISPATCH_BUDGET_MS = 1_000;
const SLOW_ENQUEUE_BATCH_LOG_INTERVAL_MS = 30_000;
const CANONICAL_PREPARATION_PENDING_RETRY_MS = 1_000;
const RECEIVED_BATCH_SHARE = 0.75;
const RECENT_RECEIPT_BATCH_SHARE = 0.25;
const AGED_RECEIPT_RESERVE_SHARE = 0.25;
const AGED_RECEIPT_WAIT_MS = 60_000;
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
  "legacy_disposition_id",
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
  AND NOT ${legacyOrderReleasedSql('webhook_events')}
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
  deleteBatch: () => Promise<number | { removed: number; scanned: number }>;
};

type RetentionCleanupPhaseResult = {
  rows: number;
  scannedRows: number;
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
  isBacklogScan?: boolean;
  scanProgress?: OutboxScanProgress | null;
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
  includeCompletedTimeoutRepair: boolean;
  expandSelectedChats: boolean;
};

type CandidatePreparationOutcome = 'ready' | 'advance' | 'block';
type CandidateEnqueueOutcome = 'terminal' | 'outstanding' | 'block';

function createEnqueueProgress() {
  return {
    workUnits: 0,
    orderedHeadBlocked: 0,
    preparationBlocked: 0,
    preparationSharedCapacityBlocked: 0,
    preparationScopeBlocked: 0,
    prepared: 0,
    settled: 0,
    outstanding: 0,
    enqueueBlocked: 0,
    workUnitErrors: 0,
  };
}

type EnqueueProgress = ReturnType<typeof createEnqueueProgress>;

type ManualClosePriorityCacheEntry = {
  prioritized: boolean;
  expiresAtMs: number;
};

type TimeoutExecutionClaim = {
  id?: string;
  semanticKey?: string;
  webhookEventId?: string | null;
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
      dedupKey?: string;
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

function buildEnqueueEligibilitySql(now: Date, includeCompletedTimeoutRepair = true) {
  const staleUserFacingQueuedBefore = new Date(now.getTime() - USER_FACING_STALE_QUEUED_REPAIR_MS);
  const staleBackgroundQueuedBefore = new Date(now.getTime() - BACKGROUND_STALE_QUEUED_REPAIR_MS);

  return {
    received: Prisma.sql`
      "legacy_disposition_id" IS NULL
      AND "status" = 'RECEIVED'::"WebhookStatus"
      AND ("next_enqueue_at" IS NULL OR "next_enqueue_at" <= ${now})
    `,
    failed: Prisma.sql`
      "legacy_disposition_id" IS NULL
      AND "status" = 'FAILED'::"WebhookStatus"
      AND (
        "next_enqueue_at" <= ${now}
        ${
          includeCompletedTimeoutRepair
            ? Prisma.sql`OR (
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
        )`
            : Prisma.empty
        }
      )
    `,
    staleUserFacingQueued: Prisma.sql`
      "legacy_disposition_id" IS NULL
      AND "status" = 'QUEUED'::"WebhookStatus"
      AND "processed_at" IS NULL
      AND ("queue_name" IS NULL OR "queue_name" <> ${WEBHOOK_QUEUE_BACKGROUND})
      AND (
        "queued_at" <= ${staleUserFacingQueuedBefore}
        OR ("queued_at" IS NULL AND "created_at" <= ${staleUserFacingQueuedBefore})
      )
      AND ("next_enqueue_at" IS NULL OR "next_enqueue_at" <= ${now})
    `,
    staleBackgroundQueued: Prisma.sql`
      "legacy_disposition_id" IS NULL
      AND "status" = 'QUEUED'::"WebhookStatus"
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

function buildEmptyEnqueueCandidatesSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT ${WEBHOOK_ENQUEUE_CANDIDATE_DB_COLUMNS_SQL}, FALSE AS "isBacklogScan", NULL::jsonb AS "scanProgress"
    FROM "webhook_events"
    WHERE FALSE
  `;
}

@Injectable()
export class WebhookOutboxService
  extends RuntimeWorkerOwner
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WebhookOutboxService.name);
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly enqueueConcurrency: number;
  private readonly maxEnqueueAttempts: number;
  private readonly webhookCompletedRetentionEnabled: boolean;
  private readonly webhookFailedRetentionEnabled: boolean;
  private readonly webhookRetentionDays: number;
  private readonly webhookFailedRetentionHours: number;
  private readonly moderationRetentionDays: number;
  private readonly sanctionHistoryRetention = new SanctionHistoryRetention();
  private readonly userDisplayNameRetentionDays: number;
  private readonly retentionBatchDelayMs = RETENTION_CLEANUP_BATCH_DELAY_MS;

  private enqueueScans?: Map<string, OutboxScanState>;
  private enqueueScanReserveOffset = 0;
  private pendingEnqueueRepresentatives?: Map<string, string>;
  private finishedHeadRecoveryOffset = 0;
  private finishedOwnerRecoveryOffset = 0;
  private nextFinishedHeadRecoveryAt = 0;
  private poller: NodeJS.Timeout | null = null;
  private polling = false;
  private cleaner: NodeJS.Timeout | null = null;
  private maintenanceScheduler: NodeJS.Timeout | null = null;
  private retentionMaintenanceDue = false;
  private draining = false;
  private shuttingDown = false;
  private activeTick: Promise<void> | null = null;
  private readonly activeEnqueueUnits = new Map<string, Promise<void>>();
  private cleaning = false;
  private webhookHeldRetentionTurn = false;
  private readonly webhookRetentionCursors = new Map<string, { id: string; createdAt: Date }>();
  private enqueueAdmissionModeCheckedAtMs = 0;
  private enqueueAdmissionModeKnown = false;
  private enqueueAdmissionDegraded = false;
  private nextDegradedQueuedRepairAtMs = 0;
  private nextCompletedTimeoutRepairAtMs = 0;
  private nextSlowEnqueueBatchLogAtMs = 0;
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
    @Optional() private readonly legacyHolds?: WebhookLegacyHoldService,
  ) {
    super();
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
    this.webhookFailedRetentionEnabled = this.configService.get<boolean>(
      'WEBHOOK_FAILED_RETENTION_ENABLED',
      false,
    );
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
    if (!this.enabled || this.polling) {
      return;
    }
    this.polling = true;

    this.maintenanceScheduler = setInterval(() => {
      this.retentionMaintenanceDue = true;
    }, RETENTION_MAINTENANCE_INTERVAL_MS);
    this.maintenanceScheduler.unref();

    this.cleaner = setInterval(() => {
      void this.cleanupRetention();
    }, WEBHOOK_RETENTION_CLEANUP_INTERVAL_MS);
    this.cleaner.unref();

    void this.poll();
  }

  stopWorkerAdmission(): readonly RuntimeWorker[] {
    this.stopPolling();
    return [
      {
        name: 'webhook-outbox',
        pause: async () => this.drainEnqueueUnits(),
        close: async (force) => {
          if (!force) await this.drainEnqueueUnits();
        },
      },
    ];
  }

  async onModuleDestroy() {
    this.stopPolling();
    await this.drainEnqueueUnits();
  }

  private stopPolling() {
    this.shuttingDown = true;
    this.polling = false;
    if (this.poller) {
      clearTimeout(this.poller);
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

  private async drainEnqueueUnits() {
    // FLAG: Work remains owned across polls. Stop selecting first, then drain each
    // admitted operation before the module releases its SQL/Redis dependencies.
    await this.activeTick;
    await Promise.all(this.activeEnqueueUnits.values());
  }

  private async poll() {
    const startedAt = performance.now();
    await this.tick();
    if (!this.polling) return;
    // FLAG: Serialize selection, not unrelated in-flight chat work. A slow operation
    // retains its own slot and chat fence while fresh polls may use other slots.
    // A selection that outlives its interval must not wait another fixed timer slot.
    this.poller = setTimeout(
      () => {
        this.poller = null;
        void this.poll();
      },
      Math.max(0, this.pollIntervalMs - (performance.now() - startedAt)),
    );
    this.poller.unref();
  }

  private tick(): Promise<void> {
    if (this.draining || this.shuttingDown) return Promise.resolve();
    this.draining = true;
    const tick = this.enqueueBatch()
      .catch((error: unknown) => {
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'Failed to enqueue webhook batch',
        );
      })
      .finally(() => {
        this.draining = false;
        this.activeTick = null;
      });
    this.activeTick = tick;
    return tick;
  }

  private async enqueueBatch() {
    const now = new Date();
    const admission = await this.resolveEnqueueAdmission(now);
    const pendingCandidates = await this.readPendingEnqueueRepresentatives(
      now,
      admission.batchSize,
    );
    const admissionFinishedAtMs = Date.now();
    let candidates: WebhookEnqueueCandidate[];
    try {
      candidates = this.mergeEnqueueCandidates(
        [...pendingCandidates, ...(await this.selectEnqueueCandidates(now, admission))],
        this.resolvePrioritySelectionWindowSize(admission.batchSize),
      );
    } finally {
      // FLAG: Leave live/due-only polls after slow or failed recovery scans too.
      // Scheduling only from the start can make a >5s scan run on every poll.
      if (admission.includeCompletedTimeoutRepair) {
        this.nextCompletedTimeoutRepairAtMs = Date.now() + COMPLETED_TIMEOUT_REPAIR_INTERVAL_MS;
      }
    }
    const selectionFinishedAtMs = Date.now();

    const prioritizedCandidates = await this.prioritizeCandidates(
      candidates,
      now,
      admission.batchSize,
    );
    let expandedCandidates = prioritizedCandidates;
    if (admission.expandSelectedChats) {
      try {
        expandedCandidates = await this.expandSelectedChatCandidates(
          prioritizedCandidates,
          now,
          admission.includeCompletedTimeoutRepair,
        );
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

    const prioritizationFinishedAtMs = Date.now();
    const progress = await this.enqueueCandidates(expandedCandidates, admission.enqueueConcurrency);
    const finishedAtMs = Date.now();
    const durationMs = finishedAtMs - now.getTime();
    if (
      (durationMs >= SLOW_ENQUEUE_BATCH_MS || candidates.length > 0) &&
      finishedAtMs >= this.nextSlowEnqueueBatchLogAtMs
    ) {
      this.nextSlowEnqueueBatchLogAtMs = finishedAtMs + SLOW_ENQUEUE_BATCH_LOG_INTERVAL_MS;
      const log = durationMs >= SLOW_ENQUEUE_BATCH_MS ? 'warn' : 'log';
      this.logger[log](
        {
          durationMs,
          admissionMs: admissionFinishedAtMs - now.getTime(),
          selectionMs: selectionFinishedAtMs - admissionFinishedAtMs,
          prioritizationMs: prioritizationFinishedAtMs - selectionFinishedAtMs,
          enqueueMs: finishedAtMs - prioritizationFinishedAtMs,
          candidateCount: candidates.length,
          selectedCount: expandedCandidates.length,
          degraded: admission.degraded,
          completedTimeoutRepair: admission.includeCompletedTimeoutRepair,
          progress,
          inFlightWorkUnits: this.activeEnqueueUnits.size,
        },
        durationMs >= SLOW_ENQUEUE_BATCH_MS
          ? 'Slow webhook enqueue batch'
          : 'Webhook enqueue batch progress',
      );
    }
  }

  private defaultEnqueueAdmission(): WebhookEnqueueAdmission {
    return {
      degraded: false,
      batchSize: this.batchSize,
      enqueueConcurrency: this.enqueueConcurrency,
      includeQueuedRepair: true,
      includeCompletedTimeoutRepair: true,
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
        // FLAG: One ordered poison scope may raise oldest lag without shared pressure.
        // Keep independent chats admitted; MAX/mixed/unknown degradation retains the cap.
        this.enqueueAdmissionDegraded =
          sharedSnapshot.mode === 'degrade' &&
          !(
            sharedSnapshot.source === 'auto' &&
            sharedSnapshot.manualMode === null &&
            sharedSnapshot.condition === 'queue_backlog'
          );
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

    // FLAG: Retained timeout settlement probes claims/owners. Pace that recovery only;
    // due retries and live receipts must remain eligible on every poll.
    const includeCompletedTimeoutRepair = nowMs >= this.nextCompletedTimeoutRepairAtMs;
    if (includeCompletedTimeoutRepair) {
      this.nextCompletedTimeoutRepairAtMs = nowMs + COMPLETED_TIMEOUT_REPAIR_INTERVAL_MS;
    }

    if (!this.enqueueAdmissionDegraded) {
      return { ...this.defaultEnqueueAdmission(), includeCompletedTimeoutRepair };
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
      includeCompletedTimeoutRepair,
      // Queue repairs and exact-head fences keep order; the optional expansion is throughput work.
      expandSelectedChats: false,
    };
  }

  private async readPendingEnqueueRepresentatives(
    now: Date,
    take: number,
  ): Promise<WebhookEnqueueCandidate[]> {
    const pending = this.pendingEnqueueRepresentatives;
    if (!pending?.size) return [];
    // FLAG: Retain only bounded FIFO identities, never queued payloads or execution
    // authority. Reload exact primary keys before reuse; changed receipts still pass
    // current eligibility, ordered-head, preparation and activation CAS fences.
    const selected = Array.from(pending.entries()).slice(0, take);
    const rows = await this.prisma.webhookEvent.findMany({
      where: { id: { in: selected.map(([, id]) => id) } },
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
        processedAt: true,
        legacyDispositionId: true,
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ready: WebhookEnqueueCandidate[] = [];
    for (const [key, id] of selected) {
      const row = byId.get(id);
      if (
        this.activeEnqueueUnits.has(key) ||
        !row ||
        row.legacyDispositionId !== null ||
        row.processedAt !== null ||
        (row.nextEnqueueAt !== null && row.nextEnqueueAt > now) ||
        (row.status !== WebhookStatus.RECEIVED &&
          row.status !== WebhookStatus.FAILED &&
          row.status !== WebhookStatus.QUEUED) ||
        (row.status === WebhookStatus.FAILED &&
          row.nextEnqueueAt === null &&
          !isPendingWebhookTimeoutQuarantineMessage(row.errorMessage)) ||
        !this.shouldEnqueueCandidate(row, now)
      ) {
        pending.delete(key);
        continue;
      }
      ready.push({ ...row, isBacklogScan: true });
    }
    return ready;
  }

  private async selectEnqueueCandidates(
    now: Date,
    admission: WebhookEnqueueAdmission = this.defaultEnqueueAdmission(),
  ): Promise<WebhookEnqueueCandidate[]> {
    const selectionWindowSize = this.resolvePrioritySelectionWindowSize(admission.batchSize);
    const recentReceiptTake = this.resolveRecentReceiptTake(selectionWindowSize);
    const backlogReceiptTake = selectionWindowSize - recentReceiptTake;
    const eligibility = buildEnqueueEligibilitySql(now, admission.includeCompletedTimeoutRepair);
    const overscanTake = Math.max(
      selectionWindowSize,
      admission.degraded
        ? DEGRADED_WEBHOOK_WORK_UNIT_OVERSCAN_SIZE
        : WEBHOOK_WORK_UNIT_OVERSCAN_SIZE,
    );
    const repairRawTake = admission.includeCompletedTimeoutRepair
      ? COMPLETED_TIMEOUT_REPAIR_RAW_ROWS
      : 0;
    const repairCandidateTake = admission.includeCompletedTimeoutRepair
      ? Math.min(50, Math.max(2, Math.floor(selectionWindowSize / 4)))
      : 0;
    const scans = (this.enqueueScans ??= new Map<string, OutboxScanState>());
    const scanLanes = [
      'received',
      'failed',
      ...(admission.includeCompletedTimeoutRepair ? ['completedTimeout'] : []),
      ...(admission.includeQueuedRepair ? ['staleUserFacingQueued', 'staleBackgroundQueued'] : []),
    ];
    // FLAG: SQL may advance only across representatives guaranteed a final batch slot.
    // Share one bounded reserve across lanes, with half for receipts; rotate small
    // budgets too. Marked work survives both JS caps, including cross-lane chat dedupe.
    const scanSlots = [
      ...Array<string>(scanLanes.length - 1).fill('received'),
      ...scanLanes.slice(1),
    ];
    const scanReserve = Math.max(
      0,
      Math.min(
        Math.max(1, Math.floor(admission.batchSize / 4)),
        Math.max(1, Math.floor(this.batchSize / 4)) -
          (this.pendingEnqueueRepresentatives?.size ?? 0),
        admission.batchSize - (this.pendingEnqueueRepresentatives?.size ?? 0),
      ),
    );
    const scanTakes = new Map<string, number>();
    const scanOffset = this.enqueueScanReserveOffset ?? 0;
    for (let slot = 0; slot < scanReserve; slot += 1) {
      const lane = scanSlots[(scanOffset + slot) % scanSlots.length]!;
      scanTakes.set(lane, (scanTakes.get(lane) ?? 0) + 1);
    }
    const rotation = (lane: string) => ({
      lane,
      state: scans.get(lane) ?? { horizon: now, after: null },
      candidateTake: scanTakes.get(lane) ?? 0,
    });
    const backlogReceiptCandidatesSql = buildBoundedEnqueueWorkUnitsSql({
      columns: WEBHOOK_ENQUEUE_CANDIDATE_DB_COLUMNS_SQL,
      workUnitKey: FAIR_WEBHOOK_WORK_UNIT_KEY_SQL,
      eligibility: eligibility.received,
      rotation: rotation('received'),
      scanDirection: 'ASC',
      resultDirection: 'ASC',
      overscanTake,
      candidateTake: backlogReceiptTake,
    });
    const recentReceiptCandidatesSql = buildBoundedEnqueueWorkUnitsSql({
      columns: WEBHOOK_ENQUEUE_CANDIDATE_DB_COLUMNS_SQL,
      workUnitKey: FAIR_WEBHOOK_WORK_UNIT_KEY_SQL,
      eligibility: eligibility.received,
      scanDirection: 'DESC',
      resultDirection: 'DESC',
      overscanTake,
      candidateTake: recentReceiptTake,
    });
    const failedCandidatesSql = buildBoundedEnqueueWorkUnitsSql({
      columns: WEBHOOK_ENQUEUE_CANDIDATE_DB_COLUMNS_SQL,
      workUnitKey: FAIR_WEBHOOK_WORK_UNIT_KEY_SQL,
      eligibility: Prisma.sql`"legacy_disposition_id" IS NULL AND "status" = 'FAILED'::"WebhookStatus" AND "next_enqueue_at" <= ${now}`,
      rotation: rotation('failed'),
      scanDirection: 'ASC',
      resultDirection: 'ASC',
      overscanTake: overscanTake - repairRawTake,
      candidateTake: selectionWindowSize - repairCandidateTake,
    });
    // FLAG: Bound historical rows before claim/semantic-owner probes. Due retries have an
    // independent lane so ineligible history cannot consume their traversal budget.
    const completedTimeoutCandidatesSql = admission.includeCompletedTimeoutRepair
      ? buildBoundedEnqueueWorkUnitsSql({
          columns: WEBHOOK_ENQUEUE_CANDIDATE_DB_COLUMNS_SQL,
          workUnitKey: FAIR_WEBHOOK_WORK_UNIT_KEY_SQL,
          sourceEligibility: Prisma.sql`"legacy_disposition_id" IS NULL AND "status" = 'FAILED'::"WebhookStatus" AND "next_enqueue_at" IS NULL`,
          eligibility: eligibility.failed,
          rotation: rotation('completedTimeout'),
          scanDirection: 'ASC',
          resultDirection: 'ASC',
          overscanTake: repairRawTake,
          candidateTake: repairCandidateTake,
        })
      : buildEmptyEnqueueCandidatesSql();
    const staleUserFacingQueuedCandidatesSql = admission.includeQueuedRepair
      ? buildBoundedEnqueueWorkUnitsSql({
          columns: WEBHOOK_ENQUEUE_CANDIDATE_DB_COLUMNS_SQL,
          workUnitKey: FAIR_WEBHOOK_WORK_UNIT_KEY_SQL,
          eligibility: eligibility.staleUserFacingQueued,
          rotation: rotation('staleUserFacingQueued'),
          scanDirection: 'ASC',
          resultDirection: 'ASC',
          overscanTake,
          candidateTake: selectionWindowSize,
        })
      : buildEmptyEnqueueCandidatesSql();
    const staleBackgroundQueuedCandidatesSql = admission.includeQueuedRepair
      ? buildBoundedEnqueueWorkUnitsSql({
          columns: WEBHOOK_ENQUEUE_CANDIDATE_DB_COLUMNS_SQL,
          workUnitKey: FAIR_WEBHOOK_WORK_UNIT_KEY_SQL,
          eligibility: eligibility.staleBackgroundQueued,
          rotation: rotation('staleBackgroundQueued'),
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
        SELECT * FROM (${failedCandidatesSql}) due_retries
        UNION ALL
        SELECT * FROM (${completedTimeoutCandidatesSql}) completed_timeout
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
        "isRecentReceipt",
        "isBacklogScan",
        "scanProgress"
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

    // FLAG: Commit cursor progress only after the whole SQL statement succeeds. Cursor loss
    // repeats a bounded scan; it never removes receipts or relaxes the exact-head CAS fence.
    this.enqueueScanReserveOffset = (scanOffset + scanReserve) % scanSlots.length;
    for (const candidate of candidates) {
      const progress = candidate.scanProgress;
      if (!progress) continue;
      if (progress.complete) scans.delete(progress.lane);
      else if (progress.afterMs !== null && progress.afterId !== null) {
        scans.set(progress.lane, {
          horizon: scans.get(progress.lane)?.horizon ?? now,
          after: { createdAt: new Date(progress.afterMs), id: progress.afterId },
        });
      }
    }
    return this.mergeEnqueueCandidates(
      candidates.filter((candidate) => candidate.id !== null),
      selectionWindowSize,
    );
  }

  private mergeEnqueueCandidates(
    candidates: readonly WebhookEnqueueCandidate[],
    take: number,
  ): WebhookEnqueueCandidate[] {
    const uniqueById = new Map<string, WebhookEnqueueCandidate>();
    for (const candidate of candidates) {
      const existing = uniqueById.get(candidate.id);
      if (!existing || candidate.isRecentReceipt) {
        uniqueById.set(candidate.id, {
          ...candidate,
          isBacklogScan: candidate.isBacklogScan || existing?.isBacklogScan,
        });
      } else if (candidate.isBacklogScan) {
        existing.isBacklogScan = true;
      }
    }

    const uniqueWorkUnits = new Map<string, WebhookEnqueueCandidate>();
    for (const candidate of uniqueById.values()) {
      const chatId = this.extractPriorityChatId(candidate.normalizedPayload);
      const workUnitKey = chatId ? `chat:${chatId}` : `event:${candidate.id}`;
      const existing = uniqueWorkUnits.get(workUnitKey);
      if (!existing || this.compareCandidateSequence(candidate, existing) < 0) {
        uniqueWorkUnits.set(workUnitKey, {
          ...candidate,
          isBacklogScan: candidate.isBacklogScan || existing?.isBacklogScan,
        });
      } else if (candidate.isBacklogScan) {
        existing.isBacklogScan = true;
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
    const selectedCandidates = this.selectCandidatesWithReceiptReserve(
      prioritizedCandidates,
      take,
      now,
    );
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
      if (this.isMembershipLeaveCandidate(candidate) || candidate.isBacklogScan) {
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
    includeCompletedTimeoutRepair = true,
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

    const eligibility = buildEnqueueEligibilitySql(now, includeCompletedTimeoutRepair);
    const expansionLimit = this.resolvePrioritySelectionWindowSize();
    const perChatLimit = Math.max(
      1,
      Math.min(
        SELECTED_CHAT_EXPANSION_MAX_PER_CHAT,
        Math.floor(expansionLimit / selectedChatIds.length),
      ),
    );
    const requestedChats = Prisma.join(selectedChatIds.map((chatId) => Prisma.sql`(${chatId})`));
    // FLAG: Bound exact indexed chat heads before eligibility filters; a global IN/ORDER BY
    // can scan the entire pending backlog and block unrelated Publisher private imports.
    const expansionQuery = Prisma.sql`
      /* selected_chat_candidates */
      WITH selected_chat_heads AS MATERIALIZED (
        SELECT head.*
        FROM (VALUES ${requestedChats}) AS requested_chats("chatId")
        JOIN LATERAL (
          SELECT ${WEBHOOK_ENQUEUE_CANDIDATE_DB_COLUMNS_SQL}
          FROM "webhook_events"
          WHERE ${ORDERED_WEBHOOK_HEAD_STATUS_SQL}
            AND ${ORDERED_WEBHOOK_MESSAGE_SQL}
            AND ${ORDERED_WEBHOOK_CHAT_ID_SQL} = requested_chats."chatId"
          ORDER BY "created_at" ASC, "id" ASC
          LIMIT ${perChatLimit}
        ) head ON TRUE
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
        FALSE AS "isRecentReceipt"
      FROM selected_chat_heads AS "webhook_events"
      WHERE (
          (${eligibility.received})
          OR (${eligibility.failed})
          OR (${eligibility.staleUserFacingQueued})
          OR (${eligibility.staleBackgroundQueued})
        )
      ORDER BY "created_at" ASC, "id" ASC
      LIMIT ${expansionLimit}
    `;
    const expandedCandidates = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw(Prisma.sql`SET LOCAL statement_timeout = '1000ms'`);
        return tx.$queryRaw<WebhookEnqueueCandidate[]>(expansionQuery);
      },
      { maxWait: 1_000, timeout: 2_000 },
    );
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
    now?: Date,
  ): T[] {
    // FLAG: These SQL representatives already advanced the durable-row scan cursor.
    // Keep every reserved unit through both caps; dropping a suffix here can starve
    // the same independent chats forever on each repeated cursor cycle.
    const scanned = candidates.filter((candidate) => candidate.isBacklogScan).slice(0, take);
    const scannedIds = new Set(scanned.map((candidate) => candidate.id));
    const scannedReceipts = scanned.filter(
      (candidate) => candidate.status === WebhookStatus.RECEIVED,
    );
    const scannedRecovery = scanned.filter(
      (candidate) => candidate.status !== WebhookStatus.RECEIVED,
    );
    const unreserved = candidates.filter((candidate) => !scannedIds.has(candidate.id));
    const recentReceipts = unreserved.filter(
      (candidate) => candidate.status === WebhookStatus.RECEIVED && candidate.isRecentReceipt,
    );
    const backlogReceipts = unreserved.filter(
      (candidate) => candidate.status === WebhookStatus.RECEIVED && !candidate.isRecentReceipt,
    );
    // FLAG: Priority alone can indefinitely starve old receipts under sustained joins/callbacks.
    // Reserve bounded admission by age; BullMQ priority and per-chat ordering remain unchanged.
    if (now) {
      const agedReceipts = backlogReceipts
        .filter(
          (candidate) => now.getTime() - candidate.createdAt.getTime() >= AGED_RECEIPT_WAIT_MS,
        )
        .sort((left, right) => this.compareCandidateSequence(left, right))
        .slice(0, Math.floor(take * AGED_RECEIPT_RESERVE_SHARE));
      const agedIds = new Set(agedReceipts.map((candidate) => candidate.id));
      backlogReceipts.splice(
        0,
        backlogReceipts.length,
        ...agedReceipts,
        ...backlogReceipts.filter((candidate) => !agedIds.has(candidate.id)),
      );
    }
    const recoveryCandidates = unreserved.filter(
      (candidate) => candidate.status !== WebhookStatus.RECEIVED,
    );
    const receivedTake = Math.max(
      scannedReceipts.length,
      Math.min(
        this.resolveReceivedTake(
          scannedReceipts.length + recentReceipts.length + backlogReceipts.length,
          take,
        ),
        take - scannedRecovery.length,
      ),
    );
    const recentReceiptTake = Math.min(
      Math.max(
        0,
        this.resolveRecentReceiptTake(take) -
          scannedReceipts.filter((candidate) => candidate.isRecentReceipt).length,
      ),
      receivedTake - scannedReceipts.length,
      recentReceipts.length,
    );
    const selectedReceipts = [
      ...scannedReceipts,
      ...recentReceipts.slice(0, recentReceiptTake),
      ...backlogReceipts.slice(
        0,
        Math.max(0, receivedTake - scannedReceipts.length - recentReceiptTake),
      ),
    ];
    const selectedReceiptIds = new Set(selectedReceipts.map((candidate) => candidate.id));
    const unselectedReceipts = [...recentReceipts, ...backlogReceipts].filter(
      (candidate) => !selectedReceiptIds.has(candidate.id),
    );

    if (selectedReceipts.length < receivedTake) {
      selectedReceipts.push(
        ...unselectedReceipts.splice(0, receivedTake - selectedReceipts.length),
      );
    }

    const selected = [
      ...selectedReceipts,
      ...scannedRecovery,
      ...recoveryCandidates.slice(
        0,
        Math.max(0, take - selectedReceipts.length - scannedRecovery.length),
      ),
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
  ): Promise<EnqueueProgress> {
    const progress = createEnqueueProgress();
    if (candidates.length === 0) {
      return progress;
    }

    const workUnits = this.buildEnqueueWorkUnits(candidates);
    const pending = (this.pendingEnqueueRepresentatives ??= new Map<string, string>());
    const pendingLimit = Math.max(1, Math.floor(this.batchSize / 4));
    const workUnitKey = (unit: WebhookEnqueueWorkUnit) =>
      unit.chatId ? `chat:${unit.chatId}` : `event:${unit.candidates[0]!.id}`;
    for (const unit of workUnits) {
      const representative = unit.candidates.find((candidate) => candidate.isBacklogScan);
      const key = workUnitKey(unit);
      if (
        representative &&
        !this.activeEnqueueUnits.has(key) &&
        !pending.has(key) &&
        pending.size < pendingLimit
      )
        pending.set(key, representative.id);
    }
    // FLAG: A bounded poll can end before all selected units start. Serve its oldest
    // unsent scan representatives first next time; repeated slow queue repairs must
    // not retake every free slot. In-flight work keeps its separate owner until done.
    const pendingOrder = new Map(Array.from(pending.keys(), (key, index) => [key, index]));
    workUnits.sort(
      (left, right) =>
        (pendingOrder.get(workUnitKey(left)) ?? Number.MAX_SAFE_INTEGER) -
        (pendingOrder.get(workUnitKey(right)) ?? Number.MAX_SAFE_INTEGER),
    );
    progress.workUnits = workUnits.length;
    const chatIds = workUnits.flatMap((workUnit) => (workUnit.chatId ? [workUnit.chatId] : []));
    let orderedHeadsByChatId = await this.findOrderedWebhookHeadsForChats(chatIds);
    // FLAG: The physical head may be an earlier mirror of a finished owner. Settle only
    // that owner's exact SQL checkpoint before ordering rejects the later receipt; never
    // invoke preparation, the moderation engine or a remote action from this recovery lane.
    const recovered = await this.recoverFinishedOrderedHeads(
      orderedHeadsByChatId,
      enqueueConcurrency,
    );
    if (recovered > 0) {
      progress.settled += recovered;
      orderedHeadsByChatId = await this.findOrderedWebhookHeadsForChats(chatIds);
    }
    const workerCount = Math.max(1, enqueueConcurrency);
    // FLAG: A carried owner already serves this selected snapshot. Its completion
    // may wake other work, but must not redispatch that stale receipt snapshot.
    const dispatched = new Set(
      workUnits.filter((unit) => this.activeEnqueueUnits.has(workUnitKey(unit))),
    );
    for (const unit of dispatched) pending.delete(workUnitKey(unit));
    const sharedCapacityBlocked = new Set<WebhookEnqueueWorkUnit>();
    const scopeBlocked = new Set<WebhookEnqueueWorkUnit>();
    const active = new Set<Promise<void>>();
    // FLAG: Amortize SQL selection across a finite refill window even when the poll
    // interval is shorter. Fresh selection waits at most this dispatch budget.
    const deadlineMs = Date.now() + ENQUEUE_DISPATCH_BUDGET_MS;
    let timer: NodeJS.Timeout | undefined;
    let budgetExhausted = false;
    const budgetExpired = new Promise<void>((resolve) => {
      timer = setTimeout(
        () => {
          budgetExhausted = true;
          resolve();
        },
        Math.max(1, deadlineMs - Date.now()),
      );
    });
    const runUnit = async (workUnit: WebhookEnqueueWorkUnit) => {
      try {
        await this.enqueueCandidateSequence(
          workUnit,
          workUnit.chatId ? (orderedHeadsByChatId.get(workUnit.chatId) ?? null) : null,
          progress,
        );
      } catch {
        // FLAG: Isolate a failed unit without dropping its durable receipt or logging
        // payloads. This task stays owned until its entire SQL/queue handoff settles.
        progress.workUnitErrors += 1;
      }
    };

    // FLAG: Keep only admitted tasks in memory, bounded across every poll. Do not
    // cancel a slow task or release its slot/chat fence on a polling deadline: it may
    // still own preparation or queue activation. Fresh independent units can advance.
    try {
      while (dispatched.size < workUnits.length && !this.shuttingDown && !budgetExhausted) {
        if (Date.now() >= deadlineMs) break;
        for (const workUnit of workUnits) {
          if (this.activeEnqueueUnits.size >= workerCount) break;
          if (dispatched.has(workUnit)) continue;
          const key = workUnitKey(workUnit);
          if (this.activeEnqueueUnits.has(key)) {
            pending.delete(key);
            continue;
          }
          const orderedHead = workUnit.chatId
            ? (orderedHeadsByChatId.get(workUnit.chatId) ?? null)
            : null;
          const first = workUnit.chatId
            ? workUnit.candidates.find(
                (event) => orderedHead && this.compareCandidateSequence(orderedHead, event) === 0,
              )
            : workUnit.candidates[0];
          const preparationState =
            first && !isPendingWebhookTimeoutQuarantineMessage(first.errorMessage)
              ? this.webhookService.webhookPreparationSchedulingState(
                  first.normalizedPayload as MaxUpdate,
                )
              : 'available';
          if (preparationState !== 'available') {
            // FLAG: Shared saturation is temporary; retain scanned FIFO positions so
            // a lifecycle stream cannot repeatedly overtake ordinary receipts. Release
            // bot/class-local holds with spare shared capacity to keep other scopes discoverable.
            if (preparationState === 'shared_capacity') sharedCapacityBlocked.add(workUnit);
            else {
              scopeBlocked.add(workUnit);
              pending.delete(key);
            }
            continue;
          }
          dispatched.add(workUnit);
          pending.delete(key);
          const task = runUnit(workUnit).finally(() => {
            active.delete(task);
            this.activeEnqueueUnits.delete(key);
          });
          active.add(task);
          this.activeEnqueueUnits.set(key, task);
        }
        if (dispatched.size === workUnits.length) break;
        // FLAG: Prior-poll work still owns slots. Observe its completion as well as
        // this pass's tasks; external preparation alone must not keep a poll waiting.
        const owned = [...this.activeEnqueueUnits.values()];
        if (owned.length === 0) break;
        const completion =
          this.activeEnqueueUnits.size < workerCount
            ? this.webhookService.nextPreparationCompletion()
            : null;
        await Promise.race(
          completion ? [...owned, completion, budgetExpired] : [...owned, budgetExpired],
        );
      }
      // A full selection may still contain a slow final task. Observe it only for
      // the remaining poll budget; its ownership continues in activeEnqueueUnits.
      if (active.size > 0 && !budgetExhausted && Date.now() < deadlineMs) {
        await Promise.race([Promise.all(active), budgetExpired]);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    progress.preparationBlocked += workUnits.length - dispatched.size;
    // FLAG: These count observed waits, not exclusive final outcomes; a unit may
    // encounter both limits and later dispatch within this same poll.
    progress.preparationSharedCapacityBlocked = sharedCapacityBlocked.size;
    progress.preparationScopeBlocked = scopeBlocked.size;
    return { ...progress };
  }

  private async recoverFinishedOrderedHeads(
    heads: ReadonlyMap<string, OrderedWebhookHead>,
    concurrency = this.enqueueConcurrency,
  ): Promise<number> {
    if (heads.size === 0) return 0;
    const startedAt = performance.now();
    if (startedAt < (this.nextFinishedHeadRecoveryAt ?? 0)) return 0;
    this.nextFinishedHeadRecoveryAt = startedAt + FINISHED_HEAD_RECOVERY_INTERVAL_MS;
    const deadline = startedAt + FINISHED_HEAD_RECOVERY_BUDGET_MS;
    const uniqueHeads = Array.from(
      new Map(Array.from(heads.values(), (head) => [head.id, head])).values(),
    ).sort((left, right) => this.compareCandidateSequence(left, right));
    const take = Math.min(COMPLETED_TIMEOUT_REPAIR_RAW_ROWS, uniqueHeads.length);
    const offset = (this.finishedHeadRecoveryOffset ?? 0) % uniqueHeads.length;
    const selected = [...uniqueHeads.slice(offset), ...uniqueHeads.slice(0, offset)].slice(0, take);
    this.finishedHeadRecoveryOffset = (offset + take) % uniqueHeads.length;
    let owners: Array<{ ownerId: string }>;
    try {
      owners = await this.selectFinishedOrderedHeadOwners(selected.map((head) => head.id));
    } catch {
      // FLAG: Recovery is opportunistic; a failed or timed-out proof query must not stop
      // normal ordered admission. The unchanged SQL owner and quarantine remain fenced.
      return 0;
    }
    if (owners.length === 0) return 0;
    owners.sort((left, right) => left.ownerId.localeCompare(right.ownerId));
    const ownerOffset = (this.finishedOwnerRecoveryOffset ?? 0) % owners.length;
    const orderedOwners = [...owners.slice(ownerOffset), ...owners.slice(0, ownerOffset)];
    let next = 0;
    let recovered = 0;
    // FLAG: Coalesce shared heads, cap proof probes and SQL transactions per pass, and keep
    // their concurrency within the pressure-mode DB width. Retained history is never scanned.
    const workers = Array.from(
      {
        length: Math.max(
          1,
          Math.min(concurrency ?? 1, DEGRADED_ENQUEUE_CONCURRENCY, owners.length),
        ),
      },
      async () => {
        while (next < orderedOwners.length && performance.now() < deadline) {
          const ownerId = orderedOwners[next++]!.ownerId;
          try {
            const settled = await this.prisma.$transaction(
              async (tx) => {
                const owner = await tx.webhookEvent.findUnique({ where: { id: ownerId } });
                const semanticKey = owner && buildWebhookSemanticEventKey(owner.normalizedPayload);
                if (!owner || !semanticKey) return false;
                const claim = await tx.webhookExecutionClaim.findUnique({
                  where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey } },
                });
                if (!claim) return false;
                return WebhookCanonicalExecutionService.tryRecoverFinishedExecutionWithClient(
                  tx as unknown as Parameters<
                    typeof WebhookCanonicalExecutionService.tryRecoverFinishedExecutionWithClient
                  >[0],
                  owner,
                  claim,
                );
              },
              { maxWait: 1_000, timeout: 2_000 },
            );
            if (settled) recovered += 1;
          } catch {
            // FLAG: A changed checkpoint/body or unavailable SQL preserves its exact fences.
            // Isolate this owner; a later poll can retry without repeating any business work.
          }
        }
      },
    );
    await Promise.all(workers);
    this.finishedOwnerRecoveryOffset = (ownerOffset + next) % owners.length;
    return recovered;
  }

  private async selectFinishedOrderedHeadOwners(
    headIds: readonly string[],
  ): Promise<Array<{ ownerId: string }>> {
    if (headIds.length === 0) return [];
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '250ms'`;
        return tx.$queryRaw<Array<{ ownerId: string }>>(
          this.finishedOrderedHeadOwnersQuery(headIds),
        );
      },
      { maxWait: 250, timeout: 500 },
    );
  }

  private finishedOrderedHeadOwnersQuery(headIds: readonly string[]): Prisma.Sql {
    const requested = Prisma.join(headIds.map((id) => Prisma.sql`(${id})`));
    // FLAG: Each supplied head uses one primary-key body lookup and one unique semantic
    // claim lookup before its JSON proof filter. OFFSET 0 preserves these bounded probes.
    return Prisma.sql`
      /* finished_ordered_head_proofs */
      WITH requested_heads("id") AS (VALUES ${requested})
      SELECT DISTINCT proof."ownerId"
      FROM requested_heads
      CROSS JOIN LATERAL (
        SELECT "semantic_key" FROM "webhook_events"
        WHERE "id" = requested_heads."id" AND "semantic_key" IS NOT NULL
        OFFSET 0
      ) head
      CROSS JOIN LATERAL (
        SELECT "webhook_event_id" AS "ownerId" FROM "webhook_execution_claims"
        WHERE "kind" = 'EXECUTION' AND "semantic_key" = head."semantic_key"
          AND "status" = 'READY'::"WebhookExecutionClaimStatus"
          AND "enforced" AND "webhook_event_id" IS NOT NULL
          AND "prepared_at" IS NOT NULL AND "completed_at" IS NULL
          AND "business_started_at" IS NOT NULL
          AND "command_result" @> ${JSON.stringify({ kind: 'EXECUTION_FINISHED', authorityVersion: MULTIBOT_EXECUTION_AUTHORITY_VERSION })}::jsonb
        OFFSET 0
      ) proof
    `;
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
    progress = createEnqueueProgress(),
  ): Promise<void> {
    let orderedHead = initialOrderedHead;

    for (const event of workUnit.candidates) {
      if (workUnit.chatId) {
        if (!orderedHead) {
          progress.orderedHeadBlocked += 1;
          return;
        }
        const headOrder = this.compareCandidateSequence(orderedHead, event);
        if (headOrder < 0) {
          progress.orderedHeadBlocked += 1;
          return;
        }
        if (headOrder > 0) {
          continue;
        }
      }

      const preparationOutcome = await this.prepareCandidateForCanonicalExecution(event);
      if (preparationOutcome === 'block') {
        progress.preparationBlocked += 1;
        return;
      }
      if (preparationOutcome === 'advance') {
        progress.settled += 1;
        if (workUnit.chatId) {
          orderedHead = await this.findOrderedWebhookHeadForChat(workUnit.chatId, event);
        }
        continue;
      }

      progress.prepared += 1;
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
        progress.enqueueBlocked += 1;
        return;
      }
      if (enqueueOutcome === 'outstanding') {
        progress.outstanding += 1;
        return;
      }
      progress.settled += 1;
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
          AND NOT ${legacyOrderReleasedSql('webhook_events')}
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
        AND NOT ${legacyOrderReleasedSql('webhook_events')}
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
      const prepared = await this.webhookService.preparePersistedWebhookEvent(
        event.id,
        undefined,
        event.normalizedPayload as MaxUpdate,
      );
      if (!prepared.canonical) {
        await this.removeNonCanonicalQueuedJob(event);
        return 'advance';
      }
      if (!prepared.prepared) {
        const deferOutcome = await this.deferPreparationWithoutExhaustion(
          event,
          new WebhookPreparationDeferredError(
            'canonical webhook preparation is still pending',
            CANONICAL_PREPARATION_PENDING_RETRY_MS,
          ),
        );
        return deferOutcome === 'terminal' ? 'advance' : 'block';
      }
      if (prepared.canonicalWebhookEventId && prepared.canonicalWebhookEventId !== event.id) {
        // FLAG: Preserve the earlier receipt as an order proxy while enqueueing only the
        // canonical owner. The next distinct message stays behind this same SQL chat head.
        const owner = await this.prisma.webhookEvent.findUnique({
          where: { id: prepared.canonicalWebhookEventId },
        });
        if (
          !owner ||
          owner.status === WebhookStatus.NO_REPLAY_HELD ||
          owner.status === WebhookStatus.PROCESSED ||
          owner.status === WebhookStatus.DUPLICATE ||
          owner.timeoutQuarantineExpiresAt !== null
        )
          throw new WebhookPreparationDeferredError('Canonical order proxy owner changed', 1_000);
        await this.removeNonCanonicalQueuedJob(event);
        Object.assign(event, owner);
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
        { preparationError: error },
      );
      return failureOutcome === 'terminal' ? 'advance' : 'block';
    }
  }

  private async removeNonCanonicalQueuedJob(event: WebhookEnqueueCandidate): Promise<void> {
    // FLAG: The pre-preparation snapshot proves no activation was committed for this receipt.
    if (this.canSkipExistingJobLookupForPristineReceivedEvent(event)) {
      return;
    }
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
    diagnostic?: { preparationError: unknown },
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
    if (result.count === 1 && diagnostic) {
      this.logger.warn(
        {
          ...describeWebhookPreparationFailure(diagnostic.preparationError),
          enqueueAttempts: nextAttempts,
          retryScheduled: !exhausted,
          retryDelaySec: exhausted ? null : nextDelaySec,
        },
        'Recorded webhook preparation failure',
      );
    }
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
                  id: true,
                  semanticKey: true,
                  webhookEventId: true,
                  enforced: true,
                  status: true,
                  preparedAt: true,
                  completedAt: true,
                  leaseToken: true,
                  leaseExpiresAt: true,
                },
              })
            : null;

        if (claim?.status === 'COMPLETED') {
          const owner = await client.webhookEvent.findUnique?.({ where: { id: event.id } });
          const semanticKey = owner
            ? (buildWebhookSemanticEventKey(owner.normalizedPayload) ??
              `receipt:${owner.dedupKey || owner.id}`)
            : null;
          // FLAG: COMPLETED alone is not proof. A timeout head releases only from its exact
          // prepared, unleased semantic authority; both the claim and body are CAS-fenced.
          if (
            !owner ||
            !claim.id ||
            claim.webhookEventId !== owner.id ||
            claim.semanticKey !== semanticKey ||
            claim.enforced !== true ||
            !(claim.preparedAt instanceof Date) ||
            !Number.isFinite(claim.preparedAt.getTime()) ||
            !(claim.completedAt instanceof Date) ||
            !Number.isFinite(claim.completedAt.getTime()) ||
            claim.leaseToken !== null ||
            claim.leaseExpiresAt !== null ||
            typeof client.webhookExecutionClaim?.updateMany !== 'function'
          )
            return 'outstanding';
          const authority = await client.webhookExecutionClaim.updateMany({
            where: {
              id: claim.id,
              kind: 'EXECUTION',
              semanticKey,
              webhookEventId: owner.id,
              enforced: true,
              status: 'COMPLETED',
              preparedAt: claim.preparedAt,
              completedAt: claim.completedAt,
              leaseToken: null,
              leaseExpiresAt: null,
            },
            data: { enforced: true },
          });
          if (authority.count !== 1) return 'outstanding';
          const repaired = await client.webhookEvent.updateMany({
            where: {
              ...this.buildEnqueueStateWhere(event),
              normalizedPayload: { equals: owner.normalizedPayload as Prisma.InputJsonValue },
            },
            data: {
              status: WebhookStatus.PROCESSED,
              processedAt: claim.completedAt,
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
      current.status === WebhookStatus.NO_REPLAY_HELD ||
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
      let moderationRowsRemaining = RETENTION_CLEANUP_BATCH_SIZE * DEFAULT_RETENTION_MAX_BATCHES;
      if (this.webhookCompletedRetentionEnabled) {
        phases.push({
          name: 'webhookProcessedOrDuplicate',
          maxBatches: WEBHOOK_RETENTION_MAX_BATCHES_PER_TICK,
          // FLAG: Share the existing one-page budget between completed and positively
          // held bodies; never multiply cleanup pressure during queue recovery.
          deleteBatch: () => {
            const held = this.webhookHeldRetentionTurn;
            this.webhookHeldRetentionTurn = !held;
            return held
              ? this.deleteLegacyHeldWebhookBatch(webhookCutoff)
              : this.deleteCompletedWebhookBatch(webhookCutoff);
          },
        });
      }
      if (runMaintenance) {
        // FLAG: FAILED is not proof that no side effect occurred. Until body/proof
        // retention is separated, its receipt and cascaded execution claims are held.
        if (this.webhookFailedRetentionEnabled) {
          phases.push({
            name: 'webhookFailedTerminal',
            maxBatches: DEFAULT_RETENTION_MAX_BATCHES,
            deleteBatch: () => this.deleteTerminalFailedWebhookBatch(failedWebhookCutoff),
          });
        }
        phases.push(
          {
            name: 'moderationEvents',
            maxBatches: DEFAULT_RETENTION_MAX_BATCHES,
            deleteBatch: async () => {
              const removed = await this.deleteModerationEventBatch(moderationCutoff);
              moderationRowsRemaining = Math.max(0, moderationRowsRemaining - removed);
              return removed;
            },
          },
          {
            name: 'sanctionHistory',
            maxBatches: 1,
            deleteBatch: () =>
              this.sanctionHistoryRetention.cleanup(
                this.prisma,
                new Date(nowMs),
                moderationRowsRemaining,
              ),
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
          webhookFailedRetentionEnabled: this.webhookFailedRetentionEnabled,
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
    let scannedRows = 0;
    let batches = 0;
    let lastBatchRows = 0;

    try {
      while (batches < phase.maxBatches) {
        const result = await phase.deleteBatch();
        lastBatchRows = Math.max(0, typeof result === 'number' ? result : result.scanned);
        rows += Math.max(0, typeof result === 'number' ? result : result.removed);
        scannedRows += lastBatchRows;
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
        scannedRows,
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

  private async deleteCompletedWebhookBatch(
    cutoff: Date,
  ): Promise<{ removed: number; scanned: number }> {
    const cursor = this.webhookRetentionCursors.get('completed');
    await expireUnclaimedGroupStarts(this.prisma, cutoff, cursor, RETENTION_CLEANUP_BATCH_SIZE);
    // FLAG: Match the exact existing terminal partial index predicate. Splitting status
    // streams lets PostgreSQL reuse that index with an unbounded opposite-status filter.
    const result = await this.prisma.$queryRaw<
      Array<{ removed: number; scanned: number; lastId: string | null; lastCreatedAt: Date | null }>
    >(Prisma.sql`
      WITH candidate_ids AS MATERIALIZED (
        SELECT "id", "created_at" FROM "webhook_events"
        WHERE "status" IN ('PROCESSED'::"WebhookStatus", 'DUPLICATE'::"WebhookStatus")
          AND "created_at" < ${cutoff}
          ${cursor ? Prisma.sql`AND ("created_at", "id") > (${cursor.createdAt}, ${cursor.id})` : Prisma.empty}
        ORDER BY "created_at" ASC, "id" ASC
        LIMIT ${RETENTION_CLEANUP_BATCH_SIZE}
      ), candidates AS MATERIALIZED (
        SELECT event."id", event."semantic_key", event."created_at", event."error_message", event."timeout_quarantine_expires_at"
        FROM candidate_ids CROSS JOIN LATERAL (
          SELECT "id", "semantic_key", "created_at", "error_message", "timeout_quarantine_expires_at" FROM "webhook_events"
          WHERE "id" = candidate_ids."id"
          OFFSET 0 FOR UPDATE SKIP LOCKED
        ) event
        ORDER BY event."created_at" ASC, event."id" ASC
      ), expired AS (
        SELECT candidate."id"
        FROM candidates candidate
        WHERE ${this.webhookRetentionProofUnpinnedSql()}
      ), removed AS (
        DELETE FROM "webhook_events" target
        WHERE target."id" = ANY(ARRAY(SELECT "id" FROM expired)) RETURNING target."id"
      )
      SELECT (SELECT COUNT(*)::int FROM removed) AS "removed",
        (SELECT COUNT(*)::int FROM candidates) AS "scanned",
        (SELECT "id" FROM candidates ORDER BY "created_at" DESC, "id" DESC LIMIT 1) AS "lastId",
        (SELECT "created_at" FROM candidates ORDER BY "created_at" DESC, "id" DESC LIMIT 1) AS "lastCreatedAt"
    `);
    return this.advanceWebhookRetentionCursor('completed', result[0]);
  }

  private async deleteLegacyHeldWebhookBatch(
    cutoff: Date,
  ): Promise<{ removed: number; scanned: number }> {
    const cursor = this.webhookRetentionCursors.get('held');
    const result = await this.prisma.$queryRaw<
      Array<{ removed: number; scanned: number; lastId: string | null; lastCreatedAt: Date | null }>
    >(Prisma.sql`
      WITH candidate_ids AS MATERIALIZED (
        SELECT "id" FROM "webhook_events"
        WHERE "status" = 'NO_REPLAY_HELD'::"WebhookStatus" AND "created_at" < ${cutoff}
          ${cursor ? Prisma.sql`AND ("created_at", "id") > (${cursor.createdAt}, ${cursor.id})` : Prisma.empty}
        ORDER BY "created_at", "id" LIMIT ${RETENTION_CLEANUP_BATCH_SIZE}
      ), candidates AS MATERIALIZED (
        SELECT event."id", event."created_at", event."legacy_disposition_id"
        FROM candidate_ids CROSS JOIN LATERAL (
          SELECT "id", "created_at", "legacy_disposition_id" FROM "webhook_events"
          WHERE "id" = candidate_ids."id" AND "status" = 'NO_REPLAY_HELD'::"WebhookStatus"
          OFFSET 0 FOR UPDATE SKIP LOCKED
        ) event
      ), expired AS (
        SELECT candidate."id" FROM candidates candidate
        WHERE ${this.legacyHeldReceiptRetentionUnpinnedSql()}
      ), removed AS (
        DELETE FROM "webhook_events" target WHERE target."id" = ANY(ARRAY(SELECT "id" FROM expired)) RETURNING target."id"
      )
      SELECT (SELECT COUNT(*)::int FROM removed) AS "removed",
        (SELECT COUNT(*)::int FROM candidates) AS "scanned",
        (SELECT "id" FROM candidates ORDER BY "created_at" DESC, "id" DESC LIMIT 1) AS "lastId",
        (SELECT "created_at" FROM candidates ORDER BY "created_at" DESC, "id" DESC LIMIT 1) AS "lastCreatedAt"
    `);
    return this.advanceWebhookRetentionCursor('held', result[0]);
  }

  private async deleteTerminalFailedWebhookBatch(
    cutoff: Date,
  ): Promise<{ removed: number; scanned: number }> {
    const cursor = this.webhookRetentionCursors.get('failed');
    const result = await this.prisma.$queryRaw<
      Array<{ removed: number; scanned: number; lastId: string | null; lastCreatedAt: Date | null }>
    >(Prisma.sql`
      WITH candidate_ids AS MATERIALIZED (
        SELECT "id"
        FROM "webhook_events"
        WHERE "status" = CAST(${WebhookStatus.FAILED} AS "WebhookStatus")
          AND "created_at" < ${cutoff}
          ${cursor ? Prisma.sql`AND ("created_at", "id") > (${cursor.createdAt}, ${cursor.id})` : Prisma.empty}
        ORDER BY "created_at" ASC, "id" ASC
        LIMIT ${RETENTION_CLEANUP_BATCH_SIZE}
      ), candidates AS MATERIALIZED (
        SELECT event."id", event."legacy_disposition_id", event."semantic_key", event."created_at", event."next_enqueue_at", event."error_message", event."timeout_quarantine_expires_at"
        FROM candidate_ids CROSS JOIN LATERAL (
          SELECT "id", "legacy_disposition_id", "semantic_key", "created_at", "next_enqueue_at", "error_message", "timeout_quarantine_expires_at" FROM "webhook_events"
          WHERE "id" = candidate_ids."id"
            AND "status" = CAST(${WebhookStatus.FAILED} AS "WebhookStatus")
            AND "created_at" < ${cutoff}
          OFFSET 0 FOR UPDATE SKIP LOCKED
        ) event
        ORDER BY event."created_at" ASC, event."id" ASC
      ), expired AS (
        SELECT candidate."id"
        FROM candidates candidate
        WHERE candidate."next_enqueue_at" IS NULL
          AND candidate."timeout_quarantine_expires_at" IS NULL
          AND LEFT(COALESCE(candidate."error_message", ''), ${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_LENGTH_SQL}) <> ${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_SQL}
          AND COALESCE(candidate."error_message", '') NOT ILIKE '%ambiguous%'
          AND (
            (COALESCE(candidate."error_message", '') NOT LIKE 'WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINED%'
              AND ${this.webhookRetentionProofUnpinnedSql()})
            OR ${this.legacyHeldReceiptRetentionUnpinnedSql()}
          )
      ), removed AS (
        DELETE FROM "webhook_events" target
        WHERE target."id" = ANY(ARRAY(SELECT "id" FROM expired)) RETURNING target."id"
      )
      SELECT (SELECT COUNT(*)::int FROM removed) AS "removed",
        (SELECT COUNT(*)::int FROM candidates) AS "scanned",
        (SELECT "id" FROM candidates ORDER BY "created_at" DESC, "id" DESC LIMIT 1) AS "lastId",
        (SELECT "created_at" FROM candidates ORDER BY "created_at" DESC, "id" DESC LIMIT 1) AS "lastCreatedAt"
    `);
    return this.advanceWebhookRetentionCursor('failed', result[0]);
  }

  private advanceWebhookRetentionCursor(
    phase: string,
    batch:
      | { removed: number; scanned: number; lastId: string | null; lastCreatedAt: Date | null }
      | undefined,
  ): { removed: number; scanned: number } {
    if (!batch) throw new Error('Webhook retention scan result missing');
    if (batch.scanned >= RETENTION_CLEANUP_BATCH_SIZE && batch.lastId && batch.lastCreatedAt)
      this.webhookRetentionCursors.set(phase, { id: batch.lastId, createdAt: batch.lastCreatedAt });
    else this.webhookRetentionCursors.delete(phase);
    return { removed: batch.removed, scanned: batch.scanned };
  }

  private webhookRetentionProofUnpinnedSql(): Prisma.Sql {
    // FLAG: Delete only bounded candidate bodies whose authority is settled. Legacy rows
    // without the indexed semantic identity wait for reviewed bounded backfill; a pending
    // mirror, action ambiguity, incomplete command result or lease pins the owner proof.
    return Prisma.sql`
      candidate."semantic_key" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "webhook_legacy_recoveries" original
        WHERE original."owner_webhook_event_id" = candidate."id")
      AND candidate."timeout_quarantine_expires_at" IS NULL
      AND COALESCE(candidate."error_message", '') NOT ILIKE '%ambiguous%'
      AND COALESCE(candidate."error_message", '') NOT LIKE 'WEBHOOK_HOT_PATH_TIMEOUT%QUARANTINED%'
      AND NOT EXISTS (
        SELECT 1 FROM "webhook_execution_claims" claim
        WHERE claim."webhook_event_id" = candidate."id"
          AND (
            claim."status" <> 'COMPLETED'::"WebhookExecutionClaimStatus"
            OR claim."lease_token" IS NOT NULL
            OR claim."lease_expires_at" IS NOT NULL
            OR (claim."kind" = 'COMMAND' AND (
              claim."prepared_at" IS NULL
              OR claim."completed_at" IS NULL
              OR claim."command_result" IS NULL
              OR jsonb_typeof(claim."command_result") <> 'object'
            ))
            OR (claim."kind" = 'EXECUTION' AND (
              claim."enforced" IS NOT TRUE
              OR claim."prepared_at" IS NULL
              OR claim."completed_at" IS NULL
            ))
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM "webhook_events" mirror
        WHERE mirror."semantic_key" = candidate."semantic_key"
          AND mirror."id" <> candidate."id"
          AND (
            mirror."status" IN ('RECEIVED'::"WebhookStatus", 'QUEUED'::"WebhookStatus")
            OR (mirror."status" = 'FAILED'::"WebhookStatus" AND mirror."next_enqueue_at" IS NOT NULL)
            OR mirror."timeout_quarantine_expires_at" IS NOT NULL
            OR COALESCE(mirror."error_message", '') ILIKE '%ambiguous%'
            OR COALESCE(mirror."error_message", '') LIKE 'WEBHOOK_HOT_PATH_TIMEOUT%QUARANTINED%'
          )
      )
    `;
  }

  private legacyHeldReceiptRetentionUnpinnedSql(): Prisma.Sql {
    // FLAG: A historical error marker or scope seal is not per-receipt proof. Only
    // positive post-seal declined work without a claim can release its retained body.
    return Prisma.sql`
      candidate."legacy_disposition_id" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "webhook_execution_claims" claim
        WHERE claim."webhook_event_id" = candidate."id")
      AND EXISTS (SELECT 1 FROM "webhook_legacy_receipt_dispositions" proof
        WHERE proof."id" = candidate."legacy_disposition_id" AND proof."receipt_id" = candidate."id"
          AND proof."reason" = 'NO_REPLAY_HELD' AND proof."scope_kind" = 'POST_SEAL_MEMBER')
    `;
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
    // FLAG: Sanctions, releases, and execution fences outlive ordinary violation retention.
    return this.prisma.$executeRaw(Prisma.sql`
      WITH expired AS (
        SELECT "id"
        FROM "moderation_events"
        WHERE "created_at" < ${cutoff}
          AND NOT ("action" IN ('MUTE', 'BAN') OR "rule_code" IN ('MANUAL_UNMUTE', 'MANUAL_UNBAN', 'SANCTION_STATE_FENCE'))
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
