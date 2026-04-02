import {
  logsDashboardRangeSchema,
  logsDashboardResponseSchema,
  manualModerationActionRequestSchema,
  manualModerationActionResultSchema,
  moderationFeedPageSchema,
  moderationFeedQuerySchema,
  membershipActivityPageSchema,
  membershipActivityQuerySchema,
  profileMentionHandoffRequestSchema,
  broadcastHandoffResponseSchema,
  type LogsDashboardRange,
  type LogsDashboardResponse,
  type ManualModerationActionRequest,
  type ManualModerationActionResult,
  type ModerationFeedPage,
  type ModerationFeedQuery,
  type MembershipActivityPage,
  type MembershipActivityQuery,
  type BroadcastHandoffResponse,
  type ProfileMentionHandoffRequest,
} from '@maxim/contracts';
import type { ApiTransport } from './transport';

export async function getLogsDashboard(
  api: ApiTransport,
  chatId: string,
  range: LogsDashboardRange = '7d',
  options: Partial<{
    includeActivityPreview: boolean;
    includeModerationPreview: boolean;
  }> = {},
  request: Pick<RequestInit, 'signal'> = {},
): Promise<LogsDashboardResponse> {
  const validatedRange = logsDashboardRangeSchema.parse(range);
  const params = new URLSearchParams({
    range: validatedRange,
  });
  if (options.includeActivityPreview === false) {
    params.set('includeActivityPreview', 'false');
  }
  if (options.includeModerationPreview === false) {
    params.set('includeModerationPreview', 'false');
  }
  const response = await api.request(
    `/chats/${chatId}/logs-dashboard?${params.toString()}`,
    request,
  );
  return logsDashboardResponseSchema.parse(response);
}

export async function getChatActivityFeed(
  api: ApiTransport,
  chatId: string,
  query: Partial<MembershipActivityQuery> = {},
  request: Pick<RequestInit, 'signal'> = {},
): Promise<MembershipActivityPage> {
  const validatedQuery = membershipActivityQuerySchema.parse(query);
  const params = new URLSearchParams({
    range: validatedQuery.range,
    filter: validatedQuery.filter,
    limit: String(validatedQuery.limit),
  });

  if (validatedQuery.cursor) {
    params.set('cursor', validatedQuery.cursor);
  }

  const response = await api.request(
    `/chats/${chatId}/activity-feed?${params.toString()}`,
    request,
  );
  return membershipActivityPageSchema.parse(response);
}

export async function getChatModerationFeed(
  api: ApiTransport,
  chatId: string,
  query: Partial<ModerationFeedQuery> = {},
  request: Pick<RequestInit, 'signal'> = {},
): Promise<ModerationFeedPage> {
  const validatedQuery = moderationFeedQuerySchema.parse(query);
  const params = new URLSearchParams({
    range: validatedQuery.range,
    filter: validatedQuery.filter,
    limit: String(validatedQuery.limit),
  });

  if (validatedQuery.cursor) {
    params.set('cursor', validatedQuery.cursor);
  }

  const response = await api.request(
    `/chats/${chatId}/moderation-feed?${params.toString()}`,
    request,
  );
  return moderationFeedPageSchema.parse(response);
}

export async function applyManualModerationAction(
  api: ApiTransport,
  chatId: string,
  userId: string,
  payload: ManualModerationActionRequest,
): Promise<ManualModerationActionResult> {
  const requestBody = manualModerationActionRequestSchema.parse(payload);
  const response = await api.request(
    `/chats/${chatId}/members/${encodeURIComponent(userId)}/moderation-action`,
    {
      method: 'POST',
      body: JSON.stringify(requestBody),
    },
  );
  return manualModerationActionResultSchema.parse(response);
}

export async function handoffChatMemberProfile(
  api: ApiTransport,
  chatId: string,
  userId: string,
  payload: ProfileMentionHandoffRequest,
): Promise<BroadcastHandoffResponse> {
  const requestBody = profileMentionHandoffRequestSchema.parse(payload);
  const response = await api.request(
    `/chats/${chatId}/members/${encodeURIComponent(userId)}/profile/handoff`,
    {
      method: 'POST',
      body: JSON.stringify(requestBody),
    },
  );
  return broadcastHandoffResponseSchema.parse(response);
}

export function handoffChatMemberProfileKeepalive(
  api: ApiTransport,
  chatId: string,
  userId: string,
  payload: ProfileMentionHandoffRequest,
): void {
  const requestBody = profileMentionHandoffRequestSchema.parse(payload);
  api.requestKeepalive(`/chats/${chatId}/members/${encodeURIComponent(userId)}/profile/handoff`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
}
