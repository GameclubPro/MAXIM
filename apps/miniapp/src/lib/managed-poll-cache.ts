import type {
  ManagedPollListResponse,
  ManagedPollListScope,
  ManagedPollSummary,
} from '@maxim/contracts/poll';
import type { InfiniteData } from '@tanstack/react-query';

export type ManagedPollListData = InfiniteData<ManagedPollListResponse, string | null>;

export function resolveManagedPollListScope(
  poll: Pick<ManagedPollSummary, 'status'>,
): ManagedPollListScope {
  return poll.status === 'CLOSED' ? 'archive' : 'current';
}

export function isManagedPollEditable(
  poll: Pick<ManagedPollSummary, 'status' | 'publicationPending' | 'publicationNeedsReview'>,
): boolean {
  return poll.status === 'DRAFT' && !poll.publicationPending && !poll.publicationNeedsReview;
}

export function reconcileManagedPollListData(
  current: ManagedPollListData | undefined,
  scope: ManagedPollListScope,
  poll: ManagedPollSummary,
): ManagedPollListData | undefined {
  if (scope !== resolveManagedPollListScope(poll)) {
    return removeManagedPollFromListData(current, poll.id);
  }

  if (!current) {
    return {
      pages: [{ items: [poll], nextCursor: null, total: 1 }],
      pageParams: [null],
    };
  }

  const loadedPollIds = new Set(current.pages.flatMap((page) => page.items.map((item) => item.id)));
  const exists = loadedPollIds.has(poll.id);
  const knownTotal = Math.max(0, ...current.pages.map((page) => page.total));
  // In a partial cache, an absent poll can already be included in a fresher server total.
  const shouldIncrementTotal = !exists && loadedPollIds.size >= knownTotal;
  const nextTotal = knownTotal + (shouldIncrementTotal ? 1 : 0);
  const pages = current.pages.map((page) => ({
    ...page,
    total: nextTotal,
    items: page.items.map((item) => (item.id === poll.id ? poll : item)),
  }));

  if (!exists) {
    const firstPage = pages[0] ?? { items: [], nextCursor: null, total: nextTotal };
    pages[0] = { ...firstPage, items: [poll, ...firstPage.items] };
  }

  return { ...current, pages };
}

export function removeManagedPollFromListData(
  current: ManagedPollListData | undefined,
  pollId: string,
): ManagedPollListData | undefined {
  if (!current) {
    return current;
  }

  const exists = current.pages.some((page) => page.items.some((poll) => poll.id === pollId));
  if (!exists) {
    return current;
  }

  return {
    ...current,
    pages: current.pages.map((page) => ({
      ...page,
      items: page.items.filter((poll) => poll.id !== pollId),
      total: Math.max(0, page.total - 1),
    })),
  };
}
