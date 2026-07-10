import {
  createManagedPollRequestSchema,
  managedPollDetailsSchema,
  managedPollListResponseSchema,
  managedPollVotersResponseSchema,
  updateManagedPollRequestSchema,
  type CreateManagedPollRequest,
  type ManagedPollDetails,
  type ManagedPollListResponse,
  type ManagedPollVotersResponse,
  type UpdateManagedPollRequest,
} from '@maxim/contracts/poll';
import type { ApiTransport } from './transport';

export const MANAGED_POLL_MUTATION_TIMEOUT_MS = 10 * 60_000;

function resolveChannelPollsBase(channelId: string): string {
  return `/channels/${encodeURIComponent(channelId)}/polls`;
}

export async function getChannelManagedPolls(
  api: ApiTransport,
  channelId: string,
  options: { cursor?: string | null; limit?: number; signal?: AbortSignal } = {},
): Promise<ManagedPollListResponse> {
  const params = new URLSearchParams();
  if (options.cursor) {
    params.set('cursor', options.cursor);
  }
  if (options.limit) {
    params.set('limit', String(options.limit));
  }
  const query = params.size > 0 ? `?${params.toString()}` : '';
  const response = await api.request(`${resolveChannelPollsBase(channelId)}${query}`, {
    signal: options.signal,
  });
  return managedPollListResponseSchema.parse(response);
}

export async function createChannelManagedPoll(
  api: ApiTransport,
  channelId: string,
  payload: CreateManagedPollRequest,
): Promise<ManagedPollDetails> {
  const requestBody = createManagedPollRequestSchema.parse(payload);
  const response = await api.request(resolveChannelPollsBase(channelId), {
    method: 'POST',
    body: JSON.stringify(requestBody),
    timeoutMs: MANAGED_POLL_MUTATION_TIMEOUT_MS,
  });
  return managedPollDetailsSchema.parse(response);
}

export async function getChannelManagedPoll(
  api: ApiTransport,
  channelId: string,
  pollId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ManagedPollDetails> {
  const response = await api.request(
    `${resolveChannelPollsBase(channelId)}/${encodeURIComponent(pollId)}`,
    { signal: options.signal },
  );
  return managedPollDetailsSchema.parse(response);
}

export async function updateChannelManagedPoll(
  api: ApiTransport,
  channelId: string,
  pollId: string,
  payload: UpdateManagedPollRequest,
): Promise<ManagedPollDetails> {
  const requestBody = updateManagedPollRequestSchema.parse(payload);
  const response = await api.request(
    `${resolveChannelPollsBase(channelId)}/${encodeURIComponent(pollId)}`,
    {
      method: 'PUT',
      body: JSON.stringify(requestBody),
      timeoutMs: MANAGED_POLL_MUTATION_TIMEOUT_MS,
    },
  );
  return managedPollDetailsSchema.parse(response);
}

export async function publishChannelManagedPoll(
  api: ApiTransport,
  channelId: string,
  pollId: string,
): Promise<ManagedPollDetails> {
  const response = await api.request(
    `${resolveChannelPollsBase(channelId)}/${encodeURIComponent(pollId)}/publish`,
    { method: 'POST', timeoutMs: MANAGED_POLL_MUTATION_TIMEOUT_MS },
  );
  return managedPollDetailsSchema.parse(response);
}

export async function closeChannelManagedPoll(
  api: ApiTransport,
  channelId: string,
  pollId: string,
): Promise<ManagedPollDetails> {
  const response = await api.request(
    `${resolveChannelPollsBase(channelId)}/${encodeURIComponent(pollId)}/close`,
    { method: 'POST' },
  );
  return managedPollDetailsSchema.parse(response);
}

export async function refreshChannelManagedPollPublication(
  api: ApiTransport,
  channelId: string,
  pollId: string,
): Promise<ManagedPollDetails> {
  const response = await api.request(
    `${resolveChannelPollsBase(channelId)}/${encodeURIComponent(pollId)}/refresh`,
    { method: 'POST' },
  );
  return managedPollDetailsSchema.parse(response);
}

export async function resetChannelManagedPollPublication(
  api: ApiTransport,
  channelId: string,
  pollId: string,
): Promise<ManagedPollDetails> {
  const response = await api.request(
    `${resolveChannelPollsBase(channelId)}/${encodeURIComponent(pollId)}/reset-publication`,
    { method: 'POST' },
  );
  return managedPollDetailsSchema.parse(response);
}

export async function deleteChannelManagedPoll(
  api: ApiTransport,
  channelId: string,
  pollId: string,
): Promise<void> {
  await api.request(`${resolveChannelPollsBase(channelId)}/${encodeURIComponent(pollId)}`, {
    method: 'DELETE',
  });
}

export async function getChannelManagedPollVoters(
  api: ApiTransport,
  channelId: string,
  pollId: string,
  options: { cursor?: string | null; limit?: number; signal?: AbortSignal } = {},
): Promise<ManagedPollVotersResponse> {
  const params = new URLSearchParams();
  if (options.cursor) {
    params.set('cursor', options.cursor);
  }
  if (options.limit) {
    params.set('limit', String(options.limit));
  }
  const query = params.size > 0 ? `?${params.toString()}` : '';
  const response = await api.request(
    `${resolveChannelPollsBase(channelId)}/${encodeURIComponent(pollId)}/voters${query}`,
    { signal: options.signal },
  );
  return managedPollVotersResponseSchema.parse(response);
}
