import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import {
  PublisherBackgroundWorkCoordinatorClosedError,
  PublisherBackgroundWorkCoordinatorService,
} from '../publisher/publisher-background-work-coordinator.service';
import { PublisherDispatchHealthService } from '../publisher/publisher-dispatch-health.service';
import { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import { readChannelSuggestionPublicationClaimV1 } from './admin-channel-suggestion-publication-protocol';
import { PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST } from './admin.service.support';
import {
  isPublisherSuggestionReviewProtocol,
  PUBLISHER_SUGGESTION_DISPATCH_PROFILE,
  PUBLISHER_SUGGESTION_LEGACY_INLINE_STALE_MS,
  PUBLISHER_SUGGESTION_REVIEW_PROTOCOL,
  readLegacyPublisherSuggestionInlineClaim,
  readPublisherSuggestionReviewClaim,
} from './publisher-suggestion-review-protocol';
import {
  PUBLISHER_SUGGESTION_PUBLICATION_JOB,
  PUBLISHER_SUGGESTION_PUBLICATION_QUEUE,
  PUBLISHER_SUGGESTION_PUBLICATION_RETRY_POLICY,
  type PublisherSuggestionPublicationJob,
} from './publisher-suggestion-publication.queue';
import {
  PUBLISHER_SUGGESTION_ADMISSION_RETENTION_MS,
  PUBLISHER_SUGGESTION_PENDING_RETENTION_MS,
} from './publisher-suggestion-submission-admission';

const PUBLISHER_SUGGESTION_RECOVERY_PAGE_SIZE = 100;
const PUBLISHER_SUGGESTION_RECOVERY_MAX_PAGES = 2;
const PUBLISHER_SUGGESTION_LEGACY_MIGRATION_BATCH_SIZE = 25;
const PUBLISHER_SUGGESTION_TERMINAL_IMAGE_CLEANUP_BATCH_SIZE = 250;
const PUBLISHER_SUGGESTION_ADMISSION_CLEANUP_BATCH_SIZE = 100;
const PUBLISHER_SUGGESTION_PENDING_CLEANUP_BATCH_SIZE = 100;

type PublisherSuggestionRecoveryCursor = {
  createdAt: Date;
  id: string;
};

type PublisherSuggestionRecoveryRow = {
  id: string;
  payload: Prisma.JsonValue;
  createdAt: Date;
};

function buildPublisherSuggestionRecoveryCursorPredicate(
  cursor: PublisherSuggestionRecoveryCursor | null,
): Prisma.Sql {
  return cursor
    ? Prisma.sql`AND (created_at, id) > (${cursor.createdAt}, ${cursor.id}::text)`
    : Prisma.empty;
}

// FLAG: Keep these literals aligned with the audit-log partial indexes; parameters or OR
// predicates prevent PostgreSQL from proving the partial-index predicates during planning.
export function buildPublisherSuggestionRecoveryQuery(
  cursor: PublisherSuggestionRecoveryCursor | null,
): Prisma.Sql {
  const cursorPredicate = buildPublisherSuggestionRecoveryCursorPredicate(cursor);
  // FLAG: Keep these predicates literal and aligned with the production partial indexes.
  // Parameterizing the action/status OR shape turns this bounded recovery into a table scan.
  return Prisma.sql`
    SELECT id, payload, created_at AS "createdAt"
    FROM (
      (
        SELECT id, payload, created_at
        FROM audit_logs
        WHERE action = 'CHANNEL_DIALOG_SUGGESTION'
          AND payload->>'type' = 'suggest'
          AND payload->>'reviewStatus' = 'publishing'
          AND payload->>'reviewDispatchProfile' = 'PUBLIK_V1'
          ${cursorPredicate}
        ORDER BY created_at ASC, id ASC
        LIMIT 100
      )
      UNION ALL
      (
        SELECT id, payload, created_at
        FROM audit_logs
        WHERE action = 'CHANNEL_DIALOG_SUGGESTION'
          AND COALESCE(NULLIF(payload->>'reviewStatus', ''), 'pending') = 'pending'
          AND payload->>'reviewStatus' = 'pending'
          AND payload->>'reviewDispatchProfile' = 'PUBLIK_V1'
          ${cursorPredicate}
        ORDER BY created_at ASC, id ASC
        LIMIT 100
      )
      UNION ALL
      (
        SELECT id, payload, created_at
        FROM audit_logs
        WHERE action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
          AND payload->>'reviewStatus' IN ('publishing', 'pending')
          AND payload->>'reviewDispatchProfile' = 'PUBLIK_V1'
          ${cursorPredicate}
        ORDER BY created_at ASC, id ASC
        LIMIT 100
      )
    ) AS publisher_suggestion_recovery_candidates
    ORDER BY created_at ASC, id ASC
    LIMIT 100
  `;
}

// FLAG: Publisher terminal status is persisted only after Publication owns durable copies of all
// suggestion images. Keep this predicate terminal-only so retryable claims retain their source.
export function buildPublisherSuggestionTerminalImageCleanupQuery(): Prisma.Sql {
  return Prisma.sql`
    WITH cleanup_candidates AS (
      SELECT id
      FROM (
        (
          SELECT asset.id, audit.created_at, audit.id AS audit_id, asset.position
          FROM audit_logs audit
          INNER JOIN channel_suggestion_image_assets asset
            ON asset.audit_log_id = audit.id
          WHERE audit.action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
            AND audit.payload->>'type' = 'suggest'
            AND audit.payload->>'reviewStatus' = 'published'
          ORDER BY audit.created_at ASC, audit.id ASC, asset.position ASC
          LIMIT ${PUBLISHER_SUGGESTION_TERMINAL_IMAGE_CLEANUP_BATCH_SIZE}
        )
        UNION ALL
        (
          SELECT asset.id, audit.created_at, audit.id AS audit_id, asset.position
          FROM audit_logs audit
          INNER JOIN channel_suggestion_image_assets asset
            ON asset.audit_log_id = audit.id
          WHERE audit.action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
            AND audit.payload->>'type' = 'suggest'
            AND audit.payload->>'reviewStatus' = 'drafted'
          ORDER BY audit.created_at ASC, audit.id ASC, asset.position ASC
          LIMIT ${PUBLISHER_SUGGESTION_TERMINAL_IMAGE_CLEANUP_BATCH_SIZE}
        )
        UNION ALL
        (
          SELECT asset.id, audit.created_at, audit.id AS audit_id, asset.position
          FROM audit_logs audit
          INNER JOIN channel_suggestion_image_assets asset
            ON asset.audit_log_id = audit.id
          WHERE audit.action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
            AND audit.payload->>'type' = 'suggest'
            AND audit.payload->>'reviewStatus' = 'cancelled'
          ORDER BY audit.created_at ASC, audit.id ASC, asset.position ASC
          LIMIT ${PUBLISHER_SUGGESTION_TERMINAL_IMAGE_CLEANUP_BATCH_SIZE}
        )
      ) terminal_assets
      ORDER BY created_at ASC, audit_id ASC, position ASC
      LIMIT ${PUBLISHER_SUGGESTION_TERMINAL_IMAGE_CLEANUP_BATCH_SIZE}
    )
    DELETE FROM channel_suggestion_image_assets asset
    USING cleanup_candidates candidate
    WHERE asset.id = candidate.id
  `;
}

export function buildPublisherSuggestionAdmissionCleanupQuery(cutoff: Date): Prisma.Sql {
  return Prisma.sql`
    WITH cleanup_candidates AS (
      SELECT id
      FROM audit_logs
      WHERE action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION_ADMISSION'
        AND created_at < ${cutoff}
      ORDER BY created_at ASC, id ASC
      LIMIT ${PUBLISHER_SUGGESTION_ADMISSION_CLEANUP_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM audit_logs audit
    USING cleanup_candidates candidate
    WHERE audit.id = candidate.id
      AND audit.action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION_ADMISSION'
      AND audit.created_at < ${cutoff}
  `;
}

// FLAG: Unreviewed Publisher suggestions retain source media for 30 days. Never delete a row that
// owns a review claim; publication recovery must resolve that claim before retention can apply.
export function buildPublisherSuggestionPendingCleanupQuery(cutoff: Date): Prisma.Sql {
  return Prisma.sql`
    WITH cleanup_candidates AS (
      SELECT id
      FROM audit_logs
      WHERE action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
        AND payload->>'type' = 'suggest'
        AND payload->>'reviewStatus' = 'pending'
        AND payload->>'reviewClaimToken' IS NULL
        AND created_at < ${cutoff}
      ORDER BY created_at ASC, id ASC
      LIMIT ${PUBLISHER_SUGGESTION_PENDING_CLEANUP_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM audit_logs audit
    USING cleanup_candidates candidate
    WHERE audit.id = candidate.id
      AND audit.action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
      AND audit.payload->>'type' = 'suggest'
      AND audit.payload->>'reviewStatus' = 'pending'
      AND audit.payload->>'reviewClaimToken' IS NULL
      AND audit.created_at < ${cutoff}
  `;
}

@Injectable()
export class PublisherSuggestionPublicationQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherSuggestionPublicationQueueService.name);
  private readonly recoveryEnabled = roleRunsPublisher(getAppRole());
  private recoveryTimer: NodeJS.Timeout | null = null;
  private recoveryInFlight: Promise<void> | null = null;
  private recoveryCursor: PublisherSuggestionRecoveryCursor | null = null;
  private legacyMigrationCursor: PublisherSuggestionRecoveryCursor | null = null;

  constructor(
    @InjectQueue(PUBLISHER_SUGGESTION_PUBLICATION_QUEUE)
    private readonly queue: Queue<PublisherSuggestionPublicationJob>,
    private readonly prisma: PrismaService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly backgroundWork: PublisherBackgroundWorkCoordinatorService,
    @Optional() private readonly runtimeBoundary?: PublisherRuntimeBoundaryService,
  ) {}

  onModuleInit(): void {
    if (!this.recoveryEnabled || this.runtimeBoundary?.dispatchEnabled !== true) {
      return;
    }
    this.recoveryTimer = setInterval(() => this.triggerRecovery(), 60_000);
    this.recoveryTimer.unref();
    this.triggerRecovery();
  }

  onModuleDestroy(): void {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  async enqueue(
    suggestionId: string,
    claimToken: string,
    options: { recycleCompleted?: boolean } = {},
  ): Promise<void> {
    const normalizedSuggestionId = suggestionId.trim();
    const normalizedClaimToken = claimToken.trim();
    if (!normalizedSuggestionId || !normalizedClaimToken) {
      throw new Error('Publisher suggestion queue requires a suggestion id and claim token');
    }
    const jobId = `publik-suggestion-${createHash('sha256')
      .update(`${normalizedSuggestionId}\0${normalizedClaimToken}`)
      .digest('hex')}`;
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'failed') {
        await existing.retry();
        return;
      }
      if (state === 'completed' && options.recycleCompleted === true) {
        // An older rolling-deploy worker can consume an unknown Publisher claim as a no-op.
        // A still-publishing audit row is the authority to recreate that exact durable job.
        await existing.remove();
      } else {
        return;
      }
    }
    await this.queue.add(
      PUBLISHER_SUGGESTION_PUBLICATION_JOB,
      {
        suggestionId: normalizedSuggestionId,
        claimToken: normalizedClaimToken,
        createdAt: new Date().toISOString(),
      },
      {
        jobId,
        ...PUBLISHER_SUGGESTION_PUBLICATION_RETRY_POLICY,
      },
    );
  }

  private async recover(): Promise<void> {
    if (!this.recoveryEnabled || this.runtimeBoundary?.dispatchEnabled !== true) {
      return;
    }
    if (this.recoveryInFlight) {
      await this.recoveryInFlight;
      return;
    }
    const run = this.backgroundWork.runExclusive('suggestion_recovery', () =>
      this.recoverExclusive(),
    );
    this.recoveryInFlight = run;
    try {
      await run;
    } finally {
      if (this.recoveryInFlight === run) {
        this.recoveryInFlight = null;
      }
    }
  }

  private async recoverExclusive(): Promise<void> {
    try {
      await this.cleanupTerminalArtifacts();
      if (await this.dispatchHealth.isGloballyPaused()) {
        return;
      }
      await this.migrateLegacyInlineClaims();
      let cursor = this.recoveryCursor;
      let failedClaims = 0;
      let firstFailure: unknown = null;
      for (let page = 0; page < PUBLISHER_SUGGESTION_RECOVERY_MAX_PAGES; page += 1) {
        const rows = await this.prisma.$queryRaw<PublisherSuggestionRecoveryRow[]>(
          buildPublisherSuggestionRecoveryQuery(cursor),
        );
        if (rows.length === 0) {
          this.recoveryCursor = null;
          break;
        }
        for (const row of rows) {
          const payload =
            row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
              ? (row.payload as Record<string, unknown>)
              : {};
          const claim =
            readChannelSuggestionPublicationClaimV1(payload, row.id) ??
            readPublisherSuggestionReviewClaim(payload, row.id, { allowPending: true });
          if (!claim) {
            continue;
          }
          try {
            await this.enqueue(row.id, claim.claimToken, {
              recycleCompleted: isPublisherSuggestionReviewProtocol(payload),
            });
          } catch (error: unknown) {
            failedClaims += 1;
            firstFailure ??= error;
          }
        }

        const lastRow = rows.at(-1)!;
        cursor = { createdAt: lastRow.createdAt, id: lastRow.id };
        this.recoveryCursor =
          rows.length === PUBLISHER_SUGGESTION_RECOVERY_PAGE_SIZE ? cursor : null;
        if (!this.recoveryCursor) {
          break;
        }
      }
      if (failedClaims > 0) {
        this.logger.warn(
          {
            failedClaims,
            err: firstFailure instanceof Error ? firstFailure.message : String(firstFailure),
          },
          'Failed to recover some queued Publik suggestion publications',
        );
      }
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to recover queued Publik suggestion publications',
      );
    }
  }

  private async cleanupTerminalArtifacts(): Promise<void> {
    const operations = [
      {
        name: 'terminal image assets',
        query: buildPublisherSuggestionTerminalImageCleanupQuery(),
      },
      {
        name: 'expired submission admissions',
        query: buildPublisherSuggestionAdmissionCleanupQuery(
          new Date(Date.now() - PUBLISHER_SUGGESTION_ADMISSION_RETENTION_MS),
        ),
      },
      {
        name: 'expired unreviewed suggestions',
        query: buildPublisherSuggestionPendingCleanupQuery(
          new Date(Date.now() - PUBLISHER_SUGGESTION_PENDING_RETENTION_MS),
        ),
      },
    ];
    for (const operation of operations) {
      try {
        await this.prisma.$executeRaw(operation.query);
      } catch (error: unknown) {
        this.logger.warn(
          {
            cleanup: operation.name,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed bounded Publisher suggestion artifact cleanup',
        );
      }
    }
  }

  private async migrateLegacyInlineClaims(): Promise<void> {
    const nowMs = Date.now();
    const staleBefore = new Date(nowMs - PUBLISHER_SUGGESTION_LEGACY_INLINE_STALE_MS);
    let cursor = this.legacyMigrationCursor;
    for (let page = 0; page < PUBLISHER_SUGGESTION_RECOVERY_MAX_PAGES; page += 1) {
      const candidates = await this.prisma.$queryRaw<
        Array<{ id: string; payload: Prisma.JsonValue; createdAt: Date }>
      >(Prisma.sql`
        SELECT id, payload, created_at AS "createdAt"
        FROM audit_logs
        WHERE action = ${PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST}::text
          AND payload->>'type' = 'suggest'
          AND payload->>'reviewStatus' = 'publishing'
          AND payload->>'reviewPublicationProtocol' IS NULL
          AND NULLIF(payload->>'reviewedByUserId', '') IS NOT NULL
          AND NULLIF(payload->>'reviewedAt', '') IS NOT NULL
          AND payload->>'reviewedAt' <= ${staleBefore.toISOString()}::text
          ${
            cursor
              ? Prisma.sql`AND (
                created_at > ${cursor.createdAt}
                OR (created_at = ${cursor.createdAt} AND id > ${cursor.id}::text)
              )`
              : Prisma.empty
          }
        ORDER BY created_at ASC, id ASC
        LIMIT ${PUBLISHER_SUGGESTION_LEGACY_MIGRATION_BATCH_SIZE}
      `);
      if (candidates.length === 0) {
        this.legacyMigrationCursor = null;
        break;
      }

      for (const candidate of candidates) {
        const payload =
          candidate.payload &&
          typeof candidate.payload === 'object' &&
          !Array.isArray(candidate.payload)
            ? (candidate.payload as Record<string, unknown>)
            : {};
        const legacyClaim = readLegacyPublisherSuggestionInlineClaim(payload, candidate.id, nowMs);
        if (!legacyClaim) continue;
        const claimToken = randomUUID();
        const patch = {
          reviewAction: 'publish',
          reviewDispatchProfile: PUBLISHER_SUGGESTION_DISPATCH_PROFILE,
          reviewPublicationProtocol: PUBLISHER_SUGGESTION_REVIEW_PROTOCOL,
          reviewPublicationRequestId: legacyClaim.requestId,
          reviewClaimToken: claimToken,
          reviewClaimedAt: legacyClaim.claimedAt,
          reviewClaimedByUserId: legacyClaim.claimedByUserId,
          reviewClaimedByUsername: null,
          reviewClaimedByDisplayName: null,
          reviewClaimedByAvatarUrl: null,
          reviewClaimedByProfileUrl: null,
          reviewClaimMigratedFrom: 'inline_v0',
        } satisfies Prisma.InputJsonObject;
        const migrated = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE audit_logs
          SET payload = payload::jsonb || ${JSON.stringify(patch)}::jsonb
          WHERE id = ${candidate.id}::text
            AND action = ${PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST}::text
            AND payload->>'type' = 'suggest'
            AND payload->>'reviewStatus' = 'publishing'
            AND payload->>'reviewPublicationProtocol' IS NULL
            AND payload->>'reviewedByUserId' = ${legacyClaim.claimedByUserId}::text
            AND payload->>'reviewedAt' = ${legacyClaim.claimedAt}::text
            AND payload->>'reviewedAt' <= ${staleBefore.toISOString()}::text
          RETURNING id
        `);
        if (migrated.length === 0) continue;
        try {
          await this.enqueue(candidate.id, claimToken, { recycleCompleted: true });
        } catch (error: unknown) {
          this.logger.warn(
            {
              suggestionId: candidate.id,
              err: error instanceof Error ? error.message : String(error),
            },
            'Migrated legacy Publik suggestion claim; queue recovery will retry enqueue',
          );
        }
      }

      const last = candidates.at(-1)!;
      cursor = { createdAt: last.createdAt, id: last.id };
      this.legacyMigrationCursor =
        candidates.length === PUBLISHER_SUGGESTION_LEGACY_MIGRATION_BATCH_SIZE ? cursor : null;
      if (!this.legacyMigrationCursor) break;
    }
  }

  private triggerRecovery(): void {
    if (this.recoveryInFlight) {
      return;
    }
    void this.recover().catch((error: unknown) => {
      if (error instanceof PublisherBackgroundWorkCoordinatorClosedError) {
        return;
      }
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to schedule Publik suggestion recovery',
      );
    });
  }
}
