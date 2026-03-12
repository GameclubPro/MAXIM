import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import {
  BrowserRouter as Router,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { Shell } from './components/shell';
import { GlassCard } from './components/ui/glass-card';
import { StatusState } from './components/ui/status-state';
import { ToastProvider } from './components/ui/toast';
import { ApiClient } from './lib/api-client';
import { getInitData } from './lib/init-data';
import { resolveLaunchRoute } from './lib/launch-route';
import { ChatsPage } from './pages/chats-page';
import { ChannelSettingsPage } from './pages/channel-settings-page';
import { ChannelStatsPage } from './pages/channel-stats-page';
import { ChannelDialogPage } from './pages/channel-dialog-page';
import { EventsPage } from './pages/events-page';
import { GiveawayPage } from './pages/giveaway-page';
import { SettingsPage } from './pages/settings-page';

const queryClient = new QueryClient();
const initData = getInitData();
const apiClient = initData ? new ApiClient(initData) : null;

function LaunchRouteSync({ launchInitData }: { launchInitData: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const appliedRouteRef = useRef<string | null>(null);

  useEffect(() => {
    const targetRoute = resolveLaunchRoute(launchInitData);
    if (!targetRoute || appliedRouteRef.current === targetRoute) {
      return;
    }

    appliedRouteRef.current = targetRoute;
    const currentRoute = `${location.pathname}${location.search}`;
    if (currentRoute !== targetRoute) {
      navigate(targetRoute, { replace: true });
    }
  }, [launchInitData, location.pathname, location.search, navigate]);

  return null;
}

export function App() {
  useEffect(() => {
    window.WebApp?.ready?.();
    window.MAX?.WebApp?.ready?.();
  }, []);

  if (!initData || !apiClient) {
    return (
      <div className="app-shell app-shell--centered">
        <GlassCard className="init-missing-card" elevated>
          <h1>Майор Максимов</h1>
          <StatusState
            tone="warning"
            title="Init Data не найден"
            description="Откройте приложение в MAX через кнопку в боте. При открытии напрямую в браузере авторизация не пройдет."
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
          <LaunchRouteSync launchInitData={initData} />
          <Routes>
            <Route element={<Shell />}>
              <Route path="/" element={<ChatsPage api={apiClient} />} />
              <Route path="/chat/:chatId/settings" element={<SettingsPage api={apiClient} />} />
              <Route
                path="/channel/:chatId/settings"
                element={<ChannelSettingsPage api={apiClient} />}
              />
              <Route path="/channel/:chatId/stats" element={<ChannelStatsPage api={apiClient} />} />
              <Route
                path="/channel/:chatId/dialog/:mode"
                element={<ChannelDialogPage api={apiClient} />}
              />
              <Route path="/chat/:chatId/events" element={<EventsPage api={apiClient} />} />
              <Route path="/giveaways/:giveawayId" element={<GiveawayPage api={apiClient} />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </Router>
      </ToastProvider>
    </QueryClientProvider>
  );
}
