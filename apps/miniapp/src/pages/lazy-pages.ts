import { createElement, lazy, type ComponentType } from 'react';
import type { ApiTransport } from '../lib/api/transport';
import {
  preloadChannelDialogPage,
  preloadChannelSettingsPage,
  preloadChannelStatsPage,
  preloadEventsPage,
  preloadGiveawayPage,
  preloadLegalPage,
  preloadSettingsPage,
  preloadSystemPage,
} from './page-preloads';
export {
  preloadChannelDialogPage,
  preloadChannelSettingsPage,
  preloadChannelStatsPage,
  preloadEventsPage,
  preloadGiveawayPage,
  preloadLegalPage,
  preloadSettingsPage,
  preloadSystemPage,
} from './page-preloads';

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

function LazyPageLoadFailure() {
  return createElement(
    'div',
    { className: 'page-stack page-enter' },
    createElement(
      'section',
      { className: 'status-state status-state--danger' },
      createElement('div', { className: 'status-state__icon', 'aria-hidden': true }, 'x'),
      createElement(
        'div',
        { className: 'status-state__content' },
        createElement('h3', null, 'Ошибка загрузки'),
        createElement('p', null, 'Обновите экран или откройте приложение заново.'),
      ),
      createElement(
        'div',
        { className: 'status-state__action' },
        createElement(
          'button',
          {
            type: 'button',
            className: 'button button--danger',
            onClick: () => window.location.reload(),
          },
          'Обновить',
        ),
      ),
    ),
  );
}

function lazyPage<TProps>(loader: () => Promise<Record<string, unknown>>, exportName: string) {
  return lazy(async () => {
    try {
      const module = await loader();
      return { default: module[exportName] as ComponentType<TProps> };
    } catch (cause) {
      if (reloadAfterLazyPageLoadFailure(exportName, cause)) {
        await new Promise((resolve) => setTimeout(resolve, 4_000));
      }

      return { default: LazyPageLoadFailure as ComponentType<TProps> };
    }
  });
}

export const preloadChatsPage = () => import('./chats-page');

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
export const LazyLegalAgreementPage = lazyPage<Record<string, never>>(
  preloadLegalPage,
  'LegalAgreementPage',
);
export const LazyPrivacyPolicyPage = lazyPage<Record<string, never>>(
  preloadLegalPage,
  'PrivacyPolicyPage',
);
