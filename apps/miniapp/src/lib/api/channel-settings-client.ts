import type {
  BroadcastHandoffState,
  ManagedBroadcastCalendarResponse,
  ManagedBroadcastDetails,
  ManagedBroadcastSummary,
  CreateManagedAutopostRuleRequest,
  ManagedAutopostRuleDetails,
  ManagedAutopostRuleSummary,
  SendBroadcastTestResult,
  UpdateManagedAutopostRuleRequest,
  BroadcastHandoffResponse,
  SendBroadcastResult,
} from '@maxim/contracts/broadcast';
import {
  channelPostSignatureSettingsSchema,
  updateChannelPostSignatureRequestSchema,
  type ChannelPostSignatureSettings,
  type UpdateChannelPostSignatureRequest,
} from '@maxim/contracts/channel-post-signature';
import type {
  PublishChannelEngagementRequest,
  PublishChannelEngagementResult,
} from '@maxim/contracts/channel-dialog';
import {
  managedEntityAccessRecheckResponseSchema,
  managedEntityBotExecutionPlanSchema,
  managedEntityHeaderSchema,
  promoteManagedEntityStandbyRequestSchema,
  updateManagedEntityPartnerAssistRequestSchema,
  updateManagedEntityPrimaryBotRequestSchema,
  type ManagedEntityAccessRecheckResponse,
  type ManagedEntityBotExecutionPlan,
  type ManagedEntityHeader,
} from '@maxim/contracts/managed-entities';
import {
  channelSettingsSchema,
  channelSettingsScreenResponseSchema,
  type ChannelSettings,
  type ChannelSettingsScreenResponse,
} from '@maxim/contracts/channel-settings';
import type { BroadcastHandoffPayload, SendBroadcastPayload } from './shared-types';
import type { ApiTransport } from './transport';

export type ChannelBroadcastComposerClientResetState = {
  resetAt: string | null;
};

export { createBroadcastRequestId } from './channel-broadcast-request-id';

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
  request: Pick<RequestInit, 'signal'> & { prefetch?: boolean } = {},
): Promise<ChannelSettingsScreenResponse> {
  const query = request.prefetch === true ? '?prefetch=1' : '';
  const response = await api.request(`/channels/${chatId}/settings-screen${query}`, {
    signal: request.signal,
  });
  return channelSettingsScreenResponseSchema.parse(response);
}

export async function getChannelPostSignature(
  api: ApiTransport,
  chatId: string,
): Promise<ChannelPostSignatureSettings> {
  const response = await api.request(`/channels/${chatId}/post-signature`);
  return channelPostSignatureSettingsSchema.parse(response);
}

export async function updateChannelPostSignature(
  api: ApiTransport,
  chatId: string,
  data: UpdateChannelPostSignatureRequest,
): Promise<ChannelPostSignatureSettings> {
  const requestBody = updateChannelPostSignatureRequestSchema.parse(data);
  const response = await api.request(`/channels/${chatId}/post-signature`, {
    method: 'PATCH',
    body: JSON.stringify(requestBody),
  });
  return channelPostSignatureSettingsSchema.parse(response);
}

export async function recheckChannelManagedEntityAccess(
  api: ApiTransport,
  chatId: string,
): Promise<ManagedEntityAccessRecheckResponse> {
  const response = await api.request(
    `/managed-entities/channel/${encodeURIComponent(chatId)}/access/recheck`,
    {
      method: 'POST',
    },
  );
  return managedEntityAccessRecheckResponseSchema.parse(response);
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
): Promise<BroadcastHandoffResponse> {
  const client = await import('./channel-publishing-client');
  return client.handoffChannelBroadcast(api, chatId, payload);
}

export async function getChannelBroadcastHandoffState(
  api: ApiTransport,
  chatId: string,
): Promise<BroadcastHandoffState> {
  const client = await import('./channel-publishing-client');
  return client.getChannelBroadcastHandoffState(api, chatId);
}

export async function getChannelBroadcastComposerClientResetState(
  api: ApiTransport,
  chatId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ChannelBroadcastComposerClientResetState> {
  const client = await import('./channel-publishing-client');
  return client.getChannelBroadcastComposerClientResetState(api, chatId, options);
}

export async function clearChannelBroadcastHandoffState(
  api: ApiTransport,
  chatId: string,
): Promise<BroadcastHandoffState> {
  const client = await import('./channel-publishing-client');
  return client.clearChannelBroadcastHandoffState(api, chatId);
}

export async function sendChannelBroadcast(
  api: ApiTransport,
  chatId: string,
  payload: SendBroadcastPayload,
): Promise<SendBroadcastResult> {
  const client = await import('./channel-publishing-client');
  return client.sendChannelBroadcast(api, chatId, payload);
}

export async function sendChannelBroadcastTest(
  api: ApiTransport,
  chatId: string,
  payload: SendBroadcastPayload,
): Promise<SendBroadcastTestResult> {
  const client = await import('./channel-publishing-client');
  return client.sendChannelBroadcastTest(api, chatId, payload);
}

export async function getChannelManagedBroadcasts(
  api: ApiTransport,
  chatId: string,
): Promise<ManagedBroadcastSummary[]> {
  const client = await import('./channel-publishing-client');
  return client.getChannelManagedBroadcasts(api, chatId);
}

export async function getChannelManagedBroadcastCalendar(
  api: ApiTransport,
  chatId: string,
  params: {
    from?: string;
    to?: string;
    targetMode?: 'current' | 'selected' | 'all';
    targetChatIds?: readonly string[];
  } = {},
): Promise<ManagedBroadcastCalendarResponse> {
  const client = await import('./channel-publishing-client');
  return client.getChannelManagedBroadcastCalendar(api, chatId, params);
}

export async function getChannelManagedBroadcast(
  api: ApiTransport,
  chatId: string,
  broadcastId: string,
): Promise<ManagedBroadcastDetails> {
  const client = await import('./channel-publishing-client');
  return client.getChannelManagedBroadcast(api, chatId, broadcastId);
}

export async function updateChannelManagedBroadcast(
  api: ApiTransport,
  chatId: string,
  broadcastId: string,
  payload: SendBroadcastPayload,
): Promise<ManagedBroadcastDetails> {
  const client = await import('./channel-publishing-client');
  return client.updateChannelManagedBroadcast(api, chatId, broadcastId, payload);
}

export async function cancelChannelManagedBroadcast(
  api: ApiTransport,
  chatId: string,
  broadcastId: string,
): Promise<ManagedBroadcastDetails> {
  const client = await import('./channel-publishing-client');
  return client.cancelChannelManagedBroadcast(api, chatId, broadcastId);
}

export async function retryChannelManagedBroadcast(
  api: ApiTransport,
  chatId: string,
  broadcastId: string,
): Promise<ManagedBroadcastDetails> {
  const client = await import('./channel-publishing-client');
  return client.retryChannelManagedBroadcast(api, chatId, broadcastId);
}

export async function getChannelManagedAutopostRules(
  api: ApiTransport,
  chatId: string,
): Promise<ManagedAutopostRuleSummary[]> {
  const client = await import('./channel-publishing-client');
  return client.getChannelManagedAutopostRules(api, chatId);
}

export async function getChannelManagedAutopostRule(
  api: ApiTransport,
  chatId: string,
  ruleId: string,
): Promise<ManagedAutopostRuleDetails> {
  const client = await import('./channel-publishing-client');
  return client.getChannelManagedAutopostRule(api, chatId, ruleId);
}

export async function createChannelManagedAutopostRule(
  api: ApiTransport,
  chatId: string,
  payload: CreateManagedAutopostRuleRequest,
): Promise<ManagedAutopostRuleDetails> {
  const client = await import('./channel-publishing-client');
  return client.createChannelManagedAutopostRule(api, chatId, payload);
}

export async function updateChannelManagedAutopostRule(
  api: ApiTransport,
  chatId: string,
  ruleId: string,
  payload: UpdateManagedAutopostRuleRequest,
): Promise<ManagedAutopostRuleDetails> {
  const client = await import('./channel-publishing-client');
  return client.updateChannelManagedAutopostRule(api, chatId, ruleId, payload);
}

export async function deleteChannelManagedAutopostRule(
  api: ApiTransport,
  chatId: string,
  ruleId: string,
): Promise<ManagedAutopostRuleDetails> {
  const client = await import('./channel-publishing-client');
  return client.deleteChannelManagedAutopostRule(api, chatId, ruleId);
}

export async function publishChannelEngagement(
  api: ApiTransport,
  chatId: string,
  payload: PublishChannelEngagementRequest,
): Promise<PublishChannelEngagementResult> {
  const client = await import('./channel-publishing-client');
  return client.publishChannelEngagement(api, chatId, payload);
}
