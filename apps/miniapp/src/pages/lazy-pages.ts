import { lazy, type ComponentType } from 'react';
import type { ApiTransport } from '../lib/api/transport';

type RoutedPageProps = {
  api: ApiTransport;
};

const LAZY_PAGE_RELOAD_MARKER_PREFIX = 'maxim:lazy-page-reload:v1:';
const ASSET_URL_PATTERN = /(?:https?:\/\/[^\s"'()]+)?\/assets\/[^\s"'()]+\.js/iu;

export function buildLazyPageReloadMarkerKey(exportName: string, cause: unknown): string {
  const message =
    cause instanceof Error
      ? `${cause.name}: ${cause.message}`
      : typeof cause === 'string'
        ? cause
        : '';
  const assetUrl = message.match(ASSET_URL_PATTERN)?.[0];
  return `${LAZY_PAGE_RELOAD_MARKER_PREFIX}${assetUrl ?? exportName}`;
}

function reloadAfterLazyPageLoadFailure(exportName: string, cause: unknown): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const markerKey = buildLazyPageReloadMarkerKey(exportName, cause);
  try {
    if (window.sessionStorage.getItem(markerKey) === '1') {
      return false;
    }
    window.sessionStorage.setItem(markerKey, '1');
  } catch {
    return false;
  }

  window.location.reload();
  return true;
}

function lazyPage<TProps>(loader: () => Promise<Record<string, unknown>>, exportName: string) {
  return lazy(async () => {
    try {
      const module = await loader();
      return { default: module[exportName] as ComponentType<TProps> };
    } catch (cause) {
      if (reloadAfterLazyPageLoadFailure(exportName, cause)) {
        return new Promise<never>(() => {
          // Keep the Suspense fallback visible while the browser reloads.
        });
      }

      throw cause;
    }
  });
}

export const preloadChatsPage = () => import('./chats-page');
export const preloadSettingsPage = () => import('./settings-page');
export const preloadChannelSettingsPage = () => import('./channel-settings-page');
export const preloadChannelStatsPage = () => import('./channel-stats-page');
export const preloadChannelDialogPage = () => import('./channel-dialog-page');
export const preloadEventsPage = () => import('./events-page');
export const preloadGiveawayPage = () => import('./giveaway-page');
export const preloadSystemPage = () => import('./system-page');

export const LazyChatsPage = lazyPage<RoutedPageProps>(preloadChatsPage, 'ChatsPage');
export const LazySettingsPage = lazyPage<RoutedPageProps>(preloadSettingsPage, 'SettingsPage');
export const LazyChannelSettingsPage = lazyPage<RoutedPageProps>(
  preloadChannelSettingsPage,
  'ChannelSettingsPage',
);
export const LazyChannelStatsPage = lazyPage<RoutedPageProps>(
  preloadChannelStatsPage,
  'ChannelStatsPage',
);
export const LazyChannelDialogPage = lazyPage<RoutedPageProps>(
  preloadChannelDialogPage,
  'ChannelDialogPage',
);
export const LazyEventsPage = lazyPage<RoutedPageProps>(preloadEventsPage, 'EventsPage');
export const LazyGiveawayPage = lazyPage<RoutedPageProps>(preloadGiveawayPage, 'GiveawayPage');
export const LazySystemPage = lazyPage<RoutedPageProps>(preloadSystemPage, 'SystemPage');
