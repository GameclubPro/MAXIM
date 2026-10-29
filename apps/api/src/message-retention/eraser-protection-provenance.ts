import { createHash } from 'node:crypto';
import { Prisma } from '../prisma/prisma-client';

const EMPTY_DIGEST = createHash('sha256').update('eraser-protection-catalog-v1').digest('hex');

type EvidenceRow = {
  revision: number;
  evidenceRevision: number;
  stage: number;
  cursor: string | null;
  digest: string | null;
  count: bigint;
};

export type ProtectionEvidence = {
  version: 1;
  source: 'ownership_capture_v1';
  chatId: string;
  sourceRevision: number;
  completeFrom: string;
  completeThrough: string;
  catalogDigest: string;
  referenceCount: number;
  checksum: string;
};

// FLAG: Hash one indexed catalogue page at a stable revision. Delivery flags are not evidence.
// A changed source restarts this bounded pass; partial hashes never widen historical authority.
export async function protectionEvidencePage(
  tx: Prisma.TransactionClient,
  chatId: string,
  token: string,
): Promise<{ revision: number; digest: string; count: number } | null> {
  const [state] = await tx.$queryRaw<EvidenceRow[]>`
    SELECT revision, evidence_revision AS "evidenceRevision", evidence_stage AS stage,
      evidence_cursor AS cursor, evidence_digest AS digest, evidence_count AS count
    FROM eraser_protection_outbox WHERE chat_id=${chatId} AND lease_token=${token} FOR UPDATE`;
  if (!state) return null;
  if (state.evidenceRevision !== state.revision) {
    state.stage = 0;
    state.cursor = null;
    state.digest = EMPTY_DIGEST;
    state.count = 0n;
  }
  if (state.stage < 2) {
    const rows =
      state.stage === 0
        ? await tx.$queryRaw<{ id: string; held: boolean }[]>`
          SELECT message_id AS id, held FROM eraser_protected_messages
          WHERE chat_id=${chatId} AND message_id > ${state.cursor ?? ''}
          ORDER BY message_id LIMIT 500`
        : await tx.$queryRaw<{ id: string; held: boolean }[]>`
          SELECT bot_id AS id, FALSE AS held FROM eraser_protected_bots
          WHERE chat_id=${chatId} AND bot_id > ${state.cursor ?? ''}
          ORDER BY bot_id LIMIT 500`;
    let digest = state.digest ?? EMPTY_DIGEST;
    for (const row of rows)
      digest = createHash('sha256')
        .update(JSON.stringify([digest, state.stage, row.id, row.held]))
        .digest('hex');
    state.digest = digest;
    state.count = BigInt(state.count) + BigInt(rows.length);
    state.cursor = rows.at(-1)?.id ?? state.cursor;
    if (rows.length < 500) {
      state.stage++;
      state.cursor = null;
    }
    await tx.$executeRaw`
      UPDATE eraser_protection_outbox SET evidence_revision=${state.revision},
        evidence_stage=${state.stage}, evidence_cursor=${state.cursor},
        evidence_digest=${state.digest}, evidence_count=${state.count}
      WHERE chat_id=${chatId} AND lease_token=${token}`;
  }
  return state.stage === 2 && state.digest && Number.isSafeInteger(Number(state.count))
    ? { revision: state.revision, digest: state.digest, count: Number(state.count) }
    : null;
}

export function protectionEvidence(
  chatId: string,
  revision: number,
  from: Date,
  through: Date,
  catalog: { digest: string; count: number },
): ProtectionEvidence | null {
  if (from > through) return null;
  const evidence = {
    version: 1 as const,
    source: 'ownership_capture_v1' as const,
    chatId,
    sourceRevision: revision,
    completeFrom: from.toISOString(),
    completeThrough: through.toISOString(),
    catalogDigest: catalog.digest,
    referenceCount: catalog.count,
  };
  return {
    ...evidence,
    checksum: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
  };
}
