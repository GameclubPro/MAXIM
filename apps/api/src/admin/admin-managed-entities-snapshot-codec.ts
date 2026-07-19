import type { ChatSummary } from '@maxim/contracts';
import { createHash } from 'node:crypto';
import type {
  ManagedEntitiesPublishedDiff,
  ManagedEntitiesPublishedSnapshot,
} from '../chat-context/chat-context-cache.service';
import { readTrimmedString } from './admin-legacy-utils';
import {
  MANAGED_ENTITIES_PUBLISHED_DIFF_MAX_CHANGE_RATIO,
  MANAGED_ENTITY_FAVORITE_TYPE_ORDER,
} from './admin.service.support';

export function cloneManagedEntitySummarySnapshotValue(chat: ChatSummary): ChatSummary {
  const selectedFavoriteTypes = new Set(
    Array.isArray(chat.favoriteTypes) ? chat.favoriteTypes : [],
  );
  const favoriteTypes = MANAGED_ENTITY_FAVORITE_TYPE_ORDER.filter((favoriteType) =>
    selectedFavoriteTypes.has(favoriteType),
  );
  const clone: ChatSummary = {
    ...chat,
    channelOverview: chat.channelOverview ? { ...chat.channelOverview } : null,
    assignedBots: Array.isArray(chat.assignedBots)
      ? chat.assignedBots.map((bot) => ({ ...bot }))
      : [],
  };
  if (favoriteTypes.length > 0) {
    clone.favoriteTypes = favoriteTypes;
  } else {
    delete clone.favoriteTypes;
  }
  return clone;
}

export function serializeManagedEntitySummaryForSnapshot(
  item: ChatSummary,
): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    createdAt: item.createdAt,
    entityType: item.entityType,
    link: item.link ?? null,
    avatarUrl: readTrimmedString(item.avatarUrl) ?? null,
    channelOverview: item.channelOverview
      ? {
          enabledScenariosCount: item.channelOverview.enabledScenariosCount,
          commentsEnabled: item.channelOverview.commentsEnabled,
          postSuggestionsEnabled: item.channelOverview.postSuggestionsEnabled,
          commentsModerationEnabled: item.channelOverview.commentsModerationEnabled,
        }
      : null,
    primaryBotId: item.primaryBotId ?? null,
    assignedBots: (item.assignedBots ?? []).map((bot) => ({
      botId: bot.botId,
      label: bot.label,
      role: bot.role,
      membershipStatus: bot.membershipStatus,
      lifecycleState: bot.lifecycleState,
      speechPersona: bot.speechPersona,
      characterName: bot.characterName ?? null,
      avatarUrl: bot.avatarUrl ?? null,
      capabilities: [...bot.capabilities],
      permissionsSummary: bot.permissionsSummary
        ? {
            checkedAt: bot.permissionsSummary.checkedAt ?? null,
            isAdmin: bot.permissionsSummary.isAdmin,
            isOwner: bot.permissionsSummary.isOwner,
            permissions: [...bot.permissionsSummary.permissions],
          }
        : null,
    })),
    sharedMode: item.sharedMode,
  };
}

export function buildManagedEntitiesPublishedSnapshotHash(
  items: readonly ChatSummary[],
  lastSyncedAt: string | null,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        lastSyncedAt,
        items: items.map((item) => serializeManagedEntitySummaryForSnapshot(item)),
      }),
    )
    .digest('hex');
}

export function areManagedEntitySummariesSnapshotEquivalent(
  left: ChatSummary,
  right: ChatSummary,
): boolean {
  return (
    JSON.stringify(serializeManagedEntitySummaryForSnapshot(left)) ===
    JSON.stringify(serializeManagedEntitySummaryForSnapshot(right))
  );
}

export function buildManagedEntitiesPublishedSnapshotDiff(
  currentSnapshot: ManagedEntitiesPublishedSnapshot | null,
  nextSnapshot: ManagedEntitiesPublishedSnapshot,
): ManagedEntitiesPublishedDiff | null {
  if (!currentSnapshot || currentSnapshot.version === nextSnapshot.version) {
    return null;
  }

  const currentById = new Map(currentSnapshot.items.map((item) => [item.id, item]));
  const nextById = new Map(nextSnapshot.items.map((item) => [item.id, item]));
  const added: ChatSummary[] = [];
  const updated: ChatSummary[] = [];
  const removedIds: string[] = [];

  for (const item of nextSnapshot.items) {
    const currentItem = currentById.get(item.id);
    if (!currentItem) {
      added.push(cloneManagedEntitySummarySnapshotValue(item));
      continue;
    }

    if (!areManagedEntitySummariesSnapshotEquivalent(currentItem, item)) {
      updated.push(cloneManagedEntitySummarySnapshotValue(item));
    }
  }

  for (const item of currentSnapshot.items) {
    if (!nextById.has(item.id)) {
      removedIds.push(item.id);
    }
  }

  const changeCount = added.length + updated.length + removedIds.length;
  if (changeCount === 0) {
    return null;
  }

  const comparisonSize = Math.max(currentSnapshot.itemCount, nextSnapshot.itemCount);
  const maxPatchChanges = Math.max(
    1,
    Math.floor(comparisonSize * MANAGED_ENTITIES_PUBLISHED_DIFF_MAX_CHANGE_RATIO),
  );
  if (changeCount > maxPatchChanges) {
    return null;
  }

  return {
    baseVersion: currentSnapshot.version,
    nextVersion: nextSnapshot.version,
    added,
    updated,
    removedIds,
    orderedIds: nextSnapshot.items.map((item) => item.id),
    changeCount,
  };
}
