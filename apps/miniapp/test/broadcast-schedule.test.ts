import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDefaultBroadcastCycleDraft,
  findBroadcastSlotConflicts,
  formatBroadcastCycleIntervalLabel,
  getBroadcastCycleValidationError,
  hasBroadcastHandoffDraft,
  normalizeBroadcastCycleDraft,
  resolveBroadcastHandoffSchedule,
  resolveBroadcastCycleLastSendAt,
  resolveBroadcastCycleSendAt,
  sortAndUniqueBroadcastSlots,
} from '../src/lib/broadcast-schedule';

const NOW_MS = Date.parse('2026-05-06T10:00:00.000Z');

test('defaults cycle drafts to a channel-safe daily cadence', () => {
  assert.deepEqual(createDefaultBroadcastCycleDraft(NOW_MS), {
    startMode: 'now',
    startAt: '2026-05-06T11:00:00.000Z',
    everyHours: 24,
    count: 7,
  });
});

test('normalizes cycle draft limits and preserves a valid delayed start', () => {
  const normalized = normalizeBroadcastCycleDraft(
    {
      startMode: 'later',
      startAt: '2026-05-06T11:00:00.000Z',
      everyHours: 0,
      count: 250,
    },
    NOW_MS,
  );

  assert.deepEqual(normalized, {
    startMode: 'later',
    startAt: '2026-05-06T11:00:00.000Z',
    everyHours: 1,
    count: 100,
  });
});

test('resolves cycle sendAt only for delayed starts', () => {
  assert.equal(
    resolveBroadcastCycleSendAt({
      startMode: 'now',
      startAt: '2026-05-06T11:00:00.000Z',
      everyHours: 2,
      count: 3,
    }),
    null,
  );

  assert.equal(
    resolveBroadcastCycleSendAt({
      startMode: 'later',
      startAt: '2026-05-06T11:00:00.000Z',
      everyHours: 2,
      count: 3,
    }),
    '2026-05-06T11:00:00.000Z',
  );
});

test('detects and restores cycle broadcast handoff schedules', () => {
  const state = {
    buttons: [],
    scheduledSlots: [],
    targetMode: 'current',
    targetChatIds: [],
    sendAt: '2026-05-06T12:00:00.000Z',
    cycleEnabled: true,
    cycleEveryHours: 6,
    cycleCount: 4,
    hasContent: false,
  };

  assert.equal(hasBroadcastHandoffDraft(state), true);
  assert.deepEqual(resolveBroadcastHandoffSchedule(state, NOW_MS), {
    timingMode: 'cycle',
    scheduledSlots: [],
    cycle: {
      startMode: 'later',
      startAt: '2026-05-06T12:00:00.000Z',
      everyHours: 6,
      count: 4,
    },
  });
});

test('restores non-cycle handoff sendAt as a scheduled single slot', () => {
  assert.deepEqual(
    resolveBroadcastHandoffSchedule(
      {
        buttons: [],
        scheduledSlots: [],
        sendAt: '2026-05-06T12:00:00.000Z',
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
      NOW_MS,
    ),
    {
      timingMode: 'scheduled',
      scheduledSlots: ['2026-05-06T12:00:00.000Z'],
      cycle: {
        startMode: 'later',
        startAt: '2026-05-06T12:00:00.000Z',
        everyHours: 1,
        count: 2,
      },
    },
  );
});

test('validates cycle start and 31-day window', () => {
  assert.equal(
    getBroadcastCycleValidationError(
      {
        startMode: 'later',
        startAt: '2026-05-06T10:00:10.000Z',
        everyHours: 1,
        count: 2,
      },
      NOW_MS,
    ),
    'Старт минимум через 30 секунд.',
  );

  assert.equal(
    getBroadcastCycleValidationError(
      {
        startMode: 'now',
        startAt: '2026-05-06T11:00:00.000Z',
        everyHours: 24,
        count: 33,
      },
      NOW_MS,
    ),
    'Цикл должен уложиться в 31 день.',
  );

  assert.equal(
    getBroadcastCycleValidationError(
      {
        startMode: 'now',
        startAt: '2026-05-06T11:00:00.000Z',
        everyHours: 6,
        count: 5,
      },
      NOW_MS,
    ),
    null,
  );
});

test('formats cycle interval labels and calculates the last send time', () => {
  assert.equal(formatBroadcastCycleIntervalLabel(1), '1 ч');
  assert.equal(formatBroadcastCycleIntervalLabel(24), '1 день');
  assert.equal(formatBroadcastCycleIntervalLabel(48), '2 дня');

  assert.equal(
    resolveBroadcastCycleLastSendAt(
      {
        startMode: 'later',
        startAt: '2026-05-06T11:00:00.000Z',
        everyHours: 6,
        count: 5,
      },
      NOW_MS,
    ),
    '2026-05-07T11:00:00.000Z',
  );
});

test('finds calendar slot conflicts by the same instant, not only exact strings', () => {
  assert.deepEqual(
    findBroadcastSlotConflicts(
      ['2026-05-06T13:00:00+03:00', '2026-05-06T14:00:00+03:00'],
      ['2026-05-06T10:00:00.000Z'],
    ),
    ['2026-05-06T13:00:00+03:00'],
  );

  assert.deepEqual(findBroadcastSlotConflicts(['broken-slot'], ['broken-slot']), ['broken-slot']);
});

test('sorts and deduplicates calendar slots by instant', () => {
  assert.deepEqual(
    sortAndUniqueBroadcastSlots([
      '2026-05-06T13:00:00+03:00',
      '2026-05-06T14:00:00+03:00',
      '2026-05-06T10:00:00.000Z',
      'broken-slot',
      'broken-slot',
    ]),
    ['2026-05-06T13:00:00+03:00', '2026-05-06T14:00:00+03:00', 'broken-slot'],
  );
});
