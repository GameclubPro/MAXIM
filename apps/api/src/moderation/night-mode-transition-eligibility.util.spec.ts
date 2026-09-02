import { ChatBotAccessState, ChatBotMembershipStatus } from '../prisma/prisma-client';
import { isNightModeTransitionMembershipCandidate } from './night-mode-transition-eligibility.util';

describe('night mode transition membership eligibility', () => {
  it.each([
    {
      name: 'explicit non-admin snapshot',
      permissionsSnapshot: {
        checkedAt: '2026-09-02T10:00:00.000Z',
        isAdmin: false,
        isOwner: false,
        permissions: ['write'],
      },
      expected: false,
    },
    {
      name: 'null snapshot',
      permissionsSnapshot: null,
      expected: true,
    },
    {
      name: 'unknown snapshot',
      permissionsSnapshot: 'unknown',
      expected: true,
    },
    {
      name: 'admin snapshot without specific write permissions',
      permissionsSnapshot: {
        checkedAt: '2026-09-02T10:00:00.000Z',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      },
      expected: true,
    },
  ])(
    'returns $expected for an active candidate with $name',
    ({ permissionsSnapshot, expected }) => {
      expect(
        isNightModeTransitionMembershipCandidate({
          botId: 'bot-1',
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
          permissionsSnapshot,
        }),
      ).toBe(expected);
    },
  );
});
