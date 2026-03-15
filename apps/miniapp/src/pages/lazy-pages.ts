import { lazy, type ComponentType } from 'react';
import type { ApiTransport } from '../lib/api/transport';

type RoutedPageProps = {
  api: ApiTransport;
};

function lazyPage<TProps>(
  loader: () => Promise<Record<string, unknown>>,
  exportName: string,
) {
  return lazy(async () => {
    const module = await loader();
    return { default: module[exportName] as ComponentType<TProps> };
  });
}

export const preloadChatsPage = () => import('./chats-page');
export const preloadSettingsPage = () => import('./settings-page');
export const preloadChannelSettingsPage = () => import('./channel-settings-page');
export const preloadChannelStatsPage = () => import('./channel-stats-page');
export const preloadChannelDialogPage = () => import('./channel-dialog-page');
export const preloadEventsPage = () => import('./events-page');
export const preloadGiveawayPage = () => import('./giveaway-page');

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
