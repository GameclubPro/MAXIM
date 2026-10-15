import type { ChatSummary } from '@maxim/contracts';
import { getInitData, readUserIdFromInitData } from './init-data';
import { readLocalMirrorItem, saveMirroredItem, removeLocalMirrorItem } from './native-storage';
import { getChatTitleScope } from './chat-title-scope';
export { setChatTitleScope } from './chat-title-scope';

const LEGACY_CHAT_TITLES_KEY = 'maxim:chat-titles';
let memo: { key: string; raw: string; titles: Record<string, string> } | null = null;

function chatTitlesKey(): string | null {
  const confirmedScope = getChatTitleScope();
  const initData = getInitData();
  const userId =
    readUserIdFromInitData(initData) ?? new URLSearchParams(initData).get('user_id')?.trim();
  if (!userId) return null;
  if (confirmedScope && confirmedScope.userId !== userId) return null;
  const profile =
    confirmedScope?.profile ??
    (typeof document === 'undefined'
      ? 'moderation'
      : (document.body?.dataset.miniappProfile ?? 'moderation'));
  return `maxim:chat-titles:v3:${encodeURIComponent(userId)}:${profile}`;
}

export function displayChatTitle(
  chatId: string,
  title: string,
  entityType: 'chat' | 'channel',
): string {
  const resolved = resolveChatTitle(chatId, title);
  return isUnusableChatTitle(chatId, resolved)
    ? entityType === 'channel'
      ? 'Канал'
      : 'Группа'
    : resolved;
}

export function isUnusableChatTitle(chatId: string, title: string): boolean {
  const normalizedId = chatId.trim();
  const normalizedTitle = title.trim();
  if (!normalizedId || !normalizedTitle) {
    return true;
  }

  return (
    normalizedTitle === normalizedId ||
    normalizedTitle === `Chat ${normalizedId}` ||
    normalizedTitle === `Channel ${normalizedId}`
  );
}

function readChatTitlesMap(): Readonly<Record<string, string>> {
  try {
    const key = chatTitlesKey();
    if (!key) return {};
    removeLocalMirrorItem(LEGACY_CHAT_TITLES_KEY);
    const raw = readLocalMirrorItem(key);
    if (!raw) return {};
    if (memo?.key === key && memo.raw === raw) return memo.titles;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const titles = Object.fromEntries(
      Object.entries(parsed)
        .slice(-2000)
        .filter(([id, title]) => id && typeof title === 'string' && title.trim()),
    ) as Record<string, string>;
    memo = { key, raw, titles };
    return titles;
  } catch {
    return {};
  }
}

function saveChatTitlesMap(value: Record<string, string>): void {
  const key = chatTitlesKey();
  if (!key) return;
  const raw = JSON.stringify(Object.fromEntries(Object.entries(value).slice(-2000)));
  if (readLocalMirrorItem(key) !== raw) saveMirroredItem(key, raw);
}

export function readChatTitle(chatId: string): string {
  return readChatTitlesMap()[chatId] ?? '';
}

export function resolveChatTitle(chatId: string, title: string): string {
  const normalizedTitle = title.trim();
  if (!isUnusableChatTitle(chatId, normalizedTitle)) {
    return normalizedTitle;
  }

  const storedTitle = readChatTitle(chatId).trim();
  return isUnusableChatTitle(chatId, storedTitle) ? normalizedTitle : storedTitle;
}

export function saveChatTitle(chatId: string, title: string): void {
  saveChatTitles([{ id: chatId, title }]);
}

export function saveChatTitles(chats: readonly Pick<ChatSummary, 'id' | 'title'>[]): void {
  if (chats.length === 0) return;
  const map = { ...readChatTitlesMap() };
  for (const chat of chats) {
    const id = chat.id.trim();
    if (!isUnusableChatTitle(id, chat.title)) map[id] = chat.title.trim();
  }
  saveChatTitlesMap(map);
}
