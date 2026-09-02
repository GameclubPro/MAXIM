import {
  archivePublisherAutoReplyRequestSchema,
  archivePublisherAutoReplyResponseSchema,
  createPublisherAutoReplyV2RequestSchema,
  createPublisherAutoReplyAuthoringSessionRequestSchema,
  publisherAutoReplyAuthoringSessionCurrentResponseSchema,
  publisherAutoReplyAuthoringSessionResponseSchema,
  publisherAutoReplyListResponseV2Schema,
  publisherAutoReplyPreviewRequestSchema,
  publisherAutoReplyPreviewResponseSchema,
  publisherAutoReplyRuleV2Schema,
  updatePublisherAutoReplyV2RequestSchema,
  type ArchivePublisherAutoReplyRequest,
  type ArchivePublisherAutoReplyResponse,
  type CreatePublisherAutoReplyV2Request,
  type CreatePublisherAutoReplyAuthoringSessionRequest,
  type PublisherAutoReplyListResponseV2,
  type PublisherAutoReplyPreviewRequest,
  type PublisherAutoReplyPreviewResponse,
  type PublisherAutoReplyRuleV2,
  type PublisherAutoReplyAuthoringSessionCurrentResponse,
  type PublisherAutoReplyAuthoringSessionResponse,
  type UpdatePublisherAutoReplyV2Request,
} from '@maxim/contracts/publisher-auto-replies';
import type { ApiTransport } from './transport';

function buildAutoRepliesPath(chatId: string): string {
  return `/publisher/entities/chat/${encodeURIComponent(chatId)}/auto-replies`;
}

function buildAutoReplyPath(chatId: string, ruleId: string): string {
  return `${buildAutoRepliesPath(chatId)}/${encodeURIComponent(ruleId)}`;
}

function withPublisherAutoReplyContractV2(path: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}contractVersion=2`;
}

export function createPublisherAutoReplyRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/gu, '');
  }

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  throw new Error('Не удалось создать идентификатор запроса. Перезапустите мини-приложение.');
}

export async function listPublisherAutoReplies(
  api: ApiTransport,
  chatId: string,
  options: { signal?: AbortSignal } = {},
): Promise<PublisherAutoReplyListResponseV2> {
  const response = await api.request(
    withPublisherAutoReplyContractV2(buildAutoRepliesPath(chatId)),
    { signal: options.signal },
  );
  return publisherAutoReplyListResponseV2Schema.parse(response);
}

export async function getPublisherAutoReply(
  api: ApiTransport,
  chatId: string,
  ruleId: string,
  options: { signal?: AbortSignal } = {},
): Promise<PublisherAutoReplyRuleV2> {
  const response = await api.request(
    withPublisherAutoReplyContractV2(buildAutoReplyPath(chatId, ruleId)),
    { signal: options.signal },
  );
  return publisherAutoReplyRuleV2Schema.parse(response);
}

export async function createPublisherAutoReply(
  api: ApiTransport,
  chatId: string,
  payload: CreatePublisherAutoReplyV2Request,
): Promise<PublisherAutoReplyRuleV2> {
  const body = createPublisherAutoReplyV2RequestSchema.parse(payload);
  const response = await api.request(
    withPublisherAutoReplyContractV2(buildAutoRepliesPath(chatId)),
    {
      method: 'POST',
      body: JSON.stringify(body),
      retryMutationOnTransportError: false,
    },
  );
  return publisherAutoReplyRuleV2Schema.parse(response);
}

export async function updatePublisherAutoReply(
  api: ApiTransport,
  chatId: string,
  ruleId: string,
  payload: UpdatePublisherAutoReplyV2Request,
): Promise<PublisherAutoReplyRuleV2> {
  const body = updatePublisherAutoReplyV2RequestSchema.parse(payload);
  const response = await api.request(
    withPublisherAutoReplyContractV2(buildAutoReplyPath(chatId, ruleId)),
    {
      method: 'PATCH',
      body: JSON.stringify(body),
      retryMutationOnTransportError: false,
    },
  );
  return publisherAutoReplyRuleV2Schema.parse(response);
}

export async function previewPublisherAutoReplyMatch(
  api: ApiTransport,
  chatId: string,
  payload: PublisherAutoReplyPreviewRequest,
  options: { signal?: AbortSignal } = {},
): Promise<PublisherAutoReplyPreviewResponse> {
  const body = publisherAutoReplyPreviewRequestSchema.parse(payload);
  const response = await api.request(
    withPublisherAutoReplyContractV2(`${buildAutoRepliesPath(chatId)}/match-preview`),
    {
      method: 'POST',
      body: JSON.stringify(body),
      retryMutationOnTransportError: false,
      signal: options.signal,
    },
  );
  return publisherAutoReplyPreviewResponseSchema.parse(response);
}

export async function archivePublisherAutoReply(
  api: ApiTransport,
  chatId: string,
  ruleId: string,
  payload: ArchivePublisherAutoReplyRequest,
): Promise<ArchivePublisherAutoReplyResponse> {
  const body = archivePublisherAutoReplyRequestSchema.parse(payload);
  const response = await api.request(buildAutoReplyPath(chatId, ruleId), {
    method: 'DELETE',
    body: JSON.stringify(body),
    retryMutationOnTransportError: false,
  });
  return archivePublisherAutoReplyResponseSchema.parse(response);
}

export async function getPublisherAutoReplyAsset(
  api: ApiTransport,
  chatId: string,
  ruleId: string,
  assetId: string,
  options: { signal?: AbortSignal } = {},
): Promise<Blob> {
  const response = await api.request(
    withPublisherAutoReplyContractV2(
      `${buildAutoReplyPath(chatId, ruleId)}/assets/${encodeURIComponent(assetId)}`,
    ),
    { signal: options.signal, responseType: 'blob' },
  );
  if (!(response instanceof Blob) || !response.type.toLowerCase().startsWith('image/')) {
    throw new Error('Сервер вернул неверный формат изображения.');
  }
  return response;
}

export async function createPublisherAutoReplyAuthoringSession(
  api: ApiTransport,
  chatId: string,
  payload: CreatePublisherAutoReplyAuthoringSessionRequest,
): Promise<PublisherAutoReplyAuthoringSessionResponse> {
  const body = createPublisherAutoReplyAuthoringSessionRequestSchema.parse(payload);
  const response = await api.request(`${buildAutoRepliesPath(chatId)}/authoring-sessions`, {
    method: 'POST',
    body: JSON.stringify(body),
    retryMutationOnTransportError: false,
  });
  return publisherAutoReplyAuthoringSessionResponseSchema.parse(response);
}

export async function getCurrentPublisherAutoReplyAuthoringSession(
  api: ApiTransport,
  chatId: string,
  options: { signal?: AbortSignal } = {},
): Promise<PublisherAutoReplyAuthoringSessionCurrentResponse> {
  const response = await api.request(`${buildAutoRepliesPath(chatId)}/authoring-sessions/current`, {
    signal: options.signal,
  });
  return publisherAutoReplyAuthoringSessionCurrentResponseSchema.parse(response);
}

export async function cancelCurrentPublisherAutoReplyAuthoringSession(
  api: ApiTransport,
  chatId: string,
): Promise<PublisherAutoReplyAuthoringSessionCurrentResponse> {
  const response = await api.request(`${buildAutoRepliesPath(chatId)}/authoring-sessions/current`, {
    method: 'DELETE',
    retryMutationOnTransportError: false,
  });
  return publisherAutoReplyAuthoringSessionCurrentResponseSchema.parse(response);
}
