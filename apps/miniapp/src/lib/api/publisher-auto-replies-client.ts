import {
  archivePublisherAutoReplyRequestSchema,
  archivePublisherAutoReplyResponseSchema,
  createPublisherAutoReplyRequestSchema,
  createPublisherAutoReplyAuthoringSessionRequestSchema,
  publisherAutoReplyAuthoringSessionCurrentResponseSchema,
  publisherAutoReplyAuthoringSessionResponseSchema,
  publisherAutoReplyListResponseSchema,
  publisherAutoReplyRuleSchema,
  updatePublisherAutoReplyRequestSchema,
  type ArchivePublisherAutoReplyRequest,
  type ArchivePublisherAutoReplyResponse,
  type CreatePublisherAutoReplyRequest,
  type CreatePublisherAutoReplyAuthoringSessionRequest,
  type PublisherAutoReplyListResponse,
  type PublisherAutoReplyRule,
  type PublisherAutoReplyAuthoringSessionCurrentResponse,
  type PublisherAutoReplyAuthoringSessionResponse,
  type UpdatePublisherAutoReplyRequest,
} from '@maxim/contracts/publisher-auto-replies';
import type { ApiTransport } from './transport';

function buildAutoRepliesPath(chatId: string): string {
  return `/publisher/entities/chat/${encodeURIComponent(chatId)}/auto-replies`;
}

function buildAutoReplyPath(chatId: string, ruleId: string): string {
  return `${buildAutoRepliesPath(chatId)}/${encodeURIComponent(ruleId)}`;
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
): Promise<PublisherAutoReplyListResponse> {
  const response = await api.request(buildAutoRepliesPath(chatId), { signal: options.signal });
  return publisherAutoReplyListResponseSchema.parse(response);
}

export async function createPublisherAutoReply(
  api: ApiTransport,
  chatId: string,
  payload: CreatePublisherAutoReplyRequest,
): Promise<PublisherAutoReplyRule> {
  const body = createPublisherAutoReplyRequestSchema.parse(payload);
  const response = await api.request(buildAutoRepliesPath(chatId), {
    method: 'POST',
    body: JSON.stringify(body),
    retryMutationOnTransportError: false,
  });
  return publisherAutoReplyRuleSchema.parse(response);
}

export async function updatePublisherAutoReply(
  api: ApiTransport,
  chatId: string,
  ruleId: string,
  payload: UpdatePublisherAutoReplyRequest,
): Promise<PublisherAutoReplyRule> {
  const body = updatePublisherAutoReplyRequestSchema.parse(payload);
  const response = await api.request(buildAutoReplyPath(chatId, ruleId), {
    method: 'PATCH',
    body: JSON.stringify(body),
    retryMutationOnTransportError: false,
  });
  return publisherAutoReplyRuleSchema.parse(response);
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
    `${buildAutoReplyPath(chatId, ruleId)}/assets/${encodeURIComponent(assetId)}`,
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
