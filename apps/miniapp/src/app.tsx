import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import {
  BrowserRouter as Router,
  HashRouter,
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
import { createApiTransport } from './lib/api/transport';
import { traceMiniappBoot, traceMiniappLaunchRoute } from './lib/boot-trace';
import { getPreviewBootstrap } from './lib/design-preview';
import { migrateHashRouterLegacyPathFromWindow } from './lib/hash-router-legacy-path';
import { getInitData, waitForInitData } from './lib/init-data';
import { resolveLaunchRoute } from './lib/launch-route';
import {
  installMaxNativeInteractionFeedback,
  readyMaxMiniApp,
  syncMaxNativeEnvironment,
} from './lib/max-bridge';
import { PUBLIC_ROUTER_BASENAME } from './lib/public-config';
import {
  LazyChannelDialogPage,
  LazyChannelSuggestDialogPage,
  LazyChannelSettingsPage,
  LazyChannelStatsPage,
  LazyChatsPage,
  LazyEventsPage,
  LazyGiveawayPage,
  LazyLegalAgreementPage,
  LazyPrivacyPolicyPage,
  LazySettingsPage,
} from './pages/lazy-pages';

const LazyAutopostsPage = lazy(async () => {
  const module = await import('./pages/autoposts-page');
  return { default: module.AutopostsPage };
});

const HASH_ROUTER_ENABLED =
  typeof __MAXIM_ROUTER_MODE__ === 'string' && __MAXIM_ROUTER_MODE__ === 'hash';
const AppRouter = HASH_ROUTER_ENABLED ? HashRouter : Router;
const ROUTER_BASENAME = HASH_ROUTER_ENABLED ? '' : PUBLIC_ROUTER_BASENAME;

migrateHashRouterLegacyPathFromWindow();

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

function parseRoute(route: string): URL | null {
  try {
    return new URL(route, 'https://miniapp.local');
  } catch {
    return null;
  }
}

function mergeRouteSearch(currentSearch: string, targetSearch: string): string {
  const merged = new URLSearchParams(currentSearch);
  const target = new URLSearchParams(targetSearch);
  const targetKeys = new Set(Array.from(target.keys()));

  for (const key of targetKeys) {
    merged.delete(key);
  }

  for (const [key, value] of target.entries()) {
    merged.append(key, value);
  }

  const serialized = merged.toString();
  return serialized ? `?${serialized}` : '';
}

function isLaunchRouteApplied(
  currentPathname: string,
  currentSearch: string,
  targetRoute: string,
): boolean {
  const parsedTarget = parseRoute(targetRoute);
  if (!parsedTarget) {
    return true;
  }

  if (currentPathname !== parsedTarget.pathname) {
    return false;
  }

  const current = new URLSearchParams(currentSearch);
  for (const [key, value] of parsedTarget.searchParams.entries()) {
    if (current.get(key) !== value) {
      return false;
    }
  }

  return true;
}

function buildMergedLaunchRoute(targetRoute: string, currentSearch: string): string {
  const parsedTarget = parseRoute(targetRoute);
  if (!parsedTarget) {
    return targetRoute;
  }

  return `${parsedTarget.pathname}${mergeRouteSearch(currentSearch, parsedTarget.search)}`;
}

function buildWindowPathForRoute(pathname: string): string {
  if (HASH_ROUTER_ENABLED) {
    return pathname;
  }

  if (!PUBLIC_ROUTER_BASENAME) {
    return pathname;
  }

  return pathname === '/' ? `${PUBLIC_ROUTER_BASENAME}/` : `${PUBLIC_ROUTER_BASENAME}${pathname}`;
}

function resolveRouterPathnameFromWindow(): string {
  if (typeof window === 'undefined') {
    return '/';
  }

  if (HASH_ROUTER_ENABLED) {
    const hashRoute = window.location.hash.replace(/^#/u, '') || '/';
    const parsedHashRoute = parseRoute(hashRoute);
    return parsedHashRoute?.pathname || '/';
  }

  const pathname = window.location.pathname || '/';
  if (
    PUBLIC_ROUTER_BASENAME &&
    (pathname === PUBLIC_ROUTER_BASENAME || pathname.startsWith(`${PUBLIC_ROUTER_BASENAME}/`))
  ) {
    const stripped = pathname.slice(PUBLIC_ROUTER_BASENAME.length);
    return stripped || '/';
  }

  return pathname;
}

function isPublicLegalPathname(): boolean {
  return /^\/legal\/(?:agreement|privacy)\/?$/u.test(resolveRouterPathnameFromWindow());
}

function applyInitialLaunchRoute(targetRoute: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  const parsedTarget = parseRoute(targetRoute);
  if (!parsedTarget) {
    return;
  }

  const nextPathname = buildWindowPathForRoute(parsedTarget.pathname);
  const nextSearch = mergeRouteSearch(window.location.search, parsedTarget.search);
  if (HASH_ROUTER_ENABLED) {
    const currentHashRoute = parseRoute(window.location.hash.replace(/^#/u, '') || '/');
    const currentHashPathname = currentHashRoute?.pathname || '/';
    const currentHashSearch = currentHashRoute?.search || '';
    const nextHashSearch = mergeRouteSearch(currentHashSearch, parsedTarget.search);
    if (currentHashPathname === parsedTarget.pathname && currentHashSearch === nextHashSearch) {
      return;
    }

    const nextUrl = `${window.location.pathname}${window.location.search}#${parsedTarget.pathname}${nextHashSearch}`;
    window.history.replaceState(window.history.state, '', nextUrl);
    return;
  }

  if (window.location.pathname === nextPathname && window.location.search === nextSearch) {
    return;
  }

  const nextUrl = `${nextPathname}${nextSearch}${window.location.hash}`;
  window.history.replaceState(window.history.state, '', nextUrl);
}

function LaunchRouteSync({ launchInitData }: { launchInitData: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const appliedRouteRef = useRef<string | null>(null);

  useEffect(() => {
    const targetRoute = resolveLaunchRoute(launchInitData);
    traceMiniappLaunchRoute(targetRoute, 'router-sync');
    if (!targetRoute || appliedRouteRef.current === targetRoute) {
      return;
    }

    appliedRouteRef.current = targetRoute;
    if (!isLaunchRouteApplied(location.pathname, location.search, targetRoute)) {
      navigate(buildMergedLaunchRoute(targetRoute, location.search), { replace: true });
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
  useEffect(() => {
    traceMiniappBoot('first_render', undefined, { once: true });
  }, []);

  return (
    <>
      {launchInitData ? <LaunchRouteSync launchInitData={launchInitData} /> : null}
      <Suspense fallback={null}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="/" element={<LazyChatsPage api={apiClient} />} />
            <Route path="/autoposts" element={<LazyAutopostsPage api={apiClient} />} />
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
              path="/channel/:chatId/dialog/comments"
              element={<LazyChannelDialogPage api={apiClient} />}
            />
            <Route
              path="/chat/:chatId/dialog/comments"
              element={<LazyChannelDialogPage api={apiClient} />}
            />
            <Route
              path="/channel/:chatId/dialog/suggest"
              element={<LazyChannelSuggestDialogPage api={apiClient} />}
            />
            <Route path="/chat/:chatId/events" element={<LazyEventsPage api={apiClient} />} />
            <Route path="/giveaways/:giveawayId" element={<LazyGiveawayPage api={apiClient} />} />
            <Route path="/legal/agreement" element={<LazyLegalAgreementPage />} />
            <Route path="/legal/privacy" element={<LazyPrivacyPolicyPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </>
  );
}

function PublicLegalRoutes() {
  return (
    <AppRouter basename={ROUTER_BASENAME}>
      <Suspense fallback={null}>
        <Routes>
          <Route path="/legal/agreement" element={<LazyLegalAgreementPage />} />
          <Route path="/legal/privacy" element={<LazyPrivacyPolicyPage />} />
          <Route path="*" element={<Navigate to="/legal/agreement" replace />} />
        </Routes>
      </Suspense>
    </AppRouter>
  );
}

export function App() {
  const [initData, setInitData] = useState(() => getInitData());
  const preview = getPreviewBootstrap(initData);
  const previewApiRef = useRef<ReturnType<typeof createApiTransport> | null>(null);
  const [previewRuntime, setPreviewRuntime] = useState<PreviewRuntime | null>(null);
  const preparedLaunchRouteRef = useRef<string | null>(null);
  const nativeReadyCalledRef = useRef(false);

  useEffect(() => {
    if (initData) {
      traceMiniappBoot('init_data_found', undefined, { once: true });
      return;
    }

    traceMiniappBoot('init_data_waiting', undefined, { once: true });
    return waitForInitData(setInitData);
  }, [initData]);

  useEffect(() => {
    const cleanup = syncMaxNativeEnvironment({
      previewDevice: preview.enabled ? preview.device : null,
    });
    if (!nativeReadyCalledRef.current && readyMaxMiniApp()) {
      nativeReadyCalledRef.current = true;
    }
    traceMiniappBoot(
      'bridge_ready',
      {
        preview: preview.enabled,
        platform: document.documentElement.dataset.maxPlatform ?? null,
        client: document.documentElement.dataset.maxClient ?? null,
      },
      { once: true },
    );
    return cleanup;
  }, [preview.device, preview.enabled]);

  useEffect(() => {
    if (!initData) {
      return;
    }

    if (!nativeReadyCalledRef.current && readyMaxMiniApp()) {
      nativeReadyCalledRef.current = true;
    }
  }, [initData]);

  useEffect(() => installMaxNativeInteractionFeedback(), []);

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

  if (!preview.enabled && initData) {
    const launchRoute = resolveLaunchRoute(initData);
    traceMiniappLaunchRoute(launchRoute, 'initial');
    if (launchRoute && preparedLaunchRouteRef.current !== launchRoute) {
      applyInitialLaunchRoute(launchRoute);
      preparedLaunchRouteRef.current = launchRoute;
    }
  }

  if (!apiClient && isPublicLegalPathname()) {
    return <PublicLegalRoutes />;
  }

  if (!apiClient) {
    return (
      <div className="app-shell app-shell--centered">
        <GlassCard className="init-missing-card" elevated>
          <h1>Панель ботов</h1>
          <StatusState
            tone="warning"
            title="Не удалось открыть приложение"
            description="Запустите панель через кнопку в боте MAX. При открытии по прямой ссылке вход недоступен."
          />
          <div className="init-missing-help">
            <p>Проверьте:</p>
            <ul>
              <li>Откройте приложение из MAX, а не по прямой ссылке в браузере.</li>
              <li>
                Если кнопка в боте не открывает панель, закройте приложение и попробуйте еще раз.
              </li>
              <li>При сохранении проблемы напишите администратору бота.</li>
            </ul>
          </div>
        </GlassCard>
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AppRouter basename={ROUTER_BASENAME}>
          {preview.enabled && PreviewScaffold ? (
            <PreviewScaffold initialDevice={preview.device}>
              <AppRoutes apiClient={apiClient} launchInitData={null} />
            </PreviewScaffold>
          ) : (
            <AppRoutes apiClient={apiClient} launchInitData={initData} />
          )}
        </AppRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
