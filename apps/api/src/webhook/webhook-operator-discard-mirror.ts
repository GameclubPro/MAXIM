import type { MaxUpdate } from '@maxim/contracts';
import { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { hasWebhookReplayFence } from './webhook-execution-deadline';

const OPERATOR_DISCARD_MARKER =
  '^WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINED:OPERATOR_DISCARDED:[A-Za-z0-9_-]{8,100}$';

// FLAG: Only the indexed first semantic receipt or the exact EXECUTION owner can
// propagate an operator abandonment. The scrubbed terminal envelope and stored key
// bind this to the same event; a generic failure is never abandonment authority.
export function operatorDiscardedMirrorSourceSql(semanticKey: string, webhookEventId: string) {
  return Prisma.sql`
    WITH authority_ids AS MATERIALIZED (
      SELECT anchor.id FROM (
        SELECT id FROM webhook_events WHERE semantic_key = ${semanticKey}
        ORDER BY created_at, id LIMIT 1
      ) anchor
      UNION
      SELECT webhook_event_id AS id FROM webhook_execution_claims
      WHERE kind = 'EXECUTION' AND semantic_key = ${semanticKey}
    )
    SELECT source.id, source.error_message AS "errorMessage"
    FROM authority_ids JOIN webhook_events source ON source.id = authority_ids.id
    JOIN webhook_events mirror ON mirror.id = ${webhookEventId}
    WHERE source.id <> mirror.id AND source.created_at < mirror.created_at
      AND source.semantic_key = ${semanticKey} AND source.status = 'FAILED'
      AND source.error_message ~ ${OPERATOR_DISCARD_MARKER}
      AND source.queue_name IS NULL AND source.queued_at IS NULL
      AND source.next_enqueue_at IS NULL AND source.timeout_quarantine_expires_at IS NULL
      AND source.legacy_disposition_id IS NULL AND source.legacy_disposition_receipt_id IS NULL
      AND source.raw_payload = '{}'::jsonb AND source.normalized_payload = '{}'::jsonb
    ORDER BY source.created_at, source.id LIMIT 1
  `;
}

type DiscardSource = { id: string; errorMessage: string };
type LockedMirror = {
  id: string;
  status: string;
  semanticKey: string | null;
  normalizedPayload: unknown;
  errorMessage: string | null;
  processedAt: Date | null;
  timeoutQuarantineExpiresAt: Date | null;
  legacyDispositionId: string | null;
  legacyDispositionReceiptId: string | null;
};

// FLAG: This records abandonment, never execution success or absence of old effects.
// Claims, leases, owners, payloads and action journals stay unchanged. Both runtime
// entry points call this before preparation/business effects; no MAX/Redis work belongs here.
export async function settleOperatorDiscardedMirror(
  prisma: PrismaService,
  input: { webhookEventId: string; update: MaxUpdate },
): Promise<boolean> {
  const type = input.update?.type?.trim().toLowerCase();
  if (type !== 'message_created' && type !== 'message_edited') return false;
  const semanticKey = buildWebhookSemanticEventKey(input.update);
  if (
    !semanticKey ||
    typeof prisma.$queryRaw !== 'function' ||
    typeof prisma.$transaction !== 'function'
  )
    return false;
  const query = operatorDiscardedMirrorSourceSql(semanticKey, input.webhookEventId);
  const source = (await prisma.$queryRaw<DiscardSource[]>(query))[0];
  if (!source) return false;

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '500ms'`);
      await tx.$executeRaw(Prisma.sql`SET LOCAL statement_timeout = '1000ms'`);
      // FLAG: Receipt locks also block new FK-linked direct claims. Use a stable
      // receipt order and lock existing claims before rechecking the selected authority.
      const receipts = await tx.$queryRaw<LockedMirror[]>(Prisma.sql`
        SELECT id, status::text AS status, semantic_key AS "semanticKey",
          normalized_payload AS "normalizedPayload", error_message AS "errorMessage",
          processed_at AS "processedAt", timeout_quarantine_expires_at AS "timeoutQuarantineExpiresAt",
          legacy_disposition_id AS "legacyDispositionId",
          legacy_disposition_receipt_id AS "legacyDispositionReceiptId"
        FROM webhook_events WHERE id IN (${source.id}, ${input.webhookEventId})
        ORDER BY id FOR UPDATE
      `);
      const mirror = receipts.find((receipt) => receipt.id === input.webhookEventId);
      if (
        receipts.length !== 2 ||
        !mirror ||
        !['RECEIVED', 'QUEUED', 'FAILED'].includes(mirror.status) ||
        mirror.processedAt !== null ||
        mirror.legacyDispositionId !== null ||
        mirror.legacyDispositionReceiptId !== null ||
        hasWebhookReplayFence(mirror) ||
        (mirror.semanticKey !== null && mirror.semanticKey !== semanticKey) ||
        buildWebhookSemanticEventKey(mirror.normalizedPayload) !== semanticKey
      )
        return false;
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM webhook_execution_claims
        WHERE kind = 'EXECUTION' AND semantic_key = ${semanticKey} FOR UPDATE
      `);
      const directClaims = await tx.$queryRaw<Array<{ harmless: boolean }>>(Prisma.sql`
        SELECT (kind = 'EXECUTION' AND semantic_key = ${semanticKey}
          AND status = 'PENDING' AND prepared_at IS NULL AND completed_at IS NULL
          AND business_started_at IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
          AND command_result IS NULL) AS harmless
        FROM webhook_execution_claims WHERE webhook_event_id = ${mirror.id}
        ORDER BY kind LIMIT 2 FOR UPDATE
      `);
      if (directClaims.length > 1 || directClaims.some((claim) => !claim.harmless)) return false;
      const rechecked = (await tx.$queryRaw<DiscardSource[]>(query))[0];
      if (rechecked?.id !== source.id || rechecked.errorMessage !== source.errorMessage)
        return false;

      // FLAG: Keep the same semantic/dedup keys and body. The terminal prefix releases
      // only this receipt's ordering slot while preserving its permanent replay fence.
      const changed = await tx.$executeRaw(Prisma.sql`
        UPDATE webhook_events SET status = 'FAILED', error_message = ${source.errorMessage},
          queue_name = NULL, queued_at = NULL, next_enqueue_at = NULL,
          timeout_quarantine_expires_at = NULL
        WHERE id = ${mirror.id} AND status::text = ${mirror.status}
          AND error_message IS NOT DISTINCT FROM ${mirror.errorMessage}
          AND processed_at IS NULL AND legacy_disposition_id IS NULL
          AND legacy_disposition_receipt_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM webhook_legacy_receipt_dispositions
            WHERE receipt_id = ${mirror.id} LIMIT 1 OFFSET 0)
      `);
      return changed === 1;
    },
    { maxWait: 1_000, timeout: 3_000 },
  );
}
