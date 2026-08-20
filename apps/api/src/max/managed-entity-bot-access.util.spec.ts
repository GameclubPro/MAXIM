import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ManagedEntityAccessState,
} from '../prisma/prisma-client';
import {
  hasFreshActionableManagedEntityBotAccess,
  managedEntityBotAccessEdgeIsFreshGranted,
  managedEntityBotMembershipAllowsFreshGrantedEdge,
  managedEntityBotMembershipHasFreshConfirmedAccess,
} from './managed-entity-bot-access.util';

const nowMs = Date.parse('2026-08-21T12:00:00.000Z');
const freshSnapshot = {
  checkedAt: '2026-08-21T11:59:00.000Z',
  isAdmin: true,
  isOwner: false,
  permissions: ['write'],
};

describe('managed entity bot access', () => {
  it('treats an explicit structured expiry as authoritative', () => {
    expect(
      managedEntityBotMembershipHasFreshConfirmedAccess(
        {
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
          botAccessExpiresAt: new Date(nowMs - 1),
          permissionsSnapshot: freshSnapshot,
        },
        { nowMs },
      ),
    ).toBe(false);
    expect(
      managedEntityBotMembershipHasFreshConfirmedAccess(
        {
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.CONFIRMED_OWNER,
          botAccessExpiresAt: 'not-a-date',
          permissionsSnapshot: freshSnapshot,
        },
        { nowMs },
      ),
    ).toBe(false);
  });

  it('uses a fresh snapshot only for legacy or unknown structured access', () => {
    for (const botAccessState of [
      undefined,
      null,
      ChatBotAccessState.UNKNOWN,
      ChatBotAccessState.CONFIRMED_ADMIN,
      ChatBotAccessState.CONFIRMED_OWNER,
    ]) {
      expect(
        managedEntityBotMembershipHasFreshConfirmedAccess(
          {
            status: ChatBotMembershipStatus.ACTIVE,
            botAccessState,
            botAccessExpiresAt: null,
            permissionsSnapshot: freshSnapshot,
          },
          { nowMs },
        ),
      ).toBe(true);
    }
  });

  it.each([
    ChatBotAccessState.CONFIRMED_MEMBER,
    ChatBotAccessState.DENIED,
    ChatBotAccessState.LOST,
    ChatBotAccessState.STALE,
  ])('does not let a fresh snapshot override explicit %s access', (botAccessState) => {
    const membership = {
      botId: 'bot-1',
      status: ChatBotMembershipStatus.ACTIVE,
      botAccessState,
      permissionsSnapshot: freshSnapshot,
    };

    expect(managedEntityBotMembershipHasFreshConfirmedAccess(membership, { nowMs })).toBe(false);
    expect(managedEntityBotMembershipAllowsFreshGrantedEdge(membership)).toBe(false);
  });

  it.each([
    ChatBotAccessState.CONFIRMED_MEMBER,
    ChatBotAccessState.DENIED,
    ChatBotAccessState.LOST,
    ChatBotAccessState.STALE,
  ])('does not let a granted edge override explicit %s membership access', (botAccessState) => {
    expect(
      hasFreshActionableManagedEntityBotAccess({
        memberships: [
          {
            botId: 'bot-1',
            status: ChatBotMembershipStatus.ACTIVE,
            botAccessState,
          },
        ],
        accessEdges: [
          {
            botId: 'bot-1',
            state: ManagedEntityAccessState.GRANTED,
            checkedAt: new Date(nowMs - 1_000),
            expiresAt: new Date(nowMs + 60_000),
          },
        ],
        nowMs,
      }),
    ).toBe(false);
  });

  it('accepts a fresh granted edge for an active legacy membership', () => {
    expect(
      hasFreshActionableManagedEntityBotAccess({
        memberships: [
          {
            botId: 'bot-1',
            status: ChatBotMembershipStatus.ACTIVE,
            botAccessState: ChatBotAccessState.UNKNOWN,
          },
        ],
        accessEdges: [
          {
            botId: 'bot-1',
            state: ManagedEntityAccessState.GRANTED,
            checkedAt: new Date(nowMs - 1_000),
            expiresAt: new Date(nowMs + 60_000),
          },
        ],
        nowMs,
      }),
    ).toBe(true);
  });

  it('does not apply the legacy edge grace period to an explicit invalid expiry', () => {
    expect(
      managedEntityBotAccessEdgeIsFreshGranted(
        {
          botId: 'bot-1',
          state: ManagedEntityAccessState.GRANTED,
          checkedAt: new Date(nowMs - 1_000),
          expiresAt: 'not-a-date',
        },
        { nowMs },
      ),
    ).toBe(false);
  });
});
