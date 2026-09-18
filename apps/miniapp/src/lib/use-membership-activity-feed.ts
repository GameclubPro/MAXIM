import type {
  MembershipActivityFilter,
  MembershipActivityPage,
  MembershipActivityRange,
} from '@maxim/contracts';
import { useState } from 'react';
import { useEventFeed } from './use-event-feed';

export function useMembershipActivityFeed({
  entityId,
  enabled = true,
  range,
  initialPage = null,
  loadPage,
  limit = 50,
}: {
  entityId: string;
  enabled?: boolean;
  range: MembershipActivityRange;
  initialPage?: MembershipActivityPage | null;
  loadPage: (
    query: {
      range: MembershipActivityRange;
      filter: MembershipActivityFilter;
      limit: number;
      cursor?: string;
    },
    request?: Pick<RequestInit, 'signal'>,
  ) => Promise<MembershipActivityPage>;
  limit?: number;
}) {
  const [filter, setFilter] = useState<MembershipActivityFilter>('all');
  const feed = useEventFeed({
    scopeKey: JSON.stringify([entityId, range, filter, limit]),
    enabled: enabled && Boolean(entityId),
    query: { range, filter, limit },
    initialPage: filter === 'all' ? initialPage : null,
    loadPage,
  });
  return { ...feed, filter, setFilter };
}
