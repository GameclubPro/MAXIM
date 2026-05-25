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
import commentsSpaceDarkWallpaperUrl from './assets/wallpapers/comments-space-dark.webp';
import commentsSpaceLightWallpaperUrl from './assets/wallpapers/comments-space-light.webp';
import { createApiTransport } from './lib/api/transport';
import { getPreviewBootstrap } from './lib/design-preview';
import { getInitData, waitForInitData } from './lib/init-data';
import { resolveLaunchRoute } from './lib/launch-route';
import {
  installMaxNativeInteractionFeedback,
  readyMaxMiniApp,
  syncMaxNativeEnvironment,
} from './lib/max-bridge';
import { PUBLIC_BASE_PATH, PUBLIC_ROUTER_BASENAME } from './lib/public-config';
import {
  LazyChannelDialogPage,
  LazyChannelSettingsPage,
  LazyChannelStatsPage,
  LazyChatsPage,
  LazyEventsPage,
  LazyGiveawayPage,
  LazyLegalAgreementPage,
  LazyPrivacyPolicyPage,
  LazySettingsPage,
  LazySystemPage,
  preloadChannelDialogPage,
  preloadChannelSettingsPage,
  preloadChannelStatsPage,
  preloadEventsPage,
  preloadGiveawayPage,
  preloadSettingsPage,
  preloadSystemPage,
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
  if (!PUBLIC_ROUTER_BASENAME) {
    return pathname;
  }

  return pathname === '/' ? `${PUBLIC_ROUTER_BASENAME}/` : `${PUBLIC_ROUTER_BASENAME}${pathname}`;
}

function resolveRouterPathnameFromWindow(): string {
  if (typeof window === 'undefined') {
    return '/';
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

function preloadImageAsset(href: string, key: string): void {
  if (typeof document === 'undefined') {
    return;
  }

  if (document.head.querySelector(`link[data-maxim-preload="${key}"]`)) {
    return;
  }

  const link = document.createElement('link');
  link.rel = 'preload';
  link.as = 'image';
  link.href = href;
  link.type = 'image/webp';
  link.dataset.maximPreload = key;
  document.head.appendChild(link);
}

function preloadCommentsWallpaper(): void {
  const prefersDark =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  const variant = prefersDark ? 'dark' : 'light';
  preloadImageAsset(
    prefersDark ? commentsSpaceDarkWallpaperUrl : commentsSpaceLightWallpaperUrl,
    `comments-wallpaper-${variant}`,
  );
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
  if (window.location.pathname === nextPathname && window.location.search === nextSearch) {
    return;
  }

  const nextUrl = `${nextPathname}${nextSearch}${window.location.hash}`;
  window.history.replaceState(window.history.state, '', nextUrl);
}

function preloadLaunchRouteModule(route: string): void {
  const parsedRoute = parseRoute(route);
  if (!parsedRoute) {
    return;
  }

  const pathname = parsedRoute.pathname;
  if (/^\/(?:chat|channel)\/[^/]+\/dialog\/comments$/u.test(pathname)) {
    preloadCommentsWallpaper();
    void preloadChannelDialogPage();
    return;
  }

  if (/^\/channel\/[^/]+\/dialog\/suggest$/u.test(pathname)) {
    void preloadChannelDialogPage();
    return;
  }

  if (/^\/chat\/[^/]+\/settings$/u.test(pathname)) {
    void preloadSettingsPage();
    return;
  }

  if (/^\/channel\/[^/]+\/settings$/u.test(pathname)) {
    void preloadChannelSettingsPage();
    return;
  }

  if (/^\/channel\/[^/]+\/stats$/u.test(pathname)) {
    void preloadChannelStatsPage();
    return;
  }

  if (/^\/chat\/[^/]+\/events$/u.test(pathname)) {
    void preloadEventsPage();
    return;
  }

  if (/^\/giveaways\/[^/]+$/u.test(pathname)) {
    void preloadGiveawayPage();
    return;
  }

  if (pathname === '/system') {
    void preloadSystemPage();
  }
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

    preloadLaunchRouteModule(targetRoute);
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
              path="/channel/:chatId/dialog/comments"
              element={<LazyChannelDialogPage api={apiClient} />}
            />
            <Route
              path="/chat/:chatId/dialog/comments"
              element={<LazyChannelDialogPage api={apiClient} />}
            />
            <Route
              path="/channel/:chatId/dialog/suggest"
              element={<LazyChannelDialogPage api={apiClient} />}
            />
            <Route path="/chat/:chatId/events" element={<LazyEventsPage api={apiClient} />} />
            <Route path="/system" element={<LazySystemPage api={apiClient} />} />
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
    <Router basename={PUBLIC_ROUTER_BASENAME}>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/legal/agreement" element={<LazyLegalAgreementPage />} />
          <Route path="/legal/privacy" element={<LazyPrivacyPolicyPage />} />
          <Route path="*" element={<Navigate to="/legal/agreement" replace />} />
        </Routes>
      </Suspense>
    </Router>
  );
}

export function App() {
  const [initData, setInitData] = useState(() => getInitData());
  const preview = getPreviewBootstrap(initData);
  const previewApiRef = useRef<ReturnType<typeof createApiTransport> | null>(null);
  const [previewRuntime, setPreviewRuntime] = useState<PreviewRuntime | null>(null);
  const preparedLaunchRouteRef = useRef<string | null>(null);

  useEffect(() => {
    if (initData) {
      return;
    }

    return waitForInitData(setInitData);
  }, [initData]);

  useEffect(() => {
    const cleanup = syncMaxNativeEnvironment({
      previewDevice: preview.enabled ? preview.device : null,
    });
    readyMaxMiniApp();
    return cleanup;
  }, [preview.device, preview.enabled]);

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
    if (launchRoute && preparedLaunchRouteRef.current !== launchRoute) {
      preloadLaunchRouteModule(launchRoute);
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
            title="Init Data не найден"
            description="Откройте приложение в MAX через кнопку в боте. При открытии напрямую в браузере авторизация не пройдет."
          />
          <div className="init-missing-help">
            <p>Проверьте:</p>
            <ul>
              <li>Запуск идет из MAX, а не по прямой ссылке.</li>
              <li>
                В URL сохраняется `WebAppData` во фрагменте `#...` или bridge
                `window.WebApp.initData`.
              </li>
              <li>
                Редирект на <code>{PUBLIC_BASE_PATH}</code> не теряет hash-фрагмент и параметры
                запуска MAX.
              </li>
              <li>
                Для дизайн-preview можно открыть <code>{PUBLIC_BASE_PATH}?preview=1</code>.
              </li>
            </ul>
          </div>
        </GlassCard>
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Router basename={PUBLIC_ROUTER_BASENAME}>
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
