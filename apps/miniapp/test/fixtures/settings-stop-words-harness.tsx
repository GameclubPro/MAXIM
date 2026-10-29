import '../../src/styles.css';
import '../../src/styles/moderation-workspace.css';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import {
  chatSettingsSchema,
  stopWordsPolicySchema,
  type ChatSettingsScreenResponse,
} from '@maxim/contracts/settings';
import { SettingsPage } from '../../src/pages/settings-page';
import { ToastProvider } from '../../src/components/ui/toast';
import { createPreviewApiTransport } from '../../src/lib/api/preview-transport';
import type { ApiTransport } from '../../src/lib/api/transport';
import { ApiRequestError } from '../../src/lib/api-request-error';
import { runNativeBackHandlers } from '../../src/lib/native-back';
import { ManagedEntityNavigationProvider } from '../../src/lib/managed-entity-navigation';
import { HomeEntityFavoritesProvider } from '../../src/lib/home-entity-favorites-context';
import { getPreviewApiPrincipalUserId } from '../../src/lib/api/preview-principal';
import { syncMaxNativeEnvironment } from '../../src/lib/max-bridge';

const preview = createPreviewApiTransport();
const verifiedUserId = getPreviewApiPrincipalUserId(preview)!;
const screen = (await preview.request(
  '/chats/chat-a/settings-screen',
)) as ChatSettingsScreenResponse;
screen.settings = chatSettingsSchema.parse({
  settingsRevision: '2026-10-29T08:00:00.000Z',
  antiSpamEnabled: false,
  messageCountLimitEnabled: true,
  messageCountLimitMessages: 5,
  stopWordsRevision: 7,
  stopWordsPolicy: stopWordsPolicySchema.parse({
    enabled: true,
    rules: [
      { id: 'exact', value: 'казино', kind: 'WORD', enabled: true, matchMode: 'EXACT' },
      { id: 'masked', value: 'реклама', kind: 'WORD', enabled: true, matchMode: 'MASKED' },
    ],
    domains: ['blocked.example'],
  }),
});
screen.stopWordsStorageStatus = 'valid';
screen.rules = { ...screen.rules, text: 'Сохранённые правила', autoTextEnabled: false };
// Response seed only: browser tests control HTTP replies and never write page or query state.
Object.defineProperty(window, '__STOP_WORDS_SCREEN__', { value: screen });
document.body.dataset.miniappProfile = 'moderation';
syncMaxNativeEnvironment();
window.WebApp?.BackButton?.onClick(() => runNativeBackHandlers());

const api: ApiTransport = {
  async request(path, init) {
    if (
      /\/(?:settings-screen|stop-words)(?:\/|\?|$)/u.test(path) ||
      (init?.method && init.method !== 'GET')
    ) {
      const response = await fetch(`/api${path}`, init);
      const body = await response.text();
      if (!response.ok) throw new ApiRequestError(response.status, body, 'Не удалось сохранить');
      return body ? JSON.parse(body) : null;
    }
    return preview.request(path, init);
  },
  requestKeepalive() {},
};

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider
    client={
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      })
    }
  >
    <HomeEntityFavoritesProvider api={api} verifiedUserId={verifiedUserId}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/chat/chat-a/settings']}>
          <ManagedEntityNavigationProvider>
            <nav
              aria-label="Тестовая навигация между чатами"
              style={{ position: 'fixed', top: 0, right: 0, zIndex: 10000, background: 'white' }}
            >
              <Link to="/chat/chat-a/settings">Чат A</Link>{' '}
              <Link to="/chat/chat-b/settings">Чат B</Link>
            </nav>
            <Routes>
              <Route path="/chat/:chatId/settings" element={<SettingsPage api={api} />} />
            </Routes>
          </ManagedEntityNavigationProvider>
        </MemoryRouter>
      </ToastProvider>
    </HomeEntityFavoritesProvider>
  </QueryClientProvider>,
);
