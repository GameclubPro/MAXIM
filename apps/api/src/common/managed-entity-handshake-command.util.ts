import { isPrivateDirectChatId } from './chat-id.util';

export const MANAGED_ENTITY_HANDSHAKE_COMMAND = 'старт';

export function isManagedEntityHandshakeStartCommand(payload: unknown): boolean {
  const record = asRecord(payload);
  if (!record) {
    return false;
  }

  if (readLowerString(record.type ?? record.update_type) !== 'message_created') {
    return false;
  }

  const message = asRecord(record.message);
  const text = readString(message?.text ?? record.text);
  if (text?.toLowerCase() !== MANAGED_ENTITY_HANDSHAKE_COMMAND) {
    return false;
  }

  const chatId = readString(message?.chatId ?? message?.chat_id ?? record.chatId ?? record.chat_id);
  return Boolean(chatId && !isPrivateDirectChatId(chatId));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function readLowerString(value: unknown): string | null {
  return readString(value)?.toLowerCase() ?? null;
}
