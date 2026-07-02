import type { MembershipActivityItem } from '@maxim/contracts';

export const MEMBERSHIP_ACTIVITY_INITIAL_RENDER_LIMIT = 150;
export const MEMBERSHIP_ACTIVITY_RENDER_STEP = 100;

export type MembershipActivityGroup = {
  key: string;
  label: string;
  items: MembershipActivityItem[];
  joinedCount: number;
  leftCount: number;
};

export type MembershipActivityGroupsResult = {
  groups: MembershipActivityGroup[];
  visibleCount: number;
  hiddenCount: number;
};

const DAY_MONTH_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
});
const DAY_MONTH_YEAR_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function resolveMembershipActivityDayLabel(value: string, now = new Date()): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return 'Без даты';
  }

  const today = startOfDay(now);
  const target = startOfDay(parsed);
  const diff = Math.round((today - target) / (24 * 60 * 60 * 1000));

  if (diff === 0) {
    return 'Сегодня';
  }

  if (diff === 1) {
    return 'Вчера';
  }

  return parsed.getFullYear() !== now.getFullYear()
    ? DAY_MONTH_YEAR_FORMATTER.format(parsed)
    : DAY_MONTH_FORMATTER.format(parsed);
}

export function buildMembershipActivityGroups(
  items: MembershipActivityItem[],
  visibleLimit: number,
  now = new Date(),
): MembershipActivityGroupsResult {
  const normalizedLimit = Number.isFinite(visibleLimit)
    ? Math.max(0, Math.trunc(visibleLimit))
    : items.length;
  const visibleCount = Math.min(items.length, normalizedLimit);
  const result: MembershipActivityGroup[] = [];
  const bucket = new Map<string, MembershipActivityGroup>();

  for (let index = 0; index < visibleCount; index += 1) {
    const item = items[index]!;
    const parsed = new Date(item.createdAt);
    const key = Number.isFinite(parsed.getTime())
      ? `${parsed.getFullYear()}-${parsed.getMonth() + 1}-${parsed.getDate()}`
      : `unknown-${item.id}`;
    const existing = bucket.get(key);

    if (existing) {
      existing.items.push(item);
      if (item.type === 'joined') {
        existing.joinedCount += 1;
      } else {
        existing.leftCount += 1;
      }
      continue;
    }

    const entry: MembershipActivityGroup = {
      key,
      label: resolveMembershipActivityDayLabel(item.createdAt, now),
      items: [item],
      joinedCount: item.type === 'joined' ? 1 : 0,
      leftCount: item.type === 'left' ? 1 : 0,
    };
    bucket.set(key, entry);
    result.push(entry);
  }

  return {
    groups: result,
    visibleCount,
    hiddenCount: Math.max(0, items.length - visibleCount),
  };
}

export function resolveNextMembershipActivityRenderLimit(
  currentLimit: number,
  itemCount: number,
): number {
  const normalizedCurrent = Number.isFinite(currentLimit)
    ? Math.max(0, Math.trunc(currentLimit))
    : MEMBERSHIP_ACTIVITY_INITIAL_RENDER_LIMIT;
  const normalizedItemCount = Math.max(0, Math.trunc(itemCount));

  return Math.min(
    normalizedItemCount,
    Math.max(MEMBERSHIP_ACTIVITY_INITIAL_RENDER_LIMIT, normalizedCurrent) +
      MEMBERSHIP_ACTIVITY_RENDER_STEP,
  );
}
