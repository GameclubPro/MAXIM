import type { Me } from '@maxim/contracts';
import type { ApiTransport } from './transport';

const botDialogUrlCache = new WeakMap<ApiTransport, string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBotDialogUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'max.ru' ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !/^\/[^/?#\s/]+$/u.test(parsed.pathname) ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
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
    botDialogUrl: parseBotDialogUrl(value.botDialogUrl),
    ...(value.canAccessSystem === true ? { canAccessSystem: true } : {}),
  };
}

export function getCachedBotDialogUrl(api: ApiTransport): string | null {
  return botDialogUrlCache.get(api) ?? null;
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
  const me = parseMe(response);
  if (me.botDialogUrl) {
    botDialogUrlCache.set(api, me.botDialogUrl);
  }
  return me;
}
