import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PUBLICATION_LATE_POLICY } from '@maxim/contracts/publication';
import {
  formatPublicationLatePolicy,
  LEGACY_PUBLICATION_LATE_POLICY,
  resolvePublicationDraftLatePolicy,
} from '../src/features/publications/publication-late-policy-presentation';
import { createEmptyPublicationDraft } from '../src/features/publications/publication-model';

test('delay presentation preserves custom deadlines and distinguishes skip from recovery', () => {
  assert.equal(
    formatPublicationLatePolicy({ mode: 'strict', maxDelayMinutes: 17, catchUp: 'all' }, true),
    'Пропустить спустя 17 мин. после назначенного времени',
  );
  assert.equal(
    formatPublicationLatePolicy({ mode: 'recover', maxDelayMinutes: 360, catchUp: 'all' }, false),
    'Ждать восстановления до 6 ч. после назначенного времени',
  );
});

test('omitted policy distinguishes unaccepted drafts, saved schedules and replacement intent', () => {
  const baseline = {
    ...createEmptyPublicationDraft(),
    timingMode: 'schedule' as const,
    scheduleKind: 'slots' as const,
    latePolicy: undefined,
    scheduledSlots: ['2030-01-01T10:00:00.000Z'],
  };
  assert.deepEqual(
    resolvePublicationDraftLatePolicy(baseline, null, false),
    DEFAULT_PUBLICATION_LATE_POLICY,
  );
  assert.deepEqual(
    resolvePublicationDraftLatePolicy(baseline, baseline, false),
    DEFAULT_PUBLICATION_LATE_POLICY,
  );
  assert.deepEqual(
    resolvePublicationDraftLatePolicy(baseline, baseline, true),
    LEGACY_PUBLICATION_LATE_POLICY,
  );
  assert.deepEqual(
    resolvePublicationDraftLatePolicy(
      { ...baseline, title: 'Правка текста', targets: [] },
      baseline,
      true,
    ),
    LEGACY_PUBLICATION_LATE_POLICY,
  );
  assert.deepEqual(
    resolvePublicationDraftLatePolicy(
      { ...baseline, scheduledSlots: ['2030-01-02T10:00:00.000Z'] },
      baseline,
      true,
    ),
    DEFAULT_PUBLICATION_LATE_POLICY,
  );
  const custom = { mode: 'strict' as const, maxDelayMinutes: 17, catchUp: 'all' as const };
  assert.deepEqual(
    resolvePublicationDraftLatePolicy({ ...baseline, latePolicy: custom }, null, false),
    custom,
  );
});

test('unchanged recurrence preserves legacy authority while a new unanchored request gets the current default', () => {
  const baseline = {
    ...createEmptyPublicationDraft(),
    timingMode: 'schedule' as const,
    scheduleKind: 'recurrence' as const,
    latePolicy: undefined,
    recurrence: {
      frequency: 'weekly' as const,
      interval: 2,
      weekdays: [4, 1],
      times: ['13:00', '09:00'],
      startsAt: '2030-01-01T00:00:00Z',
      endsAt: null,
      maxOccurrences: 10,
    },
  };
  const reordered = {
    ...baseline,
    recurrence: { ...baseline.recurrence, weekdays: [1, 4], times: ['09:00', '13:00'] },
  };
  assert.deepEqual(
    resolvePublicationDraftLatePolicy(reordered, baseline, true),
    LEGACY_PUBLICATION_LATE_POLICY,
  );
  const unanchored = { ...baseline, recurrence: { ...baseline.recurrence, startsAt: null } };
  assert.deepEqual(
    resolvePublicationDraftLatePolicy(unanchored, unanchored, true, true),
    LEGACY_PUBLICATION_LATE_POLICY,
  );
  assert.deepEqual(
    resolvePublicationDraftLatePolicy(unanchored, unanchored, true, false),
    DEFAULT_PUBLICATION_LATE_POLICY,
  );
});

test('only recovery of recurring sends exposes catch-up behavior', () => {
  assert.match(
    formatPublicationLatePolicy(DEFAULT_PUBLICATION_LATE_POLICY, true),
    /24 ч.*Только последний повтор/u,
  );
  assert.equal(
    formatPublicationLatePolicy(undefined, true),
    'Пропустить спустя 5 мин. после назначенного времени',
  );
  assert.doesNotMatch(formatPublicationLatePolicy(undefined, false), /повтор/u);
  assert.match(
    formatPublicationLatePolicy({ mode: 'recover', maxDelayMinutes: 30, catchUp: 'all' }, true),
    /30 мин.*Все актуальные повторы/u,
  );
  assert.doesNotMatch(
    formatPublicationLatePolicy({ mode: 'strict', maxDelayMinutes: 30, catchUp: 'latest' }, true),
    /повтор/u,
  );
});
