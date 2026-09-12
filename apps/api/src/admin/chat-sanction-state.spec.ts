import { resolveSanctionState, type SanctionFeedRow } from './chat-sanction-state';

const now = Date.parse('2026-09-12T12:00:00Z');
const row = (overrides: Partial<SanctionFeedRow> = {}): SanctionFeedRow => ({
  id: 's1',
  userId: 'u1',
  userDisplayName: 'Name',
  action: 'BAN',
  ruleCode: 'MANUAL_BAN',
  operator: 'ADMIN',
  metadata: {},
  createdAt: new Date(now - 500 * 86_400_000),
  nextEventAt: null,
  nextRuleCode: null,
  sourceExists: true,
  ...overrides,
});

describe('sanction registry state', () => {
  it('does not put an active old ban or permanent mute into an age-based archive', () => {
    expect(resolveSanctionState(row(), now)).toMatchObject({
      status: 'active',
      permanent: true,
      releaseAction: 'UNBAN',
    });
    expect(
      resolveSanctionState(row({ action: 'MUTE', metadata: { mutePermanent: true } }), now),
    ).toMatchObject({ status: 'active', permanent: true, releaseAction: 'UNMUTE' });
  });
  it('expires timed local mutes from stored dates', () => {
    expect(
      resolveSanctionState(
        row({ action: 'MUTE', metadata: { muteExpiresAt: new Date(now - 1).toISOString() } }),
        now,
      ),
    ).toMatchObject({ status: 'expired', releaseAction: null });
  });
  it('uses a stored duration without consulting current chat settings', () => {
    expect(
      resolveSanctionState(
        row({
          action: 'MUTE',
          createdAt: new Date(now - 3600_000),
          metadata: { muteDurationHours: 3 },
        }),
        now,
      ),
    ).toMatchObject({ status: 'active', expiresAt: new Date(now + 2 * 3600_000).toISOString() });
  });
  it('distinguishes release, replacement and expiry before a later event', () => {
    expect(
      resolveSanctionState(row({ nextEventAt: new Date(now), nextRuleCode: 'MANUAL_UNBAN' }), now)
        .status,
    ).toBe('released');
    expect(
      resolveSanctionState(row({ nextEventAt: new Date(now), nextRuleCode: 'MANUAL_MUTE' }), now)
        .status,
    ).toBe('replaced');
    expect(
      resolveSanctionState(
        row({
          action: 'MUTE',
          metadata: { muteExpiresAt: new Date(now - 1000).toISOString() },
          nextEventAt: new Date(now),
          nextRuleCode: 'MANUAL_UNMUTE',
        }),
        now,
      ).status,
    ).toBe('expired');
  });
  it('does not invent missing source state, duration or confirmation', () => {
    for (const overrides of [
      { sourceExists: false },
      { action: 'MUTE' as const },
      { metadata: { sanctionApplied: false } },
    ]) {
      expect(resolveSanctionState(row(overrides), now)).toMatchObject({
        status: 'review',
        releaseAction: null,
      });
    }
  });
});
