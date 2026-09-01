import { ManagedBroadcastDeliveryStatus } from '../prisma/prisma-client';
import { MaxActionRouteQuarantinedError } from '../max/max-action-dispatch-error';
import {
  deferPublicationDeliveryAfterPreDispatchThrottle,
  deferPublicationDeliveryAfterRouteQuarantine,
  PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
  selectManagedBroadcastDeliveryCandidates,
  syncPublicationBroadcastAfterDeliveryResolution,
} from './publication-execution-recovery';

describe('publication execution recovery', () => {
  function createOptions(error: unknown) {
    const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      managedBroadcast: { updateMany: broadcastUpdateMany },
      managedBroadcastDelivery: { updateMany: deliveryUpdateMany },
    };
    return {
      context: {
        prisma: {
          ...tx,
          $transaction: jest.fn(async (callback) => callback(tx)),
        },
        logger: { warn: jest.fn() },
      },
      row: { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' as string | null },
      delivery: { id: 'delivery-1', targetChatId: 'chat-1' },
      reason: 'deadline' as const,
      occurrenceIndex: 1,
      broadcastLockToken: 'broadcast-lock-1',
      deliveryLockToken: 'delivery-lock-1',
      error,
    };
  }

  it('prioritizes ready Publication targets ahead of quarantined targets', () => {
    const updatedAt = new Date('2026-07-27T12:00:00.000Z');
    const delivery = (id: string, targetChatId: string, lastErrorCode: string | null) => ({
      id,
      targetChatId,
      status: ManagedBroadcastDeliveryStatus.PENDING,
      lastErrorCode,
      updatedAt,
    });

    expect(
      selectManagedBroadcastDeliveryCandidates(
        [
          delivery('quarantined-1', 'chat-1', PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE),
          delivery('ready-1', 'chat-2', null),
          delivery('quarantined-2', 'chat-3', PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE),
          delivery('ready-2', 'chat-4', null),
        ],
        true,
      ).map((candidate) => candidate.id),
    ).toEqual(['ready-1', 'ready-2']);
  });

  it('rotates an all-quarantined Publication backlog by oldest update first', () => {
    const quarantined = (id: string, targetChatId: string, updatedAt: string) => ({
      id,
      targetChatId,
      status: ManagedBroadcastDeliveryStatus.PENDING,
      lastErrorCode: PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
      updatedAt: new Date(updatedAt),
    });

    expect(
      selectManagedBroadcastDeliveryCandidates(
        [
          quarantined('newest', 'chat-1', '2026-07-27T12:03:00.000Z'),
          quarantined('old-b', 'chat-b', '2026-07-27T12:00:00.000Z'),
          quarantined('old-a', 'chat-a', '2026-07-27T12:00:00.000Z'),
        ],
        true,
      ).map((candidate) => candidate.id),
    ).toEqual(['old-a', 'old-b', 'newest']);
  });

  it('returns a deadline delivery to pending when capacity rejected it before dispatch', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:30.000Z'));
    try {
      const options = createOptions(
        Object.assign(new Error('MAX API background rate limit exceeded'), {
          code: 'MAX_API_INTERNAL_RATE_LIMIT',
          managedBroadcastSendStarted: false,
          retryAfterMs: 250,
        }),
      );

      await expect(
        deferPublicationDeliveryAfterPreDispatchThrottle(options as never),
      ).resolves.toEqual(new Date('2026-07-27T12:01:00.000Z'));
      expect(options.context.prisma.managedBroadcast.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'broadcast-1',
          publicationOccurrenceId: 'occurrence-1',
          status: expect.any(String),
          lockToken: 'broadcast-lock-1',
        },
        data: {
          nextSendAt: new Date('2026-07-27T12:01:00.000Z'),
          lockedAt: null,
          lockToken: null,
        },
      });
      expect(options.context.prisma.managedBroadcastDelivery.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: 'delivery-1',
          status: ManagedBroadcastDeliveryStatus.SENDING,
          lockToken: 'delivery-lock-1',
        }),
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.PENDING,
          attemptCount: { decrement: 1 },
          botId: null,
          lockedAt: null,
          lockToken: null,
          lastError: null,
        }),
      });
      expect(options.context.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ retryAt: '2026-07-27T12:01:00.000Z' }),
        expect.any(String),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('honors a longer Retry-After on an exact external HTTP 429 rejection', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:30.000Z'));
    try {
      const options = createOptions(
        Object.assign(new Error('Too many requests'), {
          managedBroadcastSendStarted: true,
          response: { status: 429, headers: { 'retry-after': '125' } },
        }),
      );

      await expect(
        deferPublicationDeliveryAfterPreDispatchThrottle(options as never),
      ).resolves.toEqual(new Date('2026-07-27T12:03:00.000Z'));
      expect(options.context.prisma.managedBroadcast.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            nextSendAt: new Date('2026-07-27T12:03:00.000Z'),
            lockedAt: null,
            lockToken: null,
          }),
        }),
      );
      expect(options.context.prisma.managedBroadcastDelivery.updateMany).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('defers an exact pre-dispatch circuit-open rejection to its retry minute', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:30.000Z'));
    try {
      const options = createOptions(
        Object.assign(new Error('MAX API circuit breaker is open'), {
          code: 'MAX_API_CIRCUIT_OPEN',
          preDispatch: true,
          managedBroadcastSendStarted: false,
          retryAfterMs: 95_000,
        }),
      );

      await expect(
        deferPublicationDeliveryAfterPreDispatchThrottle(options as never),
      ).resolves.toEqual(new Date('2026-07-27T12:03:00.000Z'));
      expect(options.context.prisma.managedBroadcast.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            nextSendAt: new Date('2026-07-27T12:03:00.000Z'),
            lockedAt: null,
            lockToken: null,
          }),
        }),
      );
      expect(options.context.prisma.managedBroadcastDelivery.updateMany).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    {
      label: 'internal limiter after dispatch started',
      error: Object.assign(new Error('MAX API background rate limit exceeded'), {
        code: 'MAX_API_INTERNAL_RATE_LIMIT',
        managedBroadcastSendStarted: true,
      }),
      publicationOccurrenceId: 'occurrence-1',
    },
    {
      label: 'message-only rate-limit error',
      error: Object.assign(new Error('rate limit exceeded'), {
        managedBroadcastSendStarted: false,
      }),
      publicationOccurrenceId: 'occurrence-1',
    },
    {
      label: 'timeout before dispatch marker',
      error: Object.assign(new Error('timeout'), {
        code: 'ECONNABORTED',
        managedBroadcastSendStarted: false,
      }),
      publicationOccurrenceId: 'occurrence-1',
    },
    {
      label: 'HTTP 503',
      error: Object.assign(new Error('service unavailable'), {
        managedBroadcastSendStarted: true,
        response: { status: 503 },
      }),
      publicationOccurrenceId: 'occurrence-1',
    },
    {
      label: 'circuit-open after dispatch started',
      error: Object.assign(new Error('MAX API circuit breaker is open'), {
        code: 'MAX_API_CIRCUIT_OPEN',
        preDispatch: true,
        managedBroadcastSendStarted: true,
      }),
      publicationOccurrenceId: 'occurrence-1',
    },
    {
      label: 'not a Publication envelope',
      error: Object.assign(new Error('MAX API background rate limit exceeded'), {
        code: 'MAX_API_INTERNAL_RATE_LIMIT',
        managedBroadcastSendStarted: false,
      }),
      publicationOccurrenceId: null,
    },
  ])('does not defer $label', async ({ error, publicationOccurrenceId }) => {
    const options = createOptions(error);
    options.row.publicationOccurrenceId = publicationOccurrenceId;

    await expect(
      deferPublicationDeliveryAfterPreDispatchThrottle(options as never),
    ).resolves.toBeNull();
    expect(options.context.prisma.$transaction).not.toHaveBeenCalled();
    expect(options.context.prisma.managedBroadcastDelivery.updateMany).not.toHaveBeenCalled();
  });

  it('does not split the envelope and delivery updates when the broadcast lease was lost', async () => {
    const options = createOptions(
      Object.assign(new Error('MAX API background rate limit exceeded'), {
        code: 'MAX_API_INTERNAL_RATE_LIMIT',
        managedBroadcastSendStarted: false,
      }),
    );
    options.context.prisma.managedBroadcast.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      deferPublicationDeliveryAfterPreDispatchThrottle(options as never),
    ).resolves.toBeNull();
    expect(options.context.prisma.managedBroadcastDelivery.updateMany).not.toHaveBeenCalled();
    expect(options.context.logger.warn).not.toHaveBeenCalled();
  });

  it('returns a quarantined route to pending and serializes its next recovery slot', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const aggregate = jest.fn().mockResolvedValue({
        _max: { nextSendAt: new Date('2026-07-27T12:30:00.000Z') },
      });
      const executeRaw = jest.fn().mockResolvedValue(1);
      const routeCount = jest.fn().mockResolvedValue(1);
      const occurrenceUpdateMany = jest.fn();
      const scheduleUpdateMany = jest.fn();
      const publicationUpdateMany = jest.fn();
      const broadcastDeleteMany = jest.fn();
      const transaction = jest.fn(async (callback) =>
        callback({
          $executeRaw: executeRaw,
          chatBotMembership: { count: routeCount },
          managedBroadcast: {
            aggregate,
            updateMany: broadcastUpdateMany,
            deleteMany: broadcastDeleteMany,
          },
          managedBroadcastDelivery: { updateMany: deliveryUpdateMany },
          publicationOccurrence: { updateMany: occurrenceUpdateMany },
          publicationSchedule: { updateMany: scheduleUpdateMany },
          publication: { updateMany: publicationUpdateMany },
        }),
      );
      const logger = { warn: jest.fn() };
      const retryAt = new Date('2026-07-27T12:15:00.000Z');

      const deferredUntil = await deferPublicationDeliveryAfterRouteQuarantine({
        context: { prisma: { $transaction: transaction }, logger } as never,
        row: { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' },
        delivery: { id: 'delivery-1', targetChatId: 'chat-1' },
        occurrenceIndex: 1,
        broadcastLockToken: 'broadcast-lock-1',
        deliveryLockToken: 'delivery-lock-1',
        error: new MaxActionRouteQuarantinedError('SEND_MESSAGE', 'chat-1', retryAt, ['bot-1']),
      });

      expect(deferredUntil).toEqual(new Date('2026-07-27T12:45:00.000Z'));
      expect(routeCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ chatId: 'chat-1', botId: { in: ['bot-1'] } }),
        }),
      );
      expect(aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { not: 'broadcast-1' },
            deliveries: {
              some: expect.objectContaining({
                targetChatId: 'chat-1',
                lastErrorCode: PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
              }),
            },
          }),
        }),
      );
      expect(broadcastUpdateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: 'broadcast-1',
          lockToken: 'broadcast-lock-1',
        }),
        data: { nextSendAt: new Date('2026-07-27T12:45:00.000Z') },
      });
      expect(deliveryUpdateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: 'delivery-1',
          status: ManagedBroadcastDeliveryStatus.SENDING,
          lockToken: 'delivery-lock-1',
        }),
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.PENDING,
          attemptCount: { decrement: 1 },
          lastErrorCode: PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
          lockedAt: null,
          lockToken: null,
        }),
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ retryAt: '2026-07-27T12:45:00.000Z' }),
        expect.any(String),
      );
      expect(occurrenceUpdateMany).not.toHaveBeenCalled();
      expect(scheduleUpdateMany).not.toHaveBeenCalled();
      expect(publicationUpdateMany).not.toHaveBeenCalled();
      expect(broadcastDeleteMany).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('requeues immediately when a concurrent stable observation already closed the route', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const aggregate = jest.fn();
      const transaction = jest.fn(async (callback) =>
        callback({
          $executeRaw: jest.fn().mockResolvedValue(1),
          chatBotMembership: { count: jest.fn().mockResolvedValue(0) },
          managedBroadcast: { aggregate, updateMany: broadcastUpdateMany },
          managedBroadcastDelivery: { updateMany: deliveryUpdateMany },
        }),
      );

      await expect(
        deferPublicationDeliveryAfterRouteQuarantine({
          context: {
            prisma: { $transaction: transaction },
            logger: { warn: jest.fn() },
          } as never,
          row: { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' },
          delivery: { id: 'delivery-1', targetChatId: 'chat-1' },
          occurrenceIndex: 1,
          broadcastLockToken: 'broadcast-lock-1',
          deliveryLockToken: 'delivery-lock-1',
          error: new MaxActionRouteQuarantinedError(
            'SEND_MESSAGE',
            'chat-1',
            new Date('2026-07-27T18:00:00.000Z'),
            ['bot-1'],
          ),
        }),
      ).resolves.toEqual(new Date('2026-07-27T12:00:00.000Z'));

      expect(aggregate).not.toHaveBeenCalled();
      expect(broadcastUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { nextSendAt: new Date('2026-07-27T12:00:00.000Z') },
        }),
      );
      expect(deliveryUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ManagedBroadcastDeliveryStatus.PENDING,
            lastErrorCode: null,
            lastError: null,
          }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves a future quarantine retry while another delivery is resolved', async () => {
    const now = new Date('2026-07-27T12:00:00.000Z');
    const retryAt = new Date('2026-07-27T18:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    try {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const tx = {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([
            {
              status: ManagedBroadcastDeliveryStatus.PENDING,
              sentAt: null,
              remoteMessageId: null,
              remoteMessageVerifiedAt: null,
              remoteMessageVerificationAttemptCount: 0,
              remoteMessageVerificationAbsentCount: 0,
              remoteMessageVerificationPresentCount: 0,
              remoteMessageVerificationAttemptedAt: null,
              remoteMessageVerificationNextAt: null,
              remoteMessageVerificationSource: null,
              lastErrorCode: PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
            },
          ]),
        },
        managedBroadcast: {
          findUnique: jest.fn().mockResolvedValue({ nextSendAt: retryAt }),
          updateMany,
        },
      };

      await syncPublicationBroadcastAfterDeliveryResolution(tx, 'broadcast-1', 1);

      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: expect.any(String),
            nextSendAt: retryAt,
          }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps mixed-target work immediately due when any pending delivery is not quarantined', async () => {
    const now = new Date('2026-07-27T12:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    try {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const pending = (lastErrorCode: string | null) => ({
        status: ManagedBroadcastDeliveryStatus.PENDING,
        sentAt: null,
        remoteMessageId: null,
        remoteMessageVerifiedAt: null,
        remoteMessageVerificationAttemptCount: 0,
        remoteMessageVerificationAbsentCount: 0,
        remoteMessageVerificationPresentCount: 0,
        remoteMessageVerificationAttemptedAt: null,
        remoteMessageVerificationNextAt: null,
        remoteMessageVerificationSource: null,
        lastErrorCode,
      });
      const findUnique = jest.fn();
      const tx = {
        managedBroadcastDelivery: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              pending(PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE),
              pending(null),
            ]),
        },
        managedBroadcast: { findUnique, updateMany },
      };

      await syncPublicationBroadcastAfterDeliveryResolution(tx, 'broadcast-1', 1);

      expect(findUnique).not.toHaveBeenCalled();
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ nextSendAt: now }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
