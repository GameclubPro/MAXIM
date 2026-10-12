import { ChatBotAccessState, ChatBotMembershipStatus } from '../prisma/prisma-client';
import { MAJOR_EXPLICIT_ACTIVATION_PENDING_SOURCE } from '../max/managed-entity-activation.util';
import {
  hasNightModeTransitionMembershipCandidate,
  isNightModeTransitionMembershipCandidate,
} from './night-mode-transition-eligibility.util';

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

  const activated = {
    botId: 'bot-1',
    status: ChatBotMembershipStatus.ACTIVE,
    botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
    botAccessSource: 'explicit_start',
    permissionsSnapshot: {
      checkedAt: '2026-09-02T10:00:00.000Z',
      isAdmin: true,
      isOwner: false,
      permissionsKnown: true,
      permissions: ['read_all_messages', 'write'],
      activationCapabilityCeiling: ['moderation', 'delete_message', 'send_message'],
    },
  };

  it.each([
    [
      'pending activation',
      { ...activated, botAccessSource: MAJOR_EXPLICIT_ACTIVATION_PENDING_SOURCE },
    ],
    [
      'known missing baseline',
      {
        ...activated,
        permissionsSnapshot: { ...activated.permissionsSnapshot, permissions: ['write'] },
      },
    ],
    [
      'retained send denial',
      {
        ...activated,
        permissionsSnapshot: {
          ...activated.permissionsSnapshot,
          activationCapabilityCeiling: ['moderation', 'delete_message'],
        },
      },
    ],
    [
      'malformed ceiling',
      {
        ...activated,
        permissionsSnapshot: {
          ...activated.permissionsSnapshot,
          activationCapabilityCeiling: 'send_message',
        },
      },
    ],
    [
      'known missing send rights',
      {
        ...activated,
        permissionsSnapshot: {
          ...activated.permissionsSnapshot,
          permissions: ['read_all_messages', 'can_post_edit_delete_message'],
        },
      },
    ],
  ])('does not schedule %s but retains a separately activated peer', (_name, denied) => {
    expect(isNightModeTransitionMembershipCandidate(denied)).toBe(false);
    expect(hasNightModeTransitionMembershipCandidate([denied])).toBe(false);
    expect(
      hasNightModeTransitionMembershipCandidate([denied, { ...activated, botId: 'peer' }]),
    ).toBe(true);
  });

  it('keeps expired positive snapshots eligible for a guarded refresh', () => {
    expect(isNightModeTransitionMembershipCandidate(activated)).toBe(true);
  });
});
