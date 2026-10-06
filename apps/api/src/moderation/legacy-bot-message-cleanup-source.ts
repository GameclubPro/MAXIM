import { parseWebhookEventTimestampMs } from '../webhook/webhook-event-timestamp';

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function identity(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return typeof value === 'string' && value.trim() && value === value.trim() ? value : null;
}

// FLAG: A late webhook/edit clock is not the original bot-message clock. Missing
// or inconsistent original MAX evidence must stay unknown for pre-seal cleanup holds.
export function legacyBotCleanupSourceAt(params: {
  raw?: unknown;
  chatId: string;
  messageId: string;
  userId: string;
}): Date | null {
  const raw = object(params.raw);
  const message = object(raw?.message);
  const sender = object(message?.sender);
  const recipient = object(message?.recipient);
  const body = object(message?.body);
  const at = parseWebhookEventTimestampMs(message?.timestamp);
  if (
    !raw ||
    raw.update_type !== 'message_created' ||
    !message ||
    !sender ||
    !recipient ||
    !body ||
    sender.is_bot !== true ||
    recipient.chat_type !== 'chat' ||
    identity(sender.user_id) !== params.userId ||
    identity(recipient.chat_id) !== params.chatId ||
    identity(body.mid) !== params.messageId ||
    typeof message.timestamp !== 'number' ||
    !Number.isSafeInteger(message.timestamp) ||
    at === null ||
    at <= 0 ||
    at > Date.now()
  )
    return null;
  return new Date(at);
}

export function readLegacyBotCleanupSourceAt(metadata: unknown): Date | null {
  const row = object(metadata);
  if (
    row?.botMessageOriginalCreatedAtSource !== 'max_message_timestamp_v1' ||
    typeof row.botMessageOriginalCreatedAt !== 'string'
  )
    return null;
  const at = Date.parse(row.botMessageOriginalCreatedAt);
  return Number.isSafeInteger(at) &&
    at > 0 &&
    at <= Date.now() &&
    new Date(at).toISOString() === row.botMessageOriginalCreatedAt
    ? new Date(at)
    : null;
}
