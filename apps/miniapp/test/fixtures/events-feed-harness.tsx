import { createElement, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  MembershipActivityPage,
  ModerationFeedPage,
  ModerationFeedFilter,
} from '@maxim/contracts';
import { useModerationFeed } from '../../src/lib/use-moderation-feed';
import { useMembershipActivityFeed } from '../../src/lib/use-membership-activity-feed';
import { useEventFeedRefresh } from '../../src/lib/use-event-feed-refresh';

type Options = {
  chatId: string;
  kind?: 'moderation' | 'activity';
  enabled?: boolean;
  filter?: ModerationFeedFilter;
  initialPage?: ModerationFeedPage & MembershipActivityPage;
};
type Feed = ReturnType<typeof useModerationFeed> | ReturnType<typeof useMembershipActivityFeed>;
const root = createRoot(document.getElementById('root')!);
const harness = {
  current: null as Feed | null,
  pending: [] as Array<{
    query: { cursor?: string };
    signal?: AbortSignal | null;
    resolve: (page: ModerationFeedPage & MembershipActivityPage) => void;
    reject: (error: Error) => void;
  }>,
  history: [] as Array<{ chatId: string; ids: string[] }>,
  render: (options: Options) => root.render(createElement(Harness, options)),
  unmount: () => root.unmount(),
};
function Harness(options: Options) {
  const loadPage = (query: { cursor?: string }, request?: Pick<RequestInit, 'signal'>) =>
    new Promise<ModerationFeedPage & MembershipActivityPage>((resolve, reject) => {
      harness.pending.push({ query, signal: request?.signal, resolve, reject });
    });
  const moderation = useModerationFeed({
    ...options,
    enabled: options.enabled !== false && options.kind !== 'activity',
    range: '7d',
    filter: options.filter ?? 'ALL',
    loadPage,
  });
  const activity = useMembershipActivityFeed({
    ...options,
    entityId: options.chatId,
    enabled: options.enabled !== false && options.kind === 'activity',
    range: '7d',
    loadPage,
  });
  const feed = options.kind === 'activity' ? activity : moderation;
  useEventFeedRefresh({
    enabled: options.enabled !== false,
    scopeKey: JSON.stringify([options.chatId, options.kind, options.filter, activity.filter]),
    feed,
  });
  useLayoutEffect(() => {
    harness.current = feed;
    harness.history.push({ chatId: options.chatId, ids: feed.items.map((item) => item.id) });
  });
  return createElement('output', null, feed.items.map((item) => item.id).join(','));
}
Object.assign(window, { eventTest: harness });
