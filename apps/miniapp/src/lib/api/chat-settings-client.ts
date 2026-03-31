import {
  applySectionToAllResponseSchema,
  broadcastHandoffRequestSchema,
  broadcastHandoffResponseSchema,
  broadcastHandoffStateSchema,
  chatRulesSchema,
  chatSettingsSchema,
  chatSettingsScreenResponseSchema,
  managedEntityBotExecutionPlanSchema,
  domainAllowlistEntrySchema,
  managedBroadcastDetailsSchema,
  managedBroadcastSummarySchema,
  managedEntityHeaderSchema,
  managedPollSchema,
  publishChatRulesResultSchema,
  promoteManagedEntityStandbyRequestSchema,
  resolveRequiredSubscriptionChannelRequestSchema,
  resolveRequiredSubscriptionChannelResponseSchema,
  scheduleDomainRemovalRequestSchema,
  sendBroadcastRequestSchema,
  sendBroadcastResultSchema,
  updateManagedEntityPartnerAssistRequestSchema,
  updateManagedEntityPrimaryBotRequestSchema,
  updateChatRulesRequestSchema,
  updateManagedPollRequestSchema,
  type ApplySectionToAllResponse,
  type AllowlistMatchType,
  type ChatRules,
  type ChatSettings,
  type ChatSettingsScreenResponse,
  type DomainAllowlistEntry,
  type BroadcastHandoffState,
  type ManagedBroadcastDetails,
  type ManagedBroadcastSummary,
  type ManagedEntityBotExecutionPlan,
  type ManagedEntityHeader,
  type ManagedPoll,
  type PublishChatRulesResult,
  type ResolveRequiredSubscriptionChannelResponse,
  type SendBroadcastResult,
} from '@maxim/contracts';
import type {
  BroadcastHandoffPayload,
  SendBroadcastPayload,
  UpdateChatRulesPayload,
} from './shared-types';
import type { ApiTransport } from './transport';

export async function getChatHeader(
  api: ApiTransport,
  chatId: string,
): Promise<ManagedEntityHeader> {
  const response = await api.request(`/chats/${chatId}/header`);
  return managedEntityHeaderSchema.parse(response);
}

export async function getChatBotExecutionPlan(
  api: ApiTransport,
  chatId: string,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<ManagedEntityBotExecutionPlan> {
  const query = options.refresh ? '?refresh=1' : '';
  const response = await api.request(`/chats/${chatId}/bots/plan${query}`, {
    signal: options.signal,
  });
  return managedEntityBotExecutionPlanSchema.parse(response);
}

export async function updateChatPrimaryBot(
  api: ApiTransport,
  chatId: string,
  botId: string,
): Promise<ManagedEntityBotExecutionPlan> {
  const requestBody = updateManagedEntityPrimaryBotRequestSchema.parse({ botId });
  const response = await api.request(`/chats/${chatId}/bots/primary`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return managedEntityBotExecutionPlanSchema.parse(response);
}

export async function updateChatPartnerAssist(
  api: ApiTransport,
  chatId: string,
  payload: { botId: string; enabled: boolean },
): Promise<ManagedEntityBotExecutionPlan> {
  const requestBody = updateManagedEntityPartnerAssistRequestSchema.parse(payload);
  const response = await api.request(`/chats/${chatId}/bots/partner-assist`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return managedEntityBotExecutionPlanSchema.parse(response);
}

export async function promoteChatStandbyBot(
  api: ApiTransport,
  chatId: string,
  botId?: string,
): Promise<ManagedEntityBotExecutionPlan> {
  const requestBody = promoteManagedEntityStandbyRequestSchema.parse(
    botId ? { botId } : {},
  );
  const response = await api.request(`/chats/${chatId}/bots/promote-standby`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return managedEntityBotExecutionPlanSchema.parse(response);
}

export async function getSettings(api: ApiTransport, chatId: string): Promise<ChatSettings> {
  const response = await api.request(`/chats/${chatId}/settings`);
  return chatSettingsSchema.parse(response);
}

export async function getSettingsScreen(
  api: ApiTransport,
  chatId: string,
  request: Pick<RequestInit, 'signal'> = {},
): Promise<ChatSettingsScreenResponse> {
  const response = await api.request(`/chats/${chatId}/settings-screen`, request);
  return chatSettingsScreenResponseSchema.parse(response);
}

export async function resolveRequiredSubscriptionChannel(
  api: ApiTransport,
  chatId: string,
  value: string,
): Promise<ResolveRequiredSubscriptionChannelResponse> {
  const requestBody = resolveRequiredSubscriptionChannelRequestSchema.parse({ value });
  const response = await api.request(`/chats/${chatId}/required-subscription/channels/resolve`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return resolveRequiredSubscriptionChannelResponseSchema.parse(response);
}

export async function updateSettings(
  api: ApiTransport,
  chatId: string,
  data: ChatSettings,
): Promise<ChatSettings> {
  const response = await api.request(`/chats/${chatId}/settings`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  return chatSettingsSchema.parse(response);
}

export async function applySettingsSectionToAll(
  api: ApiTransport,
  chatId: string,
  section: ApplySectionToAllResponse['section'],
): Promise<ApplySectionToAllResponse> {
  const response = await api.request(`/chats/${chatId}/settings/apply-section-to-all`, {
    method: 'POST',
    body: JSON.stringify({ section }),
  });
  return applySectionToAllResponseSchema.parse(response);
}

export async function getRules(api: ApiTransport, chatId: string): Promise<ChatRules> {
  const response = await api.request(`/chats/${chatId}/rules`);
  return chatRulesSchema.parse(response);
}

export async function updateRules(
  api: ApiTransport,
  chatId: string,
  payload: UpdateChatRulesPayload,
): Promise<ChatRules> {
  const requestBody = updateChatRulesRequestSchema.parse(payload);
  const response = await api.request(`/chats/${chatId}/rules`, {
    method: 'PUT',
    body: JSON.stringify(requestBody),
  });
  return chatRulesSchema.parse(response);
}

export async function publishRules(
  api: ApiTransport,
  chatId: string,
): Promise<PublishChatRulesResult> {
  const response = await api.request(`/chats/${chatId}/rules/publish`, {
    method: 'POST',
  });
  return publishChatRulesResultSchema.parse(response);
}

export async function resetPublishedRules(api: ApiTransport, chatId: string): Promise<ChatRules> {
  const response = await api.request(`/chats/${chatId}/rules/publish`, {
    method: 'DELETE',
  });
  return chatRulesSchema.parse(response);
}

export async function getChatPoll(api: ApiTransport, chatId: string): Promise<ManagedPoll> {
  const response = await api.request(`/chats/${chatId}/poll`);
  return managedPollSchema.parse(response);
}

export async function updateChatPoll(
  api: ApiTransport,
  chatId: string,
  payload: { question: string; options: string[] },
): Promise<ManagedPoll> {
  const requestBody = updateManagedPollRequestSchema.parse(payload);
  const response = await api.request(`/chats/${chatId}/poll`, {
    method: 'PUT',
    body: JSON.stringify(requestBody),
  });
  return managedPollSchema.parse(response);
}

export async function publishChatPoll(api: ApiTransport, chatId: string): Promise<ManagedPoll> {
  const response = await api.request(`/chats/${chatId}/poll/publish`, {
    method: 'POST',
  });
  return managedPollSchema.parse(response);
}

export async function closeChatPoll(api: ApiTransport, chatId: string): Promise<ManagedPoll> {
  const response = await api.request(`/chats/${chatId}/poll/close`, {
    method: 'POST',
  });
  return managedPollSchema.parse(response);
}

export async function handoffBroadcast(
  api: ApiTransport,
  chatId: string,
  payload: BroadcastHandoffPayload,
) {
  const requestBody = broadcastHandoffRequestSchema.parse(payload);
  const response = await api.request(`/chats/${chatId}/broadcast/handoff`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return broadcastHandoffResponseSchema.parse(response);
}

export async function getBroadcastHandoffState(
  api: ApiTransport,
  chatId: string,
): Promise<BroadcastHandoffState> {
  const response = await api.request(`/chats/${chatId}/broadcast/handoff`);
  return broadcastHandoffStateSchema.parse(response);
}

export async function handoffRules(api: ApiTransport, chatId: string) {
  const response = await api.request(`/chats/${chatId}/rules/handoff`, {
    method: 'POST',
  });
  return broadcastHandoffResponseSchema.parse(response);
}

export async function getManagedBroadcasts(
  api: ApiTransport,
  chatId: string,
): Promise<ManagedBroadcastSummary[]> {
  const response = await api.request(`/chats/${chatId}/broadcasts`);
  if (!Array.isArray(response)) {
    throw new Error('Invalid managed broadcasts response');
  }

  return response.map((item: unknown) => managedBroadcastSummarySchema.parse(item));
}

export async function getManagedBroadcast(
  api: ApiTransport,
  chatId: string,
  broadcastId: string,
): Promise<ManagedBroadcastDetails> {
  const response = await api.request(`/chats/${chatId}/broadcasts/${broadcastId}`);
  return managedBroadcastDetailsSchema.parse(response);
}

export async function updateManagedBroadcast(
  api: ApiTransport,
  chatId: string,
  broadcastId: string,
  payload: SendBroadcastPayload,
): Promise<ManagedBroadcastDetails> {
  const requestBody = sendBroadcastRequestSchema.parse(payload);
  const response = await api.request(`/chats/${chatId}/broadcasts/${broadcastId}`, {
    method: 'PUT',
    body: JSON.stringify(requestBody),
  });
  return managedBroadcastDetailsSchema.parse(response);
}

export async function cancelManagedBroadcast(
  api: ApiTransport,
  chatId: string,
  broadcastId: string,
): Promise<ManagedBroadcastDetails> {
  const response = await api.request(`/chats/${chatId}/broadcasts/${broadcastId}`, {
    method: 'DELETE',
  });
  return managedBroadcastDetailsSchema.parse(response);
}

export async function retryManagedBroadcast(
  api: ApiTransport,
  chatId: string,
  broadcastId: string,
): Promise<ManagedBroadcastDetails> {
  const response = await api.request(`/chats/${chatId}/broadcasts/${broadcastId}/retry`, {
    method: 'POST',
  });
  return managedBroadcastDetailsSchema.parse(response);
}

export async function getDomainAllowlistDetails(
  api: ApiTransport,
  chatId: string,
): Promise<DomainAllowlistEntry[]> {
  const response = await api.request(`/chats/${chatId}/domain-allowlist/details`);
  if (!Array.isArray(response)) {
    throw new Error('Invalid domain allowlist details response');
  }

  return response.map((item: unknown) => domainAllowlistEntrySchema.parse(item));
}

export async function addDomain(
  api: ApiTransport,
  chatId: string,
  payload: { domain: string; matchType: AllowlistMatchType },
): Promise<void> {
  await api.request(`/chats/${chatId}/domain-allowlist`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function removeDomain(
  api: ApiTransport,
  chatId: string,
  domain: string,
): Promise<void> {
  await api.request(`/chats/${chatId}/domain-allowlist?domain=${encodeURIComponent(domain)}`, {
    method: 'DELETE',
  });
}

export async function scheduleDomainRemoval(
  api: ApiTransport,
  chatId: string,
  domain: string,
  removeAfterAt: string | null,
): Promise<void> {
  const payload = scheduleDomainRemovalRequestSchema.parse({ removeAfterAt });
  await api.request(
    `/chats/${chatId}/domain-allowlist/removal-schedule?domain=${encodeURIComponent(domain)}`,
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    },
  );
}

export async function sendBroadcast(
  api: ApiTransport,
  chatId: string,
  payload: SendBroadcastPayload,
): Promise<SendBroadcastResult> {
  const requestBody = sendBroadcastRequestSchema.parse(payload);
  const response = await api.request(`/chats/${chatId}/broadcast`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return sendBroadcastResultSchema.parse(response);
}
