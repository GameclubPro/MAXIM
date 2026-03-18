import {
  logsDashboardRangeSchema,
  logsDashboardResponseSchema,
  manualModerationActionRequestSchema,
  manualModerationActionResultSchema,
  membershipActivityPageSchema,
  membershipActivityQuerySchema,
  reviewSpammerCandidatesRequestSchema,
  reviewSpammerCandidatesResultSchema,
  spammerCandidateListResponseSchema,
  type LogsDashboardRange,
  type LogsDashboardResponse,
  type ManualModerationActionRequest,
  type ManualModerationActionResult,
  type MembershipActivityPage,
  type MembershipActivityQuery,
  type ReviewSpammerCandidatesRequest,
  type ReviewSpammerCandidatesResult,
  type SpammerCandidateListResponse,
} from '@maxim/contracts';
import type { ApiTransport } from './transport';

export async function getLogsDashboard(
  api: ApiTransport,
  chatId: string,
  range: LogsDashboardRange = '7d',
): Promise<LogsDashboardResponse> {
  const validatedRange = logsDashboardRangeSchema.parse(range);
  const response = await api.request(
    `/chats/${chatId}/logs-dashboard?range=${encodeURIComponent(validatedRange)}`,
  );
  return logsDashboardResponseSchema.parse(response);
}

export async function getChatActivityFeed(
  api: ApiTransport,
  chatId: string,
  query: Partial<MembershipActivityQuery> = {},
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

  const response = await api.request(`/chats/${chatId}/activity-feed?${params.toString()}`);
  return membershipActivityPageSchema.parse(response);
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

export async function getSpammerCandidates(
  api: ApiTransport,
  chatId: string,
): Promise<SpammerCandidateListResponse> {
  const response = await api.request(`/chats/${chatId}/spammer-candidates`);
  return spammerCandidateListResponseSchema.parse(response);
}

export async function reviewSpammerCandidates(
  api: ApiTransport,
  chatId: string,
  payload: ReviewSpammerCandidatesRequest,
): Promise<ReviewSpammerCandidatesResult> {
  const requestBody = reviewSpammerCandidatesRequestSchema.parse(payload);
  const response = await api.request(`/chats/${chatId}/spammer-candidates/review`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return reviewSpammerCandidatesResultSchema.parse(response);
}
