import type {
  ChatSummary,
  ManagedEntityAssignedBot,
  ManagedEntityBotCapability,
  ManagedEntitiesListResponse,
  ManagedEntitiesResponseDiff,
  ManagedEntitiesResponseSnapshot,
  ManagedEntityFavoriteType,
  Me,
} from '@maxim/contracts';
import type { ApiTransport } from './transport';

type ManagedEntitiesFetchOptions = {
  refresh?: boolean;
  includeRefreshState?: boolean;
  bypassRemoteCache?: boolean;
  resetRefreshCursor?: boolean;
  fresh?: boolean;
  sinceVersion?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseChannelOverview(value: unknown): ChatSummary['channelOverview'] {
  if (value === null || value === undefined) {
    return null;
  }

  if (!isRecord(value)) {
    throw new Error('Invalid channel overview');
  }

  if (
    typeof value.enabledScenariosCount !== 'number' ||
    !Number.isInteger(value.enabledScenariosCount) ||
    typeof value.commentsEnabled !== 'boolean' ||
    typeof value.postSuggestionsEnabled !== 'boolean' ||
    typeof value.commentsModerationEnabled !== 'boolean'
  ) {
    throw new Error('Invalid channel overview');
  }

  return {
    enabledScenariosCount: value.enabledScenariosCount,
    commentsEnabled: value.commentsEnabled,
    postSuggestionsEnabled: value.postSuggestionsEnabled,
    commentsModerationEnabled: value.commentsModerationEnabled,
  };
}

function parseFavoriteTypes(value: unknown): ManagedEntityFavoriteType[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<ManagedEntityFavoriteType>();
  const favoriteTypes: ManagedEntityFavoriteType[] = [];
  for (const item of value) {
    if (
      item !== 'important' &&
      item !== 'watch' &&
      item !== 'broadcast' &&
      item !== 'test' &&
      item !== 'partner' &&
      item !== 'service'
    ) {
      continue;
    }

    if (seen.has(item)) {
      continue;
    }

    seen.add(item);
    favoriteTypes.push(item);
  }

  return favoriteTypes;
}

function parseBotCapabilities(value: unknown): ManagedEntityBotCapability[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is ManagedEntityBotCapability =>
      item === 'background_scans' ||
      item === 'channel_stats' ||
      item === 'suggestion_delivery' ||
      item === 'membership_prewarm' ||
      item === 'access_prewarm',
  );
}

function parseBotPermissionsSummary(
  value: unknown,
): ManagedEntityAssignedBot['permissionsSummary'] {
  if (value === null || value === undefined) {
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  return {
    checkedAt: typeof value.checkedAt === 'string' ? value.checkedAt : null,
    isAdmin: value.isAdmin === true,
    isOwner: value.isOwner === true,
    permissions: Array.isArray(value.permissions)
      ? value.permissions.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

function parseAssignedBot(value: unknown): ManagedEntityAssignedBot {
  if (!isRecord(value) || typeof value.botId !== 'string' || typeof value.label !== 'string') {
    throw new Error('Invalid assigned bot');
  }

  return {
    botId: value.botId,
    label: value.label,
    role: value.role === 'standby' ? 'standby' : 'primary',
    membershipStatus: value.membershipStatus === 'removed' ? 'removed' : 'active',
    lifecycleState:
      value.lifecycleState === 'dormant' ||
      value.lifecycleState === 'draining' ||
      value.lifecycleState === 'disabled'
        ? value.lifecycleState
        : 'active',
    speechPersona:
      value.speechPersona === 'female' || value.speechPersona === 'neutral'
        ? value.speechPersona
        : 'male',
    characterName: typeof value.characterName === 'string' ? value.characterName : null,
    avatarUrl: typeof value.avatarUrl === 'string' ? value.avatarUrl.trim() || null : null,
    capabilities: parseBotCapabilities(value.capabilities),
    permissionsSummary: parseBotPermissionsSummary(value.permissionsSummary),
  };
}

function parseAssignedBots(value: unknown): ManagedEntityAssignedBot[] {
  return Array.isArray(value) ? value.map(parseAssignedBot) : [];
}

function parseChatSummary(value: unknown): ChatSummary {
  if (!isRecord(value)) {
    throw new Error('Invalid chat summary');
  }

  const entityType = value.entityType === 'channel' ? 'channel' : 'chat';
  const link = typeof value.link === 'string' ? value.link.trim() || null : null;
  const avatarUrl = typeof value.avatarUrl === 'string' ? value.avatarUrl.trim() || null : null;
  const botCount =
    typeof value.botCount === 'number' && Number.isInteger(value.botCount) && value.botCount >= 0
      ? value.botCount
      : undefined;

  if (
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.createdAt !== 'string'
  ) {
    throw new Error('Invalid chat summary');
  }

  const favoriteTypes = parseFavoriteTypes(value.favoriteTypes);
  const assignedBots = parseAssignedBots(value.assignedBots);
  return {
    id: value.id,
    title: value.title,
    createdAt: value.createdAt,
    entityType,
    link,
    avatarUrl,
    channelOverview: parseChannelOverview(value.channelOverview),
    primaryBotId: typeof value.primaryBotId === 'string' ? value.primaryBotId : null,
    assignedBots,
    sharedMode:
      value.sharedMode === 'shared-standby' ||
      value.sharedMode === 'shared-assist' ||
      value.sharedMode === 'shared-failover'
        ? value.sharedMode
        : 'owned',
    ...(botCount !== undefined ? { botCount } : {}),
    ...(value.hasSharedAutomation === true ? { hasSharedAutomation: true } : {}),
    ...(favoriteTypes.length > 0 ? { favoriteTypes } : {}),
  };
}

function parseMe(value: unknown): Me {
  if (!isRecord(value) || typeof value.userId !== 'string') {
    throw new Error('Invalid me response');
  }

  return {
    userId: value.userId,
    username: typeof value.username === 'string' ? value.username : null,
    displayName: typeof value.displayName === 'string' ? value.displayName : null,
    avatarUrl: typeof value.avatarUrl === 'string' ? value.avatarUrl : null,
    profileUrl: typeof value.profileUrl === 'string' ? value.profileUrl : null,
    profileHandoffUrl: typeof value.profileHandoffUrl === 'string' ? value.profileHandoffUrl : null,
    ...(value.canAccessSystem === true ? { canAccessSystem: true } : {}),
  };
}

function parseManagedEntitiesResponseSnapshot(
  value: unknown,
): ManagedEntitiesResponseSnapshot | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (!isRecord(value)) {
    throw new Error('Invalid managed entities snapshot metadata');
  }

  if (typeof value.version !== 'string' || typeof value.builtAt !== 'string') {
    throw new Error('Invalid managed entities snapshot metadata');
  }

  const version = value.version.trim();
  const builtAt = value.builtAt.trim();
  if (version.length === 0 || builtAt.length === 0) {
    throw new Error('Invalid managed entities snapshot metadata');
  }

  return {
    version,
    builtAt,
    lastSyncedAt:
      typeof value.lastSyncedAt === 'string' && value.lastSyncedAt.trim().length > 0
        ? value.lastSyncedAt.trim()
        : null,
    source:
      value.source === 'live_discovery' ||
      value.source === 'allowlist_cache' ||
      value.source === 'last_success_fallback'
        ? value.source
        : 'published_snapshot',
    stale: value.stale === true,
  };
}

function parseManagedEntitiesResponseDiff(value: unknown): ManagedEntitiesResponseDiff | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (!isRecord(value) || typeof value.mode !== 'string') {
    throw new Error('Invalid managed entities diff metadata');
  }

  if (typeof value.baseVersion !== 'string' || typeof value.nextVersion !== 'string') {
    throw new Error('Invalid managed entities diff metadata');
  }

  const baseVersion = value.baseVersion.trim();
  const nextVersion = value.nextVersion.trim();
  if (baseVersion.length === 0 || nextVersion.length === 0) {
    throw new Error('Invalid managed entities diff metadata');
  }

  if (value.mode === 'noop') {
    return {
      mode: 'noop',
      baseVersion,
      nextVersion,
    };
  }

  if (
    value.mode === 'patch' &&
    Array.isArray(value.added) &&
    Array.isArray(value.updated) &&
    Array.isArray(value.removedIds) &&
    Array.isArray(value.orderedIds)
  ) {
    return {
      mode: 'patch',
      baseVersion,
      nextVersion,
      added: value.added.map((item) => parseChatSummary(item)),
      updated: value.updated.map((item) => parseChatSummary(item)),
      removedIds: value.removedIds.map((item) => {
        if (typeof item !== 'string' || item.trim().length === 0) {
          throw new Error('Invalid managed entities diff metadata');
        }

        return item.trim();
      }),
      orderedIds: value.orderedIds.map((item) => {
        if (typeof item !== 'string' || item.trim().length === 0) {
          throw new Error('Invalid managed entities diff metadata');
        }

        return item.trim();
      }),
    };
  }

  throw new Error('Invalid managed entities diff metadata');
}

function parseManagedEntitiesListResponse(value: unknown): ManagedEntitiesListResponse {
  if (!isRecord(value) || !Array.isArray(value.items) || !isRecord(value.refresh)) {
    throw new Error('Invalid managed entities response');
  }

  const { refresh } = value;
  const manualRefreshBlockedReason =
    refresh.manualRefreshBlockedReason === 'in_progress' ||
    refresh.manualRefreshBlockedReason === 'recent_sync' ||
    refresh.manualRefreshBlockedReason === 'backoff'
      ? refresh.manualRefreshBlockedReason
      : null;
  const manualRefreshRetryAfterMs =
    typeof refresh.manualRefreshRetryAfterMs === 'number' && refresh.manualRefreshRetryAfterMs >= 0
      ? Math.trunc(refresh.manualRefreshRetryAfterMs)
      : null;
  if (
    typeof refresh.complete !== 'boolean' ||
    typeof refresh.backoffActive !== 'boolean' ||
    (refresh.cursor !== null &&
      (typeof refresh.cursor !== 'number' || !Number.isInteger(refresh.cursor))) ||
    (refresh.nextPollAfterMs !== undefined &&
      (typeof refresh.nextPollAfterMs !== 'number' ||
        !Number.isInteger(refresh.nextPollAfterMs) ||
        refresh.nextPollAfterMs < 0))
  ) {
    throw new Error('Invalid managed entities refresh state');
  }

  return {
    items: value.items.map((item) => parseChatSummary(item)),
    refresh: {
      complete: refresh.complete,
      cursor: refresh.cursor,
      backoffActive: refresh.backoffActive,
      userVisibleComplete: refresh.userVisibleComplete === true,
      nextPollAfterMs: refresh.nextPollAfterMs ?? 1500,
      processedCandidates:
        typeof refresh.processedCandidates === 'number' &&
        Number.isInteger(refresh.processedCandidates) &&
        refresh.processedCandidates >= 0
          ? refresh.processedCandidates
          : null,
      totalCandidates:
        typeof refresh.totalCandidates === 'number' &&
        Number.isInteger(refresh.totalCandidates) &&
        refresh.totalCandidates >= 0
          ? refresh.totalCandidates
          : null,
      progressPercent:
        typeof refresh.progressPercent === 'number' &&
        Number.isInteger(refresh.progressPercent) &&
        refresh.progressPercent >= 0 &&
        refresh.progressPercent <= 100
          ? refresh.progressPercent
          : null,
      lastSyncedAt: typeof refresh.lastSyncedAt === 'string' ? refresh.lastSyncedAt : null,
      manualRefreshBlockedReason,
      manualRefreshRetryAfterMs,
    },
    ...(value.snapshot !== undefined
      ? {
          snapshot: parseManagedEntitiesResponseSnapshot(value.snapshot),
        }
      : {}),
    ...(value.diff !== undefined
      ? {
          diff: parseManagedEntitiesResponseDiff(value.diff),
        }
      : {}),
  };
}

function buildManagedEntitiesPath(
  entityType: 'chat' | 'channel',
  options: ManagedEntitiesFetchOptions,
): string {
  const query = new URLSearchParams();
  if (options.refresh) {
    query.set('refresh', '1');
  }
  if (options.fresh) {
    query.set('fresh', '1');
  }
  if (options.includeRefreshState) {
    query.set('includeRefreshState', '1');
  }
  if (options.bypassRemoteCache) {
    query.set('bypassCache', '1');
  }
  if (options.resetRefreshCursor) {
    query.set('resetCursor', '1');
  }
  if (typeof options.sinceVersion === 'string' && options.sinceVersion.trim().length > 0) {
    query.set('sinceVersion', options.sinceVersion.trim());
  }

  const basePath = entityType === 'chat' ? '/chats' : '/channels';
  return query.size > 0 ? `${basePath}?${query.toString()}` : basePath;
}

export async function getMe(
  api: ApiTransport,
  options: { chatId?: string; entityType?: 'chat' | 'channel'; signal?: AbortSignal } = {},
): Promise<Me> {
  const query = new URLSearchParams();
  if (options.chatId?.trim()) {
    query.set('chatId', options.chatId.trim());
  }
  if (options.entityType) {
    query.set('entityType', options.entityType);
  }

  const response = await api.request(`/me${query.size > 0 ? `?${query.toString()}` : ''}`, {
    signal: options.signal,
  });
  return parseMe(response);
}

export async function getChats(api: ApiTransport): Promise<ChatSummary[]>;
export async function getChats(
  api: ApiTransport,
  options: ManagedEntitiesFetchOptions & { includeRefreshState: true },
): Promise<ManagedEntitiesListResponse>;
export async function getChats(
  api: ApiTransport,
  options: ManagedEntitiesFetchOptions,
): Promise<ChatSummary[]>;
export async function getChats(
  api: ApiTransport,
  options?: ManagedEntitiesFetchOptions,
): Promise<ChatSummary[] | ManagedEntitiesListResponse> {
  const response = await api.request(buildManagedEntitiesPath('chat', options ?? {}));
  if (options?.includeRefreshState) {
    return parseManagedEntitiesListResponse(response);
  }

  if (!Array.isArray(response)) {
    throw new Error('Invalid chats response');
  }

  return response.map((item) => parseChatSummary(item));
}

export async function getChannels(api: ApiTransport): Promise<ChatSummary[]>;
export async function getChannels(
  api: ApiTransport,
  options: ManagedEntitiesFetchOptions & { includeRefreshState: true },
): Promise<ManagedEntitiesListResponse>;
export async function getChannels(
  api: ApiTransport,
  options: ManagedEntitiesFetchOptions,
): Promise<ChatSummary[]>;
export async function getChannels(
  api: ApiTransport,
  options?: ManagedEntitiesFetchOptions,
): Promise<ChatSummary[] | ManagedEntitiesListResponse> {
  const response = await api.request(buildManagedEntitiesPath('channel', options ?? {}));
  if (options?.includeRefreshState) {
    return parseManagedEntitiesListResponse(response);
  }

  if (!Array.isArray(response)) {
    throw new Error('Invalid channels response');
  }

  return response.map((item) => parseChatSummary(item));
}
