import type { ManagedEntityType, PublisherChatCommentSettings } from '@maxim/contracts/publisher';

export type PublisherChatCommentSettingKey = keyof PublisherChatCommentSettings;

export function buildPublisherEntityModulesRoute(entity: {
  entityType: ManagedEntityType;
  id: string;
}): string {
  return `/publisher/${entity.entityType}/${encodeURIComponent(entity.id)}`;
}

export function buildPublisherEntityListRoute(entityType: ManagedEntityType): string {
  return `/?view=${entityType}`;
}

export function buildPublisherAutoRepliesRoute(chatId: string): string {
  return `/publisher/chat/${encodeURIComponent(chatId)}/auto-replies`;
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
