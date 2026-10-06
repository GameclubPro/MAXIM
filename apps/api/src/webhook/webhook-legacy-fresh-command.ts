import type { MaxUpdate } from '@maxim/contracts';
import type { MaxClientService } from '../max/max-client.service';
import { Prisma } from '../prisma/prisma-client';
import { isManagedEntityHandshakeStartCommand } from '../common/managed-entity-handshake-command.util';
import { recognizesAdminForwardedModerationCommand } from '../moderation/admin-forwarded-command.util';
import { parseWebhookEventTimestampMs } from './webhook-event-timestamp';
import {
  buildWebhookExecutionDeadlineAt,
  hasWebhookReplayFence,
} from './webhook-execution-deadline';
import { legacySnapshotDigest } from './webhook-legacy-source';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { WebhookParser } from './webhook.parser';

export type FreshHeldCommandDatabase = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | 'webhookEvent' | 'chatSettings'
>;
export type FreshHeldCommandReceipt = {
  receiptId: string;
  kind: 'START' | 'ADMIN';
  chatId: string;
  messageId: string;
  userId: string;
  sourceAt: Date;
  deadlineAt: Date;
  receiptCreatedAt: Date;
  botId: string;
  semanticKey: string;
  normalizedPayload: Prisma.JsonValue;
  rawPayload: Prisma.JsonValue;
};
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function original(update: unknown) {
  const row = record(update);
  return row
    ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'executionOwnerBotId'))
    : null;
}
function identity(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null;
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value === value.trim()
    ? value
    : null;
}

// FLAG: This recognizes a new command intent, never an automatic-effect permit or
// an old receipt disposition. An expired intent may finish only through the existing
// exact no-effect execution journal; callers must check deadline before any command effect.
export async function readFreshHeldCommandReceipt(
  tx: FreshHeldCommandDatabase,
  receiptId: string,
  expectedUpdate?: MaxUpdate,
): Promise<FreshHeldCommandReceipt | null> {
  const bounded = await tx.$queryRaw<Array<{ bytes: number; now: Date }>>`
    SELECT (octet_length(normalized_payload::text) + octet_length(raw_payload::text)) AS bytes,
      clock_timestamp() AT TIME ZONE 'UTC' AS now FROM webhook_events WHERE id = ${receiptId}`;
  if (
    bounded.length !== 1 ||
    !Number.isSafeInteger(bounded[0]!.bytes) ||
    bounded[0]!.bytes > 256 * 1024
  )
    return null;
  const event = await tx.webhookEvent.findUnique({ where: { id: receiptId } });
  if (
    !event ||
    !event.botId ||
    event.legacyDispositionId ||
    event.processedAt ||
    !['RECEIVED', 'QUEUED', 'FAILED'].includes(event.status) ||
    hasWebhookReplayFence(event)
  )
    return null;
  const update = event.normalizedPayload as unknown as MaxUpdate;
  const raw = record(update.raw),
    message = record(raw?.message),
    link = record(message?.link),
    sender = record(message?.sender),
    recipient = record(message?.recipient),
    body = record(message?.body);
  if (
    !raw ||
    !message ||
    !sender ||
    !recipient ||
    !body ||
    update.type !== 'message_created' ||
    raw.update_type !== 'message_created' ||
    sender.is_bot !== false ||
    recipient.chat_type !== 'chat' ||
    update.botId !== event.botId ||
    typeof body.text !== 'string' ||
    // FLAG: Ingress collapses whitespace; the full parser-derived snapshot below remains mandatory.
    body.text.replace(/\s+/g, ' ').trim() !== update.message?.text ||
    (typeof link?.type === 'string' && link.type.trim().toLowerCase() === 'forward') ||
    update.membership ||
    update.eventTimestampSource !== 'payload'
  )
    return null;
  const chatId = identity(recipient.chat_id),
    messageId = identity(body.mid),
    userId = identity(sender.user_id);
  const sourceMs =
    typeof message.timestamp === 'number' ? parseWebhookEventTimestampMs(message.timestamp) : null;
  const eventMs =
    typeof raw.timestamp === 'number' ? parseWebhookEventTimestampMs(raw.timestamp) : null;
  if (
    !chatId?.startsWith('-') ||
    !messageId ||
    !userId ||
    sourceMs === null ||
    eventMs === null ||
    sourceMs > eventMs ||
    eventMs > event.createdAt.getTime() ||
    event.createdAt > bounded[0]!.now ||
    update.message?.chatId !== chatId ||
    update.message.messageId !== messageId ||
    update.message.senderId !== userId ||
    update.message.entityType !== 'chat' ||
    event.dedupKey !== `${event.botId}:${update.updateId}` ||
    buildWebhookSemanticEventKey(update) !== event.semanticKey
  )
    return null;
  let parsed: MaxUpdate;
  try {
    parsed = new WebhookParser().parse(raw, { botId: event.botId });
  } catch {
    return null;
  }
  if (
    legacySnapshotDigest(parsed) !== legacySnapshotDigest(original(update)) ||
    (expectedUpdate &&
      legacySnapshotDigest(original(expectedUpdate)) !== legacySnapshotDigest(parsed))
  )
    return null;
  const storedRaw = record(event.rawPayload);
  if (
    !storedRaw ||
    (Object.keys(storedRaw).length && legacySnapshotDigest(storedRaw) !== legacySnapshotDigest(raw))
  )
    return null;
  const deadline = buildWebhookExecutionDeadlineAt(parsed, event.createdAt);
  if (
    !deadline ||
    (event.executionDeadlineAt && event.executionDeadlineAt.getTime() > deadline.getTime())
  )
    return null;
  const proof: FreshHeldCommandReceipt = {
    receiptId,
    kind: 'START',
    chatId,
    messageId,
    userId,
    sourceAt: new Date(sourceMs),
    deadlineAt: event.executionDeadlineAt ?? deadline,
    receiptCreatedAt: event.createdAt,
    botId: event.botId,
    semanticKey: event.semanticKey!,
    normalizedPayload: event.normalizedPayload,
    rawPayload: event.rawPayload,
  };
  const scope = await tx.$queryRaw<Array<{ allowed: boolean }>>(Prisma.sql`SELECT (
    EXISTS (SELECT 1 FROM webhook_legacy_recoveries WHERE user_id = ${userId})
    AND ${freshCommandHoldScopeSql(proof)}
  ) AS allowed`);
  if (scope[0]?.allowed !== true) return null;
  if (isManagedEntityHandshakeStartCommand(parsed)) return proof;
  const settings = await tx.chatSettings.findUnique({ where: { chatId } });
  if (!settings || !recognizesAdminForwardedModerationCommand(parsed, settings)) return null;
  return { ...proof, kind: 'ADMIN' };
}

function freshCommandHoldScopeSql(proof: FreshHeldCommandReceipt): Prisma.Sql {
  // FLAG: Every matching global hold must have the same positive sealed authority
  // contract. A later or partial installation cannot be hidden by one older seal.
  return Prisma.sql`NOT EXISTS (
      SELECT 1 FROM webhook_legacy_recoveries WHERE chat_id = ${proof.chatId} AND message_id = ${proof.messageId}
    ) AND NOT EXISTS (
      SELECT 1 FROM webhook_legacy_recoveries recovery
      LEFT JOIN webhook_legacy_quiescence_certificates certificate ON certificate.id = recovery.certificate_id
      LEFT JOIN webhook_legacy_sealed_authorities authority ON authority.certificate_id = certificate.id
      WHERE recovery.user_id = ${proof.userId} AND (
        recovery.authority_version <> 1 OR recovery.disposition <> 'NO_REPLAY_ORDER_RELEASED'
        OR certificate.id IS NULL OR certificate.authority_version <> 1 OR certificate.sealed_at IS NULL
        OR authority.id IS NULL OR authority.authority_version <> 1
        OR authority.source_sha IS DISTINCT FROM certificate.source_sha
        OR authority.image_id IS DISTINCT FROM certificate.image_id
        OR authority.attestation_digest IS DISTINCT FROM certificate.attestation_digest
        OR authority.preview_sha256 IS DISTINCT FROM certificate.preview_sha256
        OR authority.sealed_at IS DISTINCT FROM certificate.sealed_at
        OR certificate.sealed_at >= ${proof.receiptCreatedAt} OR certificate.sealed_at >= ${proof.sourceAt}
      )
    )`;
}

// FLAG: Called only after source validation under the transition's existing row locks.
// Bind the exact stored snapshot again in the mutation and recheck all current holds.
export function freshHeldCommandTransitionSql(
  alias: string,
  proof: FreshHeldCommandReceipt | null,
): Prisma.Sql {
  if (!proof) return Prisma.sql`FALSE`;
  if (!/^[a-z_]+$/u.test(alias)) throw new Error('Invalid command receipt SQL alias');
  const event = Prisma.raw(alias);
  return Prisma.sql`(${event}.id = ${proof.receiptId}
    AND ${event}.created_at = ${proof.receiptCreatedAt} AND ${event}.bot_id = ${proof.botId}
    AND ${event}.semantic_key = ${proof.semanticKey}
    AND ${event}.normalized_payload = ${JSON.stringify(proof.normalizedPayload)}::jsonb
    AND ${event}.raw_payload = ${JSON.stringify(proof.rawPayload)}::jsonb
    AND ${freshCommandHoldScopeSql(proof)})`;
}

// FLAG: Live, exact bot and actor checks only. Cached admin IDs or a transport
// failure supply no permission. This runs outside SQL transactions/row locks.
export async function verifyFreshHeldCommandAccess(
  max: Pick<MaxClientService, 'getCurrentChatMemberAccess' | 'getChatMemberAccess'>,
  proof: FreshHeldCommandReceipt,
  botId: string,
): Promise<boolean> {
  if (!botId || proof.deadlineAt.getTime() <= Date.now()) return false;
  try {
    const options = {
      botId,
      bypassCache: true,
      trafficClass: 'interactive' as const,
      timeoutMs: Math.min(3000, proof.deadlineAt.getTime() - Date.now()),
    };
    const [bot, actor] = await Promise.all([
      max.getCurrentChatMemberAccess(proof.chatId, options),
      max.getChatMemberAccess(proof.chatId, proof.userId, options),
    ]);
    return (
      proof.deadlineAt.getTime() > Date.now() &&
      (bot.isAdmin === true || bot.isOwner === true) &&
      (actor?.isAdmin === true || actor?.isOwner === true)
    );
  } catch {
    return false;
  }
}
