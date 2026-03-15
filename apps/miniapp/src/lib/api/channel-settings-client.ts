import {
  broadcastHandoffRequestSchema,
  broadcastHandoffResponseSchema,
  channelSettingsSchema,
  channelSettingsScreenResponseSchema,
  managedEntityHeaderSchema,
  managedPollSchema,
  publishChannelEngagementRequestSchema,
  publishChannelEngagementResultSchema,
  updateManagedPollRequestSchema,
  type ChannelSettings,
  type ChannelSettingsScreenResponse,
  type ManagedEntityHeader,
  type ManagedPoll,
  type PublishChannelEngagementRequest,
  type PublishChannelEngagementResult,
} from '@maxim/contracts';
import type { BroadcastHandoffPayload } from './shared-types';
import type { ApiTransport } from './transport';

export async function getChannelHeader(
  api: ApiTransport,
  chatId: string,
): Promise<ManagedEntityHeader> {
  const response = await api.request(`/channels/${chatId}/header`);
  return managedEntityHeaderSchema.parse(response);
}

export async function getChannelSettings(
  api: ApiTransport,
  chatId: string,
): Promise<ChannelSettings> {
  const response = await api.request(`/channels/${chatId}/settings`);
  return channelSettingsSchema.parse(response);
}

export async function getChannelSettingsScreen(
  api: ApiTransport,
  chatId: string,
): Promise<ChannelSettingsScreenResponse> {
  const response = await api.request(`/channels/${chatId}/settings-screen`);
  return channelSettingsScreenResponseSchema.parse(response);
}

export async function updateChannelSettings(
  api: ApiTransport,
  chatId: string,
  data: ChannelSettings,
): Promise<ChannelSettings> {
  const response = await api.request(`/channels/${chatId}/settings`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  return channelSettingsSchema.parse(response);
}

export async function handoffChannelBroadcast(
  api: ApiTransport,
  chatId: string,
  payload: BroadcastHandoffPayload,
) {
  const requestBody = broadcastHandoffRequestSchema.parse(payload);
  const response = await api.request(`/channels/${chatId}/broadcast/handoff`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return broadcastHandoffResponseSchema.parse(response);
}

export async function publishChannelEngagement(
  api: ApiTransport,
  chatId: string,
  payload: PublishChannelEngagementRequest,
): Promise<PublishChannelEngagementResult> {
  const requestBody = publishChannelEngagementRequestSchema.parse(payload);
  const response = await api.request(`/channels/${chatId}/engagement-publish`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return publishChannelEngagementResultSchema.parse(response);
}

export async function getChannelPoll(api: ApiTransport, chatId: string): Promise<ManagedPoll> {
  const response = await api.request(`/channels/${chatId}/poll`);
  return managedPollSchema.parse(response);
}

export async function updateChannelPoll(
  api: ApiTransport,
  chatId: string,
  payload: { question: string; options: string[] },
): Promise<ManagedPoll> {
  const requestBody = updateManagedPollRequestSchema.parse(payload);
  const response = await api.request(`/channels/${chatId}/poll`, {
    method: 'PUT',
    body: JSON.stringify(requestBody),
  });
  return managedPollSchema.parse(response);
}

export async function publishChannelPoll(api: ApiTransport, chatId: string): Promise<ManagedPoll> {
  const response = await api.request(`/channels/${chatId}/poll/publish`, {
    method: 'POST',
  });
  return managedPollSchema.parse(response);
}

export async function closeChannelPoll(api: ApiTransport, chatId: string): Promise<ManagedPoll> {
  const response = await api.request(`/channels/${chatId}/poll/close`, {
    method: 'POST',
  });
  return managedPollSchema.parse(response);
}
