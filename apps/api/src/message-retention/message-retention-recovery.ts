import { Prisma } from '../prisma/prisma-client';
import type { RetentionPurgeCursor } from './message-retention-purge';

// FLAG: Upgrade discovery visits the completed index in bounded pages. It never
// backfills message history or authorizes another DELETE for an ended activation.
export async function discoverRetentionReceipts(
  tx: Prisma.TransactionClient,
  cursor: RetentionPurgeCursor | null,
  before: Date,
): Promise<RetentionPurgeCursor | null> {
  const after = cursor
    ? Prisma.sql`AND ("completed_at", "chat_id", "message_id") >
      (${cursor.completedAt}, ${cursor.chatId}, ${cursor.messageId})`
    : Prisma.empty;
  const page = await tx.$queryRaw<RetentionPurgeCursor[]>(Prisma.sql`
    SELECT "completed_at" AS "completedAt", "chat_id" AS "chatId", "message_id" AS "messageId"
    FROM "message_retention_candidates"
    WHERE "completed_at" <= ${before} ${after}
    ORDER BY "completed_at", "chat_id", "message_id" LIMIT 500
  `);
  if (!page.length) return null;
  // FLAG: Store settlement locks the parent before the candidate. Discovery must
  // use that same order, rather than taking candidate locks before waking policies.
  await tx.$queryRaw(Prisma.sql`
    SELECT "chat_id" FROM "message_retention_policies"
    WHERE "chat_id" IN (${Prisma.join([...new Set(page.map((row) => row.chatId))])})
    ORDER BY "chat_id" FOR UPDATE
  `);
  await tx.$executeRaw(Prisma.sql`
    WITH page("chat_id", "message_id") AS (
      VALUES ${Prisma.join(page.map((row) => Prisma.sql`(${row.chatId}::text, ${row.messageId}::text)`))}
    ), changed AS (
    UPDATE "message_retention_candidates" candidate
    SET "reconcile_after" = CURRENT_TIMESTAMP, "outcome_code" = 'reconciliation'
    FROM page, "moderation_delete_intents" intent
    WHERE candidate."chat_id" = page."chat_id" AND candidate."message_id" = page."message_id"
      AND candidate."outcome_code" IS NULL AND candidate."status" IN ('cancelled', 'skipped')
      AND candidate."intent_id" = intent."id" AND intent."retention_owned" = TRUE
      AND candidate."chat_id" = intent."chat_id" AND candidate."message_id" = intent."message_id"
      AND (
        intent."status" IN ('SUCCEEDED', 'ALREADY_ABSENT', 'AMBIGUOUS')
        OR intent."delete_dispatch_started_at" IS NOT NULL
        OR intent."delete_dispatch_started_bot_id" IS NOT NULL
        OR intent."remote_delete_succeeded_at" IS NOT NULL
        OR intent."remote_delete_succeeded_bot_id" IS NOT NULL
      ) RETURNING candidate."chat_id"
    ) UPDATE "message_retention_policies" policy
      SET "next_run_at" = LEAST(COALESCE(policy."next_run_at", CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
      WHERE policy."chat_id" IN (SELECT "chat_id" FROM changed)
  `);
  return page[page.length - 1]!;
}
