import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { buildWebhookReceiptSemanticKey } from './webhook-receipt-semantic-key';
import { parseWebhookEventTimestampMs } from './webhook-event-timestamp';
import { legacySnapshotDigest } from './webhook-legacy-source';
import { WebhookParser } from './webhook.parser';
import type { WebhookEvent } from '../prisma/prisma-client';

const HELD_RETRY = 'Webhook preparation deferred: Legacy scope installation is not sealed';
const RAW_KEYS = new Set([
  'update_type',
  'update_id',
  'timestamp',
  'chat_id',
  'is_channel',
  'user',
  'inviter_id',
]);
const USER_KEYS = new Set([
  'user_id',
  'is_bot',
  'first_name',
  'last_name',
  'name',
  'username',
  'last_activity_time',
  'description',
  'avatar_url',
  'full_avatar_url',
]);

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function identity(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null;
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value
    ? value
    : null;
}

// FLAG: This grants only the existing sealed global-member hold's receipt disposition.
// No membership update, welcome, sanction, claim completion or old-source recovery is allowed.
// The caller must have locked the receipt, verified its sealed authority and proved zero claims.
export function isPristinePostSealHeldJoin(
  event: WebhookEvent,
  sealedAt: Date,
  heldUserId: string,
): boolean {
  const update = object(event.normalizedPayload);
  const raw = object(update?.raw);
  const user = object(raw?.user);
  const message = object(update?.message);
  const sampledRaw = object(event.rawPayload);
  if (
    event.status !== 'RECEIVED' ||
    event.enqueueAttempts !== 0 ||
    event.queuedAt ||
    event.queueName ||
    event.processedAt ||
    event.timeoutQuarantineExpiresAt ||
    (event.errorMessage !== null && event.errorMessage !== HELD_RETRY) ||
    event.createdAt <= sealedAt ||
    !event.botId ||
    !update ||
    !raw ||
    !user ||
    !message ||
    !sampledRaw ||
    update.botId !== event.botId ||
    update.type !== 'user_added' ||
    raw.update_type !== 'user_added' ||
    (raw.is_channel !== undefined && typeof raw.is_channel !== 'boolean') ||
    typeof raw.timestamp !== 'number' ||
    (raw.update_id !== undefined && !identity(raw.update_id)) ||
    Object.keys(raw).some((key) => !RAW_KEYS.has(key)) ||
    Object.keys(user).some((key) => !USER_KEYS.has(key)) ||
    Object.entries(user).some(([key, value]) =>
      key === 'user_id' || key === 'is_bot'
        ? false
        : key === 'last_activity_time'
          ? typeof value !== 'number' || !Number.isFinite(value)
          : typeof value !== 'string',
    ) ||
    user.is_bot !== false ||
    identity(user.user_id) !== heldUserId ||
    message.senderId !== heldUserId ||
    !identity(raw.chat_id) ||
    identity(raw.chat_id) !== message.chatId ||
    (raw.inviter_id !== undefined && !identity(raw.inviter_id)) ||
    message.text !== '' ||
    message.messageId !== `user_added:${update.updateId}` ||
    update.eventTimestampSource !== 'payload'
  )
    return false;
  const timestamp = parseWebhookEventTimestampMs(raw.timestamp);
  if (
    timestamp === null ||
    timestamp < sealedAt.getTime() ||
    timestamp > event.createdAt.getTime() + 1_000
  )
    return false;
  try {
    // FLAG: Reparse only this size-bounded original source. Exact equality refuses rewritten
    // membership, hidden normalized fields, alternate targets and any prepared execution routing.
    const parsed = new WebhookParser().parse(raw, { botId: event.botId });
    const semanticKey = buildWebhookSemanticEventKey(parsed);
    // FLAG: Recognize only the exact source key or its same-bot Publisher namespace.
    // This projects an existing member hold; it grants no bot role or execution authority,
    // rewrites no semantic key and never settles an independent moderation claim.
    const observationKey = buildWebhookReceiptSemanticKey(parsed, event.botId);
    return (
      (Object.keys(sampledRaw).length === 0 ||
        legacySnapshotDigest(sampledRaw) === legacySnapshotDigest(raw)) &&
      semanticKey !== null &&
      (event.semanticKey === semanticKey || event.semanticKey === observationKey) &&
      legacySnapshotDigest(parsed) === legacySnapshotDigest(update)
    );
  } catch {
    return false;
  }
}
