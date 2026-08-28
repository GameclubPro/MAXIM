import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManagedBroadcastCalendarSlot, ManagedBroadcastSummary } from '@maxim/contracts';
import {
  buildAgendaEntries,
  buildAgendaEntriesFromCalendarSlots,
} from '../src/lib/broadcast-planner-agenda';
import {
  BROADCAST_DAY_PRESETS,
  buildBroadcastDailyScheduleSlots,
  buildBroadcastPresetDayKeys,
  buildBroadcastQuickScheduleSlots,
  buildFreeWindowsForDay,
  buildBroadcastSmartScheduleTemplates,
  buildSlotsByDay,
  filterBroadcastSlotsByDayKeys,
  formatCountLabel,
  getBroadcastPlannerKeyboardNavigationDayKey,
  getBroadcastPlannerWindow,
  getCommonSelectedMinutesForDays,
  getMonthCells,
  getMonthKeys,
  normalizeBroadcastPlannerTimeMinutes,
  parseBroadcastPlannerTimeLabel,
  snapMinutesToStep,
} from '../src/lib/broadcast-planner-time';
import {
  buildBroadcastScheduleSlotIso,
  getBroadcastScheduleDayKey,
} from '../src/lib/broadcast-schedule';
import {
  buildBroadcastScheduleRecipePlan,
  createDefaultBroadcastScheduleRecipeDraft,
} from '../src/lib/broadcast-schedule-recipe';

function createManagedBroadcast(
  overrides: Partial<ManagedBroadcastSummary> = {},
): ManagedBroadcastSummary {
  return {
    id: 'broadcast-1',
    status: 'ACTIVE',
    textPreview: 'Плановый пост',
    textLength: 13,
    targetMode: 'selected',
    applyToAllChats: false,
    targetChatIds: ['chat-a', 'chat-b'],
    targetChats: 2,
    targetPreviews: [{ id: 'chat-a', title: 'Канал A', entityType: 'channel' }],
    targetOverflowCount: 1,
    hasImage: true,
    imageCount: 2,
    hasVideo: false,
    buttons: [{ text: 'Открыть', url: 'https://example.com' }],
    buttonEnabled: true,
    scheduleMode: 'calendar',
    scheduleTimezone: 'Europe/Moscow',
    scheduledSlots: [
      '2026-05-06T08:00:00.000Z',
      '2026-05-06T09:00:00.000Z',
      '2026-05-07T08:00:00.000Z',
    ],
    nextSendAt: '2026-05-06T08:00:00.000Z',
    cycleEnabled: false,
    cycleEveryHours: 24,
    cycleCount: 1,
    sentCount: 0,
    currentOccurrence: 1,
    deliveredChats: 0,
    failedChats: 0,
    pendingChats: 2,
    blockedChats: 0,
    failureBreakdown: {
      transient: 0,
      permanentTarget: 0,
      quarantined: 0,
      unknown: 0,
    },
    canRetry: false,
    remainingCount: 3,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    lastError: null,
    ...overrides,
  };
}

function createCalendarSlot(
  overrides: Partial<ManagedBroadcastCalendarSlot> = {},
): ManagedBroadcastCalendarSlot {
  return {
    broadcastId: 'broadcast-1',
    sourceChatId: 'source-1',
    scheduledAt: '2026-05-06T08:00:00.000Z',
    status: 'ACTIVE',
    textPreview: 'Плановый пост',
    targetMode: 'selected',
    targetChatIds: ['chat-a', 'chat-b'],
    targetChats: 2,
    targetPreviews: [{ id: 'chat-a', title: 'Канал A', entityType: 'channel' }],
    targetOverflowCount: 1,
    overlapChatIds: ['chat-a'],
    overlapPreviews: [{ id: 'chat-a', title: 'Канал A', entityType: 'channel' }],
    overlapOverflowCount: 0,
    hasTargetOverlap: true,
    ...overrides,
  };
}

test('formats russian count labels for compact planner UI', () => {
  assert.equal(formatCountLabel(1, 'слот', 'слота', 'слотов'), '1 слот');
  assert.equal(formatCountLabel(3, 'слот', 'слота', 'слотов'), '3 слота');
  assert.equal(formatCountLabel(11, 'слот', 'слота', 'слотов'), '11 слотов');
  assert.equal(formatCountLabel(22, 'слот', 'слота', 'слотов'), '22 слота');
});

test('builds month keys and 42 calendar cells for planner grids', () => {
  assert.deepEqual(getMonthKeys(new Date(2026, 4, 1), new Date(2026, 6, 31, 23, 59, 59, 999)), [
    '2026-05',
    '2026-06',
    '2026-07',
  ]);
  assert.equal(getMonthCells('2026-05').length, 42);
});

test('uses one complete visible window for planner dates and availability', () => {
  const window = getBroadcastPlannerWindow(new Date(2026, 6, 11, 12, 0, 0, 0));

  assert.equal(window.start.getTime(), new Date(2026, 6, 11, 0, 0, 0, 0).getTime());
  assert.equal(window.end.getTime(), new Date(2026, 7, 31, 23, 59, 59, 999).getTime());
});

test('moves calendar focus with keyboard keys without leaving the scheduling window', () => {
  const windowStart = new Date(2026, 4, 4, 0, 0, 0, 0);
  const windowEnd = new Date(2026, 4, 31, 23, 59, 59, 999);

  assert.equal(
    getBroadcastPlannerKeyboardNavigationDayKey('2026-05-06', 'ArrowLeft', windowStart, windowEnd),
    '2026-05-05',
  );
  assert.equal(
    getBroadcastPlannerKeyboardNavigationDayKey('2026-05-06', 'ArrowDown', windowStart, windowEnd),
    '2026-05-13',
  );
  assert.equal(
    getBroadcastPlannerKeyboardNavigationDayKey('2026-05-06', 'Home', windowStart, windowEnd),
    '2026-05-04',
  );
  assert.equal(
    getBroadcastPlannerKeyboardNavigationDayKey('2026-05-06', 'End', windowStart, windowEnd),
    '2026-05-10',
  );
  assert.equal(
    getBroadcastPlannerKeyboardNavigationDayKey('2026-05-04', 'ArrowLeft', windowStart, windowEnd),
    null,
  );
  assert.equal(
    getBroadcastPlannerKeyboardNavigationDayKey('2026-05-31', 'ArrowRight', windowStart, windowEnd),
    null,
  );
  assert.equal(
    getBroadcastPlannerKeyboardNavigationDayKey('2026-05-06', 'Enter', windowStart, windowEnd),
    null,
  );
});

test('calculates planner free windows from occupied slots', () => {
  const windows = buildFreeWindowsForDay([
    buildBroadcastScheduleSlotIso('2026-05-06', 9 * 60),
    buildBroadcastScheduleSlotIso('2026-05-06', 12 * 60),
    buildBroadcastScheduleSlotIso('2026-05-06', 20 * 60),
  ]);

  assert.deepEqual(
    windows.map((window) => window.label),
    ['08:00-09:00', '09:30-12:00', '12:30-20:00', '20:30-22:00'],
  );
});

test('builds one-tap quick schedule slots around occupied times', () => {
  const nowMs = new Date(2026, 4, 6, 10, 0, 0, 0).getTime();
  const occupiedSuggestedSlot = buildBroadcastScheduleSlotIso('2026-05-06', 11 * 60);

  const slots = buildBroadcastQuickScheduleSlots({
    nowMs,
    minimumTimeMs: nowMs + 30_000,
    occupiedSlots: [occupiedSuggestedSlot],
  });

  assert.equal(slots.length, 3);
  assert.equal(
    slots.some((slot) => slot.slot === occupiedSuggestedSlot),
    false,
  );
});

test('builds smart schedule templates without busy slots', () => {
  const nowMs = new Date(2026, 4, 6, 10, 0, 0, 0).getTime();
  const busyPrimeSlot = buildBroadcastScheduleSlotIso('2026-05-06', 18 * 60);

  const templates = buildBroadcastSmartScheduleTemplates({
    nowMs,
    minimumTimeMs: nowMs + 30_000,
    occupiedSlots: [busyPrimeSlot],
  });
  const prime = templates.find((template) => template.id === 'prime-3');
  const workdays = templates.find((template) => template.id === 'workdays-5');

  assert.equal(prime?.label, 'Прайм');
  assert.equal(prime?.meta, '3×18:00');
  assert.equal(getBroadcastScheduleDayKey(prime?.slots[0] ?? ''), '2026-05-07');
  assert.equal(workdays?.slots.length, 5);
  assert.equal(
    workdays?.slots.some((slot) => [0, 6].includes(new Date(slot).getDay())),
    false,
  );
});

test('builds a five-day two-times daily calendar schedule', () => {
  const nowMs = new Date(2026, 4, 6, 10, 0, 0, 0).getTime();
  const minimumTimeMs = nowMs + 30_000;
  const preset = BROADCAST_DAY_PRESETS.find((item) => item.id === 'five-days');

  assert.ok(preset);
  const dayKeys = buildBroadcastPresetDayKeys(preset, { nowMs });
  const slots = buildBroadcastDailyScheduleSlots({
    dayKeys,
    minutes: [9 * 60, 18 * 60],
  });

  assert.equal(dayKeys.length, 5);
  assert.equal(slots.length, 10);
  assert.deepEqual([...buildSlotsByDay(slots).keys()], dayKeys);
  assert.deepEqual(getCommonSelectedMinutesForDays(dayKeys, slots), [9 * 60, 18 * 60]);

  const futureSlots = buildBroadcastDailyScheduleSlots({
    dayKeys,
    minutes: [9 * 60, 18 * 60],
    minimumTimeMs,
  });

  assert.equal(futureSlots.length, 9);
  assert.equal(
    futureSlots.every((slot) => new Date(slot).getTime() >= minimumTimeMs),
    true,
  );
  assert.deepEqual(getCommonSelectedMinutesForDays(dayKeys.slice(1), futureSlots), [
    9 * 60,
    18 * 60,
  ]);
});

test('builds a complete five-day two-times recipe plan', () => {
  const nowMs = new Date(2026, 4, 6, 8, 0, 0, 0).getTime();
  const plan = buildBroadcastScheduleRecipePlan(createDefaultBroadcastScheduleRecipeDraft(), {
    nowMs,
    minimumTimeMs: nowMs + 30_000,
  });

  assert.equal(plan.isComplete, true);
  assert.equal(plan.issue, null);
  assert.equal(plan.dayKeys.length, 5);
  assert.equal(plan.slots.length, 10);
  assert.equal(plan.requestedSlotCount, 10);
  assert.deepEqual(getCommonSelectedMinutesForDays(plan.dayKeys, plan.slots), [10 * 60, 18 * 60]);
});

test('keeps recipe plans complete by skipping past and occupied days', () => {
  const nowMs = new Date(2026, 4, 6, 10, 30, 0, 0).getTime();
  const occupiedSlot = buildBroadcastScheduleSlotIso('2026-05-07', 18 * 60);
  const plan = buildBroadcastScheduleRecipePlan(createDefaultBroadcastScheduleRecipeDraft(), {
    nowMs,
    minimumTimeMs: nowMs + 30_000,
    occupiedSlots: [occupiedSlot],
  });

  assert.equal(plan.isComplete, true);
  assert.equal(plan.skippedPastDayCount, 1);
  assert.equal(plan.skippedBusyDayCount, 1);
  assert.equal(plan.dayKeys.includes('2026-05-06'), false);
  assert.equal(plan.dayKeys.includes('2026-05-07'), false);
  assert.equal(plan.slots.length, 10);
  assert.equal(
    plan.slots.some((slot) => slot === occupiedSlot),
    false,
  );
});

test('marks recipe plans incomplete when the 31-day window cannot fit requested sends', () => {
  const nowMs = new Date(2026, 4, 6, 8, 0, 0, 0).getTime();
  const occupiedSlots = Array.from({ length: 31 }, (_, index) =>
    buildBroadcastScheduleSlotIso(
      getBroadcastScheduleDayKey(new Date(2026, 4, 6 + index, 12)),
      10 * 60,
    ),
  );
  const plan = buildBroadcastScheduleRecipePlan(createDefaultBroadcastScheduleRecipeDraft(), {
    nowMs,
    minimumTimeMs: nowMs + 30_000,
    occupiedSlots,
  });

  assert.equal(plan.isComplete, false);
  assert.equal(plan.issue, 'not-enough-time');
  assert.equal(plan.slots.length, 0);
  assert.equal(plan.requestedSlotCount, 10);
});

test('rejects duplicate recipe times instead of silently changing the plan', () => {
  const nowMs = new Date(2026, 4, 6, 8, 0, 0, 0).getTime();
  const plan = buildBroadcastScheduleRecipePlan(
    {
      dayCount: 5,
      postsPerDay: 2,
      weekdayMode: 'any',
      minutes: [10 * 60, 10 * 60],
    },
    {
      nowMs,
      minimumTimeMs: nowMs + 30_000,
    },
  );

  assert.equal(plan.isComplete, false);
  assert.equal(plan.issue, 'duplicate-time');
  assert.deepEqual(plan.duplicateMinuteLabels, ['10:00']);
  assert.deepEqual(plan.slots, []);
});

test('filters preset slots to the newly selected days', () => {
  const nowMs = new Date(2026, 4, 6, 10, 0, 0, 0).getTime();
  const fiveDayPreset = BROADCAST_DAY_PRESETS.find((item) => item.id === 'five-days');
  const sevenDayPreset = BROADCAST_DAY_PRESETS.find((item) => item.id === 'seven-days');

  assert.ok(fiveDayPreset);
  assert.ok(sevenDayPreset);

  const fiveDayKeys = buildBroadcastPresetDayKeys(fiveDayPreset, { nowMs });
  const sevenDayKeys = buildBroadcastPresetDayKeys(sevenDayPreset, { nowMs });
  const sevenDaySlots = buildBroadcastDailyScheduleSlots({
    dayKeys: sevenDayKeys,
    minutes: [9 * 60, 18 * 60],
  });
  const filteredSlots = filterBroadcastSlotsByDayKeys(sevenDaySlots, fiveDayKeys);

  assert.equal(sevenDaySlots.length, 14);
  assert.equal(filteredSlots.length, 10);
  assert.deepEqual([...buildSlotsByDay(filteredSlots).keys()], fiveDayKeys);
});

test('builds weekday preset days and snaps custom times to calendar step', () => {
  const nowMs = new Date(2026, 4, 8, 10, 0, 0, 0).getTime();
  const preset = BROADCAST_DAY_PRESETS.find((item) => item.id === 'workdays');
  const parsedMinutes = parseBroadcastPlannerTimeLabel('09:10');

  assert.ok(preset);
  assert.equal(parsedMinutes, 9 * 60 + 10);
  assert.equal(normalizeBroadcastPlannerTimeMinutes(parsedMinutes ?? 0), 9 * 60);

  const dayKeys = buildBroadcastPresetDayKeys(preset, { nowMs });
  assert.equal(dayKeys.length, 5);
  assert.deepEqual(
    dayKeys.map((dayKey) => new Date(`${dayKey}T12:00:00`).getDay()),
    [5, 1, 2, 3, 4],
  );
});

test('snaps minutes and groups slots by day', () => {
  assert.equal(snapMinutesToStep(61), 90);
  assert.deepEqual([...buildSlotsByDay(['2026-05-06T08:00:00.000Z']).keys()], ['2026-05-06']);
});

test('builds managed broadcast agenda entries by day', () => {
  const entries = buildAgendaEntries([createManagedBroadcast()], 'Текущий чат', null);

  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.id, 'broadcast-1');
  assert.equal(entries[0]?.dayKey, '2026-05-06');
  assert.deepEqual(entries[0]?.facts, ['Канал A +1', '2 фото', '1 кнопка']);
  assert.equal(entries[0]?.timeSlots.length, 2);
});

test('agenda titles hide legacy multiline markdown markers', () => {
  const entries = buildAgendaEntries(
    [createManagedBroadcast({ textPreview: '**Первая\nВторая**' })],
    'Текущий чат',
    null,
  );

  assert.equal(entries[0]?.title, 'Первая Вторая');
  assert.doesNotMatch(entries[0]?.title ?? '', /\*\*/u);
});

test('builds target-aware agenda entries from calendar slots', () => {
  const entries = buildAgendaEntriesFromCalendarSlots(
    [
      createCalendarSlot(),
      createCalendarSlot({ scheduledAt: '2026-05-06T09:00:00.000Z' }),
      createCalendarSlot({ broadcastId: 'broadcast-2', sourceChatId: 'source-2' }),
    ],
    'source-1',
    'Текущий чат',
    null,
  );

  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.canEdit, true);
  assert.deepEqual(entries[0]?.facts, ['Канал A']);
  assert.equal(entries[0]?.timeSlots.length, 2);
  assert.equal(entries[1]?.canEdit, false);
});
