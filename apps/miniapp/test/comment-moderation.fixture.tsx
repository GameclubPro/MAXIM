import '../src/styles.css';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ToastProvider } from '../src/components/ui/toast';
import { ChannelDialogPage } from '../src/pages/channel-dialog-page';
import { PREVIEW_REQUEST_HANDLERS } from '../src/lib/api/preview-transport';
import { createPreviewState } from '../src/lib/api/preview-transport-state';
import { dispatchPreviewRequest } from '../src/lib/api/preview-transport-runtime';
import { syncMaxNativeEnvironment } from '../src/lib/max-bridge';
import type { ApiTransport } from '../src/lib/api/transport';

let offset = 0;
const state = createPreviewState({ clock: { now: () => new Date(Date.now() + offset) } });
const profile =
  new URLSearchParams(location.search).get('profile') === 'publisher' ? 'publisher' : 'moderation';
state.me.profile = profile;
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let failNext = false;
const api: ApiTransport = {
  async request(requestPath, init = {}) {
    if (failNext && init.method === 'PUT' && requestPath.includes('/moderation/')) {
      failNext = false;
      throw new Error('Не удалось сохранить ограничение. Повторите попытку.');
    }
    const url = new URL(requestPath, 'https://preview.local');
    return dispatchPreviewRequest(
      {
        state,
        url,
        segments: url.pathname.split('/').filter(Boolean),
        method: (init.method ?? 'GET').toUpperCase(),
        init,
      },
      PREVIEW_REQUEST_HANDLERS,
    ) as never;
  },
  requestKeepalive() {},
};
syncMaxNativeEnvironment();
const root = createRoot(document.getElementById('root')!);
const mount = () =>
  root.render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter
          initialEntries={['/chat/preview-chat/dialog/comments?token=preview-comments-token-0001']}
        >
          <div className="app-shell app-shell--no-topbar app-shell--immersive app-shell--comments-dialog">
            <div className="shell-content">
              <Routes>
                <Route
                  path="/chat/:chatId/dialog/comments"
                  element={
                    <ChannelDialogPage api={api} profile={profile} userId={state.me.userId} />
                  }
                />
              </Routes>
            </div>
          </div>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
Object.assign(window, {
  commentModerationTest: {
    async asReader(userId: string) {
      state.me.userId = userId;
      client.clear();
      mount();
    },
    async expireMute() {
      offset += 604800_000;
      await client.invalidateQueries();
    },
    failNext() {
      failNext = true;
    },
  },
});
mount();
