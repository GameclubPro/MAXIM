import { reportJournalFiltersSchema, type ReportDetail } from '@maxim/contracts/settings';
import type { PreviewState } from './preview-transport-state';
import { buildPreviewProfileHandoffUrl, buildPreviewProfileUrl } from './preview-transport-shared';

const reports = new WeakMap<PreviewState, Map<string, ReportDetail[]>>();

export function handlePreviewReports(
  state: PreviewState,
  chatId: string,
  tail: string[],
  method: string,
  url: URL,
) {
  if (tail[1] === 'availability' && method === 'GET')
    return { reportsAvailable: state.reportsAvailable, observedAt: new Date().toISOString() };
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
        updatedAt: createdAt,
        contentVersion: 1,
        snapshotVersion: 'initial',
        detailsArchived: false,
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
        updatedAt: createdAt,
        contentVersion: 1,
        snapshotVersion: 'initial',
        detailsArchived: false,
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
    if (state.reportsScenario === 'long') {
      const example = items[1]!;
      items.push(
        ...Array.from(
          { length: 63 },
          (_, index): ReportDetail => ({
            ...structuredClone(example),
            id: `preview-history-${index}`,
            messageId: `preview-message-${index + 3}`,
            status: index % 3 === 0 ? 'FAILED' : 'COMPLETED',
            createdAt: new Date(Date.now() - (index + 1) * 3_600_000).toISOString(),
            updatedAt: new Date(Date.now() - (index + 1) * 3_600_000).toISOString(),
            detailsArchived: index > 50,
            reporters: index > 50 ? [] : example.reporters,
          }),
        ),
      );
    }
    chats.set(chatId, items);
  }
  if (tail.length === 1 && method === 'GET') {
    const filters = reportJournalFiltersSchema.parse(
      Object.fromEntries([...url.searchParams].filter(([key]) => key !== 'cursor')),
    );
    const filtered = items.filter(
      (item) =>
        (filters.status === 'ALL' ||
          (filters.status === 'ACTIVE'
            ? ['COLLECTING', 'PENDING', 'RUNNING']
            : filters.status === 'FAILED'
              ? ['FAILED', 'PARTIAL']
              : ['COMPLETED', 'DISMISSED', 'EXPIRED', 'CANCELLED']
          ).includes(item.status)) &&
        (!filters.authorId || item.authorId === filters.authorId) &&
        (!filters.from || item.createdAt >= filters.from) &&
        (!filters.to || item.createdAt <= filters.to),
    );
    const cursor = url.searchParams.get('cursor');
    const start = cursor ? filtered.findIndex((item) => item.id === cursor) + 1 : 0;
    if (cursor && start === 0) throw new Error('Страница журнала устарела.');
    const page = filtered.slice(start, start + 20);
    return {
      items: structuredClone(page),
      nextCursor: filtered.length > start + 20 ? page.at(-1)!.id : null,
      observedAt: new Date().toISOString(),
    };
  }
  const item = items.find((row) => row.id === decodeURIComponent(tail[1] ?? ''));
  if (!item) throw new Error('Жалоба не найдена.');
  if (tail.length === 2 && method === 'GET')
    return { ...structuredClone(item), observedAt: new Date().toISOString() };
  if (tail[2] === 'dismiss' && method === 'POST') {
    if (!['COLLECTING', 'PENDING', 'DISMISSED'].includes(item.status))
      throw new Error('Сбор уже закрыт.');
    item.status = 'DISMISSED';
    item.updatedAt = new Date().toISOString();
    item.snapshotVersion = 'dismissed';
    return { ...structuredClone(item), observedAt: new Date().toISOString() };
  }
  throw new Error('Unsupported preview report request');
}
