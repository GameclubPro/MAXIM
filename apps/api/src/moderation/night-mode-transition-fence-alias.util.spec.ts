import { buildNightModeTransitionJobId } from './night-mode-transition.queue';
import { matchesNightModeTransitionFenceAlias } from './night-mode-transition-fence-alias.util';

describe('negative merged-session effect fences', () => {
  it.each(['close', 'open'] as const)(
    'retains the old %s member identity only as a denial',
    (transition) => {
      const owner = 'v1:Europe/Berlin:03:00:02:30:2026-03-28';
      const member = 'v1:Europe/Berlin:03:00:02:30:2026-03-29';
      const currentTime =
        transition === 'close' ? '2026-03-28T02:00:00.000Z' : '2026-03-30T00:30:00.000Z';
      const legacyTime =
        transition === 'close' ? '2026-03-29T01:00:00.000Z' : '2026-03-30T00:30:00.000Z';
      const current = {
        chatId: 'chat',
        transition,
        sessionKey: owner,
        jobId: buildNightModeTransitionJobId('chat', transition, currentTime, owner),
      };
      expect(
        matchesNightModeTransitionFenceAlias(current, {
          sessionKey: member,
          jobId: buildNightModeTransitionJobId('chat', transition, legacyTime, member),
        }),
      ).toBe(true);
      expect(
        matchesNightModeTransitionFenceAlias(current, {
          sessionKey: member,
          jobId: buildNightModeTransitionJobId('other-chat', transition, legacyTime, member),
        }),
      ).toBe(false);
      expect(
        matchesNightModeTransitionFenceAlias(current, {
          sessionKey: member,
          jobId: buildNightModeTransitionJobId(
            'chat',
            transition === 'close' ? 'open' : 'close',
            legacyTime,
            member,
          ),
        }),
      ).toBe(false);
    },
  );

  it('retains an exact old fold timestamp without accepting arbitrary times', () => {
    const key = 'v1:Europe/Berlin:23:00:02:30:2026-10-24';
    const current = {
      chatId: 'chat',
      transition: 'open' as const,
      sessionKey: key,
      jobId: buildNightModeTransitionJobId('chat', 'open', '2026-10-25T00:30:00.000Z', key),
    };
    expect(
      matchesNightModeTransitionFenceAlias(current, {
        sessionKey: key,
        jobId: buildNightModeTransitionJobId('chat', 'open', '2026-10-25T01:30:00.000Z', key),
      }),
    ).toBe(true);
    expect(
      matchesNightModeTransitionFenceAlias(current, {
        sessionKey: key,
        jobId: buildNightModeTransitionJobId('chat', 'open', '2026-10-25T01:31:00.000Z', key),
      }),
    ).toBe(false);
  });
});
