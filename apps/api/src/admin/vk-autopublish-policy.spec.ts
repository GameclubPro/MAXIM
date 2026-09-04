import { buildVkAutoPublishScheduleFingerprint } from './vk-autopublish-policy';

describe('VK autopublish schedule policy', () => {
  const settings = {
    schedulerTimezone: 'Europe/Moscow',
    quietHoursStart: null,
    quietHoursEnd: null,
    workHoursStart: '09:00',
    workHoursEnd: '22:00',
    distributeEvenlyEnabled: true,
    roundRobinEnabled: true,
  };
  const source = {
    publishIntervalMinutes: 180,
    dailyLimit: 3,
    minPublishIntervalMinutes: 30,
    publishMode: 'QUEUE',
    priority: 'NORMAL',
    quietHoursStart: null,
    quietHoursEnd: null,
  };

  it('is stable for the same effective schedule policy', () => {
    expect(buildVkAutoPublishScheduleFingerprint(settings, source)).toBe(
      buildVkAutoPublishScheduleFingerprint({ ...settings }, { ...source }),
    );
    expect(buildVkAutoPublishScheduleFingerprint(settings, source)).toMatch(/^[a-f0-9]{32}$/u);
  });

  it.each([
    ['publish interval', { publishIntervalMinutes: 30 }],
    ['daily limit', { dailyLimit: 12 }],
    ['minimum pause', { minPublishIntervalMinutes: 15 }],
    ['publish mode', { publishMode: 'IMMEDIATE' }],
    ['priority', { priority: 'HIGH' }],
    ['source quiet hours', { quietHoursStart: '23:00', quietHoursEnd: '07:00' }],
  ])('changes when the source %s changes', (_label, patch) => {
    expect(buildVkAutoPublishScheduleFingerprint(settings, { ...source, ...patch })).not.toBe(
      buildVkAutoPublishScheduleFingerprint(settings, source),
    );
  });

  it.each([
    ['timezone', { schedulerTimezone: 'UTC' }],
    ['work hours', { workHoursStart: '08:00' }],
    ['global quiet hours', { quietHoursStart: '01:00', quietHoursEnd: '06:00' }],
    ['distribution', { distributeEvenlyEnabled: false }],
    ['round robin', { roundRobinEnabled: false }],
  ])('changes when the global %s changes', (_label, patch) => {
    expect(buildVkAutoPublishScheduleFingerprint({ ...settings, ...patch }, source)).not.toBe(
      buildVkAutoPublishScheduleFingerprint(settings, source),
    );
  });
});
