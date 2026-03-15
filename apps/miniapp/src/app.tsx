import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense, useEffect, useRef } from 'react';
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
import { SkeletonCard } from './components/ui/skeleton';
import { StatusState } from './components/ui/status-state';
import { ToastProvider } from './components/ui/toast';
import { createApiTransport } from './lib/api/transport';
import { getInitData } from './lib/init-data';
import { resolveLaunchRoute } from './lib/launch-route';
import { readyMaxMiniApp } from './lib/max-bridge';
import {
  LazyChannelDialogPage,
  LazyChannelSettingsPage,
  LazyChannelStatsPage,
  LazyChatsPage,
  LazyEventsPage,
  LazyGiveawayPage,
  LazySettingsPage,
} from './pages/lazy-pages';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      retry: 1,
    },
  },
});
const initData = getInitData();
const apiClient = initData ? createApiTransport(initData) : null;

function RouteFallback() {
  return (
    <div className="page-stack page-enter">
      <GlassCard className="settings-section">
        <SkeletonCard lines={5} />
      </GlassCard>
    </div>
  );
}

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
    readyMaxMiniApp();
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
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route element={<Shell />}>
                <Route path="/" element={<LazyChatsPage api={apiClient} />} />
                <Route path="/chat/:chatId/settings" element={<LazySettingsPage api={apiClient} />} />
                <Route
                  path="/channel/:chatId/settings"
                  element={<LazyChannelSettingsPage api={apiClient} />}
                />
                <Route
                  path="/channel/:chatId/stats"
                  element={<LazyChannelStatsPage api={apiClient} />}
                />
                <Route
                  path="/channel/:chatId/dialog/:mode"
                  element={<LazyChannelDialogPage api={apiClient} />}
                />
                <Route path="/chat/:chatId/events" element={<LazyEventsPage api={apiClient} />} />
                <Route path="/giveaways/:giveawayId" element={<LazyGiveawayPage api={apiClient} />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </Suspense>
        </Router>
      </ToastProvider>
    </QueryClientProvider>
  );
}
