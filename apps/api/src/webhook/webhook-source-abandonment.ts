import { randomUUID } from 'node:crypto';
import { Prisma, type WebhookEvent } from '../prisma/prisma-client';
import { buildGroupCommandKey } from '../common/group-command-key';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { readLegacyReceiptClaims } from './webhook-legacy-claims';
import {
  canonical,
  inspectSourceAbandonmentPostSealSource,
  inspectSourceAbandonmentSource,
  legacySnapshotDigest,
} from './webhook-legacy-source';
import type { LegacyReceiptDispositionResult } from './webhook-legacy-receipt-disposition';
import {
  SOURCE_ABANDONMENT_OPERATION,
  SOURCE_ABANDONMENT_VERSION,
  type SourceAbandonmentCandidate,
  type SourceAbandonmentDatabase,
  type SourceAbandonmentSelection,
} from './webhook-source-abandonment.contract';

const sha = /^[0-9a-f]{64}$/u;
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function finite(value: Date | null | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}
export function sourceAbandonmentOwnerSnapshot(event: WebhookEvent): Prisma.InputJsonValue {
  return canonical(
    Object.fromEntries(
      Object.entries(event).filter(
        ([key]) =>
          ![
            'rawPayload',
            'normalizedPayload',
            'sourceDispositionId',
            'sourceDispositionReceiptId',
          ].includes(key),
      ),
    ),
  ) as Prisma.InputJsonValue;
}

export function sourceAbandonmentReceiptSourceDigest(
  event: WebhookEvent,
  originalStatus = event.status,
): string {
  return legacySnapshotDigest({
    ...Object.fromEntries(
      Object.entries(event).filter(
        ([key]) => !['sourceDispositionId', 'sourceDispositionReceiptId'].includes(key),
      ),
    ),
    status: originalStatus,
  });
}

// FLAG: Modern started execution is never replayable. This inspector identifies
// an exact offline exclusion candidate; the separate bounded descendant inventory
// and stopped-generation certificate are still mandatory before installation.
export async function inspectSourceAbandonmentCandidate(
  db: SourceAbandonmentDatabase,
  ownerId: string,
  selection: SourceAbandonmentSelection,
  onRefusal?: (reason: string) => void,
): Promise<SourceAbandonmentCandidate | null> {
  const refuse = (reason: string): null => {
    onRefusal?.(reason);
    return null;
  };
  if (!finite(selection.abandonBefore) || !selection.majorBotIds.length)
    return refuse('source_selection_invalid');
  const sizes = await db.$queryRaw<Array<{ bytes: number; now: Date }>>(Prisma.sql`
    SELECT octet_length("raw_payload"::text) + octet_length("normalized_payload"::text) AS bytes,
      clock_timestamp() AT TIME ZONE 'UTC' AS now
    FROM "webhook_events" WHERE "id" = ${ownerId}`);
  if (
    sizes.length !== 1 ||
    !Number.isSafeInteger(sizes[0]?.bytes) ||
    sizes[0]!.bytes > 256 * 1024 ||
    !finite(sizes[0]!.now) ||
    selection.abandonBefore > sizes[0]!.now
  )
    return refuse('source_size_or_cutoff_invalid');
  const owner = await db.webhookEvent.findUnique({ where: { id: ownerId } });
  if (
    !owner ||
    owner.status !== 'FAILED' ||
    !owner.errorMessage ||
    owner.errorMessage.length > 8192 ||
    owner.errorMessage.includes('LEGACY_EXECUTION_UNVERIFIED') ||
    owner.processedAt ||
    owner.nextEnqueueAt ||
    owner.timeoutQuarantineExpiresAt ||
    owner.legacyDispositionId ||
    owner.legacyDispositionReceiptId ||
    owner.sourceDispositionId ||
    owner.sourceDispositionReceiptId ||
    !owner.botId ||
    !selection.majorBotIds.includes(owner.botId)
  )
    return refuse('source_owner_unproved');
  const source = inspectSourceAbandonmentSource(owner, onRefusal);
  if (!source) return refuse('source_content_unproved');
  const settings = await db.chatSettings.findUnique({ where: { chatId: source.chatId } });
  if (!inspectSourceAbandonmentSource(owner, onRefusal, settings ?? undefined))
    return refuse('source_configured_command');
  const semanticKey = buildWebhookSemanticEventKey(owner.normalizedPayload as never);
  if (!semanticKey || semanticKey !== owner.semanticKey) return refuse('source_semantic_unproved');
  const claims = await readLegacyReceiptClaims(
    db as Prisma.TransactionClient,
    owner.id,
    semanticKey,
    buildGroupCommandKey(source.chatId, source.messageId),
  );
  const claim = claims?.length === 1 ? claims[0] : null;
  if (
    !claim ||
    claim.kind !== 'EXECUTION' ||
    claim.webhookEventId !== owner.id ||
    claim.semanticKey !== semanticKey ||
    !claim.enforced ||
    claim.status !== 'READY' ||
    !finite(claim.preparedAt) ||
    !finite(claim.businessStartedAt) ||
    !claim.executionBotId ||
    !selection.majorBotIds.includes(claim.executionBotId) ||
    claim.completedAt ||
    claim.commandResult !== null ||
    claim.leaseToken ||
    claim.leaseExpiresAt
  )
    return refuse('source_started_claim_unproved');
  const migration = await db.$queryRaw<Array<{ at: Date }>>(Prisma.sql`
    SELECT "finished_at" AS at FROM "_prisma_migrations"
    WHERE "migration_name" = '20261005020000_add_multibot_order_fences'
      AND "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
    ORDER BY "finished_at" DESC LIMIT 1`);
  const after = migration[0]?.at;
  const clocks = [owner.createdAt, claim.createdAt, claim.preparedAt, claim.businessStartedAt];
  if (
    !finite(after) ||
    clocks.some((at) => !finite(at) || at <= after || at >= selection.abandonBefore) ||
    source.sourceAt <= after ||
    source.sourceAt >= selection.abandonBefore ||
    claim.preparedAt < claim.createdAt ||
    claim.businessStartedAt < claim.preparedAt
  )
    return refuse('source_modern_clock_unproved');
  return {
    owner,
    claim,
    source,
    rawPayloadDigest: legacySnapshotDigest(owner.rawPayload),
    normalizedPayloadDigest: legacySnapshotDigest(owner.normalizedPayload),
  };
}

type MaterializeOptions = { certificateId?: string; onRefusal?: (reason: string) => void };

// FLAG: Online preview and locked installation share one source/claim classifier.
// This performs reads only and never accepts a certificate or emits a disposition.
export async function inspectSourceAbandonmentReceiptCandidate(
  db: SourceAbandonmentDatabase,
  receiptId: string,
  candidate: SourceAbandonmentCandidate,
  onRefusal?: (reason: string) => void,
) {
  const refuse = (reason: string) => {
    onRefusal?.(reason);
    return null;
  };
  const sizes = await db.$queryRaw<Array<{ bytes: number }>>(Prisma.sql`
    SELECT octet_length("raw_payload"::text) + octet_length("normalized_payload"::text) AS bytes
    FROM "webhook_events" WHERE "id" = ${receiptId}`);
  if (sizes.length !== 1 || !Number.isSafeInteger(sizes[0]?.bytes) || sizes[0]!.bytes > 256 * 1024)
    return refuse('source_receipt_payload_unproved');
  const event = await db.webhookEvent.findUnique({ where: { id: receiptId } });
  if (
    !event ||
    event.legacyDispositionId ||
    event.legacyDispositionReceiptId ||
    event.sourceDispositionId ||
    event.sourceDispositionReceiptId ||
    event.processedAt ||
    !['RECEIVED', 'QUEUED', 'FAILED'].includes(event.status)
  )
    return refuse('source_receipt_state_unproved');
  const source = candidate.source;
  const settings = await db.chatSettings.findUnique({ where: { chatId: source.chatId } });
  const provenance = inspectSourceAbandonmentPostSealSource(event, settings ?? undefined);
  const semanticKey = buildWebhookSemanticEventKey(event.normalizedPayload as never);
  if (
    !provenance ||
    !semanticKey ||
    semanticKey !== event.semanticKey ||
    provenance.chatId !== source.chatId ||
    provenance.messageId !== source.messageId ||
    provenance.userId !== source.userId ||
    provenance.sourceAt.getTime() !== source.sourceAt.getTime()
  )
    return refuse('source_receipt_provenance_unproved');
  const claims = await readLegacyReceiptClaims(
    db as Prisma.TransactionClient,
    event.id,
    semanticKey,
    buildGroupCommandKey(source.chatId, source.messageId),
  );
  if (!claims) return refuse('source_receipt_claims_unproved');
  const exactClaim =
    claims.length === 1 &&
    claims[0]!.id === candidate.claim.id &&
    legacySnapshotDigest(claims[0]) === legacySnapshotDigest(candidate.claim);
  if (semanticKey === candidate.claim.semanticKey ? !exactClaim : claims.length !== 0)
    return refuse('source_receipt_independent_claim');
  return {
    event,
    claims,
    sourceDigest: sourceAbandonmentReceiptSourceDigest(event),
    scopeKind:
      event.id === candidate.owner.id ? ('EXACT_OWNER' as const) : ('EXACT_SOURCE' as const),
  };
}

// FLAG: A message match blocks effects before seal, but only this independent
// immutable positive receipt proof releases ordering. No claim or effect journal
// is updated here, and a fresh distinct message from the same user is out of scope.
export async function materializeSourceAbandonmentReceipt(
  tx: Prisma.TransactionClient,
  receiptId: string,
  options?: MaterializeOptions,
): Promise<LegacyReceiptDispositionResult> {
  const refuse = (reason: string): LegacyReceiptDispositionResult => {
    options?.onRefusal?.(reason);
    return 'BLOCKED_UNKNOWN';
  };
  const rows = await tx.$queryRaw<
    Array<{
      bytes: number;
      chatId: string | null;
      messageId: string | null;
      proofId: string | null;
    }>
  >(Prisma.sql`SELECT octet_length("raw_payload"::text) + octet_length("normalized_payload"::text) AS bytes,
    CASE WHEN jsonb_typeof("normalized_payload"->'message'->'chatId') = 'string'
      THEN left("normalized_payload"->'message'->>'chatId', 513) END AS "chatId",
    CASE WHEN jsonb_typeof("normalized_payload"->'message'->'messageId') = 'string'
      THEN left("normalized_payload"->'message'->>'messageId', 513) END AS "messageId",
    "source_disposition_id" AS "proofId"
    FROM "webhook_events" WHERE "id" = ${receiptId} FOR UPDATE`);
  const meta = rows[0];
  if (rows.length !== 1 || !meta) return refuse('source_receipt_missing');
  if (!meta.chatId || !meta.messageId)
    return meta.proofId ? refuse('source_scope_unproved') : 'NOT_HELD';
  const source = await tx.webhookSourceAbandonment.findUnique({
    where: { chatId_messageId: { chatId: meta.chatId, messageId: meta.messageId } },
    include: { certificate: true },
  });
  if (!source) return meta.proofId ? refuse('source_scope_unproved') : 'NOT_HELD';
  if (
    !Number.isSafeInteger(meta.bytes) ||
    meta.bytes > 256 * 1024 ||
    meta.chatId.length > 512 ||
    meta.messageId.length > 512 ||
    (options?.certificateId && source.certificateId !== options.certificateId)
  )
    return refuse('source_receipt_scope_unproved');
  const certificate = source.certificate;
  const attestation = object(certificate.attestation);
  if (
    source.operationVersion !== SOURCE_ABANDONMENT_VERSION ||
    certificate.operation !== SOURCE_ABANDONMENT_OPERATION ||
    certificate.operationVersion !== SOURCE_ABANDONMENT_VERSION ||
    !finite(certificate.sealedAt) ||
    !finite(certificate.abandonBefore) ||
    certificate.sealedAt < certificate.abandonBefore ||
    legacySnapshotDigest(certificate.attestation) !== certificate.attestationDigest ||
    ![
      certificate.attestationDigest,
      certificate.previewSha256,
      certificate.sourceClosureSha256,
      certificate.descendantsSha256,
    ].every((value) => sha.test(value)) ||
    attestation?.operation !== SOURCE_ABANDONMENT_OPERATION ||
    attestation?.sourceSha !== certificate.sourceSha ||
    attestation?.imageId !== certificate.imageId ||
    attestation?.abandonBefore !== certificate.abandonBefore.toISOString() ||
    attestation?.sourceClosureSha256 !== certificate.sourceClosureSha256 ||
    attestation?.descendantsSha256 !== certificate.descendantsSha256
  )
    return refuse('source_certificate_unproved');
  const event = await tx.webhookEvent.findUnique({ where: { id: receiptId } });
  if (!event || event.legacyDispositionId || event.legacyDispositionReceiptId)
    return refuse('source_receipt_pointer_conflict');
  if (event.sourceDispositionId) {
    if (event.sourceDispositionReceiptId !== event.id)
      return refuse('source_receipt_pointer_unproved');
    const proof = await tx.webhookSourceReceiptDisposition.findUnique({
      where: { id: event.sourceDispositionId },
    });
    return proof &&
      proof.receiptId === event.id &&
      proof.abandonmentId === source.id &&
      proof.sourceDigest === sourceAbandonmentReceiptSourceDigest(event, proof.originalStatus) &&
      (proof.scopeKind === 'EXACT_OWNER'
        ? event.id === source.ownerWebhookEventId &&
          event.status === 'FAILED' &&
          proof.originalStatus === 'FAILED'
        : proof.scopeKind === 'EXACT_SOURCE' &&
          event.id !== source.ownerWebhookEventId &&
          event.status === 'NO_REPLAY_HELD')
      ? 'ALREADY_APPLIED_SAME_PROOF'
      : refuse('source_receipt_proof_unproved');
  }
  if (
    event.sourceDispositionReceiptId ||
    !['RECEIVED', 'QUEUED', 'FAILED'].includes(event.status) ||
    event.processedAt
  )
    return refuse('source_receipt_state_unproved');
  const owner = await tx.webhookEvent.findUnique({ where: { id: source.ownerWebhookEventId } });
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "webhook_execution_claims" WHERE "id" = ${source.claimId} FOR UPDATE`,
  );
  const ownerClaim = await tx.webhookExecutionClaim.findUnique({ where: { id: source.claimId } });
  if (
    !owner ||
    !ownerClaim ||
    legacySnapshotDigest(sourceAbandonmentOwnerSnapshot(owner)) !==
      legacySnapshotDigest(source.ownerSnapshot) ||
    legacySnapshotDigest(owner.rawPayload) !== source.rawPayloadDigest ||
    legacySnapshotDigest(owner.normalizedPayload) !== source.normalizedPayloadDigest ||
    legacySnapshotDigest(ownerClaim) !== legacySnapshotDigest(source.claimSnapshot) ||
    owner.status !== 'FAILED' ||
    ownerClaim.webhookEventId !== owner.id ||
    ownerClaim.kind !== 'EXECUTION' ||
    ownerClaim.semanticKey !== source.semanticKey ||
    ownerClaim.status !== 'READY' ||
    !ownerClaim.enforced ||
    !ownerClaim.businessStartedAt ||
    ownerClaim.completedAt ||
    ownerClaim.commandResult !== null ||
    ownerClaim.leaseToken ||
    ownerClaim.leaseExpiresAt
  )
    return refuse('source_frozen_owner_unproved');
  const candidate: SourceAbandonmentCandidate = {
    owner,
    claim: ownerClaim,
    source: {
      chatId: source.chatId,
      messageId: source.messageId,
      userId: source.subjectUserId,
      sourceAt: source.sourceAt,
    },
    rawPayloadDigest: source.rawPayloadDigest,
    normalizedPayloadDigest: source.normalizedPayloadDigest,
  };
  const inspected = await inspectSourceAbandonmentReceiptCandidate(
    tx,
    event.id,
    candidate,
    options?.onRefusal,
  );
  if (!inspected) return 'BLOCKED_UNKNOWN';
  for (const claim of inspected.claims)
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "webhook_execution_claims" WHERE "id" = ${claim.id} FOR UPDATE`,
    );
  const rechecked = await inspectSourceAbandonmentReceiptCandidate(
    tx,
    event.id,
    candidate,
    options?.onRefusal,
  );
  if (!rechecked || legacySnapshotDigest(rechecked) !== legacySnapshotDigest(inspected))
    return refuse('source_receipt_claims_changed');
  const { claims, scopeKind } = rechecked;
  const proof = await tx.webhookSourceReceiptDisposition.create({
    data: {
      id: randomUUID(),
      receiptId: event.id,
      abandonmentId: source.id,
      sourceDigest: sourceAbandonmentReceiptSourceDigest(event),
      originalStatus: event.status,
      originalSnapshot: canonical({
        version: 1,
        receipt: sourceAbandonmentOwnerSnapshot(event),
        rawPayloadDigest: legacySnapshotDigest(event.rawPayload),
        normalizedPayloadDigest: legacySnapshotDigest(event.normalizedPayload),
        claims,
      }) as Prisma.InputJsonValue,
      scopeKind,
    },
  });
  const updated = await tx.webhookEvent.updateMany({
    where: {
      id: event.id,
      sourceDispositionId: null,
      legacyDispositionId: null,
      status: event.status,
    },
    data: {
      sourceDispositionId: proof.id,
      sourceDispositionReceiptId: event.id,
      ...(scopeKind === 'EXACT_OWNER' ? {} : { status: 'NO_REPLAY_HELD' as const }),
    },
  });
  if (updated.count !== 1) throw new Error('Source receipt proof CAS mismatch');
  return 'APPLIED_WITH_PROOF';
}
