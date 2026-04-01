import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
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
import { getPreviewBootstrap } from './lib/design-preview';
import { getInitData } from './lib/init-data';
import { resolveLaunchRoute } from './lib/launch-route';
import { readyMaxMiniApp, syncMaxNativeEnvironment } from './lib/max-bridge';
import {
  LazyChannelDialogPage,
  LazyChannelSettingsPage,
  LazyChannelStatsPage,
  LazyChatsPage,
  LazyEventsPage,
  LazyGiveawayPage,
  LazySettingsPage,
  LazySystemPage,
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

type PreviewRuntime = {
  DesignPreviewScaffold: ComponentType<{
    children: ReactNode;
    initialDevice: ReturnType<typeof getPreviewBootstrap>['device'];
  }>;
  createPreviewApiTransport: () => ReturnType<typeof createApiTransport>;
};

function AppRoutes({
  apiClient,
  launchInitData,
}: {
  apiClient: ReturnType<typeof createApiTransport>;
  launchInitData: string | null;
}) {
  return (
    <>
      {launchInitData ? <LaunchRouteSync launchInitData={launchInitData} /> : null}
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
            <Route
              path="/chat/:chatId/dialog/:mode"
              element={<LazyChannelDialogPage api={apiClient} />}
            />
            <Route path="/chat/:chatId/events" element={<LazyEventsPage api={apiClient} />} />
            <Route path="/system" element={<LazySystemPage api={apiClient} />} />
            <Route path="/giveaways/:giveawayId" element={<LazyGiveawayPage api={apiClient} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </>
  );
}

export function App() {
  const initData = getInitData();
  const preview = getPreviewBootstrap(initData);
  const previewApiRef = useRef<ReturnType<typeof createApiTransport> | null>(null);
  const [previewRuntime, setPreviewRuntime] = useState<PreviewRuntime | null>(null);

  useEffect(() => {
    const cleanup = syncMaxNativeEnvironment({
      previewDevice: preview.enabled ? preview.device : null,
    });
    readyMaxMiniApp();
    return cleanup;
  }, [preview.device, preview.enabled]);

  useEffect(() => {
    if (!preview.enabled || previewRuntime) {
      return;
    }

    let cancelled = false;

    void import('./preview-runtime').then((module) => {
      if (cancelled) {
        return;
      }

      setPreviewRuntime({
        DesignPreviewScaffold: module.DesignPreviewScaffold,
        createPreviewApiTransport: module.createPreviewApiTransport,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [preview.enabled, previewRuntime]);

  if (preview.enabled && previewRuntime && previewApiRef.current === null) {
    previewApiRef.current = previewRuntime.createPreviewApiTransport();
  }

  const PreviewScaffold = previewRuntime?.DesignPreviewScaffold ?? null;

  if (preview.enabled && !previewRuntime) {
    return (
      <div className="app-shell app-shell--centered">
        <GlassCard className="init-missing-card" elevated>
          <h1>Design Preview</h1>
          <StatusState
            tone="neutral"
            title="Подготавливаю preview"
            description="Загружаю мобильную рамку и моковые данные для дизайн-режима."
          />
        </GlassCard>
      </div>
    );
  }

  const apiClient = preview.enabled
    ? previewApiRef.current
    : initData
      ? createApiTransport(getInitData)
      : null;

  if (!apiClient) {
    return (
      <div className="app-shell app-shell--centered">
        <GlassCard className="init-missing-card" elevated>
          <h1>MAXIM</h1>
          <StatusState
            tone="warning"
            title="Init Data не найден"
            description="Откройте приложение в MAX через кнопку в боте. При открытии напрямую в браузере авторизация не пройдет."
          />
          <div className="init-missing-help">
            <p>Проверьте:</p>
            <ul>
              <li>Запуск идет из MAX, а не по прямой ссылке.</li>
              <li>В URL сохраняется `WebAppData` во фрагменте `#...` или bridge `window.WebApp.initData`.</li>
              <li>Редирект на `/app/` не теряет hash-фрагмент и параметры запуска MAX.</li>
              <li>Для дизайн-preview можно открыть `/app/?preview=1`.</li>
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
          {preview.enabled && PreviewScaffold ? (
            <PreviewScaffold initialDevice={preview.device}>
              <AppRoutes apiClient={apiClient} launchInitData={null} />
            </PreviewScaffold>
          ) : (
            <AppRoutes apiClient={apiClient} launchInitData={initData} />
          )}
        </Router>
      </ToastProvider>
    </QueryClientProvider>
  );
}
