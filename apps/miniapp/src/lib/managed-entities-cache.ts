import type { ChatSummary, ManagedEntitiesRefreshState } from '@maxim/contracts';

export type ManagedEntityKind = 'chat' | 'channel';

type ManagedEntitiesSnapshot = {
  items: ChatSummary[];
  refreshState: ManagedEntitiesRefreshState | null;
  lastSyncedAtMs: number | null;
};

function buildStorageKey(entityType: ManagedEntityKind): string {
  return `maxim:managed-entities-snapshot:${entityType}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseChannelOverview(value: unknown): ChatSummary['channelOverview'] {
  if (value === null || value === undefined) {
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.enabledScenariosCount !== 'number' ||
    !Number.isInteger(value.enabledScenariosCount) ||
    typeof value.commentsEnabled !== 'boolean' ||
    typeof value.postSuggestionsEnabled !== 'boolean' ||
    typeof value.commentsModerationEnabled !== 'boolean'
  ) {
    return null;
  }

  return {
    enabledScenariosCount: value.enabledScenariosCount,
    commentsEnabled: value.commentsEnabled,
    postSuggestionsEnabled: value.postSuggestionsEnabled,
    commentsModerationEnabled: value.commentsModerationEnabled,
  };
}

function parseChatSummary(value: unknown): ChatSummary | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.createdAt !== 'string'
  ) {
    return null;
  }

  return {
    id: value.id,
    title: value.title,
    createdAt: value.createdAt,
    entityType: value.entityType === 'channel' ? 'channel' : 'chat',
    link: typeof value.link === 'string' ? value.link.trim() || null : null,
    avatarUrl: typeof value.avatarUrl === 'string' ? value.avatarUrl.trim() || null : null,
    channelOverview: parseChannelOverview(value.channelOverview),
  };
}

function parseRefreshState(value: unknown): ManagedEntitiesRefreshState | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.complete !== 'boolean' ||
    typeof value.backoffActive !== 'boolean' ||
    (value.cursor !== null &&
      value.cursor !== undefined &&
      (typeof value.cursor !== 'number' || !Number.isInteger(value.cursor))) ||
    (value.nextPollAfterMs !== undefined &&
      (typeof value.nextPollAfterMs !== 'number' ||
        !Number.isInteger(value.nextPollAfterMs) ||
        value.nextPollAfterMs < 0))
  ) {
    return null;
  }

  return {
    complete: value.complete,
    backoffActive: value.backoffActive,
    cursor: value.cursor ?? null,
    nextPollAfterMs: value.nextPollAfterMs ?? 900,
  };
}

export function readManagedEntitiesSnapshot(
  entityType: ManagedEntityKind,
): ManagedEntitiesSnapshot | null {
  try {
    const raw = window.localStorage.getItem(buildStorageKey(entityType));
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
      return null;
    }

    const items = parsed.items
      .map((item) => parseChatSummary(item))
      .filter((item): item is ChatSummary => item !== null);

    if (items.length === 0) {
      return null;
    }

    const lastSyncedAtMs =
      typeof parsed.lastSyncedAtMs === 'number' && Number.isFinite(parsed.lastSyncedAtMs)
        ? Math.trunc(parsed.lastSyncedAtMs)
        : null;

    return {
      items,
      refreshState: parseRefreshState(parsed.refreshState),
      lastSyncedAtMs,
    };
  } catch {
    return null;
  }
}

export function saveManagedEntitiesSnapshot(
  entityType: ManagedEntityKind,
  snapshot: ManagedEntitiesSnapshot,
): void {
  try {
    window.localStorage.setItem(buildStorageKey(entityType), JSON.stringify(snapshot));
  } catch {
    // Ignore localStorage failures in restrictive WebView environments.
  }
}
