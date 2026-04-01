import type { ChatSummary } from '@maxim/contracts';

const CHAT_TITLES_KEY = 'maxim:chat-titles';

function normalizeChatTitleValue(value: string): string {
  return value.trim();
}

export function isUnusableChatTitle(chatId: string, title: string): boolean {
  const normalizedId = chatId.trim();
  const normalizedTitle = normalizeChatTitleValue(title);
  if (!normalizedId || !normalizedTitle) {
    return true;
  }

  return (
    normalizedTitle === normalizedId ||
    normalizedTitle === `Chat ${normalizedId}` ||
    normalizedTitle === `Channel ${normalizedId}`
  );
}

function readChatTitlesMap(): Record<string, string> {
  if (typeof window === 'undefined') {
    return {};
  }

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
  if (typeof window === 'undefined') {
    return;
  }

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

export function resolveChatTitle(chatId: string, title: string): string {
  const normalizedTitle = normalizeChatTitleValue(title);
  if (!isUnusableChatTitle(chatId, normalizedTitle)) {
    return normalizedTitle;
  }

  const storedTitle = normalizeChatTitleValue(readChatTitle(chatId));
  return isUnusableChatTitle(chatId, storedTitle) ? normalizedTitle : storedTitle;
}

export function saveChatTitle(chatId: string, title: string): void {
  const normalizedId = chatId.trim();
  const normalizedTitle = normalizeChatTitleValue(title);
  if (isUnusableChatTitle(normalizedId, normalizedTitle)) {
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
    if (isUnusableChatTitle(chat.id, chat.title)) {
      continue;
    }
    map[chat.id] = normalizeChatTitleValue(chat.title);
  }

  saveChatTitlesMap(map);
}
