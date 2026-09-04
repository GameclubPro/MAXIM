import {
  getVkAutoPublishLocalDayRange,
  isValidVkAutoPublishTimezone,
  isVkAutoPublishTimeAllowed,
  normalizeVkAutoPublishTimezone,
  planVkAutoPublishSourceSlots,
  resolveNextAllowedVkAutoPublishAt,
  resolveVkAutoPublishSourceSpacingMs,
  type VkAutoPublishTimingSettings,
  type VkAutoPublishTimingSource,
} from './vk-autopublish-timing';

const allDaySettings: VkAutoPublishTimingSettings = {
  schedulerTimezone: 'UTC',
  workHoursStart: '00:00',
  workHoursEnd: '00:00',
  quietHoursStart: null,
  quietHoursEnd: null,
  distributeEvenlyEnabled: true,
  roundRobinEnabled: true,
};

const source: VkAutoPublishTimingSource = {
  publishIntervalMinutes: 30,
  minPublishIntervalMinutes: 30,
  quietHoursStart: null,
  quietHoursEnd: null,
};

describe('VK autopublish timing', () => {
  it('normalizes IANA timezones with one stable Moscow fallback', () => {
    expect(isValidVkAutoPublishTimezone(' Europe/Moscow ')).toBe(true);
    expect(isValidVkAutoPublishTimezone('UTC')).toBe(true);
    expect(isValidVkAutoPublishTimezone('local')).toBe(false);
    expect(normalizeVkAutoPublishTimezone(' Asia/Yekaterinburg ')).toBe('Asia/Yekaterinburg');
    expect(normalizeVkAutoPublishTimezone('Invalid/Timezone')).toBe('Europe/Moscow');
    expect(normalizeVkAutoPublishTimezone(null, 'also-invalid')).toBe('Europe/Moscow');
  });

  it('converts a Moscow local day to a half-open UTC range', () => {
    const range = getVkAutoPublishLocalDayRange(
      new Date('2026-09-04T12:00:00.000Z'),
      'Europe/Moscow',
    );

    expect(range).toEqual({
      timezone: 'Europe/Moscow',
      start: new Date('2026-09-03T21:00:00.000Z'),
      end: new Date('2026-09-04T21:00:00.000Z'),
    });
  });

  it('keeps local day ranges DST-correct', () => {
    const spring = getVkAutoPublishLocalDayRange(
      new Date('2026-03-29T12:00:00.000Z'),
      'Europe/Berlin',
    );
    const fall = getVkAutoPublishLocalDayRange(
      new Date('2026-10-25T12:00:00.000Z'),
      'Europe/Berlin',
    );

    expect(spring.start.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(spring.end.toISOString()).toBe('2026-03-29T22:00:00.000Z');
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * 60 * 60_000);
    expect(fall.start.toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(fall.end.toISOString()).toBe('2026-10-25T23:00:00.000Z');
    expect(fall.end.getTime() - fall.start.getTime()).toBe(25 * 60 * 60_000);
  });

  it('uses the effective source spacing and applies interval changes immediately', () => {
    expect(
      resolveVkAutoPublishSourceSpacingMs(
        { distributeEvenlyEnabled: true },
        { publishIntervalMinutes: 180, minPublishIntervalMinutes: 30 },
      ),
    ).toBe(180 * 60_000);
    expect(
      resolveVkAutoPublishSourceSpacingMs(
        { distributeEvenlyEnabled: false },
        { publishIntervalMinutes: 180, minPublishIntervalMinutes: 30 },
      ),
    ).toBe(30 * 60_000);
    expect(
      resolveVkAutoPublishSourceSpacingMs(
        { distributeEvenlyEnabled: false },
        { publishIntervalMinutes: 180, minPublishIntervalMinutes: 0 },
      ),
    ).toBe(5 * 60_000);

    const common = {
      count: 2,
      now: new Date('2026-09-04T10:00:00.000Z'),
      lastSourceAt: new Date('2026-09-04T10:00:00.000Z'),
      existingChatSlots: [],
      settings: allDaySettings,
    };
    const oldSlots = planVkAutoPublishSourceSlots({
      ...common,
      source: { ...source, publishIntervalMinutes: 180 },
    });
    const newSlots = planVkAutoPublishSourceSlots({ ...common, source });

    expect(oldSlots.map((slot) => slot.toISOString())).toEqual([
      '2026-09-04T13:00:00.000Z',
      '2026-09-04T16:00:00.000Z',
    ]);
    expect(newSlots.map((slot) => slot.toISOString())).toEqual([
      '2026-09-04T10:30:00.000Z',
      '2026-09-04T11:00:00.000Z',
    ]);
  });

  it('resolves exact work starts in Moscow after local midnight', () => {
    const settings: VkAutoPublishTimingSettings = {
      ...allDaySettings,
      schedulerTimezone: 'Europe/Moscow',
      workHoursStart: '09:00',
      workHoursEnd: '22:00',
    };
    const localDay = getVkAutoPublishLocalDayRange(
      new Date('2026-09-04T12:00:00.000Z'),
      settings.schedulerTimezone,
    );

    expect(resolveNextAllowedVkAutoPublishAt(localDay.end, settings, source)?.toISOString()).toBe(
      '2026-09-05T06:00:00.000Z',
    );
    expect(
      resolveNextAllowedVkAutoPublishAt(
        new Date('2026-09-04T19:00:00.000Z'),
        settings,
        source,
      )?.toISOString(),
    ).toBe('2026-09-05T06:00:00.000Z');
  });

  it('respects global and source quiet hours inside the work window', () => {
    const settings: VkAutoPublishTimingSettings = {
      ...allDaySettings,
      workHoursStart: '09:00',
      workHoursEnd: '22:00',
      quietHoursStart: '12:00',
      quietHoursEnd: '13:00',
    };
    const quietSource = {
      ...source,
      quietHoursStart: '18:00',
      quietHoursEnd: '20:00',
    };

    expect(
      isVkAutoPublishTimeAllowed(new Date('2026-09-04T11:59:30.000Z'), settings, quietSource),
    ).toBe(true);
    expect(
      resolveNextAllowedVkAutoPublishAt(
        new Date('2026-09-04T12:00:00.000Z'),
        settings,
        quietSource,
      )?.toISOString(),
    ).toBe('2026-09-04T13:00:00.000Z');
    expect(
      resolveNextAllowedVkAutoPublishAt(
        new Date('2026-09-04T18:00:00.000Z'),
        settings,
        quietSource,
      )?.toISOString(),
    ).toBe('2026-09-04T20:00:00.000Z');
    expect(
      resolveNextAllowedVkAutoPublishAt(
        new Date('2026-09-04T22:00:00.000Z'),
        settings,
        quietSource,
      )?.toISOString(),
    ).toBe('2026-09-05T09:00:00.000Z');
  });

  it('returns no slot when quiet hours fully cover the work window', () => {
    expect(
      resolveNextAllowedVkAutoPublishAt(
        new Date('2026-09-04T10:00:00.000Z'),
        {
          ...allDaySettings,
          workHoursStart: '09:00',
          workHoursEnd: '18:00',
          quietHoursStart: '09:00',
          quietHoursEnd: '18:00',
        },
        source,
      ),
    ).toBeNull();
  });

  it('fills round-robin gaps instead of appending after the global queue maximum', () => {
    const slots = planVkAutoPublishSourceSlots({
      count: 3,
      now: new Date('2026-09-04T10:00:00.000Z'),
      lastSourceAt: null,
      existingChatSlots: [
        new Date('2026-09-04T10:00:00.000Z'),
        new Date('2026-09-04T10:31:00.000Z'),
        new Date('2026-09-04T13:00:00.000Z'),
      ],
      settings: allDaySettings,
      source,
    });

    expect(slots.map((slot) => slot.toISOString())).toEqual([
      '2026-09-04T10:01:00.000Z',
      '2026-09-04T10:32:00.000Z',
      '2026-09-04T11:02:00.000Z',
    ]);
    expect(slots.at(-1)!.getTime()).toBeLessThan(new Date('2026-09-04T13:00:00.000Z').getTime());
  });

  it('rechecks work hours after moving past an occupied round-robin slot', () => {
    const settings: VkAutoPublishTimingSettings = {
      ...allDaySettings,
      workHoursStart: '09:00',
      workHoursEnd: '22:00',
    };

    expect(
      planVkAutoPublishSourceSlots({
        count: 1,
        now: new Date('2026-09-04T21:59:30.000Z'),
        existingChatSlots: [new Date('2026-09-04T21:59:30.000Z')],
        settings,
        source,
      }).map((slot) => slot.toISOString()),
    ).toEqual(['2026-09-05T09:00:00.000Z']);
  });

  it('advances through a dense bounded queue without appending scans per collision', () => {
    const start = Date.parse('2026-09-04T10:00:00.000Z');
    const occupied = Array.from({ length: 5_000 }, (_, index) => new Date(start + index * 60_000));

    expect(
      planVkAutoPublishSourceSlots({
        count: 1,
        now: new Date(start),
        existingChatSlots: occupied,
        settings: allDaySettings,
        source,
      })[0]?.toISOString(),
    ).toBe('2026-09-07T21:20:00.000Z');
  });

  it('advances through a DST spring gap using the next real allowed local minute', () => {
    const settings: VkAutoPublishTimingSettings = {
      ...allDaySettings,
      schedulerTimezone: 'Europe/Berlin',
      workHoursStart: '02:30',
      workHoursEnd: '03:30',
    };

    expect(
      resolveNextAllowedVkAutoPublishAt(
        new Date('2026-03-29T00:30:00.000Z'),
        settings,
        source,
      )?.toISOString(),
    ).toBe('2026-03-29T01:00:00.000Z');
  });
});
