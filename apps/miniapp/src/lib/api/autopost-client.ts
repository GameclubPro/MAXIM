import {
  createManagedAutopostHubRuleRequestSchema,
  listManagedAutopostHubRulesQuerySchema,
  managedAutopostHubRuleDetailsSchema,
  managedAutopostHubRuleSummarySchema,
  sendBroadcastRequestSchema,
  sendBroadcastTestResultSchema,
  updateManagedAutopostRuleRequestSchema,
  type CreateManagedAutopostHubRuleRequest,
  type ListManagedAutopostHubRulesQuery,
  type ManagedAutopostHubRuleDetails,
  type ManagedAutopostHubRuleSummary,
  type SendBroadcastTestResult,
  type UpdateManagedAutopostRuleRequest,
} from '@maxim/contracts';
import type { SendBroadcastPayload } from './shared-types';
import type { ApiTransport } from './transport';

function appendAutopostRulesQuery(path: string, query: ListManagedAutopostHubRulesQuery): string {
  const parsed = listManagedAutopostHubRulesQuerySchema.parse(query);
  const search = new URLSearchParams();
  if (parsed.entityType && parsed.entityType !== 'all') {
    search.set('entityType', parsed.entityType);
  }
  if (parsed.status) {
    search.set('status', parsed.status);
  }
  if (parsed.sourceChatId) {
    search.set('sourceChatId', parsed.sourceChatId);
  }

  const serialized = search.toString();
  return serialized ? `${path}?${serialized}` : path;
}

export async function getAutopostRules(
  api: ApiTransport,
  query: ListManagedAutopostHubRulesQuery = {},
): Promise<ManagedAutopostHubRuleSummary[]> {
  const response = await api.request(appendAutopostRulesQuery('/autopost-rules', query));
  if (!Array.isArray(response)) {
    throw new Error('Invalid autopost rules response');
  }

  return response.map((item: unknown) => managedAutopostHubRuleSummarySchema.parse(item));
}

export async function getAutopostRule(
  api: ApiTransport,
  ruleId: string,
): Promise<ManagedAutopostHubRuleDetails> {
  const response = await api.request(`/autopost-rules/${encodeURIComponent(ruleId)}`);
  return managedAutopostHubRuleDetailsSchema.parse(response);
}

export async function createAutopostRule(
  api: ApiTransport,
  payload: CreateManagedAutopostHubRuleRequest,
): Promise<ManagedAutopostHubRuleDetails> {
  const requestBody = createManagedAutopostHubRuleRequestSchema.parse(payload);
  const response = await api.request('/autopost-rules', {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return managedAutopostHubRuleDetailsSchema.parse(response);
}

export async function updateAutopostRule(
  api: ApiTransport,
  ruleId: string,
  payload: UpdateManagedAutopostRuleRequest,
): Promise<ManagedAutopostHubRuleDetails> {
  const requestBody = updateManagedAutopostRuleRequestSchema.parse(payload);
  const response = await api.request(`/autopost-rules/${encodeURIComponent(ruleId)}`, {
    method: 'PUT',
    body: JSON.stringify(requestBody),
  });
  return managedAutopostHubRuleDetailsSchema.parse(response);
}

export async function deleteAutopostRule(
  api: ApiTransport,
  ruleId: string,
): Promise<ManagedAutopostHubRuleDetails> {
  const response = await api.request(`/autopost-rules/${encodeURIComponent(ruleId)}`, {
    method: 'DELETE',
  });
  return managedAutopostHubRuleDetailsSchema.parse(response);
}

export async function sendAutopostTest(
  api: ApiTransport,
  sourceChatId: string,
  entityType: 'chat' | 'channel',
  payload: SendBroadcastPayload,
): Promise<SendBroadcastTestResult> {
  const requestBody = sendBroadcastRequestSchema.parse(payload);
  const response = await api.request(
    `/${entityType === 'channel' ? 'channels' : 'chats'}/${encodeURIComponent(
      sourceChatId,
    )}/broadcast/test`,
    {
      method: 'POST',
      body: JSON.stringify(requestBody),
    },
  );
  return sendBroadcastTestResultSchema.parse(response);
}
