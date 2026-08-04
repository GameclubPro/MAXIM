import { EventType, Operator, SanctionAction } from '../prisma/prisma-client';
import {
  ModerationSanctionStateFenceService,
  SANCTION_STATE_FENCE_RULE_CODE,
  type ModerationSanctionStateFence,
} from './moderation-sanction-state-fence.service';

function createHarness() {
  const prisma = {
    moderationEvent: {
      create: jest.fn().mockResolvedValue({ id: 'fence-event-1' }),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  return {
    prisma,
    service: new ModerationSanctionStateFenceService(prisma as never),
  };
}

function createFence(
  overrides: Partial<ModerationSanctionStateFence> = {},
): ModerationSanctionStateFence {
  return {
    version: 1,
    transitionId: 'transition-1',
    chatId: 'chat-1',
    userId: 'user-1',
    intendedAction: 'UNBAN',
    operator: Operator.ADMIN,
    source: 'release_callback',
    invalidatedSanctionEventIds: ['sanction-1'],
    ...overrides,
  };
}

function fenceMetadata(
  phase: 'PREPARED' | 'COMMITTED' | 'REMOTE_CONFIRMED_EVENT_MISSING' | 'ABORTED',
  transitionId = 'transition-1',
) {
  return {
    version: 1,
    transitionId,
    intendedAction: 'UNBAN',
    invalidatedSanctionEventIds: ['sanction-1'],
    phase,
  };
}

describe('ModerationSanctionStateFenceService', () => {
  it('prepares a persisted fence and invalidates the latest sanction event', async () => {
    const { prisma, service } = createHarness();
    prisma.moderationEvent.findFirst.mockResolvedValue({
      id: 'sanction-1',
      action: SanctionAction.BAN,
    });

    const fence = await service.prepare({
      chatId: 'chat-1',
      userId: 'user-1',
      intendedAction: 'UNBAN',
      operator: Operator.ADMIN,
      source: ' release_callback ',
    });

    expect(prisma.moderationEvent.findFirst).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        userId: 'user-1',
        OR: [
          { action: { in: [SanctionAction.BAN, SanctionAction.MUTE] } },
          { ruleCode: { in: ['MANUAL_UNBAN', 'MANUAL_UNMUTE'] } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, action: true },
    });
    expect(fence).toEqual({
      version: 1,
      transitionId: expect.any(String),
      chatId: 'chat-1',
      userId: 'user-1',
      intendedAction: 'UNBAN',
      operator: Operator.ADMIN,
      source: 'release_callback',
      invalidatedSanctionEventIds: ['sanction-1'],
    });
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: {
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: null,
        eventType: EventType.SYSTEM,
        ruleCode: SANCTION_STATE_FENCE_RULE_CODE,
        action: SanctionAction.NONE,
        maskedExcerpt: null,
        score: 0,
        operator: Operator.ADMIN,
        metadata: {
          version: 1,
          transitionId: fence.transitionId,
          intendedAction: 'UNBAN',
          invalidatedSanctionEventIds: ['sanction-1'],
          phase: 'PREPARED',
          source: 'release_callback',
        },
      },
    });
  });

  it('skips every marker phase when the latest state is a manual release', async () => {
    const { prisma, service } = createHarness();
    prisma.moderationEvent.findFirst.mockResolvedValue({
      id: 'release-1',
      action: SanctionAction.NONE,
    });

    const fence = await service.prepare({
      chatId: 'chat-1',
      userId: 'user-1',
      intendedAction: 'BAN',
      operator: Operator.BOT,
    });

    expect(fence.invalidatedSanctionEventIds).toEqual([]);
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();

    await service.commit(fence, 'event-2');
    await service.markRemoteConfirmedEventMissing(fence);
    await service.abort(fence);

    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('appends terminal phases and links a committed moderation event', async () => {
    const { prisma, service } = createHarness();
    const fence = createFence();

    await service.commit(fence, ' event-2 ');
    await service.markRemoteConfirmedEventMissing(fence);
    await service.abort(fence);

    expect(prisma.moderationEvent.create.mock.calls.map((call) => call[0].data.metadata)).toEqual([
      {
        version: 1,
        transitionId: 'transition-1',
        intendedAction: 'UNBAN',
        invalidatedSanctionEventIds: ['sanction-1'],
        phase: 'COMMITTED',
        source: 'release_callback',
        eventId: 'event-2',
      },
      {
        version: 1,
        transitionId: 'transition-1',
        intendedAction: 'UNBAN',
        invalidatedSanctionEventIds: ['sanction-1'],
        phase: 'REMOTE_CONFIRMED_EVENT_MISSING',
        source: 'release_callback',
      },
      {
        version: 1,
        transitionId: 'transition-1',
        intendedAction: 'UNBAN',
        invalidatedSanctionEventIds: ['sanction-1'],
        phase: 'ABORTED',
        source: 'release_callback',
      },
    ]);
  });

  it.each(['PREPARED', 'COMMITTED'] as const)(
    'treats a %s fence as invalidating the sanction event',
    async (phase) => {
      const { prisma, service } = createHarness();
      const eventCreatedAt = new Date('2026-08-04T12:00:00.000Z');
      prisma.moderationEvent.findMany.mockResolvedValue([{ metadata: fenceMetadata(phase) }]);

      await expect(
        service.isSanctionEventInvalidated({
          chatId: 'chat-1',
          userId: 'user-1',
          sanctionEventId: 'sanction-1',
          eventCreatedAt,
        }),
      ).resolves.toBe(true);

      expect(prisma.moderationEvent.findMany).toHaveBeenCalledWith({
        where: {
          chatId: 'chat-1',
          userId: 'user-1',
          ruleCode: SANCTION_STATE_FENCE_RULE_CODE,
          createdAt: { gte: eventCreatedAt },
          metadata: {
            path: ['invalidatedSanctionEventIds'],
            array_contains: ['sanction-1'],
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 129,
        select: { metadata: true },
      });
      expect(prisma.moderationEvent.findUnique).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['ABORTED before PREPARED', ['ABORTED', 'PREPARED']],
    ['PREPARED before ABORTED', ['PREPARED', 'ABORTED']],
  ] as const)('ignores an aborted prepared fence with %s', async (_label, phases) => {
    const { prisma, service } = createHarness();
    prisma.moderationEvent.findUnique.mockResolvedValue({
      chatId: 'chat-1',
      userId: 'user-1',
      createdAt: new Date('2026-08-04T12:00:00.000Z'),
    });
    prisma.moderationEvent.findMany.mockResolvedValue(
      phases.map((phase) => ({ metadata: fenceMetadata(phase) })),
    );

    await expect(
      service.isSanctionEventInvalidated({
        chatId: 'chat-1',
        userId: 'user-1',
        sanctionEventId: 'sanction-1',
      }),
    ).resolves.toBe(false);
  });

  it.each(['COMMITTED', 'REMOTE_CONFIRMED_EVENT_MISSING'] as const)(
    'keeps a %s transition invalidating even when it also has ABORTED',
    async (committedPhase) => {
      const { prisma, service } = createHarness();
      prisma.moderationEvent.findMany.mockResolvedValue([
        { metadata: fenceMetadata('PREPARED') },
        { metadata: fenceMetadata('ABORTED') },
        { metadata: fenceMetadata(committedPhase) },
      ]);

      await expect(
        service.isSanctionEventInvalidated({
          chatId: 'chat-1',
          userId: 'user-1',
          sanctionEventId: 'sanction-1',
          eventCreatedAt: new Date('2026-08-04T12:00:00.000Z'),
        }),
      ).resolves.toBe(true);
    },
  );

  it('fails closed when matching fence rows exceed the bounded resolution window', async () => {
    const { prisma, service } = createHarness();
    prisma.moderationEvent.findMany.mockResolvedValue(
      Array.from({ length: 129 }, (_, index) => ({
        metadata: fenceMetadata('ABORTED', `transition-${index}`),
      })),
    );

    await expect(
      service.isSanctionEventInvalidated({
        chatId: 'chat-1',
        userId: 'user-1',
        sanctionEventId: 'sanction-1',
        eventCreatedAt: new Date('2026-08-04T12:00:00.000Z'),
      }),
    ).resolves.toBe(true);
  });

  it('does not return a fence when PREPARED persistence fails', async () => {
    const { prisma, service } = createHarness();
    const persistenceError = new Error('database unavailable');
    prisma.moderationEvent.findFirst.mockResolvedValue({
      id: 'sanction-1',
      action: SanctionAction.MUTE,
    });
    prisma.moderationEvent.create.mockRejectedValue(persistenceError);

    await expect(
      service.prepare({
        chatId: 'chat-1',
        userId: 'user-1',
        intendedAction: 'UNMUTE',
        operator: Operator.ADMIN,
      }),
    ).rejects.toBe(persistenceError);
  });
});
