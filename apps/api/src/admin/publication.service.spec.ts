import {
  ChatEntityType,
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  Prisma,
  PublicationAudienceMode,
  PublicationAudienceSelection,
  PublicationContentFormat,
  PublicationDeliveryVerificationSource,
  PublicationDispatchProfile,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleMode,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { buildMaxActionNoExecutableRouteMessage } from '../max/max-action-dispatch-error';
import { validateMaxMediaUploadPayload } from '../max/max-media-upload-validation';
import { PublisherSetupRequiredException } from '../publisher/publisher-errors';
import {
  type PreparedPublicationContentRevision,
  PublicationContentService,
} from './publication-content.service';
import { PublicationPresenterService } from './publication-presenter.service';
import {
  LEGACY_PUBLICATION_EXECUTION_IMMUTABLE_CODE,
  PublicationPublisherRoutingService,
} from './publication-publisher-routing.service';
import { PublicationService } from './publication.service';
import {
  PUBLICATION_MAX_VIDEO_BYTES,
  PUBLICATION_VIDEO_ASSET_ID_FIELD,
  PUBLICATION_VIDEO_INLINE_BASE64_FIELD,
} from './publication-video-media';
import { TINY_VALID_MP4 } from '../../test/fixtures/max-media';

function createService(prismaOverrides: Record<string, unknown> = {}) {
  const prisma = {
    managedBroadcastDelivery: { groupBy: jest.fn().mockResolvedValue([]) },
    managedBroadcastCalendarReservation: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    ...prismaOverrides,
  };
  const contentService = new PublicationContentService(
    prisma as never,
    {
      validateMediaUploadPayload: validateMaxMediaUploadPayload,
    } as never,
  );
  const presenter = new PublicationPresenterService(prisma as never);
  const managedEntitiesService = {
    listChats: jest.fn().mockResolvedValue([
      {
        id: 'chat-1',
        entityType: 'chat',
        title: 'Чат 1',
        avatarUrl: null,
        link: null,
      },
    ]),
    listChannels: jest.fn().mockResolvedValue([
      {
        id: 'channel-1',
        entityType: 'channel',
        title: 'Канал 1',
        avatarUrl: null,
        link: null,
      },
    ]),
    assertChatAdminAccess: jest.fn().mockResolvedValue(undefined),
    assertChannelAdminAccess: jest.fn().mockResolvedValue(undefined),
  };
  const publisherTargets = [
    {
      chatId: 'chat-1',
      entityType: 'chat' as const,
      title: 'Чат 1',
      avatarUrl: null,
      link: null,
    },
    {
      chatId: 'channel-1',
      entityType: 'channel' as const,
      title: 'Канал 1',
      avatarUrl: null,
      link: null,
    },
  ];
  const publisherPolicyService = {
    resolvePublicationTargets: jest.fn(
      async (
        _user: unknown,
        requested?: readonly { chatId: string; entityType: 'chat' | 'channel' }[],
      ) => {
        if (!requested) {
          return publisherTargets;
        }
        return requested.map((target) => {
          const resolved = publisherTargets.find(
            (candidate) =>
              candidate.chatId === target.chatId && candidate.entityType === target.entityType,
          );
          if (!resolved) {
            throw new BadRequestException('Publisher target unavailable');
          }
          return resolved;
        });
      },
    ),
  };
  const audienceRouting = new PublicationPublisherRoutingService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    managedEntitiesService as never,
    publisherPolicyService as never,
  );
  const publisherRouting = {
    resolveAudienceTargets: jest.fn(audienceRouting.resolveAudienceTargets.bind(audienceRouting)),
    resolvePersistedTargets: jest.fn(audienceRouting.resolvePersistedTargets.bind(audienceRouting)),
    requireNewRoute: jest.fn().mockReturnValue({
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: 'publisher-bot',
    }),
    assertTargetsReady: jest.fn().mockImplementation(async (targets: any[]) =>
      targets.map((target) => ({
        ...target,
        requiredBotId: 'publisher-bot',
        policyRevision: 1,
      })),
    ),
    blockedRetryBefore: jest.fn((now: Date) => new Date(now.getTime() - 60_000)),
    deferOccurrenceIfBlocked: jest.fn().mockResolvedValue(false),
    prepareOccurrenceRoute: jest.fn().mockImplementation(async (_profile, _botId, targets) => ({
      broadcastData: {
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        requiredBotId: 'publisher-bot',
      },
      deliveryDataByChatId: new Map(
        targets.map((target: any) => [
          target.chatId,
          {
            dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
            requiredBotId: 'publisher-bot',
            dialogBotId: 'primary-bot',
            publisherDialogContext: {
              version: 1,
              dialogBotId: 'primary-bot',
              buttons: [],
              reference: null,
            },
            publicationPolicyRevision: 1,
          },
        ]),
      ),
    })),
  };
  const service = new PublicationService(
    prisma as never,
    contentService,
    presenter,
    managedEntitiesService as never,
    {} as never,
    {} as never,
    {} as never,
    publisherRouting as never,
  );
  return {
    contentService,
    presenter,
    service,
    prisma,
    managedEntitiesService,
    publisherPolicyService,
    publisherRouting,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function extractSqlText(query: unknown): string {
  const strings = (query as { strings?: readonly string[] } | null)?.strings;
  return (Array.isArray(strings) ? strings.join('?') : String(query)).replace(/\s+/gu, ' ').trim();
}

function extractSqlValues(query: unknown): readonly unknown[] {
  return (query as { values?: readonly unknown[] } | null)?.values ?? [];
}

function createPublicationUpdateTransaction() {
  return {
    $executeRaw: jest.fn().mockResolvedValue(1),
    publication: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    publicationTarget: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    publicationSchedule: {
      update: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    publicationOccurrence: {
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      createMany: jest.fn(),
    },
    managedBroadcast: {
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    managedBroadcastDelivery: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    publicationMutationRecord: {
      create: jest.fn().mockResolvedValue({}),
    },
  };
}

function createOriginalRetryService(
  tx: Record<string, unknown>,
  occurrenceStatus: PublicationOccurrenceStatus = PublicationOccurrenceStatus.FAILED,
) {
  const failedDeliveryCount = jest.fn().mockResolvedValue(1);
  const transaction = jest.fn((callback: (client: typeof tx) => unknown) => callback(tx));
  const { service, managedEntitiesService } = createService({
    publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
    publication: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'publication-1',
        version: 7,
        lifecycle: PublicationLifecycle.ERROR,
        canonicalContentRevisionId: 'content-latest',
        targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
      }),
    },
    publicationOccurrence: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'occurrence-1',
        publicationId: 'publication-1',
        scheduleId: 'schedule-1',
        scheduleRevision: 5,
        contentRevisionId: 'content-original',
        contentRevision: { revision: 1 },
        status: occurrenceStatus,
        legacyBroadcastId: 'broadcast-1',
        schedule: { id: 'schedule-1', mode: PublicationScheduleMode.ONCE },
        legacyBroadcasts: [{ id: 'broadcast-1' }],
        _count: { deliveries: 1, legacyBroadcasts: 1 },
      }),
    },
    managedBroadcastDelivery: { count: failedDeliveryCount },
    $transaction: transaction,
  });
  jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-1' } as never);
  return { service, transaction, failedDeliveryCount, managedEntitiesService };
}

describe('PublicationService', () => {
  it('materializes and dispatches NOW publications and rolls up state while background work is paused', async () => {
    const { service } = createService();
    const backgroundRuntimeGovernorService = {
      decide: jest.fn().mockResolvedValue({
        action: 'pause',
        reason: 'user-facing queue lag 12.0s',
        retryAfterMs: 60_000,
      }),
    };
    const verificationBudget = { remaining: 50 };
    const managedBroadcastService = {
      processDueImmediatePublicationBroadcasts: jest.fn().mockResolvedValue(verificationBudget),
      processDueDeadlinePublicationBroadcasts: jest.fn().mockResolvedValue(undefined),
    };
    (service as any).backgroundRuntimeGovernorService = backgroundRuntimeGovernorService;
    (service as any).managedBroadcastService = managedBroadcastService;
    const normalizeSpy = jest
      .spyOn(service as any, 'normalizeStalePublicationOccurrences')
      .mockResolvedValue(undefined);
    const reconcileOrphansSpy = jest
      .spyOn(service as any, 'reconcileOrphanedPublicationOccurrences')
      .mockResolvedValue(undefined);
    const reconcileSpy = jest
      .spyOn(service as any, 'reconcileActiveRecurrenceSchedules')
      .mockResolvedValue(undefined);
    const dispatchSpy = jest
      .spyOn(service as any, 'dispatchScheduledOccurrences')
      .mockResolvedValue(undefined);
    const materializeSpy = jest
      .spyOn(service as any, 'materializeRecurringSchedules')
      .mockResolvedValue(undefined);
    const rollupOccurrencesSpy = jest
      .spyOn(service as any, 'rollupActiveOccurrences')
      .mockResolvedValue(undefined);
    const rollupPublicationsSpy = jest
      .spyOn(service as any, 'rollupPublicationLifecycles')
      .mockResolvedValue(undefined);

    await service.processDuePublications('scheduled');

    expect(normalizeSpy).toHaveBeenCalledWith(200);
    expect(reconcileOrphansSpy).toHaveBeenCalledWith(200);
    expect(reconcileSpy).toHaveBeenCalledWith(200);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenNthCalledWith(1, 50, [PublicationScheduleMode.NOW]);
    expect(managedBroadcastService.processDueImmediatePublicationBroadcasts).toHaveBeenCalledTimes(
      1,
    );
    expect(managedBroadcastService.processDueImmediatePublicationBroadcasts).toHaveBeenCalledWith();
    expect(managedBroadcastService.processDueDeadlinePublicationBroadcasts).not.toHaveBeenCalled();
    expect(backgroundRuntimeGovernorService.decide).toHaveBeenCalledWith({
      component: 'publication-materializer',
      sourceTag: 'managed_broadcast',
      allowMaxApiCapacitySlowPath: true,
    });
    expect(materializeSpy).not.toHaveBeenCalled();
    expect(rollupOccurrencesSpy).toHaveBeenCalledTimes(1);
    expect(rollupPublicationsSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy.mock.invocationCallOrder[0]).toBeLessThan(
      managedBroadcastService.processDueImmediatePublicationBroadcasts.mock.invocationCallOrder[0],
    );
    expect(normalizeSpy.mock.invocationCallOrder[0]).toBeLessThan(
      reconcileOrphansSpy.mock.invocationCallOrder[0],
    );
    expect(reconcileOrphansSpy.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchSpy.mock.invocationCallOrder[0],
    );
    expect(
      managedBroadcastService.processDueImmediatePublicationBroadcasts.mock.invocationCallOrder[0],
    ).toBeLessThan(backgroundRuntimeGovernorService.decide.mock.invocationCallOrder[0]);
    expect(rollupOccurrencesSpy.mock.invocationCallOrder[0]).toBeLessThan(
      backgroundRuntimeGovernorService.decide.mock.invocationCallOrder[0],
    );
    expect(rollupPublicationsSpy.mock.invocationCallOrder[0]).toBeLessThan(
      backgroundRuntimeGovernorService.decide.mock.invocationCallOrder[0],
    );
  });

  it('bounds deadline materialization and delivery when the background governor is slow', async () => {
    const { service } = createService();
    const backgroundRuntimeGovernorService = {
      decide: jest.fn().mockResolvedValue({
        action: 'slow',
        reason: 'MAX API capacity is constrained',
        retryAfterMs: 15_000,
      }),
    };
    const verificationBudget = { remaining: 50 };
    const managedBroadcastService = {
      processDueImmediatePublicationBroadcasts: jest.fn().mockResolvedValue(verificationBudget),
      processDueDeadlinePublicationBroadcasts: jest.fn().mockResolvedValue(undefined),
    };
    (service as any).backgroundRuntimeGovernorService = backgroundRuntimeGovernorService;
    (service as any).managedBroadcastService = managedBroadcastService;
    jest.spyOn(service as any, 'normalizeStalePublicationOccurrences').mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'reconcileOrphanedPublicationOccurrences')
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, 'reconcileActiveRecurrenceSchedules').mockResolvedValue(undefined);
    const dispatchSpy = jest
      .spyOn(service as any, 'dispatchScheduledOccurrences')
      .mockResolvedValue(undefined);
    const materializeSpy = jest
      .spyOn(service as any, 'materializeRecurringSchedules')
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, 'rollupActiveOccurrences').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'rollupPublicationLifecycles').mockResolvedValue(undefined);

    await service.processDuePublications('scheduled');

    expect(dispatchSpy).toHaveBeenNthCalledWith(1, 50, [PublicationScheduleMode.NOW]);
    expect(dispatchSpy).toHaveBeenNthCalledWith(2, 10, [
      PublicationScheduleMode.ONCE,
      PublicationScheduleMode.SLOTS,
      PublicationScheduleMode.RECURRENCE,
    ]);
    expect(dispatchSpy).toHaveBeenNthCalledWith(3, 10, [
      PublicationScheduleMode.ONCE,
      PublicationScheduleMode.SLOTS,
      PublicationScheduleMode.RECURRENCE,
    ]);
    expect(managedBroadcastService.processDueImmediatePublicationBroadcasts).toHaveBeenCalledWith();
    expect(managedBroadcastService.processDueDeadlinePublicationBroadcasts).toHaveBeenCalledWith(
      10,
      verificationBudget,
    );
    expect(materializeSpy).toHaveBeenCalledWith(10);
    expect(backgroundRuntimeGovernorService.decide.mock.invocationCallOrder[0]).toBeLessThan(
      managedBroadcastService.processDueDeadlinePublicationBroadcasts.mock.invocationCallOrder[0],
    );
  });

  it('cancels only provably stale scheduled occurrences during reconciliation', async () => {
    const now = new Date('2026-07-10T09:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    try {
      const updateMany = jest.fn().mockResolvedValue({ count: 3 });
      const queryRaw = jest
        .fn()
        .mockResolvedValue([{ id: 'paused-past' }, { id: 'old-revision' }, { id: 'completed' }]);
      const { service } = createService({
        $queryRaw: queryRaw,
        publicationOccurrence: {
          updateMany,
        },
      });

      await (service as any).normalizeStalePublicationOccurrences(500);

      const selectionSql = extractSqlText(queryRaw.mock.calls[0]?.[0]);
      expect(extractSqlValues(queryRaw.mock.calls[0]?.[0])).toEqual([now, 200]);
      expect(selectionSql).toContain('po."schedule_revision" <> ps."revision"');
      expect(selectionSql).toContain(
        'ps."status" = \'PAUSED\'::"PublicationScheduleStatus" AND po."scheduled_at" < ?',
      );
      expect(selectionSql).toContain('AND NOT EXISTS');
      expect(selectionSql).toContain(
        '\'SENDING\'::"ManagedBroadcastDeliveryStatus", \'AMBIGUOUS\'::"ManagedBroadcastDeliveryStatus"',
      );
      expect(selectionSql).toMatch(
        /WHERE .*po\."schedule_revision" <> ps\."revision".*AND NOT EXISTS .*ORDER BY po\."scheduled_at" ASC, po\."id" ASC LIMIT \?$/u,
      );

      expect(updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['paused-past', 'old-revision', 'completed'] },
          status: PublicationOccurrenceStatus.SCHEDULED,
          deliveries: {
            none: {
              status: {
                in: [
                  ManagedBroadcastDeliveryStatus.SENDING,
                  ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                ],
              },
            },
          },
        },
        data: { status: PublicationOccurrenceStatus.CANCELED },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('atomically reconciles old in-progress occurrences without execution envelopes', async () => {
    const now = new Date('2026-07-26T18:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    try {
      const queryRaw = jest.fn().mockResolvedValue([
        { id: 'stale-revision', status: PublicationOccurrenceStatus.CANCELED },
        { id: 'current-error', status: PublicationOccurrenceStatus.FAILED },
      ]);
      const { service } = createService({ $queryRaw: queryRaw });
      const warn = jest.fn();
      (service as any).logger.warn = warn;

      await (service as any).reconcileOrphanedPublicationOccurrences(500);

      const query = queryRaw.mock.calls[0]?.[0];
      const selectionSql = extractSqlText(query);
      expect(extractSqlValues(query)).toEqual([new Date(now.getTime() - 5 * 60_000), 200]);
      expect(selectionSql).toContain(
        'WHERE po."status" = \'IN_PROGRESS\'::"PublicationOccurrenceStatus" AND po."scheduled_at" < ?',
      );
      expect(selectionSql).toContain('po."schedule_revision" <> ps."revision"');
      expect(selectionSql).toContain(
        '\'PAUSED\'::"PublicationScheduleStatus", \'COMPLETED\'::"PublicationScheduleStatus", \'CANCELED\'::"PublicationScheduleStatus"',
      );
      expect(selectionSql).toContain(
        'THEN \'CANCELED\'::"PublicationOccurrenceStatus" ELSE \'FAILED\'::"PublicationOccurrenceStatus"',
      );
      expect(selectionSql).toContain('po."legacy_broadcast_id" IS NULL');
      expect(selectionSql).toContain(
        'FROM "managed_broadcasts" AS mb WHERE mb."publication_occurrence_id" = po."id"',
      );
      expect(selectionSql).toContain(
        'FROM "managed_broadcast_deliveries" AS d WHERE d."publication_occurrence_id" = po."id"',
      );
      expect(selectionSql).toContain('LIMIT ? FOR UPDATE OF po SKIP LOCKED');
      expect(selectionSql).toContain(
        'UPDATE "publication_occurrences" AS po SET "status" = candidate."next_status"',
      );
      expect(selectionSql).not.toContain('\'SCHEDULED\'::"PublicationOccurrenceStatus"');
      expect(warn).toHaveBeenCalledWith(
        {
          recovered: 2,
          canceled: 1,
          failed: 1,
          cutoff: new Date(now.getTime() - 5 * 60_000).toISOString(),
        },
        'Reconciled publication occurrences without execution envelopes',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('skips orphan reconciliation for an invalid batch limit', async () => {
    const { service, prisma } = createService();

    await (service as any).reconcileOrphanedPublicationOccurrences(0);

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('accelerates recurrence materialization when the current horizon has no future occurrence', async () => {
    const now = new Date('2026-07-10T09:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    try {
      const scheduledRefreshAt = new Date(now.getTime() + 6 * 60 * 60_000);
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const { service } = createService({
        publicationSchedule: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'schedule-1',
              publicationId: 'publication-1',
              revision: 3,
              nextMaterializeAt: scheduledRefreshAt,
              rule: {
                mode: 'recurrence',
                timezone: 'UTC',
                frequency: 'daily',
                interval: 1,
                weekdays: [],
                times: ['10:00'],
                startsAt: '2026-07-01T09:00:00.000Z',
                endsAt: null,
                maxOccurrences: null,
                replaceConflicts: false,
              },
              occurrences: [],
            },
          ]),
          updateMany,
        },
        publicationOccurrence: {
          count: jest.fn().mockResolvedValue(0),
          findFirst: jest.fn().mockResolvedValue(null),
        },
      });

      await (service as any).reconcileActiveRecurrenceSchedules(200);

      expect(updateMany).toHaveBeenCalledWith({
        where: {
          id: 'schedule-1',
          revision: 3,
          status: PublicationScheduleStatus.ACTIVE,
          nextMaterializeAt: scheduledRefreshAt,
          publication: { is: { lifecycle: PublicationLifecycle.ACTIVE } },
        },
        data: { nextMaterializeAt: now },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns occupied calendar slots only for the selected publication targets', async () => {
    const scheduledAt = new Date('2026-07-12T09:00:00.000Z');
    const { service, prisma } = createService({
      managedBroadcastCalendarReservation: {
        findMany: jest.fn().mockResolvedValue([
          {
            entityType: ChatEntityType.CHAT,
            targetChatId: 'chat-1',
            scheduledAt,
            broadcast: { publicationOccurrence: null },
          },
        ]),
      },
      publicationOccurrence: {
        findMany: jest.fn().mockResolvedValue([
          {
            scheduledAt,
            publication: {
              targets: [
                { entityType: ChatEntityType.CHAT, targetChatId: 'chat-1' },
                { entityType: ChatEntityType.CHANNEL, targetChatId: 'channel-1' },
              ],
            },
          },
        ]),
      },
    });
    jest.spyOn(service as any, 'resolveAudienceTargets').mockResolvedValue([
      {
        chatId: 'chat-1',
        entityType: 'chat',
        title: 'Чат',
        avatarUrl: null,
        link: null,
      },
      {
        chatId: 'channel-1',
        entityType: 'channel',
        title: 'Канал',
        avatarUrl: null,
        link: null,
      },
    ]);

    const result = await service.getCalendarAvailability({ userId: 'user-1' } as never, {
      audience: {
        selection: 'SELECTED',
        mode: 'SNAPSHOT',
        targets: [
          { chatId: 'chat-1', entityType: 'chat' },
          { chatId: 'channel-1', entityType: 'channel' },
        ],
      },
      from: '2026-07-11T00:00:00.000Z',
      to: '2026-07-31T23:59:59.999Z',
    });

    expect(result).toEqual({
      from: '2026-07-11T00:00:00.000Z',
      to: '2026-07-31T23:59:59.999Z',
      slots: [{ scheduledAt: scheduledAt.toISOString(), targetCount: 2 }],
    });
    expect(prisma.managedBroadcastCalendarReservation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scheduledAt: { gte: expect.any(Date), lte: expect.any(Date) },
        }),
      }),
    );
  });

  it('anchors recurrence and rejects off-grid local times', () => {
    const { service } = createService();
    const now = new Date('2026-07-10T09:00:00.000Z');

    expect(
      (service as any).normalizeSchedule(
        {
          mode: 'recurrence',
          timezone: 'Europe/Moscow',
          frequency: 'daily',
          interval: 1,
          weekdays: [],
          times: ['12:30'],
          startsAt: null,
          endsAt: null,
          maxOccurrences: null,
          replaceConflicts: false,
        },
        now,
      ),
    ).toEqual(
      expect.objectContaining({
        startsAt: now.toISOString(),
        times: ['12:30'],
      }),
    );

    expect(() =>
      (service as any).normalizeSchedule(
        {
          mode: 'once',
          timezone: 'Europe/Moscow',
          at: '2026-07-10T12:15:00.000+03:00',
          replaceConflicts: false,
        },
        now,
      ),
    ).toThrow('шагом 30 минут');
  });

  it('returns a bad request for an unknown IANA timezone', () => {
    const { service } = createService();
    const normalize = () =>
      (service as any).normalizeSchedule(
        {
          mode: 'once',
          timezone: 'Mars/Olympus',
          at: '2026-07-10T12:30:00.000+03:00',
          replaceConflicts: false,
        },
        new Date('2026-07-10T09:00:00.000Z'),
      );

    expect(normalize).toThrow(BadRequestException);
    try {
      normalize();
    } catch (error: unknown) {
      expect((error as BadRequestException).getStatus()).toBe(400);
    }
  });

  it('rejects once and slot timestamps with non-zero seconds', () => {
    const { service } = createService();

    expect(() =>
      (service as any).normalizeSchedule(
        {
          mode: 'once',
          timezone: 'Europe/Moscow',
          at: '2026-07-10T12:30:01.000+03:00',
          replaceConflicts: false,
        },
        new Date('2026-07-10T09:00:00.000Z'),
      ),
    ).toThrow('шагом 30 минут');
  });

  it('rejects a bounded recurrence with no possible future occurrence', () => {
    const { service } = createService();
    const now = new Date('2026-07-10T09:00:00.000Z');
    const schedule = {
      mode: 'recurrence',
      timezone: 'UTC',
      frequency: 'daily',
      interval: 1,
      weekdays: [],
      times: ['12:00'],
      startsAt: now.toISOString(),
      endsAt: '2026-07-10T10:00:00.000Z',
      maxOccurrences: null,
      replaceConflicts: false,
    } as const;

    expect(() => (service as any).assertPublishableSchedule(schedule, [], now)).toThrow(
      BadRequestException,
    );
    try {
      (service as any).assertPublishableSchedule(schedule, [], now);
    } catch (error: unknown) {
      expect((error as BadRequestException).getResponse()).toEqual({
        code: 'PUBLICATION_SCHEDULE_EMPTY',
        message: 'Расписание не содержит ни одного будущего запуска.',
      });
    }
  });

  it('schedules far-future recurrence materialization when its first slot enters the horizon', () => {
    const { service } = createService();
    const now = new Date('2026-07-10T09:00:00.000Z');
    const firstSlot = new Date('2026-09-10T10:00:00.000Z');
    const schedule = {
      mode: 'recurrence',
      timezone: 'UTC',
      frequency: 'daily',
      interval: 1,
      weekdays: [],
      times: ['10:00'],
      startsAt: '2026-09-10T09:00:00.000Z',
      endsAt: null,
      maxOccurrences: null,
      replaceConflicts: false,
    } as const;

    expect(
      (service as any).resolveInitialRecurrenceMaterializeAt(schedule, [], false, now),
    ).toEqual(new Date(firstSlot.getTime() - 14 * 24 * 60 * 60_000));
  });

  it('finishes content preparation before opening a create transaction', async () => {
    const tx = {
      publication: {
        create: jest.fn().mockResolvedValue({ id: 'publication-create' }),
        update: jest.fn().mockResolvedValue({}),
      },
      publicationMutationRecord: { create: jest.fn().mockResolvedValue({}) },
    };
    const transaction = jest.fn((callback: (client: typeof tx) => unknown) => callback(tx));
    const { service, contentService } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: transaction,
    });
    const preparationStarted = createDeferred<void>();
    const preparation = createDeferred<PreparedPublicationContentRevision>();
    const prepareSpy = jest
      .spyOn(contentService, 'prepareContentRevision')
      .mockImplementation(() => {
        preparationStarted.resolve(undefined);
        return preparation.promise;
      });
    jest
      .spyOn(contentService, 'persistPreparedContentRevision')
      .mockResolvedValue({ id: 'content-create' } as never);
    jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-create' } as never);

    const createPromise = service.create(
      { userId: 'user-1', username: null, displayName: null },
      {
        requestId: 'create_prepare_001',
        title: 'Черновик',
        content: { text: 'Текст', textFormat: 'plain', buttons: [], media: [] },
        audience: {
          selection: 'SELECTED',
          mode: 'SNAPSHOT',
          targets: [{ chatId: 'chat-1', entityType: 'chat' }],
        },
        schedule: null,
        intent: 'draft',
      },
    );

    await preparationStarted.promise;
    expect(transaction).not.toHaveBeenCalled();
    expect(tx.publication.create).not.toHaveBeenCalled();

    preparation.resolve({ text: 'Текст', textFormat: 'plain', buttons: [], assets: [] });
    await expect(createPromise).resolves.toEqual({ id: 'publication-create' });
    expect(tx.publication.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          requiredBotId: 'publisher-bot',
        }),
      }),
    );
    expect(prepareSpy.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.mock.invocationCallOrder[0],
    );
  });

  it('rejects a new publication root when the publisher bot is not configured', async () => {
    const { service, contentService } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    (service as any).publisherRouting.requireNewRoute.mockImplementation(() => {
      throw new ConflictException({ code: 'PUBLISHER_SETUP_REQUIRED' });
    });
    const prepare = jest.spyOn(contentService, 'prepareContentRevision');

    await expect(
      service.create(
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'create_missing_publisher_001',
          title: 'Черновик',
          content: { text: 'Текст', textFormat: 'plain', buttons: [], media: [] },
          audience: {
            selection: 'SELECTED',
            mode: 'SNAPSHOT',
            targets: [{ chatId: 'chat-1', entityType: 'chat' }],
          },
          schedule: null,
          intent: 'draft',
        },
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'PUBLISHER_SETUP_REQUIRED',
      },
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('finishes content preparation before the update transaction takes the calendar lock', async () => {
    const tx = createPublicationUpdateTransaction();
    const transaction = jest.fn((callback: (client: typeof tx) => unknown) => callback(tx));
    const { service, contentService } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-prepare-update',
          actorUserId: 'user-1',
          version: 2,
          lifecycle: PublicationLifecycle.DRAFT,
          title: 'Черновик',
          audienceSelection: 'SELECTED',
          audienceMode: 'SNAPSHOT',
          canonicalContentRevisionId: 'content-old',
          canonicalContentRevision: { id: 'content-old' },
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT, position: 0 }],
          schedule: null,
        }),
      },
      $transaction: transaction,
    });
    const preparationStarted = createDeferred<void>();
    const preparation = createDeferred<PreparedPublicationContentRevision>();
    const prepareSpy = jest
      .spyOn(contentService, 'prepareContentRevision')
      .mockImplementation(() => {
        preparationStarted.resolve(undefined);
        return preparation.promise;
      });
    jest
      .spyOn(contentService, 'persistPreparedContentRevision')
      .mockResolvedValue({ id: 'content-new' } as never);
    jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-prepare-update' } as never);

    const updatePromise = service.update(
      'publication-prepare-update',
      { userId: 'user-1', username: null, displayName: null },
      {
        requestId: 'update_prepare_001',
        expectedRevision: 2,
        content: { text: 'Новый текст', textFormat: 'plain', buttons: [], media: [] },
        intent: 'draft',
      },
    );

    await preparationStarted.promise;
    expect(transaction).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();

    preparation.resolve({ text: 'Новый текст', textFormat: 'plain', buttons: [], assets: [] });
    await expect(updatePromise).resolves.toEqual({ id: 'publication-prepare-update' });
    expect(prepareSpy.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.mock.invocationCallOrder[0],
    );
    expect(transaction.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$executeRaw.mock.invocationCallOrder[0],
    );
  });

  it('rejects activation of a migrated legacy draft before creating dispatch work', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T09:00:00.000Z'));
    try {
      const transaction = jest.fn();
      const { contentService, publisherRouting, service } = createService({
        publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
        publication: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'legacy-draft',
            actorUserId: 'user-1',
            version: 3,
            lifecycle: PublicationLifecycle.DRAFT,
            title: 'Старый черновик',
            audienceSelection: 'SELECTED',
            audienceMode: 'SNAPSHOT',
            canonicalContentRevisionId: 'content-legacy-draft',
            canonicalContentRevision: { id: 'content-legacy-draft' },
            dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED,
            requiredBotId: null,
            targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT, position: 0 }],
            schedule: {
              id: 'legacy-draft-schedule',
              revision: 2,
              status: PublicationScheduleStatus.DRAFT,
              rule: {
                mode: 'once',
                timezone: 'Europe/Moscow',
                at: '2026-08-27T12:00:00.000+03:00',
                replaceConflicts: false,
              },
            },
          }),
        },
        $transaction: transaction,
      });
      const prepareContent = jest.spyOn(contentService, 'prepareContentRevision');

      await expect(
        service.update(
          'legacy-draft',
          { userId: 'user-1', username: null, displayName: null },
          {
            requestId: 'legacy-draft-activate-001',
            expectedRevision: 3,
            schedule: {
              mode: 'once',
              timezone: 'Europe/Moscow',
              at: '2026-08-27T12:00:00.000+03:00',
              replaceConflicts: false,
            },
            intent: 'publish',
          },
        ),
      ).rejects.toMatchObject({
        response: { code: LEGACY_PUBLICATION_EXECUTION_IMMUTABLE_CODE },
      });

      expect(publisherRouting.assertTargetsReady).not.toHaveBeenCalled();
      expect(prepareContent).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects rescheduling and editing a migrated legacy publication before persistence', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T09:00:00.000Z'));
    try {
      const transaction = jest.fn();
      const { contentService, publisherRouting, service } = createService({
        publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
        publication: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'legacy-scheduled',
            actorUserId: 'user-1',
            version: 5,
            lifecycle: PublicationLifecycle.ACTIVE,
            title: 'Старый план',
            audienceSelection: 'SELECTED',
            audienceMode: 'SNAPSHOT',
            canonicalContentRevisionId: 'content-legacy-scheduled',
            canonicalContentRevision: { id: 'content-legacy-scheduled' },
            dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED,
            requiredBotId: null,
            targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT, position: 0 }],
            schedule: {
              id: 'legacy-active-schedule',
              revision: 4,
              status: PublicationScheduleStatus.ACTIVE,
              rule: {
                mode: 'once',
                timezone: 'Europe/Moscow',
                at: '2026-08-27T12:00:00.000+03:00',
                replaceConflicts: false,
              },
            },
          }),
        },
        $transaction: transaction,
      });
      const prepareContent = jest.spyOn(contentService, 'prepareContentRevision');

      await expect(
        service.update(
          'legacy-scheduled',
          { userId: 'user-1', username: null, displayName: null },
          {
            requestId: 'legacy-reschedule-edit-001',
            expectedRevision: 5,
            title: 'Новый план',
            content: { text: 'Новый текст', textFormat: 'plain', buttons: [], media: [] },
            schedule: {
              mode: 'once',
              timezone: 'Europe/Moscow',
              at: '2026-08-28T12:00:00.000+03:00',
              replaceConflicts: false,
            },
            intent: 'publish',
          },
        ),
      ).rejects.toMatchObject({
        response: { code: LEGACY_PUBLICATION_EXECUTION_IMMUTABLE_CODE },
      });

      expect(publisherRouting.assertTargetsReady).not.toHaveBeenCalled();
      expect(prepareContent).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a content-only edit of materialized legacy work without mutating its intent', async () => {
    const transaction = jest.fn();
    const { contentService, service } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'legacy-materialized',
          actorUserId: 'user-1',
          version: 6,
          lifecycle: PublicationLifecycle.ACTIVE,
          title: 'Старый план',
          audienceSelection: 'SELECTED',
          audienceMode: 'SNAPSHOT',
          canonicalContentRevisionId: 'content-legacy-materialized',
          canonicalContentRevision: { id: 'content-legacy-materialized' },
          dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED,
          requiredBotId: null,
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT, position: 0 }],
          schedule: {
            id: 'legacy-materialized-schedule',
            revision: 4,
            status: PublicationScheduleStatus.ACTIVE,
            rule: { mode: 'now', timezone: 'Europe/Moscow' },
          },
        }),
      },
      $transaction: transaction,
    });
    const prepareContent = jest.spyOn(contentService, 'prepareContentRevision');

    await expect(
      service.update(
        'legacy-materialized',
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'legacy-content-edit-001',
          expectedRevision: 6,
          content: { text: 'Подмененный текст', textFormat: 'plain', buttons: [], media: [] },
          schedule: { mode: 'now', timezone: 'Europe/Moscow' },
          intent: 'publish',
        },
      ),
    ).rejects.toMatchObject({
      response: { code: LEGACY_PUBLICATION_EXECUTION_IMMUTABLE_CODE },
    });

    expect(prepareContent).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('updates an already materialized NOW occurrence without rebuilding its schedule', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T09:00:05.000Z'));
    try {
      const tx = createPublicationUpdateTransaction();
      const { service, contentService } = createService({
        publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
        publication: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'publication-now',
            actorUserId: 'user-1',
            version: 3,
            lifecycle: PublicationLifecycle.ACTIVE,
            title: 'Старый заголовок',
            audienceSelection: 'SELECTED',
            audienceMode: 'SNAPSHOT',
            canonicalContentRevisionId: 'content-old',
            canonicalContentRevision: { id: 'content-old' },
            dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
            requiredBotId: 'publisher-bot',
            targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT, position: 0 }],
            schedule: {
              id: 'schedule-now',
              revision: 4,
              rule: { mode: 'now', timezone: 'Europe/Moscow' },
            },
          }),
        },
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      });
      jest
        .spyOn(contentService, 'persistPreparedContentRevision')
        .mockResolvedValue({ id: 'content-new' } as never);
      jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-now' } as never);

      await service.update(
        'publication-now',
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'update-now-001',
          expectedRevision: 3,
          title: 'Новый заголовок',
          content: {
            text: 'Новый текст',
            textFormat: 'plain',
            buttons: [],
            media: [],
          },
          audience: {
            selection: 'SELECTED',
            mode: 'SNAPSHOT',
            targets: [{ chatId: 'chat-1', entityType: 'chat' }],
          },
          schedule: { mode: 'now', timezone: 'Europe/Moscow' },
          intent: 'publish',
        },
      );

      expect(tx.publicationTarget.deleteMany).not.toHaveBeenCalled();
      expect(tx.publicationSchedule.update).not.toHaveBeenCalled();
      expect(tx.publicationSchedule.create).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.findMany).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.createMany).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith({
        where: {
          publicationId: 'publication-now',
          scheduleId: 'schedule-now',
          scheduleRevision: 4,
          status: PublicationOccurrenceStatus.SCHEDULED,
        },
        data: { contentRevisionId: 'content-new' },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects an update when a cached target fails live admin verification', async () => {
    const transaction = jest.fn();
    const { service, managedEntitiesService } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-revoked',
          actorUserId: 'user-1',
          version: 2,
          lifecycle: PublicationLifecycle.ACTIVE,
          audienceSelection: 'SELECTED',
          audienceMode: 'SNAPSHOT',
          schedule: null,
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT, position: 0 }],
        }),
      },
      $transaction: transaction,
    });
    managedEntitiesService.assertChatAdminAccess.mockRejectedValue(
      new ForbiddenException('Пользователь не является администратором чата.'),
    );

    await expect(
      service.update(
        'publication-revoked',
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'update-revoked-001',
          expectedRevision: 2,
          title: 'Новый заголовок',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(managedEntitiesService.listChats).toHaveBeenCalledTimes(1);
    expect(managedEntitiesService.assertChatAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects an audience replacement before canceling work for a revoked persisted target', async () => {
    const tx = createPublicationUpdateTransaction();
    tx.publicationOccurrence.findMany.mockResolvedValue([]);
    const transaction = jest.fn((callback: (client: typeof tx) => unknown) => callback(tx));
    const { service, managedEntitiesService } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-replace-revoked',
          actorUserId: 'user-1',
          version: 2,
          lifecycle: PublicationLifecycle.DRAFT,
          audienceSelection: 'SELECTED',
          audienceMode: 'SNAPSHOT',
          canonicalContentRevisionId: 'content-2',
          canonicalContentRevision: { id: 'content-2' },
          schedule: null,
          targets: [{ targetChatId: 'chat-revoked', entityType: ChatEntityType.CHAT, position: 0 }],
        }),
      },
      $transaction: transaction,
    });
    const listChats = jest.fn().mockResolvedValue([
      {
        id: 'chat-revoked',
        entityType: 'chat',
        title: 'Старый чат',
        avatarUrl: null,
        link: null,
      },
    ]);
    const listChannels = jest.fn().mockResolvedValue([
      {
        id: 'channel-1',
        entityType: 'channel',
        title: 'Канал 1',
        avatarUrl: null,
        link: null,
      },
    ]);
    const assertChatAdminAccess = jest
      .fn()
      .mockRejectedValue(new ForbiddenException('Пользователь не является администратором чата.'));
    const assertChannelAdminAccess = jest.fn().mockResolvedValue(undefined);
    managedEntitiesService.listChats.mockImplementation(listChats);
    managedEntitiesService.listChannels.mockImplementation(listChannels);
    managedEntitiesService.assertChatAdminAccess.mockImplementation(assertChatAdminAccess);
    managedEntitiesService.assertChannelAdminAccess.mockImplementation(assertChannelAdminAccess);

    await expect(
      service.update(
        'publication-replace-revoked',
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'update-remove-revoked-001',
          expectedRevision: 2,
          audience: {
            selection: 'SELECTED',
            mode: 'SNAPSHOT',
            targets: [{ chatId: 'channel-1', entityType: 'channel' }],
          },
          intent: 'draft',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(listChats).toHaveBeenCalledTimes(1);
    expect(listChannels).toHaveBeenCalledTimes(1);
    expect(assertChatAdminAccess).toHaveBeenCalledWith(
      'chat-revoked',
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(assertChannelAdminAccess).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(tx.publicationTarget.deleteMany).not.toHaveBeenCalled();
    expect(tx.publicationTarget.createMany).not.toHaveBeenCalled();
  });

  it('fails closed before content preparation and persistence on a transient live access error', async () => {
    const transaction = jest.fn();
    const { service, contentService, managedEntitiesService, publisherPolicyService } =
      createService({
        publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
        $transaction: transaction,
      });
    publisherPolicyService.resolvePublicationTargets.mockRejectedValue(
      new ServiceUnavailableException('Не удалось проверить права администратора в MAX.'),
    );
    const prepareContent = jest.spyOn(contentService, 'prepareContentRevision');

    await expect(
      service.create(
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'create-access-transient-001',
          title: 'Черновик',
          content: { text: 'Текст', textFormat: 'plain', buttons: [], media: [] },
          audience: {
            selection: 'SELECTED',
            mode: 'SNAPSHOT',
            targets: [{ chatId: 'chat-1', entityType: 'chat' }],
          },
          schedule: null,
          intent: 'draft',
        },
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(publisherPolicyService.resolvePublicationTargets).toHaveBeenCalledTimes(1);
    expect(managedEntitiesService.assertChatAdminAccess).not.toHaveBeenCalled();
    expect(prepareContent).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('keeps a finite recurrence revision and occurrence count on a semantic no-op edit', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T09:00:00.000Z'));
    try {
      const tx = createPublicationUpdateTransaction();
      const persistedRule = {
        mode: 'recurrence',
        timezone: 'Europe/Moscow',
        frequency: 'weekly',
        interval: 1,
        weekdays: [1, 5],
        times: ['10:00', '18:00'],
        startsAt: '2026-07-10T09:00:00.000Z',
        endsAt: null,
        maxOccurrences: 3,
        replaceConflicts: false,
      };
      const { service, contentService } = createService({
        publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
        publication: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'publication-recurrence',
            actorUserId: 'user-1',
            version: 6,
            lifecycle: PublicationLifecycle.ACTIVE,
            title: 'Повтор',
            audienceSelection: 'SELECTED',
            audienceMode: 'SNAPSHOT',
            canonicalContentRevisionId: 'content-6',
            canonicalContentRevision: { id: 'content-6' },
            targets: [
              { targetChatId: 'chat-1', entityType: ChatEntityType.CHAT, position: 0 },
              {
                targetChatId: 'channel-1',
                entityType: ChatEntityType.CHANNEL,
                position: 1,
              },
            ],
            schedule: {
              id: 'schedule-recurrence',
              revision: 7,
              rule: persistedRule,
            },
          }),
        },
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      });
      jest
        .spyOn(contentService, 'persistPreparedContentRevision')
        .mockResolvedValue({ id: 'content-7' } as never);
      jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-recurrence' } as never);

      await service.update(
        'publication-recurrence',
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'update-recurrence-001',
          expectedRevision: 6,
          title: 'Повтор с новым текстом',
          content: {
            text: 'Обновлённый текст',
            textFormat: 'plain',
            buttons: [],
            media: [],
          },
          audience: {
            selection: 'SELECTED',
            mode: 'SNAPSHOT',
            targets: [
              { chatId: 'channel-1', entityType: 'channel' },
              { chatId: 'chat-1', entityType: 'chat' },
            ],
          },
          schedule: {
            ...persistedRule,
            weekdays: [5, 1],
            times: ['18:00', '10:00'],
            startsAt: '2026-07-10T12:00:00.000+03:00',
          },
          intent: 'publish',
        },
      );

      expect(tx.publicationTarget.deleteMany).not.toHaveBeenCalled();
      expect(tx.publicationSchedule.update).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.findMany).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.createMany).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith({
        where: {
          publicationId: 'publication-recurrence',
          scheduleId: 'schedule-recurrence',
          scheduleRevision: 7,
          status: PublicationOccurrenceStatus.SCHEDULED,
        },
        data: { contentRevisionId: 'content-7' },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the schedule and execution linkage when an active publication becomes a draft', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T09:00:00.000Z'));
    try {
      const tx = {
        ...createPublicationUpdateTransaction(),
        managedBroadcastCalendarReservation: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        managedBroadcastDelivery: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
      tx.publicationOccurrence.findMany.mockResolvedValue([{ id: 'occurrence-future' }]);
      tx.managedBroadcast.findMany.mockResolvedValue([{ id: 'broadcast-future' }]);
      tx.managedBroadcast.updateMany.mockResolvedValue({ count: 1 });
      const deleteBroadcasts = jest.fn();
      Object.assign(tx.managedBroadcast, { deleteMany: deleteBroadcasts });
      const { service } = createService({
        publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
        publication: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'publication-active',
            actorUserId: 'user-1',
            version: 4,
            lifecycle: PublicationLifecycle.ACTIVE,
            title: 'Запланированный пост',
            audienceSelection: 'SELECTED',
            audienceMode: 'SNAPSHOT',
            canonicalContentRevisionId: 'content-4',
            canonicalContentRevision: { id: 'content-4' },
            targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT, position: 0 }],
            schedule: {
              id: 'schedule-active',
              revision: 3,
              status: PublicationScheduleStatus.ACTIVE,
              rule: {
                mode: 'once',
                timezone: 'Europe/Moscow',
                at: '2026-07-12T12:00:00.000+03:00',
                replaceConflicts: false,
              },
            },
          }),
        },
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      });
      jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-active' } as never);

      await service.update(
        'publication-active',
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'update-draft-001',
          expectedRevision: 4,
          schedule: null,
          intent: 'draft',
        },
      );

      expect(tx.publication.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lifecycle: PublicationLifecycle.DRAFT }),
        }),
      );
      expect(tx.publicationSchedule.update).toHaveBeenCalledWith({
        where: { publicationId: 'publication-active' },
        data: {
          revision: { increment: 1 },
          status: PublicationScheduleStatus.DRAFT,
          nextMaterializeAt: null,
          lastError: null,
        },
      });
      expect(tx.publicationSchedule.deleteMany).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['occurrence-future'] },
          deliveries: {
            none: {
              OR: [
                { attemptCount: { gt: 0 } },
                { lockedAt: { not: null } },
                {
                  status: {
                    in: [
                      ManagedBroadcastDeliveryStatus.SENDING,
                      ManagedBroadcastDeliveryStatus.SENT,
                      ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                    ],
                  },
                },
              ],
            },
          },
        },
        data: { status: PublicationOccurrenceStatus.CANCELED },
      });
      expect(tx.managedBroadcast.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['broadcast-future'] },
          status: {
            in: [
              ManagedBroadcastStatus.ACTIVE,
              ManagedBroadcastStatus.PARTIAL,
              ManagedBroadcastStatus.FAILED,
            ],
          },
          lockedAt: null,
          lockToken: null,
          deliveries: {
            none: {
              OR: [
                { attemptCount: { gt: 0 } },
                { lockedAt: { not: null } },
                {
                  status: {
                    in: [
                      ManagedBroadcastDeliveryStatus.SENDING,
                      ManagedBroadcastDeliveryStatus.SENT,
                      ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                    ],
                  },
                },
              ],
            },
          },
        },
        data: {
          status: ManagedBroadcastStatus.CANCELED,
          nextSendAt: null,
          lockedAt: null,
          lockToken: null,
        },
      });
      expect(tx.managedBroadcast.findMany).toHaveBeenCalledWith({
        where: {
          publicationOccurrenceId: { in: ['occurrence-future'] },
          status: {
            in: [
              ManagedBroadcastStatus.ACTIVE,
              ManagedBroadcastStatus.PARTIAL,
              ManagedBroadcastStatus.FAILED,
            ],
          },
        },
        select: { id: true, lockedAt: true, lockToken: true },
      });
      expect(tx.managedBroadcast.updateMany.mock.calls[0]?.[0].data).not.toHaveProperty(
        'publicationOccurrenceId',
      );
      expect(deleteBroadcasts).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a schedule update while a future publication envelope is preclaimed', async () => {
    const tx = createPublicationUpdateTransaction();
    tx.publicationOccurrence.findMany.mockResolvedValue([{ id: 'occurrence-future' }]);
    tx.managedBroadcast.findMany.mockResolvedValue([
      {
        id: 'broadcast-future',
        lockedAt: new Date('2026-07-10T09:00:00.000Z'),
        lockToken: 'update-execution-lease',
      },
    ]);
    const { service } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-update-lease',
          actorUserId: 'user-1',
          version: 4,
          lifecycle: PublicationLifecycle.ACTIVE,
          title: 'Запланированный пост',
          audienceSelection: 'SELECTED',
          audienceMode: 'SNAPSHOT',
          canonicalContentRevisionId: 'content-4',
          canonicalContentRevision: { id: 'content-4' },
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT, position: 0 }],
          schedule: {
            id: 'schedule-active',
            revision: 3,
            status: PublicationScheduleStatus.ACTIVE,
            rule: {
              mode: 'once',
              timezone: 'Europe/Moscow',
              at: '2026-07-12T12:00:00.000+03:00',
              replaceConflicts: false,
            },
          },
        }),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });

    await expect(
      service.update(
        'publication-update-lease',
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'update-lease-001',
          expectedRevision: 4,
          schedule: null,
          intent: 'draft',
        },
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW',
        message: 'Публикация уже начала отправку. Проверьте доставки отдельно.',
      },
    });

    expect(tx.managedBroadcast.updateMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcastDelivery.updateMany).not.toHaveBeenCalled();
    expect(tx.publicationOccurrence.updateMany).not.toHaveBeenCalled();
  });

  it.each(['pause', 'cancel'] as const)(
    'rejects %s while a future publication envelope is preclaimed',
    async (action) => {
      const updateBroadcasts = jest.fn();
      const deleteBroadcasts = jest.fn();
      const updateSchedule = jest.fn();
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        publication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        publicationOccurrence: {
          findMany: jest.fn().mockResolvedValue([{ id: 'occurrence-future' }]),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        managedBroadcast: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'broadcast-future',
              lockedAt: new Date('2026-07-10T09:00:00.000Z'),
              lockToken: `${action}-execution-lease`,
            },
          ]),
          updateMany: updateBroadcasts,
          deleteMany: deleteBroadcasts,
        },
        publicationSchedule: { updateMany: updateSchedule },
        publicationMutationRecord: { create: jest.fn() },
      };
      const { service } = createService({
        publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
        publication: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'publication-action-lease',
            actorUserId: 'user-1',
            version: 3,
            lifecycle: PublicationLifecycle.ACTIVE,
            targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
          }),
        },
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      });

      await expect(
        service[action](
          'publication-action-lease',
          { userId: 'user-1', username: null, displayName: null },
          { requestId: `${action}-lease-001`, expectedRevision: 3 },
        ),
      ).rejects.toMatchObject({
        response: {
          code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW',
          message: 'Публикация уже начала отправку. Проверьте доставки отдельно.',
        },
      });

      expect(updateBroadcasts).not.toHaveBeenCalled();
      expect(deleteBroadcasts).not.toHaveBeenCalled();
      expect(updateSchedule).not.toHaveBeenCalled();
      expect(tx.publicationMutationRecord.create).not.toHaveBeenCalled();
    },
  );

  it('creates separate chat and channel execution envelopes linked to one occurrence', async () => {
    const managedBroadcastCreate = jest
      .fn()
      .mockResolvedValueOnce({ id: 'broadcast-chat' })
      .mockResolvedValueOnce({ id: 'broadcast-channel' });
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcast: {
        count: jest.fn().mockResolvedValue(0),
        create: managedBroadcastCreate,
        updateMany: jest.fn(),
      },
      managedBroadcastOccurrence: { create: jest.fn().mockResolvedValue({}) },
      managedBroadcastDelivery: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        updateMany: jest.fn(),
      },
      managedBroadcastCalendarReservation: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn(),
      },
      publicationOccurrence: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const { service } = createService({
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });
    const occurrence = {
      id: 'occurrence-1',
      publicationId: 'publication-1',
      scheduleId: 'schedule-1',
      contentRevisionId: 'content-1',
      scheduledAt: new Date('2026-07-10T10:00:00.000Z'),
      legacyBroadcastId: null,
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: 'publisher-bot',
      schedule: { timezone: 'Europe/Moscow' },
      contentRevision: {
        text: 'Проверка',
        textFormat: PublicationContentFormat.PLAIN,
        buttons: [{ text: 'Открыть', url: 'https://max.ru/example', row: 0 }],
      },
      publication: { actorUserId: 'user-1' },
    };

    await (service as any).createOccurrenceExecution(
      occurrence,
      [
        {
          chatId: 'chat-1',
          entityType: 'chat',
          title: 'Чат',
          avatarUrl: null,
          link: null,
        },
        {
          chatId: 'channel-1',
          entityType: 'channel',
          title: 'Канал',
          avatarUrl: null,
          link: null,
        },
      ],
      { mode: 'now', timezone: 'Europe/Moscow' },
    );

    expect(managedBroadcastCreate).toHaveBeenCalledTimes(2);
    expect(managedBroadcastCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          entityType: ChatEntityType.CHAT,
          publicationOccurrenceId: 'occurrence-1',
          publicationContentRevisionId: 'content-1',
          targetChatIds: ['chat-1'],
        }),
      }),
    );
    expect(managedBroadcastCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          entityType: ChatEntityType.CHANNEL,
          publicationOccurrenceId: 'occurrence-1',
          targetChatIds: ['channel-1'],
        }),
      }),
    );
    expect(tx.managedBroadcastDelivery.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          publicationOccurrenceId: 'occurrence-1',
          occurrenceIndex: 1,
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          requiredBotId: 'publisher-bot',
          dialogBotId: 'primary-bot',
          publicationPolicyRevision: 1,
        }),
      ],
    });
  });

  it('keeps an unready Publik occurrence scheduled with a bounded blocker', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const transaction = jest.fn();
    const occurrence = {
      id: 'occurrence-blocked',
      publicationId: 'publication-blocked',
      scheduleId: 'schedule-blocked',
      scheduleRevision: 1,
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: 'publisher-bot',
      schedule: {
        id: 'schedule-blocked',
        revision: 1,
        rule: { mode: 'now', timezone: 'Europe/Moscow' },
      },
      contentRevision: {},
      publication: { targets: [] },
    };
    const { publisherRouting, service } = createService({
      publicationOccurrence: {
        findMany: jest.fn().mockResolvedValue([occurrence]),
        updateMany,
      },
      $transaction: transaction,
    });
    publisherRouting.deferOccurrenceIfBlocked.mockResolvedValue(true);
    jest.spyOn(service as any, 'resolveOccurrenceTargets').mockResolvedValue([
      {
        chatId: 'chat-1',
        entityType: 'chat',
        title: 'Чат',
        avatarUrl: null,
        link: null,
      },
    ]);
    jest
      .spyOn(service as any, 'createOccurrenceExecution')
      .mockRejectedValue(new PublisherSetupRequiredException(['chat-1'], 'policy_disabled'));

    await (service as any).dispatchScheduledOccurrences(1, [PublicationScheduleMode.NOW]);

    expect(publisherRouting.deferOccurrenceIfBlocked).toHaveBeenCalledWith(
      occurrence,
      expect.objectContaining({ blockerCode: 'policy_disabled' }),
    );
    expect(updateMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rolls an ambiguous delivery up without making it retryable', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const observedAt = new Date('2026-07-10T10:01:00.000Z');
    const { presenter, service } = createService({
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occurrence-1',
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          updatedAt: observedAt,
          scheduleRevision: 4,
          contentRevisionId: 'content-1',
          scheduledAt: new Date('2026-07-10T10:00:00.000Z'),
          legacyBroadcasts: [
            {
              status: ManagedBroadcastStatus.FAILED,
              deliveries: [{ status: ManagedBroadcastDeliveryStatus.AMBIGUOUS }],
            },
          ],
        }),
        updateMany,
      },
    });

    await (service as any).rollupOccurrence('occurrence-1');

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'occurrence-1',
        status: PublicationOccurrenceStatus.IN_PROGRESS,
        updatedAt: observedAt,
        scheduleRevision: 4,
        contentRevisionId: 'content-1',
      },
      data: { status: PublicationOccurrenceStatus.AMBIGUOUS },
    });
    expect(
      presenter.buildDeliveryStats([{ status: ManagedBroadcastDeliveryStatus.AMBIGUOUS }]),
    ).toEqual({
      total: 1,
      pending: 0,
      sent: 0,
      failed: 0,
      ambiguous: 1,
      canceled: 0,
    });
  });

  it('rolls a terminal canceled envelope with only sent deliveries up as sent', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const observedAt = new Date('2026-07-10T10:01:00.000Z');
    const { service } = createService({
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occurrence-canceled-envelope',
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          updatedAt: observedAt,
          scheduleRevision: 4,
          contentRevisionId: 'content-1',
          scheduledAt: new Date('2026-07-10T10:00:00.000Z'),
          legacyBroadcasts: [
            {
              status: ManagedBroadcastStatus.CANCELED,
              deliveries: [
                {
                  status: ManagedBroadcastDeliveryStatus.SENT,
                  targetChatId: 'chat-1',
                  lastErrorCode: null,
                  lastError: null,
                },
              ],
            },
          ],
        }),
        updateMany,
      },
    });

    await (service as any).rollupOccurrence('occurrence-canceled-envelope');

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'occurrence-canceled-envelope',
        status: PublicationOccurrenceStatus.IN_PROGRESS,
        updatedAt: observedAt,
        scheduleRevision: 4,
        contentRevisionId: 'content-1',
      },
      data: { status: PublicationOccurrenceStatus.SENT },
    });
  });

  it('rolls a stale active envelope with untouched sent deliveries up as sent', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const observedAt = new Date('2026-07-10T10:01:00.000Z');
    const { service } = createService({
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occurrence-active-pristine',
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          updatedAt: observedAt,
          scheduleRevision: 4,
          contentRevisionId: 'content-1',
          scheduledAt: new Date('2026-07-10T10:00:00.000Z'),
          legacyBroadcasts: [
            {
              status: ManagedBroadcastStatus.ACTIVE,
              deliveries: [
                {
                  status: ManagedBroadcastDeliveryStatus.SENT,
                  targetChatId: 'chat-1',
                  lastErrorCode: null,
                  lastError: null,
                  remoteMessageId: 'legacy-message',
                  remoteMessageVerifiedAt: null,
                  remoteMessageVerificationAttemptCount: 0,
                  remoteMessageVerificationAbsentCount: 0,
                  remoteMessageVerificationPresentCount: 0,
                  remoteMessageVerificationAttemptedAt: null,
                  remoteMessageVerificationNextAt: null,
                  remoteMessageVerificationSource: null,
                },
              ],
            },
          ],
        }),
        updateMany,
      },
    });

    await (service as any).rollupOccurrence('occurrence-active-pristine');

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'occurrence-active-pristine',
        status: PublicationOccurrenceStatus.IN_PROGRESS,
        updatedAt: observedAt,
        scheduleRevision: 4,
        contentRevisionId: 'content-1',
      },
      data: { status: PublicationOccurrenceStatus.SENT },
    });
  });

  it('keeps armed verification in progress while its envelope can still execute', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { service } = createService({
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occurrence-active-verification',
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          updatedAt: new Date('2026-07-10T10:01:00.000Z'),
          scheduleRevision: 4,
          contentRevisionId: 'content-1',
          scheduledAt: new Date('2026-07-10T10:00:00.000Z'),
          legacyBroadcasts: [
            {
              status: ManagedBroadcastStatus.ACTIVE,
              deliveries: [
                {
                  status: ManagedBroadcastDeliveryStatus.SENT,
                  targetChatId: 'chat-1',
                  lastErrorCode: null,
                  lastError: null,
                  remoteMessageId: 'new-message',
                  remoteMessageVerifiedAt: null,
                  remoteMessageVerificationAttemptCount: 0,
                  remoteMessageVerificationAbsentCount: 0,
                  remoteMessageVerificationPresentCount: 0,
                  remoteMessageVerificationAttemptedAt: null,
                  remoteMessageVerificationNextAt: new Date('2026-07-10T10:01:15.000Z'),
                  remoteMessageVerificationSource: null,
                },
              ],
            },
          ],
        }),
        updateMany,
      },
    });

    await (service as any).rollupOccurrence('occurrence-active-verification');

    expect(updateMany).not.toHaveBeenCalled();
  });

  it('marks stopped envelopes with armed verification as ambiguous for manual review', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const observedAt = new Date('2026-07-10T10:01:00.000Z');
    const { service } = createService({
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occurrence-stopped-verification',
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          updatedAt: observedAt,
          scheduleRevision: 4,
          contentRevisionId: 'content-1',
          scheduledAt: new Date('2026-07-10T10:00:00.000Z'),
          legacyBroadcasts: [
            {
              status: ManagedBroadcastStatus.CANCELED,
              deliveries: [
                {
                  status: ManagedBroadcastDeliveryStatus.SENT,
                  targetChatId: 'chat-1',
                  lastErrorCode: null,
                  lastError: null,
                  remoteMessageId: 'new-message',
                  remoteMessageVerifiedAt: null,
                  remoteMessageVerificationAttemptCount: 0,
                  remoteMessageVerificationAbsentCount: 0,
                  remoteMessageVerificationPresentCount: 0,
                  remoteMessageVerificationAttemptedAt: null,
                  remoteMessageVerificationNextAt: new Date('2026-07-10T10:01:15.000Z'),
                  remoteMessageVerificationSource: null,
                },
              ],
            },
          ],
        }),
        updateMany,
      },
    });

    await (service as any).rollupOccurrence('occurrence-stopped-verification');

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'occurrence-stopped-verification',
        status: PublicationOccurrenceStatus.IN_PROGRESS,
        updatedAt: observedAt,
        scheduleRevision: 4,
        contentRevisionId: 'content-1',
      },
      data: { status: PublicationOccurrenceStatus.AMBIGUOUS },
    });
  });

  it('keeps an occurrence in progress while an active envelope has ambiguous and pending targets', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { service } = createService({
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occurrence-1',
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          updatedAt: new Date('2026-07-10T10:01:00.000Z'),
          scheduleRevision: 4,
          contentRevisionId: 'content-1',
          scheduledAt: new Date('2026-07-10T10:00:00.000Z'),
          legacyBroadcasts: [
            {
              status: ManagedBroadcastStatus.ACTIVE,
              deliveries: [
                { status: ManagedBroadcastDeliveryStatus.AMBIGUOUS },
                { status: ManagedBroadcastDeliveryStatus.PENDING },
              ],
            },
          ],
        }),
        updateMany,
      },
    });

    await (service as any).rollupOccurrence('occurrence-1');

    expect(updateMany).not.toHaveBeenCalled();
  });

  it('does not overwrite a retried occurrence from a stale rollup snapshot', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const observedAt = new Date('2026-07-10T10:01:00.000Z');
    const { service } = createService({
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occurrence-1',
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          updatedAt: observedAt,
          scheduleRevision: 4,
          contentRevisionId: 'content-1',
          scheduledAt: new Date('2026-07-10T10:00:00.000Z'),
          legacyBroadcasts: [
            {
              status: ManagedBroadcastStatus.FAILED,
              deliveries: [{ status: ManagedBroadcastDeliveryStatus.FAILED }],
            },
          ],
        }),
        updateMany,
      },
    });

    await (service as any).rollupOccurrence('occurrence-1');

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'occurrence-1',
        status: PublicationOccurrenceStatus.IN_PROGRESS,
        updatedAt: observedAt,
        scheduleRevision: 4,
        contentRevisionId: 'content-1',
      },
      data: { status: PublicationOccurrenceStatus.FAILED },
    });
  });

  it('pauses future slots after a pre-dispatch no-route failure', async () => {
    const observedAt = new Date('2026-07-27T15:00:00.000Z');
    const occurrenceUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const publicationUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const scheduleUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      publicationOccurrence: {
        count: jest.fn().mockResolvedValue(2),
        updateMany: occurrenceUpdateMany,
      },
      publicationSchedule: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'schedule-1',
          revision: 4,
          status: PublicationScheduleStatus.ACTIVE,
          nextMaterializeAt: null,
        }),
        updateMany: scheduleUpdateMany,
      },
      publicationTarget: { count: jest.fn().mockResolvedValue(1) },
      publication: { updateMany: publicationUpdateMany },
      managedBroadcast: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const { service } = createService({
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occurrence-no-route',
          publicationId: 'publication-1',
          scheduleId: 'schedule-1',
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          updatedAt: observedAt,
          scheduleRevision: 4,
          contentRevisionId: 'content-1',
          scheduledAt: new Date('2026-07-27T14:59:00.000Z'),
          legacyBroadcasts: [
            {
              status: ManagedBroadcastStatus.FAILED,
              deliveries: [
                {
                  status: ManagedBroadcastDeliveryStatus.FAILED,
                  targetChatId: 'chat-no-route',
                  lastError: buildMaxActionNoExecutableRouteMessage(
                    'SEND_MESSAGE',
                    'chat-no-route',
                  ),
                },
              ],
            },
          ],
        }),
        updateMany: jest.fn(),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });

    await (service as any).rollupOccurrence('occurrence-no-route');

    expect(occurrenceUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: PublicationOccurrenceStatus.FAILED } }),
    );
    expect(publicationUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'publication-1',
        lifecycle: PublicationLifecycle.ACTIVE,
        targets: { some: { targetChatId: 'chat-no-route' } },
      },
      data: { lifecycle: PublicationLifecycle.PAUSED },
    });
    expect(scheduleUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          publicationId: 'publication-1',
          id: 'schedule-1',
          revision: 4,
          status: PublicationScheduleStatus.ACTIVE,
        },
        data: expect.objectContaining({
          status: PublicationScheduleStatus.PAUSED,
          nextMaterializeAt: null,
          lastError: expect.stringContaining('права администратора'),
        }),
      }),
    );
  });

  it('does not pause healthy targets after one target loses its route', async () => {
    const observedAt = new Date('2026-07-27T15:00:00.000Z');
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const transaction = jest.fn();
    const { service } = createService({
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occurrence-partial-route',
          publicationId: 'publication-1',
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          updatedAt: observedAt,
          scheduleRevision: 4,
          contentRevisionId: 'content-1',
          scheduledAt: new Date('2026-07-27T14:59:00.000Z'),
          legacyBroadcasts: [
            {
              status: ManagedBroadcastStatus.PARTIAL,
              deliveries: [
                {
                  status: ManagedBroadcastDeliveryStatus.FAILED,
                  targetChatId: 'chat-no-route',
                  lastError: buildMaxActionNoExecutableRouteMessage(
                    'SEND_MESSAGE',
                    'chat-no-route',
                  ),
                },
                {
                  status: ManagedBroadcastDeliveryStatus.SENT,
                  targetChatId: 'chat-healthy',
                  lastError: null,
                },
              ],
            },
          ],
        }),
        updateMany,
      },
      $transaction: transaction,
    });

    await (service as any).rollupOccurrence('occurrence-partial-route');

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'occurrence-partial-route',
        status: PublicationOccurrenceStatus.IN_PROGRESS,
        updatedAt: observedAt,
        scheduleRevision: 4,
        contentRevisionId: 'content-1',
      },
      data: { status: PublicationOccurrenceStatus.PARTIAL },
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rolls up only non-terminal occurrences so completed rows cannot starve the batch', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const { service } = createService({ publicationOccurrence: { findMany } });

    await (service as any).rollupActiveOccurrences();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: {
            in: [PublicationOccurrenceStatus.SCHEDULED, PublicationOccurrenceStatus.IN_PROGRESS],
          },
          legacyBroadcasts: { some: { deliveries: { some: {} } } },
        },
      }),
    );
  });

  it('persists a non-empty MIME type for contract-valid video input', async () => {
    const assetUpsert = jest.fn().mockResolvedValue({ id: 'asset-1' });
    const tx = {
      publicationContentRevision: {
        create: jest.fn().mockResolvedValue({ id: 'content-1' }),
      },
      publicationAsset: { upsert: assetUpsert },
      publicationContentAsset: { create: jest.fn().mockResolvedValue({}) },
    };
    const { contentService } = createService();

    const prepared = await contentService.prepareContentRevision({
      text: '',
      textFormat: 'plain',
      buttons: [],
      media: [
        {
          type: 'video',
          payload: { token: 'video-1' },
          base64: '',
          mimeType: '',
          fileName: '',
        },
      ],
    });
    await contentService.persistPreparedContentRevision(tx, 'publication-1', 2, prepared, 'user-1');

    expect(assetUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ mimeType: 'application/octet-stream' }),
      }),
    );
    expect(tx.publicationContentRevision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revision: 2 }),
      }),
    );
  });

  it('stores an uploaded video as bounded bytes and builds a trusted test upload marker', async () => {
    const videoBytes = TINY_VALID_MP4;
    const assetUpsert = jest.fn().mockResolvedValue({ id: 'asset-video' });
    const tx = {
      publicationContentRevision: {
        create: jest.fn().mockResolvedValue({ id: 'content-video' }),
      },
      publicationAsset: { upsert: assetUpsert },
      publicationContentAsset: { create: jest.fn().mockResolvedValue({}) },
    };
    const { contentService } = createService();
    const content = {
      text: '',
      textFormat: 'plain' as const,
      buttons: [],
      media: [
        {
          type: 'video' as const,
          payload: null,
          base64: videoBytes.toString('base64'),
          mimeType: 'video/mp4',
          fileName: 'clip.mp4',
        },
      ],
    };

    const prepared = await contentService.prepareContentRevision(content);
    await contentService.persistPreparedContentRevision(tx, 'publication-1', 3, prepared, 'user-1');

    expect(assetUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          mimeType: 'video/mp4',
          sizeBytes: videoBytes.length,
          bytes: videoBytes,
          durablePayload: Prisma.DbNull,
        }),
      }),
    );
    await expect(
      contentService.buildLegacyTestPayload(
        {
          requestId: 'request-video-1',
          content,
          sourceTarget: { chatId: 'chat-1', entityType: 'chat' },
        },
        'user-1',
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        mediaType: 'video',
        mediaPayload: {
          [PUBLICATION_VIDEO_INLINE_BASE64_FIELD]: videoBytes.toString('base64'),
        },
        mediaMimeType: 'video/mp4',
        mediaFileName: 'clip.mp4',
      }),
    );
  });

  it('rejects raw video above the public 24 MB byte limit', async () => {
    const { contentService } = createService();
    const oversized = Buffer.alloc(PUBLICATION_MAX_VIDEO_BYTES + 1).toString('base64');

    await expect(
      contentService.buildLegacyTestPayload(
        {
          requestId: 'request-video-too-large',
          content: {
            text: '',
            textFormat: 'plain',
            buttons: [],
            media: [
              {
                type: 'video',
                payload: null,
                base64: oversized,
                mimeType: 'video/mp4',
                fileName: 'large.mp4',
              },
            ],
          },
          sourceTarget: { chatId: 'chat-1', entityType: 'chat' },
        },
        'user-1',
      ),
    ).rejects.toThrow('Видео слишком большое. Максимум 24 МБ.');
  });

  it('turns only an actor-owned byte-backed video reference into an internal asset marker', async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce({
        id: 'asset-video-owned',
        bytes: Buffer.from('saved-video'),
        durablePayload: null,
        mimeType: 'video/mp4',
        fileName: 'saved.mp4',
      })
      .mockResolvedValueOnce(null);
    const { contentService } = createService({ publicationAsset: { findFirst } });
    const request = {
      requestId: 'request-video-ref',
      content: {
        text: '',
        textFormat: 'plain' as const,
        buttons: [],
        media: [{ type: 'video-ref' as const, assetId: 'asset-video-owned' }],
      },
      sourceTarget: { chatId: 'chat-1', entityType: 'chat' as const },
    };

    await expect(contentService.buildLegacyTestPayload(request, 'user-1')).resolves.toEqual(
      expect.objectContaining({
        mediaType: 'video',
        mediaPayload: { [PUBLICATION_VIDEO_ASSET_ID_FIELD]: 'asset-video-owned' },
      }),
    );
    await expect(contentService.buildLegacyTestPayload(request, 'user-2')).rejects.toThrow(
      'Медиа публикации больше недоступно.',
    );
    expect(findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'asset-video-owned',
          contentLinks: {
            some: { contentRevision: { publication: { actorUserId: 'user-2' } } },
          },
        }),
      }),
    );
  });

  it('rejects internal video markers supplied through a public video payload', async () => {
    const { contentService } = createService();

    await expect(
      contentService.buildLegacyTestPayload(
        {
          requestId: 'request-forged-video-marker',
          content: {
            text: '',
            textFormat: 'plain',
            buttons: [],
            media: [
              {
                type: 'video',
                payload: { [PUBLICATION_VIDEO_ASSET_ID_FIELD]: 'asset-from-another-user' },
                base64: '',
                mimeType: 'video/mp4',
                fileName: 'forged.mp4',
              },
            ],
          },
          sourceTarget: { chatId: 'chat-1', entityType: 'chat' },
        },
        'user-1',
      ),
    ).rejects.toThrow('Сохранённое видео больше недоступно.');
  });

  it('aggregates grouped delivery counts without expanding them into rows', async () => {
    const { presenter } = createService({
      managedBroadcastDelivery: {
        groupBy: jest.fn().mockResolvedValue([
          {
            status: ManagedBroadcastDeliveryStatus.SENT,
            _count: { _all: 1_000_000 },
          },
          {
            status: ManagedBroadcastDeliveryStatus.SENDING,
            _count: { _all: 7 },
          },
        ]),
      },
    });

    await expect(presenter.loadDeliveryStats('publication-1')).resolves.toEqual({
      total: 1_000_007,
      pending: 7,
      sent: 1_000_000,
      failed: 0,
      ambiguous: 0,
      canceled: 0,
    });
  });

  it('maps the earliest scheduled occurrence as the next publication time', async () => {
    const { presenter } = createService({
      managedBroadcastDelivery: { groupBy: jest.fn().mockResolvedValue([]) },
    });

    const summary = await presenter.mapPublicationSummary({
      id: 'publication-1',
      title: 'Публикация',
      lifecycle: PublicationLifecycle.ACTIVE,
      version: 1,
      canonicalContentRevision: { text: 'Текст', assets: [] },
      targets: [],
      audienceSelection: 'SELECTED',
      audienceMode: 'SNAPSHOT',
      schedule: {
        rule: {
          mode: 'once',
          timezone: 'Europe/Moscow',
          at: '2026-07-11T12:00:00.000+03:00',
          replaceConflicts: false,
        },
        status: PublicationScheduleStatus.ACTIVE,
        revision: 1,
        lastError: null,
      },
      occurrences: [
        {
          status: PublicationOccurrenceStatus.SENT,
          scheduledAt: new Date('2026-07-12T09:00:00.000Z'),
        },
        {
          status: PublicationOccurrenceStatus.SCHEDULED,
          scheduledAt: new Date('2026-07-11T09:00:00.000Z'),
        },
        {
          status: PublicationOccurrenceStatus.SCHEDULED,
          scheduledAt: new Date('2026-07-10T09:00:00.000Z'),
        },
      ],
      createdAt: new Date('2026-07-10T08:00:00.000Z'),
      updatedAt: new Date('2026-07-10T08:00:00.000Z'),
    });

    expect(summary.schedule?.nextOccurrenceAt).toBe('2026-07-10T09:00:00.000Z');
  });

  it('loads the nearest scheduled occurrence independently from limited history', async () => {
    const detailsRow = { id: 'publication-1', occurrences: [] };
    const publicationFindFirst = jest.fn().mockResolvedValue(detailsRow);
    const occurrenceFindFirst = jest.fn().mockResolvedValue({
      scheduledAt: new Date('2026-07-10T09:00:00.000Z'),
    });
    const occurrenceFindMany = jest.fn().mockResolvedValue([]);
    const { presenter } = createService({
      publication: { findFirst: publicationFindFirst },
      publicationOccurrence: {
        findFirst: occurrenceFindFirst,
        findMany: occurrenceFindMany,
      },
    });

    await expect(presenter.loadPublicationDetailsRow('publication-1', 'user-1')).resolves.toEqual({
      ...detailsRow,
      nextOccurrenceAt: new Date('2026-07-10T09:00:00.000Z'),
      deliveryStats: {
        total: 0,
        pending: 0,
        sent: 0,
        failed: 0,
        ambiguous: 0,
        canceled: 0,
      },
      actionableDeliveryStats: {
        total: 0,
        pending: 0,
        sent: 0,
        failed: 0,
        ambiguous: 0,
        canceled: 0,
      },
    });
    expect(occurrenceFindFirst).toHaveBeenCalledWith({
      where: {
        publicationId: 'publication-1',
        status: PublicationOccurrenceStatus.SCHEDULED,
      },
      orderBy: { scheduledAt: 'asc' },
      select: { scheduledAt: true },
    });
  });

  it('keeps every unresolved occurrence beyond the recent history limit without duplicates', async () => {
    const recentOccurrences = Array.from({ length: 50 }, (_, index) => ({
      id: `recent-${String(index).padStart(2, '0')}`,
      scheduledAt: new Date(Date.UTC(2026, 6, 31 - index)),
      status: index === 10 ? PublicationOccurrenceStatus.FAILED : PublicationOccurrenceStatus.SENT,
      deliveries: [],
    }));
    const unresolvedInsideRecent = recentOccurrences[10]!;
    const unresolvedOutsideRecent = {
      id: 'unresolved-outside-recent',
      scheduledAt: new Date('2025-12-01T09:00:00.000Z'),
      status: PublicationOccurrenceStatus.AMBIGUOUS,
      deliveries: [{ status: ManagedBroadcastDeliveryStatus.AMBIGUOUS }],
    };
    const sameTimeA = {
      id: 'unresolved-a',
      scheduledAt: new Date('2026-08-01T09:00:00.000Z'),
      status: PublicationOccurrenceStatus.IN_PROGRESS,
      deliveries: [{ status: ManagedBroadcastDeliveryStatus.PENDING }],
    };
    const sameTimeB = { ...sameTimeA, id: 'unresolved-b' };
    const publicationFindFirst = jest.fn().mockResolvedValue({
      id: 'publication-1',
      occurrences: recentOccurrences,
    });
    const occurrenceFindMany = jest
      .fn()
      .mockResolvedValue([sameTimeB, sameTimeA, unresolvedInsideRecent, unresolvedOutsideRecent]);
    const { presenter } = createService({
      publication: { findFirst: publicationFindFirst },
      publicationOccurrence: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: occurrenceFindMany,
      },
    });

    const result = await presenter.loadPublicationDetailsRow('publication-1', 'user-1');

    expect(result?.occurrences).toHaveLength(53);
    expect(result?.occurrences.slice(0, 2).map((occurrence) => occurrence.id)).toEqual([
      'unresolved-b',
      'unresolved-a',
    ]);
    expect(result?.occurrences.at(-1)?.id).toBe('unresolved-outside-recent');
    expect(
      result?.occurrences.filter((occurrence) => occurrence.id === unresolvedInsideRecent.id),
    ).toHaveLength(1);
    expect(publicationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          occurrences: expect.objectContaining({
            orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }],
            take: 50,
          }),
        }),
      }),
    );
    expect(occurrenceFindMany).toHaveBeenCalledWith({
      where: {
        publicationId: 'publication-1',
        status: {
          in: [
            PublicationOccurrenceStatus.SCHEDULED,
            PublicationOccurrenceStatus.IN_PROGRESS,
            PublicationOccurrenceStatus.FAILED,
            PublicationOccurrenceStatus.PARTIAL,
            PublicationOccurrenceStatus.AMBIGUOUS,
          ],
        },
      },
      orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }],
      include: {
        contentRevision: { select: { revision: true } },
        _count: { select: { legacyBroadcasts: true } },
      },
    });
  });

  it('does not create an execution envelope when the occurrence content revision changed', async () => {
    const managedBroadcastCount = jest.fn();
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      publicationOccurrence: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      managedBroadcast: { count: managedBroadcastCount },
    };
    const { service } = createService({
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });

    await (service as any).createOccurrenceExecution(
      {
        id: 'occurrence-stale-content',
        publicationId: 'publication-1',
        scheduleId: 'schedule-1',
        scheduleRevision: 3,
        contentRevisionId: 'content-old',
        scheduledAt: new Date('2026-07-10T10:00:00.000Z'),
        legacyBroadcastId: null,
        schedule: { timezone: 'Europe/Moscow' },
        contentRevision: {
          text: 'Старый текст',
          textFormat: PublicationContentFormat.PLAIN,
          buttons: [],
        },
        publication: { actorUserId: 'user-1' },
      },
      [
        {
          chatId: 'chat-1',
          entityType: 'chat',
          title: 'Чат',
          avatarUrl: null,
          link: null,
        },
      ],
      { mode: 'now', timezone: 'Europe/Moscow' },
    );

    expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'occurrence-stale-content',
          scheduleRevision: 3,
          contentRevisionId: 'content-old',
        }),
      }),
    );
    expect(managedBroadcastCount).not.toHaveBeenCalled();
  });

  it('cancels stale schedule revisions before they can starve the dispatcher batch', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { service } = createService({
      publicationOccurrence: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'occurrence-old-revision',
            scheduleRevision: 2,
            schedule: { revision: 3 },
          },
        ]),
        updateMany,
      },
    });

    await (service as any).dispatchScheduledOccurrences(1);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'occurrence-old-revision',
        scheduleRevision: 2,
        status: PublicationOccurrenceStatus.SCHEDULED,
        deliveries: {
          none: {
            status: {
              in: [
                ManagedBroadcastDeliveryStatus.SENDING,
                ManagedBroadcastDeliveryStatus.AMBIGUOUS,
              ],
            },
          },
        },
      },
      data: { status: PublicationOccurrenceStatus.CANCELED },
    });
  });

  it('fails closed when a background occurrence target is no longer administered', async () => {
    const { service, managedEntitiesService } = createService();
    managedEntitiesService.assertChatAdminAccess.mockRejectedValue(
      new ForbiddenException('Пользователь не является администратором чата.'),
    );

    await expect(
      (service as any).resolveOccurrenceTargets({
        actorUserId: 'user-1',
        audienceMode: 'SNAPSHOT',
        audienceSelection: 'SELECTED',
        targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(managedEntitiesService.assertChatAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ userId: 'user-1' }),
    );
  });

  it('defers background dispatch without terminal mutations on a transient access outage', async () => {
    const scheduleUpdate = jest.fn();
    const occurrenceUpdate = jest.fn();
    const publicationUpdate = jest.fn();
    const transaction = jest.fn();
    const { service, managedEntitiesService } = createService({
      publicationOccurrence: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'occurrence-access-transient',
            publicationId: 'publication-access-transient',
            scheduleId: 'schedule-access-transient',
            scheduleRevision: 3,
            contentRevisionId: 'content-1',
            scheduledAt: new Date('2026-07-10T09:00:00.000Z'),
            schedule: {
              revision: 3,
              rule: { mode: 'now', timezone: 'UTC' },
            },
            publication: {
              actorUserId: 'user-1',
              audienceMode: PublicationAudienceMode.SNAPSHOT,
              audienceSelection: PublicationAudienceSelection.SELECTED,
              targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
            },
          },
        ]),
        updateMany: occurrenceUpdate,
      },
      publicationSchedule: { updateMany: scheduleUpdate },
      publication: { updateMany: publicationUpdate },
      $transaction: transaction,
    });
    managedEntitiesService.assertChatAdminAccess.mockRejectedValue(
      new ServiceUnavailableException('Не удалось проверить права администратора в MAX.'),
    );
    const createExecution = jest.spyOn(service as any, 'createOccurrenceExecution');
    (service as any).logger.warn = jest.fn();

    await (service as any).dispatchScheduledOccurrences(1);

    expect(createExecution).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(scheduleUpdate).not.toHaveBeenCalled();
    expect(occurrenceUpdate).not.toHaveBeenCalled();
    expect(publicationUpdate).not.toHaveBeenCalled();
  });

  it('defers recurrence materialization without terminal mutations on a transient access outage', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T09:00:00.000Z'));
    try {
      const scheduleUpdate = jest.fn();
      const publicationUpdate = jest.fn();
      const occurrenceCreate = jest.fn();
      const transaction = jest.fn();
      const { service, managedEntitiesService } = createService({
        publicationSchedule: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'schedule-access-transient',
              publicationId: 'publication-access-transient',
              revision: 4,
              rule: {
                mode: 'recurrence',
                timezone: 'UTC',
                frequency: 'daily',
                interval: 1,
                weekdays: [],
                times: ['10:00'],
                startsAt: '2026-07-10T09:00:00.000Z',
                endsAt: null,
                maxOccurrences: 1,
                replaceConflicts: false,
              },
              publication: {
                id: 'publication-access-transient',
                actorUserId: 'user-1',
                audienceMode: PublicationAudienceMode.SNAPSHOT,
                audienceSelection: PublicationAudienceSelection.SELECTED,
                canonicalContentRevisionId: 'content-1',
                targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
              },
            },
          ]),
          updateMany: scheduleUpdate,
        },
        publicationOccurrence: {
          findFirst: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(0),
          createMany: occurrenceCreate,
        },
        publication: { updateMany: publicationUpdate },
        $transaction: transaction,
      });
      managedEntitiesService.assertChatAdminAccess.mockRejectedValue(
        new ServiceUnavailableException('Не удалось проверить права администратора в MAX.'),
      );
      (service as any).logger.warn = jest.fn();

      await (service as any).materializeRecurringSchedules(1);

      expect(transaction).not.toHaveBeenCalled();
      expect(scheduleUpdate).not.toHaveBeenCalled();
      expect(publicationUpdate).not.toHaveBeenCalled();
      expect(occurrenceCreate).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not materialize recurrence slots after a stale schedule claim', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T09:00:00.000Z'));
    try {
      const createMany = jest.fn();
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        publicationSchedule: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        publicationOccurrence: { createMany },
      };
      const { service } = createService({
        publicationSchedule: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'schedule-1',
              publicationId: 'publication-1',
              revision: 4,
              rule: {
                mode: 'recurrence',
                timezone: 'UTC',
                frequency: 'daily',
                interval: 1,
                weekdays: [],
                times: ['10:00'],
                startsAt: '2026-07-10T09:00:00.000Z',
                endsAt: null,
                maxOccurrences: null,
                replaceConflicts: false,
              },
              publication: {
                id: 'publication-1',
                actorUserId: 'user-1',
                audienceMode: 'SNAPSHOT',
                audienceSelection: 'SELECTED',
                canonicalContentRevisionId: 'content-1',
                targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
              },
            },
          ]),
        },
        publicationOccurrence: {
          findFirst: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(0),
        },
        chat: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 'chat-1', title: 'Чат', entityType: ChatEntityType.CHAT }]),
        },
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      });

      await (service as any).materializeRecurringSchedules(1);

      expect(tx.publicationSchedule.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'schedule-1',
            revision: 4,
            status: PublicationScheduleStatus.ACTIVE,
          }),
        }),
      );
      expect(createMany).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('materializes recurrence slots with the canonical content refreshed under the lock', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T09:00:00.000Z'));
    try {
      const createMany = jest.fn().mockResolvedValue({ count: 1 });
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        publication: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ canonicalContentRevisionId: 'content-current' }),
        },
        publicationSchedule: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        publicationOccurrence: { createMany },
      };
      const { service } = createService({
        publicationSchedule: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'schedule-1',
              publicationId: 'publication-1',
              revision: 4,
              rule: {
                mode: 'recurrence',
                timezone: 'UTC',
                frequency: 'daily',
                interval: 1,
                weekdays: [],
                times: ['10:00'],
                startsAt: '2026-07-10T09:00:00.000Z',
                endsAt: null,
                maxOccurrences: 1,
                replaceConflicts: false,
              },
              publication: {
                id: 'publication-1',
                actorUserId: 'user-1',
                audienceMode: 'SNAPSHOT',
                audienceSelection: 'SELECTED',
                canonicalContentRevisionId: 'content-stale',
                dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED,
                requiredBotId: null,
                targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
              },
            },
          ]),
        },
        publicationOccurrence: {
          findFirst: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(0),
        },
        chat: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 'chat-1', title: 'Чат', entityType: ChatEntityType.CHAT }]),
        },
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      });
      jest.spyOn(service as any, 'reservePublicationCalendar').mockResolvedValue(undefined);

      await (service as any).materializeRecurringSchedules(1);

      expect(tx.publication.findUnique).toHaveBeenCalledWith({
        where: { id: 'publication-1' },
        select: { canonicalContentRevisionId: true },
      });
      expect(createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            publicationId: 'publication-1',
            scheduleRevision: 4,
            contentRevisionId: 'content-current',
            dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED,
            requiredBotId: null,
          }),
        ],
        skipDuplicates: true,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('reactivates the exact failed schedule revision before retrying deliveries', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      publication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationSchedule: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationOccurrence: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      managedBroadcastDelivery: {
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([{ id: 'broadcast-1' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publicationMutationRecord: { create: jest.fn().mockResolvedValue({}) },
    };
    const { service } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          version: 7,
          lifecycle: PublicationLifecycle.ERROR,
          canonicalContentRevisionId: 'content-latest',
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
        }),
      },
      publicationOccurrence: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'occurrence-1',
          publicationId: 'publication-1',
          scheduleId: 'schedule-1',
          scheduleRevision: 5,
          contentRevisionId: 'content-original',
          contentRevision: { revision: 1 },
          status: PublicationOccurrenceStatus.FAILED,
          schedule: { id: 'schedule-1', mode: PublicationScheduleMode.RECURRENCE },
          legacyBroadcasts: [{ id: 'broadcast-1' }],
        }),
      },
      managedBroadcastDelivery: { count: jest.fn().mockResolvedValue(1) },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });
    jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-1' } as never);

    await service.retryOccurrence(
      'publication-1',
      'occurrence-1',
      { userId: 'user-1', username: null, displayName: null },
      { requestId: 'retry-001' },
    );

    expect(tx.publicationSchedule.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'schedule-1',
        revision: 5,
        status: { in: [PublicationScheduleStatus.ACTIVE, PublicationScheduleStatus.ERROR] },
        publication: { is: { id: 'publication-1', lifecycle: PublicationLifecycle.ACTIVE } },
      },
      data: {
        status: PublicationScheduleStatus.ACTIVE,
        nextMaterializeAt: expect.any(Date),
        lastError: null,
      },
    });
    expect(tx.managedBroadcastDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: ManagedBroadcastDeliveryStatus.FAILED }),
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.PENDING,
          botId: null,
          remoteMessageId: null,
          remoteMessageVerifiedAt: null,
          remoteMessageVerificationAttemptCount: 0,
          remoteMessageVerificationAbsentCount: 0,
          remoteMessageVerificationPresentCount: 0,
          remoteMessageVerificationAttemptedAt: null,
          remoteMessageVerificationNextAt: null,
          remoteMessageVerificationLastError: null,
          remoteMessageVerificationSource: null,
          legacySentWithoutRemoteId: false,
          sentAt: null,
        }),
      }),
    );
  });

  it('requeues a failed occurrence without an execution envelope only after an explicit retry', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      publication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationSchedule: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationOccurrence: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      managedBroadcast: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
      },
      managedBroadcastDelivery: { updateMany: jest.fn() },
      publicationMutationRecord: { create: jest.fn().mockResolvedValue({}) },
    };
    const { service } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          version: 7,
          lifecycle: PublicationLifecycle.ERROR,
          canonicalContentRevisionId: 'content-current',
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
        }),
      },
      publicationOccurrence: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'occurrence-orphan',
          publicationId: 'publication-1',
          scheduleId: 'schedule-1',
          scheduleRevision: 5,
          contentRevisionId: 'content-current',
          contentRevision: { revision: 7 },
          status: PublicationOccurrenceStatus.FAILED,
          legacyBroadcastId: null,
          schedule: { id: 'schedule-1', mode: PublicationScheduleMode.ONCE },
          _count: { deliveries: 0, legacyBroadcasts: 0 },
        }),
      },
      managedBroadcastDelivery: { count: jest.fn().mockResolvedValue(0) },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });
    jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-1' } as never);

    await service.retryOccurrence(
      'publication-1',
      'occurrence-orphan',
      { userId: 'user-1', username: null, displayName: null },
      { requestId: 'retry-orphan-001' },
    );

    expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'occurrence-orphan',
        publicationId: 'publication-1',
        scheduleRevision: 5,
        status: PublicationOccurrenceStatus.FAILED,
        legacyBroadcastId: null,
        legacyBroadcasts: { none: {} },
        deliveries: { none: {} },
        contentRevisionId: 'content-current',
      },
      data: { status: PublicationOccurrenceStatus.SCHEDULED },
    });
    expect(tx.managedBroadcast.findMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcast.updateMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcastDelivery.updateMany).not.toHaveBeenCalled();
    expect(tx.publicationMutationRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: 'user-1',
        requestId: 'retry-orphan-001',
        publicationId: 'publication-1',
      }),
    });
  });

  it('does not requeue a delivery-less failure when an execution envelope still exists', async () => {
    const tx = { $executeRaw: jest.fn() };
    const { service, transaction, failedDeliveryCount } = createOriginalRetryService(tx);
    failedDeliveryCount.mockResolvedValue(0);

    await expect(
      service.retryOccurrence(
        'publication-1',
        'occurrence-1',
        { userId: 'user-1', username: null, displayName: null },
        { requestId: 'retry-non-orphan-001' },
      ),
    ).rejects.toThrow('Нет доставок, которые можно безопасно повторить');

    expect(transaction).not.toHaveBeenCalled();
  });

  it('rebinds only failed targets when retrying the latest content revision', async () => {
    const persistedDeliveries: Array<{
      id: string;
      broadcastId: string;
      publicationOccurrenceId: string;
      status: ManagedBroadcastDeliveryStatus;
      contentRevisionId: string;
    }> = [
      {
        id: 'delivery-failed',
        broadcastId: 'broadcast-failed',
        publicationOccurrenceId: 'occurrence-1',
        status: ManagedBroadcastDeliveryStatus.FAILED,
        contentRevisionId: 'content-original',
      },
      {
        id: 'delivery-sent',
        broadcastId: 'broadcast-failed',
        publicationOccurrenceId: 'occurrence-1',
        status: ManagedBroadcastDeliveryStatus.SENT,
        contentRevisionId: 'content-original',
      },
      {
        id: 'delivery-ambiguous',
        broadcastId: 'broadcast-ambiguous',
        publicationOccurrenceId: 'occurrence-1',
        status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
        contentRevisionId: 'content-original',
      },
    ];
    const updateDeliveries = jest.fn().mockImplementation(
      async ({
        where,
        data,
      }: {
        where: {
          publicationOccurrenceId: string;
          broadcastId: { in: string[] };
          status: ManagedBroadcastDeliveryStatus;
        };
        data: Partial<(typeof persistedDeliveries)[number]>;
      }) => {
        let count = 0;
        for (const delivery of persistedDeliveries) {
          if (
            delivery.publicationOccurrenceId !== where.publicationOccurrenceId ||
            !where.broadcastId.in.includes(delivery.broadcastId) ||
            delivery.status !== where.status
          ) {
            continue;
          }
          Object.assign(delivery, data);
          count += 1;
        }
        return { count };
      },
    );
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      publication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationSchedule: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationOccurrence: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      managedBroadcastDelivery: { updateMany: updateDeliveries },
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([{ id: 'broadcast-failed' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publicationMutationRecord: { create: jest.fn().mockResolvedValue({}) },
    };
    const deliveryCount = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const { service } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          version: 8,
          lifecycle: PublicationLifecycle.ERROR,
          canonicalContentRevisionId: 'content-latest',
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
        }),
      },
      publicationContentRevision: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'content-latest',
          revision: 8,
          text: 'Актуальный текст',
          textFormat: PublicationContentFormat.MARKDOWN,
          buttons: [{ text: 'Открыть', url: 'https://example.com' }],
        }),
      },
      publicationOccurrence: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'occurrence-1',
          publicationId: 'publication-1',
          scheduleId: 'schedule-1',
          scheduleRevision: 5,
          contentRevisionId: 'content-original',
          contentRevision: { revision: 7 },
          status: PublicationOccurrenceStatus.PARTIAL,
          schedule: { id: 'schedule-1', mode: PublicationScheduleMode.ONCE },
          legacyBroadcasts: [
            { id: 'broadcast-failed' },
            { id: 'broadcast-sent' },
            { id: 'broadcast-ambiguous' },
          ],
        }),
      },
      managedBroadcastDelivery: { count: deliveryCount },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });
    jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-1' } as never);

    await service.retryOccurrence(
      'publication-1',
      'occurrence-1',
      { userId: 'user-1', username: null, displayName: null },
      {
        requestId: 'retry-latest-001',
        contentMode: 'latest',
        expectedPublicationVersion: 8,
        expectedContentRevision: 8,
      },
    );

    expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ contentRevisionId: 'content-original' }),
        data: expect.objectContaining({
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          contentRevisionId: 'content-latest',
        }),
      }),
    );
    expect(tx.managedBroadcastDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          broadcastId: { in: ['broadcast-failed'] },
          status: ManagedBroadcastDeliveryStatus.FAILED,
        }),
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.PENDING,
          contentRevisionId: 'content-latest',
        }),
      }),
    );
    expect(tx.managedBroadcast.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['broadcast-failed'] } }),
        data: expect.objectContaining({
          text: 'Актуальный текст',
          textFormat: 'markdown',
          publicationContentRevisionId: 'content-latest',
        }),
      }),
    );
    expect(persistedDeliveries).toEqual([
      expect.objectContaining({
        id: 'delivery-failed',
        status: ManagedBroadcastDeliveryStatus.PENDING,
        contentRevisionId: 'content-latest',
      }),
      expect.objectContaining({
        id: 'delivery-sent',
        status: ManagedBroadcastDeliveryStatus.SENT,
        contentRevisionId: 'content-original',
      }),
      expect.objectContaining({
        id: 'delivery-ambiguous',
        status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
        contentRevisionId: 'content-original',
      }),
    ]);
    expect(tx.managedBroadcast.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['broadcast-failed'] },
          lockedAt: null,
          lockToken: null,
          deliveries: expect.objectContaining({
            some: expect.objectContaining({ status: ManagedBroadcastDeliveryStatus.FAILED }),
            none: expect.objectContaining({
              status: {
                in: [
                  ManagedBroadcastDeliveryStatus.SENDING,
                  ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                ],
              },
            }),
          }),
        }),
        data: {
          lockedAt: expect.any(Date),
          lockToken: expect.stringMatching(/^publication-retry:/),
        },
      }),
    );
    expect(tx.managedBroadcast.findMany).toHaveBeenCalledWith({
      where: {
        publicationOccurrenceId: 'occurrence-1',
        deliveries: {
          some: {
            publicationOccurrenceId: 'occurrence-1',
            status: ManagedBroadcastDeliveryStatus.FAILED,
          },
        },
      },
      select: { id: true },
    });
    expect(tx.managedBroadcast.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['broadcast-failed'] },
          lockToken: expect.stringMatching(/^publication-retry:/),
        }),
        data: expect.objectContaining({ lockedAt: null, lockToken: null }),
      }),
    );
  });

  it('rolls back an original retry when any failed envelope already has a worker lease', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcast: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'broadcast-free' }, { id: 'broadcast-worker-owned' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publication: { updateMany: jest.fn() },
      publicationSchedule: { updateMany: jest.fn() },
      publicationOccurrence: { updateMany: jest.fn() },
      managedBroadcastDelivery: { updateMany: jest.fn() },
    };
    const { service } = createOriginalRetryService(tx);

    await expect(
      service.retryOccurrence(
        'publication-1',
        'occurrence-1',
        { userId: 'user-1', username: null, displayName: null },
        { requestId: 'retry-worker-owned' },
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.managedBroadcast.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lockedAt: null,
          lockToken: null,
          deliveries: expect.objectContaining({
            none: expect.objectContaining({
              status: {
                in: [
                  ManagedBroadcastDeliveryStatus.SENDING,
                  ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                ],
              },
            }),
          }),
        }),
      }),
    );
    expect(tx.publication.updateMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcastDelivery.updateMany).not.toHaveBeenCalled();
  });

  it('rolls back when a worker lease appears between envelope selection and CAS claim', async () => {
    let envelopesSelected = false;
    const findMany = jest.fn().mockImplementation(async () => {
      envelopesSelected = true;
      return [{ id: 'broadcast-1' }];
    });
    const claimBroadcast = jest.fn().mockImplementation(async () => {
      expect(envelopesSelected).toBe(true);
      return { count: 0 };
    });
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcast: { findMany, updateMany: claimBroadcast },
      publication: { updateMany: jest.fn() },
      publicationSchedule: { updateMany: jest.fn() },
      publicationOccurrence: { updateMany: jest.fn() },
      managedBroadcastDelivery: { updateMany: jest.fn() },
    };
    const { service } = createOriginalRetryService(tx);

    await expect(
      service.retryOccurrence(
        'publication-1',
        'occurrence-1',
        { userId: 'user-1', username: null, displayName: null },
        { requestId: 'retry-raced-lease' },
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(findMany.mock.invocationCallOrder[0]).toBeLessThan(
      claimBroadcast.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(tx.managedBroadcastDelivery.updateMany).not.toHaveBeenCalled();
  });

  it('rechecks the retryable occurrence status inside the transaction', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([{ id: 'broadcast-1' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationSchedule: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationOccurrence: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      managedBroadcastDelivery: { updateMany: jest.fn() },
    };
    const { service } = createOriginalRetryService(tx);

    await expect(
      service.retryOccurrence(
        'publication-1',
        'occurrence-1',
        { userId: 'user-1', username: null, displayName: null },
        { requestId: 'retry-occurrence-race' },
      ),
    ).rejects.toThrow('Запуск публикации уже изменён');

    expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: [PublicationOccurrenceStatus.FAILED, PublicationOccurrenceStatus.PARTIAL],
          },
        }),
      }),
    );
    expect(tx.managedBroadcastDelivery.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    PublicationOccurrenceStatus.CANCELED,
    PublicationOccurrenceStatus.SENT,
    PublicationOccurrenceStatus.AMBIGUOUS,
    PublicationOccurrenceStatus.IN_PROGRESS,
  ])('rejects a %s occurrence before starting a retry transaction', async (status) => {
    const tx = { $executeRaw: jest.fn() };
    const { service, transaction, failedDeliveryCount } = createOriginalRetryService(tx, status);

    await expect(
      service.retryOccurrence(
        'publication-1',
        'occurrence-1',
        { userId: 'user-1', username: null, displayName: null },
        { requestId: `retry-invalid-${status.toLowerCase()}` },
      ),
    ).rejects.toThrow('Этот запуск больше нельзя повторить');

    expect(failedDeliveryCount).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('does not retry when the exact schedule revision is paused or terminal', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      publication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationSchedule: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      publicationOccurrence: { updateMany: jest.fn() },
      managedBroadcastDelivery: { updateMany: jest.fn() },
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([{ id: 'broadcast-1' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const { service } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          version: 7,
          lifecycle: PublicationLifecycle.ERROR,
          canonicalContentRevisionId: 'content-latest',
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
        }),
      },
      publicationOccurrence: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'occurrence-1',
          publicationId: 'publication-1',
          scheduleId: 'schedule-1',
          scheduleRevision: 5,
          contentRevisionId: 'content-original',
          contentRevision: { revision: 1 },
          status: PublicationOccurrenceStatus.FAILED,
          schedule: { id: 'schedule-1', mode: PublicationScheduleMode.ONCE },
          legacyBroadcasts: [{ id: 'broadcast-1' }],
        }),
      },
      managedBroadcastDelivery: { count: jest.fn().mockResolvedValue(1) },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });

    await expect(
      service.retryOccurrence(
        'publication-1',
        'occurrence-1',
        { userId: 'user-1', username: null, displayName: null },
        { requestId: 'retry-002' },
      ),
    ).rejects.toThrow('Расписание публикации изменилось или остановлено');
    expect(tx.publicationOccurrence.updateMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcastDelivery.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a delivery retry when access to a persisted target was revoked', async () => {
    const tx = { $executeRaw: jest.fn() };
    const { service, transaction, failedDeliveryCount, managedEntitiesService } =
      createOriginalRetryService(tx);
    managedEntitiesService.listChats.mockResolvedValue([]);
    managedEntitiesService.listChannels.mockResolvedValue([]);

    await expect(
      service.retryOccurrence(
        'publication-1',
        'occurrence-1',
        { userId: 'user-1', username: null, displayName: null },
        { requestId: 'retry-revoked-001' },
      ),
    ).rejects.toThrow('больше недоступны');
    expect(failedDeliveryCount).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['pause', PublicationLifecycle.DRAFT],
    ['resume', PublicationLifecycle.ACTIVE],
    ['cancel', PublicationLifecycle.COMPLETED],
  ] as const)('rejects invalid %s transition from %s', async (action, lifecycle) => {
    const { service } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({ id: 'publication-1', version: 1, lifecycle }),
      },
    });

    await expect(
      service[action](
        'publication-1',
        { userId: 'user-1', username: null, displayName: null },
        { requestId: `action-${action}`, expectedRevision: 1 },
      ),
    ).rejects.toThrow();
  });

  it('rejects resume before mutation when live access to a persisted target is revoked', async () => {
    const transaction = jest.fn();
    const { service, managedEntitiesService } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          version: 1,
          lifecycle: PublicationLifecycle.PAUSED,
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
        }),
      },
      $transaction: transaction,
    });
    managedEntitiesService.assertChatAdminAccess.mockRejectedValue(
      new ForbiddenException('Пользователь не является администратором чата.'),
    );

    await expect(
      service.resume(
        'publication-1',
        { userId: 'user-1', username: null, displayName: null },
        { requestId: 'resume-revoked-001', expectedRevision: 1 },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(managedEntitiesService.assertChatAdminAccess).toHaveBeenCalledTimes(1);
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each(['pause', 'cancel'] as const)(
    'allows %s to reach the stop transaction without live target access',
    async (action) => {
      const transactionStarted = new Error('stop transaction started');
      const transaction = jest.fn().mockRejectedValue(transactionStarted);
      const { service, managedEntitiesService } = createService({
        publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
        publication: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'publication-1',
            version: 1,
            lifecycle: PublicationLifecycle.ACTIVE,
            targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
          }),
        },
        $transaction: transaction,
      });
      managedEntitiesService.assertChatAdminAccess.mockRejectedValue(
        new ForbiddenException('Пользователь не является администратором чата.'),
      );

      await expect(
        service[action](
          'publication-1',
          { userId: 'user-1', username: null, displayName: null },
          { requestId: `${action}-revoked-001`, expectedRevision: 1 },
        ),
      ).rejects.toBe(transactionStarted);

      expect(managedEntitiesService.assertChatAdminAccess).not.toHaveBeenCalled();
      expect(transaction).toHaveBeenCalledTimes(1);
    },
  );

  it('removes only unsent canceled envelopes from future scheduled occurrences before resume', async () => {
    const tx = {
      publicationOccurrence: {
        findMany: jest.fn().mockResolvedValue([{ id: 'occurrence-1' }]),
      },
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([{ id: 'broadcast-1' }]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const { service } = createService();
    const now = new Date('2026-07-10T09:00:00.000Z');

    await (service as any).restoreAccessLossPausedOccurrences(
      tx,
      'publication-1',
      'schedule-1',
      3,
      now,
    );

    expect(tx.publicationOccurrence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          publicationId: 'publication-1',
          scheduleId: 'schedule-1',
          scheduleRevision: 3,
          status: PublicationOccurrenceStatus.SCHEDULED,
          scheduledAt: { gte: now },
          deliveries: {
            none: {
              OR: [
                { attemptCount: { gt: 0 } },
                {
                  status: {
                    in: [
                      ManagedBroadcastDeliveryStatus.SENDING,
                      ManagedBroadcastDeliveryStatus.SENT,
                      ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                    ],
                  },
                },
              ],
            },
          },
        }),
      }),
    );
    expect(tx.managedBroadcast.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['broadcast-1'] } },
    });
  });

  it('marks an ambiguous delivery sent, completes its broadcast, and rolls state up before get', async () => {
    const tx = {
      managedBroadcastDelivery: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{ status: ManagedBroadcastDeliveryStatus.SENT }]),
      },
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([{ id: 'broadcast-1' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcastCalendarReservation: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcastOccurrence: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationMutationRecord: { create: jest.fn().mockResolvedValue({}) },
    };
    const { service } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          version: 2,
          lifecycle: PublicationLifecycle.ERROR,
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
        }),
      },
      managedBroadcastDelivery: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'delivery-1',
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
          sentAt: null,
          remoteMessageId: 'mid-manual-confirmed',
        }),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });
    const rollupOccurrence = jest
      .spyOn(service as any, 'rollupOccurrence')
      .mockResolvedValue(undefined);
    const rollupLifecycle = jest
      .spyOn(service as any, 'rollupPublicationLifecycle')
      .mockResolvedValue(undefined);
    const get = jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-1' } as never);

    await service.resolveAmbiguousDelivery(
      'publication-1',
      'occurrence-1',
      { userId: 'user-1', username: null, displayName: null },
      { requestId: 'resolve-001', deliveryId: 'delivery-1', resolution: 'mark_sent' },
    );

    expect(tx.managedBroadcastDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.SENT,
          remoteMessageVerificationAttemptCount: 0,
          remoteMessageVerificationPresentCount: 0,
          remoteMessageVerificationAttemptedAt: null,
          remoteMessageVerificationSource: PublicationDeliveryVerificationSource.MANUAL_CONFIRMED,
          remoteMessageVerifiedAt: expect.any(Date),
        }),
      }),
    );
    expect(tx.managedBroadcast.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ManagedBroadcastStatus.COMPLETED,
          sentCount: 1,
          nextSendAt: null,
        }),
      }),
    );
    expect(rollupOccurrence).toHaveBeenCalledWith('occurrence-1');
    expect(rollupLifecycle).toHaveBeenCalledWith('publication-1');
    expect(rollupLifecycle.mock.invocationCallOrder[0]).toBeLessThan(
      get.mock.invocationCallOrder[0],
    );
  });

  it('rejects ambiguous-delivery resolution before reading or mutating delivery state', async () => {
    const transaction = jest.fn();
    const findDelivery = jest.fn();
    const { service, managedEntitiesService } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          version: 2,
          lifecycle: PublicationLifecycle.ERROR,
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
        }),
      },
      managedBroadcastDelivery: { findFirst: findDelivery },
      $transaction: transaction,
    });
    managedEntitiesService.assertChatAdminAccess.mockRejectedValue(
      new ForbiddenException('Пользователь не является администратором чата.'),
    );

    await expect(
      service.resolveAmbiguousDelivery(
        'publication-1',
        'occurrence-1',
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'resolve-revoked-001',
          deliveryId: 'delivery-1',
          resolution: 'mark_failed',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(findDelivery).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('reactivates a broadcast when ambiguous resolution leaves pending fanout targets', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { service } = createService();

    await (service as any).syncBroadcastAfterDeliveryResolution(
      {
        managedBroadcastDelivery: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { status: ManagedBroadcastDeliveryStatus.SENT },
              { status: ManagedBroadcastDeliveryStatus.PENDING },
            ]),
        },
        managedBroadcast: { updateMany },
      },
      'broadcast-1',
      1,
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'broadcast-1', status: { not: ManagedBroadcastStatus.CANCELED } },
      data: {
        status: ManagedBroadcastStatus.ACTIVE,
        nextSendAt: expect.any(Date),
        lockedAt: null,
        lockToken: null,
        lastError: null,
      },
    });
  });

  it('keeps a resolved broadcast active while another sent target still needs verification', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const nextVerificationAt = new Date(Date.now() + 60_000);
    const { service } = createService();

    await (service as any).syncBroadcastAfterDeliveryResolution(
      {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([
            {
              status: ManagedBroadcastDeliveryStatus.SENT,
              sentAt: new Date(),
              remoteMessageId: null,
              remoteMessageVerifiedAt: null,
              remoteMessageVerificationNextAt: null,
            },
            {
              status: ManagedBroadcastDeliveryStatus.SENT,
              sentAt: new Date(),
              remoteMessageId: 'message-unverified',
              remoteMessageVerifiedAt: null,
              remoteMessageVerificationNextAt: nextVerificationAt,
            },
          ]),
        },
        managedBroadcast: { updateMany },
      },
      'broadcast-1',
      1,
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'broadcast-1', status: { not: ManagedBroadcastStatus.CANCELED } },
      data: {
        status: ManagedBroadcastStatus.ACTIVE,
        nextSendAt: nextVerificationAt,
        lockedAt: null,
        lockToken: null,
        lastError: null,
      },
    });
  });

  it('does not reactivate a resolved broadcast for untouched legacy SENT verification state', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { service } = createService();

    await (service as any).syncBroadcastAfterDeliveryResolution(
      {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([
            {
              status: ManagedBroadcastDeliveryStatus.SENT,
              sentAt: new Date('2026-07-11T10:00:00.000Z'),
              remoteMessageId: 'message-legacy',
              remoteMessageVerifiedAt: null,
              remoteMessageVerificationAttemptCount: 0,
              remoteMessageVerificationAbsentCount: 0,
              remoteMessageVerificationPresentCount: 0,
              remoteMessageVerificationAttemptedAt: null,
              remoteMessageVerificationNextAt: null,
              remoteMessageVerificationSource: null,
            },
          ]),
        },
        managedBroadcast: { updateMany },
        managedBroadcastCalendarReservation: { deleteMany: jest.fn() },
        managedBroadcastOccurrence: { updateMany: jest.fn() },
      },
      'broadcast-legacy',
      1,
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'broadcast-legacy', status: { not: ManagedBroadcastStatus.CANCELED } },
      data: expect.objectContaining({
        status: ManagedBroadcastStatus.COMPLETED,
        sentCount: 1,
        nextSendAt: null,
      }),
    });
  });

  it.each([
    [
      [{ status: PublicationOccurrenceStatus.SENT, _count: { _all: 1 } }],
      PublicationScheduleStatus.ERROR,
      PublicationLifecycle.COMPLETED,
      PublicationScheduleStatus.COMPLETED,
      'sent current revision',
    ],
    [
      [],
      PublicationScheduleStatus.ACTIVE,
      PublicationLifecycle.COMPLETED,
      PublicationScheduleStatus.COMPLETED,
      'empty exhausted current revision',
    ],
    [
      [],
      PublicationScheduleStatus.ERROR,
      PublicationLifecycle.ERROR,
      PublicationScheduleStatus.ERROR,
      'empty failed schedule',
    ],
  ] as const)(
    'rolls lifecycle up for %s (%s)',
    async (grouped, scheduleStatus, expectedLifecycle, expectedScheduleStatus, _label) => {
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        publication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        publicationOccurrence: { count: jest.fn().mockResolvedValue(0) },
        publicationSchedule: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
      const groupBy = jest.fn().mockResolvedValue(grouped);
      const { service } = createService({
        publication: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'publication-1',
            lifecycle: PublicationLifecycle.ERROR,
            schedule: {
              id: 'schedule-1',
              revision: 6,
              status: scheduleStatus,
              nextMaterializeAt: null,
            },
          }),
        },
        publicationOccurrence: { groupBy },
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      });

      await (service as any).rollupPublicationLifecycle('publication-1');

      expect(groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            publicationId: 'publication-1',
            scheduleId: 'schedule-1',
            scheduleRevision: 6,
          },
        }),
      );
      if (
        expectedLifecycle === PublicationLifecycle.ERROR &&
        expectedScheduleStatus === PublicationScheduleStatus.ERROR
      ) {
        expect(tx.publication.updateMany).not.toHaveBeenCalled();
        expect(tx.publicationSchedule.updateMany).not.toHaveBeenCalled();
      } else {
        expect(tx.publication.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              occurrences: {
                none: {
                  scheduleId: 'schedule-1',
                  scheduleRevision: 6,
                  status: {
                    in: [
                      PublicationOccurrenceStatus.SCHEDULED,
                      PublicationOccurrenceStatus.IN_PROGRESS,
                    ],
                  },
                },
              },
            }),
            data: { lifecycle: expectedLifecycle },
          }),
        );
        expect(tx.publicationSchedule.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ data: { status: expectedScheduleStatus } }),
        );
      }
    },
  );

  it('marks an empty active recurrence as an error instead of completing it as 0/0', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T09:00:00.000Z'));
    try {
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        publication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        publicationOccurrence: { count: jest.fn().mockResolvedValue(0) },
        publicationSchedule: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
      const { service } = createService({
        publication: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'publication-empty',
            lifecycle: PublicationLifecycle.ACTIVE,
            schedule: {
              id: 'schedule-empty',
              revision: 1,
              mode: PublicationScheduleMode.RECURRENCE,
              status: PublicationScheduleStatus.ACTIVE,
              nextMaterializeAt: null,
              rule: {
                mode: 'recurrence',
                timezone: 'UTC',
                frequency: 'daily',
                interval: 1,
                weekdays: [],
                times: ['12:00'],
                startsAt: '2026-07-10T09:00:00.000Z',
                endsAt: '2026-07-10T10:00:00.000Z',
                maxOccurrences: null,
                replaceConflicts: false,
              },
            },
          }),
        },
        publicationOccurrence: {
          groupBy: jest.fn().mockResolvedValue([]),
          findFirst: jest.fn().mockResolvedValue(null),
        },
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      });

      await (service as any).rollupPublicationLifecycle('publication-empty');

      expect(tx.publication.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { lifecycle: PublicationLifecycle.ERROR } }),
      );
      expect(tx.publicationSchedule.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            status: PublicationScheduleStatus.ERROR,
            lastError: 'Расписание не содержит ни одного будущего запуска.',
          },
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('leaves lifecycle active when a retry starts after the rollup aggregate read', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      publication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationOccurrence: { count: jest.fn().mockResolvedValue(1) },
      publicationSchedule: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const { service } = createService({
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          lifecycle: PublicationLifecycle.ACTIVE,
          schedule: {
            id: 'schedule-1',
            revision: 6,
            status: PublicationScheduleStatus.ACTIVE,
            nextMaterializeAt: null,
          },
        }),
      },
      publicationOccurrence: {
        groupBy: jest
          .fn()
          .mockResolvedValue([{ status: PublicationOccurrenceStatus.FAILED, _count: { _all: 1 } }]),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });

    await (service as any).rollupPublicationLifecycle('publication-1');

    expect(tx.publicationOccurrence.count).toHaveBeenCalledWith({
      where: {
        publicationId: 'publication-1',
        scheduleId: 'schedule-1',
        scheduleRevision: 6,
        status: {
          in: [PublicationOccurrenceStatus.SCHEDULED, PublicationOccurrenceStatus.IN_PROGRESS],
        },
      },
    });
    expect(tx.publication.updateMany).not.toHaveBeenCalled();
    expect(tx.publicationSchedule.updateMany).not.toHaveBeenCalled();
  });

  it('selects lifecycle rollups only when no occurrence is still scheduled or in progress', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const { service } = createService({ publication: { findMany } });

    await (service as any).rollupPublicationLifecycles();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { lifecycle: PublicationLifecycle.ACTIVE },
            {
              lifecycle: PublicationLifecycle.ERROR,
              occurrences: {
                some: {
                  status: {
                    in: [PublicationOccurrenceStatus.SENT, PublicationOccurrenceStatus.CANCELED],
                  },
                },
                none: {
                  status: {
                    in: [
                      PublicationOccurrenceStatus.FAILED,
                      PublicationOccurrenceStatus.PARTIAL,
                      PublicationOccurrenceStatus.AMBIGUOUS,
                    ],
                  },
                },
              },
            },
          ],
          schedule: { is: { nextMaterializeAt: null } },
          occurrences: {
            none: {
              status: {
                in: [
                  PublicationOccurrenceStatus.SCHEDULED,
                  PublicationOccurrenceStatus.IN_PROGRESS,
                ],
              },
            },
          },
        },
      }),
    );
  });

  it('detects conflicts with current-revision publication occurrences before envelopes exist', async () => {
    const slot = new Date('2026-07-12T09:00:00.000Z');
    const { service } = createService({
      managedBroadcastCalendarReservation: { findMany: jest.fn().mockResolvedValue([]) },
      publicationOccurrence: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'old-occurrence',
            publicationId: 'old-publication',
            scheduleId: 'old-schedule',
            scheduleRevision: 2,
            scheduledAt: slot,
            schedule: { revision: 2 },
            publication: {
              actorUserId: 'user-1',
              targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
            },
          },
        ]),
      },
    });

    await expect(
      (service as any).assertCalendarAvailability(
        [
          {
            chatId: 'chat-1',
            entityType: 'chat',
            title: 'Чат',
            avatarUrl: null,
            link: null,
          },
        ],
        [slot],
        {
          mode: 'once',
          timezone: 'Europe/Moscow',
          at: '2026-07-12T12:00:00.000+03:00',
          replaceConflicts: false,
        },
        'user-1',
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PUBLICATION_SCHEDULE_CONFLICT' }),
    });
  });

  it('replaces only fully covered publication occurrences under the calendar lock', async () => {
    const slot = new Date('2026-07-12T09:00:00.000Z');
    const conflict = {
      id: 'old-occurrence',
      publicationId: 'old-publication',
      scheduleId: 'old-schedule',
      scheduleRevision: 2,
      scheduledAt: slot,
      schedule: { revision: 2 },
      publication: {
        actorUserId: 'user-1',
        targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
      },
    };
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcastCalendarReservation: { findMany: jest.fn().mockResolvedValue([]) },
      publicationOccurrence: {
        findMany: jest.fn().mockResolvedValue([conflict]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcast: { findMany: jest.fn().mockResolvedValue([]) },
      managedBroadcastDelivery: { count: jest.fn().mockResolvedValue(0) },
    };
    const { service } = createService();

    await (service as any).reservePublicationCalendar(
      tx,
      [
        {
          chatId: 'chat-1',
          entityType: 'chat',
          title: 'Чат',
          avatarUrl: null,
          link: null,
        },
      ],
      [slot],
      {
        mode: 'once',
        timezone: 'Europe/Moscow',
        at: '2026-07-12T12:00:00.000+03:00',
        replaceConflicts: true,
      },
      'new-publication',
      'user-1',
    );

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: PublicationOccurrenceStatus.CANCELED } }),
    );
  });

  it('requires manual review when replacement does not cover all old occurrence targets', async () => {
    const slot = new Date('2026-07-12T09:00:00.000Z');
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcastCalendarReservation: { findMany: jest.fn().mockResolvedValue([]) },
      publicationOccurrence: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'old-occurrence',
            publicationId: 'old-publication',
            scheduleId: 'old-schedule',
            scheduleRevision: 2,
            scheduledAt: slot,
            schedule: { revision: 2 },
            publication: {
              actorUserId: 'user-1',
              targets: [
                { targetChatId: 'chat-1', entityType: ChatEntityType.CHAT },
                { targetChatId: 'channel-1', entityType: ChatEntityType.CHANNEL },
              ],
            },
          },
        ]),
        updateMany: jest.fn(),
      },
    };
    const { service } = createService();

    await expect(
      (service as any).reservePublicationCalendar(
        tx,
        [
          {
            chatId: 'chat-1',
            entityType: 'chat',
            title: 'Чат',
            avatarUrl: null,
            link: null,
          },
        ],
        [slot],
        {
          mode: 'once',
          timezone: 'Europe/Moscow',
          at: '2026-07-12T12:00:00.000+03:00',
          replaceConflicts: true,
        },
        'new-publication',
        'user-1',
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW' }),
    });
    expect(tx.publicationOccurrence.updateMany).not.toHaveBeenCalled();
  });

  it("requires manual review before replacing another owner's publication occurrence", async () => {
    const slot = new Date('2026-07-12T09:00:00.000Z');
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcastCalendarReservation: { findMany: jest.fn().mockResolvedValue([]) },
      publicationOccurrence: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'other-owner-occurrence',
            publicationId: 'other-owner-publication',
            scheduleId: 'other-owner-schedule',
            scheduleRevision: 2,
            scheduledAt: slot,
            schedule: { revision: 2 },
            publication: {
              actorUserId: 'user-2',
              targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
            },
          },
        ]),
        updateMany: jest.fn(),
      },
      managedBroadcast: { findMany: jest.fn() },
    };
    const { service } = createService();

    await expect(
      (service as any).reservePublicationCalendar(
        tx,
        [
          {
            chatId: 'chat-1',
            entityType: 'chat',
            title: 'Чат',
            avatarUrl: null,
            link: null,
          },
        ],
        [slot],
        {
          mode: 'once',
          timezone: 'Europe/Moscow',
          at: '2026-07-12T12:00:00.000+03:00',
          replaceConflicts: true,
        },
        'new-publication',
        'user-1',
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW' }),
    });
    expect(tx.managedBroadcast.findMany).not.toHaveBeenCalled();
    expect(tx.publicationOccurrence.updateMany).not.toHaveBeenCalled();
  });

  it('rejects replacement after any conflicting publication delivery attempt', async () => {
    const tx = {
      managedBroadcastDelivery: { count: jest.fn().mockResolvedValue(1) },
      publicationOccurrence: { updateMany: jest.fn() },
    };
    const { service } = createService();

    await expect(
      (service as any).cancelConflictingPublicationOccurrences(tx, [
        {
          id: 'old-occurrence',
          publicationId: 'old-publication',
          scheduleId: 'old-schedule',
          scheduleRevision: 2,
          scheduledAt: new Date('2026-07-12T09:00:00.000Z'),
          schedule: { revision: 2 },
          publication: {
            actorUserId: 'user-1',
            targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
          },
        },
      ]),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW' }),
    });
    expect(tx.publicationOccurrence.updateMany).not.toHaveBeenCalled();
  });

  it('rejects replacement for a preclaimed publication execution envelope', async () => {
    const lockedAt = new Date('2026-07-12T08:59:59.000Z');
    const updateOccurrences = jest.fn();
    const updateBroadcasts = jest.fn();
    const tx = {
      managedBroadcastDelivery: { count: jest.fn().mockResolvedValue(0) },
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'publication-broadcast',
            lockedAt,
            lockToken: 'publication-execution-lease',
          },
        ]),
        updateMany: updateBroadcasts,
      },
      publicationOccurrence: { updateMany: updateOccurrences },
    };
    const { service } = createService();

    await expect(
      (service as any).cancelConflictingPublicationOccurrences(tx, [
        {
          id: 'old-occurrence',
          publicationId: 'old-publication',
          scheduleId: 'old-schedule',
          scheduleRevision: 2,
          scheduledAt: new Date('2026-07-12T09:00:00.000Z'),
          schedule: { revision: 2 },
          publication: {
            actorUserId: 'user-1',
            targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
          },
        },
      ]),
    ).rejects.toMatchObject({
      response: {
        code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW',
        message: 'Конфликтующая публикация уже начала отправку. Проверьте её отдельно.',
      },
    });

    expect(tx.managedBroadcast.findMany).toHaveBeenCalledWith({
      where: {
        publicationOccurrenceId: { in: ['old-occurrence'] },
        status: {
          in: [
            ManagedBroadcastStatus.ACTIVE,
            ManagedBroadcastStatus.PARTIAL,
            ManagedBroadcastStatus.FAILED,
          ],
        },
      },
      select: { id: true, lockedAt: true, lockToken: true },
    });
    expect(updateOccurrences).not.toHaveBeenCalled();
    expect(updateBroadcasts).not.toHaveBeenCalled();
  });

  it('does not double-cancel a publication conflict represented by its reservation', async () => {
    const slot = new Date('2026-07-12T09:00:00.000Z');
    const reservationFindMany = jest.fn().mockResolvedValue([
      {
        broadcastId: 'publication-broadcast',
        entityType: ChatEntityType.CHAT,
        targetChatId: 'chat-1',
        scheduledAt: slot,
      },
    ]);
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcastCalendarReservation: {
        findMany: reservationFindMany,
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publicationOccurrence: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'old-occurrence',
            publicationId: 'old-publication',
            scheduleId: 'old-schedule',
            scheduleRevision: 2,
            scheduledAt: slot,
            schedule: { revision: 2 },
            publication: {
              actorUserId: 'user-1',
              targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
            },
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([{ id: 'publication-broadcast' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcastDelivery: {
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const { service } = createService();

    await (service as any).reservePublicationCalendar(
      tx,
      [
        {
          chatId: 'chat-1',
          entityType: 'chat',
          title: 'Чат',
          avatarUrl: null,
          link: null,
        },
      ],
      [slot],
      {
        mode: 'once',
        timezone: 'Europe/Moscow',
        at: '2026-07-12T12:00:00.000+03:00',
        replaceConflicts: true,
      },
      'new-publication',
      'user-1',
    );

    expect(reservationFindMany).toHaveBeenCalledTimes(1);
    expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledTimes(1);
  });

  it('cancels a mixed occurrence only after every execution envelope is canceled', async () => {
    const tx = {
      managedBroadcastCalendarReservation: {
        findMany: jest.fn().mockResolvedValue([
          {
            broadcastId: 'broadcast-chat',
            entityType: ChatEntityType.CHAT,
            targetChatId: 'chat-1',
            scheduledAt: new Date('2026-07-12T09:00:00.000Z'),
          },
        ]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcastDelivery: {
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publicationOccurrence: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const { service } = createService();

    await (service as any).cancelConflictingBroadcasts(tx, ['broadcast-chat'], {
      entityType: ChatEntityType.CHAT,
      scheduledAt: new Date('2026-07-12T09:00:00.000Z'),
      targetChatIds: ['chat-1'],
      actorUserId: 'user-1',
    });

    expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith({
      where: {
        legacyBroadcasts: {
          some: { id: { in: ['broadcast-chat'] } },
          every: { status: ManagedBroadcastStatus.CANCELED },
        },
      },
      data: { status: PublicationOccurrenceStatus.CANCELED },
    });
  });

  it('does not replace a legacy broadcast after delivery started or a lock is active', async () => {
    const reservationFindMany = jest.fn();
    const tx = {
      managedBroadcastDelivery: { count: jest.fn().mockResolvedValue(1) },
      managedBroadcast: { findMany: jest.fn().mockResolvedValue([{ id: 'broadcast-1' }]) },
      managedBroadcastCalendarReservation: { findMany: reservationFindMany },
    };
    const { service } = createService();

    await expect(
      (service as any).cancelConflictingBroadcasts(tx, ['broadcast-1'], {
        entityType: ChatEntityType.CHAT,
        scheduledAt: new Date('2026-07-12T09:00:00.000Z'),
        targetChatIds: ['chat-1'],
        actorUserId: 'user-1',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW' }),
    });
    expect(reservationFindMany).not.toHaveBeenCalled();
  });

  it("requires manual review before replacing another owner's legacy broadcast", async () => {
    const reservationFindMany = jest.fn();
    const updateBroadcasts = jest.fn();
    const tx = {
      managedBroadcastDelivery: { count: jest.fn().mockResolvedValue(0) },
      managedBroadcast: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'broadcast-other-owner', actorUserId: 'user-2' }]),
        updateMany: updateBroadcasts,
      },
      managedBroadcastCalendarReservation: { findMany: reservationFindMany },
    };
    const { service } = createService();

    await expect(
      (service as any).cancelConflictingBroadcasts(tx, ['broadcast-other-owner'], {
        entityType: ChatEntityType.CHAT,
        scheduledAt: new Date('2026-07-12T09:00:00.000Z'),
        targetChatIds: ['chat-1'],
        actorUserId: 'user-1',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW' }),
    });
    expect(reservationFindMany).not.toHaveBeenCalled();
    expect(updateBroadcasts).not.toHaveBeenCalled();
  });

  it('returns a controlled conflict when a legacy broadcast is claimed after replacement preflight', async () => {
    const slot = new Date('2026-07-12T09:00:00.000Z');
    const deleteReservations = jest.fn();
    const updateDeliveries = jest.fn();
    const tx = {
      managedBroadcastDelivery: {
        count: jest.fn().mockResolvedValue(0),
        updateMany: updateDeliveries,
      },
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      managedBroadcastCalendarReservation: {
        findMany: jest.fn().mockResolvedValue([
          {
            broadcastId: 'broadcast-1',
            entityType: ChatEntityType.CHAT,
            targetChatId: 'chat-1',
            scheduledAt: slot,
          },
        ]),
        deleteMany: deleteReservations,
      },
      publicationOccurrence: { updateMany: jest.fn() },
    };
    const { service } = createService();

    await expect(
      (service as any).cancelConflictingBroadcasts(tx, ['broadcast-1'], {
        entityType: ChatEntityType.CHAT,
        scheduledAt: slot,
        targetChatIds: ['chat-1'],
        actorUserId: 'user-1',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW' }),
    });
    expect(tx.managedBroadcast.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          actorUserId: 'user-1',
          sentCount: 0,
          lockedAt: null,
          lockToken: null,
          deliveries: {
            none: {
              OR: expect.arrayContaining([
                { attemptCount: { gt: 0 } },
                { lockedAt: { not: null } },
                {
                  status: {
                    in: [
                      ManagedBroadcastDeliveryStatus.SENDING,
                      ManagedBroadcastDeliveryStatus.SENT,
                      ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                    ],
                  },
                },
              ]),
            },
          },
        }),
      }),
    );
    expect(deleteReservations).not.toHaveBeenCalled();
    expect(updateDeliveries).not.toHaveBeenCalled();
  });

  it('keeps both entity types in mixed target previews limited to six items', async () => {
    const { presenter } = createService({
      managedBroadcastDelivery: { groupBy: jest.fn().mockResolvedValue([]) },
    });
    const targets = [
      ...Array.from({ length: 6 }, (_, index) => ({
        targetChatId: `chat-${index + 1}`,
        entityType: ChatEntityType.CHAT,
        chat: { title: `Чат ${index + 1}` },
      })),
      {
        targetChatId: 'channel-1',
        entityType: ChatEntityType.CHANNEL,
        chat: { title: 'Канал' },
      },
    ];

    const summary = await presenter.mapPublicationSummary({
      id: 'publication-mixed',
      title: 'Mixed',
      lifecycle: PublicationLifecycle.ACTIVE,
      version: 1,
      canonicalContentRevision: { text: 'Текст', assets: [] },
      targets,
      audienceSelection: 'SELECTED',
      audienceMode: 'SNAPSHOT',
      schedule: null,
      occurrences: [],
      createdAt: new Date('2026-07-10T08:00:00.000Z'),
      updatedAt: new Date('2026-07-10T08:00:00.000Z'),
    });

    expect(summary.targetPreviews).toHaveLength(6);
    expect(summary.targetPreviews.map((target) => target.entityType)).toEqual(
      expect.arrayContaining(['chat', 'channel']),
    );
    expect(summary.targetOverflowCount).toBe(1);
  });

  it('marks maxOccurrences=1 recurrence exhausted after its initial slot', () => {
    const { service } = createService();
    const now = new Date('2026-07-10T09:00:00.000Z');

    expect(
      (service as any).isInitialRecurrenceExhausted(
        {
          mode: 'recurrence',
          timezone: 'UTC',
          frequency: 'daily',
          interval: 1,
          weekdays: [],
          times: ['10:00'],
          startsAt: now.toISOString(),
          endsAt: null,
          maxOccurrences: 1,
          replaceConflicts: false,
        },
        [new Date('2026-07-10T10:00:00.000Z')],
        now,
      ),
    ).toBe(true);
  });

  it('resolves PUBLIK_V1 audiences from Publisher-owned scope without Major discovery', async () => {
    const { managedEntitiesService, publisherPolicyService, service } = createService();
    const user = { userId: 'user-1', username: null, displayName: null };

    const targets = await (service as any).resolveAudienceTargets(
      user,
      {
        selection: 'SELECTED',
        mode: 'SNAPSHOT',
        targets: [{ chatId: 'channel-1', entityType: 'channel' }],
      },
      PublicationDispatchProfile.PUBLIK_V1,
    );

    expect(targets).toEqual([
      expect.objectContaining({ chatId: 'channel-1', entityType: 'channel' }),
    ]);
    expect(publisherPolicyService.resolvePublicationTargets).toHaveBeenCalledWith(user, [
      { chatId: 'channel-1', entityType: 'channel' },
    ]);
    expect(managedEntitiesService.listChats).not.toHaveBeenCalled();
    expect(managedEntitiesService.listChannels).not.toHaveBeenCalled();
    expect(managedEntitiesService.assertChatAdminAccess).not.toHaveBeenCalled();
    expect(managedEntitiesService.assertChannelAdminAccess).not.toHaveBeenCalled();
  });

  it('scopes publication ownership checks to the requested dispatch profile', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const { service } = createService({ publication: { findFirst } });

    await expect(
      (service as any).assertPublicationOwner(
        'publication-1',
        'user-1',
        PublicationDispatchProfile.PUBLIK_V1,
      ),
    ).rejects.toThrow('Публикация не найдена.');
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'publication-1',
          actorUserId: 'user-1',
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        },
      }),
    );
  });

  it('rejects legacy-profile calendar work before resolving any Major audience', async () => {
    const { managedEntitiesService, publisherPolicyService, service } = createService();

    await expect(
      service.getCalendarAvailability(
        { userId: 'user-1' } as never,
        {
          audience: {
            selection: 'SELECTED',
            mode: 'SNAPSHOT',
            targets: [{ chatId: 'chat-1', entityType: 'chat' }],
          },
          from: '2026-07-11T00:00:00.000Z',
          to: '2026-07-31T23:59:59.999Z',
        },
        PublicationDispatchProfile.LEGACY_ROUTED,
      ),
    ).rejects.toThrow('Новые публикации создаются только через Публик.');
    expect(publisherPolicyService.resolvePublicationTargets).not.toHaveBeenCalled();
    expect(managedEntitiesService.assertChatAdminAccess).not.toHaveBeenCalled();
  });

  it('keeps LEGACY_ROUTED occurrence authorization on Major while PUBLIK_V1 uses Publisher', async () => {
    const { managedEntitiesService, publisherPolicyService, service } = createService();
    const publication = {
      actorUserId: 'user-1',
      audienceMode: PublicationAudienceMode.SNAPSHOT,
      audienceSelection: PublicationAudienceSelection.SELECTED,
      targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
    };

    await (service as any).resolveOccurrenceTargets({
      ...publication,
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
    });
    expect(publisherPolicyService.resolvePublicationTargets).toHaveBeenCalledTimes(1);
    expect(managedEntitiesService.listChats).not.toHaveBeenCalled();

    await (service as any).resolveOccurrenceTargets({
      ...publication,
      dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED,
    });
    expect(managedEntitiesService.listChats).toHaveBeenCalledTimes(1);
    expect(managedEntitiesService.assertChatAdminAccess).toHaveBeenCalledTimes(1);
    expect(publisherPolicyService.resolvePublicationTargets).toHaveBeenCalledTimes(1);
  });

  it('authorizes a PUBLIK_V1 retry through its persisted dispatch profile', async () => {
    const authorizationError = new Error('publisher authorization stopped retry');
    const { service } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-publik-retry',
          version: 1,
          lifecycle: PublicationLifecycle.ERROR,
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          requiredBotId: 'publisher-bot',
          canonicalContentRevisionId: 'content-1',
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
        }),
      },
    });
    const resolvePersisted = jest
      .spyOn(service as any, 'resolvePersistedPublicationTargets')
      .mockRejectedValue(authorizationError);

    await expect(
      service.retryOccurrence(
        'publication-publik-retry',
        'occurrence-1',
        { userId: 'user-1', username: null, displayName: null },
        { requestId: 'retry-publik-auth-001' },
      ),
    ).rejects.toBe(authorizationError);
    expect(resolvePersisted).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
      PublicationDispatchProfile.PUBLIK_V1,
    );
  });

  it('rejects an expanded ALL audience above the 500 target limit', async () => {
    const { managedEntitiesService, service } = createService();
    managedEntitiesService.listChats.mockResolvedValue(
      Array.from({ length: 501 }, (_, index) => ({
        id: `chat-${index}`,
        entityType: 'chat',
        title: `Чат ${index}`,
        avatarUrl: null,
        link: null,
      })),
    );
    managedEntitiesService.listChannels.mockResolvedValue([]);

    await expect(
      (service as any).resolveAudienceTargets(
        { userId: 'user-1', username: null, displayName: null },
        { selection: 'ALL_CHATS', mode: 'DYNAMIC', targets: [] },
      ),
    ).rejects.toThrow('не больше 500');
  });

  it('bounds live audience access verification concurrency', async () => {
    const { service, managedEntitiesService } = createService();
    managedEntitiesService.listChats.mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => ({
        id: `chat-${index}`,
        entityType: 'chat',
        title: `Чат ${index}`,
        avatarUrl: null,
        link: null,
      })),
    );
    managedEntitiesService.listChannels.mockResolvedValue([]);
    let activeChecks = 0;
    let maxActiveChecks = 0;
    managedEntitiesService.assertChatAdminAccess.mockImplementation(async () => {
      activeChecks += 1;
      maxActiveChecks = Math.max(maxActiveChecks, activeChecks);
      await new Promise<void>((resolve) => setImmediate(resolve));
      activeChecks -= 1;
    });

    await (service as any).resolveAudienceTargets(
      { userId: 'user-1', username: null, displayName: null },
      { selection: 'ALL_CHATS', mode: 'DYNAMIC', targets: [] },
    );

    expect(managedEntitiesService.assertChatAdminAccess).toHaveBeenCalledTimes(8);
    expect(maxActiveChecks).toBe(4);
  });
});
