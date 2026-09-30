import {
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleStatus,
  PublicationScheduleMode,
} from '../prisma/prisma-client';
import { ConflictException } from '@nestjs/common';
import { MaxActionRouteQuarantinedError } from '../max/max-action-dispatch-error';
import {
  deferPublicationAfterPreDispatchPrismaError,
  deferPublicationDeliveryAfterPreDispatchThrottle,
  deferPublicationDeliveryAfterRouteQuarantine,
  ensureManagedBroadcastPublicationExecutionActive,
  resolvePublicationRateLimitRetryAt,
  PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
  selectManagedBroadcastDeliveryCandidates,
  syncPublicationBroadcastAfterDeliveryResolution,
  syncResolvedPublicationOccurrence,
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
      delivery: { id: 'delivery-1', targetChatId: 'chat-1', attemptCount: 0 },
      reason: 'deadline' as const,
      occurrenceIndex: 1,
      broadcastLockToken: 'broadcast-lock-1',
      deliveryLockToken: 'delivery-lock-1',
      error,
    };
  }

  it('reuses the active occurrence read for deadline timing metadata', async () => {
    const scheduledAt = new Date('2026-09-04T10:30:00.000Z');
    const findUnique = jest.fn().mockResolvedValue({
      status: PublicationOccurrenceStatus.IN_PROGRESS,
      scheduledAt,
      scheduleRevision: 3,
      contentRevisionId: 'content-1',
      publication: { lifecycle: PublicationLifecycle.ACTIVE },
      schedule: { revision: 3, status: PublicationScheduleStatus.ACTIVE },
    });
    const onOccurrenceScheduledAt = jest.fn();

    await expect(
      ensureManagedBroadcastPublicationExecutionActive({
        prisma: { publicationOccurrence: { findUnique } } as never,
        row: {
          id: 'broadcast-1',
          lockToken: 'lease-1',
          publicationOccurrenceId: 'occurrence-1',
          publicationContentRevisionId: 'content-1',
        },
        occurrenceIndex: 1,
        onOccurrenceScheduledAt,
      }),
    ).resolves.toBe(true);

    expect(onOccurrenceScheduledAt).toHaveBeenCalledWith(scheduledAt, expect.any(Object));
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'occurrence-1' },
      select: expect.objectContaining({ scheduledAt: true }),
    });
  });

  describe('materialized scheduled publication deadline', () => {
    beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-09-30T09:00:00Z')));
    afterEach(() => jest.useRealTimers());

    function createLateHarness(mode: PublicationScheduleMode = PublicationScheduleMode.ONCE) {
      const occurrence = {
        status: PublicationOccurrenceStatus.IN_PROGRESS,
        scheduledAt: new Date('2026-09-30T07:00:00Z'),
        scheduleRevision: 3,
        contentRevisionId: 'content-1',
        dispatchBlockerCode: null as string | null,
        dispatchBlockedAt: null as Date | null,
        dispatchFirstBlockedAt: null,
        publication: { lifecycle: PublicationLifecycle.ACTIVE },
        schedule: { revision: 3, status: PublicationScheduleStatus.ACTIVE, mode },
      };
      const attemptCount = jest.fn().mockResolvedValue(0);
      const expire = jest.fn().mockResolvedValue({ count: 1 });
      const tx = {
        managedBroadcast: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        managedBroadcastDelivery: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          count: jest.fn().mockResolvedValue(0),
        },
        managedBroadcastCalendarReservation: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
      const prisma = {
        publicationOccurrence: {
          findUnique: jest.fn().mockResolvedValue(occurrence),
          updateMany: expire,
        },
        managedBroadcastDelivery: { count: attemptCount },
        managedBroadcast: tx.managedBroadcast,
        $transaction: jest.fn(async (callback) => callback(tx)),
      };
      const options = {
        prisma: prisma as never,
        row: {
          id: 'broadcast-1',
          lockToken: 'lease-1',
          publicationOccurrenceId: 'occurrence-1',
          publicationContentRevisionId: 'content-1',
        },
        occurrenceIndex: 1,
        reconcileStaleDeliveries: jest.fn().mockResolvedValue(undefined),
      };
      return { occurrence, attemptCount, expire, prisma, tx, options };
    }

    it.each([
      PublicationScheduleMode.ONCE,
      PublicationScheduleMode.SLOTS,
      PublicationScheduleMode.RECURRENCE,
    ])('stops a never-attempted two-hour-old %s occurrence after materialization', async (mode) => {
      const harness = createLateHarness(mode);
      await expect(ensureManagedBroadcastPublicationExecutionActive(harness.options)).resolves.toBe(
        false,
      );
      expect(harness.expire).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            contentRevisionId: 'content-1',
            scheduleRevision: 3,
            deliveries: { none: expect.any(Object) },
          }),
          data: expect.objectContaining({
            status:
              mode === PublicationScheduleMode.RECURRENCE
                ? PublicationOccurrenceStatus.CANCELED
                : PublicationOccurrenceStatus.FAILED,
            dispatchBlockerCode:
              mode === PublicationScheduleMode.RECURRENCE
                ? 'PUBLISHER_WINDOW_EXPIRED'
                : 'PUBLISHER_MISSED_WINDOW_REVIEW',
          }),
        }),
      );
      expect(harness.options.reconcileStaleDeliveries).toHaveBeenCalledTimes(1);
    });

    it('preserves a partial fanout or an attempted send without a receipt for normal recovery', async () => {
      const harness = createLateHarness();
      harness.attemptCount.mockResolvedValue(1);
      await expect(ensureManagedBroadcastPublicationExecutionActive(harness.options)).resolves.toBe(
        true,
      );
      expect(harness.attemptCount).toHaveBeenCalledWith({
        where: expect.objectContaining({ publicationOccurrenceId: 'occurrence-1' }),
      });
      expect(harness.expire).not.toHaveBeenCalled();
      expect(harness.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('does not let the current first pre-dispatch claim bypass the deadline during upload', async () => {
      const harness = createLateHarness();
      harness.tx.managedBroadcastDelivery.count.mockResolvedValue(1);
      await expect(
        ensureManagedBroadcastPublicationExecutionActive({
          ...harness.options,
          preDispatchClaim: { id: 'delivery-1', lockToken: 'delivery-lease-1', attemptCount: 1 },
        }),
      ).resolves.toBe(false);
      expect(harness.attemptCount).toHaveBeenCalledWith({
        where: expect.objectContaining({
          NOT: {
            id: 'delivery-1',
            lockToken: 'delivery-lease-1',
            attemptCount: 1,
            status: ManagedBroadcastDeliveryStatus.SENDING,
            remoteMessageId: null,
            legacySentWithoutRemoteId: false,
          },
        }),
      });
      expect(harness.tx.managedBroadcast.deleteMany).not.toHaveBeenCalled();
    });

    it('does not exclude a previous attempt from crash-safe recovery', async () => {
      const harness = createLateHarness();
      harness.attemptCount.mockResolvedValue(1);
      await expect(
        ensureManagedBroadcastPublicationExecutionActive({
          ...harness.options,
          preDispatchClaim: { id: 'delivery-1', lockToken: 'delivery-lease-1', attemptCount: 2 },
        }),
      ).resolves.toBe(true);
      expect(harness.attemptCount.mock.calls[0][0].where).not.toHaveProperty('NOT');
    });

    it.each([
      { attemptCount: 0, sendAttemptStarted: false, excluded: true },
      { attemptCount: 0, sendAttemptStarted: true, excluded: false },
      { attemptCount: 1, sendAttemptStarted: false, excluded: false },
    ])(
      'excludes a live claim only before its first HTTP request (%j)',
      async ({ attemptCount, sendAttemptStarted, excluded }) => {
        const harness = createLateHarness();
        harness.attemptCount.mockImplementation(async ({ where }: { where: { NOT?: unknown } }) =>
          where.NOT ? 0 : 1,
        );
        const result = await ensureManagedBroadcastPublicationExecutionActive({
          ...harness.options,
          activeDeliveryClaim: {
            id: 'delivery-1',
            lockToken: 'delivery-lease-1',
            attemptCount,
            sendAttemptStarted,
          },
        });
        expect(result).toBe(!excluded);
        if (excluded) {
          expect(harness.attemptCount.mock.calls[0][0].where.NOT).toMatchObject({
            id: 'delivery-1',
            lockToken: 'delivery-lease-1',
            attemptCount: 1,
          });
          expect(harness.expire).toHaveBeenCalledTimes(1);
        } else {
          expect(harness.attemptCount.mock.calls[0][0].where).not.toHaveProperty('NOT');
          expect(harness.expire).not.toHaveBeenCalled();
        }
      },
    );

    it.each([PublicationScheduleMode.NOW, PublicationScheduleMode.ONCE])(
      'preserves %s recovery with a fresh persisted explicit author retry',
      async (mode) => {
        const harness = createLateHarness(mode);
        harness.occurrence.dispatchBlockerCode = 'PUBLISHER_EXPLICIT_RETRY';
        harness.occurrence.dispatchBlockedAt = new Date('2026-09-30T08:59:00Z');
        await expect(
          ensureManagedBroadcastPublicationExecutionActive(harness.options),
        ).resolves.toBe(true);
        expect(harness.attemptCount).not.toHaveBeenCalled();
      },
    );

    it('releases only its envelope lease when a revision or concurrent dispatch wins the expiration fence', async () => {
      const harness = createLateHarness();
      harness.expire.mockResolvedValue({ count: 0 });
      await expect(ensureManagedBroadcastPublicationExecutionActive(harness.options)).resolves.toBe(
        false,
      );
      expect(harness.tx.managedBroadcast.updateMany).toHaveBeenCalledWith({
        where: { id: 'broadcast-1', lockToken: 'lease-1' },
        data: { lockedAt: null, lockToken: null },
      });
      expect(harness.tx.managedBroadcastDelivery.updateMany).not.toHaveBeenCalled();
      expect(harness.options.reconcileStaleDeliveries).not.toHaveBeenCalled();
    });
  });

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
        deferPublicationDeliveryAfterPreDispatchThrottle({
          ...options,
          sendAttemptStarted: false,
        } as never),
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

  it.each(['P2024', 'P2028'])(
    'atomically recycles an attempt-zero delivery after a pre-dispatch Prisma %s failure',
    async (code) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-04T12:00:00.000Z'));
      try {
        const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
        const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
        const deliveryCount = jest.fn();
        const tx = {
          managedBroadcast: { updateMany: broadcastUpdateMany },
          managedBroadcastDelivery: { updateMany: deliveryUpdateMany, count: deliveryCount },
        };
        const transaction = jest.fn(async (callback) => callback(tx));
        const logger = { warn: jest.fn() };
        const error = Object.assign(new Error(`${code} transient database failure`), { code });

        await expect(
          deferPublicationAfterPreDispatchPrismaError({
            context: { prisma: { $transaction: transaction }, logger } as never,
            row: {
              id: 'broadcast-1',
              publicationOccurrenceId: 'occurrence-1',
              status: ManagedBroadcastStatus.ACTIVE,
            },
            occurrenceIndex: 1,
            broadcastLockToken: 'broadcast-lock-1',
            delivery: {
              id: 'delivery-1',
              targetChatId: 'chat-1',
              attemptCount: 0,
              lockToken: 'delivery-lock-1',
            },
            sendAttemptStarted: false,
            error,
          }),
        ).resolves.toEqual(new Date('2026-09-04T12:00:01.000Z'));

        expect(deliveryUpdateMany).toHaveBeenCalledWith({
          where: {
            id: 'delivery-1',
            broadcastId: 'broadcast-1',
            occurrenceIndex: 1,
            status: ManagedBroadcastDeliveryStatus.SENDING,
            attemptCount: 1,
            remoteMessageId: null,
            lockToken: 'delivery-lock-1',
          },
          data: expect.objectContaining({
            status: ManagedBroadcastDeliveryStatus.PENDING,
            attemptCount: { decrement: 1 },
            botId: null,
            remoteMessageId: null,
            lockedAt: null,
            lockToken: null,
            lastErrorCode: null,
            lastError: null,
            dispatchBlockerCode: null,
            dispatchBlockedAt: null,
          }),
        });
        expect(deliveryCount).not.toHaveBeenCalled();
        expect(broadcastUpdateMany).toHaveBeenCalledWith({
          where: {
            id: 'broadcast-1',
            publicationOccurrenceId: 'occurrence-1',
            status: ManagedBroadcastStatus.ACTIVE,
            lockToken: 'broadcast-lock-1',
          },
          data: {
            nextSendAt: new Date('2026-09-04T12:00:01.000Z'),
            lockedAt: null,
            lockToken: null,
            lastError: null,
          },
        });
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each([
    ['a marked MAX attempt', ManagedBroadcastStatus.ACTIVE, true],
    ['a terminal envelope', ManagedBroadcastStatus.FAILED, false],
    ['a partial envelope', ManagedBroadcastStatus.PARTIAL, false],
  ])(
    'does not recycle %s after a transient Prisma failure',
    async (_label, status, sendStarted) => {
      const transaction = jest.fn();
      const error = Object.assign(new Error('pool timeout'), {
        code: 'P2024',
        managedBroadcastSendStarted: sendStarted,
      });

      await expect(
        deferPublicationAfterPreDispatchPrismaError({
          context: {
            prisma: { $transaction: transaction },
            logger: { warn: jest.fn() },
          } as never,
          row: {
            id: 'broadcast-1',
            publicationOccurrenceId: 'occurrence-1',
            status,
          },
          occurrenceIndex: 1,
          broadcastLockToken: 'broadcast-lock-1',
          delivery: {
            id: 'delivery-1',
            targetChatId: 'chat-1',
            attemptCount: 0,
            lockToken: 'delivery-lock-1',
          },
          sendAttemptStarted: sendStarted,
          error,
        }),
      ).resolves.toBeNull();
      expect(transaction).not.toHaveBeenCalled();
    },
  );

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

  it.each([
    { external: false, sendAttemptStarted: false, undo: true },
    { external: false, sendAttemptStarted: true, undo: false },
    { external: false, sendAttemptStarted: undefined, undo: false },
    { external: true, sendAttemptStarted: false, undo: false },
    { external: true, sendAttemptStarted: true, undo: false },
  ])(
    'keeps real request provenance across capacity deferral (%j)',
    async ({ external, sendAttemptStarted, undo }) => {
      const options = createOptions(
        Object.assign(
          new Error('Capacity deferred'),
          external
            ? { response: { status: 429 }, managedBroadcastSendStarted: true }
            : { code: 'MAX_API_INTERNAL_RATE_LIMIT', managedBroadcastSendStarted: false },
        ),
      );
      expect(
        await deferPublicationDeliveryAfterPreDispatchThrottle({
          ...options,
          sendAttemptStarted,
        } as never),
      ).toBeInstanceOf(Date);
      const { where, data } =
        options.context.prisma.managedBroadcastDelivery.updateMany.mock.calls[0][0];
      expect(data.status).toBe('PENDING');
      if (undo) {
        expect(where.attemptCount).toBe(1);
        expect(data.attemptCount).toEqual({ decrement: 1 });
      } else {
        expect(data).not.toHaveProperty('attemptCount');
      }
    },
  );

  it.each([
    {
      label: 'two-hour seconds',
      response: { status: 429, headers: { 'retry-after': '7200' } },
      retryAt: '2026-09-30T11:01:00Z',
    },
    {
      label: 'HTTP date',
      response: { status: 429, headers: { 'Retry-After': 'Wed, 30 Sep 2026 11:00:30 GMT' } },
      retryAt: '2026-09-30T11:01:00Z',
    },
    {
      label: 'longer header than local hint',
      retryAfterMs: 1000,
      response: { status: 429, headers: { 'retry-after': ['7200', '30'] } },
      retryAt: '2026-09-30T11:01:00Z',
    },
    {
      label: 'expired HTTP date',
      response: { status: 429, headers: { 'retry-after': 'Wed, 30 Sep 2026 08:00:00 GMT' } },
      retryAt: '2026-09-30T09:01:00Z',
    },
    {
      label: 'negative header',
      response: { status: 429, headers: { 'retry-after': '-7200' } },
      retryAt: '2026-09-30T09:01:00Z',
    },
    {
      label: 'invalid header',
      response: { status: 429, headers: { 'retry-after': 'unknown' } },
      retryAt: '2026-09-30T09:01:00Z',
    },
    {
      label: 'empty header',
      response: { status: 429, headers: { 'retry-after': '' } },
      retryAt: '2026-09-30T09:01:00Z',
    },
  ])('persists a safe retry time for $label', ({ retryAt, ...error }) => {
    expect(resolvePublicationRateLimitRetryAt(error, new Date('2026-09-30T09:00:30Z'))).toEqual(
      new Date(retryAt),
    );
  });

  it('preserves a longer remote retry hint through wrapper causes', () => {
    const cause = { response: { status: 429, data: { retry_after_ms: 7_200_000 } } };
    const error = Object.assign(new Error('wrapped'), { retryAfterMs: 2000, cause });
    expect(resolvePublicationRateLimitRetryAt(error, new Date('2026-09-30T09:00:30Z'))).toEqual(
      new Date('2026-09-30T11:01:00Z'),
    );
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

  it('rejects a stale atomic occurrence rollup as a retryable conflict', async () => {
    const updatedAt = new Date('2026-09-04T09:00:00.000Z');
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const tx = {
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occurrence-1',
          publicationId: 'publication-1',
          status: PublicationOccurrenceStatus.AMBIGUOUS,
          updatedAt,
          scheduleId: 'schedule-1',
          scheduleRevision: 2,
          contentRevisionId: 'content-1',
          scheduledAt: new Date('2020-09-04T08:00:00.000Z'),
          publication: { lifecycle: PublicationLifecycle.ACTIVE },
          schedule: { revision: 2, status: PublicationScheduleStatus.ACTIVE },
          legacyBroadcasts: [
            {
              status: ManagedBroadcastStatus.ACTIVE,
              deliveries: [
                {
                  status: ManagedBroadcastDeliveryStatus.PENDING,
                  remoteMessageId: null,
                  remoteMessageVerifiedAt: null,
                },
              ],
            },
          ],
        }),
        updateMany,
      },
    };

    await expect(
      syncResolvedPublicationOccurrence(tx as never, 'occurrence-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'occurrence-1',
        publicationId: 'publication-1',
        status: PublicationOccurrenceStatus.AMBIGUOUS,
        updatedAt,
        scheduleId: 'schedule-1',
        scheduleRevision: 2,
        contentRevisionId: 'content-1',
        publication: { is: { lifecycle: PublicationLifecycle.ACTIVE } },
        schedule: {
          is: { revision: 2, status: PublicationScheduleStatus.ACTIVE },
        },
      },
      data: { status: PublicationOccurrenceStatus.IN_PROGRESS },
    });
  });

  it('locks an unchanged runnable occurrence before reactivating error parents', async () => {
    const updatedAt = new Date('2026-09-04T09:00:00.000Z');
    const updateOccurrence = jest.fn().mockResolvedValue({ count: 1 });
    const updatePublication = jest.fn().mockResolvedValue({ count: 1 });
    const updateSchedule = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occurrence-1',
          publicationId: 'publication-1',
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          updatedAt,
          scheduleId: 'schedule-1',
          scheduleRevision: 2,
          contentRevisionId: 'content-1',
          scheduledAt: new Date('2020-09-04T08:00:00.000Z'),
          publication: { lifecycle: PublicationLifecycle.ERROR },
          schedule: { revision: 2, status: PublicationScheduleStatus.ERROR },
          legacyBroadcasts: [
            {
              status: ManagedBroadcastStatus.ACTIVE,
              deliveries: [
                {
                  status: ManagedBroadcastDeliveryStatus.PENDING,
                  remoteMessageId: null,
                  remoteMessageVerifiedAt: null,
                },
              ],
            },
          ],
        }),
        updateMany: updateOccurrence,
      },
      publication: { updateMany: updatePublication },
      publicationSchedule: { updateMany: updateSchedule },
    };

    await syncResolvedPublicationOccurrence(tx as never, 'occurrence-1');

    expect(updateOccurrence).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'occurrence-1',
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          updatedAt,
        }),
        data: { status: PublicationOccurrenceStatus.IN_PROGRESS },
      }),
    );
    expect(updateOccurrence.mock.invocationCallOrder[0]).toBeLessThan(
      updatePublication.mock.invocationCallOrder[0]!,
    );
    expect(updatePublication).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lifecycle: PublicationLifecycle.ACTIVE } }),
    );
    expect(updateSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: PublicationScheduleStatus.ACTIVE, lastError: null },
      }),
    );
  });

  it.each([
    [PublicationLifecycle.PAUSED, PublicationScheduleStatus.PAUSED],
    [PublicationLifecycle.CANCELED, PublicationScheduleStatus.CANCELED],
  ])(
    'keeps %s/%s parent state while resolving the occurrence',
    async (lifecycle, scheduleStatus) => {
      const updateOccurrence = jest.fn().mockResolvedValue({ count: 1 });
      const updatePublication = jest.fn();
      const updateSchedule = jest.fn();
      const tx = {
        publicationOccurrence: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'occurrence-1',
            publicationId: 'publication-1',
            status: PublicationOccurrenceStatus.AMBIGUOUS,
            updatedAt: new Date('2026-09-04T09:00:00.000Z'),
            scheduleId: 'schedule-1',
            scheduleRevision: 2,
            contentRevisionId: 'content-1',
            scheduledAt: new Date('2020-09-04T08:00:00.000Z'),
            publication: { lifecycle },
            schedule: { revision: 2, status: scheduleStatus },
            legacyBroadcasts: [
              {
                status: ManagedBroadcastStatus.ACTIVE,
                deliveries: [
                  {
                    status: ManagedBroadcastDeliveryStatus.PENDING,
                    remoteMessageId: null,
                    remoteMessageVerifiedAt: null,
                  },
                ],
              },
            ],
          }),
          updateMany: updateOccurrence,
        },
        publication: { updateMany: updatePublication },
        publicationSchedule: { updateMany: updateSchedule },
      };

      await expect(
        syncResolvedPublicationOccurrence(tx as never, 'occurrence-1'),
      ).resolves.toBeUndefined();

      expect(updateOccurrence).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: PublicationOccurrenceStatus.IN_PROGRESS } }),
      );
      expect(updatePublication).not.toHaveBeenCalled();
      expect(updateSchedule).not.toHaveBeenCalled();
    },
  );
});
