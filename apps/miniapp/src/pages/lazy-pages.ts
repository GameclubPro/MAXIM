import { createElement, lazy, type ComponentType } from 'react';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import type { ApiTransport } from '../lib/api/transport';
import {
  preloadChannelDialogPage,
  preloadChannelSuggestDialogPage,
  preloadChannelSettingsPage,
  preloadChannelStatsPage,
  preloadEventsPage,
  preloadGiveawayPage,
  preloadLegalPage,
  preloadSettingsPage,
} from './page-preloads';
export {
  preloadChannelDialogPage,
  preloadChannelSuggestDialogPage,
  preloadChannelSettingsPage,
  preloadChannelStatsPage,
  preloadEventsPage,
  preloadGiveawayPage,
  preloadLegalPage,
  preloadSettingsPage,
} from './page-preloads';

type RoutedPageProps = {
  api: ApiTransport;
};

type ProfiledRoutedPageProps = RoutedPageProps & {
  profile: MiniappProfile;
};

function LazyPageLoadFailure() {
  return createElement(
    'button',
    {
      type: 'button',
      className: 'button button--danger',
      onClick: () => window.location.reload(),
    },
    'Обновить',
  );
}

function lazyPage<TProps>(loader: () => Promise<Record<string, unknown>>, exportName: string) {
  return lazy(async () => {
    try {
      const module = await loader();
      return { default: module[exportName] as ComponentType<TProps> };
    } catch (cause) {
      let reloading = false;
      try {
        const recovery = await import('../lib/lazy-load-recovery');
        reloading = recovery.reloadAfterLazyPageLoadFailure(exportName, cause);
      } catch {
        // Keep the explicit reload action available when the recovery chunk also failed.
      }
      if (reloading) {
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
export const LazyChannelDialogPage = lazyPage<ProfiledRoutedPageProps>(
  preloadChannelDialogPage,
  'ChannelDialogPage',
);
export const LazyChannelSuggestDialogPage = lazyPage<ProfiledRoutedPageProps>(
  preloadChannelSuggestDialogPage,
  'ChannelSuggestDialogPage',
);
export const LazyEventsPage = lazyPage<RoutedPageProps>(preloadEventsPage, 'EventsPage');
export const LazyGiveawayPage = lazyPage<RoutedPageProps>(preloadGiveawayPage, 'GiveawayPage');
export const LazyLegalAgreementPage = lazyPage<Record<string, never>>(
  preloadLegalPage,
  'LegalAgreementPage',
);
export const LazyPrivacyPolicyPage = lazyPage<Record<string, never>>(
  preloadLegalPage,
  'PrivacyPolicyPage',
);
