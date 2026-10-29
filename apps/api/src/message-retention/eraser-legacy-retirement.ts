import { Prisma } from '../prisma/prisma-client';

type CandidateRow = { messageId: string; intentId: string | null; activationId: string };
type IntentRow = {
  id: string;
  messageId: string;
  status: string;
  retentionOwned: boolean;
  leaseToken: string | null;
  dispatchedAt: Date | null;
  dispatchedBot: string | null;
  succeededAt: Date | null;
  succeededBot: string | null;
};

export function retirementCandidatePageQuery(chatId: string, after: string | null): Prisma.Sql {
  return Prisma.sql`
    SELECT message_id AS "messageId", intent_id AS "intentId", activation_id AS "activationId"
    FROM message_retention_candidates WHERE chat_id=${chatId} AND status IN ('pending','retry')
      AND message_id > ${after ?? ''} ORDER BY message_id LIMIT 100`;
}

// FLAG: This pass ends only never-issued authority. It never deletes journals, holds or MAX messages.
// Preserve intent -> quota -> policy -> candidate lock order used by the existing receipt executor.
export async function retireTransferredChat(
  tx: Prisma.TransactionClient,
  chatId: string,
): Promise<void> {
  await tx.$executeRaw`SET LOCAL lock_timeout = '300ms'`;
  await tx.$executeRaw`SET LOCAL statement_timeout = '1500ms'`;
  const [progress] = await tx.$queryRaw<{ cursor: string | null }[]>`
    SELECT cursor_message_id AS cursor FROM eraser_legacy_retirement
    WHERE chat_id=${chatId} AND completed_at IS NULL FOR UPDATE`;
  if (!progress) return;
  const page = await tx.$queryRaw<CandidateRow[]>(
    retirementCandidatePageQuery(chatId, progress.cursor),
  );
  const messageIds = page.map((row) => row.messageId);
  const intents = messageIds.length
    ? await tx.$queryRaw<IntentRow[]>(Prisma.sql`
    SELECT id, message_id AS "messageId", status, retention_owned AS "retentionOwned", lease_token AS "leaseToken",
      delete_dispatch_started_at AS "dispatchedAt", delete_dispatch_started_bot_id AS "dispatchedBot",
      remote_delete_succeeded_at AS "succeededAt", remote_delete_succeeded_bot_id AS "succeededBot"
    FROM moderation_delete_intents WHERE chat_id=${chatId} AND message_id IN (${Prisma.join(messageIds)})
    ORDER BY id FOR UPDATE`)
    : [];
  const [initial] = await tx.$queryRaw<{ shard: number }[]>`
    SELECT policy.quota_shard AS shard FROM message_retention_policies policy
    JOIN eraser_chat_bindings binding ON binding.chat_id=policy.chat_id WHERE policy.chat_id=${chatId}`;
  if (!initial) {
    await tx.$executeRaw`UPDATE eraser_legacy_retirement SET completed_at=CURRENT_TIMESTAMP WHERE chat_id=${chatId}`;
    return;
  }
  await tx.$queryRaw`SELECT shard FROM message_retention_quotas WHERE shard=${initial.shard} FOR UPDATE`;
  const [policy] = await tx.$queryRaw<{ enabled: boolean; activationId: string }[]>`
    SELECT enabled, activation_id AS "activationId" FROM message_retention_policies WHERE chat_id=${chatId} FOR UPDATE`;
  // FLAG: A drifted legacy policy is not authority to cancel a current activation.
  if (!policy || policy.enabled) throw new Error('Transferred retention policy is not disabled');
  const current = messageIds.length
    ? await tx.$queryRaw<CandidateRow[]>(Prisma.sql`
    SELECT message_id AS "messageId", intent_id AS "intentId", activation_id AS "activationId"
    FROM message_retention_candidates WHERE chat_id=${chatId} AND message_id IN (${Prisma.join(messageIds)})
      AND status IN ('pending','retry') ORDER BY message_id FOR UPDATE`)
    : [];
  const byMessage = new Map(intents.map((row) => [row.messageId, row]));
  const retire: string[] = [];
  const receipts: string[] = [];
  for (const row of current) {
    if (row.activationId === policy.activationId) continue;
    const intent = byMessage.get(row.messageId);
    if (!intent) {
      // FLAG: A missing linked journal is missing evidence, never proof that no DELETE occurred.
      if (row.intentId === null) retire.push(row.messageId);
      continue;
    }
    if (row.intentId !== intent.id || !intent.retentionOwned) continue;
    if (['SUCCEEDED', 'ALREADY_ABSENT'].includes(intent.status)) {
      receipts.push(row.messageId);
      continue;
    }
    const mutation =
      intent.dispatchedAt || intent.dispatchedBot || intent.succeededAt || intent.succeededBot;
    if (
      mutation ||
      intent.status === 'AMBIGUOUS' ||
      intent.status === 'IN_PROGRESS' ||
      intent.leaseToken
    )
      continue;
    if (
      [
        'PENDING',
        'RETRYABLE',
        'WAITING_CAPABILITY',
        'OBSERVED',
        'EXPIRED',
        'FAILED_TERMINAL',
      ].includes(intent.status)
    )
      retire.push(row.messageId);
  }
  const retired = retire.length
    ? await tx.$executeRaw(Prisma.sql`
    UPDATE message_retention_candidates SET status='cancelled', completed_at=CURRENT_TIMESTAMP,
      outcome_code='cancelled', reconcile_after=NULL
    WHERE chat_id=${chatId} AND message_id IN (${Prisma.join(retire)}) AND status IN ('pending','retry')`)
    : 0;
  if (retired) {
    await tx.$executeRaw`UPDATE message_retention_policies SET pending_count=pending_count-${retired},
      skipped_count=skipped_count+${retired} WHERE chat_id=${chatId}`;
    await tx.$executeRaw`UPDATE message_retention_quotas SET pending_count=pending_count-${retired} WHERE shard=${initial.shard}`;
  }
  const reconciled = receipts.length
    ? await tx.$executeRaw(Prisma.sql`
    UPDATE message_retention_candidates SET reconcile_after=COALESCE(reconcile_after,CURRENT_TIMESTAMP), outcome_code='reconciliation'
    WHERE chat_id=${chatId} AND message_id IN (${Prisma.join(receipts)}) AND reconcile_after IS NULL`)
    : 0;
  if (reconciled)
    await tx.$executeRaw`UPDATE message_retention_policies SET next_run_at=LEAST(COALESCE(next_run_at,CURRENT_TIMESTAMP),CURRENT_TIMESTAMP) WHERE chat_id=${chatId}`;
  await tx.$executeRaw`
    UPDATE eraser_legacy_retirement SET cursor_message_id=${page.at(-1)?.messageId ?? progress.cursor},
      completed_at=CASE WHEN ${page.length < 100} THEN CURRENT_TIMESTAMP ELSE NULL END,
      next_attempt_at=CURRENT_TIMESTAMP+INTERVAL '1 second', updated_at=CURRENT_TIMESTAMP,
      retired_count=retired_count+${retired}, reconciliation_count=reconciliation_count+${reconciled},
      retained_count=retained_count+${current.length - retired - receipts.length}
    WHERE chat_id=${chatId}`;
}
