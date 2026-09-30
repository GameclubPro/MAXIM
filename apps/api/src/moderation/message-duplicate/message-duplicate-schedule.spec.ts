import { duplicateSettings } from './message-duplicate-test-fixtures';
import { isDuplicateScheduleOpen, resolveDuplicateDailyWindow } from './message-duplicate-schedule';
import {
  exactImageSettingsDigest,
  messageDuplicateSettingsDigest,
} from './message-duplicate-state';

const ms = (iso: string) => Date.parse(iso);
const daily = (overrides = {}) => duplicateSettings({ duplicateWindowMode: 'DAILY', ...overrides });

describe('duplicate daily periods', () => {
  it('keeps interval mode independent of dormant schedule settings', () => {
    expect(
      resolveDuplicateDailyWindow(duplicateSettings(), ms('2026-09-29T01:00Z')),
    ).toBeUndefined();
    for (const digest of [messageDuplicateSettingsDigest, exactImageSettingsDigest]) {
      expect(digest(duplicateSettings({ duplicateStartTimeMinutes: 5 }))).toBe(
        digest(duplicateSettings()),
      );
      expect(digest(daily())).not.toBe(digest(duplicateSettings()));
      expect(digest(daily({ duplicateTimezone: 'Asia/Tokyo' }))).not.toBe(digest(daily()));
    }
  });

  it('includes start and excludes end in the selected timezone', () => {
    const settings = daily();
    expect(resolveDuplicateDailyWindow(settings, ms('2026-09-29T05:59:59.999Z'))).toBeNull();
    expect(resolveDuplicateDailyWindow(settings, ms('2026-09-29T06:00Z'))).toEqual({
      startMs: ms('2026-09-29T06:00Z'),
      endMs: ms('2026-09-29T15:00Z'),
    });
    expect(resolveDuplicateDailyWindow(settings, ms('2026-09-29T15:00Z'))).toBeNull();
    expect(
      resolveDuplicateDailyWindow(
        daily({ duplicateTimezone: 'Asia/Kathmandu' }),
        ms('2026-09-29T03:15Z'),
      )?.startMs,
    ).toBe(ms('2026-09-29T03:15Z'));
  });

  it('uses the same normalized timezone for admission and policy digests', () => {
    const settings = daily();
    const equivalent = daily({ duplicateTimezone: '  europe/MOSCOW  ' });
    const atMs = ms('2026-09-29T06:00Z');
    expect(resolveDuplicateDailyWindow(equivalent, atMs)).toEqual(
      resolveDuplicateDailyWindow(settings, atMs),
    );
    expect(isDuplicateScheduleOpen(equivalent, atMs, ms('2026-09-29T14:59Z'))).toBe(true);
    expect(isDuplicateScheduleOpen(equivalent, atMs, ms('2026-09-29T15:00Z'))).toBe(false);
    for (const digest of [messageDuplicateSettingsDigest, exactImageSettingsDigest])
      expect(digest(equivalent)).toBe(digest(settings));
  });

  it('keeps an overnight period intact across month/year boundaries', () => {
    const settings = daily({ duplicateStartTimeMinutes: 22 * 60, duplicateEndTimeMinutes: 8 * 60 });
    expect(resolveDuplicateDailyWindow(settings, ms('2027-01-01T02:00Z'))).toEqual({
      startMs: ms('2026-12-31T19:00Z'),
      endMs: ms('2027-01-01T05:00Z'),
    });
    expect(resolveDuplicateDailyWindow(settings, ms('2027-01-01T05:00Z'))).toBeNull();
  });

  it('does not let delayed jobs enter a later daily period', () => {
    expect(isDuplicateScheduleOpen(daily(), ms('2026-09-29T06:00Z'), ms('2026-09-29T14:59Z'))).toBe(
      true,
    );
    expect(isDuplicateScheduleOpen(daily(), ms('2026-09-29T06:00Z'), ms('2026-09-29T15:00Z'))).toBe(
      false,
    );
    expect(isDuplicateScheduleOpen(daily(), ms('2026-09-29T06:00Z'), ms('2026-09-30T06:00Z'))).toBe(
      false,
    );
    expect(isDuplicateScheduleOpen(daily(), ms('2026-09-29T05:59Z'), ms('2026-09-29T06:00Z'))).toBe(
      false,
    );
  });

  it.each([
    { duplicateStartTimeMinutes: 1080 },
    { duplicateStartTimeMinutes: -1 },
    { duplicateEndTimeMinutes: 1440 },
    { duplicateTimezone: 'invalid/zone' },
  ])('rejects invalid stored schedules %j', (overrides) => {
    expect(resolveDuplicateDailyWindow(daily(overrides), ms('2026-09-29T07:00Z'))).toBeNull();
  });

  it('uses one continuous period across repeated autumn clock times', () => {
    const settings = daily({
      duplicateTimezone: 'Europe/Berlin',
      duplicateStartTimeMinutes: 150,
      duplicateEndTimeMinutes: 165,
    });
    const expected = { startMs: ms('2026-10-25T00:30Z'), endMs: ms('2026-10-25T01:45Z') };
    for (const at of ['2026-10-25T00:30Z', '2026-10-25T01:10Z', '2026-10-25T01:44:59Z']) {
      expect(resolveDuplicateDailyWindow(settings, ms(at))).toEqual(expected);
    }
    expect(resolveDuplicateDailyWindow(settings, expected.endMs)).toBeNull();
  });

  it('advances missing spring times and skips a collapsed period', () => {
    const settings = daily({
      duplicateTimezone: 'Europe/Berlin',
      duplicateStartTimeMinutes: 150,
      duplicateEndTimeMinutes: 240,
    });
    expect(resolveDuplicateDailyWindow(settings, ms('2026-03-29T01:30Z'))).toEqual({
      startMs: ms('2026-03-29T01:30Z'),
      endMs: ms('2026-03-29T02:00Z'),
    });
    expect(
      resolveDuplicateDailyWindow(
        { ...settings, duplicateEndTimeMinutes: 180 },
        ms('2026-03-29T01:45Z'),
      ),
    ).toBeNull();
  });
});
