import type {
  MarketplaceButtonContext,
  MarketplaceButtonPolicyState,
} from '@maxim/contracts/marketplace-integration';

export function marketplaceEntityPath(
  profile: 'moderation' | 'publisher',
  entityType: 'chat' | 'channel',
  entityId: string,
  view: 'entry' | 'button-policy',
) {
  return `/marketplace/entities/${entityType === 'channel' ? 'CHANNEL' : 'CHAT'}/${encodeURIComponent(entityId)}/${view}?profile=${profile}`;
}
export const marketplaceButtonLabels: Record<MarketplaceButtonContext, string> = {
  GREETINGS: 'В приветствиях',
  MODERATION_NOTICES: 'В уведомлениях модерации',
  CHANNEL_POSTS: 'В новых постах канала',
  PUBLICATIONS: 'В публикациях',
};
export const marketplaceButtonStatus: Record<
  MarketplaceButtonPolicyState['contexts'][number]['status'],
  string
> = {
  OFF: '',
  READY: '',
  CHECKING: 'Проверяем доступность кнопки…',
  PROFILE_UNAVAILABLE: 'Кнопка появится после публикации доступного профиля.',
  ACCESS_REQUIRED: 'Для кнопки нужны действующие права администратора и бота.',
  CONFIRM_REQUIRED: 'Подтвердите включение с текущими правами.',
};

export function mergeMarketplaceButtonPolicy(
  result: MarketplaceButtonPolicyState,
  previous?: MarketplaceButtonPolicyState,
) {
  if (
    previous &&
    previous.entityId === result.entityId &&
    previous.kind === result.kind &&
    previous.profile === result.profile &&
    previous.revision > result.revision
  )
    return previous;
  return result;
}
