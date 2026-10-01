import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReportDetail } from '@maxim/contracts/settings';
import { ReportJournal } from '../../src/pages/settings/settings-reports-section';
import type { ApiTransport } from '../../src/lib/api/transport';
import '../../src/styles.css';

document.body.dataset.miniappProfile = 'moderation';

const createdAt = '2026-10-01T09:00:00.000Z';
const items: ReportDetail[] = Array.from({ length: 65 }, (_, index) => ({
  id: `case-${index}`,
  messageId: `message-${index}`,
  authorId: `author-${index % 2}`,
  authorName: 'Александр · очень длинное имя участника для проверки переноса',
  status: index === 0 ? 'COLLECTING' : 'COMPLETED',
  votes: 2,
  threshold: 3,
  deleteMode: 'MESSAGE',
  muteHours: null,
  muteApplied: false,
  candidates: 1,
  deleted: index === 0 ? 0 : 1,
  absent: 0,
  pending: 0,
  failed: 0,
  createdAt: new Date(Date.parse(createdAt) - index * 3_600_000).toISOString(),
  expiresAt: '2026-10-02T09:00:00.000Z',
  updatedAt: createdAt,
  contentVersion: 1,
  snapshotVersion: `v1-${index}`,
  detailsArchived: false,
  lastError: null,
  reporters: [{ userId: 'reporter', displayName: 'Мария Волкова', createdAt }],
}));
const requests: Array<{ path: string; kind: string }> = [];
let failure = false;
let holdNext = false;
let heldStatus: string | undefined;
let releaseDetail: (() => void) | undefined;
const api: ApiTransport = {
  request: async (path) => {
    const url = new URL(path, 'http://local');
    const id = url.pathname.split('/')[4];
    if (!id) {
      const cursor = url.searchParams.get('cursor');
      requests.push({ path, kind: cursor ? 'older' : 'head' });
      if (failure) throw new Error('Тестовый отказ');
      const status = url.searchParams.get('status') ?? 'ALL';
      const author = url.searchParams.get('authorId');
      const filtered = items.filter(
        (item) =>
          (status === 'ALL' ||
            (status === 'ACTIVE'
              ? item.status === 'COLLECTING'
              : status === 'FAILED'
                ? item.status === 'FAILED'
                : item.status === 'COMPLETED')) &&
          (!author || item.authorId === author),
      );
      const start = cursor ? filtered.findIndex((item) => item.id === cursor) + 1 : 0;
      const page = filtered.slice(start, start + 20);
      return {
        items: structuredClone(page),
        nextCursor: start + 20 < filtered.length ? page.at(-1)!.id : null,
        observedAt: new Date().toISOString(),
      };
    }
    const item = items.find((entry) => entry.id === id)!;
    requests.push({ path, kind: path.endsWith('/dismiss') ? 'dismiss' : 'detail' });
    if (path.endsWith('/dismiss')) {
      item.status = 'DISMISSED';
      item.snapshotVersion = 'dismissed';
      item.updatedAt = new Date().toISOString();
    }
    const snapshot = { ...structuredClone(item), observedAt: new Date().toISOString() };
    if (holdNext) {
      holdNext = false;
      heldStatus = snapshot.status;
      await new Promise<void>((resolve) => {
        releaseDetail = resolve;
      });
    }
    return snapshot;
  },
  requestKeepalive: () => {},
};
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
Object.assign(window, {
  reportJournalTest: {
    requests,
    holdNextDetail: () => {
      heldStatus = undefined;
      holdNext = true;
    },
    releaseDetail: () => releaseDetail?.(),
    heldStatus: () => heldStatus,
    addCollecting: () => {
      const now = new Date().toISOString();
      items.unshift({
        ...structuredClone(items[1]!),
        id: 'case-stale',
        messageId: 'message-stale',
        status: 'COLLECTING',
        deleted: 0,
        createdAt: now,
        updatedAt: now,
        contentVersion: 1,
        snapshotVersion: 'collecting-stale',
      });
    },
    complete: () => {
      items[0]!.contentVersion = (items[0]!.contentVersion ?? 0) + 1;
      items[0]!.status = 'COMPLETED';
      items[0]!.deleted = 1;
      items[0]!.snapshotVersion = 'completed';
      items[0]!.updatedAt = new Date().toISOString();
    },
    fail: (value: boolean) => {
      failure = value;
    },
    refreshHead: () => client.invalidateQueries({ queryKey: ['chat-reports', 'chat', 'head'] }),
  },
});
createRoot(document.getElementById('root')!).render(
  createElement(
    QueryClientProvider,
    { client },
    createElement(ReportJournal, { api, chatId: 'chat' }),
  ),
);
