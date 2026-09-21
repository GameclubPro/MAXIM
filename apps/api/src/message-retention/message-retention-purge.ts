import { Prisma } from '../prisma/prisma-client';
import { MESSAGE_RETENTION_DAY_MS } from './message-retention.policy';

export type RetentionPurgeCursor = { completedAt: Date; chatId: string; messageId: string };
type PurgeRow = RetentionPurgeCursor & { intentId: string | null };

export async function purgeRetentionPage(
  tx: Prisma.TransactionClient,
  cursor: RetentionPurgeCursor | null,
): Promise<RetentionPurgeCursor | null> {
  const cutoff = new Date(Date.now() - 7 * MESSAGE_RETENTION_DAY_MS);
  const after = cursor
    ? Prisma.sql`AND ("completed_at", "chat_id", "message_id") >
    (${cursor.completedAt}, ${cursor.chatId}, ${cursor.messageId})`
    : Prisma.empty;
  const page = await tx.$queryRaw<PurgeRow[]>(Prisma.sql`
    SELECT "completed_at" AS "completedAt", "chat_id" AS "chatId",
      "message_id" AS "messageId", "intent_id" AS "intentId"
    FROM "message_retention_candidates" WHERE "completed_at" < ${cutoff} ${after}
    ORDER BY "completed_at", "chat_id", "message_id" LIMIT 500
  `);
  if (!page.length) return null;
  const ids = [...new Set(page.flatMap((row) => (row.intentId ? [row.intentId] : [])))];
  // FLAG: Match the intent producer's lock order, intent before candidate. Never
  // discard an ambiguous receipt's candidate, or let it block later cleanup pages.
  const locked = ids.length
    ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "moderation_delete_intents" WHERE "id" IN (${Prisma.join(ids)})
      AND "retention_owned" = TRUE
      AND ("status" <> 'IN_PROGRESS' OR "lease_expires_at" < CURRENT_TIMESTAMP)
    ORDER BY "id" FOR UPDATE SKIP LOCKED
  `)
    : [];
  const lockedPredicate = locked.length
    ? Prisma.sql`intent."id" IN (${Prisma.join(locked.map((row) => row.id))})`
    : Prisma.sql`FALSE`;
  await tx.$executeRaw(Prisma.sql`
    WITH page("chat_id", "message_id") AS (VALUES ${Prisma.join(page.map((row) => Prisma.sql`(${row.chatId}::text, ${row.messageId}::text)`))}),
    deleted_intents AS (
      DELETE FROM "moderation_delete_intents" intent
      USING "message_retention_candidates" candidate, page
      WHERE ${lockedPredicate} AND intent."retention_owned" = TRUE
        AND candidate."chat_id" = page."chat_id" AND candidate."message_id" = page."message_id"
        AND candidate."completed_at" < ${cutoff}
        AND candidate."intent_id" = intent."id"
        AND candidate."chat_id" = intent."chat_id" AND candidate."message_id" = intent."message_id"
        AND (
          intent."status" IN ('SUCCEEDED', 'ALREADY_ABSENT') OR (
            intent."delete_dispatch_started_at" IS NULL AND intent."delete_dispatch_started_bot_id" IS NULL
            AND intent."remote_delete_succeeded_at" IS NULL AND intent."remote_delete_succeeded_bot_id" IS NULL
            AND (intent."status" <> 'IN_PROGRESS' OR intent."lease_expires_at" < CURRENT_TIMESTAMP)
          )
        ) RETURNING intent."id"
    ) DELETE FROM "message_retention_candidates" candidate USING page
    WHERE candidate."chat_id" = page."chat_id" AND candidate."message_id" = page."message_id"
      AND candidate."completed_at" < ${cutoff}
      AND (
        candidate."intent_id" IS NULL
        OR EXISTS (SELECT 1 FROM deleted_intents d WHERE d."id" = candidate."intent_id")
        OR NOT EXISTS (SELECT 1 FROM "moderation_delete_intents" i WHERE i."id" = candidate."intent_id")
        OR EXISTS (SELECT 1 FROM "moderation_delete_intents" i WHERE i."id" = candidate."intent_id" AND i."retention_owned" = FALSE)
      )
  `);
  return page[page.length - 1]!;
}
