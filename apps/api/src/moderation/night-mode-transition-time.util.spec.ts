import { DateTime } from 'luxon';
import {
  NIGHT_MODE_CALENDAR_CACHE_LIMIT,
  resolveNightModeCalendar,
} from './night-mode-calendar.util';
import {
  resolveCurrentNightModeCloseOccurrence,
  resolveCurrentNightModeOpenOccurrence,
  resolveEffectiveChatClosure,
  resolveLatestNightModeTransitionOccurrences,
  resolveNextNightModeTransitionOccurrences,
  resolveNightModeNoticeCatchUpWindow,
  resolveNightModeTransitionSessionAliases,
  resolveNightModeTransitionSessionOpenAt,
  resolveNightModeTransitionSnapshot,
} from './night-mode-transition-time.util';
import { matchesNightModeRecoveryBoundaryTime } from './night-mode-recovery-time-compat.util';

const schedule = (start: number, end: number, timezone = 'Europe/Berlin') => ({
  nightModeEnabled: true,
  nightModeStartTimeMinutes: start,
  nightModeEndTimeMinutes: end,
  nightModeTimezone: timezone,
});
const instant = (value: string) => new Date(value);
const manualOff = {
  nightModeForceCloseEnabled: false,
  nightModeForceCloseForever: false,
  nightModeForceCloseUntil: '',
};

describe('absolute night calendar', () => {
  it('closes at the first repeated local time and remains closed through the second hour', () => {
    const settings = schedule(150, 480);
    for (const at of ['2026-10-25T00:30Z', '2026-10-25T00:45Z', '2026-10-25T01:15Z']) {
      expect(resolveNightModeTransitionSnapshot(settings, instant(at))?.status).toBe('closed');
      expect(
        resolveCurrentNightModeCloseOccurrence(settings, instant(at))?.dueAt.toISOString(),
      ).toBe('2026-10-25T00:30:00.000Z');
    }
    expect(
      resolveNightModeTransitionSnapshot(settings, instant('2026-10-25T01:30Z'))?.isCloseBoundary,
    ).toBe(false);
    expect(resolveNightModeTransitionSnapshot(settings, instant('2026-10-25T07:00Z'))?.status).toBe(
      'open',
    );
  });

  it('opens at the first repeated local time without reclosing in the repeated hour', () => {
    const settings = schedule(1380, 150);
    expect(
      resolveNightModeTransitionSnapshot(settings, instant('2026-10-25T00:29:59.999Z'))?.status,
    ).toBe('closed');
    expect(
      resolveCurrentNightModeOpenOccurrence(
        settings,
        instant('2026-10-25T01:15Z'),
      )?.dueAt.toISOString(),
    ).toBe('2026-10-25T00:30:00.000Z');
    expect(
      resolveNightModeTransitionSnapshot(settings, instant('2026-10-25T01:30Z'))?.isOpenBoundary,
    ).toBe(false);
  });

  it('moves a missing boundary by the spring gap for both scheduling and enforcement', () => {
    const settings = schedule(150, 480);
    expect(resolveNightModeTransitionSnapshot(settings, instant('2026-03-29T01:00Z'))?.status).toBe(
      'open',
    );
    expect(
      resolveNextNightModeTransitionOccurrences(
        settings,
        instant('2026-03-29T01:00Z'),
      )[0]?.dueAt.toISOString(),
    ).toBe('2026-03-29T01:30:00.000Z');
    expect(
      resolveNightModeTransitionSnapshot(settings, instant('2026-03-29T01:30Z')),
    ).toMatchObject({ status: 'closed', isCloseBoundary: true });
  });

  it('skips an interval inverted by the spring gap', () => {
    const settings = schedule(150, 180);
    const now = instant('2026-03-29T01:30Z');
    expect(resolveNightModeTransitionSnapshot(settings, now)?.status).toBe('open');
    expect(resolveLatestNightModeTransitionOccurrences(settings, now).close?.sessionKey).toBe(
      'v1:Europe/Berlin:02:30:03:00:2026-03-28',
    );
    expect(resolveNextNightModeTransitionOccurrences(settings, now)[0]?.dueAt.toISOString()).toBe(
      '2026-03-30T00:30:00.000Z',
    );
  });

  it('merges adjacent closures without interior notices and retains the first session identity', () => {
    const settings = schedule(180, 150);
    const key = 'v1:Europe/Berlin:03:00:02:30:2026-03-28';
    for (const at of ['2026-03-29T01:00Z', '2026-03-29T01:30Z']) {
      expect(resolveNightModeTransitionSnapshot(settings, instant(at))).toMatchObject({
        status: 'closed',
        sessionKey: key,
        isCloseBoundary: false,
        isOpenBoundary: false,
      });
    }
    expect(resolveNightModeTransitionSessionOpenAt(key)?.toISOString()).toBe(
      '2026-03-30T00:30:00.000Z',
    );
    expect(resolveNightModeTransitionSessionAliases(key)).toEqual([
      key,
      'v1:Europe/Berlin:03:00:02:30:2026-03-29',
    ]);
    expect(
      resolveCurrentNightModeOpenOccurrence(settings, instant('2026-03-30T00:30Z'))?.sessionKey,
    ).toBe(key);
  });

  it('handles a 30-minute Lord Howe gap and fold', () => {
    const settings = schedule(135, 480, 'Australia/Lord_Howe');
    expect(
      resolveNextNightModeTransitionOccurrences(
        settings,
        instant('2026-10-03T15:00Z'),
      )[0]?.dueAt.toISOString(),
    ).toBe('2026-10-03T15:45:00.000Z');
    const folded = schedule(105, 480, 'Australia/Lord_Howe');
    expect(
      resolveCurrentNightModeCloseOccurrence(
        folded,
        instant('2026-04-04T15:10Z'),
      )?.dueAt.toISOString(),
    ).toBe('2026-04-04T14:45:00.000Z');
  });

  it.each(['Europe/Moscow', 'Europe/Kaliningrad', 'Asia/Kamchatka', 'UTC'])(
    'keeps ordinary %s session keys and half-open boundaries',
    (timezone) => {
      const settings = schedule(1380, 480, timezone);
      const next = resolveNextNightModeTransitionOccurrences(
        settings,
        instant('2026-11-15T12:00Z'),
      );
      for (const item of next) {
        expect(item.sessionKey).toContain(`v1:${timezone}:23:00:08:00:`);
        expect(resolveNightModeTransitionSnapshot(settings, item.dueAt)?.status).toBe(
          item.transition === 'close' ? 'closed' : 'open',
        );
        expect(
          resolveNightModeTransitionSnapshot(settings, new Date(item.dueAt.getTime() - 1))?.status,
        ).toBe(item.transition === 'close' ? 'open' : 'closed');
      }
    },
  );

  it('handles a skipped civil date without duplicate boundaries', () => {
    const settings = schedule(1380, 480, 'Pacific/Apia');
    const next = resolveNextNightModeTransitionOccurrences(settings, instant('2011-12-30T09:00Z'));
    expect(next).toHaveLength(2);
    expect(new Set(next.map((item) => item.dueAt.getTime())).size).toBe(2);
    for (const item of next)
      expect(resolveNightModeTransitionSnapshot(settings, item.dueAt)?.status).toBe(
        item.transition === 'close' ? 'closed' : 'open',
      );
  });

  it('keeps diagnostic geometry after disable and outside the OPEN catch-up window', () => {
    const settings = { ...schedule(1380, 480, 'UTC'), nightModeEnabled: false };
    const now = instant('2026-10-30T14:00Z');
    expect(resolveLatestNightModeTransitionOccurrences(settings, now)).toMatchObject({
      basis: 'current_schedule',
      open: { dueAt: instant('2026-10-30T08:00Z') },
    });
    expect(resolveCurrentNightModeOpenOccurrence(settings, now)).toBeNull();
    expect(
      resolveCurrentNightModeOpenOccurrence({ ...settings, nightModeEnabled: true }, now),
    ).toBeNull();
  });

  it('caps OPEN catch-up at the next CLOSE and otherwise includes the two-hour endpoint', () => {
    const settings = schedule(600, 480, 'UTC');
    const item = resolveLatestNightModeTransitionOccurrences(
      settings,
      instant('2026-10-30T09:00Z'),
    ).open!;
    expect(
      resolveNightModeNoticeCatchUpWindow(item, settings, instant('2026-10-30T10:00Z')).state,
    ).toBe('expired');
    const ordinary = schedule(1380, 480, 'UTC');
    expect(
      resolveNightModeNoticeCatchUpWindow(item, ordinary, instant('2026-10-30T10:00Z')).state,
    ).toBe('expired');
    const ordinaryItem = resolveLatestNightModeTransitionOccurrences(
      ordinary,
      instant('2026-10-30T09:00Z'),
    ).open!;
    expect(
      resolveNightModeNoticeCatchUpWindow(ordinaryItem, ordinary, instant('2026-10-30T10:00Z'))
        .state,
    ).toBe('within_window');
  });

  it('keeps manual and night switches independent and reports effective reopening', () => {
    const settings = {
      ...schedule(1380, 480, 'UTC'),
      ...manualOff,
      nightModeForceCloseEnabled: true,
      nightModeForceCloseUntil: '2026-10-30T05:00:00Z',
    };
    const now = instant('2026-10-30T04:00Z');
    expect(resolveEffectiveChatClosure(settings, now)).toMatchObject({
      closed: true,
      restriction: 'manual',
      night: { status: 'closed' },
      opensAt: instant('2026-10-30T08:00Z'),
    });
    expect(resolveEffectiveChatClosure({ ...settings, ...manualOff }, now).restriction).toBe(
      'night',
    );
    expect(
      resolveEffectiveChatClosure({ ...settings, nightModeEnabled: false }, now).restriction,
    ).toBe('manual');
    expect(
      resolveEffectiveChatClosure({ ...settings, nightModeForceCloseForever: true }, now).opensAt,
    ).toBeNull();
    expect(resolveEffectiveChatClosure({ ...schedule(300, 300), ...manualOff }, now)).toMatchObject(
      { closed: true, boundary: 'continuous', opensAt: null, nextTransitionAt: null },
    );
  });

  it('reads exact legacy times only through the recovery compatibility helper', () => {
    const key = 'v1:Europe/Berlin:23:00:02:30:2026-10-24';
    expect(resolveNightModeTransitionSessionOpenAt(key)?.toISOString()).toBe(
      '2026-10-25T00:30:00.000Z',
    );
    expect(
      matchesNightModeRecoveryBoundaryTime({
        sessionKey: key,
        transition: 'open',
        scheduledFor: '2026-10-25T01:30:00.000Z',
      }),
    ).toBe(true);
    expect(
      matchesNightModeRecoveryBoundaryTime({
        sessionKey: key,
        transition: 'open',
        scheduledFor: '2026-10-25T01:30:01.000Z',
      }),
    ).toBe(false);
  });
});

describe('bounded calendar cache', () => {
  afterEach(() => jest.restoreAllMocks());
  it('reuses geometry but recalculates state across boundaries and forward/backward clocks', () => {
    const settings = schedule(121, 481, 'UTC');
    const spy = jest.spyOn(DateTime, 'fromObject');
    expect(resolveNightModeTransitionSnapshot(settings, instant('2033-03-10T02:00Z'))?.status).toBe(
      'open',
    );
    const coldCalls = spy.mock.calls.length;
    expect(coldCalls).toBeGreaterThan(0);
    expect(resolveNightModeTransitionSnapshot(settings, instant('2033-03-10T02:01Z'))?.status).toBe(
      'closed',
    );
    expect(resolveNightModeTransitionSnapshot(settings, instant('2033-03-10T02:00Z'))?.status).toBe(
      'open',
    );
    expect(spy).toHaveBeenCalledTimes(coldCalls);
    resolveNightModeTransitionSnapshot(settings, instant('2033-05-10T02:00Z'));
    expect(spy.mock.calls.length).toBeGreaterThan(coldCalls);
    const futureCalls = spy.mock.calls.length;
    resolveNightModeTransitionSnapshot(settings, instant('2033-03-10T02:00Z'));
    expect(spy.mock.calls.length).toBeGreaterThan(futureCalls);
    expect(
      resolveNightModeTransitionSnapshot(
        { ...settings, nightModeStartTimeMinutes: 119 },
        instant('2033-03-10T02:00Z'),
      )?.status,
    ).toBe('closed');
  });
  it('evicts old geometries at the configured bound and protects cached interval data', () => {
    const at = Date.parse('2034-04-10T12:00Z');
    const value = { timezone: 'UTC', startMinutes: 1, endMinutes: 1000 };
    const windows = resolveNightModeCalendar(value, at);
    expect(Object.isFrozen(windows)).toBe(true);
    expect(Object.isFrozen(windows[0]?.memberDateKeys)).toBe(true);
    for (let offset = 2; offset <= NIGHT_MODE_CALENDAR_CACHE_LIMIT + 1; offset += 1)
      resolveNightModeCalendar({ ...value, startMinutes: offset }, at);
    const spy = jest.spyOn(DateTime, 'fromObject');
    resolveNightModeCalendar(value, at);
    expect(spy).toHaveBeenCalled();
  });
});
