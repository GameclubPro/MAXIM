import { normalizePublicationSchedule } from './publication-schedule-normalization';
import { expandPublicationSchedule } from './publication-recurrence';
import type { PublicationScheduleInput } from '@maxim/contracts/publication';

const now = new Date('2026-09-18T00:00:00Z');
const normalize = (schedule: PublicationScheduleInput) =>
  normalizePublicationSchedule(schedule, now, 0);

describe('minute-precision publication schedules', () => {
  it.each(['00', '01', '17', '29', '30', '45', '59'])(
    'preserves minute %s in once and slot schedules',
    (minute) => {
      const at = `2026-09-19T23:${minute}:00+03:00`;
      expect(
        normalize({ mode: 'once', timezone: 'Europe/Moscow', at, replaceConflicts: false }),
      ).toMatchObject({ at });
      expect(
        normalize({
          mode: 'slots',
          timezone: 'Europe/Moscow',
          slots: [at],
          replaceConflicts: false,
        }),
      ).toMatchObject({ slots: [at] });
    },
  );

  it('expands arbitrary minutes without rounding in a non-hour-offset timezone', () => {
    const rule = normalize({
      mode: 'recurrence',
      timezone: 'Asia/Kathmandu',
      frequency: 'daily',
      interval: 1,
      weekdays: [],
      times: ['09:17', '23:59'],
      startsAt: null,
      endsAt: null,
      maxOccurrences: 2,
      replaceConflicts: false,
    });
    expect(
      expandPublicationSchedule(rule, { now, from: now, to: new Date('2026-09-19T00:00:00Z') }).map(
        (date) => date.toISOString(),
      ),
    ).toEqual(['2026-09-18T03:32:00.000Z', '2026-09-18T18:14:00.000Z']);
  });

  it.each(['2026-09-19T09:17:01Z', '2026-09-19T09:17:00.001Z'])(
    'still rejects sub-minute timestamps %s',
    (at) => {
      expect(() =>
        normalize({ mode: 'once', timezone: 'UTC', at, replaceConflicts: false }),
      ).toThrow('без секунд');
      expect(() =>
        normalize({ mode: 'slots', timezone: 'UTC', slots: [at], replaceConflicts: false }),
      ).toThrow('без секунд');
    },
  );

  it('still rejects past times and invalid timezones', () => {
    expect(() =>
      normalize({
        mode: 'once',
        timezone: 'UTC',
        at: '2026-09-17T23:59:00Z',
        replaceConflicts: false,
      }),
    ).toThrow('уже прошло');
    expect(() => normalize({ mode: 'now', timezone: 'Invalid/Zone' })).toThrow('часовой пояс');
  });
});
