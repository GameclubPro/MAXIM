import {
  broadcastHandoffRequestSchema,
  broadcastHandoffResponseSchema,
  channelSettingsSchema,
  channelSettingsScreenResponseSchema,
  managedEntityHeaderSchema,
  managedPollSchema,
  publishChannelEngagementRequestSchema,
  publishChannelEngagementResultSchema,
  surfaceEntryRequestSchema,
  surfaceEntryResponseSchema,
  updateManagedPollRequestSchema,
  workbenchSummarySchema,
  type ChannelSettings,
  type ChannelSettingsScreenResponse,
  type ManagedEntityHeader,
  type ManagedPoll,
  type PublishChannelEngagementRequest,
  type PublishChannelEngagementResult,
  type SurfaceEntryRequest,
  type SurfaceEntryResponse,
  type WorkbenchSummary,
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

export async function getChannelWorkbench(
  api: ApiTransport,
  chatId: string,
): Promise<WorkbenchSummary> {
  const response = await api.request(`/channels/${chatId}/workbench`);
  return workbenchSummarySchema.parse(response);
}

export async function openChannelEntrypoint(
  api: ApiTransport,
  chatId: string,
  payload: Omit<SurfaceEntryRequest, 'entityId' | 'entityType'>,
): Promise<SurfaceEntryResponse> {
  const requestBody = surfaceEntryRequestSchema.parse({
    ...payload,
    entityId: chatId,
    entityType: 'channel',
  });
  const response = await api.request(`/channels/${chatId}/entrypoint`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return surfaceEntryResponseSchema.parse(response);
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
