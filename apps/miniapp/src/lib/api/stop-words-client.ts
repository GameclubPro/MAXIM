import {
  stopWordsStateSchema,
  stopWordsStatusSchema,
  stopWordsPreviewResponseSchema,
  updateStopWordsRequestSchema,
  stopWordsPreviewRequestSchema,
  type StopWordsPolicy,
} from '@maxim/contracts/settings';
import type { ApiTransport } from './transport';

export async function getStopWords(api: ApiTransport, chatId: string, signal?: AbortSignal) {
  return stopWordsStateSchema.parse(
    await api.request(`/chats/${encodeURIComponent(chatId)}/stop-words`, { signal }),
  );
}

export async function getStopWordsStatus(api: ApiTransport, chatId: string, signal?: AbortSignal) {
  return stopWordsStatusSchema.parse(
    await api.request(`/chats/${encodeURIComponent(chatId)}/stop-words/status`, { signal }),
  );
}

export async function updateStopWords(
  api: ApiTransport,
  chatId: string,
  policy: StopWordsPolicy,
  expectedRevision: number,
) {
  return stopWordsStateSchema.parse(
    await api.request(`/chats/${encodeURIComponent(chatId)}/stop-words`, {
      method: 'PUT',
      body: JSON.stringify(updateStopWordsRequestSchema.parse({ policy, expectedRevision })),
    }),
  );
}

export async function previewStopWords(
  api: ApiTransport,
  chatId: string,
  policy: StopWordsPolicy,
  text: string,
) {
  return stopWordsPreviewResponseSchema.parse(
    await api.request(`/chats/${encodeURIComponent(chatId)}/stop-words/preview`, {
      method: 'POST',
      body: JSON.stringify(
        stopWordsPreviewRequestSchema.parse({
          policy: {
            version: policy.version,
            enabled: policy.enabled,
            rules: policy.rules,
            domains: policy.domains,
          },
          text,
        }),
      ),
    }),
  );
}
