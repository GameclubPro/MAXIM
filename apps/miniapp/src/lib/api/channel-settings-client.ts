import {
  broadcastHandoffRequestSchema,
  broadcastHandoffResponseSchema,
  broadcastHandoffStateSchema,
  channelSettingsSchema,
  channelSettingsScreenResponseSchema,
  managedEntityBotExecutionPlanSchema,
  managedBroadcastCalendarResponseSchema,
  managedBroadcastDetailsSchema,
  managedBroadcastSummarySchema,
  managedEntityHeaderSchema,
  managedPollSchema,
  promoteManagedEntityStandbyRequestSchema,
  publishChannelEngagementRequestSchema,
  publishChannelEngagementResultSchema,
  sendBroadcastResultSchema,
  updateManagedEntityPartnerAssistRequestSchema,
  updateManagedEntityPrimaryBotRequestSchema,
  updateManagedPollRequestSchema,
  addVkParsingSourceRequestSchema,
  publishVkParsingPostRequestSchema,
  publishVkParsingPostResultSchema,
  sendBroadcastRequestSchema,
  vkParsingFeedSchema,
  vkParsingRefreshResultSchema,
  type BroadcastHandoffState,
  type ChannelSettings,
  type ChannelSettingsScreenResponse,
  type ManagedBroadcastCalendarResponse,
  type ManagedBroadcastDetails,
  type ManagedBroadcastSummary,
  type ManagedEntityBotExecutionPlan,
  type ManagedEntityHeader,
  type ManagedPoll,
  type PublishVkParsingPostRequest,
  type PublishVkParsingPostResult,
  type PublishChannelEngagementRequest,
  type PublishChannelEngagementResult,
  type VkParsingFeed,
  type VkParsingRefreshResult,
} from '@maxim/contracts';
import type { BroadcastHandoffPayload, SendBroadcastPayload } from './shared-types';
import type { ApiTransport } from './transport';

export async function getChannelHeader(
  api: ApiTransport,
  chatId: string,
): Promise<ManagedEntityHeader> {
  const response = await api.request(`/channels/${chatId}/header`);
  return managedEntityHeaderSchema.parse(response);
}

export async function getChannelBotExecutionPlan(
  api: ApiTransport,
  chatId: string,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<ManagedEntityBotExecutionPlan> {
  const query = options.refresh ? '?refresh=1' : '';
  const response = await api.request(`/channels/${chatId}/bots/plan${query}`, {
    signal: options.signal,
  });
  return managedEntityBotExecutionPlanSchema.parse(response);
}

export async function updateChannelPrimaryBot(
  api: ApiTransport,
  chatId: string,
  botId: string,
): Promise<ManagedEntityBotExecutionPlan> {
  const requestBody = updateManagedEntityPrimaryBotRequestSchema.parse({ botId });
  const response = await api.request(`/channels/${chatId}/bots/primary`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return managedEntityBotExecutionPlanSchema.parse(response);
}

export async function updateChannelPartnerAssist(
  api: ApiTransport,
  chatId: string,
  payload: { botId: string; enabled: boolean },
): Promise<ManagedEntityBotExecutionPlan> {
  const requestBody = updateManagedEntityPartnerAssistRequestSchema.parse(payload);
  const response = await api.request(`/channels/${chatId}/bots/partner-assist`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return managedEntityBotExecutionPlanSchema.parse(response);
}

export async function promoteChannelStandbyBot(
  api: ApiTransport,
  chatId: string,
  botId?: string,
): Promise<ManagedEntityBotExecutionPlan> {
  const requestBody = promoteManagedEntityStandbyRequestSchema.parse(botId ? { botId } : {});
  const response = await api.request(`/channels/${chatId}/bots/promote-standby`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return managedEntityBotExecutionPlanSchema.parse(response);
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
  request: Pick<RequestInit, 'signal'> = {},
): Promise<ChannelSettingsScreenResponse> {
  const response = await api.request(`/channels/${chatId}/settings-screen`, request);
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

export async function getChannelBroadcastHandoffState(
  api: ApiTransport,
  chatId: string,
): Promise<BroadcastHandoffState> {
  const response = await api.request(`/channels/${chatId}/broadcast/handoff`);
  return broadcastHandoffStateSchema.parse(response);
}

export async function clearChannelBroadcastHandoffState(
  api: ApiTransport,
  chatId: string,
): Promise<BroadcastHandoffState> {
  const response = await api.request(`/channels/${chatId}/broadcast/handoff`, {
    method: 'DELETE',
  });
  return broadcastHandoffStateSchema.parse(response);
}

export async function sendChannelBroadcast(
  api: ApiTransport,
  chatId: string,
  payload: SendBroadcastPayload,
) {
  const requestBody = sendBroadcastRequestSchema.parse(payload);
  const response = await api.request(`/channels/${chatId}/broadcast`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return sendBroadcastResultSchema.parse(response);
}

export async function sendChannelBroadcastTest(
  api: ApiTransport,
  chatId: string,
  payload: SendBroadcastPayload,
): Promise<void> {
  const requestBody = sendBroadcastRequestSchema.parse({
    ...payload,
    targetMode: 'current',
    targetChatIds: [chatId],
    applyToAllChats: false,
    scheduleMode: 'legacy',
    scheduledSlots: [],
    sendAt: null,
    cycleEnabled: false,
    cycleEveryHours: 1,
    cycleCount: 1,
  });
  await api.request(`/channels/${chatId}/broadcast/test`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
}

export async function getChannelManagedBroadcasts(
  api: ApiTransport,
  chatId: string,
): Promise<ManagedBroadcastSummary[]> {
  const response = await api.request(`/channels/${chatId}/broadcasts`);
  if (!Array.isArray(response)) {
    throw new Error('Invalid managed broadcasts response');
  }

  return response.map((item: unknown) => managedBroadcastSummarySchema.parse(item));
}

export async function getChannelManagedBroadcastCalendar(
  api: ApiTransport,
  chatId: string,
  params: { from?: string; to?: string; targetChatIds?: readonly string[] } = {},
): Promise<ManagedBroadcastCalendarResponse> {
  const search = new URLSearchParams();
  if (params.from) {
    search.set('from', params.from);
  }
  if (params.to) {
    search.set('to', params.to);
  }
  if (params.targetChatIds && params.targetChatIds.length > 0) {
    search.set('targetChatIds', params.targetChatIds.join(','));
  }

  const response = await api.request(
    `/channels/${chatId}/broadcast-calendar${search.toString() ? `?${search.toString()}` : ''}`,
  );
  return managedBroadcastCalendarResponseSchema.parse(response);
}

export async function getChannelManagedBroadcast(
  api: ApiTransport,
  chatId: string,
  broadcastId: string,
): Promise<ManagedBroadcastDetails> {
  const response = await api.request(`/channels/${chatId}/broadcasts/${broadcastId}`);
  return managedBroadcastDetailsSchema.parse(response);
}

export async function updateChannelManagedBroadcast(
  api: ApiTransport,
  chatId: string,
  broadcastId: string,
  payload: SendBroadcastPayload,
): Promise<ManagedBroadcastDetails> {
  const requestBody = sendBroadcastRequestSchema.parse(payload);
  const response = await api.request(`/channels/${chatId}/broadcasts/${broadcastId}`, {
    method: 'PUT',
    body: JSON.stringify(requestBody),
  });
  return managedBroadcastDetailsSchema.parse(response);
}

export async function cancelChannelManagedBroadcast(
  api: ApiTransport,
  chatId: string,
  broadcastId: string,
): Promise<ManagedBroadcastDetails> {
  const response = await api.request(`/channels/${chatId}/broadcasts/${broadcastId}`, {
    method: 'DELETE',
  });
  return managedBroadcastDetailsSchema.parse(response);
}

export async function retryChannelManagedBroadcast(
  api: ApiTransport,
  chatId: string,
  broadcastId: string,
): Promise<ManagedBroadcastDetails> {
  const response = await api.request(`/channels/${chatId}/broadcasts/${broadcastId}/retry`, {
    method: 'POST',
  });
  return managedBroadcastDetailsSchema.parse(response);
}

export async function getChannelVkParsing(
  api: ApiTransport,
  chatId: string,
): Promise<VkParsingFeed> {
  const response = await api.request(`/channels/${chatId}/vk-parsing`);
  return vkParsingFeedSchema.parse(response);
}

export async function addChannelVkParsingSource(
  api: ApiTransport,
  chatId: string,
  url: string,
): Promise<VkParsingRefreshResult> {
  const requestBody = addVkParsingSourceRequestSchema.parse({ url });
  const response = await api.request(`/channels/${chatId}/vk-parsing/sources`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return vkParsingRefreshResultSchema.parse(response);
}

export async function removeChannelVkParsingSource(
  api: ApiTransport,
  chatId: string,
  sourceId: string,
): Promise<VkParsingFeed> {
  const response = await api.request(`/channels/${chatId}/vk-parsing/sources/${sourceId}`, {
    method: 'DELETE',
  });
  return vkParsingFeedSchema.parse(response);
}

export async function refreshChannelVkParsing(
  api: ApiTransport,
  chatId: string,
): Promise<VkParsingRefreshResult> {
  const response = await api.request(`/channels/${chatId}/vk-parsing/refresh`, {
    method: 'POST',
  });
  return vkParsingRefreshResultSchema.parse(response);
}

export async function publishChannelVkParsingPost(
  api: ApiTransport,
  chatId: string,
  postId: string,
  payload: PublishVkParsingPostRequest,
): Promise<PublishVkParsingPostResult> {
  const requestBody = publishVkParsingPostRequestSchema.parse(payload);
  const response = await api.request(`/channels/${chatId}/vk-parsing/posts/${postId}/publish`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return publishVkParsingPostResultSchema.parse(response);
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
