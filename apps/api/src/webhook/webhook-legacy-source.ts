import { createHash } from 'node:crypto';
import type { WebhookEvent } from '../prisma/prisma-client';
import { isManagedEntityHandshakeStartCommand } from '../common/managed-entity-handshake-command.util';
import {
  parseAdminForwardedModerationCommand,
  type AdminForwardedCommandSettings,
} from '../moderation/admin-forwarded-command.util';
import { parseWebhookEventTimestampMs } from './webhook-event-timestamp';
import {
  inspectLegacyForwardText,
  legacyParsedTextMatches,
  type LegacyForwardRefusal,
} from './webhook-legacy-forward-source';
export type LegacyRecoverySource = {
  chatId: string;
  messageId: string;
  userId: string;
  sourceAt: Date;
};
export type LegacyRecoverySourceRefusal =
  | LegacyForwardRefusal
  | 'source_objects_missing'
  | 'source_receiver_unproved'
  | 'source_event_kind'
  | 'source_membership_present'
  | 'source_ingress_clock'
  | 'source_chat_type'
  | 'source_human_unproved'
  | 'source_raw_keys'
  | 'source_message_keys'
  | 'source_sender_keys'
  | 'source_recipient_keys'
  | 'source_body_keys'
  | 'source_sender_metadata'
  | 'source_sequence'
  | 'source_update_identity'
  | 'source_attachments'
  | 'source_text_mismatch'
  | 'source_clock_type'
  | 'source_identity_mismatch'
  | 'source_clock_order'
  | 'source_normalized_clock'
  | 'source_command'
  | 'source_raw_mismatch'
  | 'source_command_parse_failed';
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

// FLAG: Positively known original MAX text shapes only. Never infer CHAT, non-command,
// author, original time or secondary targets from defaults/current settings/text heuristics.
export function inspectLegacyRecoverySource(
  owner: Pick<WebhookEvent, 'botId' | 'createdAt' | 'normalizedPayload' | 'rawPayload'>,
  onRefusal?: (reason: LegacyRecoverySourceRefusal) => void,
  settings?: AdminForwardedCommandSettings,
): LegacyRecoverySource | null {
  return inspectLegacyTextSource(owner, false, onRefusal, settings);
}

// FLAG: Only the already-held POST_SEAL receipt path may use edit/future-clock
// provenance. This grants no recovery/cutoff authority and retains the strict text/image shapes.
export function inspectLegacyPostSealTextSource(
  owner: Pick<WebhookEvent, 'botId' | 'createdAt' | 'normalizedPayload' | 'rawPayload'>,
  settings?: AdminForwardedCommandSettings,
): LegacyRecoverySource | null {
  return inspectLegacyTextSource(owner, true, undefined, settings);
}

function inspectLegacyTextSource(
  owner: Pick<WebhookEvent, 'botId' | 'createdAt' | 'normalizedPayload' | 'rawPayload'>,
  postSealForward: boolean,
  onRefusal?: (reason: LegacyRecoverySourceRefusal) => void,
  settings?: AdminForwardedCommandSettings,
): LegacyRecoverySource | null {
  // FLAG: Emit one fixed code from the deciding guard. Never expose raw keys,
  // source text, identities or exception details through refusal diagnostics.
  const refuse = (reason: LegacyRecoverySourceRefusal): null => {
    onRefusal?.(reason);
    return null;
  };
  const update = record(owner.normalizedPayload);
  const raw = record(update?.raw);
  const message = record(raw?.message);
  const sender = record(message?.sender);
  const recipient = record(message?.recipient);
  const body = record(message?.body);
  const normalized = record(update?.message);
  // FLAG: The immutable ingress receiver must agree in both receipt representations.
  // A routed execution owner changes independently and cannot supply missing provenance.
  if (!update || !raw || !message || !sender || !recipient || !body || !normalized)
    return refuse('source_objects_missing');
  if (typeof owner.botId !== 'string' || !identity(owner.botId) || update.botId !== owner.botId)
    return refuse('source_receiver_unproved');
  if (
    (update.type !== 'message_created' && !(postSealForward && update.type === 'message_edited')) ||
    raw.update_type !== update.type
  )
    return refuse('source_event_kind');
  if (update.membership) return refuse('source_membership_present');
  if (update.eventTimestampSource === 'ingress') return refuse('source_ingress_clock');
  if (normalized.entityType !== 'chat' || recipient.chat_type !== 'chat')
    return refuse('source_chat_type');
  if (sender.is_bot !== false) return refuse('source_human_unproved');
  if (!onlyKeys(raw, ['update_type', 'timestamp', 'message', 'update_id']))
    return refuse('source_raw_keys');
  if (!onlyKeys(message, ['sender', 'recipient', 'timestamp', 'body', 'link']))
    return refuse('source_message_keys');
  if (
    !onlyKeys(sender, [
      'user_id',
      'name',
      'first_name',
      'last_name',
      'username',
      'is_bot',
      'avatar_url',
      'last_activity_time',
    ])
  )
    return refuse('source_sender_keys');
  if (!onlyKeys(recipient, ['chat_id', 'chat_type'])) return refuse('source_recipient_keys');
  if (!onlyKeys(body, ['mid', 'seq', 'text', 'attachments'])) return refuse('source_body_keys');
  if (
    ['name', 'first_name', 'last_name', 'username', 'avatar_url'].some(
      (key) => sender[key] !== undefined && sender[key] !== null && typeof sender[key] !== 'string',
    ) ||
    (sender.last_activity_time !== undefined &&
      sender.last_activity_time !== null &&
      (typeof sender.last_activity_time !== 'number' ||
        !Number.isSafeInteger(sender.last_activity_time)))
  )
    return refuse('source_sender_metadata');
  if (body.seq !== undefined && (typeof body.seq !== 'number' || !Number.isSafeInteger(body.seq)))
    return refuse('source_sequence');
  if (raw.update_id !== undefined && identity(raw.update_id) === null)
    return refuse('source_update_identity');
  if (
    body.attachments !== undefined &&
    (!Array.isArray(body.attachments) || body.attachments.length !== 0)
  )
    return refuse('source_attachments');
  if (message.link !== undefined) {
    const forwardRefusal = inspectLegacyForwardText(update, settings);
    if (forwardRefusal) return refuse(forwardRefusal);
  } else if (typeof body.text !== 'string' || !legacyParsedTextMatches(update))
    return refuse('source_text_mismatch');
  if (typeof body.text !== 'string') return refuse('source_text_mismatch');
  if (typeof raw.timestamp !== 'number' || typeof message.timestamp !== 'number')
    return refuse('source_clock_type');
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
    normalized.senderId !== userId
  )
    return refuse('source_identity_mismatch');
  if (
    eventAt === null ||
    sourceAt === null ||
    sourceAt > eventAt ||
    (!postSealForward && eventAt > owner.createdAt.getTime())
  )
    return refuse('source_clock_order');
  if (typeof normalized.createdAt !== 'string' || Date.parse(normalized.createdAt) !== eventAt)
    return refuse('source_normalized_clock');
  if (isManagedEntityHandshakeStartCommand(update) || /^[/$]/u.test(body.text.trim()))
    return refuse('source_command');
  const storedRaw = record(owner.rawPayload);
  if (
    !storedRaw ||
    (Object.keys(storedRaw).length && legacySnapshotDigest(storedRaw) !== legacySnapshotDigest(raw))
  )
    return refuse('source_raw_mismatch');
  try {
    if (
      parseAdminForwardedModerationCommand(body.text) ||
      (settings && parseAdminForwardedModerationCommand(body.text, settings))
    )
      return refuse('source_command');
  } catch {
    return refuse('source_command_parse_failed');
  }
  return { chatId, messageId, userId, sourceAt: new Date(sourceAt) };
}
