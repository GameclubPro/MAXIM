import { createHash } from 'node:crypto';
import { Prisma, WebhookStatus, type WebhookEvent } from '../prisma/prisma-client';
import { DORMANT_BOT_OBSERVATION_MARKER } from './webhook-dormant-observation';

// FLAG: Every claim creator must retain this protocol across both rollback paths.
// Existing proof formats alone do not prevent a stale writer after receipt closure.
export const WEBHOOK_SEMANTIC_CLAIM_FENCE_VERSION = 1;

type ClaimFenceDatabase = Pick<Prisma.TransactionClient, '$queryRaw'>;

function fenceKeys(semanticKeys: readonly (string | null)[]): Array<[number, number]> {
  return [...new Set(semanticKeys.filter((key): key is string => Boolean(key)))]
    .sort()
    .map((key): [number, number] => {
      const digest = createHash('sha256')
        .update(JSON.stringify(['webhook-semantic-claim-fence-v1', key]))
        .digest();
      return [digest.readInt32BE(0), digest.readInt32BE(4)];
    });
}

// FLAG: Absence needs the same transaction fence as every matching claim creator.
// This nonblocking form is safe after an existing receipt lock: contention preserves
// the held receipt instead of waiting in the reverse claim/receipt lock order.
export async function tryLockWebhookSemanticClaimFences(
  tx: ClaimFenceDatabase,
  semanticKeys: readonly (string | null)[],
): Promise<boolean> {
  for (const [first, second] of fenceKeys(semanticKeys)) {
    const rows = await tx.$queryRaw<Array<{ locked: boolean }>>(Prisma.sql`
      SELECT pg_try_advisory_xact_lock(${first}::integer, ${second}::integer) AS locked
    `);
    if (rows.length !== 1 || rows[0]?.locked !== true) return false;
  }
  return true;
}

// FLAG: A running command must await serialization, not silently lose its work on
// contention or throw a preparation retry after business start. Take this fence
// before its receipt lock; ordinary transaction timeouts retain their failure semantics.
export async function lockWebhookSemanticClaimFences(
  tx: ClaimFenceDatabase,
  semanticKeys: readonly (string | null)[],
): Promise<void> {
  for (const [first, second] of fenceKeys(semanticKeys))
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(${first}::integer, ${second}::integer)::text
    `);
}

// FLAG: The receipt may have closed since the caller's first snapshot. Holding its
// row through claim insertion prevents a stale caller from adding authority after
// a no-replay proof. Existing PROCESSED command/observation semantics stay unchanged.
export async function lockWebhookClaimReceiptAdmission(
  tx: ClaimFenceDatabase,
  receiptId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<
    Array<
      Pick<
        WebhookEvent,
        | 'status'
        | 'errorMessage'
        | 'legacyDispositionId'
        | 'legacyDispositionReceiptId'
        | 'sourceDispositionId'
        | 'sourceDispositionReceiptId'
      >
    >
  >(Prisma.sql`
    SELECT status, error_message AS "errorMessage",
      legacy_disposition_id AS "legacyDispositionId",
      legacy_disposition_receipt_id AS "legacyDispositionReceiptId",
      source_disposition_id AS "sourceDispositionId",
      source_disposition_receipt_id AS "sourceDispositionReceiptId"
    FROM webhook_events WHERE id = ${receiptId} FOR UPDATE
  `);
  const receipt = rows[0];
  return (
    rows.length === 1 &&
    receipt !== undefined &&
    receipt.status !== WebhookStatus.NO_REPLAY_HELD &&
    receipt.status !== WebhookStatus.QUARANTINED &&
    receipt.status !== WebhookStatus.CANCELLED &&
    receipt.errorMessage !== DORMANT_BOT_OBSERVATION_MARKER &&
    receipt.legacyDispositionId === null &&
    receipt.legacyDispositionReceiptId === null &&
    receipt.sourceDispositionId === null &&
    receipt.sourceDispositionReceiptId === null
  );
}
