import {
  ChatEntityType,
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  Prisma,
  PublicationContentFormat,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleMode,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import { BadRequestException } from '@nestjs/common';
import { PublicationContentService } from './publication-content.service';
import { PublicationPresenterService } from './publication-presenter.service';
import { PublicationService } from './publication.service';
import {
  PUBLICATION_MAX_VIDEO_BYTES,
  PUBLICATION_VIDEO_ASSET_ID_FIELD,
  PUBLICATION_VIDEO_INLINE_BASE64_FIELD,
} from './publication-video-media';

function createService(prismaOverrides: Record<string, unknown> = {}) {
  const prisma = {
    managedBroadcastDelivery: { groupBy: jest.fn().mockResolvedValue([]) },
    managedBroadcastCalendarReservation: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    ...prismaOverrides,
  };
  const contentService = new PublicationContentService(prisma as never);
  const presenter = new PublicationPresenterService(prisma as never);
  const service = new PublicationService(
    prisma as never,
    contentService,
    presenter,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { contentService, presenter, service, prisma };
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
    publicationMutationRecord: {
      create: jest.fn().mockResolvedValue({}),
    },
  };
}

describe('PublicationService', () => {
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
        .spyOn(contentService, 'persistContentRevision')
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
        .spyOn(contentService, 'persistContentRevision')
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
        where: { id: { in: ['occurrence-future'] } },
        data: { status: PublicationOccurrenceStatus.CANCELED },
      });
      expect(tx.managedBroadcast.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['broadcast-future'] } },
        data: {
          status: ManagedBroadcastStatus.CANCELED,
          nextSendAt: null,
          lockedAt: null,
          lockToken: null,
        },
      });
      expect(tx.managedBroadcast.findMany).toHaveBeenCalledWith({
        where: { publicationOccurrenceId: { in: ['occurrence-future'] } },
        select: { id: true },
      });
      expect(tx.managedBroadcast.updateMany.mock.calls[0]?.[0].data).not.toHaveProperty(
        'publicationOccurrenceId',
      );
      expect(deleteBroadcasts).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

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
        }),
      ],
    });
  });

  it('rolls an ambiguous delivery up without making it retryable', async () => {
    const update = jest.fn().mockResolvedValue({});
    const { presenter, service } = createService({
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occurrence-1',
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          scheduledAt: new Date('2026-07-10T10:00:00.000Z'),
          legacyBroadcasts: [
            {
              status: ManagedBroadcastStatus.FAILED,
              deliveries: [{ status: ManagedBroadcastDeliveryStatus.AMBIGUOUS }],
            },
          ],
        }),
        update,
      },
    });

    await (service as any).rollupOccurrence('occurrence-1');

    expect(update).toHaveBeenCalledWith({
      where: { id: 'occurrence-1' },
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
          legacyBroadcasts: { some: {} },
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

    await contentService.persistContentRevision(
      tx,
      'publication-1',
      2,
      {
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
      },
      'user-1',
    );

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
    const videoBytes = Buffer.from('uploaded-video');
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

    await contentService.persistContentRevision(tx, 'publication-1', 3, content, 'user-1');

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
      },
      data: { status: PublicationOccurrenceStatus.CANCELED },
    });
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
        findMany: jest.fn().mockResolvedValue([]),
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
        }),
      },
      publicationOccurrence: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'occurrence-1',
          publicationId: 'publication-1',
          scheduleId: 'schedule-1',
          scheduleRevision: 5,
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
        data: expect.objectContaining({ status: ManagedBroadcastDeliveryStatus.PENDING }),
      }),
    );
  });

  it('does not retry when the exact schedule revision is paused or terminal', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      publication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationSchedule: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      publicationOccurrence: { updateMany: jest.fn() },
      managedBroadcastDelivery: { updateMany: jest.fn() },
    };
    const { service } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          version: 7,
          lifecycle: PublicationLifecycle.ERROR,
        }),
      },
      publicationOccurrence: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'occurrence-1',
          publicationId: 'publication-1',
          scheduleId: 'schedule-1',
          scheduleRevision: 5,
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
      managedBroadcast: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
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
        }),
      },
      managedBroadcastDelivery: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'delivery-1',
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
          sentAt: null,
          remoteMessageId: null,
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
        publication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
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
          expect.objectContaining({ data: { lifecycle: expectedLifecycle } }),
        );
        expect(tx.publicationSchedule.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ data: { status: expectedScheduleStatus } }),
        );
      }
    },
  );

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
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW' }),
    });
    expect(reservationFindMany).not.toHaveBeenCalled();
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
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW' }),
    });
    expect(tx.managedBroadcast.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
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

  it('rejects an expanded ALL audience above the 500 target limit', async () => {
    const { service } = createService();
    (service as any).managedEntitiesService = {
      listChats: jest.fn().mockResolvedValue(
        Array.from({ length: 501 }, (_, index) => ({
          id: `chat-${index}`,
          entityType: 'chat',
          title: `Чат ${index}`,
          avatarUrl: null,
          link: null,
        })),
      ),
      listChannels: jest.fn().mockResolvedValue([]),
    };

    await expect(
      (service as any).resolveAudienceTargets(
        { userId: 'user-1', username: null, displayName: null },
        { selection: 'ALL_CHATS', mode: 'DYNAMIC', targets: [] },
      ),
    ).rejects.toThrow('не больше 500');
  });
});
