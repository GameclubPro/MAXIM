import type {
  ManagedEntityType,
  PublisherChatCommentSettings,
  PublisherSuggestion,
} from '@maxim/contracts/publisher';

export type PublisherChatCommentSettingKey = keyof PublisherChatCommentSettings;
export type PublisherSuggestionView = 'pending' | 'history';

export const PUBLISHER_SUGGESTIONS_PAGE_SIZE = 20;

export function isPendingPublisherSuggestion(
  suggestion: Pick<PublisherSuggestion, 'reviewStatus'>,
): boolean {
  return suggestion.reviewStatus === 'pending' || suggestion.reviewStatus === 'publishing';
}

export function orderPublisherSuggestions(
  suggestions: readonly PublisherSuggestion[],
): PublisherSuggestion[] {
  const statusRank: Record<PublisherSuggestion['reviewStatus'], number> = {
    pending: 0,
    publishing: 1,
    published: 2,
    cancelled: 3,
  };

  return [...suggestions].sort((left, right) => {
    const statusDifference = statusRank[left.reviewStatus] - statusRank[right.reviewStatus];
    if (statusDifference !== 0) {
      return statusDifference;
    }
    return Date.parse(right.createdAt) - Date.parse(left.createdAt);
  });
}

export function filterPublisherSuggestions(
  suggestions: readonly PublisherSuggestion[],
  view: PublisherSuggestionView,
): PublisherSuggestion[] {
  return orderPublisherSuggestions(suggestions).filter((suggestion) =>
    view === 'pending'
      ? isPendingPublisherSuggestion(suggestion)
      : !isPendingPublisherSuggestion(suggestion),
  );
}

export function countPublisherSuggestions(suggestions: readonly PublisherSuggestion[]): {
  pending: number;
  history: number;
} {
  const pending = suggestions.filter(isPendingPublisherSuggestion).length;
  return { pending, history: suggestions.length - pending };
}

export function growPublisherSuggestionLimit(
  currentLimit: number,
  total: number,
  pageSize = PUBLISHER_SUGGESTIONS_PAGE_SIZE,
): number {
  return Math.min(total, Math.max(pageSize, currentLimit + pageSize));
}

export function getPublisherSuggestionStatusLabel(
  status: PublisherSuggestion['reviewStatus'],
): string {
  if (status === 'published') {
    return 'Публикация создана';
  }
  if (status === 'publishing') {
    return 'Публикуется';
  }
  return status === 'cancelled' ? 'Отклонено' : 'Ожидает решения';
}

export function buildPublisherEntityModulesRoute(entity: {
  entityType: ManagedEntityType;
  id: string;
}): string {
  return `/publisher/${entity.entityType}/${encodeURIComponent(entity.id)}`;
}

export function buildPublisherEntityListRoute(entityType: ManagedEntityType): string {
  return `/?view=${entityType}`;
}

export function updatePublisherChatCommentSetting(
  current: PublisherChatCommentSettings,
  key: PublisherChatCommentSettingKey,
  enabled: boolean,
): PublisherChatCommentSettings {
  const next = { ...current, [key]: enabled };
  if (key === 'commentsEnabled') {
    return enabled && !next.commentsAdminsEnabled && !next.commentsChatBroadcastsEnabled
      ? { ...next, commentsAdminsEnabled: true }
      : next;
  }

  if (enabled) {
    return { ...next, commentsEnabled: true };
  }

  return next.commentsAdminsEnabled || next.commentsChatBroadcastsEnabled
    ? next
    : { ...next, commentsEnabled: false };
}
