import type { ChatSummary, Me } from '@maxim/contracts';
import type { ApiTransport } from './transport';

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
  };
}

export async function getMe(api: ApiTransport): Promise<Me> {
  const response = await api.request('/me');
  return parseMe(response);
}

export async function getChats(
  api: ApiTransport,
  options: { refresh?: boolean } = {},
): Promise<ChatSummary[]> {
  const response = await api.request(`/chats${options.refresh ? '?refresh=1' : ''}`);
  if (!Array.isArray(response)) {
    throw new Error('Invalid chats response');
  }

  return response.map(parseChatSummary);
}

export async function getChannels(
  api: ApiTransport,
  options: { refresh?: boolean } = {},
): Promise<ChatSummary[]> {
  const response = await api.request(`/channels${options.refresh ? '?refresh=1' : ''}`);
  if (!Array.isArray(response)) {
    throw new Error('Invalid channels response');
  }

  return response.map(parseChatSummary);
}
