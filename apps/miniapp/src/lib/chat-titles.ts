import type { ChatSummary } from '@maxim/contracts';

const CHAT_TITLES_KEY = 'maxim:chat-titles';

function readChatTitlesMap(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(CHAT_TITLES_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    return Object.entries(parsed).reduce<Record<string, string>>((acc, [chatId, title]) => {
      if (typeof chatId === 'string' && typeof title === 'string' && chatId && title.trim()) {
        acc[chatId] = title;
      }
      return acc;
    }, {});
  } catch {
    return {};
  }
}

function saveChatTitlesMap(value: Record<string, string>): void {
  try {
    window.localStorage.setItem(CHAT_TITLES_KEY, JSON.stringify(value));
  } catch {
    // Ignore localStorage failures in restrictive WebView environments.
  }
}

export function readChatTitle(chatId: string): string {
  if (!chatId) {
    return '';
  }

  const map = readChatTitlesMap();
  return map[chatId] ?? '';
}

export function saveChatTitle(chatId: string, title: string): void {
  const normalizedId = chatId.trim();
  const normalizedTitle = title.trim();
  if (!normalizedId || !normalizedTitle) {
    return;
  }

  const map = readChatTitlesMap();
  map[normalizedId] = normalizedTitle;
  saveChatTitlesMap(map);
}

export function saveChatTitles(chats: ChatSummary[]): void {
  if (chats.length === 0) {
    return;
  }

  const map = readChatTitlesMap();
  for (const chat of chats) {
    if (!chat.id || !chat.title.trim()) {
      continue;
    }
    map[chat.id] = chat.title.trim();
  }

  saveChatTitlesMap(map);
}
