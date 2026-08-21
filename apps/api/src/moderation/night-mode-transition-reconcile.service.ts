import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { buildNightModeNoticeIdempotencyKey } from '../max/max-action-idempotency.util';
import { getAppRole, roleRunsEnqueue } from '../runtime/app-role';
import { NightModeTransitionSchedulerService } from './night-mode-transition-scheduler.service';
import type { NightModeTransitionManualReview } from './night-mode-transition-scheduler.service';
import { parseNightModeTransitionSessionKey } from './night-mode-transition-time.util';

const NIGHT_MODE_RECONCILE_INTERVAL_MS = 500;
const NIGHT_MODE_RECONCILE_BATCH_SIZE = 250;
const NIGHT_MODE_RECONCILE_CONCURRENCY = 8;
const NIGHT_MODE_RECONCILE_REQUEUE_DELAY_MS = 5_000;
const NIGHT_MODE_RECONCILE_LEASE_MS = 30_000;
const NIGHT_MODE_RECONCILE_HEARTBEAT_MS = 10_000;
const NIGHT_MODE_REGISTRY_OVERDUE_MS = 5 * 60_000;
const NIGHT_MODE_MANUAL_REVIEW_REASON_MAX_LENGTH = 1_000;
const NIGHT_MODE_RECONCILE_ERROR_CODE_MAX_LENGTH = 120;
const NIGHT_MODE_RECONCILE_ERROR_MAX_LENGTH = 1_000;
const NIGHT_MODE_LEGACY_RECOVERY_DISCOVERY_PAGE_SIZE = 100;
const NIGHT_MODE_LEGACY_RECOVERY_DISCOVERY_RETRY_MS = 5_000;
const NIGHT_MODE_LEGACY_RECOVERY_DISCOVERY_INCREMENTAL_MS = 60_000;
const NIGHT_MODE_LEGACY_RECOVERY_DISCOVERY_OVERLAP_MS = 5 * 60_000;

type NightModeTransitionReconcileRequest = {
  chat_id: string;
  generation: bigint;
};

type ClaimedNightModeTransitionReconcileRequests = {
  leaseToken: string;
  requests: NightModeTransitionReconcileRequest[];
};

type NightModeTransitionBatchLeaseHeartbeat = {
  release(request: NightModeTransitionReconcileRequest): void;
  stop(): Promise<void>;
};

type NightModeLegacyRecoveryLedgerRow = {
  id: string;
  jobId: string;
  chatId: string;
  completedAt: Date;
  remoteMessageId: string;
  dispatchBotId: string;
  eventExists: boolean;
};

type NightModeLegacyRecoveryCursor = {
  completedAt: Date;
  id: string;
};

@Injectable()
export class NightModeTransitionReconcileService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NightModeTransitionReconcileService.name);
  private readonly enabled = roleRunsEnqueue(getAppRole());
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private legacyRecoveryDiscoveryComplete = false;
  private legacyRecoveryDiscoveryNextAttemptAt = 0;
  private legacyRecoveryCursor: NightModeLegacyRecoveryCursor | null = null;
  private legacyRecoveryHeadCursor: NightModeLegacyRecoveryCursor | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: NightModeTransitionSchedulerService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) {
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, NIGHT_MODE_RECONCILE_INTERVAL_MS);
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.inFlight) {
      return;
    }

    this.inFlight = true;
    try {
      await this.discoverLegacyCloseRecoveriesPage().catch((error: unknown) => {
        this.legacyRecoveryDiscoveryNextAttemptAt =
          Date.now() + NIGHT_MODE_LEGACY_RECOVERY_DISCOVERY_RETRY_MS;
        this.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'Failed to discover historical night mode close-event recovery candidates',
        );
      });
      await this.reconcileBatch();
    } catch (error: unknown) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to reconcile durable night mode transition requests',
      );
    } finally {
      this.inFlight = false;
    }
  }

  private async discoverLegacyCloseRecoveriesPage(): Promise<number> {
    if (Date.now() < this.legacyRecoveryDiscoveryNextAttemptAt) {
      return 0;
    }

    const cursorPredicate = this.legacyRecoveryCursor
      ? this.legacyRecoveryDiscoveryComplete
        ? Prisma.sql`
            AND (ledger."completed_at", ledger."id") >
              (${this.legacyRecoveryCursor.completedAt}, ${this.legacyRecoveryCursor.id})
          `
        : Prisma.sql`
            AND (ledger."completed_at", ledger."id") <
              (${this.legacyRecoveryCursor.completedAt}, ${this.legacyRecoveryCursor.id})
          `
      : Prisma.empty;
    const ledgerOrder = this.legacyRecoveryDiscoveryComplete ? Prisma.sql`ASC` : Prisma.sql`DESC`;
    const rows = await this.prisma.$queryRaw<NightModeLegacyRecoveryLedgerRow[]>(Prisma.sql`
      WITH ledger_page AS MATERIALIZED (
        SELECT
          ledger."id",
          ledger."job_id" AS "jobId",
          ledger."chat_id" AS "chatId",
          ledger."completed_at" AS "completedAt",
          ledger."remote_message_id" AS "remoteMessageId",
          ledger."dispatch_bot_id" AS "dispatchBotId"
        FROM "max_action_ledger" ledger
        WHERE ledger."terminal" = true
          AND ledger."completed_at" IS NOT NULL
          AND ledger."status" = 'SUCCEEDED'
          AND ledger."ambiguous" = false
          AND ledger."action_type" = 'SEND_MESSAGE'
          AND ledger."source_tag" = 'night_mode_transition'
          AND ledger."remote_message_id" IS NOT NULL
          AND BTRIM(ledger."remote_message_id") <> ''
          AND ledger."dispatch_bot_id" IS NOT NULL
          AND BTRIM(ledger."dispatch_bot_id") <> ''
          AND LEFT(
            ledger."job_id",
            CHAR_LENGTH('night-mode:close:' || ledger."chat_id" || ':session:')
          ) = 'night-mode:close:' || ledger."chat_id" || ':session:'
          ${cursorPredicate}
        ORDER BY ledger."completed_at" ${ledgerOrder}, ledger."id" ${ledgerOrder}
        LIMIT ${NIGHT_MODE_LEGACY_RECOVERY_DISCOVERY_PAGE_SIZE}
      )
      SELECT
        page.*,
        EXISTS (
          SELECT 1
          FROM "moderation_events" event
          WHERE event."chat_id" = page."chatId"
            AND event."message_id" = page."remoteMessageId"
            AND event."bot_id" = page."dispatchBotId"
            AND event."rule_code" = 'NIGHT_MODE_CLOSE_NOTICE'
            AND event."metadata" ->> 'sessionKey' = SUBSTRING(
              page."jobId"
              FROM CHAR_LENGTH('night-mode:close:' || page."chatId" || ':session:') + 1
            )
        ) AS "eventExists"
      FROM ledger_page page
      ORDER BY page."completedAt" ${ledgerOrder}, page."id" ${ledgerOrder}
    `);

    const pageCandidates = new Map<
      string,
      { chatId: string; sessionKey: string; ledgerJobId: string }
    >();
    for (const row of rows) {
      const chatId = row.chatId.trim();
      const jobIdPrefix = buildNightModeNoticeIdempotencyKey('close', chatId, '');
      const sessionKey = row.jobId.startsWith(jobIdPrefix)
        ? row.jobId.slice(jobIdPrefix.length)
        : '';
      if (
        !chatId ||
        !row.id.trim() ||
        !(row.completedAt instanceof Date) ||
        !Number.isFinite(row.completedAt.getTime()) ||
        !row.remoteMessageId.trim() ||
        !row.dispatchBotId.trim() ||
        row.eventExists ||
        !parseNightModeTransitionSessionKey(sessionKey) ||
        row.jobId !== buildNightModeNoticeIdempotencyKey('close', chatId, sessionKey)
      ) {
        continue;
      }
      pageCandidates.set(`${chatId}\u0000${sessionKey}`, {
        chatId,
        sessionKey,
        ledgerJobId: row.jobId,
      });
    }

    const candidates = Array.from(pageCandidates.values()).sort(
      (left, right) =>
        left.chatId.localeCompare(right.chatId) || left.sessionKey.localeCompare(right.sessionKey),
    );
    if (candidates.length > 0) {
      await this.prisma.$queryRaw(Prisma.sql`
        WITH recovery_candidates("chat_id", "session_key", "ledger_job_id") AS (
          VALUES ${Prisma.join(
            candidates.map(
              (candidate) =>
                Prisma.sql`(${candidate.chatId}, ${candidate.sessionKey}, ${candidate.ledgerJobId})`,
            ),
          )}
        ), chats_to_request AS (
          SELECT DISTINCT candidate."chat_id"
          FROM recovery_candidates candidate
          WHERE NOT EXISTS (
            SELECT 1
            FROM "night_mode_transition_reconcile_requests" request
            WHERE request."chat_id" = candidate."chat_id"
              AND (
                request."manual_blocked_at" IS NULL
                OR request."generation" > request."manual_blocked_generation"
              )
          )
            AND NOT EXISTS (
              SELECT 1
              FROM "night_mode_transition_reconcile_requests" request
              WHERE request."chat_id" = candidate."chat_id"
                AND request."manual_blocked_at" IS NOT NULL
                AND request."generation" = request."manual_blocked_generation"
                AND request."manual_blocked_session_key" = candidate."session_key"
                AND request."manual_blocked_ledger_job_id" = candidate."ledger_job_id"
            )
            AND NOT EXISTS (
              SELECT 1
              FROM "night_mode_transition_scheduled_jobs" registry
              WHERE registry."chat_id" = candidate."chat_id"
                AND registry."session_key" = candidate."session_key"
                AND POSITION('__recovery__' IN registry."job_id") > 0
            )
        )
        SELECT enqueue_night_mode_transition_reconcile_request(candidate."chat_id")
        FROM chats_to_request candidate
        ORDER BY candidate."chat_id" ASC
      `);
    }

    const lastRow = rows[rows.length - 1];
    if (lastRow) {
      this.legacyRecoveryCursor = {
        completedAt: lastRow.completedAt,
        id: lastRow.id,
      };
      if (!this.legacyRecoveryDiscoveryComplete && !this.legacyRecoveryHeadCursor) {
        const firstRow = rows[0]!;
        this.legacyRecoveryHeadCursor = {
          completedAt: firstRow.completedAt,
          id: firstRow.id,
        };
      } else if (
        this.legacyRecoveryDiscoveryComplete &&
        (!this.legacyRecoveryHeadCursor ||
          this.compareLegacyRecoveryCursor(
            this.legacyRecoveryCursor,
            this.legacyRecoveryHeadCursor,
          ) > 0)
      ) {
        this.legacyRecoveryHeadCursor = this.legacyRecoveryCursor;
      }
    }
    this.legacyRecoveryDiscoveryNextAttemptAt = 0;
    if (rows.length < NIGHT_MODE_LEGACY_RECOVERY_DISCOVERY_PAGE_SIZE) {
      if (!this.legacyRecoveryDiscoveryComplete) {
        this.legacyRecoveryDiscoveryComplete = true;
      }
      this.legacyRecoveryCursor = this.buildLegacyRecoveryOverlapCursor(
        this.legacyRecoveryHeadCursor,
      );
      this.legacyRecoveryDiscoveryNextAttemptAt =
        Date.now() + NIGHT_MODE_LEGACY_RECOVERY_DISCOVERY_INCREMENTAL_MS;
    }
    return new Set(candidates.map((candidate) => candidate.chatId)).size;
  }

  private buildLegacyRecoveryOverlapCursor(
    cursor: NightModeLegacyRecoveryCursor | null,
  ): NightModeLegacyRecoveryCursor | null {
    return cursor
      ? {
          completedAt: new Date(
            cursor.completedAt.getTime() - NIGHT_MODE_LEGACY_RECOVERY_DISCOVERY_OVERLAP_MS,
          ),
          id: '',
        }
      : null;
  }

  private compareLegacyRecoveryCursor(
    left: NightModeLegacyRecoveryCursor,
    right: NightModeLegacyRecoveryCursor,
  ): number {
    return (
      left.completedAt.getTime() - right.completedAt.getTime() || left.id.localeCompare(right.id)
    );
  }

  private async reconcileBatch(): Promise<number> {
    const { leaseToken, requests } = await this.claimRequests();
    if (requests.length === 0) {
      return 0;
    }

    const heartbeat = this.startBatchLeaseHeartbeat(requests, leaseToken);
    let nextIndex = 0;
    const workerCount = Math.max(1, Math.min(NIGHT_MODE_RECONCILE_CONCURRENCY, requests.length));
    const runWorker = async () => {
      while (true) {
        const request = requests[nextIndex];
        nextIndex += 1;
        if (!request) {
          return;
        }
        try {
          await this.reconcileRequest(request, leaseToken);
        } finally {
          heartbeat.release(request);
        }
      }
    };

    const workerResults = await Promise.allSettled(
      Array.from({ length: workerCount }, () => runWorker()),
    );
    await heartbeat.stop();
    const failedWorker = workerResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failedWorker) {
      throw failedWorker.reason;
    }
    return requests.length;
  }

  private async claimRequests(): Promise<ClaimedNightModeTransitionReconcileRequests> {
    const now = new Date();
    const registryOverdueBefore = new Date(now.getTime() - NIGHT_MODE_REGISTRY_OVERDUE_MS);
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + NIGHT_MODE_RECONCILE_LEASE_MS);
    const requests = await this.prisma.$queryRaw<NightModeTransitionReconcileRequest[]>(Prisma.sql`
      WITH candidates AS (
        SELECT request."chat_id", request."generation"
        FROM "night_mode_transition_reconcile_requests" request
        WHERE (
            request."manual_blocked_at" IS NULL
            OR request."generation" > request."manual_blocked_generation"
          )
          AND request."requested_at" <= ${now}
          AND (
            request."lease_expires_at" IS NULL
            OR request."lease_expires_at" < ${now}
          )
        ORDER BY request."requested_at" ASC, request."chat_id" ASC
        LIMIT ${NIGHT_MODE_RECONCILE_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      ), claim_context AS (
        SELECT
          ${leaseToken}::TEXT AS "lease_token",
          ${leaseExpiresAt}::TIMESTAMP AS "lease_expires_at",
          ${now}::TIMESTAMP AS "last_attempt_at"
      ), overdue_registry_chats AS (
        SELECT registry."chat_id"
        FROM "night_mode_transition_scheduled_jobs" registry
        LEFT JOIN "night_mode_transition_reconcile_requests" existing
          ON existing."chat_id" = registry."chat_id"
        WHERE registry."scheduled_for" <= ${now}
          AND registry."updated_at" <= ${registryOverdueBefore}
          AND NOT (
            existing."manual_blocked_at" IS NOT NULL
            AND registry."job_id" = existing."manual_blocked_job_id"
            AND registry."session_key" = existing."manual_blocked_session_key"
            AND registry."schedule_fingerprint" = existing."manual_blocked_fingerprint"
          )
          AND (
            existing."chat_id" IS NULL
            OR (
              existing."manual_blocked_at" IS NOT NULL
              AND existing."generation" = existing."manual_blocked_generation"
            )
          )
        GROUP BY registry."chat_id"
        ORDER BY MIN(registry."scheduled_for") ASC, registry."chat_id" ASC
        LIMIT ${NIGHT_MODE_RECONCILE_BATCH_SIZE}
      ), materialized_registry_requests AS (
        INSERT INTO "night_mode_transition_reconcile_requests" (
          "chat_id",
          "generation",
          "first_requested_at",
          "requested_at"
        )
        SELECT "chat_id", 1, ${now}, ${now}
        FROM overdue_registry_chats
        ON CONFLICT ("chat_id") DO UPDATE
        SET
          "generation" = "night_mode_transition_reconcile_requests"."generation" + 1,
          "requested_at" = ${now},
          "lease_token" = NULL,
          "lease_expires_at" = NULL
        WHERE "night_mode_transition_reconcile_requests"."manual_blocked_at" IS NOT NULL
          AND "night_mode_transition_reconcile_requests"."generation" =
            "night_mode_transition_reconcile_requests"."manual_blocked_generation"
        RETURNING "chat_id"
      )
      UPDATE "night_mode_transition_reconcile_requests" request
      SET
        "lease_token" = claim_context."lease_token",
        "lease_expires_at" = claim_context."lease_expires_at",
        "attempt_count" = request."attempt_count" + 1,
        "last_attempt_at" = claim_context."last_attempt_at"
      FROM candidates CROSS JOIN claim_context
      WHERE request."chat_id" = candidates."chat_id"
        AND request."generation" = candidates."generation"
      RETURNING request."chat_id", request."generation"
    `);
    return { leaseToken, requests };
  }

  private async reconcileRequest(
    request: NightModeTransitionReconcileRequest,
    leaseToken: string,
  ): Promise<void> {
    if (!(await this.confirmLeaseOwnership(request, leaseToken))) {
      this.logLostLease(request, 'before scheduler mutation');
      return;
    }

    let result: Awaited<
      ReturnType<NightModeTransitionSchedulerService['repairAccessSchedule']>
    > | null = null;
    let repairFailed = false;
    let repairError: unknown;
    try {
      result = await this.scheduler.repairAccessSchedule(request.chat_id, {
        generation: request.generation,
        leaseToken,
      });
      if (!result.queueAvailable) {
        throw new Error('Night mode transition queue is unavailable during durable repair');
      }
    } catch (error: unknown) {
      repairFailed = true;
      repairError = error;
    }

    if (!(await this.confirmLeaseOwnership(request, leaseToken))) {
      this.logLostLease(request, 'after scheduler mutation');
      return;
    }

    if (repairFailed) {
      await this.requeueRequest(request, leaseToken, repairError).catch((requeueError: unknown) => {
        this.logger.error(
          {
            chatId: request.chat_id,
            generation: request.generation.toString(),
            error: requeueError instanceof Error ? requeueError.message : String(requeueError),
          },
          'Failed to release night mode reconcile lease; expiry will recover it',
        );
      });
      this.logger.warn(
        {
          chatId: request.chat_id,
          generation: request.generation.toString(),
          error: repairError instanceof Error ? repairError.message : String(repairError),
        },
        'Failed to reconcile durable night mode state; request was requeued',
      );
      return;
    }

    if (result?.manualReview) {
      await this.markManualReview(request, leaseToken, result.manualReview);
      return;
    }
    await this.completeRequest(request, leaseToken);
  }

  private async confirmLeaseOwnership(
    request: NightModeTransitionReconcileRequest,
    leaseToken: string,
  ): Promise<boolean> {
    const leaseExpiresAt = new Date(Date.now() + NIGHT_MODE_RECONCILE_LEASE_MS);
    try {
      const owned = await this.prisma.$queryRaw<Array<{ chat_id: string }>>(Prisma.sql`
        UPDATE "night_mode_transition_reconcile_requests"
        SET "lease_expires_at" = ${leaseExpiresAt}
        WHERE "chat_id" = ${request.chat_id}
          AND "generation" = ${request.generation}
          AND "lease_token" = ${leaseToken}
          AND "lease_expires_at" > CURRENT_TIMESTAMP
          AND (
            "manual_blocked_at" IS NULL
            OR "generation" > "manual_blocked_generation"
          )
        RETURNING "chat_id"
      `);
      return owned.length === 1;
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: request.chat_id,
          generation: request.generation.toString(),
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to confirm night mode reconcile lease ownership',
      );
      return false;
    }
  }

  private startBatchLeaseHeartbeat(
    requests: readonly NightModeTransitionReconcileRequest[],
    leaseToken: string,
  ): NightModeTransitionBatchLeaseHeartbeat {
    const pending = new Map(
      requests.map((request) => [this.buildRequestIdentity(request), request] as const),
    );
    let renewalChain = Promise.resolve();
    const timer = setInterval(() => {
      const snapshot = Array.from(pending.values());
      if (snapshot.length === 0) {
        return;
      }
      renewalChain = renewalChain
        .then(async () => {
          await this.renewBatchLeases(snapshot, leaseToken);
        })
        .catch((error: unknown) => {
          this.logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'Failed to heartbeat the night mode reconcile request batch',
          );
        });
    }, NIGHT_MODE_RECONCILE_HEARTBEAT_MS);
    timer.unref();

    return {
      release: (request) => {
        pending.delete(this.buildRequestIdentity(request));
      },
      stop: async () => {
        clearInterval(timer);
        await renewalChain.catch(() => undefined);
      },
    };
  }

  private async renewBatchLeases(
    requests: readonly NightModeTransitionReconcileRequest[],
    leaseToken: string,
  ): Promise<void> {
    if (requests.length === 0) {
      return;
    }
    const leaseExpiresAt = new Date(Date.now() + NIGHT_MODE_RECONCILE_LEASE_MS);
    await this.prisma.$queryRaw(Prisma.sql`
      WITH expected("chat_id", "generation") AS (
        VALUES ${Prisma.join(
          requests.map((request) => Prisma.sql`(${request.chat_id}, ${request.generation})`),
        )}
      )
      UPDATE "night_mode_transition_reconcile_requests" request
      SET "lease_expires_at" = ${leaseExpiresAt}
      FROM expected
      WHERE request."chat_id" = expected."chat_id"
        AND request."generation" = expected."generation"
        AND request."lease_token" = ${leaseToken}
        AND request."lease_expires_at" > CURRENT_TIMESTAMP
        AND (
          request."manual_blocked_at" IS NULL
          OR request."generation" > request."manual_blocked_generation"
        )
      RETURNING request."chat_id", request."generation"
    `);
  }

  private buildRequestIdentity(request: NightModeTransitionReconcileRequest): string {
    return `${request.chat_id}\u0000${request.generation.toString()}`;
  }

  private logLostLease(request: NightModeTransitionReconcileRequest, phase: string): void {
    this.logger.warn(
      {
        chatId: request.chat_id,
        generation: request.generation.toString(),
        phase,
      },
      'Skipped night mode reconcile work after losing lease ownership',
    );
  }

  private async completeRequest(
    request: NightModeTransitionReconcileRequest,
    leaseToken: string,
  ): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      WITH preserved_manual AS (
        UPDATE "night_mode_transition_reconcile_requests"
        SET
          "manual_blocked_generation" = "generation",
          "lease_token" = NULL,
          "lease_expires_at" = NULL,
          "last_error_code" = NULL,
          "last_error_at" = NULL,
          "last_error" = NULL
        WHERE "chat_id" = ${request.chat_id}
          AND "generation" = ${request.generation}
          AND "lease_token" = ${leaseToken}
          AND "manual_blocked_at" IS NOT NULL
        RETURNING "chat_id"
      )
      DELETE FROM "night_mode_transition_reconcile_requests"
      WHERE "chat_id" = ${request.chat_id}
        AND "generation" = ${request.generation}
        AND "lease_token" = ${leaseToken}
        AND "manual_blocked_at" IS NULL
    `);
  }

  private async markManualReview(
    request: NightModeTransitionReconcileRequest,
    leaseToken: string,
    manualReview: NightModeTransitionManualReview,
  ): Promise<void> {
    const normalizedReason =
      manualReview.reason.trim().slice(0, NIGHT_MODE_MANUAL_REVIEW_REASON_MAX_LENGTH) ||
      'Night mode catch-up requires manual review';
    await this.prisma.$executeRaw(Prisma.sql`
      WITH incoming AS (
        SELECT
          ${normalizedReason}::TEXT AS "reason",
          ${manualReview.category}::TEXT AS "category",
          ${manualReview.jobId}::TEXT AS "job_id",
          ${manualReview.ledgerJobId}::TEXT AS "ledger_job_id",
          ${manualReview.sessionKey}::TEXT AS "session_key",
          ${manualReview.fingerprint}::TEXT AS "fingerprint"
      )
      UPDATE "night_mode_transition_reconcile_requests" request
      SET
        "manual_blocked_at" = CASE
          WHEN request."manual_blocked_job_id" = incoming."job_id"
            AND request."manual_blocked_session_key" = incoming."session_key"
            AND request."manual_blocked_fingerprint" = incoming."fingerprint"
            AND request."manual_blocked_category" = incoming."category"
            THEN request."manual_blocked_at"
          ELSE ${new Date()}
        END,
        "manual_blocked_reason" = CASE
          WHEN request."manual_blocked_job_id" = incoming."job_id"
            AND request."manual_blocked_session_key" = incoming."session_key"
            AND request."manual_blocked_fingerprint" = incoming."fingerprint"
            AND request."manual_blocked_category" = incoming."category"
            THEN request."manual_blocked_reason"
          ELSE incoming."reason"
        END,
        "manual_acknowledged_at" = CASE
          WHEN request."manual_blocked_job_id" = incoming."job_id"
            AND request."manual_blocked_session_key" = incoming."session_key"
            AND request."manual_blocked_fingerprint" = incoming."fingerprint"
            AND request."manual_blocked_category" = incoming."category"
            THEN request."manual_acknowledged_at"
          ELSE NULL
        END,
        "manual_blocked_category" = incoming."category",
        "manual_blocked_job_id" = incoming."job_id",
        "manual_blocked_ledger_job_id" = incoming."ledger_job_id",
        "manual_blocked_session_key" = incoming."session_key",
        "manual_blocked_fingerprint" = incoming."fingerprint",
        "manual_blocked_generation" = ${request.generation},
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "last_error_code" = NULL,
        "last_error_at" = NULL,
        "last_error" = NULL
      FROM incoming
      WHERE request."chat_id" = ${request.chat_id}
        AND request."generation" = ${request.generation}
        AND request."lease_token" = ${leaseToken}
    `);
    this.logger.warn(
      {
        chatId: request.chat_id,
        generation: request.generation.toString(),
        category: manualReview.category,
        jobId: manualReview.jobId,
        reason: normalizedReason,
      },
      'Night mode catch-up retained for manual review without automatic retry',
    );
  }

  private async requeueRequest(
    request: NightModeTransitionReconcileRequest,
    leaseToken: string,
    error: unknown,
  ): Promise<void> {
    const retryAt = new Date(Date.now() + NIGHT_MODE_RECONCILE_REQUEUE_DELAY_MS);
    const errorAt = new Date();
    const errorCode = this.normalizeErrorCode(error);
    const errorMessage = this.normalizeErrorMessage(error);
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "night_mode_transition_reconcile_requests"
      SET
        "requested_at" = ${retryAt},
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "last_error_code" = ${errorCode},
        "last_error_at" = ${errorAt},
        "last_error" = ${errorMessage}
      WHERE "chat_id" = ${request.chat_id}
        AND "generation" = ${request.generation}
        AND "lease_token" = ${leaseToken}
    `);
  }

  private normalizeErrorCode(error: unknown): string {
    const candidate =
      error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : error instanceof Error
          ? error.name
          : 'unknown_error';
    return candidate.trim().slice(0, NIGHT_MODE_RECONCILE_ERROR_CODE_MAX_LENGTH) || 'unknown_error';
  }

  private normalizeErrorMessage(error: unknown): string {
    const candidate = error instanceof Error ? error.message : String(error);
    return (
      candidate.trim().slice(0, NIGHT_MODE_RECONCILE_ERROR_MAX_LENGTH) ||
      'Unknown night mode reconcile failure'
    );
  }
}
