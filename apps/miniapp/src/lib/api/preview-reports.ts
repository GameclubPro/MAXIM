import type { ReportDetail } from '@maxim/contracts/settings';
import type { PreviewState } from './preview-transport-state';

const reports = new WeakMap<PreviewState, Map<string, ReportDetail[]>>();

export function handlePreviewReports(
  state: PreviewState,
  chatId: string,
  tail: string[],
  method: string,
) {
  let chats = reports.get(state);
  if (!chats) {
    chats = new Map();
    reports.set(state, chats);
  }
  let items = chats.get(chatId);
  if (!items) {
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    items = [
      {
        id: 'preview-open',
        messageId: 'preview-message-1',
        authorId: '100200300',
        status: 'COLLECTING',
        votes: 1,
        threshold: 3,
        deleteMode: 'MESSAGE',
        muteHours: null,
        muteApplied: false,
        candidates: 0,
        deleted: 0,
        pending: 0,
        failed: 0,
        createdAt,
        expiresAt,
        lastError: null,
        reporters: [{ userId: '100200301', createdAt }],
      },
      {
        id: 'preview-partial',
        messageId: 'preview-message-2',
        authorId: '100200302',
        status: 'PARTIAL',
        votes: 3,
        threshold: 3,
        deleteMode: 'HISTORY_24H',
        muteHours: 1,
        muteApplied: true,
        candidates: 15,
        deleted: 12,
        pending: 0,
        failed: 3,
        createdAt,
        expiresAt,
        lastError: 'Не все сообщения удалось удалить.',
        reporters: [301, 302, 303].map((n) => ({ userId: `100200${n}`, createdAt })),
      },
    ];
    chats.set(chatId, items);
  }
  if (tail.length === 1 && method === 'GET')
    return { items: structuredClone(items), nextCursor: null };
  const item = items.find((row) => row.id === decodeURIComponent(tail[1] ?? ''));
  if (!item) throw new Error('Жалоба не найдена.');
  if (tail.length === 2 && method === 'GET') return structuredClone(item);
  if (tail[2] === 'dismiss' && method === 'POST') {
    if (!['COLLECTING', 'PENDING', 'DISMISSED'].includes(item.status))
      throw new Error('Сбор уже закрыт.');
    item.status = 'DISMISSED';
    return structuredClone(item);
  }
  throw new Error('Unsupported preview report request');
}
