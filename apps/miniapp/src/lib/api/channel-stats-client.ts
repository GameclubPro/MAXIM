import type {
  BroadcastHandoffResponse,
  ChannelStatsRange,
  ChannelStatsResponse,
  MembershipActivityPage,
  MembershipActivityQuery,
  ProfileMentionHandoffRequest,
} from '@maxim/contracts';
import type { ApiTransport } from './transport';

const channelStatsRanges = new Set<ChannelStatsRange>(['24h', '7d', '30d']);
const membershipActivityRanges = new Set<MembershipActivityQuery['range']>(['24h', '7d', '30d']);
const membershipActivityFilters = new Set<MembershipActivityQuery['filter']>([
  'all',
  'joined',
  'left',
]);

function parseChannelStatsRange(range: ChannelStatsRange): ChannelStatsRange {
  if (!channelStatsRanges.has(range)) {
    throw new Error('Invalid channel stats range');
  }

  return range;
}

function normalizeMembershipActivityQuery(
  query: Partial<MembershipActivityQuery>,
): MembershipActivityQuery {
  const range = query.range ?? '7d';
  const filter = query.filter ?? 'all';
  const limit = query.limit ?? 50;
  const cursor = query.cursor?.trim();

  if (!membershipActivityRanges.has(range)) {
    throw new Error('Invalid activity range');
  }
  if (!membershipActivityFilters.has(filter)) {
    throw new Error('Invalid activity filter');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Invalid activity limit');
  }

  return {
    range,
    filter,
    limit,
    ...(cursor ? { cursor } : {}),
  };
}

export async function getChannelStats(
  api: ApiTransport,
  chatId: string,
  range: ChannelStatsRange = '7d',
  request: Pick<RequestInit, 'signal'> = {},
  options: Partial<{
    includeActivityPreview: boolean;
    includeIntelligence: boolean;
  }> = {},
): Promise<ChannelStatsResponse> {
  const query = parseChannelStatsRange(range);
  const params = new URLSearchParams({
    range: query,
  });
  if (options.includeActivityPreview === false) {
    params.set('includeActivityPreview', 'false');
  }
  if (options.includeIntelligence === false) {
    params.set('includeIntelligence', 'false');
  }

  const response = await api.request(`/channels/${chatId}/stats?${params.toString()}`, request);
  return response as ChannelStatsResponse;
}

export async function getChannelActivityFeed(
  api: ApiTransport,
  chatId: string,
  query: Partial<MembershipActivityQuery> = {},
  request: Pick<RequestInit, 'signal'> = {},
): Promise<MembershipActivityPage> {
  const validatedQuery = normalizeMembershipActivityQuery(query);
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
    request,
  );
  return response as MembershipActivityPage;
}

export async function handoffChannelMemberProfile(
  api: ApiTransport,
  chatId: string,
  userId: string,
  payload: ProfileMentionHandoffRequest,
): Promise<BroadcastHandoffResponse> {
  const requestBody = payload;
  const response = await api.request(
    `/channels/${chatId}/members/${encodeURIComponent(userId)}/profile/handoff`,
    {
      method: 'POST',
      body: JSON.stringify(requestBody),
    },
  );
  return response as BroadcastHandoffResponse;
}

export function handoffChannelMemberProfileKeepalive(
  api: ApiTransport,
  chatId: string,
  userId: string,
  payload: ProfileMentionHandoffRequest,
): void {
  const requestBody = payload;
  api.requestKeepalive(
    `/channels/${chatId}/members/${encodeURIComponent(userId)}/profile/handoff`,
    {
      method: 'POST',
      body: JSON.stringify(requestBody),
    },
  );
}
