import type {
  ChatParticipantItem,
  ChatParticipantsPage,
  ChatParticipantsQuery,
} from '@maxim/contracts';

export function normalizeParticipantsSearch(search: string): string {
  return search.trim().slice(0, 100);
}

export function buildParticipantsFeedKey(chatId: string, query: ChatParticipantsQuery): string {
  return JSON.stringify([chatId, query.range, query.roleFilter, query.limit, query.search ?? '']);
}

export function mergeParticipants(
  current: ChatParticipantItem[],
  next: ChatParticipantItem[],
): ChatParticipantItem[] {
  const items = new Map(current.map((item) => [item.userId, item]));
  for (const item of next) items.set(item.userId, item);
  return [...items.values()];
}

export function validateParticipantsCursor(
  page: ChatParticipantsPage,
  visitedCursors: ReadonlySet<string>,
): void {
  if (page.hasMore && (!page.nextCursor || visitedCursors.has(page.nextCursor))) {
    throw new Error('Не удалось продолжить список. Обновите участников.');
  }
}

export function describeParticipantViolations(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  const word =
    lastTwo >= 11 && lastTwo <= 14
      ? 'нарушений'
      : last === 1
        ? 'нарушение'
        : last >= 2 && last <= 4
          ? 'нарушения'
          : 'нарушений';
  return `${count} ${word} за выбранный период`;
}
