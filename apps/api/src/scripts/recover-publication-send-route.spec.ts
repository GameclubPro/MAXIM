import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  ChatRoutingState,
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  Prisma,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import { MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE } from '../max/max-send-route-health';
import { PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE } from '../admin/publication-delivery-verification-state';
import {
  readPublicationSendRouteRecoveryOptions,
  runPublicationSendRouteRecovery,
  type PublicationSendRouteRecoveryOptions,
} from './recover-publication-send-route';

const NOW = new Date('2026-07-28T12:00:00.000Z');

function buildMembership(overrides: Record<string, unknown> = {}) {
  return {
    id: 'membership-1',
    chatId: 'chat-1',
    botId: 'bot-1',
    status: ChatBotMembershipStatus.ACTIVE,
    botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
    botAccessCheckedAt: new Date('2026-07-28T11:30:00.000Z'),
    botAccessExpiresAt: new Date('2026-07-28T13:30:00.000Z'),
    permissionsSnapshot: {
      checkedAt: '2026-07-28T11:30:00.000Z',
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
    },
    sendRouteFailureCount: 3,
    sendRouteQuarantinedUntil: new Date('2026-07-28T18:00:00.000Z'),
    sendRouteLastFailureAt: new Date('2026-07-28T10:00:00.000Z'),
    sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
    sendRouteLastSuccessAt: new Date('2026-07-27T10:00:00.000Z'),
    updatedAt: new Date('2026-07-28T10:05:00.000Z'),
    chat: {
      entityType: ChatEntityType.CHANNEL,
      routingState: ChatRoutingState.READY,
    },
    ...overrides,
  };
}

function buildOptions(
  overrides: Partial<PublicationSendRouteRecoveryOptions> = {},
): PublicationSendRouteRecoveryOptions {
  return {
    apply: false,
    json: false,
    actorUserId: null,
    routes: [{ chatId: 'chat-1', botId: 'bot-1' }],
    ...overrides,
  };
}

function buildRegistry(botIds: string[] = ['bot-1']) {
  return {
    getActionableBots: jest.fn(() => botIds.map((id) => ({ id }))),
  };
}

describe('publication send-route recovery CLI', () => {
  it('defaults to dry-run with one explicit route pair', () => {
    expect(
      readPublicationSendRouteRecoveryOptions(['--route', 'chat-1', 'bot-1', '--json']),
    ).toEqual({
      apply: false,
      json: true,
      actorUserId: null,
      routes: [{ chatId: 'chat-1', botId: 'bot-1' }],
    });
  });

  it('requires an attributed operator and 1-5 unique explicit pairs for apply', () => {
    expect(
      readPublicationSendRouteRecoveryOptions([
        '--apply',
        '--actor-user-id',
        'admin-1',
        '--route',
        'chat-1',
        'bot-1',
      ]),
    ).toEqual({
      apply: true,
      json: false,
      actorUserId: 'admin-1',
      routes: [{ chatId: 'chat-1', botId: 'bot-1' }],
    });
    expect(() =>
      readPublicationSendRouteRecoveryOptions(['--apply', '--route', 'chat-1', 'bot-1']),
    ).toThrow('--apply requires --actor-user-id');
    expect(() => readPublicationSendRouteRecoveryOptions([])).toThrow(
      'At least one explicit --route',
    );
    expect(() =>
      readPublicationSendRouteRecoveryOptions([
        '--route',
        'chat-1',
        'bot-1',
        '--route',
        'chat-1',
        'bot-1',
      ]),
    ).toThrow('must be unique');
    expect(() =>
      readPublicationSendRouteRecoveryOptions(
        Array.from({ length: 6 }, (_, index) => [
          '--route',
          `chat-${index}`,
          `bot-${index}`,
        ]).flat(),
      ),
    ).toThrow('At most 5 --route pairs');
    expect(() =>
      readPublicationSendRouteRecoveryOptions([
        '--apply',
        '--dry-run',
        '--actor-user-id',
        'admin-1',
        '--route',
        'chat-1',
        'bot-1',
      ]),
    ).toThrow('--apply cannot be combined with --dry-run');
  });
});

describe('runPublicationSendRouteRecovery', () => {
  it('previews one eligible sticky route without starting a transaction', async () => {
    const transaction = jest.fn();
    const prisma = {
      chatBotMembership: { findMany: jest.fn().mockResolvedValue([buildMembership()]) },
      $transaction: transaction,
    };

    await expect(
      runPublicationSendRouteRecovery(
        prisma as never,
        buildRegistry() as never,
        buildOptions(),
        () => NOW,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        apply: false,
        requested: 1,
        wouldApply: 1,
        applied: 0,
        ineligible: 0,
        outcomes: [
          expect.objectContaining({
            chatId: 'chat-1',
            botId: 'bot-1',
            result: 'would_apply',
            previousFailureCount: 3,
          }),
        ],
      }),
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'inactive membership',
      membership: buildMembership({ status: ChatBotMembershipStatus.REMOVED }),
      registry: buildRegistry(),
      reason: 'membership_inactive',
    },
    {
      label: 'non-ready chat route',
      membership: buildMembership({
        chat: {
          entityType: ChatEntityType.CHANNEL,
          routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
        },
      }),
      registry: buildRegistry(),
      reason: 'chat_route_not_ready',
    },
    {
      label: 'non-actionable configured bot',
      membership: buildMembership(),
      registry: buildRegistry([]),
      reason: 'bot_not_actionable',
    },
    {
      label: 'non-sticky route',
      membership: buildMembership({ sendRouteFailureCount: 1 }),
      registry: buildRegistry(),
      reason: 'not_sticky_disappearance',
    },
    {
      label: 'unconfirmed access',
      membership: buildMembership({ botAccessState: ChatBotAccessState.UNKNOWN }),
      registry: buildRegistry(),
      reason: 'persisted_access_unconfirmed',
    },
    {
      label: 'expired access',
      membership: buildMembership({
        botAccessExpiresAt: new Date('2026-07-28T11:59:59.999Z'),
      }),
      registry: buildRegistry(),
      reason: 'persisted_access_stale',
    },
    {
      label: 'channel without write capability',
      membership: buildMembership({
        permissionsSnapshot: {
          checkedAt: '2026-07-28T11:30:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
      }),
      registry: buildRegistry(),
      reason: 'persisted_send_capability_missing',
    },
  ])('rejects $label from persisted state', async ({ membership, registry, reason }) => {
    const prisma = {
      chatBotMembership: { findMany: jest.fn().mockResolvedValue([membership]) },
      $transaction: jest.fn(),
    };

    const summary = await runPublicationSendRouteRecovery(
      prisma as never,
      registry as never,
      buildOptions(),
      () => NOW,
    );

    expect(summary).toEqual(
      expect.objectContaining({
        wouldApply: 0,
        ineligible: 1,
        outcomes: [expect.objectContaining({ result: 'ineligible', reason })],
      }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('reports an explicitly requested missing membership', async () => {
    const summary = await runPublicationSendRouteRecovery(
      {
        chatBotMembership: { findMany: jest.fn().mockResolvedValue([]) },
        $transaction: jest.fn(),
      } as never,
      buildRegistry() as never,
      buildOptions(),
      () => NOW,
    );

    expect(summary.outcomes).toEqual([
      expect.objectContaining({ result: 'ineligible', reason: 'membership_missing' }),
    ]);
  });

  it('uses a health-snapshot CAS, wakes only matching Publication backlog, and audits atomically', async () => {
    const membership = buildMembership();
    const membershipUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 2 });
    const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 3 });
    const auditCreate = jest.fn().mockResolvedValue({ id: 'audit-1' });
    const tx = {
      chatBotMembership: { updateMany: membershipUpdateMany },
      managedBroadcast: { updateMany: broadcastUpdateMany },
      managedBroadcastDelivery: { updateMany: deliveryUpdateMany },
      auditLog: { create: auditCreate },
    };
    const transaction = jest.fn(async (callback) => callback(tx));
    const prisma = {
      chatBotMembership: { findMany: jest.fn().mockResolvedValue([membership]) },
      $transaction: transaction,
    };

    const summary = await runPublicationSendRouteRecovery(
      prisma as never,
      buildRegistry() as never,
      buildOptions({ apply: true, actorUserId: 'admin-1' }),
      () => NOW,
    );

    expect(summary).toEqual(
      expect.objectContaining({
        applied: 1,
        casConflicts: 0,
        errors: 0,
        outcomes: [
          expect.objectContaining({
            result: 'applied',
            wokenBroadcastCount: 2,
            releasedDeliveryCount: 3,
          }),
        ],
      }),
    );
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(membershipUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: membership.id,
        chatId: 'chat-1',
        botId: 'bot-1',
        status: ChatBotMembershipStatus.ACTIVE,
        sendRouteFailureCount: 3,
        sendRouteQuarantinedUntil: membership.sendRouteQuarantinedUntil,
        sendRouteLastFailureAt: membership.sendRouteLastFailureAt,
        sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
        sendRouteLastSuccessAt: membership.sendRouteLastSuccessAt,
        updatedAt: membership.updatedAt,
        chat: {
          routingState: ChatRoutingState.READY,
          entityType: ChatEntityType.CHANNEL,
        },
      }),
      data: {
        sendRouteFailureCount: 1,
        sendRouteQuarantinedUntil: NOW,
      },
    });
    expect(broadcastUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        publicationOccurrenceId: { not: null },
        status: ManagedBroadcastStatus.ACTIVE,
        lockToken: null,
        publicationOccurrence: {
          is: {
            status: {
              in: [PublicationOccurrenceStatus.SCHEDULED, PublicationOccurrenceStatus.IN_PROGRESS],
            },
            publication: { lifecycle: PublicationLifecycle.ACTIVE },
            schedule: { status: PublicationScheduleStatus.ACTIVE },
          },
        },
        deliveries: {
          some: {
            targetChatId: 'chat-1',
            status: ManagedBroadcastDeliveryStatus.PENDING,
            lastErrorCode: PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
          },
        },
      }),
      data: { nextSendAt: NOW },
    });
    expect(deliveryUpdateMany).toHaveBeenCalledWith({
      where: {
        targetChatId: 'chat-1',
        status: ManagedBroadcastDeliveryStatus.PENDING,
        lastErrorCode: PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
        broadcast: {
          is: {
            publicationOccurrenceId: { not: null },
            status: ManagedBroadcastStatus.ACTIVE,
            lockToken: null,
            publicationOccurrence: {
              is: {
                status: {
                  in: [
                    PublicationOccurrenceStatus.SCHEDULED,
                    PublicationOccurrenceStatus.IN_PROGRESS,
                  ],
                },
                publication: { lifecycle: PublicationLifecycle.ACTIVE },
                schedule: { status: PublicationScheduleStatus.ACTIVE },
              },
            },
          },
        },
      },
      data: { lastErrorCode: null, lastError: null },
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        actorUserId: 'admin-1',
        action: 'PUBLICATION_SEND_ROUTE_CONTROLLED_RECOVERY',
        payload: expect.objectContaining({
          botId: 'bot-1',
          wokenBroadcastCount: 2,
          releasedDeliveryCount: 3,
        }),
      }),
    });
  });

  it('does not wake or audit when the health snapshot CAS loses', async () => {
    const broadcastUpdateMany = jest.fn();
    const deliveryUpdateMany = jest.fn();
    const auditCreate = jest.fn();
    const tx = {
      chatBotMembership: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      managedBroadcast: { updateMany: broadcastUpdateMany },
      managedBroadcastDelivery: { updateMany: deliveryUpdateMany },
      auditLog: { create: auditCreate },
    };
    const prisma = {
      chatBotMembership: { findMany: jest.fn().mockResolvedValue([buildMembership()]) },
      $transaction: jest.fn(async (callback) => callback(tx)),
    };

    const summary = await runPublicationSendRouteRecovery(
      prisma as never,
      buildRegistry() as never,
      buildOptions({ apply: true, actorUserId: 'admin-1' }),
      () => NOW,
    );

    expect(summary).toEqual(expect.objectContaining({ applied: 0, casConflicts: 1 }));
    expect(broadcastUpdateMany).not.toHaveBeenCalled();
    expect(deliveryUpdateMany).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('surfaces an audit failure as a failed transaction outcome', async () => {
    const tx = {
      chatBotMembership: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      managedBroadcast: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      managedBroadcastDelivery: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: jest.fn().mockRejectedValue(new Error('audit unavailable')) },
    };
    const prisma = {
      chatBotMembership: { findMany: jest.fn().mockResolvedValue([buildMembership()]) },
      $transaction: jest.fn(async (callback) => callback(tx)),
    };

    const summary = await runPublicationSendRouteRecovery(
      prisma as never,
      buildRegistry() as never,
      buildOptions({ apply: true, actorUserId: 'admin-1' }),
      () => NOW,
    );

    expect(summary).toEqual(
      expect.objectContaining({
        applied: 0,
        errors: 1,
        outcomes: [expect.objectContaining({ result: 'error', error: 'audit unavailable' })],
      }),
    );
  });
});
