import type { PublicationScheduleInput } from '@maxim/contracts/publication';
import {
  assertPublicationTimezone,
  expandPublicationSchedule,
  isValidPublicationTimezone,
} from './publication-recurrence';

const window = {
  from: new Date('2026-07-01T00:00:00.000Z'),
  to: new Date('2026-07-31T23:59:59.999Z'),
};

function recurrence(
  overrides: Partial<Extract<PublicationScheduleInput, { mode: 'recurrence' }>> = {},
): Extract<PublicationScheduleInput, { mode: 'recurrence' }> {
  return {
    mode: 'recurrence',
    timezone: 'Europe/Moscow',
    frequency: 'daily',
    interval: 1,
    weekdays: [],
    times: ['09:00'],
    startsAt: '2026-07-01T00:00:00.000Z',
    endsAt: null,
    maxOccurrences: null,
    replaceConflicts: false,
    ...overrides,
  };
}

describe('publication recurrence', () => {
  it('validates IANA timezones', () => {
    expect(isValidPublicationTimezone('Europe/Moscow')).toBe(true);
    expect(isValidPublicationTimezone('UTC')).toBe(true);
    expect(isValidPublicationTimezone('local')).toBe(false);
    expect(isValidPublicationTimezone('Invalid/Timezone')).toBe(false);
    expect(() => assertPublicationTimezone('Invalid/Timezone')).toThrow(RangeError);
  });

  it('expands now at an explicit deterministic instant', () => {
    const now = new Date('2026-07-10T10:20:30.000Z');
    expect(
      expandPublicationSchedule({ mode: 'now', timezone: 'Europe/Moscow' }, { ...window, now }),
    ).toEqual([now]);
  });

  it('passes through once and slots while filtering, sorting and deduplicating UTC instants', () => {
    expect(
      expandPublicationSchedule(
        {
          mode: 'once',
          timezone: 'Europe/Moscow',
          at: '2026-07-10T12:00:00+03:00',
          replaceConflicts: false,
        },
        window,
      ).map((value) => value.toISOString()),
    ).toEqual(['2026-07-10T09:00:00.000Z']);

    expect(
      expandPublicationSchedule(
        {
          mode: 'slots',
          timezone: 'Europe/Moscow',
          replaceConflicts: false,
          slots: [
            '2026-08-01T12:00:00+03:00',
            '2026-07-12T12:00:00+03:00',
            '2026-07-10T12:00:00+03:00',
            '2026-07-10T09:00:00Z',
          ],
        },
        window,
      ).map((value) => value.toISOString()),
    ).toEqual(['2026-07-10T09:00:00.000Z', '2026-07-12T09:00:00.000Z']);
  });

  it('expands daily recurrence from its local anchor with multiple sorted times and interval', () => {
    const result = expandPublicationSchedule(
      recurrence({
        interval: 2,
        times: ['18:30', '09:00'],
        startsAt: '2026-07-01T07:00:00.000Z',
        endsAt: '2026-07-06T20:00:00.000Z',
      }),
      window,
    );

    expect(result.map((value) => value.toISOString())).toEqual([
      '2026-07-01T15:30:00.000Z',
      '2026-07-03T06:00:00.000Z',
      '2026-07-03T15:30:00.000Z',
      '2026-07-05T06:00:00.000Z',
      '2026-07-05T15:30:00.000Z',
    ]);
  });

  it('uses ISO weekdays and the anchored week for weekly intervals', () => {
    const result = expandPublicationSchedule(
      recurrence({
        frequency: 'weekly',
        interval: 2,
        weekdays: [1, 7],
        times: ['12:00'],
        startsAt: '2026-07-08T00:00:00.000Z',
        endsAt: '2026-07-27T23:00:00.000Z',
      }),
      window,
    );

    expect(result.map((value) => value.toISOString())).toEqual([
      '2026-07-12T09:00:00.000Z',
      '2026-07-20T09:00:00.000Z',
      '2026-07-26T09:00:00.000Z',
    ]);
  });

  it('subtracts existing occurrences from maxOccurrences', () => {
    const result = expandPublicationSchedule(
      recurrence({
        times: ['09:00', '18:00'],
        maxOccurrences: 5,
      }),
      { ...window, existingCount: 3 },
    );

    expect(result.map((value) => value.toISOString())).toEqual([
      '2026-07-01T06:00:00.000Z',
      '2026-07-01T15:00:00.000Z',
    ]);
  });

  it('skips a nonexistent spring-forward wall time', () => {
    const result = expandPublicationSchedule(
      recurrence({
        timezone: 'Europe/Berlin',
        times: ['02:30'],
        startsAt: '2026-03-28T00:00:00.000Z',
        endsAt: '2026-03-30T23:00:00.000Z',
      }),
      {
        from: new Date('2026-03-28T00:00:00.000Z'),
        to: new Date('2026-03-30T23:59:59.999Z'),
      },
    );

    expect(result.map((value) => value.toISOString())).toEqual([
      '2026-03-28T01:30:00.000Z',
      '2026-03-30T00:30:00.000Z',
    ]);
  });

  it('emits an ambiguous fall-back wall time once at the earlier UTC instant', () => {
    const result = expandPublicationSchedule(
      recurrence({
        timezone: 'Europe/Berlin',
        times: ['02:30'],
        startsAt: '2026-10-25T00:00:00.000Z',
        endsAt: '2026-10-25T23:00:00.000Z',
      }),
      {
        from: new Date('2026-10-25T00:00:00.000Z'),
        to: new Date('2026-10-25T23:59:59.999Z'),
      },
    );

    expect(result.map((value) => value.toISOString())).toEqual(['2026-10-25T00:30:00.000Z']);
  });

  it('rejects invalid expansion boundaries and recurrence input', () => {
    expect(() =>
      expandPublicationSchedule(recurrence(), {
        from: new Date('2026-07-02T00:00:00.000Z'),
        to: new Date('2026-07-01T00:00:00.000Z'),
      }),
    ).toThrow(RangeError);
    expect(() => expandPublicationSchedule(recurrence({ times: ['25:00'] }), window)).toThrow(
      RangeError,
    );
    expect(() =>
      expandPublicationSchedule(recurrence({ timezone: 'Invalid/Timezone' }), window),
    ).toThrow(RangeError);
  });
});
