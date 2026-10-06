import { createHash } from 'node:crypto';
import type { WebhookEvent } from '../prisma/prisma-client';
import { isManagedEntityHandshakeStartCommand } from '../common/managed-entity-handshake-command.util';
import { parseAdminForwardedModerationCommand } from '../moderation/admin-forwarded-command.util';
import { parseWebhookEventTimestampMs } from './webhook-event-timestamp';
export type LegacyRecoverySource = {
  chatId: string;
  messageId: string;
  userId: string;
  sourceAt: Date;
};
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
export function canonical(value: unknown): unknown {
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
