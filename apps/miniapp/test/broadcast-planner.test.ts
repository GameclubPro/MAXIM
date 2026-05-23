import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManagedBroadcastCalendarSlot, ManagedBroadcastSummary } from '@maxim/contracts';
import {
  buildAgendaEntries,
  buildAgendaEntriesFromCalendarSlots,
} from '../src/lib/broadcast-planner-agenda';
import {
  buildBroadcastQuickScheduleSlots,
  buildFreeWindowsForDay,
  buildBroadcastSmartScheduleTemplates,
  buildSlotsByDay,
  formatCountLabel,
  getMonthCells,
  getMonthKeys,
  snapMinutesToStep,
} from '../src/lib/broadcast-planner-time';
import {
  buildBroadcastScheduleSlotIso,
  getBroadcastScheduleDayKey,
} from '../src/lib/broadcast-schedule';

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
