import type { ChatSanctionsPage, ChatSanctionsQuery } from '@maxim/contracts';
import type { ApiTransport } from './transport';

export async function getChatSanctions(
  api: ApiTransport,
  chatId: string,
  query: ChatSanctionsQuery,
  signal?: AbortSignal,
): Promise<ChatSanctionsPage> {
  const params = new URLSearchParams({
    status: query.status,
    action: query.action,
    limit: String(query.limit),
  });
  if (query.search) params.set('search', query.search);
  if (query.userId) params.set('userId', query.userId);
  if (query.cursor) params.set('cursor', query.cursor);
  const result = (await api.request(`/chats/${encodeURIComponent(chatId)}/sanctions?${params}`, {
    signal,
  })) as ChatSanctionsPage;
  if (
    !result ||
    !Array.isArray(result.items) ||
    !Number.isFinite(Date.parse(result.serverTime)) ||
    (result.hasMore && (!result.nextCursor || result.nextCursor === query.cursor))
  ) {
    throw new Error('Не удалось продолжить список ограничений. Обновите его.');
  }
  return result;
}
