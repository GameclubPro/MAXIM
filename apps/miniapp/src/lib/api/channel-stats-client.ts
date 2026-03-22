import {
  broadcastHandoffResponseSchema,
  channelStatsRangeSchema,
  channelStatsResponseSchema,
  membershipActivityPageSchema,
  membershipActivityQuerySchema,
  profileMentionHandoffRequestSchema,
  type BroadcastHandoffResponse,
  type ChannelStatsRange,
  type ChannelStatsResponse,
  type MembershipActivityPage,
  type MembershipActivityQuery,
  type ProfileMentionHandoffRequest,
} from '@maxim/contracts';
import type { ApiTransport } from './transport';

export async function getChannelStats(
  api: ApiTransport,
  chatId: string,
  range: ChannelStatsRange = '7d',
): Promise<ChannelStatsResponse> {
  const validatedRange = channelStatsRangeSchema.parse(range);
  const response = await api.request(
    `/channels/${chatId}/stats?range=${encodeURIComponent(validatedRange)}`,
  );
  return channelStatsResponseSchema.parse(response);
}

export async function getChannelActivityFeed(
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

  const response = await api.request(
    `/channels/${chatId}/activity-feed?${params.toString()}`,
  );
  return membershipActivityPageSchema.parse(response);
}

export async function handoffChannelMemberProfile(
  api: ApiTransport,
  chatId: string,
  userId: string,
  payload: ProfileMentionHandoffRequest,
): Promise<BroadcastHandoffResponse> {
  const requestBody = profileMentionHandoffRequestSchema.parse(payload);
  const response = await api.request(
    `/channels/${chatId}/members/${encodeURIComponent(userId)}/profile/handoff`,
    {
      method: 'POST',
      body: JSON.stringify(requestBody),
    },
  );
  return broadcastHandoffResponseSchema.parse(response);
}

export function handoffChannelMemberProfileKeepalive(
  api: ApiTransport,
  chatId: string,
  userId: string,
  payload: ProfileMentionHandoffRequest,
): void {
  const requestBody = profileMentionHandoffRequestSchema.parse(payload);
  api.requestKeepalive(
    `/channels/${chatId}/members/${encodeURIComponent(userId)}/profile/handoff`,
    {
      method: 'POST',
      body: JSON.stringify(requestBody),
    },
  );
}
