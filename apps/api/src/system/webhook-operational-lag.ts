import { Prisma } from '../prisma/prisma-client';
import { MULTIBOT_EXECUTION_AUTHORITY_VERSION } from '../webhook/webhook-semantic-authority';
import {
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX,
  WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINE_PREFIX,
} from '../webhook/webhook-timeout-quarantine';

export const WEBHOOK_READINESS_LAG_HEAD_LIMIT = 64;

export type WebhookOperationalLagHead = {
  id: string;
  createdAt: Date;
  nextEnqueueAt: Date | null;
  executionDeadlineAt: Date | null;
  readinessWaiting: boolean;
};

export function buildWebhookOperationalLagQuery(): Prisma.Sql {
  // FLAG: Materialize at most 65 indexed receipt heads before inspecting scalar proof fields.
  // The last head remains undiscounted, so unknown work beyond the proof budget fails closed.
  // Neither receipt bodies nor command journals leave PostgreSQL on this health path.
  return Prisma.sql`
    WITH heads AS MATERIALIZED (
      SELECT "id", "created_at", "next_enqueue_at", "execution_deadline_at", "semantic_key",
             "timeout_quarantine_expires_at", "error_message", "legacy_disposition_id",
             "normalized_payload" ->> 'type' AS "event_type"
      FROM "webhook_events"
      WHERE "status" = 'RECEIVED'
      ORDER BY "created_at"
      LIMIT ${WEBHOOK_READINESS_LAG_HEAD_LIMIT + 1}
    )
    SELECT heads."id", heads."created_at" AS "createdAt",
           heads."next_enqueue_at" AS "nextEnqueueAt",
           heads."execution_deadline_at" AS "executionDeadlineAt",
           COALESCE(proof."waiting", false) AS "readinessWaiting"
    FROM heads
    LEFT JOIN LATERAL (
      SELECT true AS "waiting"
      FROM "webhook_execution_claims" AS claim
      WHERE claim."kind" = 'EXECUTION' AND claim."semantic_key" = heads."semantic_key"
        AND claim."webhook_event_id" = heads."id"
        AND claim."status" = 'PENDING' AND claim."enforced"
        AND claim."business_started_at" IS NULL AND claim."completed_at" IS NULL
        AND heads."next_enqueue_at" IS NOT NULL
        AND heads."event_type" IN ('user_added', 'message_created', 'message_edited')
        AND heads."execution_deadline_at" <= heads."created_at" +
            CASE WHEN heads."event_type" = 'user_added' THEN INTERVAL '5 minutes'
                 ELSE INTERVAL '10 minutes' END
        AND heads."timeout_quarantine_expires_at" IS NULL
        AND heads."legacy_disposition_id" IS NULL
        AND COALESCE(heads."error_message", '') NOT LIKE ${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX + '%'}
        AND COALESCE(heads."error_message", '') NOT LIKE ${WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINE_PREFIX + '%'}
        AND POSITION('ambiguous' IN LOWER(COALESCE(heads."error_message", ''))) = 0
        AND claim."command_result" @> jsonb_build_object(
          'kind', 'EXECUTION_WAITING',
          'authorityVersion', ${MULTIBOT_EXECUTION_AUTHORITY_VERSION}::text,
          'webhookEventId', heads."id", 'semanticKey', heads."semantic_key",
          'deadlineAt', to_char(heads."execution_deadline_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
      LIMIT 1
    ) AS proof ON true
    ORDER BY heads."created_at"
  `;
}

export function resolveWebhookOperationalLag(
  heads: WebhookOperationalLagHead[],
  now: Date,
): { lagSec: number; readinessWaitingCount: number; readinessHeadLimitReached: boolean } {
  let lagSec = 0;
  let readinessWaitingCount = 0;
  for (const [index, head] of heads.entries()) {
    // FLAG: The immutable deadline remains an overdue anchor even after expiry. A fresh
    // retry can never hide stalled expiry settlement or renew the original time window.
    const waiting =
      index < WEBHOOK_READINESS_LAG_HEAD_LIMIT &&
      head.readinessWaiting &&
      head.nextEnqueueAt !== null &&
      head.executionDeadlineAt !== null;
    const actionableAt = waiting
      ? Math.min(head.nextEnqueueAt!.getTime(), head.executionDeadlineAt!.getTime())
      : head.createdAt.getTime();
    lagSec = Math.max(lagSec, (now.getTime() - actionableAt) / 1_000);
    if (waiting) readinessWaitingCount += 1;
  }
  return {
    lagSec,
    readinessWaitingCount,
    readinessHeadLimitReached: heads.length > WEBHOOK_READINESS_LAG_HEAD_LIMIT,
  };
}
