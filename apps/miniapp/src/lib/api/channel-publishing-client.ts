import {
  broadcastHandoffRequestSchema,
  broadcastHandoffResponseSchema,
  broadcastHandoffStateSchema,
  managedBroadcastCalendarResponseSchema,
  managedBroadcastDetailsSchema,
  managedBroadcastSummarySchema,
  createManagedAutopostRuleRequestSchema,
  managedAutopostRuleDetailsSchema,
  managedAutopostRuleSummarySchema,
  updateManagedAutopostRuleRequestSchema,
  sendBroadcastResultSchema,
  sendBroadcastRequestSchema,
  sendBroadcastTestResultSchema,
  type BroadcastHandoffState,
  type ManagedBroadcastCalendarResponse,
  type ManagedBroadcastDetails,
  type ManagedBroadcastSummary,
  type CreateManagedAutopostRuleRequest,
  type ManagedAutopostRuleDetails,
  type ManagedAutopostRuleSummary,
  type SendBroadcastTestResult,
  type UpdateManagedAutopostRuleRequest,
} from '@maxim/contracts/broadcast';

import {
  publishChannelEngagementRequestSchema,
  publishChannelEngagementResultSchema,
  type PublishChannelEngagementRequest,
  type PublishChannelEngagementResult,
} from '@maxim/contracts/channel-dialog';

import type { BroadcastHandoffPayload, SendBroadcastPayload } from './shared-types';

import type { ApiTransport } from './transport';

import type { ChannelBroadcastComposerClientResetState } from './channel-settings-client';

import { createBroadcastRequestId } from './channel-broadcast-request-id';

function parseChannelBroadcastComposerClientResetState(
  response: unknown,
): ChannelBroadcastComposerClientResetState {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return { resetAt: null };
  }

  const resetAt = (response as Record<string, unknown>).resetAt;
  return {
    resetAt: typeof resetAt === 'string' && resetAt.trim().length > 0 ? resetAt.trim() : null,
  };
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

export async function getChannelBroadcastComposerClientResetState(
  api: ApiTransport,
  chatId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ChannelBroadcastComposerClientResetState> {
  const response = await api.request(`/channels/${chatId}/broadcast/client-reset`, {
    signal: options.signal,
  });
  return parseChannelBroadcastComposerClientResetState(response);
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
  const requestBody = sendBroadcastRequestSchema.parse({
    ...payload,
    requestId: payload.requestId ?? createBroadcastRequestId(),
  });
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
): Promise<SendBroadcastTestResult> {
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
  const response = await api.request(`/channels/${chatId}/broadcast/test`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return sendBroadcastTestResultSchema.parse(response);
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
  params: {
    from?: string;
    to?: string;
    targetMode?: 'current' | 'selected' | 'all';
    targetChatIds?: readonly string[];
  } = {},
): Promise<ManagedBroadcastCalendarResponse> {
  const search = new URLSearchParams();
  if (params.from) {
    search.set('from', params.from);
  }
  if (params.to) {
    search.set('to', params.to);
  }
  if (params.targetMode) {
    search.set('targetMode', params.targetMode);
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

export async function getChannelManagedAutopostRules(
  api: ApiTransport,
  chatId: string,
): Promise<ManagedAutopostRuleSummary[]> {
  const response = await api.request(`/channels/${chatId}/autopost-rules`);
  if (!Array.isArray(response)) {
    throw new Error('Invalid channel managed autopost rules response');
  }

  return response.map((item: unknown) => managedAutopostRuleSummarySchema.parse(item));
}

export async function getChannelManagedAutopostRule(
  api: ApiTransport,
  chatId: string,
  ruleId: string,
): Promise<ManagedAutopostRuleDetails> {
  const response = await api.request(`/channels/${chatId}/autopost-rules/${ruleId}`);
  return managedAutopostRuleDetailsSchema.parse(response);
}

export async function createChannelManagedAutopostRule(
  api: ApiTransport,
  chatId: string,
  payload: CreateManagedAutopostRuleRequest,
): Promise<ManagedAutopostRuleDetails> {
  const requestBody = createManagedAutopostRuleRequestSchema.parse(payload);
  const response = await api.request(`/channels/${chatId}/autopost-rules`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return managedAutopostRuleDetailsSchema.parse(response);
}

export async function updateChannelManagedAutopostRule(
  api: ApiTransport,
  chatId: string,
  ruleId: string,
  payload: UpdateManagedAutopostRuleRequest,
): Promise<ManagedAutopostRuleDetails> {
  const requestBody = updateManagedAutopostRuleRequestSchema.parse(payload);
  const response = await api.request(`/channels/${chatId}/autopost-rules/${ruleId}`, {
    method: 'PUT',
    body: JSON.stringify(requestBody),
  });
  return managedAutopostRuleDetailsSchema.parse(response);
}

export async function deleteChannelManagedAutopostRule(
  api: ApiTransport,
  chatId: string,
  ruleId: string,
): Promise<ManagedAutopostRuleDetails> {
  const response = await api.request(`/channels/${chatId}/autopost-rules/${ruleId}`, {
    method: 'DELETE',
  });
  return managedAutopostRuleDetailsSchema.parse(response);
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
