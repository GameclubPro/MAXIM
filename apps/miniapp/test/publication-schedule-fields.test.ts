import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePublicationScheduleField } from '../src/features/publications/publication-schedule-fields';
import {
  formatPublicationScheduleField,
  getNextPublicationRecurrenceTime,
} from '../src/features/publications/publication-time-presentation';
import { createEmptyPublicationDraft } from '../src/features/publications/publication-model';
import { formatDraftTiming } from '../src/features/publications/publication-page-formatters';

test('publication date input round-trips in its saved zone instead of the device zone', () => {
  const local = formatPublicationScheduleField('2026-09-08T21:00:00Z', 'Asia/Vladivostok');
  assert.equal(local, '2026-09-09T07:00');
  assert.equal(
    parsePublicationScheduleField(local, 'Asia/Vladivostok'),
    '2026-09-08T21:00:00.000Z',
  );
  assert.equal(
    parsePublicationScheduleField('2026-09-09T00:00', 'Asia/Vladivostok'),
    '2026-09-08T14:00:00.000Z',
  );
});

test('publication schedule rejects malformed dates and DST gaps', () => {
  for (const value of ['', '2026-02-30T09:00', '2026-03-29T02:30']) {
    assert.equal(parsePublicationScheduleField(value, 'Europe/Berlin'), null);
  }
  assert.equal(formatPublicationScheduleField('invalid', 'UTC'), '');
  assert.equal(parsePublicationScheduleField('2026-09-08T09:00', 'Invalid/Zone'), null);
});

test('adding recurrence times skips duplicates and wraps around midnight', () => {
  assert.equal(getNextPublicationRecurrenceTime(['17:30', '18:00']), '18:30');
  assert.equal(getNextPublicationRecurrenceTime(['00:00', '23:30']), '00:30');
  let times = ['09:00'];
  for (let index = 1; index < 12; index += 1)
    times = [...times, getNextPublicationRecurrenceTime(times)];
  assert.equal(new Set(times).size, 12);
});

test('weekly schedule summary includes selected weekdays, sorted times and the occurrence limit', () => {
  const draft = createEmptyPublicationDraft();
  draft.timingMode = 'schedule';
  draft.scheduleKind = 'recurrence';
  draft.recurrence = {
    frequency: 'weekly',
    interval: 2,
    weekdays: [1, 5],
    times: ['18:00', '09:00'],
    startsAt: '2026-09-01T00:00:00Z',
    endsAt: null,
    maxOccurrences: 12,
  };
  assert.match(formatDraftTiming(draft), /Пн, Пт/u);
  assert.match(formatDraftTiming(draft), /09:00, 18:00/u);
  assert.match(formatDraftTiming(draft), /12 запусков/u);
});
