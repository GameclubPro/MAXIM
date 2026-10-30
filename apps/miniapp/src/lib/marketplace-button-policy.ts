import type {
  MarketplaceButtonContext,
  MarketplaceButtonModule,
  MarketplaceButtonPolicyState,
} from '@maxim/contracts/marketplace-integration';

export function marketplaceEntityPath(
  profile: 'moderation' | 'publisher',
  entityType: 'chat' | 'channel',
  entityId: string,
  view: 'entry' | 'button-policy' | 'editorial',
) {
  return `/marketplace/entities/${entityType === 'channel' ? 'CHANNEL' : 'CHAT'}/${encodeURIComponent(entityId)}/${view}?profile=${profile}${view === 'button-policy' ? '&version=2' : ''}`;
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
  CHECKING: 'Проверяем доступ…',
  PROFILE_UNAVAILABLE: 'Профиль недоступен посетителям.',
  ACCESS_REQUIRED: 'Проверьте права администратора и бота.',
  CONFIRM_REQUIRED: 'Нужно повторное подтверждение.',
};

export function mergeMarketplaceButtonPolicy(
  result: MarketplaceButtonPolicyState,
  previous?: MarketplaceButtonPolicyState,
) {
  if (
    previous &&
    (previous.entityId !== result.entityId ||
      previous.kind !== result.kind ||
      previous.profile !== result.profile)
  )
    return result;
  if (
    previous &&
    previous.entityId === result.entityId &&
    previous.kind === result.kind &&
    previous.profile === result.profile &&
    previous.revision > result.revision
  )
    return previous.captionRevision < result.captionRevision
      ? { ...previous, caption: result.caption, captionRevision: result.captionRevision }
      : previous;
  return previous && previous.captionRevision > result.captionRevision
    ? { ...result, caption: previous.caption, captionRevision: previous.captionRevision }
    : result;
}

export const marketplaceModuleLabels: Record<MarketplaceButtonModule, string> = {
  GREETING: 'Приветствие',
  LINKS: 'Ссылки',
  PROFANITY: 'Мат и оскорбления',
  COMMERCIAL: 'Реклама',
  DUPLICATES: 'Антидубли',
  MESSAGE_LIMITS: 'Лимиты сообщений',
  STOP_WORDS: 'Стоп-слова',
  PHONE_NUMBERS: 'Номера телефонов',
  REQUIRED_SUBSCRIPTION: 'Обязательная подписка',
  INVITATION_ACCESS: 'Вход по приглашению',
  OTHER_MODERATION: 'Другие уведомления',
  NIGHT_MODE: 'Ночной режим',
  RULES: 'Правила',
  CHANNEL_POST: 'Новые посты канала',
  PUBLICATION: 'Публикации',
  VK_IMPORT: 'Импорт из VK',
  APPROVED_SUGGESTION: 'Предложенные посты',
};
