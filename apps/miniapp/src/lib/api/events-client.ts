import type {
  BroadcastHandoffResponse,
  ChatParticipantImmunityUpdateRequest,
  ChatParticipantImmunityUpdateResult,
  ChatParticipantsPage,
  ChatParticipantsQuery,
  GlobalSpammerCandidateStatus,
  GlobalSpammerReviewMetrics,
  GlobalSpammerReviewQueue,
  GlobalSpammerReviewRequest,
  GlobalSpammerReviewResult,
  GlobalSpammerUserDiagnostics,
  LogsDashboardRange,
  LogsDashboardResponse,
  ManualModerationActionRequest,
  ManualModerationActionResult,
  MembershipActivityPage,
  MembershipActivityQuery,
  ModerationFeedPage,
  ModerationFeedQuery,
  ProfileMentionHandoffRequest,
} from '@maxim/contracts';
import type { ApiTransport } from './transport';

const logsDashboardRanges = new Set<LogsDashboardRange>(['24h', '7d', '30d']);
const membershipActivityFilters = new Set<MembershipActivityQuery['filter']>([
  'all',
  'joined',
  'left',
]);
const moderationFeedFilters = new Set<ModerationFeedQuery['filter']>([
  'ALL',
  'WARN',
  'DELETE_MESSAGE',
  'MUTE',
  'BAN',
  'UNMUTE',
  'UNBAN',
]);
const globalSpammerCandidateStatuses = new Set<GlobalSpammerCandidateStatus | 'ALL'>([
  'PENDING',
  'AUTO_APPROVED',
  'APPROVED',
  'SUPPRESSED',
  'ALL',
]);
const globalSpammerRegistryStatuses = new Set([
  'NONE',
  'ACTIVE_CONFIRMED',
  'LOCAL_BLOCKED',
  'MEDIUM_REVIEW',
  'SUPPRESSED',
  'EXPIRED',
  'ADMIN_EXEMPT',
]);
const globalSpammerPolicyActions = new Set(['NONE', 'DELETE_AND_KICK', 'SHADOW_DELETE_AND_KICK']);
const globalSpammerEnforcementModes = new Set(['enforce', 'shadow']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseGlobalSpammerUserDiagnosticsResponse(
  response: unknown,
): GlobalSpammerUserDiagnostics {
  if (!isRecord(response) || typeof response.userId !== 'string') {
    throw new Error('Invalid spammer diagnostics response');
  }

  const policy = response.policy;
  const registry = response.registry;
  const reputationSummary = response.reputationSummary;
  if (
    !isRecord(policy) ||
    !globalSpammerRegistryStatuses.has(String(policy.registryStatus)) ||
    !globalSpammerPolicyActions.has(String(policy.action)) ||
    !globalSpammerEnforcementModes.has(String(policy.enforcementMode)) ||
    typeof policy.deleteSpammersEnabled !== 'boolean' ||
    !isRecord(registry) ||
    !Array.isArray(response.observations) ||
    !Array.isArray(response.graphSignals) ||
    !Array.isArray(response.campaigns) ||
    !isRecord(reputationSummary)
  ) {
    throw new Error('Invalid spammer diagnostics response');
  }

  return response as GlobalSpammerUserDiagnostics;
}

function parseLogsDashboardRange(range: LogsDashboardRange): LogsDashboardRange {
  if (!logsDashboardRanges.has(range)) {
    throw new Error('Invalid dashboard range');
  }

  return range;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Invalid page limit');
  }

  return limit;
}

function normalizeMembershipActivityQuery(
  query: Partial<MembershipActivityQuery>,
): MembershipActivityQuery {
  const range = query.range ?? '7d';
  const filter = query.filter ?? 'all';
  if (!logsDashboardRanges.has(range)) {
    throw new Error('Invalid activity range');
  }
  if (!membershipActivityFilters.has(filter)) {
    throw new Error('Invalid activity filter');
  }

  const cursor = query.cursor?.trim();
  return {
    range,
    filter,
    limit: normalizeLimit(query.limit, 50),
    ...(cursor ? { cursor } : {}),
  };
}

function normalizeModerationFeedQuery(query: Partial<ModerationFeedQuery>): ModerationFeedQuery {
  const range = query.range ?? '7d';
  const filter = query.filter ?? 'ALL';
  if (!logsDashboardRanges.has(range)) {
    throw new Error('Invalid moderation range');
  }
  if (!moderationFeedFilters.has(filter)) {
    throw new Error('Invalid moderation filter');
  }

  const cursor = query.cursor?.trim();
  return {
    range,
    filter,
    limit: normalizeLimit(query.limit, 50),
    ...(cursor ? { cursor } : {}),
  };
}

function normalizeChatParticipantsQuery(
  query: Partial<ChatParticipantsQuery>,
): ChatParticipantsQuery {
  const range = query.range ?? '7d';
  if (!logsDashboardRanges.has(range)) {
    throw new Error('Invalid participants range');
  }

  const cursor = query.cursor?.trim();
  const search = query.search?.trim();
  return {
    range,
    limit: normalizeLimit(query.limit, 100),
    ...(cursor ? { cursor } : {}),
    ...(search ? { search } : {}),
  };
}

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
  const validatedRange = parseLogsDashboardRange(range);
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
  return response as LogsDashboardResponse;
}

export async function getChatModerationDashboard(
  api: ApiTransport,
  chatId: string,
  range: LogsDashboardRange = '7d',
  request: Pick<RequestInit, 'signal'> = {},
): Promise<LogsDashboardResponse> {
  const validatedRange = parseLogsDashboardRange(range);
  const params = new URLSearchParams({
    range: validatedRange,
  });
  const response = await api.request(
    `/chats/${chatId}/moderation-dashboard?${params.toString()}`,
    request,
  );
  return response as LogsDashboardResponse;
}

export async function getChatActivityDashboard(
  api: ApiTransport,
  chatId: string,
  range: LogsDashboardRange = '7d',
  request: Pick<RequestInit, 'signal'> = {},
): Promise<LogsDashboardResponse> {
  const validatedRange = parseLogsDashboardRange(range);
  const params = new URLSearchParams({
    range: validatedRange,
  });
  const response = await api.request(
    `/chats/${chatId}/activity-dashboard?${params.toString()}`,
    request,
  );
  return response as LogsDashboardResponse;
}

export async function getChatActivityFeed(
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
    `/chats/${chatId}/activity-feed?${params.toString()}`,
    request,
  );
  return response as MembershipActivityPage;
}

export async function getChatModerationFeed(
  api: ApiTransport,
  chatId: string,
  query: Partial<ModerationFeedQuery> = {},
  request: Pick<RequestInit, 'signal'> = {},
): Promise<ModerationFeedPage> {
  const validatedQuery = normalizeModerationFeedQuery(query);
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
  return response as ModerationFeedPage;
}

export async function getChatParticipantsPage(
  api: ApiTransport,
  chatId: string,
  query: Partial<ChatParticipantsQuery> = {},
  request: Pick<RequestInit, 'signal'> = {},
): Promise<ChatParticipantsPage> {
  const validatedQuery = normalizeChatParticipantsQuery(query);
  const params = new URLSearchParams({
    range: validatedQuery.range,
    limit: String(validatedQuery.limit),
  });

  if (validatedQuery.cursor) {
    params.set('cursor', validatedQuery.cursor);
  }
  if (validatedQuery.search) {
    params.set('search', validatedQuery.search);
  }

  const response = await api.request(`/chats/${chatId}/members?${params.toString()}`, request);
  return response as ChatParticipantsPage;
}

export async function applyManualModerationAction(
  api: ApiTransport,
  chatId: string,
  userId: string,
  payload: ManualModerationActionRequest,
): Promise<ManualModerationActionResult> {
  const requestBody = payload;
  const response = await api.request(
    `/chats/${chatId}/members/${encodeURIComponent(userId)}/moderation-action`,
    {
      method: 'POST',
      body: JSON.stringify(requestBody),
    },
  );
  return response as ManualModerationActionResult;
}

export async function getGlobalSpammerReviewQueue(
  api: ApiTransport,
  chatId: string,
  query: Partial<{
    status: GlobalSpammerCandidateStatus | 'ALL';
    limit: number;
    includeProfiles: boolean;
    includeObservations: boolean;
    profileMode: 'full' | 'local';
  }> = {},
  request: Pick<RequestInit, 'signal'> = {},
): Promise<GlobalSpammerReviewQueue> {
  const status = query.status ?? 'PENDING';
  if (!globalSpammerCandidateStatuses.has(status)) {
    throw new Error('Invalid spammer review status');
  }

  const limit = normalizeLimit(query.limit, 50);
  const params = new URLSearchParams({
    status,
    limit: String(limit),
  });
  if (query.includeProfiles === false) {
    params.set('includeProfiles', 'false');
  }
  if (query.includeObservations === false) {
    params.set('includeObservations', 'false');
  }
  if (query.profileMode === 'local') {
    params.set('profileMode', 'local');
  }
  const response = await api.request(
    `/chats/${chatId}/spammer-review?${params.toString()}`,
    request,
  );
  return response as GlobalSpammerReviewQueue;
}

export async function getGlobalSpammerReviewMetrics(
  api: ApiTransport,
  chatId: string,
  request: Pick<RequestInit, 'signal'> = {},
): Promise<GlobalSpammerReviewMetrics> {
  const response = await api.request(`/chats/${chatId}/spammer-review/metrics`, request);
  return response as GlobalSpammerReviewMetrics;
}

export async function getGlobalSpammerUserDiagnostics(
  api: ApiTransport,
  chatId: string,
  userId: string,
  query: Partial<{
    includeProfile: boolean;
    profileMode: 'full' | 'local';
  }> = {},
  request: Pick<RequestInit, 'signal'> = {},
): Promise<GlobalSpammerUserDiagnostics> {
  const params = new URLSearchParams();
  if (query.includeProfile === false) {
    params.set('includeProfile', 'false');
  }
  if (query.profileMode === 'local') {
    params.set('profileMode', 'local');
  }
  const suffix = params.toString();
  const path = `/chats/${chatId}/spammer-diagnostics/${encodeURIComponent(userId)}`;
  const response = await api.request(suffix ? `${path}?${suffix}` : path, request);
  return parseGlobalSpammerUserDiagnosticsResponse(response);
}

export async function reviewGlobalSpammerCandidate(
  api: ApiTransport,
  chatId: string,
  userId: string,
  payload: GlobalSpammerReviewRequest,
): Promise<GlobalSpammerReviewResult> {
  const response = await api.request(
    `/chats/${chatId}/spammer-review/${encodeURIComponent(userId)}`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  );
  return response as GlobalSpammerReviewResult;
}

export async function updateChatParticipantImmunity(
  api: ApiTransport,
  chatId: string,
  userId: string,
  payload: ChatParticipantImmunityUpdateRequest,
): Promise<ChatParticipantImmunityUpdateResult> {
  const requestBody = payload;
  const response = await api.request(
    `/chats/${chatId}/members/${encodeURIComponent(userId)}/immunity`,
    {
      method: 'PUT',
      body: JSON.stringify(requestBody),
    },
  );
  return response as ChatParticipantImmunityUpdateResult;
}

export async function handoffChatMemberProfile(
  api: ApiTransport,
  chatId: string,
  userId: string,
  payload: ProfileMentionHandoffRequest,
): Promise<BroadcastHandoffResponse> {
  const requestBody = payload;
  const response = await api.request(
    `/chats/${chatId}/members/${encodeURIComponent(userId)}/profile/handoff`,
    {
      method: 'POST',
      body: JSON.stringify(requestBody),
    },
  );
  return response as BroadcastHandoffResponse;
}

export function handoffChatMemberProfileKeepalive(
  api: ApiTransport,
  chatId: string,
  userId: string,
  payload: ProfileMentionHandoffRequest,
): void {
  const requestBody = payload;
  api.requestKeepalive(`/chats/${chatId}/members/${encodeURIComponent(userId)}/profile/handoff`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
}
