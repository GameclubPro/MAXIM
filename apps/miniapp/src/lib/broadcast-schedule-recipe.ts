import {
  BROADCAST_SCHEDULE_MAX_DAYS,
  buildBroadcastScheduleSlotIso,
  getBroadcastSlotInstantKey,
  getBroadcastScheduleDayKey,
  sortAndUniqueBroadcastSlots,
} from './broadcast-schedule';
import {
  addDays,
  formatMinuteLabel,
  normalizeBroadcastPlannerTimeMinutes,
  sortDayKeys,
} from './broadcast-planner-time';

export type BroadcastScheduleRecipeWeekdayMode = 'any' | 'workdays';

export type BroadcastScheduleRecipeDraft = {
  dayCount: number;
  postsPerDay: number;
  weekdayMode: BroadcastScheduleRecipeWeekdayMode;
  minutes: number[];
};

export type BroadcastScheduleRecipeIssue = 'duplicate-time' | 'not-enough-time' | null;

export type BroadcastScheduleRecipePlan = {
  recipe: BroadcastScheduleRecipeDraft;
  dayKeys: string[];
  slots: string[];
  requestedSlotCount: number;
  skippedPastDayCount: number;
  skippedBusyDayCount: number;
  duplicateMinuteLabels: string[];
  issue: BroadcastScheduleRecipeIssue;
  isComplete: boolean;
};

export const BROADCAST_RECIPE_MIN_DAYS = 1;
export const BROADCAST_RECIPE_MAX_DAYS = BROADCAST_SCHEDULE_MAX_DAYS;
export const BROADCAST_RECIPE_MIN_POSTS_PER_DAY = 1;
export const BROADCAST_RECIPE_MAX_POSTS_PER_DAY = 6;
export const BROADCAST_RECIPE_DEFAULT_MINUTES = [
  10 * 60,
  18 * 60,
  13 * 60,
  21 * 60,
  8 * 60,
  16 * 60,
] as const;

function clampRecipeNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function normalizeBroadcastScheduleRecipeMinutes(
  minutes: readonly number[],
  postsPerDay: number,
): number[] {
  const targetCount = clampRecipeNumber(
    postsPerDay,
    BROADCAST_RECIPE_MIN_POSTS_PER_DAY,
    BROADCAST_RECIPE_MAX_POSTS_PER_DAY,
  );
  const result: number[] = [];

  for (const value of minutes) {
    if (result.length >= targetCount) {
      break;
    }
    result.push(normalizeBroadcastPlannerTimeMinutes(value));
  }

  for (const value of BROADCAST_RECIPE_DEFAULT_MINUTES) {
    if (result.length >= targetCount) {
      break;
    }

    const normalized = normalizeBroadcastPlannerTimeMinutes(value);
    if (!result.includes(normalized)) {
      result.push(normalized);
    }
  }

  return result.slice(0, targetCount).sort((left, right) => left - right);
}

export function createDefaultBroadcastScheduleRecipeDraft(): BroadcastScheduleRecipeDraft {
  return {
    dayCount: 5,
    postsPerDay: 2,
    weekdayMode: 'any',
    minutes: normalizeBroadcastScheduleRecipeMinutes(BROADCAST_RECIPE_DEFAULT_MINUTES, 2),
  };
}

export function normalizeBroadcastScheduleRecipeDraft(
  value: BroadcastScheduleRecipeDraft,
): BroadcastScheduleRecipeDraft {
  const postsPerDay = clampRecipeNumber(
    value.postsPerDay,
    BROADCAST_RECIPE_MIN_POSTS_PER_DAY,
    BROADCAST_RECIPE_MAX_POSTS_PER_DAY,
  );

  return {
    dayCount: clampRecipeNumber(
      value.dayCount,
      BROADCAST_RECIPE_MIN_DAYS,
      BROADCAST_RECIPE_MAX_DAYS,
    ),
    postsPerDay,
    weekdayMode: value.weekdayMode === 'workdays' ? 'workdays' : 'any',
    minutes: normalizeBroadcastScheduleRecipeMinutes(value.minutes, postsPerDay),
  };
}

export function getBroadcastScheduleRecipeDuplicateMinuteLabels(
  minutes: readonly number[],
): string[] {
  const seen = new Set<number>();
  const duplicates = new Set<number>();

  for (const value of minutes) {
    const normalized = normalizeBroadcastPlannerTimeMinutes(value);
    if (seen.has(normalized)) {
      duplicates.add(normalized);
    }
    seen.add(normalized);
  }

  return Array.from(duplicates)
    .sort((left, right) => left - right)
    .map(formatMinuteLabel);
}

function shouldUseRecipeDay(
  dayKey: string,
  weekdayMode: BroadcastScheduleRecipeWeekdayMode,
): boolean {
  if (weekdayMode === 'any') {
    return true;
  }

  const weekDay = new Date(`${dayKey}T12:00:00`).getDay();
  return weekDay !== 0 && weekDay !== 6;
}

export function buildBroadcastScheduleRecipePlan(
  recipe: BroadcastScheduleRecipeDraft,
  options: {
    nowMs: number;
    minimumTimeMs: number;
    occupiedSlots?: readonly string[];
    maxDays?: number;
  },
): BroadcastScheduleRecipePlan {
  const normalizedRecipe = normalizeBroadcastScheduleRecipeDraft(recipe);
  const duplicateMinuteLabels = getBroadcastScheduleRecipeDuplicateMinuteLabels(
    normalizedRecipe.minutes,
  );
  const requestedSlotCount = normalizedRecipe.dayCount * normalizedRecipe.postsPerDay;
  const basePlan = {
    recipe: normalizedRecipe,
    requestedSlotCount,
    skippedPastDayCount: 0,
    skippedBusyDayCount: 0,
    duplicateMinuteLabels,
  };

  if (duplicateMinuteLabels.length > 0) {
    return {
      ...basePlan,
      dayKeys: [],
      slots: [],
      issue: 'duplicate-time',
      isComplete: false,
    };
  }

  const occupiedInstantSet = new Set(
    sortAndUniqueBroadcastSlots([...(options.occupiedSlots ?? [])]).map(getBroadcastSlotInstantKey),
  );
  const dayKeys: string[] = [];
  let skippedPastDayCount = 0;
  let skippedBusyDayCount = 0;
  const maxDays = clampRecipeNumber(
    options.maxDays ?? BROADCAST_SCHEDULE_MAX_DAYS,
    BROADCAST_RECIPE_MIN_DAYS,
    BROADCAST_SCHEDULE_MAX_DAYS,
  );

  for (
    let dayOffset = 0;
    dayOffset < maxDays && dayKeys.length < normalizedRecipe.dayCount;
    dayOffset += 1
  ) {
    const dayKey = getBroadcastScheduleDayKey(addDays(new Date(options.nowMs), dayOffset));
    if (!shouldUseRecipeDay(dayKey, normalizedRecipe.weekdayMode)) {
      continue;
    }

    const daySlots = normalizedRecipe.minutes.map((minutes) =>
      buildBroadcastScheduleSlotIso(dayKey, minutes),
    );
    const hasPastSlot = daySlots.some((slot) => new Date(slot).getTime() < options.minimumTimeMs);
    if (hasPastSlot) {
      skippedPastDayCount += 1;
      continue;
    }

    const hasBusySlot = daySlots.some((slot) =>
      occupiedInstantSet.has(getBroadcastSlotInstantKey(slot)),
    );
    if (hasBusySlot) {
      skippedBusyDayCount += 1;
      continue;
    }

    dayKeys.push(dayKey);
  }

  const slots = sortAndUniqueBroadcastSlots(
    sortDayKeys(dayKeys).flatMap((dayKey) =>
      normalizedRecipe.minutes.map((minutes) => buildBroadcastScheduleSlotIso(dayKey, minutes)),
    ),
  );
  const isComplete =
    dayKeys.length === normalizedRecipe.dayCount && slots.length === requestedSlotCount;

  return {
    recipe: normalizedRecipe,
    dayKeys,
    slots,
    requestedSlotCount,
    skippedPastDayCount,
    skippedBusyDayCount,
    duplicateMinuteLabels,
    issue: isComplete ? null : 'not-enough-time',
    isComplete,
  };
}

export function areBroadcastScheduleRecipeDraftsEqual(
  left: BroadcastScheduleRecipeDraft,
  right: BroadcastScheduleRecipeDraft,
): boolean {
  return (
    left.dayCount === right.dayCount &&
    left.postsPerDay === right.postsPerDay &&
    left.weekdayMode === right.weekdayMode &&
    left.minutes.length === right.minutes.length &&
    left.minutes.every((value, index) => value === right.minutes[index])
  );
}
