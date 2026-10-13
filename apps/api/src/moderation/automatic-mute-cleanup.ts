import { Prisma, type ModerationEvent } from '../prisma/prisma-client';

export const AUTOMATIC_MUTE_HISTORY_MS = 30 * 60_000;
export const AUTOMATIC_MUTE_CLEANUP_RULE = 'MUTE_ACTIVE_DELETE';

export function needsAutomaticMuteCleanup(
  data: Prisma.ModerationEventUncheckedCreateInput,
): boolean {
  const metadata = data.metadata as Record<string, unknown> | null;
  return (
    data.action === 'MUTE' &&
    (data.operator ?? 'BOT') === 'BOT' &&
    !data.ruleCode.startsWith('MANUAL_') &&
    !!data.messageId &&
    metadata?.sanctionApplied === true
  );
}

// FLAG: Called inside the transaction that creates the applied mute. No historical
// enrollment or detached enqueue is allowed; rollback removes both rows together.
export async function persistAutomaticMuteCleanup(
  tx: Prisma.TransactionClient,
  event: ModerationEvent,
): Promise<void> {
  if (!needsAutomaticMuteCleanup(event as Prisma.ModerationEventUncheckedCreateInput)) return;
  await tx.automaticMuteCleanup.create({
    data: {
      eventId: event.id,
      chatId: event.chatId,
      userId: event.userId,
      sourceMessageId: event.messageId!,
      originBotId: event.botId,
      windowStart: new Date(event.createdAt.getTime() - AUTOMATIC_MUTE_HISTORY_MS),
      windowEnd: event.createdAt,
      deadlineAt: new Date(event.createdAt.getTime() + AUTOMATIC_MUTE_HISTORY_MS),
    },
  });
}

// FLAG: This is a covered raw receipt page. The cursor advances only after all
// exact targets have durable intents; mirror receipts can safely be replayed.
export function automaticMuteHistoryPage(
  row: {
    chatId: string;
    userId: string;
    windowStart: Date;
    windowEnd: Date;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  },
  limit: number,
): Prisma.Sql {
  return Prisma.sql`
    SELECT id, created_at, normalized_payload->'message'->>'messageId' AS "messageId",
      normalized_payload->'message'->>'createdAt' AS "sourceAt"
    FROM webhook_events
    WHERE normalized_payload->>'type' = 'message_created'
      AND normalized_payload->'message'->>'chatId' = ${row.chatId}
      AND normalized_payload->'message'->>'senderId' = ${row.userId}
      AND created_at >= ${new Date(row.windowStart.getTime() - 1000)} AND created_at <= ${row.windowEnd}
      ${row.cursorCreatedAt && row.cursorId ? Prisma.sql`AND (created_at, id) > (${row.cursorCreatedAt}, ${row.cursorId})` : Prisma.empty}
    ORDER BY created_at, id LIMIT ${limit}
  `;
}
