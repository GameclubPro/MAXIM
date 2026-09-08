import { createElement, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type { ChatParticipantsPage, ChatParticipantsQuery } from '@maxim/contracts';
import { useChatParticipantsFeed } from '../../src/lib/use-chat-participants-feed';
import { ChatParticipantsRoster } from '../../src/components/dashboard/chat-participants-roster';

type Options = {
  chatId: string;
  search?: string;
  enabled?: boolean;
  roleFilter?: ChatParticipantsQuery['roleFilter'];
  initialPage?: ChatParticipantsPage;
  refetchInitialPage?: boolean;
  roster?: boolean;
};
type Feed = ReturnType<typeof useChatParticipantsFeed>;
type Pending = {
  chatId: string;
  query: ChatParticipantsQuery;
  signal?: AbortSignal | null;
  resolve: (page: ChatParticipantsPage) => void;
  reject: (error: Error) => void;
};
const harness = {
  pending: [] as Pending[],
  history: [] as Array<{ chatId: string; ids: string[] }>,
  current: null as Feed | null,
  render: (options: Options) => root.render(createElement(Harness, options)),
  unmount: () => root.unmount(),
};

function Harness(options: Options) {
  const feed = useChatParticipantsFeed({
    ...options,
    loadPage: (query, request) =>
      new Promise((resolve, reject) => {
        harness.pending.push({
          chatId: options.chatId,
          query,
          signal: request?.signal,
          resolve,
          reject,
        });
      }),
  });
  useLayoutEffect(() => {
    harness.current = feed;
    harness.history.push({ chatId: options.chatId, ids: feed.items.map((item) => item.userId) });
  });
  if (options.roster)
    return createElement(ChatParticipantsRoster, {
      ...feed,
      search: options.search ?? '',
      roleFilter: options.roleFilter ?? 'all',
      rangeLabel: 'за 7 дней',
      isSearchPending: false,
      onSearchChange: (search) => harness.render({ ...options, search }),
      onRoleFilterChange: (roleFilter) => harness.render({ ...options, roleFilter }),
      onRetry: () => void feed.retryFailed(),
      onRefresh: () => void feed.retry(),
      onLoadMore: () => void feed.loadMore(),
    });
  return createElement('output', null, feed.items.length);
}

const root = createRoot(document.getElementById('root')!);
Object.assign(window, { participantTest: harness });
