export const LAST_CHAT_ID_KEY = 'maxim:last-chat-id';

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
