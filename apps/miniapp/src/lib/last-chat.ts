export const LAST_CHAT_ID_KEY = 'maxim:last-chat-id';
export const LAST_ENTITY_TYPE_KEY = 'maxim:last-entity-type';

export type LastEntityType = 'chat' | 'channel';

export function readLastChatId(): string {
  try {
    return window.localStorage.getItem(LAST_CHAT_ID_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveLastChatId(chatId: string): void {
  if (!chatId) {
    return;
  }

  try {
    window.localStorage.setItem(LAST_CHAT_ID_KEY, chatId);
  } catch {
    // Ignore localStorage failures in restrictive WebView environments.
  }
}

export function readLastEntityType(): LastEntityType {
  try {
    const value = window.localStorage.getItem(LAST_ENTITY_TYPE_KEY);
    return value === 'channel' ? 'channel' : 'chat';
  } catch {
    return 'chat';
  }
}

export function saveLastEntityType(entityType: LastEntityType): void {
  try {
    window.localStorage.setItem(LAST_ENTITY_TYPE_KEY, entityType);
  } catch {
    // Ignore localStorage failures in restrictive WebView environments.
  }
}
