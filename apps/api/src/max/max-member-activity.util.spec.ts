import { readMaxMemberActivity } from './max-member-activity.util';

const now = Date.parse('2026-09-12T12:00:00Z');
describe('MAX member activity', () => {
  it('reads documented millisecond timestamps at either roster shape', () => {
    expect(readMaxMemberActivity({ last_activity_time: now }, now)).toBe(
      '2026-09-12T12:00:00.000Z',
    );
    expect(readMaxMemberActivity({ user: { last_activity_time: now } }, now)).toBe(
      '2026-09-12T12:00:00.000Z',
    );
  });
  it.each([undefined, null, 0, -1, now / 1000, String(now), now + 1, NaN, Infinity])(
    'keeps missing, hidden and invalid values unknown: %s',
    (value) => {
      expect(readMaxMemberActivity({ last_activity_time: value }, now)).toBeNull();
    },
  );
  it('does not revive a hidden root field from nested historical data', () => {
    expect(
      readMaxMemberActivity({ last_activity_time: null, user: { last_activity_time: now } }, now),
    ).toBeNull();
  });
});
