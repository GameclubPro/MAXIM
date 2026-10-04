import type { MarketplaceProfileState } from '@maxim/contracts/marketplace-integration';

export function marketplaceQueryKey(profile: string, entityType: string, entityId: string) {
  return ['marketplace-profile', profile, entityType, entityId];
}
export function marketplaceProfileTitle(state: MarketplaceProfileState, fresh = true) {
  const active = fresh && state.binding.state === 'ACTIVE';
  const consent = state.binding.statisticsConsent;
  const publicState =
    state.capabilities?.publicState ??
    (state.listing?.status === 'PAUSED'
      ? 'HIDDEN'
      : state.listing?.status === 'PUBLISHED'
        ? 'ACCESS_REQUIRED'
        : 'DRAFT');
  const publicNow = active && publicState === 'PUBLIC' && !!state.listing?.publicUrl;
  return !state.listing
    ? 'Новый профиль · не сохранён'
    : !fresh
      ? 'Не удалось обновить состояние'
      : state.binding.state === 'UNKNOWN'
        ? 'Проверяем ваши права…'
        : !active
          ? consent
            ? 'Доступ не подтверждён'
            : 'Обмен статистикой отключён'
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
