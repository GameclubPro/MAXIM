import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherActionCredentialService } from '../publisher/publisher-action-credential.service';
import { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import {
  buildPublisherSuggestionAdminSyncMarker,
  PublisherSuggestionAdminQueueService,
  type PublisherSuggestionAdminReviewStatus,
} from '../publisher/publisher-suggestion-admin.queue';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import { reconcileStaleChannelSuggestionDeliveryClaims } from './admin-channel-suggestion-delivery-ledger';
import { CHANNEL_SUGGESTION_DELIVERY_RECOVERY_STALE_MS } from './admin.service.support';
import { PUBLISHER_SUGGESTION_PENDING_RETENTION_MS } from './publisher-suggestion-submission-admission';

const PUBLISHER_SUGGESTION_ADMIN_RECOVERY_STARTUP_DELAY_MS = 15_000;
const PUBLISHER_SUGGESTION_ADMIN_RECOVERY_INTERVAL_MS = 60_000;
const PUBLISHER_SUGGESTION_ADMIN_RECOVERY_BATCH_SIZE = 25;

@Injectable()
export class PublisherSuggestionAdminRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherSuggestionAdminRecoveryService.name);
  private readonly enabled: boolean;
  private readonly publisherBotId: string;
  private startupTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private recoveryCursor: { createdAt: Date; id: string } | null = null;
  private terminalSyncCursor: { createdAt: Date; id: string } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PublisherSuggestionAdminQueueService,
    runtimeBoundary: PublisherRuntimeBoundaryService,
    credentials: PublisherActionCredentialService,
  ) {
    this.enabled =
      roleRunsPublisher(getAppRole()) &&
      process.env.APP_SERVICE_NAME === 'api-publisher' &&
      runtimeBoundary.dispatchEnabled;
    this.publisherBotId = credentials.getBotId();
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.run('startup');
    }, PUBLISHER_SUGGESTION_ADMIN_RECOVERY_STARTUP_DELAY_MS);
    this.startupTimer.unref?.();
    this.timer = setInterval(() => {
      void this.run('scheduled');
    }, PUBLISHER_SUGGESTION_ADMIN_RECOVERY_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.timer) clearInterval(this.timer);
    this.startupTimer = null;
    this.timer = null;
  }

  private async run(reason: 'startup' | 'scheduled'): Promise<void> {
    if (!this.enabled || this.inFlight) return;
    this.inFlight = true;
    try {
      const recovered = await this.recover();
      if (recovered > 0) {
        this.logger.warn({ reason, recovered }, 'Recovered Publisher suggestion admin deliveries');
      }
    } catch (error: unknown) {
      this.logger.warn(
        { reason, err: error instanceof Error ? error.message : String(error) },
        'Failed to recover Publisher suggestion admin deliveries',
      );
    } finally {
      this.inFlight = false;
    }
  }

  async recover(now = new Date()): Promise<number> {
    if (!this.enabled) return 0;
    const staleBefore = new Date(now.getTime() - CHANNEL_SUGGESTION_DELIVERY_RECOVERY_STALE_MS);
    const lookbackFrom = new Date(now.getTime() - PUBLISHER_SUGGESTION_PENDING_RETENTION_MS);
    const botKey = `publisher:${this.publisherBotId}`;
    const rows = await this.prisma.$queryRaw<Array<{ id: string; createdAt: Date }>>(
      buildPublisherSuggestionAdminRecoveryQuery({
        lookbackFrom,
        staleBefore,
        botKey,
        publisherBotId: this.publisherBotId,
        cursor: this.recoveryCursor,
      }),
    );

    let recovered = 0;
    for (const row of rows) {
      try {
        await reconcileStaleChannelSuggestionDeliveryClaims({
          prisma: this.prisma,
          auditLogId: row.id,
          auditAction: 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION',
          botKey,
          staleBefore,
        });
        await this.queue.enqueueDelivery({
          suggestionId: row.id,
          requiredBotId: this.publisherBotId,
          recoverExisting: true,
        });
        recovered += 1;
      } catch (error: unknown) {
        this.logger.warn(
          { suggestionId: row.id, err: error instanceof Error ? error.message : String(error) },
          'Failed to recover one Publisher suggestion admin delivery',
        );
      }
    }
    const last = rows.at(-1);
    this.recoveryCursor =
      rows.length >= PUBLISHER_SUGGESTION_ADMIN_RECOVERY_BATCH_SIZE && last
        ? { createdAt: last.createdAt, id: last.id }
        : null;
    let terminalRows: Array<{
      id: string;
      reviewStatus: PublisherSuggestionAdminReviewStatus;
      createdAt: Date;
    }> = [];
    try {
      terminalRows = await this.prisma.$queryRaw<
        Array<{
          id: string;
          reviewStatus: PublisherSuggestionAdminReviewStatus;
          createdAt: Date;
        }>
      >(
        buildPublisherSuggestionAdminTerminalSyncRecoveryQuery({
          lookbackFrom,
          botKey,
          publisherBotId: this.publisherBotId,
          cursor: this.terminalSyncCursor,
        }),
      );
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to scan terminal Publisher suggestion cards for synchronization',
      );
    }
    for (const row of terminalRows) {
      try {
        await this.queue.enqueueSync({
          suggestionId: row.id,
          requiredBotId: this.publisherBotId,
          reviewStatus: row.reviewStatus,
          recoverExisting: true,
        });
        recovered += 1;
      } catch (error: unknown) {
        this.logger.warn(
          { suggestionId: row.id, err: error instanceof Error ? error.message : String(error) },
          'Failed to recover one terminal Publisher suggestion card sync',
        );
      }
    }
    const lastTerminal = terminalRows.at(-1);
    this.terminalSyncCursor =
      terminalRows.length >= PUBLISHER_SUGGESTION_ADMIN_RECOVERY_BATCH_SIZE && lastTerminal
        ? { createdAt: lastTerminal.createdAt, id: lastTerminal.id }
        : null;
    let recoveredSyncJobs = 0;
    try {
      recoveredSyncJobs = await this.queue.recoverFailedSyncJobs(
        this.publisherBotId,
        PUBLISHER_SUGGESTION_ADMIN_RECOVERY_BATCH_SIZE,
      );
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to inspect failed Publisher suggestion card-sync jobs',
      );
    }
    return recovered + recoveredSyncJobs;
  }
}

// FLAG: Keep terminal statuses as literal, independently limited branches so the bounded
// action/created-at index walk cannot collapse into an unbounded JSON-status scan.
export function buildPublisherSuggestionAdminTerminalSyncRecoveryQuery(params: {
  lookbackFrom: Date;
  botKey: string;
  publisherBotId: string;
  cursor?: { createdAt: Date; id: string } | null;
}): Prisma.Sql {
  const cursorPredicate = params.cursor
    ? Prisma.sql`AND (audit.created_at, audit.id) > (${params.cursor.createdAt}, ${params.cursor.id}::text)`
    : Prisma.empty;
  const publishedSyncKey = buildPublisherSuggestionAdminSyncMarker(
    params.publisherBotId,
    'published',
  );
  const draftedSyncKey = buildPublisherSuggestionAdminSyncMarker(params.publisherBotId, 'drafted');
  const cancelledSyncKey = buildPublisherSuggestionAdminSyncMarker(
    params.publisherBotId,
    'cancelled',
  );
  return Prisma.sql`
    SELECT id, "reviewStatus", created_at AS "createdAt"
    FROM (
      (
        SELECT audit.id, 'published'::text AS "reviewStatus", audit.created_at
        FROM audit_logs audit
        CROSS JOIN LATERAL (
          SELECT COUNT(*)::integer AS sent_card_count
          FROM channel_suggestion_admin_deliveries delivery
          WHERE delivery.audit_log_id = audit.id
            AND delivery.bot_key = ${params.botKey}
            AND delivery.status = 'SENT'::"ChannelSuggestionAdminDeliveryStatus"
            AND delivery.private_chat_id IS NOT NULL
            AND delivery.remote_message_id IS NOT NULL
        ) delivery_sync
        WHERE audit.action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
          AND audit.payload->>'type' = 'suggest'
          AND audit.payload->>'reviewStatus' = 'published'
          AND audit.created_at >= ${params.lookbackFrom}
          ${cursorPredicate}
          AND delivery_sync.sent_card_count > 0
          AND NOT (
            COALESCE(audit.payload->>'publisherAdminCardSyncKey', '') = ${publishedSyncKey}
            AND CASE
              WHEN COALESCE(audit.payload->>'publisherAdminCardSyncedCount', '') ~ '^[0-9]{1,9}$'
                THEN (audit.payload->>'publisherAdminCardSyncedCount')::integer
              ELSE -1
            END = delivery_sync.sent_card_count
          )
        ORDER BY audit.created_at ASC, audit.id ASC
        LIMIT ${PUBLISHER_SUGGESTION_ADMIN_RECOVERY_BATCH_SIZE}
      )
      UNION ALL
      (
        SELECT audit.id, 'drafted'::text AS "reviewStatus", audit.created_at
        FROM audit_logs audit
        CROSS JOIN LATERAL (
          SELECT COUNT(*)::integer AS sent_card_count
          FROM channel_suggestion_admin_deliveries delivery
          WHERE delivery.audit_log_id = audit.id
            AND delivery.bot_key = ${params.botKey}
            AND delivery.status = 'SENT'::"ChannelSuggestionAdminDeliveryStatus"
            AND delivery.private_chat_id IS NOT NULL
            AND delivery.remote_message_id IS NOT NULL
        ) delivery_sync
        WHERE audit.action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
          AND audit.payload->>'type' = 'suggest'
          AND audit.payload->>'reviewStatus' = 'drafted'
          AND audit.created_at >= ${params.lookbackFrom}
          ${cursorPredicate}
          AND delivery_sync.sent_card_count > 0
          AND NOT (
            COALESCE(audit.payload->>'publisherAdminCardSyncKey', '') = ${draftedSyncKey}
            AND CASE
              WHEN COALESCE(audit.payload->>'publisherAdminCardSyncedCount', '') ~ '^[0-9]{1,9}$'
                THEN (audit.payload->>'publisherAdminCardSyncedCount')::integer
              ELSE -1
            END = delivery_sync.sent_card_count
          )
        ORDER BY audit.created_at ASC, audit.id ASC
        LIMIT ${PUBLISHER_SUGGESTION_ADMIN_RECOVERY_BATCH_SIZE}
      )
      UNION ALL
      (
        SELECT audit.id, 'cancelled'::text AS "reviewStatus", audit.created_at
        FROM audit_logs audit
        CROSS JOIN LATERAL (
          SELECT COUNT(*)::integer AS sent_card_count
          FROM channel_suggestion_admin_deliveries delivery
          WHERE delivery.audit_log_id = audit.id
            AND delivery.bot_key = ${params.botKey}
            AND delivery.status = 'SENT'::"ChannelSuggestionAdminDeliveryStatus"
            AND delivery.private_chat_id IS NOT NULL
            AND delivery.remote_message_id IS NOT NULL
        ) delivery_sync
        WHERE audit.action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
          AND audit.payload->>'type' = 'suggest'
          AND audit.payload->>'reviewStatus' = 'cancelled'
          AND audit.created_at >= ${params.lookbackFrom}
          ${cursorPredicate}
          AND delivery_sync.sent_card_count > 0
          AND NOT (
            COALESCE(audit.payload->>'publisherAdminCardSyncKey', '') = ${cancelledSyncKey}
            AND CASE
              WHEN COALESCE(audit.payload->>'publisherAdminCardSyncedCount', '') ~ '^[0-9]{1,9}$'
                THEN (audit.payload->>'publisherAdminCardSyncedCount')::integer
              ELSE -1
            END = delivery_sync.sent_card_count
          )
        ORDER BY audit.created_at ASC, audit.id ASC
        LIMIT ${PUBLISHER_SUGGESTION_ADMIN_RECOVERY_BATCH_SIZE}
      )
    ) publisher_suggestion_terminal_sync_recovery
    ORDER BY created_at ASC, id ASC
    LIMIT ${PUBLISHER_SUGGESTION_ADMIN_RECOVERY_BATCH_SIZE}
  `;
}

// FLAG: Each literal branch must stay independently limited. OR/action parameters prevent
// PostgreSQL from proving the Publisher suggestion partial-index predicates.
export function buildPublisherSuggestionAdminRecoveryQuery(params: {
  lookbackFrom: Date;
  staleBefore: Date;
  botKey: string;
  publisherBotId: string;
  cursor?: { createdAt: Date; id: string } | null;
}): Prisma.Sql {
  const cursorPredicate = params.cursor
    ? Prisma.sql`AND (audit.created_at, audit.id) > (${params.cursor.createdAt}, ${params.cursor.id}::text)`
    : Prisma.empty;
  return Prisma.sql`
    SELECT id, MIN(created_at) AS "createdAt"
    FROM (
      (
        SELECT audit.id, audit.created_at
        FROM audit_logs audit
        WHERE audit.action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
          AND audit.payload->>'type' = 'suggest'
          AND audit.payload->>'reviewStatus' = 'pending'
          AND audit.payload->>'reviewClaimToken' IS NULL
          AND audit.created_at >= ${params.lookbackFrom}
          ${cursorPredicate}
          AND NOT EXISTS (
            SELECT 1
            FROM channel_suggestion_admin_deliveries delivery
            WHERE delivery.audit_log_id = audit.id
              AND delivery.bot_key = ${params.botKey}
          )
        ORDER BY audit.created_at ASC, audit.id ASC
        LIMIT ${PUBLISHER_SUGGESTION_ADMIN_RECOVERY_BATCH_SIZE}
      )
      UNION ALL
      (
        SELECT audit.id, audit.created_at
        FROM audit_logs audit
        INNER JOIN channel_suggestion_admin_deliveries delivery
          ON delivery.audit_log_id = audit.id
        WHERE audit.action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
          AND audit.payload->>'type' = 'suggest'
          AND audit.payload->>'reviewStatus' = 'pending'
          AND audit.payload->>'reviewClaimToken' IS NULL
          AND audit.created_at >= ${params.lookbackFrom}
          ${cursorPredicate}
          AND delivery.bot_key = ${params.botKey}
          AND delivery.status = 'PENDING'
        ORDER BY audit.created_at ASC, audit.id ASC
        LIMIT ${PUBLISHER_SUGGESTION_ADMIN_RECOVERY_BATCH_SIZE}
      )
      UNION ALL
      (
        SELECT audit.id, audit.created_at
        FROM audit_logs audit
        INNER JOIN channel_suggestion_admin_deliveries delivery
          ON delivery.audit_log_id = audit.id
        WHERE audit.action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
          AND audit.payload->>'type' = 'suggest'
          AND audit.payload->>'reviewStatus' = 'pending'
          AND audit.payload->>'reviewClaimToken' IS NULL
          AND audit.created_at >= ${params.lookbackFrom}
          ${cursorPredicate}
          AND delivery.bot_key = ${params.botKey}
          AND delivery.status = 'FAILED'
          AND delivery.terminal = FALSE
        ORDER BY audit.created_at ASC, audit.id ASC
        LIMIT ${PUBLISHER_SUGGESTION_ADMIN_RECOVERY_BATCH_SIZE}
      )
      UNION ALL
      (
        SELECT audit.id, audit.created_at
        FROM audit_logs audit
        INNER JOIN channel_suggestion_admin_deliveries delivery
          ON delivery.audit_log_id = audit.id
        WHERE audit.action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
          AND audit.payload->>'type' = 'suggest'
          AND audit.payload->>'reviewStatus' = 'pending'
          AND audit.payload->>'reviewClaimToken' IS NULL
          AND audit.created_at >= ${params.lookbackFrom}
          ${cursorPredicate}
          AND delivery.bot_key = ${params.botKey}
          AND delivery.status = 'SENDING'
          AND delivery.locked_at < ${params.staleBefore}
        ORDER BY audit.created_at ASC, audit.id ASC
        LIMIT ${PUBLISHER_SUGGESTION_ADMIN_RECOVERY_BATCH_SIZE}
      )
      UNION ALL
      (
        SELECT audit.id, audit.created_at
        FROM audit_logs audit
        INNER JOIN channel_suggestion_admin_deliveries delivery
          ON delivery.audit_log_id = audit.id
        WHERE audit.action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
          AND audit.payload->>'type' = 'suggest'
          AND audit.payload->>'reviewStatus' = 'pending'
          AND audit.payload->>'reviewClaimToken' IS NULL
          AND audit.created_at >= ${params.lookbackFrom}
          ${cursorPredicate}
          AND delivery.bot_key = ${params.botKey}
          AND delivery.status = 'FAILED'
          AND delivery.terminal = TRUE
          AND delivery.last_error_code = 'suggestion.delivery.dialog_unavailable'
          AND EXISTS (
            SELECT 1
            FROM webhook_events private_start
            WHERE private_start.bot_id = ${params.publisherBotId}
              AND private_start.created_at > delivery.updated_at
              AND private_start.normalized_payload->'message'->>'senderId' = delivery.admin_user_id
              AND private_start.normalized_payload->'message'->>'chatId' ~ '^[1-9][0-9]*$'
              AND private_start.normalized_payload->>'type' IN (
                'bot_started',
                'message_created'
              )
          )
        ORDER BY audit.created_at ASC, audit.id ASC
        LIMIT ${PUBLISHER_SUGGESTION_ADMIN_RECOVERY_BATCH_SIZE}
      )
      UNION ALL
      (
        SELECT audit.id, audit.created_at
        FROM audit_logs audit
        INNER JOIN channel_suggestion_admin_deliveries delivery
          ON delivery.audit_log_id = audit.id
        WHERE audit.action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
          AND audit.payload->>'type' = 'suggest'
          AND audit.payload->>'reviewStatus' = 'pending'
          AND audit.payload->>'reviewClaimToken' IS NULL
          AND audit.created_at >= ${params.lookbackFrom}
          ${cursorPredicate}
          AND delivery.bot_key = ${params.botKey}
          AND delivery.status = 'FAILED'
          AND delivery.terminal = TRUE
          AND delivery.last_error_code = 'suggestion.delivery.no_reachable_dialog'
          AND EXISTS (
            SELECT 1
            FROM webhook_events private_start
            WHERE private_start.bot_id = ${params.publisherBotId}
              AND private_start.created_at > delivery.updated_at
              AND private_start.normalized_payload->'message'->>'senderId' = delivery.admin_user_id
              AND private_start.normalized_payload->'message'->>'chatId' ~ '^[1-9][0-9]*$'
              AND private_start.normalized_payload->>'type' IN (
                'bot_started',
                'message_created'
              )
          )
        ORDER BY audit.created_at ASC, audit.id ASC
        LIMIT ${PUBLISHER_SUGGESTION_ADMIN_RECOVERY_BATCH_SIZE}
      )
    ) publisher_suggestion_admin_recovery
    GROUP BY id
    ORDER BY MIN(created_at) ASC, id ASC
    LIMIT ${PUBLISHER_SUGGESTION_ADMIN_RECOVERY_BATCH_SIZE}
  `;
}
