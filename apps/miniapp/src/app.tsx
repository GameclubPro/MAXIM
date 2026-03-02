import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { BrowserRouter as Router, Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/shell';
import { GlassCard } from './components/ui/glass-card';
import { StatusState } from './components/ui/status-state';
import { ToastProvider } from './components/ui/toast';
import { ApiClient } from './lib/api-client';
import { getInitData } from './lib/init-data';
import { ChatsPage } from './pages/chats-page';
import { EventsPage } from './pages/events-page';
import { SettingsPage } from './pages/settings-page';

const queryClient = new QueryClient();
const initData = getInitData();
const apiClient = initData ? new ApiClient(initData) : null;

export function App() {
  useEffect(() => {
    window.WebApp?.ready?.();
    window.MAX?.WebApp?.ready?.();
  }, []);

  if (!initData || !apiClient) {
    return (
      <div className="app-shell app-shell--centered">
        <GlassCard className="init-missing-card" elevated>
          <h1>Майор Максимов miniapp</h1>
          <StatusState
            tone="warning"
            title="Init Data не найден"
            description="Откройте miniapp из MAX через кнопку open_app. При открытии напрямую в браузере авторизация не пройдет."
          />
          <div className="init-missing-help">
            <p>Проверьте:</p>
            <ul>
              <li>Запуск идет из MAX, а не по прямой ссылке.</li>
              <li>В URL сохраняется query-параметр `init_data`.</li>
              <li>Редирект на `/app/` не теряет query-параметры.</li>
            </ul>
          </div>
        </GlassCard>
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
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
      </ToastProvider>
    </QueryClientProvider>
  );
}
