import {
  channelStatsRangeSchema,
  channelStatsResponseSchema,
  membershipActivityPageSchema,
  membershipActivityQuerySchema,
  type ChannelStatsRange,
  type ChannelStatsResponse,
  type MembershipActivityPage,
  type MembershipActivityQuery,
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
