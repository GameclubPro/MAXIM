import { Prisma } from '../prisma/prisma-client';
import { DORMANT_BOT_OBSERVATION_MARKER } from './webhook-dormant-observation';
import {
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX,
  WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINE_PREFIX,
} from './webhook-timeout-quarantine';

const TIMEOUT_PREFIX_LENGTH_SQL = Prisma.raw(
  String(WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX.length),
);
const TERMINAL_TIMEOUT_PREFIX_LENGTH_SQL = Prisma.raw(
  String(WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINE_PREFIX.length),
);

export function priorWebhookExecutionProofQuery(
  semanticKey: string,
  webhookEventId: string,
): Prisma.Sql {
  // FLAG: Probe claims only by the current exact receipt. OFFSET 0 prevents PostgreSQL
  // from replacing this correlated EXISTS with a hash of all retained claim identities.
  // Only a complete dormant observation without any linked claim is not business proof;
  // replay fences remain independent and the caller retains the earliest semantic anchor.
  return Prisma.sql`
    SELECT "prior"."id"
    FROM "webhook_events" AS "prior"
    WHERE "prior"."semantic_key" = ${semanticKey}
      AND "prior"."id" <> ${webhookEventId}
      AND (
        (
          "prior"."status" = 'PROCESSED'::"WebhookStatus"
          AND (
            "prior"."error_message" IS DISTINCT FROM ${DORMANT_BOT_OBSERVATION_MARKER}
            OR "prior"."processed_at" IS NULL
            OR "prior"."queue_name" IS NOT NULL
            OR "prior"."next_enqueue_at" IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM "webhook_execution_claims" AS "prior_claim"
              WHERE "prior_claim"."webhook_event_id" = "prior"."id"
              OFFSET 0
            )
          )
        )
        OR "prior"."timeout_quarantine_expires_at" IS NOT NULL
        OR "prior"."error_message" ILIKE ${'%AMBIGUOUS%'}
        OR LEFT(COALESCE("prior"."error_message", ''), ${TIMEOUT_PREFIX_LENGTH_SQL})
          = ${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}
        OR LEFT(COALESCE("prior"."error_message", ''), ${TERMINAL_TIMEOUT_PREFIX_LENGTH_SQL})
          = ${WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINE_PREFIX}
      )
    ORDER BY "prior"."created_at", "prior"."id"
    LIMIT 1
  `;
}
