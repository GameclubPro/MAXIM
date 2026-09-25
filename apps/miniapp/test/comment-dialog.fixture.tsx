import '../src/styles.css';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ToastProvider } from '../src/components/ui/toast';
import { ChannelDialogPage } from '../src/pages/channel-dialog-page';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import { syncMaxNativeEnvironment } from '../src/lib/max-bridge';
import type { ChannelDialogResponse } from '@maxim/contracts/channel-dialog';
import type { ApiTransport } from '../src/lib/api/transport';

const preview = createPreviewApiTransport();
const route = '/channels/preview-channel/dialog/comments';
const token = 'preview-comments-token-0001';
const initial = await preview.request<ChannelDialogResponse>(`${route}?token=${token}`);
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let sequence = 0;
const message = (
  text = 'Комментарий для проверки прокрутки. Весь текст должен быть доступен. https://example.org/info',
) => ({
  ...initial.messages[0]!,
  id: `scroll-comment-${++sequence}`,
  createdAt: new Date(2026, 8, 13, 12, sequence).toISOString(),
  authorUserId: 'preview-admin',
  authorDisplayName: 'Алексей',
  canEdit: true,
  canDelete: true,
  attachments: [],
  text,
});
let data = { ...initial, messages: Array.from({ length: 24 }, () => message()) };
let pendingSend: { resolve: () => void; reject: (error: Error) => void } | null = null;
let holdSend = false;
const api: ApiTransport = {
  ...preview,
  async request(path, init = {}) {
    if (path.startsWith(route) && (!init.method || init.method === 'GET')) {
      return structuredClone(data) as never;
    }
    const payload = JSON.parse(String(init.body ?? '{}'));
    if (path.endsWith('/messages') && init.method === 'POST') {
      if (holdSend) {
        await new Promise<void>((resolve, reject) => {
          pendingSend = { resolve, reject };
        });
      }
      const next = message(payload.text);
      data = { ...data, messages: [...data.messages, next] };
      return { ok: true, message: next } as never;
    }
    if (init.method === 'PATCH' && path.includes('/messages/')) {
      const id = path.split('/').at(-1);
      const next = { ...data.messages.find((item) => item.id === id)!, text: payload.text };
      data = { ...data, messages: data.messages.map((item) => (item.id === id ? next : item)) };
      return { ok: true, message: next } as never;
    }
    return preview.request(path, init);
  },
};

Object.assign(window, {
  commentTest: {
    async setTruncated(hasMoreMessages: boolean) {
      data = { ...data, hasMoreMessages };
      await client.invalidateQueries();
    },
    async append(text: string) {
      data = { ...data, messages: [...data.messages, message(text)] };
      await client.invalidateQueries();
    },
    holdSend() {
      holdSend = true;
    },
    finishSend(fail = false) {
      if (!pendingSend) throw new Error('No pending send');
      if (fail) pendingSend.reject(new Error('Не удалось отправить комментарий'));
      else pendingSend.resolve();
      holdSend = false;
      pendingSend = null;
    },
    async empty() {
      data = { ...data, messages: [] };
      await client.invalidateQueries();
    },
  },
});

syncMaxNativeEnvironment();
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <ToastProvider>
      <MemoryRouter initialEntries={[`/channel/preview-channel/dialog/comments?token=${token}`]}>
        <div className="app-shell app-shell--no-topbar app-shell--immersive app-shell--comments-dialog">
          <div className="shell-content">
            <Routes>
              <Route
                path="/channel/:chatId/dialog/comments"
                element={
                  <ChannelDialogPage api={api} profile="moderation" userId="preview-admin" />
                }
              />
            </Routes>
          </div>
        </div>
      </MemoryRouter>
    </ToastProvider>
  </QueryClientProvider>,
);
