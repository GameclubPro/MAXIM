import type { MarketplaceProfileState } from '@maxim/contracts/marketplace-integration';

export function marketplaceQueryKey(profile: string, entityType: string, entityId: string) {
  return ['marketplace-profile', profile, entityType, entityId];
}
export function marketplaceProfileAvailable(state: MarketplaceProfileState): boolean {
  if (state.statistics?.state === 'DISABLED') return false;
  return (
    state.binding.statisticsConsent ||
    (state.capabilities !== undefined && state.statistics !== undefined)
  );
}
export function marketplaceProfileTitle(state: MarketplaceProfileState, fresh = true) {
  const active = fresh && state.binding.state === 'ACTIVE';
  const publicState =
    state.capabilities?.publicState ??
    (state.listing?.status === 'PAUSED'
      ? 'HIDDEN'
      : state.listing?.status === 'PUBLISHED'
        ? 'ACCESS_REQUIRED'
        : 'DRAFT');
  const publicNow =
    active &&
    marketplaceProfileAvailable(state) &&
    publicState === 'PUBLIC' &&
    !!state.listing?.publicUrl;
  return !state.listing
    ? 'Новый профиль · не сохранён'
    : !fresh
      ? 'Не удалось обновить состояние'
      : state.binding.state === 'UNKNOWN'
        ? 'Проверяем ваши права…'
        : !active
          ? 'Профиль пока недоступен'
          : !marketplaceProfileAvailable(state)
            ? 'Профиль пока недоступен'
            : publicState === 'REVIEW'
              ? 'Профиль на проверке биржи'
              : publicNow
                ? 'Профиль опубликован'
                : publicState === 'HIDDEN'
                  ? 'Профиль скрыт'
                  : publicState === 'ACCESS_REQUIRED'
                    ? 'Профиль сейчас недоступен посетителям'
                    : 'Черновик · виден только вам';
}
