import '../src/styles.css';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ToastProvider } from '../src/components/ui/toast';
import { PublisherEntityModulesPage } from '../src/pages/publisher-entity-modules-page';
import { PREVIEW_REQUEST_HANDLERS } from '../src/lib/api/preview-transport';
import { createPreviewState } from '../src/lib/api/preview-transport-state';
import { dispatchPreviewRequest } from '../src/lib/api/preview-transport-runtime';
import { syncMaxNativeEnvironment } from '../src/lib/max-bridge';
import type { ApiTransport } from '../src/lib/api/transport';

const state = createPreviewState({});
state.me.profile = 'publisher';
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let failNext = false;
const changes: unknown[] = [];
const api: ApiTransport = {
  async request(requestPath, init = {}) {
    if (init.method === 'PATCH' && requestPath.endsWith('/modules')) {
      changes.push(JSON.parse(String(init.body)));
      if (failNext) {
        failNext = false;
        throw new Error('Не удалось сохранить');
      }
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
Object.assign(window, {
  publisherCommentsTest: {
    changes,
    failNext() {
      failNext = true;
    },
  },
});
const channel = new URLSearchParams(location.search).get('channel') === '1';
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <ToastProvider>
      <MemoryRouter
        initialEntries={[`/publisher/${channel ? 'channel/preview-channel' : 'chat/preview-chat'}`]}
      >
        <div className="app-shell app-shell--no-topbar">
          <div className="shell-content">
            <Routes>
              <Route
                path="/publisher/:entityType/:entityId"
                element={<PublisherEntityModulesPage api={api} />}
              />
            </Routes>
          </div>
        </div>
      </MemoryRouter>
    </ToastProvider>
  </QueryClientProvider>,
);
