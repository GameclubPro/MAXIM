import { resolveModerationSanctionExpiry } from './moderation-sanction-expiry.util';

describe('shared moderation sanction expiry', () => {
  const createdAt = new Date('2026-10-01T10:00:00Z');
  it('gives absolute expiry precedence over delayed event persistence', () => {
    expect(
      resolveModerationSanctionExpiry(
        'MUTE',
        {
          muteDurationHours: 1,
          muteExpiresAt: '2026-10-01T10:30:00Z',
        },
        createdAt,
      ),
    ).toEqual({ permanent: false, expiresAt: new Date('2026-10-01T10:30:00Z') });
  });
  it('keeps permanent mutes and bans while supporting bounded legacy durations', () => {
    expect(
      resolveModerationSanctionExpiry('MUTE', { mutePermanent: true }, createdAt).permanent,
    ).toBe(true);
    expect(resolveModerationSanctionExpiry('BAN', {}, createdAt).permanent).toBe(true);
    expect(
      resolveModerationSanctionExpiry('BAN', { banDurationHours: 2 }, createdAt).expiresAt,
    ).toEqual(new Date('2026-10-01T12:00:00Z'));
    expect(
      resolveModerationSanctionExpiry('MUTE', { muteDurationHours: -1 }, createdAt).expiresAt,
    ).toBeNull();
  });
});
