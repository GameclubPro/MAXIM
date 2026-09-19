import type { ReportDetail } from '@maxim/contracts/settings';
import type { PreviewState } from './preview-transport-state';
import { buildPreviewProfileHandoffUrl, buildPreviewProfileUrl } from './preview-transport-shared';

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
        authorName: 'Александр Соколов',
        authorProfileUrl: buildPreviewProfileUrl('alexander-preview'),
        authorProfileHandoffUrl: buildPreviewProfileHandoffUrl('alexander-preview'),
        status: 'COLLECTING',
        votes: 1,
        threshold: 3,
        deleteMode: 'MESSAGE',
        muteHours: null,
        muteApplied: false,
        candidates: 0,
        deleted: 0,
        absent: 0,
        pending: 0,
        failed: 0,
        createdAt,
        expiresAt,
        lastError: null,
        reporters: [
          {
            userId: '100200301',
            displayName: 'Мария Волкова',
            profileUrl: buildPreviewProfileUrl('maria-preview'),
            profileHandoffUrl: buildPreviewProfileHandoffUrl('maria-preview'),
            createdAt,
          },
        ],
      },
      {
        id: 'preview-partial',
        messageId: 'preview-message-2',
        authorId: '100200305',
        authorName: 'Андрей Николаев',
        authorProfileUrl: buildPreviewProfileUrl('andrey-preview'),
        authorProfileHandoffUrl: buildPreviewProfileHandoffUrl('andrey-preview'),
        status: 'PARTIAL',
        votes: 3,
        threshold: 3,
        deleteMode: 'HISTORY_24H',
        muteHours: 1,
        muteApplied: true,
        candidates: 15,
        deleted: 10,
        absent: 2,
        pending: 0,
        failed: 3,
        createdAt,
        expiresAt,
        lastError: 'Не все сообщения удалось удалить.',
        reporters: ['Мария Волкова', 'Дмитрий Орлов', 'Елена Миронова'].map(
          (displayName, index) => ({
            userId: `100200${301 + index}`,
            displayName,
            profileUrl: buildPreviewProfileUrl(`reporter-${index}`),
            profileHandoffUrl: buildPreviewProfileHandoffUrl(`reporter-${index}`),
            createdAt,
          }),
        ),
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
