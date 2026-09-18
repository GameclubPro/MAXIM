import type {
  LogsDashboardRange,
  ModerationFeedFilter,
  ModerationFeedPage,
} from '@maxim/contracts';
import { useEventFeed } from './use-event-feed';

export function useModerationFeed({
  chatId,
  enabled = true,
  range,
  filter,
  loadPage,
  initialPage = null,
  limit = 50,
}: {
  chatId: string;
  enabled?: boolean;
  range: LogsDashboardRange;
  filter: ModerationFeedFilter;
  loadPage: (
    query: {
      range: LogsDashboardRange;
      filter: ModerationFeedFilter;
      limit: number;
      cursor?: string;
    },
    request?: Pick<RequestInit, 'signal'>,
  ) => Promise<ModerationFeedPage>;
  initialPage?: ModerationFeedPage | null;
  limit?: number;
}) {
  return useEventFeed({
    scopeKey: JSON.stringify([chatId, range, filter, limit]),
    enabled: enabled && Boolean(chatId),
    query: { range, filter, limit },
    initialPage: filter === 'ALL' ? initialPage : null,
    loadPage,
  });
}
