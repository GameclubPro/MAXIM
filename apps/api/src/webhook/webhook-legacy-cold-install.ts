import type { MaxUpdate } from '@maxim/contracts';
import { createHash, randomUUID } from 'node:crypto';
import {
  Prisma,
  type PrismaClient,
  type WebhookEvent,
  type WebhookExecutionClaim,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';
import { buildGroupCommandKey } from '../common/group-command-authority.service';
import { isManagedEntityHandshakeStartCommand } from '../common/managed-entity-handshake-command.util';
import { parseAdminForwardedModerationCommand } from '../moderation/admin-forwarded-command.util';
import { parseWebhookEventTimestampMs } from './webhook-event-timestamp';
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
export type LegacyRecoverySource = {
  chatId: string;
  messageId: string;
  userId: string;
  sourceAt: Date;
};
export type LegacyRecoveryCandidate = {
  owner: WebhookEvent;
  claim: WebhookExecutionClaim;
  source: LegacyRecoverySource;
  rawPayloadDigest: string;
  normalizedPayloadDigest: string;
};

const SHA = /^[0-9a-f]{64}$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const IMAGE = /^sha256:[0-9a-f]{64}$/u;
const LEGACY_ERROR =
  'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required';
const ALL_API_ROLES = RUNTIME_SERVICE_NAMES.filter((name) => name !== 'api-all');
const MAX_TARGETS = 200;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function identity(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null;
  return typeof value === 'string' && value.trim() && value === value.trim() ? value : null;
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  const row = record(value);
  return row
    ? Object.fromEntries(
        Object.keys(row)
          .sort()
          .map((key) => [key, canonical(row[key])]),
      )
    : value;
}
export function legacySnapshotDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

// FLAG: One positively known original MAX shape only. Never infer CHAT, non-command,
// author, original time or secondary targets from defaults/current settings/text heuristics.
export function inspectLegacyRecoverySource(
  owner: Pick<WebhookEvent, 'botId' | 'createdAt' | 'normalizedPayload' | 'rawPayload'>,
): LegacyRecoverySource | null {
  const update = record(owner.normalizedPayload);
  const raw = record(update?.raw);
  const message = record(raw?.message);
  const sender = record(message?.sender);
  const recipient = record(message?.recipient);
  const body = record(message?.body);
  const normalized = record(update?.message);
  // FLAG: The immutable ingress receiver must agree in both receipt representations.
  // A routed execution owner changes independently and cannot supply missing provenance.
  if (
    !update ||
    typeof owner.botId !== 'string' ||
    !identity(owner.botId) ||
    update.botId !== owner.botId ||
    !raw ||
    !message ||
    !sender ||
    !recipient ||
    !body ||
    !normalized ||
    update.type !== 'message_created' ||
    raw.update_type !== 'message_created' ||
    update.membership ||
    update.eventTimestampSource === 'ingress' ||
    normalized.entityType !== 'chat' ||
    recipient.chat_type !== 'chat' ||
    sender.is_bot !== false ||
    !onlyKeys(raw, ['update_type', 'timestamp', 'message', 'update_id']) ||
    !onlyKeys(message, ['sender', 'recipient', 'timestamp', 'body']) ||
    !onlyKeys(sender, [
      'user_id',
      'name',
      'first_name',
      'last_name',
      'username',
      'is_bot',
      'avatar_url',
      'last_activity_time',
    ]) ||
    !onlyKeys(recipient, ['chat_id', 'chat_type']) ||
    !onlyKeys(body, ['mid', 'seq', 'text', 'attachments']) ||
    ['name', 'first_name', 'last_name', 'username', 'avatar_url'].some(
      (key) => sender[key] !== undefined && sender[key] !== null && typeof sender[key] !== 'string',
    ) ||
    (sender.last_activity_time !== undefined &&
      sender.last_activity_time !== null &&
      (typeof sender.last_activity_time !== 'number' ||
        !Number.isSafeInteger(sender.last_activity_time))) ||
    (body.seq !== undefined && (typeof body.seq !== 'number' || !Number.isSafeInteger(body.seq))) ||
    (raw.update_id !== undefined && identity(raw.update_id) === null) ||
    (body.attachments !== undefined &&
      (!Array.isArray(body.attachments) || body.attachments.length !== 0)) ||
    typeof body.text !== 'string' ||
    body.text !== normalized.text ||
    typeof raw.timestamp !== 'number' ||
    typeof message.timestamp !== 'number'
  )
    return null;
  const chatId = identity(recipient.chat_id);
  const messageId = identity(body.mid);
  const userId = identity(sender.user_id);
  const eventAt = parseWebhookEventTimestampMs(raw.timestamp);
  const sourceAt = parseWebhookEventTimestampMs(message.timestamp);
  if (
    !chatId ||
    !messageId ||
    !userId ||
    !chatId.startsWith('-') ||
    normalized.chatId !== chatId ||
    normalized.messageId !== messageId ||
    normalized.senderId !== userId ||
    eventAt === null ||
    sourceAt === null ||
    sourceAt > eventAt ||
    eventAt > owner.createdAt.getTime() ||
    typeof normalized.createdAt !== 'string' ||
    Date.parse(normalized.createdAt) !== eventAt ||
    isManagedEntityHandshakeStartCommand(update) ||
    /^[/$]/u.test(body.text.trim())
  )
    return null;
  const storedRaw = record(owner.rawPayload);
  if (
    !storedRaw ||
    (Object.keys(storedRaw).length && legacySnapshotDigest(storedRaw) !== legacySnapshotDigest(raw))
  )
    return null;
  try {
    if (parseAdminForwardedModerationCommand(body.text)) return null;
  } catch {
    return null;
  }
  return { chatId, messageId, userId, sourceAt: new Date(sourceAt) };
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
        ownerDigest: legacySnapshotDigest(candidate.owner),
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
): Promise<LegacyRecoveryCandidate | null> {
  const sizes = await prisma.$queryRaw<Array<{ payloadBytes: number }>>(Prisma.sql`
    SELECT octet_length("raw_payload"::text) + octet_length("normalized_payload"::text) AS "payloadBytes"
    FROM "webhook_events" WHERE "id" = ${ownerId}`);
  if (!Number.isSafeInteger(sizes[0]?.payloadBytes) || sizes[0]!.payloadBytes > 256 * 1024)
    return null;
  const owner = await prisma.webhookEvent.findUnique({ where: { id: ownerId } });
  if (
    !owner ||
    owner.status !== 'FAILED' ||
    owner.errorMessage !== LEGACY_ERROR ||
    owner.processedAt ||
    owner.nextEnqueueAt ||
    owner.timeoutQuarantineExpiresAt ||
    !owner.botId ||
    !majorBotIds.includes(owner.botId)
  )
    return null;
  const source = inspectLegacyRecoverySource(owner);
  if (!source) return null;
  const semanticKey = buildWebhookSemanticEventKey(owner.normalizedPayload);
  if (!semanticKey || semanticKey !== owner.semanticKey) return null;
  const claim = await prisma.webhookExecutionClaim.findUnique({
    where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey } },
  });
  if (
    !claim ||
    claim.webhookEventId !== owner.id ||
    claim.status === 'COMPLETED' ||
    claim.businessStartedAt ||
    claim.leaseToken ||
    claim.leaseExpiresAt ||
    claim.completedAt ||
    claim.commandResult !== null
  )
    return null;
  const command = await prisma.webhookExecutionClaim.findUnique({
    where: {
      kind_semanticKey: {
        kind: 'COMMAND',
        semanticKey: buildGroupCommandKey(source.chatId, source.messageId),
      },
    },
  });
  if (command) return null;
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
  if (deleteIntent || action) return null;
  const settings = await prisma.chatSettings.findUnique({ where: { chatId: source.chatId } });
  try {
    if (
      settings &&
      parseAdminForwardedModerationCommand(
        (owner.normalizedPayload as unknown as MaxUpdate).message!.text,
        settings,
      )
    )
      return null;
  } catch {
    return null;
  }
  const cutoff = await prisma.$queryRaw<Array<{ at: Date }>>(Prisma.sql`
    SELECT finished_at AS at FROM _prisma_migrations
    WHERE migration_name = '20261005020000_add_multibot_order_fences' AND finished_at IS NOT NULL AND rolled_back_at IS NULL
    ORDER BY finished_at DESC LIMIT 1`);
  if (
    !cutoff[0]?.at ||
    owner.createdAt > cutoff[0].at ||
    source.sourceAt > cutoff[0].at ||
    (claim.enforced && claim.createdAt > cutoff[0].at)
  )
    return null;
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
): Promise<{ id: string; quiescedAt: Date; attestationDigest: string }> {
  requireOffline();
  validateAttestation(attestation);
  const id = randomUUID();
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
          legacySnapshotDigest(owner) !== legacySnapshotDigest(candidate.owner) ||
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
            ([key]) => key !== 'rawPayload' && key !== 'normalizedPayload',
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
}
