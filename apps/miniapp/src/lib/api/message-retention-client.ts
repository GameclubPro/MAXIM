import {
  messageRetentionStateSchema,
  updateMessageRetentionSchema,
  type UpdateMessageRetention,
} from '@maxim/contracts/settings';
import type { ApiTransport } from './transport';

export async function getMessageRetention(api: ApiTransport, chatId: string, signal?: AbortSignal) {
  return messageRetentionStateSchema.parse(
    await api.request(`/chats/${encodeURIComponent(chatId)}/message-retention/status`, { signal }),
  );
}

export async function updateMessageRetention(
  api: ApiTransport,
  chatId: string,
  input: UpdateMessageRetention,
) {
  return messageRetentionStateSchema.parse(
    await api.request(`/chats/${encodeURIComponent(chatId)}/message-retention`, {
      method: 'PUT',
      body: JSON.stringify(updateMessageRetentionSchema.parse(input)),
    }),
  );
}
