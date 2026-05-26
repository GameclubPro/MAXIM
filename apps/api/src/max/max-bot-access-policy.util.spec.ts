import { ChatBotMembershipRole, ChatBotMembershipStatus } from '../prisma/prisma-client';
import {
  calculatePrimaryPermissionScore,
  membershipExplicitlyLacksAccess,
  normalizeMembershipAccessSnapshot,
  normalizePermissionName,
  resolvePreferredPrimaryBotId,
} from './max-bot-access-policy.util';

describe('max bot access policy', () => {
  it('normalizes permissions from MAX snapshots consistently', () => {
    expect(normalizePermissionName('Can Edit-Link')).toBe('can_edit_link');
    expect(
      normalizeMembershipAccessSnapshot({
        isAdmin: true,
        isOwner: false,
        permissions: ['Delete Messages', 'delete-messages', '', null, 'Can Edit-Link'],
      }),
    ).toEqual({
      isAdmin: true,
      isOwner: false,
      permissions: ['delete_messages', 'can_edit_link'],
    });
    expect(calculatePrimaryPermissionScore(['edit-link', 'can edit link', 'unknown'])).toBe(2_000);
  });

  it('only treats explicit non-admin snapshots as lacking access', () => {
    expect(membershipExplicitlyLacksAccess(null)).toBe(false);
    expect(
      membershipExplicitlyLacksAccess({
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
    ).toBe(true);
    expect(
      membershipExplicitlyLacksAccess({
        isAdmin: false,
        isOwner: true,
        permissions: [],
      }),
    ).toBe(false);
  });

  it('keeps current primary when there are no permission snapshots', () => {
    expect(
      resolvePreferredPrimaryBotId('primary-bot', [
        {
          botId: 'primary-bot',
          role: ChatBotMembershipRole.PRIMARY,
          status: ChatBotMembershipStatus.ACTIVE,
        },
        {
          botId: 'standby-bot',
          role: ChatBotMembershipRole.STANDBY,
          status: ChatBotMembershipStatus.ACTIVE,
        },
      ]),
    ).toBe('primary-bot');
  });

  it('selects the active bot with stronger confirmed access', () => {
    expect(
      resolvePreferredPrimaryBotId('primary-bot', [
        {
          botId: 'primary-bot',
          role: ChatBotMembershipRole.PRIMARY,
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: {
            isAdmin: true,
            isOwner: false,
            permissions: ['read_all_messages'],
          },
        },
        {
          botId: 'standby-bot',
          role: ChatBotMembershipRole.STANDBY,
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: {
            isAdmin: true,
            isOwner: false,
            permissions: ['read_all_messages', 'delete_messages', 'add_remove_members'],
          },
        },
      ]),
    ).toBe('standby-bot');
  });

  it('prefers owner access and ignores removed memberships', () => {
    expect(
      resolvePreferredPrimaryBotId('primary-bot', [
        {
          botId: 'removed-owner-bot',
          role: ChatBotMembershipRole.STANDBY,
          status: ChatBotMembershipStatus.REMOVED,
          permissionsSnapshot: {
            isAdmin: true,
            isOwner: true,
            permissions: ['delete_messages'],
          },
        },
        {
          botId: 'owner-bot',
          role: ChatBotMembershipRole.STANDBY,
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: {
            isAdmin: false,
            isOwner: true,
            permissions: [],
          },
        },
        {
          botId: 'primary-bot',
          role: ChatBotMembershipRole.PRIMARY,
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: {
            isAdmin: true,
            isOwner: false,
            permissions: ['add_remove_members'],
          },
        },
      ]),
    ).toBe('owner-bot');
  });
});
