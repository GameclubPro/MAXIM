import { ChannelSuggestionAdminDeliveryStatus, Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';

export type RecoverableChannelSuggestionDeliveryRow = {
  id: string;
  adminUserId: string;
  status: ChannelSuggestionAdminDeliveryStatus;
  terminal: boolean;
  botId: string | null;
  lastStatusCode: number | null;
  lastErrorCode: string | null;
};

export function isTerminalPrivateDialogDeliveryRow(
  row: RecoverableChannelSuggestionDeliveryRow,
): boolean {
  if (row.status !== ChannelSuggestionAdminDeliveryStatus.FAILED || !row.terminal) return false;
  const code = row.lastErrorCode?.trim().toLowerCase() ?? '';
  if (code.startsWith('suggestion.delivery.')) {
    return [
      'suggestion.delivery.dialog_unavailable',
      'suggestion.delivery.no_reachable_dialog',
    ].includes(code);
  }
  return (
    row.lastStatusCode === 403 ||
    row.lastStatusCode === 404 ||
    ['access.denied', 'chat.denied', 'chat.not.found', 'dialog.not.found'].includes(code)
  );
}

export async function findRecentRecoverableChannelSuggestionAuditLogIds(params: {
  prisma: PrismaService;
  action: string;
  recoveryFrom: Date;
  staleBefore: Date;
  limit: number;
}): Promise<string[]> {
  const rows = await params.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH ranked_admin_suggestions AS (
      SELECT
        audit.id AS audit_log_id,
        audit.created_at,
        COALESCE(NULLIF(audit.payload->>'reviewStatus', ''), 'pending') AS review_status,
        CASE
          WHEN COALESCE(audit.payload->>'deliveryAttemptedAt', '') ~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
            THEN (audit.payload->>'deliveryAttemptedAt')::timestamptz
          ELSE NULL
        END AS delivery_attempted_at,
        delivery.id AS delivery_id,
        delivery.admin_user_id,
        delivery.status,
        delivery.terminal,
        delivery.last_status_code,
        delivery.last_error_code,
        delivery.updated_at,
        DENSE_RANK() OVER (
          PARTITION BY delivery.admin_user_id
          ORDER BY audit.created_at DESC, audit.id DESC
        ) AS admin_suggestion_rank
      FROM channel_suggestion_admin_deliveries delivery
      JOIN audit_logs audit
        ON audit.id = delivery.audit_log_id
      WHERE audit.action = ${params.action}::text
        AND audit.created_at >= ${params.recoveryFrom}
    ),
    eligible_deliveries AS (
      SELECT
        ranked.*,
        ROW_NUMBER() OVER (
          PARTITION BY ranked.admin_user_id, ranked.audit_log_id
          ORDER BY ranked.updated_at DESC, ranked.delivery_id DESC
        ) AS admin_delivery_rank
      FROM ranked_admin_suggestions ranked
      WHERE ranked.admin_suggestion_rank = 1
        AND ranked.created_at <= ${params.staleBefore}
        AND ranked.status = 'FAILED'::"ChannelSuggestionAdminDeliveryStatus"
        AND ranked.terminal = true
        AND ranked.review_status = 'pending'
        AND NOT EXISTS (
          SELECT 1
          FROM channel_suggestion_admin_deliveries blocking_sibling
          WHERE blocking_sibling.audit_log_id = ranked.audit_log_id
            AND blocking_sibling.admin_user_id = ranked.admin_user_id
            AND blocking_sibling.id <> ranked.delivery_id
            AND (
              blocking_sibling.status IN (
                'SENT'::"ChannelSuggestionAdminDeliveryStatus",
                'AMBIGUOUS'::"ChannelSuggestionAdminDeliveryStatus",
                'SENDING'::"ChannelSuggestionAdminDeliveryStatus",
                'PENDING'::"ChannelSuggestionAdminDeliveryStatus"
              )
              OR (
                blocking_sibling.status = 'FAILED'::"ChannelSuggestionAdminDeliveryStatus"
                AND blocking_sibling.terminal = false
              )
            )
        )
        AND (
          (
            LOWER(COALESCE(ranked.last_error_code, '')) NOT LIKE 'suggestion.delivery.%'
            AND (
              ranked.last_status_code IN (403, 404)
              OR LOWER(COALESCE(ranked.last_error_code, '')) IN (
                'access.denied',
                'chat.denied',
                'chat.not.found',
                'dialog.not.found'
              )
            )
          )
          OR (
            LOWER(COALESCE(ranked.last_error_code, '')) IN (
              'suggestion.delivery.dialog_unavailable',
              'suggestion.delivery.no_reachable_dialog'
            )
            AND EXISTS (
              SELECT 1
              FROM webhook_events private_start
              WHERE private_start.normalized_payload->>'type' = 'bot_started'
                AND private_start.normalized_payload->'message'->>'senderId' = ranked.admin_user_id
                AND NULLIF(
                  BTRIM(private_start.normalized_payload->'message'->>'chatId'),
                  ''
                ) ~ '^[1-9][0-9]*$'
                AND private_start.created_at >
                  LEAST(
                    ranked.updated_at,
                    COALESCE(ranked.delivery_attempted_at, ranked.updated_at)
                  )
            )
          )
        )
    )
    SELECT eligible.audit_log_id AS id
    FROM eligible_deliveries eligible
    WHERE eligible.admin_delivery_rank = 1
    GROUP BY eligible.audit_log_id
    ORDER BY MIN(eligible.created_at) ASC
    LIMIT ${params.limit}
  `);

  return Array.from(
    new Set(
      rows
        .map((row) => (typeof row.id === 'string' ? row.id.trim() : ''))
        .filter((id): id is string => id.length > 0),
    ),
  );
}

export async function findRetryableChannelSuggestionAuditLogIds(params: {
  prisma: PrismaService;
  action: string;
  staleBefore: Date;
  limit: number;
}): Promise<string[]> {
  const staleBeforeIso = params.staleBefore.toISOString();
  const rows = await params.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT audit.id
    FROM audit_logs audit
    LEFT JOIN channel_suggestion_admin_deliveries delivery
      ON delivery.audit_log_id = audit.id
    WHERE audit.action = ${params.action}::text
      AND audit.created_at <= ${params.staleBefore}
      AND COALESCE(NULLIF(audit.payload->>'reviewStatus', ''), 'pending') = 'pending'
      AND (delivery.id IS NULL OR delivery.updated_at <= ${params.staleBefore})
      AND (
        delivery.id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM channel_suggestion_admin_deliveries blocking_sibling
          WHERE blocking_sibling.audit_log_id = delivery.audit_log_id
            AND blocking_sibling.admin_user_id = delivery.admin_user_id
            AND blocking_sibling.id <> delivery.id
            AND blocking_sibling.status IN (
              'SENT'::"ChannelSuggestionAdminDeliveryStatus",
              'AMBIGUOUS'::"ChannelSuggestionAdminDeliveryStatus",
              'SENDING'::"ChannelSuggestionAdminDeliveryStatus"
            )
        )
      )
      AND (
        delivery.status = 'PENDING'::"ChannelSuggestionAdminDeliveryStatus"
        OR (
          delivery.status = 'FAILED'::"ChannelSuggestionAdminDeliveryStatus"
          AND delivery.terminal = false
        )
        OR (
          delivery.id IS NULL
          AND audit.payload->>'delivered' = 'false'
          AND COALESCE(
            jsonb_array_length(
              CASE
                WHEN jsonb_typeof(audit.payload->'deliveries') = 'array'
                THEN audit.payload->'deliveries'
                ELSE '[]'::jsonb
              END
            ),
            0
          ) = 0
          AND (
            (
              NOT (audit.payload ? 'deliveryAttemptedAt')
              AND (
                NOT (audit.payload ? 'deliveryJobLastFailedAt')
                OR (
                  audit.payload->>'deliveryJobRecoverable' = 'true'
                  AND COALESCE(audit.payload->>'deliveryJobLastFailedAt', '') ~
                    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
                  AND (audit.payload->>'deliveryJobLastFailedAt')::timestamptz <= ${params.staleBefore}
                )
              )
            )
            OR (
              NULLIF(audit.payload->>'deliveryAttemptedAt', '') <= ${staleBeforeIso}
              AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements(
                  CASE
                    WHEN jsonb_typeof(audit.payload->'deliveryFailures') = 'array'
                    THEN audit.payload->'deliveryFailures'
                    ELSE '[]'::jsonb
                  END
                ) AS delivery_failure(value)
                WHERE delivery_failure.value->>'recoverable' = 'true'
                  OR (
                    delivery_failure.value->>'terminal' = 'false'
                    AND (
                      delivery_failure.value->>'status' IN ('408', '429')
                      OR (
                        (delivery_failure.value->>'status') ~ '^[0-9]+$'
                        AND (delivery_failure.value->>'status')::integer >= 500
                      )
                      OR LOWER(COALESCE(delivery_failure.value->>'code', '')) = 'attachment.not.ready'
                      OR LOWER(COALESCE(delivery_failure.value->>'message', '')) LIKE '%rate limit%'
                      OR LOWER(COALESCE(delivery_failure.value->>'message', '')) LIKE '%temporarily%'
                      OR LOWER(COALESCE(delivery_failure.value->>'message', '')) LIKE '%try again%'
                      OR LOWER(COALESCE(delivery_failure.value->>'message', '')) LIKE '%econnreset%'
                      OR LOWER(COALESCE(delivery_failure.value->>'message', '')) LIKE '%eai_again%'
                      OR LOWER(COALESCE(delivery_failure.value->>'message', '')) LIKE '%connection%'
                      OR LOWER(COALESCE(delivery_failure.value->>'message', '')) LIKE '%connect%'
                    )
                  )
              )
            )
          )
        )
      )
    GROUP BY audit.id, audit.created_at
    ORDER BY MIN(
      CASE
        WHEN delivery.updated_at IS NOT NULL THEN delivery.updated_at
        WHEN COALESCE(audit.payload->>'deliveryAttemptedAt', '') ~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
          THEN (audit.payload->>'deliveryAttemptedAt')::timestamptz
        WHEN COALESCE(audit.payload->>'deliveryJobLastFailedAt', '') ~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
          THEN (audit.payload->>'deliveryJobLastFailedAt')::timestamptz
        ELSE audit.created_at
      END
    ) ASC, audit.created_at ASC
    LIMIT ${params.limit}
  `);
  return rows
    .map((row) => (typeof row.id === 'string' ? row.id.trim() : ''))
    .filter((id): id is string => id.length > 0);
}

export async function recoverChannelSuggestionAdminDeliveriesAfterBotStarted(params: {
  prisma: PrismaService;
  auditLogId: string;
  rows: RecoverableChannelSuggestionDeliveryRow[];
}): Promise<number> {
  const blockedAdminUserIds = new Set(
    params.rows
      .filter((row) => row.status !== ChannelSuggestionAdminDeliveryStatus.FAILED || !row.terminal)
      .map((row) => row.adminUserId),
  );
  const candidateIds = params.rows
    .filter(
      (row) => isTerminalPrivateDialogDeliveryRow(row) && !blockedAdminUserIds.has(row.adminUserId),
    )
    .map((row) => row.id);
  if (candidateIds.length === 0) return 0;

  const matchedRows = await params.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH eligible_deliveries AS (
      SELECT
        delivery.id,
        ROW_NUMBER() OVER (
          PARTITION BY delivery.admin_user_id
          ORDER BY delivery.updated_at DESC, delivery.id DESC
        ) AS admin_delivery_rank
      FROM channel_suggestion_admin_deliveries delivery
      JOIN audit_logs audit
        ON audit.id = delivery.audit_log_id
      WHERE delivery.audit_log_id = ${params.auditLogId}
        AND delivery.id IN (${Prisma.join(candidateIds)})
        AND delivery.status = 'FAILED'::"ChannelSuggestionAdminDeliveryStatus"
        AND delivery.terminal = true
        AND NOT EXISTS (
          SELECT 1
          FROM channel_suggestion_admin_deliveries newer_delivery
          JOIN audit_logs newer_audit
            ON newer_audit.id = newer_delivery.audit_log_id
          WHERE newer_delivery.admin_user_id = delivery.admin_user_id
            AND newer_audit.action = audit.action
            AND (
              newer_audit.created_at > audit.created_at
              OR (
                newer_audit.created_at = audit.created_at
                AND newer_audit.id > audit.id
              )
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM channel_suggestion_admin_deliveries blocking_sibling
          WHERE blocking_sibling.audit_log_id = delivery.audit_log_id
            AND blocking_sibling.admin_user_id = delivery.admin_user_id
            AND blocking_sibling.id <> delivery.id
            AND (
              blocking_sibling.status IN (
                'SENT'::"ChannelSuggestionAdminDeliveryStatus",
                'AMBIGUOUS'::"ChannelSuggestionAdminDeliveryStatus",
                'SENDING'::"ChannelSuggestionAdminDeliveryStatus",
                'PENDING'::"ChannelSuggestionAdminDeliveryStatus"
              )
              OR (
                blocking_sibling.status = 'FAILED'::"ChannelSuggestionAdminDeliveryStatus"
                AND blocking_sibling.terminal = false
              )
            )
          )
        AND (
          (
            LOWER(COALESCE(delivery.last_error_code, '')) NOT LIKE 'suggestion.delivery.%'
            AND (
              delivery.last_status_code IN (403, 404)
              OR LOWER(COALESCE(delivery.last_error_code, '')) IN (
                'access.denied',
                'chat.denied',
                'chat.not.found',
                'dialog.not.found'
              )
            )
          )
          OR (
            LOWER(COALESCE(delivery.last_error_code, '')) IN (
              'suggestion.delivery.dialog_unavailable',
              'suggestion.delivery.no_reachable_dialog'
            )
            AND EXISTS (
              SELECT 1
              FROM webhook_events private_start
              WHERE private_start.normalized_payload->>'type' = 'bot_started'
                AND private_start.normalized_payload->'message'->>'senderId' = delivery.admin_user_id
                AND NULLIF(
                  BTRIM(private_start.normalized_payload->'message'->>'chatId'),
                  ''
                ) ~ '^[1-9][0-9]*$'
                AND private_start.created_at > LEAST(
                  delivery.updated_at,
                  CASE
                    WHEN COALESCE(audit.payload->>'deliveryAttemptedAt', '') ~
                      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
                      THEN (audit.payload->>'deliveryAttemptedAt')::timestamptz
                    ELSE delivery.updated_at
                  END
                )
            )
          )
        )
    ), selected_deliveries AS (
      SELECT eligible.id
      FROM eligible_deliveries eligible
      WHERE eligible.admin_delivery_rank = 1
      LIMIT ${candidateIds.length}
    )
    UPDATE channel_suggestion_admin_deliveries target
    SET
      status = 'PENDING'::"ChannelSuggestionAdminDeliveryStatus",
      private_chat_id = NULL,
      remote_message_id = NULL,
      sent_at = NULL,
      locked_at = NULL,
      lock_token = NULL,
      last_error = NULL,
      last_status_code = NULL,
      last_error_code = NULL,
      terminal = false,
      updated_at = CURRENT_TIMESTAMP
    FROM selected_deliveries selected
    WHERE target.id = selected.id
      AND target.status = 'FAILED'::"ChannelSuggestionAdminDeliveryStatus"
      AND target.terminal = true
    RETURNING target.id
  `);

  return matchedRows.filter((row) => {
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    return id.length > 0 && candidateIds.includes(id);
  }).length;
}
