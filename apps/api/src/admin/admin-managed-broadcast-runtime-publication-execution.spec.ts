import {
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleMode,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import { AdminManagedBroadcastPublicationVerification } from './admin-managed-broadcast-publication-verification';
import { AdminManagedBroadcastRuntime } from './admin-managed-broadcast-runtime';

describe('AdminManagedBroadcastRuntime publication execution guard', () => {
  it('persists a MAX send response for another chat as ambiguous', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: { managedBroadcastDelivery: { updateMany } },
      logger: { warn: jest.fn() },
    } as never);
    const sentMessage = {
      messageId: 'mid-1',
      url: null,
      chatId: 'chat-other',
    };

    expect(verification.findResponseTargetMismatch('chat-expected', sentMessage)).toContain(
      'chat-other вместо chat-expected',
    );
    await expect(
      verification.persistResponseTargetMismatch({
        broadcastId: 'broadcast-1',
        occurrenceIndex: 1,
        delivery: { id: 'delivery-1', targetChatId: 'chat-expected' },
        deliveryLockToken: 'lock-1',
        resolvedBotId: 'bot-1',
        sentMessage,
        sentAt: new Date('2026-07-25T08:00:00.000Z'),
      }),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
          remoteMessageId: 'mid-1',
        }),
      }),
    );
    expect(
      verification.findResponseTargetMismatch('chat-expected', {
        messageId: 'mid-2',
        url: null,
        chatId: 'chat-expected',
      }),
    ).toBeNull();
  });

  it.each([
    {
      label: 'confirmed present',
      presence: 'present',
      expectedStatus: null,
    },
    {
      label: 'explicitly absent',
      presence: 'absent',
      expectedStatus: ManagedBroadcastDeliveryStatus.FAILED,
    },
    {
      label: 'bare 404',
      presence: new Error('MAX API request failed with HTTP 404 (not.found)'),
      expectedStatus: 'DEFERRED',
    },
    {
      label: 'transient lookup failure',
      presence: new Error('MAX API request failed with HTTP 503'),
      expectedStatus: 'DEFERRED',
    },
  ])(
    'records publication post-send verification when the message is $label',
    async ({ presence, expectedStatus }) => {
      const delivery = {
        id: 'delivery-verify',
        targetChatId: 'chat-1',
        botId: 'bot-1',
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date('2026-07-25T08:00:00.000Z'),
        remoteMessageId: 'mid-verify',
        remoteMessageVerifiedAt: null,
      };
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const getExactMessagePresences = jest.fn().mockResolvedValue([
        presence instanceof Error
          ? {
              chatId: delivery.targetChatId,
              messageId: delivery.remoteMessageId,
              error: presence,
            }
          : {
              chatId: delivery.targetChatId,
              messageId: delivery.remoteMessageId,
              presence,
            },
      ]);
      const logger = { warn: jest.fn() };
      const verification = new AdminManagedBroadcastPublicationVerification({
        prisma: {
          managedBroadcastDelivery: {
            findMany: jest.fn().mockResolvedValue([delivery]),
            updateMany,
          },
        },
        maxClient: { getExactMessagePresences },
        logger,
      } as never);

      const result = await verification.verifyAfterSend(
        { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockResolvedValue(undefined),
      );

      expect(getExactMessagePresences).toHaveBeenCalledWith(
        [{ chatId: 'chat-1', messageId: 'mid-verify' }],
        expect.objectContaining({
          botId: 'bot-1',
          bypassCache: true,
          ignoreFailureMetricStatuses: [404],
        }),
      );
      if (expectedStatus === null) {
        expect(result).toEqual(new Set());
        expect(updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              remoteMessageVerifiedAt: expect.any(Date),
              lastError: null,
            }),
          }),
        );
        expect(logger.warn).not.toHaveBeenCalled();
      } else if (expectedStatus === 'DEFERRED') {
        expect(result).toEqual(new Set());
        expect(updateMany).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ verificationStatus: 'DEFERRED' }),
          expect.stringContaining('deferred'),
        );
      } else {
        expect(result).toEqual(new Set(['chat-1']));
        expect(updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: expectedStatus }),
          }),
        );
        expect(logger.warn).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('keeps an entire bot batch sent and unverified after a transient lookup failure', async () => {
    const deliveries = ['mid-1', 'mid-2'].map((remoteMessageId, index) => ({
      id: `delivery-${index + 1}`,
      targetChatId: `chat-${index + 1}`,
      botId: 'bot-1',
      status: ManagedBroadcastDeliveryStatus.SENT,
      sentAt: new Date('2026-07-25T08:00:00.000Z'),
      remoteMessageId,
      remoteMessageVerifiedAt: null,
    }));
    const updateMany = jest.fn();
    const getExactMessagePresences = jest.fn().mockResolvedValue(
      deliveries.map((delivery) => ({
        chatId: delivery.targetChatId,
        messageId: delivery.remoteMessageId,
        error: new Error('MAX API request failed with HTTP 503'),
      })),
    );
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue(deliveries),
          updateMany,
        },
      },
      maxClient: { getExactMessagePresences },
      logger: { warn: jest.fn() },
    } as never);

    await expect(
      verification.verifyAfterSend(
        { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toEqual(new Set());
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('does not attribute one chat verification result to another target with the same message id', async () => {
    const deliveries = [
      {
        id: 'delivery-1',
        targetChatId: 'chat-1',
        botId: 'bot-1',
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date('2026-07-25T08:00:00.000Z'),
        remoteMessageId: 'mid-shared',
        remoteMessageVerifiedAt: null,
      },
      {
        id: 'delivery-2',
        targetChatId: 'chat-2',
        botId: 'bot-1',
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date('2026-07-25T08:00:01.000Z'),
        remoteMessageId: 'mid-shared',
        remoteMessageVerifiedAt: null,
      },
    ];
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue(deliveries),
          updateMany,
        },
      },
      maxClient: {
        getExactMessagePresences: jest.fn().mockResolvedValue([
          { chatId: 'chat-1', messageId: 'mid-shared', presence: 'present' },
          {
            chatId: 'chat-2',
            messageId: 'mid-shared',
            error: new Error('MAX returned another recipient'),
          },
        ]),
      },
      logger: { warn: jest.fn() },
    } as never);

    await expect(
      verification.verifyAfterSend(
        { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toEqual(new Set());

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'delivery-1' }) }),
    );
  });

  it('batches ready publication verification by bot', async () => {
    const deliveries = [
      {
        id: 'delivery-1',
        targetChatId: 'chat-1',
        botId: 'bot-1',
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date('2026-07-25T08:00:00.000Z'),
        remoteMessageId: 'mid-1',
        remoteMessageVerifiedAt: null,
      },
      {
        id: 'delivery-2',
        targetChatId: 'chat-2',
        botId: 'bot-1',
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date('2026-07-25T08:00:01.000Z'),
        remoteMessageId: 'mid-2',
        remoteMessageVerifiedAt: null,
      },
      {
        id: 'delivery-3',
        targetChatId: 'chat-3',
        botId: 'bot-2',
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date('2026-07-25T08:00:02.000Z'),
        remoteMessageId: 'mid-3',
        remoteMessageVerifiedAt: null,
      },
    ];
    const getExactMessagePresences = jest
      .fn()
      .mockImplementation(async (requests: Array<{ chatId: string; messageId: string }>) =>
        requests.map((request) => ({ ...request, presence: 'present' })),
      );
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue(deliveries),
          updateMany,
        },
      },
      maxClient: { getExactMessagePresences },
      logger: { warn: jest.fn() },
    } as never);

    await expect(
      verification.verifyAfterSend(
        { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toEqual(new Set());

    expect(getExactMessagePresences).toHaveBeenCalledTimes(2);
    expect(getExactMessagePresences).toHaveBeenNthCalledWith(
      1,
      [
        { chatId: 'chat-1', messageId: 'mid-1' },
        { chatId: 'chat-2', messageId: 'mid-2' },
      ],
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(getExactMessagePresences).toHaveBeenNthCalledWith(
      2,
      [{ chatId: 'chat-3', messageId: 'mid-3' }],
      expect.objectContaining({ botId: 'bot-2' }),
    );
    expect(updateMany).toHaveBeenCalledTimes(3);
  });

  it('does not wait inside the delivery loop for a recently sent publication', async () => {
    const getExactMessagePresences = jest.fn();
    const updateMany = jest.fn();
    const onProgress = jest.fn().mockResolvedValue(undefined);
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'delivery-recent',
              targetChatId: 'chat-1',
              botId: 'bot-1',
              status: ManagedBroadcastDeliveryStatus.SENT,
              sentAt: new Date(),
              remoteMessageId: 'mid-recent',
              remoteMessageVerifiedAt: null,
            },
          ]),
          updateMany,
        },
      },
      maxClient: { getExactMessagePresences },
      logger: { warn: jest.fn() },
    } as never);

    await expect(
      verification.verifyAfterSend(
        { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        onProgress,
      ),
    ).resolves.toEqual(new Set());

    expect(getExactMessagePresences).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('restores publication attribution when recovering missing delivery rows', async () => {
    const recoveredDelivery = {
      id: 'delivery-recovered',
      broadcastId: 'broadcast-1',
      occurrenceIndex: 1,
      targetChatId: 'chat-1',
      status: ManagedBroadcastDeliveryStatus.PENDING,
      publicationOccurrenceId: 'occurrence-1',
      contentRevisionId: 'content-1',
    };
    const createMany = jest.fn().mockResolvedValue({ count: 1 });
    const findMany = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([recoveredDelivery]);
    const prisma = {
      managedBroadcastDelivery: {
        count: jest.fn().mockResolvedValue(0),
        createMany,
        findMany,
      },
    };
    const runtime = new AdminManagedBroadcastRuntime({ prisma } as never);

    await expect(
      (runtime as any).ensureManagedBroadcastDeliveryRows(
        {
          id: 'broadcast-1',
          cycleCount: 1,
          publicationOccurrenceId: 'occurrence-1',
          publicationContentRevisionId: 'content-1',
        },
        1,
        ['chat-1'],
        [],
      ),
    ).resolves.toEqual([recoveredDelivery]);

    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: ManagedBroadcastDeliveryStatus.PENDING,
          publicationOccurrenceId: 'occurrence-1',
          contentRevisionId: 'content-1',
        },
      ],
      skipDuplicates: true,
    });
  });

  it('delivers exact due NOW envelopes through the explicit immediate entry point', async () => {
    const managedBroadcast = {
      findMany: jest.fn().mockResolvedValue([{ id: 'broadcast-now' }]),
    };
    const context = {
      prisma: { managedBroadcast },
      logger: { log: jest.fn(), warn: jest.fn() },
    };
    const runtime = new AdminManagedBroadcastRuntime(context as never);
    const processSpy = jest
      .spyOn(runtime as any, 'processManagedBroadcastOccurrence')
      .mockResolvedValue(undefined);

    await runtime.processDueImmediatePublicationBroadcasts();

    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(processSpy).toHaveBeenCalledWith('broadcast-now', 'immediate', expect.any(Date), [
      ManagedBroadcastStatus.ACTIVE,
    ]);
    expect(managedBroadcast.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: expect.arrayContaining([
            { status: ManagedBroadcastStatus.ACTIVE },
            {
              publicationOccurrence: {
                is: {
                  schedule: {
                    is: {
                      mode: PublicationScheduleMode.NOW,
                    },
                  },
                },
              },
            },
            {
              deliveries: {
                some: {},
              },
            },
          ]),
        },
      }),
    );
  });

  it('delivers exact due scheduled publication envelopes through the deadline entry point', async () => {
    const managedBroadcast = {
      findMany: jest.fn().mockResolvedValue([{ id: 'broadcast-once' }]),
    };
    const context = {
      prisma: { managedBroadcast },
      logger: { log: jest.fn(), warn: jest.fn() },
    };
    const runtime = new AdminManagedBroadcastRuntime(context as never);
    const processSpy = jest
      .spyOn(runtime as any, 'processManagedBroadcastOccurrence')
      .mockResolvedValue(undefined);

    await runtime.processDueDeadlinePublicationBroadcasts(7);

    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(processSpy).toHaveBeenCalledWith('broadcast-once', 'deadline', expect.any(Date), [
      ManagedBroadcastStatus.ACTIVE,
    ]);
    expect(managedBroadcast.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 7,
        where: {
          AND: expect.arrayContaining([
            { status: ManagedBroadcastStatus.ACTIVE },
            {
              publicationOccurrence: {
                is: {
                  schedule: {
                    is: {
                      mode: {
                        in: [
                          PublicationScheduleMode.ONCE,
                          PublicationScheduleMode.SLOTS,
                          PublicationScheduleMode.RECURRENCE,
                        ],
                      },
                    },
                  },
                },
              },
            },
            { deliveries: { some: {} } },
          ]),
        },
      }),
    );
  });

  it('keeps publication envelopes out of the legacy runner entry point', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: { managedBroadcast: { findMany } },
      backgroundRuntimeGovernorService: {
        decide: jest.fn().mockResolvedValue({
          action: 'run',
          reason: 'background headroom available',
          retryAfterMs: 0,
        }),
      },
      logger: { log: jest.fn(), warn: jest.fn() },
    } as never);
    const immediateSpy = jest.spyOn(runtime, 'processDueImmediatePublicationBroadcasts');
    const deadlineSpy = jest.spyOn(runtime, 'processDueDeadlinePublicationBroadcasts');

    await runtime.processDueManagedBroadcasts('scheduled');

    expect(immediateSpy).not.toHaveBeenCalled();
    expect(deadlineSpy).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(
      findMany.mock.calls.every(([query]) => query.where?.publicationOccurrenceId === null),
    ).toBe(true);
  });

  it('does not revisit a due legacy broadcast within the same runner invocation', async () => {
    const findMany = jest.fn().mockImplementation(async ({ where }: any) => {
      if (where?.status === ManagedBroadcastStatus.ACTIVE) {
        return where.id?.notIn?.includes('broadcast-1') ? [] : [{ id: 'broadcast-1' }];
      }
      return [];
    });
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: { managedBroadcast: { findMany } },
      backgroundRuntimeGovernorService: {
        decide: jest.fn().mockResolvedValue({
          action: 'run',
          reason: 'background headroom available',
          retryAfterMs: 0,
        }),
      },
      logger: { log: jest.fn(), warn: jest.fn() },
    } as never);
    const processSpy = jest
      .spyOn(runtime as any, 'processManagedBroadcastOccurrence')
      .mockResolvedValue(undefined);

    await runtime.processDueManagedBroadcasts('scheduled');

    expect(findMany).toHaveBeenCalledTimes(4);
    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(processSpy).toHaveBeenCalledWith('broadcast-1', 'scheduled', expect.any(Date), [
      ManagedBroadcastStatus.ACTIVE,
      ManagedBroadcastStatus.PARTIAL,
      ManagedBroadcastStatus.FAILED,
    ]);
    const activeQueries = findMany.mock.calls
      .map(([query]) => query)
      .filter((query) => query.where?.status === ManagedBroadcastStatus.ACTIVE);
    expect(activeQueries).toHaveLength(2);
    expect(activeQueries[0]?.where?.id).toBeUndefined();
    expect(activeQueries[1]?.where?.id).toEqual({ notIn: ['broadcast-1'] });
    expect(activeQueries.every((query) => query.where?.publicationOccurrenceId === null)).toBe(
      true,
    );
    const retryQueries = findMany.mock.calls
      .map(([query]) => query)
      .filter((query) => Array.isArray(query.where?.status?.in));
    expect(retryQueries).toHaveLength(2);
    expect(retryQueries.every((query) => query.where?.publicationOccurrenceId === null)).toBe(true);
  });

  it('limits one automatic publication envelope pass to four deliveries', async () => {
    const nextSendAt = new Date('2026-07-12T10:00:00.000Z');
    const row = {
      id: 'broadcast-deadline',
      sourceChatId: 'chat-source',
      entityType: 'CHAT',
      actorUserId: 'admin-1',
      text: 'Publication',
      textFormat: 'plain',
      applyToAllChats: false,
      targetChatIds: ['chat-1', 'chat-2', 'chat-3', 'chat-4', 'chat-5'],
      buttons: [],
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Open',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      mediaType: null,
      mediaPayload: null,
      mediaMimeType: '',
      mediaFileName: '',
      scheduleMode: 'calendar',
      scheduleTimezone: 'Europe/Moscow',
      nextSendAt,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 1,
      sentCount: 0,
      status: ManagedBroadcastStatus.ACTIVE,
      lastError: null,
      lockedAt: null,
      lockToken: null,
      publicationOccurrenceId: 'occurrence-1',
      publicationContentRevisionId: 'content-1',
    };
    const deliveries = row.targetChatIds.map((targetChatId, index) => ({
      id: `delivery-${index + 1}`,
      broadcastId: row.id,
      occurrenceIndex: 1,
      targetChatId,
      status: ManagedBroadcastDeliveryStatus.PENDING,
      attemptCount: 0,
      remoteMessageId: null,
      lastError: null,
      sentAt: null,
      lockedAt: null,
      lockToken: null,
    }));
    const prisma = {
      managedBroadcast: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(row),
      },
      managedBroadcastDelivery: {
        findMany: jest.fn().mockResolvedValue(deliveries),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const runtime = new AdminManagedBroadcastRuntime({
      prisma,
      logger: { log: jest.fn(), warn: jest.fn() },
    } as never);
    jest
      .spyOn(runtime as any, 'ensureManagedBroadcastPublicationExecutionActive')
      .mockResolvedValue(true);
    jest
      .spyOn(runtime as any, 'reconcileStaleManagedBroadcastDeliveries')
      .mockResolvedValue(undefined);
    jest
      .spyOn(runtime as any, 'deferManagedBroadcastOccurrenceWithFreshSendingDeliveries')
      .mockResolvedValue(false);
    jest.spyOn(runtime as any, 'resolveManagedBroadcastTargetsFromRow').mockReturnValue({
      targetMode: 'selected',
      targetChatIds: row.targetChatIds,
    });
    jest.spyOn(runtime as any, 'ensureManagedBroadcastDeliveryRows').mockResolvedValue(deliveries);
    jest
      .spyOn((runtime as any).mediaRuntime, 'loadManagedBroadcastRequestMedia')
      .mockResolvedValue({});
    jest.spyOn((runtime as any).mediaRuntime, 'resolveManagedBroadcastMedia').mockResolvedValue({});
    jest.spyOn(runtime as any, 'resolveDeliveryBotAssignment').mockResolvedValue('bot-1');
    jest.spyOn(runtime as any, 'buildManagedBroadcastMessage').mockResolvedValue({
      messageText: 'Publication',
      messageOptions: {},
      commentDialogReference: null,
    });
    jest
      .spyOn(runtime as any, 'heartbeatManagedBroadcastProcessingLock')
      .mockResolvedValue(undefined);
    jest
      .spyOn(runtime as any, 'recordManagedBroadcastCommentDialogReference')
      .mockResolvedValue(undefined);
    jest
      .spyOn((runtime as any).publicationVerification, 'persistResponseTargetMismatch')
      .mockResolvedValue(null);
    jest
      .spyOn((runtime as any).publicationVerification, 'verifyAfterSend')
      .mockResolvedValue(new Set());
    const sendSpy = jest
      .spyOn(runtime as any, 'sendManagedBroadcastMessageImmediateWithId')
      .mockImplementation(async (...args: unknown[]) => ({
        messageId: `message-${String(args[0])}`,
        url: null,
      }));
    const finalizeSpy = jest
      .spyOn(runtime as any, 'finalizeManagedBroadcastOccurrence')
      .mockResolvedValue({
        status: ManagedBroadcastStatus.ACTIVE,
        currentOccurrence: 1,
        sentChatIds: row.targetChatIds.slice(0, 4),
        failedChatIds: [],
        pendingChatIds: ['chat-5'],
        canRetry: false,
        firstSendError: null,
        nextSendAt,
      });

    await (runtime as any).processManagedBroadcastOccurrence(
      row.id,
      'deadline',
      new Date('2026-07-12T09:55:00.000Z'),
      [ManagedBroadcastStatus.ACTIVE],
    );

    expect(sendSpy).toHaveBeenCalledTimes(4);
    expect(sendSpy.mock.calls.map((call) => call[0])).toEqual([
      'chat-1',
      'chat-2',
      'chat-3',
      'chat-4',
    ]);
    expect(sendSpy.mock.calls[0]?.[4]).toEqual(
      expect.objectContaining({ trafficClass: 'background', sourceTag: 'managed_broadcast' }),
    );
    expect(finalizeSpy).toHaveBeenCalledTimes(1);
  });

  it('defers a deadline delivery when MAX capacity rejects it before dispatch', async () => {
    const nextSendAt = new Date('2026-07-12T10:00:00.000Z');
    const row = {
      id: 'broadcast-deadline',
      sourceChatId: 'chat-source',
      entityType: 'CHAT',
      actorUserId: 'admin-1',
      text: 'Publication',
      textFormat: 'plain',
      applyToAllChats: false,
      targetChatIds: ['chat-1', 'chat-2'],
      buttons: [],
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Open',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      mediaType: null,
      mediaPayload: null,
      mediaMimeType: '',
      mediaFileName: '',
      scheduleMode: 'calendar',
      scheduleTimezone: 'Europe/Moscow',
      nextSendAt,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 1,
      sentCount: 0,
      status: ManagedBroadcastStatus.ACTIVE,
      lastError: null,
      lockedAt: null,
      lockToken: null,
      publicationOccurrenceId: 'occurrence-1',
      publicationContentRevisionId: 'content-1',
    };
    const deliveries = ['chat-1', 'chat-2'].map((targetChatId, index) => ({
      id: `delivery-${index + 1}`,
      broadcastId: row.id,
      occurrenceIndex: 1,
      targetChatId,
      status: ManagedBroadcastDeliveryStatus.PENDING,
      attemptCount: 0,
      remoteMessageId: null,
      lastError: null,
      sentAt: null,
      lockedAt: null,
      lockToken: null,
    }));
    const capacityError = Object.assign(new Error('MAX API background rate limit exceeded'), {
      code: 'MAX_API_INTERNAL_RATE_LIMIT',
      preDispatch: true,
      retryAfterMs: 250,
    });
    const publish = jest.fn().mockImplementation(async (request: any) => {
      request.onDispatchAttempt?.({ botId: 'bot-1', job: {} });
      throw capacityError;
    });
    const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedBroadcast: {
          updateMany: broadcastUpdateMany,
          findUnique: jest.fn().mockResolvedValue(row),
        },
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue(deliveries),
          updateMany: deliveryUpdateMany,
        },
        managedBroadcastOccurrence: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      },
      maxRoutedPublicationService: { publish },
      logger: { log: jest.fn(), warn: jest.fn() },
    } as never);
    jest
      .spyOn(runtime as any, 'ensureManagedBroadcastPublicationExecutionActive')
      .mockResolvedValue(true);
    jest
      .spyOn(runtime as any, 'reconcileStaleManagedBroadcastDeliveries')
      .mockResolvedValue(undefined);
    jest
      .spyOn(runtime as any, 'deferManagedBroadcastOccurrenceWithFreshSendingDeliveries')
      .mockResolvedValue(false);
    jest.spyOn(runtime as any, 'resolveManagedBroadcastTargetsFromRow').mockReturnValue({
      targetMode: 'selected',
      targetChatIds: ['chat-1', 'chat-2'],
    });
    jest.spyOn(runtime as any, 'ensureManagedBroadcastDeliveryRows').mockResolvedValue(deliveries);
    jest
      .spyOn((runtime as any).mediaRuntime, 'loadManagedBroadcastRequestMedia')
      .mockResolvedValue({});
    jest
      .spyOn((runtime as any).publicationVerification, 'verifyAfterSend')
      .mockResolvedValue(new Set());
    jest
      .spyOn(runtime as any, 'heartbeatManagedBroadcastProcessingLock')
      .mockResolvedValue(undefined);
    jest.spyOn(runtime as any, 'resolveManagedBroadcastSendRetryDelayMs').mockReturnValue(null);

    const result = await (runtime as any).processManagedBroadcastOccurrence(
      row.id,
      'deadline',
      new Date('2026-07-12T09:55:00.000Z'),
      [ManagedBroadcastStatus.ACTIVE],
    );

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        logicalIdempotencyKey:
          'managed-broadcast:send:broadcast-deadline:occurrence:1:target:chat-1:content:publication-content-1',
        trafficClass: 'background',
      }),
    );
    expect(capacityError).toMatchObject({ managedBroadcastSendStarted: false });
    expect(deliveryUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'delivery-1',
        status: ManagedBroadcastDeliveryStatus.SENDING,
        lockToken: expect.any(String),
        attemptCount: { gt: 0 },
      },
      data: expect.objectContaining({
        status: ManagedBroadcastDeliveryStatus.PENDING,
        attemptCount: { decrement: 1 },
        botId: null,
        remoteMessageId: null,
        lockedAt: null,
        lockToken: null,
        lastError: null,
      }),
    });
    expect(
      deliveryUpdateMany.mock.calls.some(
        ([query]) => query.data?.status === ManagedBroadcastDeliveryStatus.FAILED,
      ),
    ).toBe(false);
    expect(broadcastUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ManagedBroadcastStatus.ACTIVE,
          lastError: null,
          lockedAt: null,
          lockToken: null,
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: ManagedBroadcastStatus.ACTIVE,
        failedChatIds: [],
        pendingChatIds: ['chat-1', 'chat-2'],
        canRetry: false,
      }),
    );
  });

  it('rotates an unfinished deadline envelope behind older due work', async () => {
    const now = new Date('2026-07-12T10:05:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    try {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const runtime = new AdminManagedBroadcastRuntime({
        prisma: {
          managedBroadcastDelivery: {
            findMany: jest.fn().mockResolvedValue([
              {
                status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                targetChatId: 'chat-1',
              },
              {
                status: ManagedBroadcastDeliveryStatus.PENDING,
                targetChatId: 'chat-2',
              },
            ]),
          },
          managedBroadcast: { updateMany },
          managedBroadcastOccurrence: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
        },
      } as never);

      const result = await (runtime as any).finalizeManagedBroadcastOccurrence(
        {
          id: 'broadcast-1',
          scheduleMode: 'calendar',
          nextSendAt: new Date('2026-07-12T10:00:00.000Z'),
          publicationOccurrenceId: 'occurrence-1',
        },
        1,
        [],
        [],
        null,
      );

      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ManagedBroadcastStatus.ACTIVE,
            nextSendAt: now,
          }),
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          status: ManagedBroadcastStatus.ACTIVE,
          failedChatIds: ['chat-1'],
          pendingChatIds: ['chat-2'],
          nextSendAt: now,
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('finalizes an ambiguous NOW recovery envelope without dispatching it again', async () => {
    const nextSendAt = new Date('2026-07-12T10:00:00.000Z');
    const row = {
      id: 'broadcast-now',
      sourceChatId: 'chat-1',
      entityType: 'CHAT',
      actorUserId: 'admin-1',
      text: 'Publication',
      textFormat: 'plain',
      applyToAllChats: false,
      targetChatIds: ['chat-1'],
      buttons: [],
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Open',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      mediaType: null,
      mediaPayload: null,
      mediaMimeType: '',
      mediaFileName: '',
      scheduleMode: 'calendar',
      scheduleTimezone: 'Europe/Moscow',
      nextSendAt,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 1,
      sentCount: 0,
      status: ManagedBroadcastStatus.ACTIVE,
      lastError: null,
      lockedAt: null,
      lockToken: null,
      publicationOccurrenceId: 'occurrence-1',
      publicationContentRevisionId: 'content-1',
    };
    const ambiguousDelivery = {
      id: 'delivery-1',
      broadcastId: row.id,
      occurrenceIndex: 1,
      targetChatId: 'chat-1',
      status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
      attemptCount: 1,
      remoteMessageId: null,
      lastError: 'timeout',
      sentAt: null,
      lockedAt: null,
      lockToken: null,
    };
    const prisma = {
      managedBroadcast: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(row),
      },
      managedBroadcastDelivery: {
        findMany: jest.fn().mockResolvedValue([ambiguousDelivery]),
      },
    };
    const runtime = new AdminManagedBroadcastRuntime({ prisma } as never);
    jest
      .spyOn(runtime as any, 'ensureManagedBroadcastPublicationExecutionActive')
      .mockResolvedValue(true);
    jest
      .spyOn(runtime as any, 'reconcileStaleManagedBroadcastDeliveries')
      .mockResolvedValue(undefined);
    jest
      .spyOn(runtime as any, 'deferManagedBroadcastOccurrenceWithFreshSendingDeliveries')
      .mockResolvedValue(false);
    jest.spyOn(runtime as any, 'resolveManagedBroadcastTargetsFromRow').mockReturnValue({
      targetMode: 'selected',
      targetChatIds: ['chat-1'],
    });
    jest
      .spyOn(runtime as any, 'ensureManagedBroadcastDeliveryRows')
      .mockResolvedValue([ambiguousDelivery]);
    jest
      .spyOn((runtime as any).mediaRuntime, 'loadManagedBroadcastRequestMedia')
      .mockResolvedValue({});
    const finalizeSpy = jest
      .spyOn(runtime as any, 'finalizeManagedBroadcastOccurrence')
      .mockResolvedValue({
        status: ManagedBroadcastStatus.FAILED,
        currentOccurrence: 1,
        sentChatIds: [],
        failedChatIds: ['chat-1'],
        pendingChatIds: [],
        canRetry: false,
        firstSendError: null,
        nextSendAt,
      });
    const sendSpy = jest
      .spyOn(runtime as any, 'sendManagedBroadcastMessageImmediateWithId')
      .mockResolvedValue({ messageId: 'duplicate', url: null });

    const result = await (runtime as any).processManagedBroadcastOccurrence(
      row.id,
      'immediate',
      new Date('2026-07-12T09:55:00.000Z'),
      [ManagedBroadcastStatus.ACTIVE],
    );

    expect(sendSpy).not.toHaveBeenCalled();
    expect(finalizeSpy).toHaveBeenCalledWith(row, 1, [], [], null, expect.any(Object));
    expect(result).toEqual(expect.objectContaining({ status: ManagedBroadcastStatus.FAILED }));
  });

  it('recovers a pre-deploy routed send that crashed before delivery persistence', async () => {
    const deliveryLockedAt = new Date('2026-07-12T09:55:00.000Z');
    const completedAt = new Date('2026-07-12T09:55:01.000Z');
    const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const ledgerFindMany = jest.fn().mockResolvedValue([
      {
        jobId:
          'managed-broadcast:send:broadcast-1:occurrence:1:target:chat-1:content:publication-content-1',
        remoteMessageId: 'mid-after-crash',
        dispatchToken: 'dispatch-1',
        dispatchStartedAt: completedAt,
        dispatchBotId: 'bot-1',
        lastAttemptAt: completedAt,
        ambiguous: false,
        terminal: true,
        lastError: null,
        completedAt,
        metadata: null,
      },
    ]);
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedBroadcast: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'broadcast-1',
            actorUserId: 'admin-1',
            text: 'Publication',
            publicationContentRevisionId: 'content-1',
          }),
        },
        managedBroadcastDelivery: {
          updateMany: deliveryUpdateMany,
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'delivery-1',
              targetChatId: 'chat-1',
              botId: null,
              attemptCount: 2,
              lockedAt: deliveryLockedAt,
            },
          ]),
        },
        maxActionLedgerEntry: { findMany: ledgerFindMany },
      },
      maxRoutedPublicationService: {},
    } as never);
    const sendSpy = jest.spyOn(runtime as any, 'sendManagedBroadcastMessageImmediateWithId');

    await (runtime as any).reconcileStaleManagedBroadcastDeliveries(
      'broadcast-1',
      1,
      new Date('2026-07-12T10:00:00.000Z'),
    );

    expect(ledgerFindMany).toHaveBeenCalledWith({
      where: {
        jobId: {
          in: [
            'managed-broadcast:send:broadcast-1:occurrence:1:target:chat-1:content:publication-content-1:attempt:2',
            'managed-broadcast:send:broadcast-1:occurrence:1:target:chat-1:content:publication-content-1',
          ],
        },
      },
      select: expect.any(Object),
    });
    expect(deliveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'delivery-1',
          status: ManagedBroadcastDeliveryStatus.SENDING,
          remoteMessageId: null,
        }),
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.SENT,
          botId: 'bot-1',
          remoteMessageId: 'mid-after-crash',
          sentAt: completedAt,
        }),
      }),
    );
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('fails closed before the legacy direct broadcast path can run in production', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const runtime = new AdminManagedBroadcastRuntime({} as never);

    try {
      await expect(
        (runtime as any).sendManagedBroadcastViaQueue(
          'chat-1',
          { userId: 'admin-1' },
          {},
          'chat',
          'miniapp',
        ),
      ).rejects.toThrow('Legacy direct managed broadcast dispatch is disabled in production');
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it.each([PublicationLifecycle.PAUSED, PublicationLifecycle.CANCELED])(
    'deletes an unsent envelope when its publication becomes %s',
    async (lifecycle) => {
      const tx = {
        managedBroadcastDelivery: { count: jest.fn().mockResolvedValue(0) },
        managedBroadcast: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
      const prisma = {
        publicationOccurrence: {
          findUnique: jest.fn().mockResolvedValue({
            status: PublicationOccurrenceStatus.IN_PROGRESS,
            scheduleRevision: 2,
            contentRevisionId: 'content-1',
            publication: { lifecycle },
            schedule: { revision: 2, status: PublicationScheduleStatus.ACTIVE },
          }),
        },
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      };
      const runtime = new AdminManagedBroadcastRuntime({ prisma } as never);

      await expect(
        (runtime as any).ensureManagedBroadcastPublicationExecutionActive(
          {
            id: 'broadcast-1',
            publicationOccurrenceId: 'occurrence-1',
            publicationContentRevisionId: 'content-1',
            sentCount: 0,
          },
          1,
        ),
      ).resolves.toBe(false);

      expect(tx.managedBroadcast.deleteMany).toHaveBeenCalledWith({
        where: { id: 'broadcast-1' },
      });
    },
  );

  it('releases a stale worker after content edit without resetting a newer SENDING delivery', async () => {
    const deliveryUpdateMany = jest.fn();
    const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          scheduleRevision: 2,
          contentRevisionId: 'content-new',
          publication: { lifecycle: PublicationLifecycle.ACTIVE },
          schedule: { revision: 2, status: PublicationScheduleStatus.ACTIVE },
        }),
      },
      managedBroadcastDelivery: { updateMany: deliveryUpdateMany },
      managedBroadcast: { updateMany: broadcastUpdateMany },
      $transaction: jest.fn(),
    };
    const runtime = new AdminManagedBroadcastRuntime({ prisma } as never);

    await expect(
      (runtime as any).ensureManagedBroadcastPublicationExecutionActive(
        {
          id: 'broadcast-1',
          publicationOccurrenceId: 'occurrence-1',
          publicationContentRevisionId: 'content-old',
          sentCount: 0,
          lockToken: 'lease-1',
        },
        1,
      ),
    ).resolves.toBe(false);

    expect(deliveryUpdateMany).not.toHaveBeenCalled();
    expect(broadcastUpdateMany).toHaveBeenCalledWith({
      where: { id: 'broadcast-1', lockToken: 'lease-1' },
      data: { lockedAt: null, lockToken: null },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'all canceled',
      deliveries: [
        { status: ManagedBroadcastDeliveryStatus.CANCELED, targetChatId: 'chat-1' },
        { status: ManagedBroadcastDeliveryStatus.CANCELED, targetChatId: 'chat-2' },
      ],
      expectedStatus: ManagedBroadcastStatus.FAILED,
      expectedSentChatIds: [],
      expectedFailedChatIds: ['chat-1', 'chat-2'],
      expectedCanRetry: false,
    },
    {
      label: 'sent and canceled',
      deliveries: [
        { status: ManagedBroadcastDeliveryStatus.SENT, targetChatId: 'chat-1' },
        { status: ManagedBroadcastDeliveryStatus.CANCELED, targetChatId: 'chat-2' },
      ],
      expectedStatus: ManagedBroadcastStatus.PARTIAL,
      expectedSentChatIds: ['chat-1'],
      expectedFailedChatIds: ['chat-2'],
      expectedCanRetry: false,
    },
    {
      label: 'failed and canceled',
      deliveries: [
        { status: ManagedBroadcastDeliveryStatus.FAILED, targetChatId: 'chat-1' },
        { status: ManagedBroadcastDeliveryStatus.CANCELED, targetChatId: 'chat-2' },
      ],
      expectedStatus: ManagedBroadcastStatus.FAILED,
      expectedSentChatIds: [],
      expectedFailedChatIds: ['chat-1', 'chat-2'],
      expectedCanRetry: true,
    },
  ])(
    'treats $label deliveries as terminal undelivered with retry based only on real failures',
    async ({
      deliveries,
      expectedStatus,
      expectedSentChatIds,
      expectedFailedChatIds,
      expectedCanRetry,
    }) => {
      const prisma = {
        managedBroadcastDelivery: { findMany: jest.fn().mockResolvedValue(deliveries) },
        managedBroadcast: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        managedBroadcastOccurrence: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
      const runtime = new AdminManagedBroadcastRuntime({ prisma } as never);
      const row = {
        id: 'broadcast-1',
        scheduleMode: 'calendar',
        nextSendAt: new Date('2026-07-12T10:00:00.000Z'),
        publicationOccurrenceId: 'occurrence-1',
      };

      const result = await (runtime as any).finalizeManagedBroadcastOccurrence(
        row,
        1,
        [],
        [],
        null,
      );

      expect(result).toEqual(
        expect.objectContaining({
          status: expectedStatus,
          sentChatIds: expectedSentChatIds,
          failedChatIds: expectedFailedChatIds,
          pendingChatIds: [],
          canRetry: expectedCanRetry,
        }),
      );
      expect(prisma.managedBroadcast.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: expectedStatus }),
        }),
      );
      expect(prisma.managedBroadcast.updateMany.mock.calls[0]?.[0]?.data).not.toHaveProperty(
        'sentCount',
      );
      expect(prisma.managedBroadcastOccurrence.updateMany).toHaveBeenCalledWith({
        where: { broadcastId: 'broadcast-1', occurrenceIndex: 1 },
        data: { status: expectedStatus },
      });
    },
  );

  it('keeps legacy canceled-target completion semantics while reporting the blocked targets', async () => {
    const prisma = {
      managedBroadcastDelivery: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { status: ManagedBroadcastDeliveryStatus.CANCELED, targetChatId: 'chat-1' },
          ]),
      },
      managedBroadcast: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const runtime = new AdminManagedBroadcastRuntime({ prisma } as never);

    const result = await (runtime as any).finalizeManagedBroadcastOccurrence(
      {
        id: 'broadcast-legacy',
        scheduleMode: 'legacy',
        nextSendAt: new Date('2026-07-12T10:00:00.000Z'),
        cycleEveryHours: 1,
        cycleCount: 1,
        publicationOccurrenceId: null,
      },
      1,
      [],
      [],
      null,
    );

    expect(result).toEqual(
      expect.objectContaining({
        status: ManagedBroadcastStatus.COMPLETED,
        sentChatIds: [],
        failedChatIds: ['chat-1'],
        canRetry: false,
      }),
    );
    expect(prisma.managedBroadcast.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ManagedBroadcastStatus.COMPLETED,
          sentCount: 1,
        }),
      }),
    );
  });

  it('does not expose retry after a concurrent broadcast cancellation wins finalization', async () => {
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedBroadcast: {
          findUnique: jest.fn().mockResolvedValue({
            status: ManagedBroadcastStatus.CANCELED,
            sentCount: 0,
            cycleCount: 1,
            nextSendAt: null,
          }),
        },
      },
    } as never);

    const result = await (runtime as any).readManagedBroadcastOccurrenceResult(
      'broadcast-1',
      [],
      ['chat-1'],
      [],
      null,
      true,
    );

    expect(result).toEqual(
      expect.objectContaining({
        status: ManagedBroadcastStatus.CANCELED,
        canRetry: false,
      }),
    );
  });
});
