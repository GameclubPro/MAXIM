import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import { Shell } from './components/shell';
import { ApiClient } from './lib/api-client';
import { getInitData } from './lib/init-data';
import { ChatsPage } from './pages/chats-page';
import { EventsPage } from './pages/events-page';
import { SettingsPage } from './pages/settings-page';

const queryClient = new QueryClient();
const initData = getInitData();
const apiClient = new ApiClient(initData);

export function App() {
  useEffect(() => {
    window.WebApp?.ready?.();
    window.MAX?.WebApp?.ready?.();
  }, []);

  if (!initData) {
    return (
      <div className="layout">
        <main className="content">
          <section className="panel">
            <h2>Init Data не найден</h2>
            <p>
              Открой mini-app из MAX через кнопку `open_app` или передайте `init_data` в query-параметре.
            </p>
          </section>
        </main>
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <Router basename="/app">
        <Routes>
          <Route element={<Shell />}>
            <Route path="/" element={<ChatsPage api={apiClient} />} />
            <Route path="/chat/:chatId/settings" element={<SettingsPage api={apiClient} />} />
            <Route path="/chat/:chatId/events" element={<EventsPage api={apiClient} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Router>
    </QueryClientProvider>
  );
}
