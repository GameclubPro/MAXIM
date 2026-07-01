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
        checkedAt: '2026-05-09T10:00:00.000Z',
        isAdmin: true,
        isOwner: false,
        permissions: ['Delete Messages', 'delete-messages', '', null, 'Can Edit-Link'],
      }),
    ).toEqual({
      checkedAt: '2026-05-09T10:00:00.000Z',
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

  it('does not let permission aliases override an explicit non-admin snapshot', () => {
    expect(
      resolvePreferredPrimaryBotId('primary-bot', [
        {
          botId: 'primary-bot',
          role: ChatBotMembershipRole.PRIMARY,
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: {
            isAdmin: true,
            isOwner: false,
            permissions: [],
          },
        },
        {
          botId: 'standby-bot',
          role: ChatBotMembershipRole.STANDBY,
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: {
            isAdmin: false,
            isOwner: false,
            permissions: ['delete_messages', 'add_remove_members'],
          },
        },
      ]),
    ).toBe('primary-bot');
  });

  it('uses deterministic tie-breakers when access scores are equal', () => {
    const equalPrimarySnapshot = {
      isAdmin: true,
      isOwner: false,
      permissions: ['delete_messages'],
    };

    expect(
      resolvePreferredPrimaryBotId('current-bot', [
        {
          botId: 'current-bot',
          role: ChatBotMembershipRole.STANDBY,
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: equalPrimarySnapshot,
        },
        {
          botId: 'role-primary-bot',
          role: ChatBotMembershipRole.PRIMARY,
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: equalPrimarySnapshot,
        },
      ]),
    ).toBe('current-bot');

    expect(
      resolvePreferredPrimaryBotId(null, [
        {
          botId: 'first-standby-bot',
          role: ChatBotMembershipRole.STANDBY,
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: equalPrimarySnapshot,
        },
        {
          botId: 'role-primary-bot',
          role: ChatBotMembershipRole.PRIMARY,
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: equalPrimarySnapshot,
        },
      ]),
    ).toBe('role-primary-bot');

    expect(
      resolvePreferredPrimaryBotId(null, [
        {
          botId: 'first-standby-bot',
          role: ChatBotMembershipRole.STANDBY,
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: equalPrimarySnapshot,
        },
        {
          botId: 'second-standby-bot',
          role: ChatBotMembershipRole.STANDBY,
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: equalPrimarySnapshot,
        },
      ]),
    ).toBe('first-standby-bot');
  });

  it('does not promote a standby from a stale permissions snapshot when freshness is required', () => {
    const nowMs = Date.parse('2026-05-11T10:00:00.000Z');

    expect(
      resolvePreferredPrimaryBotId(
        'primary-bot',
        [
          {
            botId: 'primary-bot',
            role: ChatBotMembershipRole.PRIMARY,
            status: ChatBotMembershipStatus.ACTIVE,
            permissionsSnapshot: {
              checkedAt: '2026-05-11T09:59:00.000Z',
              isAdmin: true,
              isOwner: false,
              permissions: ['read_all_messages'],
            },
          },
          {
            botId: 'stale-standby-bot',
            role: ChatBotMembershipRole.STANDBY,
            status: ChatBotMembershipStatus.ACTIVE,
            permissionsSnapshot: {
              checkedAt: '2026-05-09T10:00:00.000Z',
              isAdmin: true,
              isOwner: true,
              permissions: ['delete_messages', 'add_remove_members'],
            },
          },
          {
            botId: 'fresh-weak-standby-bot',
            role: ChatBotMembershipRole.STANDBY,
            status: ChatBotMembershipStatus.ACTIVE,
            permissionsSnapshot: {
              checkedAt: '2026-05-11T09:58:00.000Z',
              isAdmin: true,
              isOwner: false,
              permissions: [],
            },
          },
        ],
        {
          requireFreshSnapshotForPromotion: true,
          nowMs,
          freshMs: 60 * 60 * 1_000,
        },
      ),
    ).toBe('primary-bot');
  });

  it('uses a fresh replacement instead of a stale fallback when the current primary is gone', () => {
    const nowMs = Date.parse('2026-05-11T10:00:00.000Z');

    expect(
      resolvePreferredPrimaryBotId(
        null,
        [
          {
            botId: 'stale-owner-bot',
            role: ChatBotMembershipRole.STANDBY,
            status: ChatBotMembershipStatus.ACTIVE,
            permissionsSnapshot: {
              checkedAt: '2026-05-09T10:00:00.000Z',
              isAdmin: true,
              isOwner: true,
              permissions: ['delete_messages', 'add_remove_members'],
            },
          },
          {
            botId: 'fresh-admin-bot',
            role: ChatBotMembershipRole.STANDBY,
            status: ChatBotMembershipStatus.ACTIVE,
            permissionsSnapshot: {
              checkedAt: '2026-05-11T09:58:00.000Z',
              isAdmin: true,
              isOwner: false,
              permissions: ['read_all_messages'],
            },
          },
        ],
        {
          requireFreshSnapshotForPromotion: true,
          nowMs,
          freshMs: 60 * 60 * 1_000,
        },
      ),
    ).toBe('fresh-admin-bot');
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
