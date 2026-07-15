import type {
  ChatParticipantsPage,
  ChatParticipantRoleFilter,
  LogsDashboardRange,
  LogsDashboardResponse,
  MembershipActivityFilter,
  MembershipActivityPage,
  MembershipActivityRange,
} from '@maxim/contracts';

export type EventsDashboardPrefetchNetwork = {
  saveData?: boolean;
  effectiveType?: string | null;
};

export type EventsDashboardPrefetchInput = {
  range: LogsDashboardRange;
  participantsCount: number | null | undefined;
  network?: EventsDashboardPrefetchNetwork | null;
};

const SECONDARY_DASHBOARD_PREFETCH_MAX_PARTICIPANTS = 1_500;
const SLOW_EFFECTIVE_CONNECTION_TYPES = new Set(['slow-2g', '2g']);

export function buildLogsDashboardSnapshotParts(
  chatId: string,
  range: LogsDashboardRange,
  includeActivityPreview: boolean,
  includeModerationPreview: boolean,
): readonly string[] {
  return [
    chatId,
    range,
    includeActivityPreview ? 'activity' : 'no-activity',
    includeModerationPreview ? 'moderation' : 'no-moderation',
  ];
}

export function buildMembershipActivitySnapshotParts(
  entityType: 'chat' | 'channel',
  entityId: string,
  range: MembershipActivityRange,
  filter: MembershipActivityFilter,
): readonly string[] {
  return [entityType, entityId, range, filter, 'first-page'];
}

export function buildChatParticipantsSnapshotParts(
  chatId: string,
  range: LogsDashboardRange,
  search: string,
  roleFilter: ChatParticipantRoleFilter = 'all',
): readonly string[] {
  const normalizedSearch = search.trim();
  return [chatId, range, roleFilter, normalizedSearch || 'all', 'first-page'];
}

export function isLogsDashboardResponseForRange(
  dashboard: LogsDashboardResponse | null | undefined,
  chatId: string,
  range: LogsDashboardRange,
): dashboard is LogsDashboardResponse {
  return Boolean(dashboard && dashboard.chat.id === chatId && dashboard.period.range === range);
}

export function isMembershipActivityPage(value: unknown): value is MembershipActivityPage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const page = value as Partial<MembershipActivityPage>;
  return (
    Array.isArray(page.items) &&
    typeof page.hasMore === 'boolean' &&
    (typeof page.nextCursor === 'string' || page.nextCursor === null)
  );
}

export function isChatParticipantsPage(value: unknown): value is ChatParticipantsPage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const page = value as Partial<ChatParticipantsPage>;
  return (
    Array.isArray(page.items) &&
    typeof page.hasMore === 'boolean' &&
    (typeof page.nextCursor === 'string' || page.nextCursor === null) &&
    (typeof page.totalCount === 'number' || page.totalCount === null)
  );
}

export function shouldPrefetchSecondaryEventsDashboard({
  range,
  participantsCount,
  network,
}: EventsDashboardPrefetchInput): boolean {
  if (range !== '24h') {
    return false;
  }

  if (network?.saveData) {
    return false;
  }

  if (
    typeof network?.effectiveType === 'string' &&
    SLOW_EFFECTIVE_CONNECTION_TYPES.has(network.effectiveType)
  ) {
    return false;
  }

  if (typeof participantsCount !== 'number' || !Number.isFinite(participantsCount)) {
    return false;
  }

  return participantsCount <= SECONDARY_DASHBOARD_PREFETCH_MAX_PARTICIPANTS;
}
