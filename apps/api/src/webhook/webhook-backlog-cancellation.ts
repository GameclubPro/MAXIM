import type { MaxUpdate } from '@maxim/contracts';
import { Prisma } from '../prisma/prisma-client';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import type { LegacyReceiptDispositionResult } from './webhook-legacy-receipt-disposition';

export function backlogSource(value: unknown) {
  const update = (
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  ) as Partial<MaxUpdate>;
  // FLAG: Cancelling one callback must not disable future clicks on the same menu.
  const messageSource = !update.type || ['message_created', 'message_edited'].includes(update.type);
  const chatId = messageSource ? update.message?.chatId : null;
  const messageId = messageSource ? update.message?.messageId : null;
  return {
    semanticKey: buildWebhookSemanticEventKey(update),
    chatId:
      typeof chatId === 'string' && typeof messageId === 'string' && chatId && messageId
        ? chatId
        : null,
    messageId:
      typeof chatId === 'string' && typeof messageId === 'string' && chatId && messageId
        ? messageId
        : null,
  };
}

export function backlogUpdateHeldSql(update: Partial<MaxUpdate>): Prisma.Sql {
  const source = backlogSource(update);
  return Prisma.sql`(EXISTS (SELECT 1 FROM webhook_backlog_receipts
    WHERE semantic_key = ${source.semanticKey}) OR EXISTS (SELECT 1 FROM webhook_backlog_receipts
    WHERE chat_id = ${source.chatId} AND message_id = ${source.messageId}))`;
}

// FLAG: This projects cancellation only. It never clears, completes or reacquires an
// execution claim. Late mirrors inherit exact semantic/message tombstones, not user immunity.
export async function materializeBacklogCancellation(
  tx: Prisma.TransactionClient,
  receiptId: string,
): Promise<LegacyReceiptDispositionResult> {
  const [event] = await tx.$queryRaw<
    Array<{
      status: string;
      semanticKey: string | null;
      update: MaxUpdate;
      legacyId: string | null;
      sourceId: string | null;
    }>
  >(Prisma.sql`SELECT status, semantic_key AS "semanticKey", normalized_payload AS update,
    legacy_disposition_id AS "legacyId", source_disposition_id AS "sourceId"
    FROM webhook_events WHERE id = ${receiptId} FOR UPDATE`);
  if (!event) return 'NOT_HELD';
  if (event.status === 'CANCELLED') return 'ALREADY_APPLIED_SAME_PROOF';
  if (
    event.legacyId ||
    event.sourceId ||
    ['PROCESSED', 'DUPLICATE', 'NO_REPLAY_HELD'].includes(event.status)
  )
    return 'NOT_HELD';
  const source = backlogSource(event.update);
  const [proof] = await tx.$queryRaw<Array<{ cancellationId: string; sealed: boolean }>>(Prisma.sql`
    SELECT c.id AS "cancellationId", c.sealed_at IS NOT NULL AS sealed
    FROM (
      (SELECT cancellation_id FROM webhook_backlog_receipts WHERE receipt_id = ${receiptId} LIMIT 1)
      UNION ALL
      (SELECT cancellation_id FROM webhook_backlog_receipts WHERE semantic_key = ${event.semanticKey ?? source.semanticKey} LIMIT 1)
      UNION ALL
      (SELECT cancellation_id FROM webhook_backlog_receipts WHERE chat_id = ${source.chatId} AND message_id = ${source.messageId} LIMIT 1)
    ) matched JOIN webhook_backlog_cancellations c ON c.id = matched.cancellation_id LIMIT 1`);
  if (!proof) return 'NOT_HELD';
  if (!proof.sealed) return 'BLOCKED_UNKNOWN';
  await tx.$executeRaw(Prisma.sql`INSERT INTO webhook_backlog_receipts
    (receipt_id, cancellation_id, semantic_key, chat_id, message_id, original_snapshot)
    SELECT id, ${proof.cancellationId}, ${event.semanticKey ?? source.semanticKey}, ${source.chatId}, ${source.messageId}, to_jsonb(e)
    FROM webhook_events e WHERE id = ${receiptId} ON CONFLICT (receipt_id) DO NOTHING`);
  await tx.$executeRaw(
    Prisma.sql`UPDATE webhook_events SET status = 'CANCELLED' WHERE id = ${receiptId}`,
  );
  return 'APPLIED_WITH_PROOF';
}
