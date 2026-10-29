import type { MarketplaceProfileState } from '@maxim/contracts/marketplace-integration';
import { ApiRequestError } from './api-request-error';
import {
  marketplaceProfileAvailable,
  marketplaceProfileTitle,
} from './marketplace-profile-summary';
import { describeUserFacingError } from './user-facing-error';
export { marketplaceProfileAvailable, marketplaceQueryKey } from './marketplace-profile-summary';

export type MarketplaceDetails = {
  title: string;
  description: string;
  topic: string;
  region: string;
};
export function marketplaceDetails(state: MarketplaceProfileState): MarketplaceDetails {
  return {
    title: state.listing?.title ?? state.binding.metadata.title,
    description: state.listing?.description ?? state.binding.metadata.description.slice(0, 1500),
    topic: state.listing?.topic ?? '',
    region: state.listing?.region ?? '',
  };
}
export function marketplaceProfilePath(profile: string, entityType: string, entityId: string) {
  return `/marketplace/entities/${entityType === 'channel' ? 'CHANNEL' : 'CHAT'}/${encodeURIComponent(entityId)}/profile?profile=${profile}&view=2`;
}
export function isMarketplaceAccessPending(error: unknown) {
  return error instanceof ApiRequestError && error.code === 'MARKETPLACE_ACCESS_PENDING';
}
export function marketplaceRetryInterval(attempts: number, waiting: boolean): number | false {
  if (!waiting) return 60_000;
  return attempts < 4 ? Math.min(5000 * 2 ** attempts, 30_000) : false;
}
export function marketplaceProfileError(error: unknown, fallback: string) {
  const message = describeUserFacingError(error, fallback);
  return /статистик|MAXIM|обмен/iu.test(message) ? fallback : message;
}
export function marketplaceProfileView(state: MarketplaceProfileState, fresh = true) {
  const unexpired =
    state.binding.validUntil === null || Date.parse(state.binding.validUntil) > Date.now();
  const active = fresh && unexpired && state.binding.state === 'ACTIVE';
  const available = marketplaceProfileAvailable(state);
  const caps = state.capabilities;
  const publicState =
    caps?.publicState ??
    (state.listing?.status === 'PAUSED'
      ? 'HIDDEN'
      : state.listing?.status === 'PUBLISHED'
        ? 'ACCESS_REQUIRED'
        : 'DRAFT');
  const publicNow = active && available && publicState === 'PUBLIC' && !!state.listing?.publicUrl;
  return {
    title: marketplaceProfileTitle(state, fresh && unexpired),
    active,
    publicNow,
    canEdit: active && (caps?.canEdit ?? true),
    canPublish: active && available && publicState !== 'REVIEW' && !!caps?.canPublish,
    canPause: active && !!caps?.canPause,
    canAppend: active && available && publicNow,
    placement:
      caps?.placementState ?? (state.listing?.profileOnly ? 'BOT_REQUIRED' : 'UNAVAILABLE'),
    publicState,
  };
}

type MarketplaceOverviewAction =
  | { kind: 'profile'; label: string; editor: boolean }
  | { kind: 'publish' | 'refresh'; label: string }
  | { kind: 'connect' | 'manage' | 'listing'; label: string; url: string };

export function marketplaceProfileOverview(state: MarketplaceProfileState, fresh = true) {
  const view = marketplaceProfileView(state, fresh);
  const listing = state.listing;
  const caps = state.capabilities;
  let status = view.title;
  let placementNote: string | null = null;
  let primary: MarketplaceOverviewAction | null = null;
  let secondary: Extract<MarketplaceOverviewAction, { url: string }> | null = null;
  const publicAction =
    view.publicNow && listing?.publicUrl
      ? { kind: 'listing' as const, label: 'Посмотреть профиль', url: listing.publicUrl }
      : null;

  if (!fresh) {
    status = 'Не удалось обновить данные';
    primary = { kind: 'refresh', label: 'Повторить' };
  } else if (!view.active) {
    status = state.binding.state === 'UNKNOWN' ? 'Проверяем доступ…' : 'Нужно проверить доступ';
    primary = { kind: 'refresh', label: 'Проверить доступ' };
  } else if (!listing) {
    status = 'Профиля пока нет';
    if (view.canEdit) primary = { kind: 'profile', label: 'Создать профиль', editor: true };
  } else if (!marketplaceProfileAvailable(state) || view.publicState === 'ACCESS_REQUIRED') {
    status = 'Профиль пока недоступен';
    primary = { kind: 'refresh', label: 'Проверить доступ' };
  } else if (view.publicState === 'REVIEW') {
    status = 'На проверке';
  } else if (view.publicState === 'HIDDEN') {
    status = 'Скрыт';
    if (view.canEdit) primary = { kind: 'profile', label: 'Настройки профиля', editor: false };
  } else if (view.publicState === 'DRAFT') {
    status = 'Черновик';
    if (!listing.title.trim() || !listing.topic || !listing.region) {
      if (view.canEdit) primary = { kind: 'profile', label: 'Продолжить настройку', editor: true };
    } else if (view.canPublish) primary = { kind: 'publish', label: 'Опубликовать профиль' };
  } else if (view.publicNow) {
    status = 'Опубликован';
    if (view.placement === 'BOT_REQUIRED') {
      placementNote = 'Бот не подключён';
      if (caps?.connectUrl)
        primary = { kind: 'connect', label: 'Подключить бота', url: caps.connectUrl };
    } else if (view.placement === 'SETUP_REQUIRED') {
      placementNote = 'Нужно завершить настройку';
      if (caps?.manageUrl)
        primary = { kind: 'manage', label: 'Настроить размещения', url: caps.manageUrl };
    } else if (view.placement === 'READY') {
      primary = publicAction;
      if (caps?.manageUrl)
        secondary = { kind: 'manage', label: 'Условия размещений', url: caps.manageUrl };
    } else {
      placementNote = 'Размещения пока недоступны';
      if (caps?.manageUrl)
        primary = { kind: 'manage', label: 'Условия размещений', url: caps.manageUrl };
    }
    if (primary?.kind !== 'listing') secondary = publicAction;
  }

  return {
    status,
    placementNote,
    primary,
    secondary,
    showProfileSettings: !!listing && view.canEdit && primary?.kind !== 'profile',
  };
}

export function mergeMarketplaceMutationState(
  result: MarketplaceProfileState,
  previous?: MarketplaceProfileState,
): MarketplaceProfileState {
  if (
    !previous ||
    previous.bindingId !== result.bindingId ||
    previous.entityId !== result.entityId ||
    previous.kind !== result.kind
  )
    return result;
  // Durable policy replies keep the legacy shape; fresh binding/consent still govern every action.
  return {
    ...result,
    capabilities: result.capabilities ?? previous.capabilities,
    statistics: result.statistics ?? previous.statistics,
  };
}
