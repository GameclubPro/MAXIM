import type { ChatSummary, ManagedEntitiesListResponse, Me } from '@maxim/contracts';
import type { ApiTransport } from './transport';

type ManagedEntitiesFetchOptions = {
  refresh?: boolean;
  includeRefreshState?: boolean;
  bypassRemoteCache?: boolean;
  resetRefreshCursor?: boolean;
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

function parseChatSummary(value: unknown): ChatSummary {
  if (!isRecord(value)) {
    throw new Error('Invalid chat summary');
  }

  const entityType = value.entityType === 'channel' ? 'channel' : 'chat';
  const link = typeof value.link === 'string' ? value.link.trim() || null : null;
  const avatarUrl = typeof value.avatarUrl === 'string' ? value.avatarUrl.trim() || null : null;

  if (
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.createdAt !== 'string'
  ) {
    throw new Error('Invalid chat summary');
  }

  return {
    id: value.id,
    title: value.title,
    createdAt: value.createdAt,
    entityType,
    link,
    avatarUrl,
    channelOverview: parseChannelOverview(value.channelOverview),
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
  };
}

function parseManagedEntitiesListResponse(value: unknown): ManagedEntitiesListResponse {
  if (!isRecord(value) || !Array.isArray(value.items) || !isRecord(value.refresh)) {
    throw new Error('Invalid managed entities response');
  }

  const { refresh } = value;
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
      nextPollAfterMs: refresh.nextPollAfterMs ?? 900,
    },
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
  if (options.includeRefreshState) {
    query.set('includeRefreshState', '1');
  }
  if (options.bypassRemoteCache) {
    query.set('bypassCache', '1');
  }
  if (options.resetRefreshCursor) {
    query.set('resetCursor', '1');
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
