import { parseAdminForwardedModerationCommand } from '../moderation/admin-forwarded-command.util';
import {
  canonical,
  inspectLegacyRecoverySource,
  legacySnapshotDigest,
  type LegacyRecoverySource,
  type LegacyRecoverySourceRefusal,
} from './webhook-legacy-source';
export { inspectLegacyRecoverySource, legacySnapshotDigest } from './webhook-legacy-source';
import {
  materializeLegacyReceiptDisposition,
  legacyReceiptSourceDigest,
  legacyReceiptScopeMetadataSql,
  isLegacyReceiptOutsideRecoveryScopes,
  type LegacyReceiptScopeMetadata,
} from './webhook-legacy-receipt-disposition';
import type { MaxUpdate } from '@maxim/contracts';
import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type PrismaClient,
  type WebhookEvent,
  type WebhookExecutionClaim,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';
import { buildGroupCommandKey } from '../common/group-command-authority.service';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';

type Database = PrismaService | PrismaClient;
type ReadDatabase = Database | Prisma.TransactionClient;
export type LegacyStopAttestation = {
  version: 1;
  sourceSha: string;
  imageId: string;
  transitionJournalSha256: string;
  previewSha256: string;
  queueFenceNonce: string;
  roleSnapshots: Array<{
    serviceName: string;
    containerId: string;
    imageId: string;
    sourceSha: string;
    stopped: true;
  }>;
};
export type LegacyChildHoldInput = {
  jobKey: string;
  queueName: string;
  jobPayloadDigest: string;
  chatId: string;
  messageId?: string;
  userId?: string;
};
export type LegacyRecoveryCandidate = {
  owner: WebhookEvent;
  claim: WebhookExecutionClaim;
  source: LegacyRecoverySource;
  rawPayloadDigest: string;
  normalizedPayloadDigest: string;
};
export type LegacyRecoveryCandidateRefusal =
  | LegacyRecoverySourceRefusal
  | 'candidate_payload_size'
  | 'candidate_owner_missing'
  | 'candidate_owner_status'
  | 'candidate_owner_error'
  | 'candidate_owner_processed'
  | 'candidate_owner_retry'
  | 'candidate_owner_quarantine'
  | 'candidate_owner_bot'
  | 'candidate_semantic_key'
  | 'candidate_claim_missing'
  | 'candidate_claim_owner'
  | 'candidate_claim_completed'
  | 'candidate_claim_started'
  | 'candidate_claim_lease'
  | 'candidate_claim_command_result'
  | 'candidate_command_claim'
  | 'candidate_delete_intent'
  | 'candidate_action'
  | 'candidate_configured_command'
  | 'candidate_command_parse_failed'
  | 'candidate_cutoff_missing'
  | 'candidate_owner_after_cutoff'
  | 'candidate_source_after_cutoff'
  | 'candidate_claim_after_cutoff';

const SHA = /^[0-9a-f]{64}$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const IMAGE = /^sha256:[0-9a-f]{64}$/u;
const LEGACY_ERROR =
  'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required';
const ALL_API_ROLES = RUNTIME_SERVICE_NAMES.filter((name) => name !== 'api-all');
const MAX_TARGETS = 200;

// FLAG: Nullable modern proof columns do not change previously frozen legacy
// source snapshots or preview hashes. Legacy eligibility remains separate.
function legacyOwnerDigest(owner: WebhookEvent): string {
  return legacySnapshotDigest(
    Object.fromEntries(
      Object.entries(owner).filter(
        ([key]) => !['sourceDispositionId', 'sourceDispositionReceiptId'].includes(key),
      ),
    ),
  );
}

function identity(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null;
  return typeof value === 'string' && value.trim() && value === value.trim() ? value : null;
}
function requireOffline(): void {
  if (process.env.MAXIM_LEGACY_RECOVERY_OFFLINE !== '1')
    throw new Error('Legacy installation requires the trusted stopped-role offline operation');
}
function validateAttestation(attestation: LegacyStopAttestation): void {
  if (
    attestation.version !== 1 ||
    !SOURCE_SHA.test(attestation.sourceSha) ||
    !IMAGE.test(attestation.imageId) ||
    !SHA.test(attestation.transitionJournalSha256) ||
    !SHA.test(attestation.previewSha256) ||
    !/^[a-zA-Z0-9_-]{16,200}$/u.test(attestation.queueFenceNonce) ||
    ALL_API_ROLES.length !== 14 ||
    attestation.roleSnapshots.length !== ALL_API_ROLES.length
  )
    throw new Error('Incomplete legacy stopped-role attestation');
  const names = new Set<string>();
  const containers = new Set<string>();
  for (const role of attestation.roleSnapshots) {
    if (
      !ALL_API_ROLES.some((name) => name === role.serviceName) ||
      names.has(role.serviceName) ||
      !SHA.test(role.containerId) ||
      containers.has(role.containerId) ||
      role.stopped !== true ||
      role.imageId !== attestation.imageId ||
      role.sourceSha !== attestation.sourceSha
    )
      throw new Error('Unverified legacy stopped role generation');
    names.add(role.serviceName);
    containers.add(role.containerId);
  }
}

export function buildLegacyRecoveryPreviewDigest(
  candidates: readonly LegacyRecoveryCandidate[],
  children: readonly LegacyChildHoldInput[],
): string {
  return legacySnapshotDigest({
    version: 1,
    candidates: [...candidates]
      .sort((a, b) => a.owner.id.localeCompare(b.owner.id))
      .map((candidate) => ({
        ownerDigest: legacyOwnerDigest(candidate.owner),
        claimDigest: legacySnapshotDigest(candidate.claim),
        source: candidate.source,
        rawPayloadDigest: candidate.rawPayloadDigest,
        normalizedPayloadDigest: candidate.normalizedPayloadDigest,
      })),
    children: [...children].sort((a, b) => a.jobKey.localeCompare(b.jobKey)),
  });
}

export async function inspectLegacyRecoveryCandidate(
  prisma: ReadDatabase,
  ownerId: string,
  majorBotIds: readonly string[],
  onRefusal?: (reason: LegacyRecoveryCandidateRefusal) => void,
): Promise<LegacyRecoveryCandidate | null> {
  const refuse = (reason: LegacyRecoveryCandidateRefusal): null => {
    onRefusal?.(reason);
    return null;
  };
  const sizes = await prisma.$queryRaw<Array<{ payloadBytes: number }>>(Prisma.sql`
    SELECT octet_length("raw_payload"::text) + octet_length("normalized_payload"::text) AS "payloadBytes"
    FROM "webhook_events" WHERE "id" = ${ownerId}`);
  if (!Number.isSafeInteger(sizes[0]?.payloadBytes) || sizes[0]!.payloadBytes > 256 * 1024)
    return refuse('candidate_payload_size');
  const owner = await prisma.webhookEvent.findUnique({ where: { id: ownerId } });
  if (!owner) return refuse('candidate_owner_missing');
  if (owner.status !== 'FAILED') return refuse('candidate_owner_status');
  if (owner.errorMessage !== LEGACY_ERROR) return refuse('candidate_owner_error');
  if (owner.processedAt) return refuse('candidate_owner_processed');
  if (owner.nextEnqueueAt) return refuse('candidate_owner_retry');
  if (owner.timeoutQuarantineExpiresAt) return refuse('candidate_owner_quarantine');
  if (!owner.botId || !majorBotIds.includes(owner.botId)) return refuse('candidate_owner_bot');
  const source = inspectLegacyRecoverySource(owner, onRefusal);
  if (!source) return null;
  const semanticKey = buildWebhookSemanticEventKey(owner.normalizedPayload);
  if (!semanticKey || semanticKey !== owner.semanticKey) return refuse('candidate_semantic_key');
  const claim = await prisma.webhookExecutionClaim.findUnique({
    where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey } },
  });
  if (!claim) return refuse('candidate_claim_missing');
  if (claim.webhookEventId !== owner.id) return refuse('candidate_claim_owner');
  if (claim.status === 'COMPLETED' || claim.completedAt) return refuse('candidate_claim_completed');
  if (claim.businessStartedAt) return refuse('candidate_claim_started');
  if (claim.leaseToken || claim.leaseExpiresAt) return refuse('candidate_claim_lease');
  if (claim.commandResult !== null) return refuse('candidate_claim_command_result');
  const command = await prisma.webhookExecutionClaim.findUnique({
    where: {
      kind_semanticKey: {
        kind: 'COMMAND',
        semanticKey: buildGroupCommandKey(source.chatId, source.messageId),
      },
    },
  });
  if (command) return refuse('candidate_command_claim');
  const [deleteIntent, action] = await Promise.all([
    prisma.moderationDeleteIntent.findFirst({
      where: { chatId: source.chatId, messageId: source.messageId },
      select: { id: true },
    }),
    prisma.maxActionLedgerEntry.findFirst({
      where: { chatId: source.chatId, messageId: source.messageId },
      select: { id: true },
    }),
  ]);
  if (deleteIntent) return refuse('candidate_delete_intent');
  if (action) return refuse('candidate_action');
  const settings = await prisma.chatSettings.findUnique({ where: { chatId: source.chatId } });
  try {
    if (
      settings &&
      (!inspectLegacyRecoverySource(owner, undefined, settings) ||
        parseAdminForwardedModerationCommand(
          (owner.normalizedPayload as unknown as MaxUpdate).message!.text,
          settings,
        ))
    )
      return refuse('candidate_configured_command');
  } catch {
    return refuse('candidate_command_parse_failed');
  }
  const cutoff = await prisma.$queryRaw<Array<{ at: Date }>>(Prisma.sql`
    SELECT finished_at AS at FROM _prisma_migrations
    WHERE migration_name = '20261005020000_add_multibot_order_fences' AND finished_at IS NOT NULL AND rolled_back_at IS NULL
    ORDER BY finished_at DESC LIMIT 1`);
  if (!cutoff[0]?.at) return refuse('candidate_cutoff_missing');
  if (owner.createdAt > cutoff[0].at) return refuse('candidate_owner_after_cutoff');
  if (source.sourceAt > cutoff[0].at) return refuse('candidate_source_after_cutoff');
  // FLAG: A fresh claim can point at an original pre-cutoff receipt. Runtime
  // holdUnverifiedLegacyExecution correctly retains its historical uncertainty.
  // Claim birth never renews the old source or prevents permanent abandonment;
  // the original owner/source cutoff, no-start/no-lease guards and cold seal remain mandatory.
  return {
    owner,
    claim,
    source,
    rawPayloadDigest: legacySnapshotDigest(owner.rawPayload),
    normalizedPayloadDigest: legacySnapshotDigest(owner.normalizedPayload),
  };
}

export async function createLegacyColdCertificate(
  prisma: Database,
  attestation: LegacyStopAttestation,
  id: string = randomUUID(),
): Promise<{ id: string; quiescedAt: Date; attestationDigest: string }> {
  requireOffline();
  validateAttestation(attestation);
  // FLAG: The host persists this identity before starting the writer. Never upsert
  // or silently replace it after a lost response; reconcile the exact primary key.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id))
    throw new Error('Legacy certificate identity must be a canonical UUID v4');
  const attestationDigest = legacySnapshotDigest(attestation);
  const rows = await prisma.$queryRaw<Array<{ quiescedAt: Date }>>(Prisma.sql`
    INSERT INTO "webhook_legacy_quiescence_certificates" ("id", "source_sha", "image_id", "attestation", "attestation_digest", "preview_sha256", "quiesced_at")
    VALUES (${id}, ${attestation.sourceSha}, ${attestation.imageId}, ${JSON.stringify(attestation)}::jsonb,
      ${attestationDigest}, ${attestation.previewSha256}, clock_timestamp() AT TIME ZONE 'UTC')
    RETURNING "quiesced_at" AS "quiescedAt"`);
  return { id, quiescedAt: rows[0]!.quiescedAt, attestationDigest };
}

export async function installLegacyRecoveryBatch(
  prisma: Database,
  certificateId: string,
  candidates: readonly LegacyRecoveryCandidate[],
  children: readonly LegacyChildHoldInput[],
): Promise<{ recoveries: number; children: number }> {
  return installLegacyBatch(prisma, certificateId, candidates, children, false);
}

// FLAG: Production installs and seals the complete finite scope in one transaction.
// A crash leaves either no holds or all sealed holds; an empty certificate is harmless.
export async function installAndSealLegacyRecoveryBatch(
  prisma: Database,
  certificateId: string,
  candidates: readonly LegacyRecoveryCandidate[],
  children: readonly LegacyChildHoldInput[],
): Promise<{ recoveries: number; children: number }> {
  return installLegacyBatch(prisma, certificateId, candidates, children, true);
}

async function installLegacyBatch(
  prisma: Database,
  certificateId: string,
  candidates: readonly LegacyRecoveryCandidate[],
  children: readonly LegacyChildHoldInput[],
  seal: boolean,
): Promise<{ recoveries: number; children: number }> {
  requireOffline();
  if (
    !candidates.length ||
    candidates.length > MAX_TARGETS ||
    new Set(candidates.map((candidate) => candidate.owner.id)).size !== candidates.length ||
    new Set(children.map((child) => child.jobKey)).size !== children.length ||
    children.length > 10_000
  )
    throw new Error('Legacy installation requires one bounded distinct reviewed batch');
  const previewSha256 = buildLegacyRecoveryPreviewDigest(candidates, children);
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
      const certificates = await tx.$queryRaw<
        Array<{
          attestation: LegacyStopAttestation;
          attestationDigest: string;
          previewSha256: string;
          quiescedAt: Date;
          sealedAt: Date | null;
          recoveryCount: number;
          childCount: number;
        }>
      >(Prisma.sql`
      SELECT "attestation", "attestation_digest" AS "attestationDigest", "preview_sha256" AS "previewSha256", "quiesced_at" AS "quiescedAt",
        "sealed_at" AS "sealedAt", "recovery_count" AS "recoveryCount", "child_count" AS "childCount"
      FROM "webhook_legacy_quiescence_certificates" WHERE "id" = ${certificateId} FOR UPDATE`);
      const certificate = certificates[0];
      if (
        !certificate ||
        certificate.sealedAt ||
        certificate.recoveryCount ||
        certificate.childCount ||
        certificate.previewSha256 !== previewSha256 ||
        legacySnapshotDigest(certificate.attestation) !== certificate.attestationDigest
      )
        throw new Error('Legacy certificate changed or does not bind this exact preview');
      validateAttestation(certificate.attestation);
      const chats = [...new Set(candidates.map((candidate) => candidate.source.chatId))].sort();
      for (const chatId of chats) {
        // FLAG: Original FAILED owners retain raw state and occupy the existing ordered
        // index. Bound the lifetime per-chat exception prefix, including prior certificates.
        const prefix = await tx.webhookLegacyRecovery.findMany({
          where: { chatId },
          select: { id: true },
          take: MAX_TARGETS + 1,
        });
        const incoming = candidates.filter(
          (candidate) => candidate.source.chatId === chatId,
        ).length;
        if (prefix.length + incoming > MAX_TARGETS)
          throw new Error('Legacy original owner prefix exceeds reviewed bound');
        const locked = await tx.$queryRaw<Array<{ entityType: string }>>(
          Prisma.sql`SELECT "entity_type"::text AS "entityType" FROM "chats" WHERE "id" = ${chatId} FOR UPDATE`,
        );
        if (locked[0]?.entityType !== 'CHAT')
          throw new Error('Legacy source chat ownership changed');
      }
      for (const candidate of [...candidates].sort((a, b) =>
        a.claim.id.localeCompare(b.claim.id),
      )) {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "webhook_execution_claims" WHERE "id" = ${candidate.claim.id} FOR UPDATE`,
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "webhook_events" WHERE "id" = ${candidate.owner.id} FOR UPDATE`,
        );
        const owner = await tx.webhookEvent.findUnique({ where: { id: candidate.owner.id } });
        const claim = await tx.webhookExecutionClaim.findUnique({
          where: { id: candidate.claim.id },
        });
        // FLAG: The preview is a comparison snapshot, never authority supplied by the caller.
        // Reparse the original source and every SQL eligibility fence while both rows are locked.
        const eligible = owner?.botId
          ? await inspectLegacyRecoveryCandidate(tx, owner.id, [owner.botId])
          : null;
        if (
          !owner ||
          !claim ||
          legacyOwnerDigest(owner) !== legacyOwnerDigest(candidate.owner) ||
          legacySnapshotDigest(claim) !== legacySnapshotDigest(candidate.claim) ||
          !eligible ||
          legacySnapshotDigest(eligible.source) !== legacySnapshotDigest(candidate.source) ||
          owner.errorMessage !== LEGACY_ERROR ||
          owner.status !== 'FAILED' ||
          owner.nextEnqueueAt ||
          owner.timeoutQuarantineExpiresAt ||
          claim.kind !== 'EXECUTION' ||
          claim.webhookEventId !== owner.id ||
          claim.semanticKey !== owner.semanticKey ||
          claim.status === 'COMPLETED' ||
          claim.leaseToken ||
          claim.leaseExpiresAt ||
          claim.businessStartedAt ||
          claim.completedAt ||
          claim.commandResult !== null ||
          candidate.rawPayloadDigest !== legacySnapshotDigest(owner.rawPayload) ||
          candidate.normalizedPayloadDigest !== legacySnapshotDigest(owner.normalizedPayload)
        )
          throw new Error('Legacy candidate snapshot changed before cold installation');
        const command = await tx.webhookExecutionClaim.findUnique({
          where: {
            kind_semanticKey: {
              kind: 'COMMAND',
              semanticKey: buildGroupCommandKey(
                candidate.source.chatId,
                candidate.source.messageId,
              ),
            },
          },
        });
        if (command) throw new Error('Legacy command authority appeared before installation');
        const settings = await tx.chatSettings.findUnique({
          where: { chatId: candidate.source.chatId },
        });
        const settingsSnapshot = {
          settings,
          rules: await tx.chatRules.findUnique({ where: { chatId: candidate.source.chatId } }),
        };
        const ownerSnapshot = Object.fromEntries(
          Object.entries(owner).filter(
            ([key]) =>
              ![
                'rawPayload',
                'normalizedPayload',
                'sourceDispositionId',
                'sourceDispositionReceiptId',
              ].includes(key),
          ),
        );
        await tx.$executeRaw(Prisma.sql`INSERT INTO "webhook_legacy_recoveries"
        ("id", "semantic_key", "owner_webhook_event_id", "claim_id", "chat_id", "message_id", "user_id", "source_at",
          "raw_payload_digest", "normalized_payload_digest", "owner_snapshot", "claim_snapshot", "settings_snapshot", "certificate_id")
        VALUES (${randomUUID()}, ${candidate.claim.semanticKey}, ${owner.id}, ${claim.id}, ${candidate.source.chatId}, ${candidate.source.messageId}, ${candidate.source.userId}, ${candidate.source.sourceAt},
          ${candidate.rawPayloadDigest}, ${candidate.normalizedPayloadDigest}, ${JSON.stringify(canonical(ownerSnapshot))}::jsonb,
          ${JSON.stringify(canonical(claim))}::jsonb, ${JSON.stringify(canonical(settingsSnapshot))}::jsonb, ${certificateId})`);
      }
      for (const child of children) {
        if (
          !identity(child.jobKey) ||
          child.jobKey.length > 512 ||
          !identity(child.queueName) ||
          !SHA.test(child.jobPayloadDigest) ||
          !chats.includes(child.chatId) ||
          (child.messageId !== undefined && !identity(child.messageId)) ||
          (child.userId !== undefined && !identity(child.userId))
        )
          throw new Error('Unattributed or malformed legacy child hold');
        await tx.$executeRaw(Prisma.sql`INSERT INTO "webhook_legacy_child_holds"
        ("job_key", "queue_name", "job_payload_digest", "chat_id", "message_id", "user_id", "certificate_id")
        VALUES (${child.jobKey}, ${child.queueName}, ${child.jobPayloadDigest}, ${child.chatId}, ${child.messageId ?? null}, ${child.userId ?? null}, ${certificateId})`);
      }
      // FLAG: Preserve current local effects. The certificate boundary prevents any old
      // target-free custom OPEN/SILENCE/RULES command from overwriting newer settings.
      for (const chatId of chats)
        await tx.$executeRaw(Prisma.sql`
      UPDATE "chats" SET
        "chat_control_order_at" = GREATEST(COALESCE("chat_control_order_at", ${certificate.quiescedAt}), ${certificate.quiescedAt}),
        "chat_control_order_key" = CASE WHEN "chat_control_order_at" IS NULL OR "chat_control_order_at" <= ${certificate.quiescedAt} THEN ${`legacy-certificate:${certificateId}`} ELSE "chat_control_order_key" END,
        "rules_order_at" = GREATEST(COALESCE("rules_order_at", ${certificate.quiescedAt}), ${certificate.quiescedAt}),
        "rules_order_key" = CASE WHEN "rules_order_at" IS NULL OR "rules_order_at" <= ${certificate.quiescedAt} THEN ${`legacy-certificate:${certificateId}`} ELSE "rules_order_key" END
      WHERE "id" = ${chatId}`);
      await tx.$executeRaw(
        Prisma.sql`UPDATE "webhook_legacy_quiescence_certificates" SET "recovery_count" = ${candidates.length}, "child_count" = ${children.length} WHERE "id" = ${certificateId} AND "sealed_at" IS NULL`,
      );
      const installed = { recoveries: candidates.length, children: children.length };
      if (seal)
        await sealLegacyCertificateWithClient(tx, certificateId, { ...installed, previewSha256 });
      return installed;
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
}

export async function sealLegacyColdCertificate(
  prisma: Database,
  certificateId: string,
  expected: { recoveries: number; children: number; previewSha256: string },
): Promise<void> {
  requireOffline();
  await prisma.$transaction((tx) => sealLegacyCertificateWithClient(tx, certificateId, expected));
}

async function sealLegacyCertificateWithClient(
  client: Prisma.TransactionClient,
  certificateId: string,
  expected: { recoveries: number; children: number; previewSha256: string },
): Promise<void> {
  if (
    !Number.isInteger(expected.recoveries) ||
    expected.recoveries < 1 ||
    expected.recoveries > MAX_TARGETS ||
    !Number.isInteger(expected.children) ||
    expected.children < 0 ||
    expected.children > 10_000 ||
    !SHA.test(expected.previewSha256)
  )
    throw new Error('Invalid legacy seal expectation');
  await client.$queryRaw(
    Prisma.sql`SELECT "id" FROM "webhook_legacy_quiescence_certificates" WHERE "id" = ${certificateId} FOR UPDATE`,
  );
  const certificate = await client.webhookLegacyQuiescenceCertificate.findUnique({
    where: { id: certificateId },
  });
  if (
    !certificate ||
    legacySnapshotDigest(certificate.attestation) !== certificate.attestationDigest
  )
    throw new Error('Legacy certificate attestation changed before seal');
  validateAttestation(certificate.attestation as unknown as LegacyStopAttestation);
  const changed =
    await client.$executeRaw(Prisma.sql`UPDATE "webhook_legacy_quiescence_certificates" certificate
    SET "sealed_at" = COALESCE(certificate."sealed_at", clock_timestamp() AT TIME ZONE 'UTC')
    WHERE certificate."id" = ${certificateId} AND certificate."authority_version" = 1
      AND certificate."preview_sha256" = ${expected.previewSha256}
      AND certificate."recovery_count" = ${expected.recoveries} AND certificate."child_count" = ${expected.children}
      AND (SELECT count(*) FROM "webhook_legacy_recoveries" WHERE "certificate_id" = certificate."id") = ${expected.recoveries}
      AND (SELECT count(*) FROM "webhook_legacy_child_holds" WHERE "certificate_id" = certificate."id") = ${expected.children}`);
  if (changed !== 1) throw new Error('Legacy certificate seal did not match installed finite work');
  await client.$executeRaw(Prisma.sql`INSERT INTO "webhook_legacy_sealed_authorities"
    ("id", "certificate_id", "authority_version", "source_sha", "image_id", "attestation_digest", "preview_sha256", "sealed_at")
    SELECT "id", "id", "authority_version", "source_sha", "image_id", "attestation_digest", "preview_sha256", "sealed_at"
    FROM "webhook_legacy_quiescence_certificates" WHERE "id" = ${certificateId}
    ON CONFLICT ("certificate_id") DO NOTHING`);
  const owners = await client.webhookLegacyRecovery.findMany({
    where: { certificateId },
    select: { ownerWebhookEventId: true },
  });
  for (const owner of owners) {
    const result = await materializeLegacyReceiptDisposition(client, owner.ownerWebhookEventId, {
      certificateId,
      preSeal: true,
    });
    if (result !== 'APPLIED_WITH_PROOF' && result !== 'ALREADY_APPLIED_SAME_PROOF')
      throw new Error('Original legacy receipt disposition is not proven');
  }
}

// FLAG: Bounded stopped-phase walk. The cursor only advances after exact receipt proof;
// unknown held sources remain visible and stop this scope. Neither scope seal nor cursor
// completion is an execution success. Each committed page can be safely retried.
export async function materializeLegacyHeldReceiptPage(
  prisma: Database,
  certificateId: string,
  chatId: string,
  pageSize = 100,
): Promise<{ complete: boolean; scanned: number; applied: number; blocked: boolean }> {
  requireOffline();
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200)
    throw new Error('Legacy materialization page must contain 1..200 receipts');
  return prisma.$transaction(
    async (tx) => {
      const authority = await tx.webhookLegacySealedAuthority.findUnique({
        where: { certificateId },
      });
      // FLAG: Global-user holds cross the selected chats. Load the complete bounded
      // sealed-certificate scope set, never only this chat, before proving NOT_HELD.
      const scopes = await tx.webhookLegacyRecovery.findMany({
        where: { certificateId },
        select: { chatId: true, messageId: true, userId: true },
        take: MAX_TARGETS + 1,
      });
      if (
        !authority ||
        scopes.length > MAX_TARGETS ||
        !scopes.some((scope) => scope.chatId === chatId)
      )
        throw new Error('Missing or incomplete sealed materialization scope');
      await tx.webhookLegacyMaterializationCursor.upsert({
        where: { certificateId_chatId: { certificateId, chatId } },
        create: { certificateId, chatId, horizon: authority.sealedAt },
        update: {},
      });
      await tx.$queryRaw(Prisma.sql`SELECT "certificate_id" FROM "webhook_legacy_materialization_cursors"
      WHERE "certificate_id" = ${certificateId} AND "chat_id" = ${chatId} FOR UPDATE`);
      const cursor = await tx.webhookLegacyMaterializationCursor.findUniqueOrThrow({
        where: { certificateId_chatId: { certificateId, chatId } },
      });
      if (cursor.horizon.getTime() !== authority.sealedAt.getTime())
        throw new Error('Legacy materialization horizon changed');
      if (cursor.complete) return { complete: true, scanned: 0, applied: 0, blocked: false };
      // FLAG: Lock the same bounded ordered page before classifying any receipt.
      // No SKIP LOCKED: a concurrent source change must wait or abort this page,
      // never let its cursor advance using stale non-membership evidence.
      const rows = await tx.$queryRaw<
        Array<LegacyReceiptScopeMetadata & { createdAt: Date }>
      >(Prisma.sql`
      SELECT ${legacyReceiptScopeMetadataSql}, "created_at" AS "createdAt" FROM "webhook_events"
      WHERE COALESCE(NULLIF(BTRIM("normalized_payload"->'message'->>'chatId'), ''),
          NULLIF(BTRIM("normalized_payload"->>'chatId'), '')) = ${chatId}
        AND ("status" = ANY(ARRAY['RECEIVED', 'QUEUED']::"WebhookStatus"[]) OR (
          "status" = 'FAILED'::"WebhookStatus" AND ("next_enqueue_at" IS NOT NULL
            OR LEFT(COALESCE("error_message", ''), 37) = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:')))
        AND LOWER(COALESCE(NULLIF(BTRIM("normalized_payload"->>'type'), ''),
          NULLIF(BTRIM("normalized_payload"->>'update_type'), ''))) = ANY(ARRAY['message_created','message_edited'])
        AND "created_at" <= ${cursor.horizon}
        ${cursor.afterId ? Prisma.sql`AND ("created_at", "id") > (${cursor.afterCreatedAt}, ${cursor.afterId})` : Prisma.empty}
      ORDER BY "created_at", "id" LIMIT ${pageSize + 1} FOR UPDATE`);
      let scanned = 0;
      let applied = 0;
      let lastScanned: (typeof rows)[number] | undefined;
      // FLAG: Every receipt proof and this cursor share one transaction. Persist the
      // proved prefix once per page, including before a blocked row; a rollback must
      // remove both dispositions and cursor progress. Never advance over unknown work.
      const advanceCursor = async (complete: boolean) => {
        if (!lastScanned && !complete) return;
        await tx.webhookLegacyMaterializationCursor.update({
          where: { certificateId_chatId: { certificateId, chatId } },
          data: {
            ...(lastScanned
              ? { afterCreatedAt: lastScanned.createdAt, afterId: lastScanned.id }
              : {}),
            scanned: { increment: scanned },
            ...(complete ? { complete: true } : {}),
          },
        });
      };
      for (const row of rows.slice(0, pageSize)) {
        const result = isLegacyReceiptOutsideRecoveryScopes(row, scopes)
          ? 'NOT_HELD'
          : await materializeLegacyReceiptDisposition(tx, row.id, {
              certificateId,
              preSeal: true,
            });
        if (result === 'BLOCKED_UNKNOWN') {
          await advanceCursor(false);
          return { complete: false, scanned, applied, blocked: true };
        }
        scanned++;
        lastScanned = row;
        if (result === 'APPLIED_WITH_PROOF') applied++;
      }
      const complete = rows.length <= pageSize;
      await advanceCursor(complete);
      return { complete, scanned, applied, blocked: false };
    },
    { maxWait: 1000, timeout: 15_000 },
  );
}

// FLAG: Read-only reconciliation after a lost commit response. Counts alone never
// authorize restart: reconstruct the exact approved preview and every owner proof.
export async function readLegacyRecoveryInstallation(
  prisma: Database,
  certificateId: string,
  expected: {
    sourceSha: string;
    imageId: string;
    previewSha256: string;
    recoveries: number;
    children: number;
  },
): Promise<{
  state: 'ABSENT' | 'UNSEALED' | 'INVALID' | 'SEALED' | 'MATERIALIZED';
  completeChats: number;
  requiredChats: number;
}> {
  const refused = (state: 'ABSENT' | 'UNSEALED' | 'INVALID') => ({
    state,
    completeChats: 0,
    requiredChats: 0,
  });
  if (
    !SOURCE_SHA.test(expected.sourceSha) ||
    !IMAGE.test(expected.imageId) ||
    !SHA.test(expected.previewSha256) ||
    !Number.isInteger(expected.recoveries) ||
    expected.recoveries < 1 ||
    expected.recoveries > MAX_TARGETS ||
    !Number.isInteger(expected.children) ||
    expected.children < 0 ||
    expected.children > 10_000
  )
    return refused('INVALID');
  return prisma.$transaction(
    async (tx) => {
      const certificate = await tx.webhookLegacyQuiescenceCertificate.findUnique({
        where: { id: certificateId },
      });
      if (!certificate) return refused('ABSENT');
      if (
        certificate.sourceSha !== expected.sourceSha ||
        certificate.imageId !== expected.imageId ||
        certificate.previewSha256 !== expected.previewSha256 ||
        legacySnapshotDigest(certificate.attestation) !== certificate.attestationDigest
      )
        return refused('INVALID');
      try {
        validateAttestation(certificate.attestation as unknown as LegacyStopAttestation);
      } catch {
        return refused('INVALID');
      }
      if (!certificate.sealedAt) return refused('UNSEALED');
      const authority = await tx.webhookLegacySealedAuthority.findUnique({
        where: { certificateId },
      });
      if (
        !authority ||
        authority.authorityVersion !== 1 ||
        authority.sourceSha !== expected.sourceSha ||
        authority.imageId !== expected.imageId ||
        authority.previewSha256 !== expected.previewSha256 ||
        authority.attestationDigest !== certificate.attestationDigest ||
        authority.sealedAt.getTime() !== certificate.sealedAt.getTime()
      )
        return refused('INVALID');
      const recoveries = await tx.webhookLegacyRecovery.findMany({
        where: { certificateId },
        take: MAX_TARGETS + 1,
      });
      const children = await tx.webhookLegacyChildHold.findMany({
        where: { certificateId },
        take: 10_001,
      });
      if (
        recoveries.length !== expected.recoveries ||
        children.length !== expected.children ||
        certificate.recoveryCount !== expected.recoveries ||
        certificate.childCount !== expected.children
      )
        return refused('INVALID');
      const candidates: LegacyRecoveryCandidate[] = [];
      for (const recovery of recoveries) {
        const owner = await tx.webhookEvent.findUnique({
          where: { id: recovery.ownerWebhookEventId },
        });
        const claim = await tx.webhookExecutionClaim.findUnique({
          where: { id: recovery.claimId },
        });
        const proof = await tx.webhookLegacyReceiptDisposition.findUnique({
          where: { receiptId: recovery.ownerWebhookEventId },
        });
        if (
          !owner ||
          !claim ||
          !proof ||
          owner.status !== 'FAILED' ||
          proof.scopeKind !== 'EXACT_OWNER' ||
          proof.originalStatus !== 'FAILED' ||
          proof.authorityId !== authority.id ||
          owner.legacyDispositionId !== proof.id ||
          owner.legacyDispositionReceiptId !== owner.id ||
          proof.sourceDigest !== legacyReceiptSourceDigest(owner) ||
          legacySnapshotDigest(claim) !== legacySnapshotDigest(recovery.claimSnapshot) ||
          legacySnapshotDigest(owner.rawPayload) !== recovery.rawPayloadDigest ||
          legacySnapshotDigest(owner.normalizedPayload) !== recovery.normalizedPayloadDigest
        )
          return refused('INVALID');
        candidates.push({
          owner: { ...owner, legacyDispositionId: null, legacyDispositionReceiptId: null },
          claim,
          source: {
            chatId: recovery.chatId,
            messageId: recovery.messageId,
            userId: recovery.userId,
            sourceAt: recovery.sourceAt,
          },
          rawPayloadDigest: recovery.rawPayloadDigest,
          normalizedPayloadDigest: recovery.normalizedPayloadDigest,
        });
      }
      const childInputs = children.map((child) => ({
        jobKey: child.jobKey,
        queueName: child.queueName,
        jobPayloadDigest: child.jobPayloadDigest,
        chatId: child.chatId,
        ...(child.messageId ? { messageId: child.messageId } : {}),
        ...(child.userId ? { userId: child.userId } : {}),
      }));
      if (buildLegacyRecoveryPreviewDigest(candidates, childInputs) !== expected.previewSha256)
        return refused('INVALID');
      const chats = [...new Set(recoveries.map((recovery) => recovery.chatId))];
      const cursors = await tx.webhookLegacyMaterializationCursor.findMany({
        where: { certificateId },
        take: MAX_TARGETS + 1,
      });
      const completeChats = chats.filter((chatId) =>
        cursors.some(
          (cursor) =>
            cursor.chatId === chatId &&
            cursor.complete &&
            cursor.horizon.getTime() === authority.sealedAt.getTime(),
        ),
      ).length;
      return {
        state: completeChats === chats.length ? 'MATERIALIZED' : 'SEALED',
        completeChats,
        requiredChats: chats.length,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 1000,
      timeout: 15_000,
    },
  );
}
