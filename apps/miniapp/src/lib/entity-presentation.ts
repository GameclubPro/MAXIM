import type { ChatSummary, ManagedEntityPresentation } from '@maxim/contracts';
import { isUnusableChatTitle } from './chat-titles';

export function mergeEntityPresentation<T extends ChatSummary>(
  entity: T,
  presentation: ManagedEntityPresentation | undefined,
): T {
  if (
    !presentation ||
    presentation.id !== entity.id ||
    presentation.entityType !== entity.entityType
  )
    return entity;
  const moderator =
    presentation.moderatorRevision !== undefined &&
    presentation.moderatorRevision >= (entity.moderatorRevision ?? 0)
      ? {
          moderator: presentation.moderator,
          moderatorRevision: presentation.moderatorRevision,
          canChooseModerator: presentation.canChooseModerator,
        }
      : {};
  if (
    entity.metadataObservedAt &&
    (!presentation.observedAt || presentation.observedAt < entity.metadataObservedAt)
  )
    return { ...entity, ...moderator };
  return {
    ...entity,
    ...moderator,
    avatarState: presentation.avatarState,
    metadataObservedAt: presentation.observedAt,
    ...(presentation.title && !isUnusableChatTitle(entity.id, presentation.title)
      ? { title: presentation.title }
      : {}),
    ...(presentation.avatarState === 'absent'
      ? { avatarUrl: null }
      : presentation.avatarUrl
        ? { avatarUrl: presentation.avatarUrl }
        : {}),
  };
}
