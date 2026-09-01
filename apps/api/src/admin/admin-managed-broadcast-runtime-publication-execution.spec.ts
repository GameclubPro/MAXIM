import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import {
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationDeliveryVerificationSource,
  PublicationDispatchProfile,
  PublicationScheduleMode,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import { AdminManagedBroadcastPublicationVerification } from './admin-managed-broadcast-publication-verification';
import { AdminManagedBroadcastRuntime } from './admin-managed-broadcast-runtime';
import { cancelManagedBroadcastTargetDeliveries } from './admin-managed-broadcast-target-failure';
import { PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE } from './publication-access-loss-recovery';
import { PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE } from './admin.service.support';
import { PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE } from './publication-delivery-verification-state';

const AUTOMATED_VERIFICATION_DUE_AT = new Date('2026-07-25T08:00:15.000Z');

const createPublicationEnvelopeRow = () => ({
  id: 'broadcast-access-check',
  sourceChatId: 'chat-source',
  entityType: 'CHAT',
  actorUserId: 'admin-1',
  applyToAllChats: false,
  targetChatIds: ['chat-target'],
  scheduleMode: 'calendar',
  nextSendAt: new Date('2026-07-12T10:00:00.000Z'),
  cycleCount: 1,
  sentCount: 0,
  status: ManagedBroadcastStatus.ACTIVE,
  publicationOccurrenceId: 'occurrence-access-check',
  publicationContentRevisionId: 'content-access-check',
});

describe('AdminManagedBroadcastRuntime publication execution guard', () => {
  it('persists a structured access-loss code for the current and future target deliveries', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = { managedBroadcastDelivery: { updateMany } };

    await cancelManagedBroadcastTargetDeliveries(prisma as never, 'broadcast-1', 1, {
      targetChatId: 'chat-1',
      currentDeliveryId: 'delivery-1',
      currentDeliveryLockToken: 'delivery-lock-1',
      lastErrorCode: PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE,
      lastError: 'chat.denied',
    });

    expect(updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'delivery-1',
          lockToken: 'delivery-lock-1',
        }),
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.CANCELED,
          lastErrorCode: PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE,
        }),
      }),
    );
    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          broadcastId: 'broadcast-1',
          targetChatId: 'chat-1',
          occurrenceIndex: { gte: 2 },
        }),
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.CANCELED,
          lastErrorCode: PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE,
        }),
      }),
    );
  });

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

  it('keeps the first present observation provisional until the stability window', async () => {
    const delivery = {
      id: 'delivery-verify',
      targetChatId: 'chat-1',
      botId: 'bot-1',
      status: ManagedBroadcastDeliveryStatus.SENT,
      sentAt: new Date('2026-07-25T08:00:00.000Z'),
      remoteMessageId: 'mid-verify',
      remoteMessageVerifiedAt: null,
      remoteMessageVerificationAttemptCount: 0,
      remoteMessageVerificationPresentCount: 0,
      remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
    };
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([delivery]),
          updateMany,
        },
      },
      maxClient: {
        getExactMessagePresences: jest
          .fn()
          .mockResolvedValue([{ chatId: 'chat-1', messageId: 'mid-verify', presence: 'present' }]),
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

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          remoteMessageVerificationAttemptCount: 0,
          remoteMessageVerificationAbsentCount: 0,
          remoteMessageVerificationPresentCount: 0,
          remoteMessageVerificationAttemptedAt: null,
          remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
          remoteMessageVerificationLastError: null,
          remoteMessageVerificationSource: null,
        }),
        data: expect.objectContaining({
          remoteMessageVerificationAttemptCount: 1,
          remoteMessageVerificationPresentCount: 1,
          remoteMessageVerificationNextAt: expect.any(Date),
          remoteMessageVerificationSource: null,
          remoteMessageVerifiedAt: null,
        }),
      }),
    );
  });

  it('keeps untouched legacy SENT deliveries out of automatic exact lookup', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'delivery-legacy',
        targetChatId: 'chat-legacy',
        botId: 'bot-1',
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date('2026-07-11T08:00:00.000Z'),
        remoteMessageId: 'mid-legacy',
        remoteMessageVerifiedAt: null,
        remoteMessageVerificationAttemptCount: 0,
        remoteMessageVerificationAbsentCount: 0,
        remoteMessageVerificationPresentCount: 0,
        remoteMessageVerificationAttemptedAt: null,
        remoteMessageVerificationNextAt: null,
        remoteMessageVerificationLastError: null,
        remoteMessageVerificationSource: null,
      },
    ]);
    const getExactMessagePresences = jest.fn();
    const updateMany = jest.fn();
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: { managedBroadcastDelivery: { findMany, updateMany } },
      maxClient: { getExactMessagePresences },
      logger: { warn: jest.fn() },
    } as never);

    await expect(
      verification.verifyAfterSend(
        { id: 'broadcast-legacy', publicationOccurrenceId: 'occurrence-legacy' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toEqual(new Set());

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            expect.objectContaining({
              OR: expect.arrayContaining([
                { remoteMessageVerificationNextAt: { not: null } },
                { remoteMessageVerificationAttemptCount: { gt: 0 } },
              ]),
            }),
          ]),
        }),
      }),
    );
    expect(getExactMessagePresences).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('skips a stale priority delivery after its half-open route has already closed', async () => {
    const budget = { remaining: 2 };
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'selected-delivery',
        broadcastId: 'broadcast-priority',
        occurrenceIndex: 1,
        targetChatId: 'chat-priority',
        botId: 'bot-priority',
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date('2026-07-25T08:00:00.000Z'),
        remoteMessageId: 'mid-priority',
        remoteMessageVerifiedAt: null,
        remoteMessageVerificationAttemptCount: 1,
        remoteMessageVerificationAbsentCount: 1,
        remoteMessageVerificationPresentCount: 0,
        remoteMessageVerificationAttemptedAt: new Date('2026-07-25T08:00:15.000Z'),
        remoteMessageVerificationNextAt: new Date('2026-07-25T08:00:30.000Z'),
        remoteMessageVerificationLastError: null,
        remoteMessageVerificationSource: null,
      },
    ]);
    const getExactMessagePresences = jest.fn();
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: { findMany, updateMany: jest.fn() },
        chatBotMembership: { findMany: jest.fn().mockResolvedValue([]) },
      },
      maxClient: { getExactMessagePresences },
      logger: { warn: jest.fn() },
    } as never);

    await expect(
      verification.verifyAfterSend(
        {
          id: 'broadcast-priority',
          publicationOccurrenceId: 'occurrence-priority',
        } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockResolvedValue(undefined),
        budget,
        ['selected-delivery'],
      ),
    ).resolves.toEqual(new Set());

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['selected-delivery'] } }),
      }),
    );
    expect(budget.remaining).toBe(2);
    expect(getExactMessagePresences).not.toHaveBeenCalled();
  });

  it('confirms a second present observation after the stability window', async () => {
    const sentAt = new Date('2026-07-25T08:00:00.000Z');
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const routeUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const executeRaw = jest.fn().mockResolvedValue(1);
    const prisma: any = {
      managedBroadcastDelivery: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'delivery-verify',
            targetChatId: 'chat-1',
            botId: 'bot-1',
            status: ManagedBroadcastDeliveryStatus.SENT,
            sentAt,
            remoteMessageId: 'mid-verify',
            remoteMessageVerifiedAt: null,
            remoteMessageVerificationAttemptCount: 1,
            remoteMessageVerificationPresentCount: 1,
          },
        ]),
        updateMany,
      },
      chatBotMembership: { updateMany: routeUpdateMany },
      managedBroadcast: { updateMany: broadcastUpdateMany },
      $executeRaw: executeRaw,
    };
    prisma.$transaction = jest.fn(async (callback) => callback(prisma));
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma,
      maxClient: {
        getExactMessagePresences: jest
          .fn()
          .mockResolvedValue([{ chatId: 'chat-1', messageId: 'mid-verify', presence: 'present' }]),
      },
      logger: { warn: jest.fn() },
    } as never);

    await verification.verifyAfterSend(
      { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
      1,
      { trafficClass: 'background', sourceTag: 'managed_broadcast' },
      jest.fn().mockResolvedValue(undefined),
    );

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          remoteMessageVerificationAttemptCount: 1,
          remoteMessageVerificationAbsentCount: 0,
          remoteMessageVerificationPresentCount: 1,
          remoteMessageVerificationAttemptedAt: null,
          remoteMessageVerificationNextAt: null,
          remoteMessageVerificationLastError: null,
          remoteMessageVerificationSource: null,
        }),
        data: expect.objectContaining({
          remoteMessageVerificationAttemptCount: 2,
          remoteMessageVerificationPresentCount: 2,
          remoteMessageVerificationNextAt: null,
          remoteMessageVerificationSource: PublicationDeliveryVerificationSource.AUTOMATED_STABLE,
          remoteMessageVerifiedAt: expect.any(Date),
        }),
      }),
    );
    expect(routeUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ chatId: 'chat-1', botId: 'bot-1' }),
        data: expect.objectContaining({
          sendRouteFailureCount: 0,
          sendRouteQuarantinedUntil: null,
          sendRouteLastSuccessAt: sentAt,
        }),
      }),
    );
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(broadcastUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deliveries: {
            some: expect.objectContaining({ targetChatId: 'chat-1' }),
          },
        }),
        data: { nextSendAt: expect.any(Date) },
      }),
    );
  });

  it('marks repeated stable exact absence ambiguous without quarantining its route', async () => {
    const delivery = {
      id: 'delivery-verify',
      targetChatId: 'chat-1',
      botId: 'bot-1',
      status: ManagedBroadcastDeliveryStatus.SENT,
      sentAt: new Date('2026-07-25T08:00:00.000Z'),
      remoteMessageId: 'mid-verify',
      remoteMessageVerifiedAt: null,
      remoteMessageVerificationAttemptCount: 2,
      remoteMessageVerificationAbsentCount: 2,
      remoteMessageVerificationPresentCount: 0,
    };
    const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const routeUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const transaction = jest.fn(async (callback) => callback(prisma));
    const prisma: any = {
      managedBroadcastDelivery: {
        findMany: jest.fn().mockResolvedValue([delivery]),
        updateMany: deliveryUpdateMany,
      },
      chatBotMembership: { updateMany: routeUpdateMany },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    prisma.$transaction = transaction;
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma,
      maxClient: {
        getExactMessagePresences: jest
          .fn()
          .mockResolvedValue([{ chatId: 'chat-1', messageId: 'mid-verify', presence: 'absent' }]),
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
    ).resolves.toEqual(new Set(['chat-1']));

    expect(deliveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          remoteMessageVerificationAttemptCount: 2,
          remoteMessageVerificationAbsentCount: 2,
          remoteMessageVerificationPresentCount: 0,
          remoteMessageVerificationAttemptedAt: null,
          remoteMessageVerificationNextAt: null,
          remoteMessageVerificationLastError: null,
        }),
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
          remoteMessageVerificationAttemptCount: 3,
          remoteMessageVerificationAbsentCount: 3,
          remoteMessageVerificationNextAt: null,
          lastError: expect.stringContaining('Нужна ручная проверка'),
        }),
      }),
    );
    const terminalData = deliveryUpdateMany.mock.calls[0]?.[0]?.data;
    expect(terminalData).not.toHaveProperty('remoteMessageId');
    expect(terminalData).not.toHaveProperty('sentAt');
    expect(transaction).not.toHaveBeenCalled();
    expect(routeUpdateMany).not.toHaveBeenCalled();
  });

  it('rolls back a stable verification transition when route-health persistence fails', async () => {
    const delivery = {
      id: 'delivery-verify',
      targetChatId: 'chat-1',
      botId: 'bot-1',
      status: ManagedBroadcastDeliveryStatus.SENT,
      sentAt: new Date('2026-07-25T08:00:00.000Z'),
      remoteMessageId: 'mid-verify',
      remoteMessageVerifiedAt: null,
      remoteMessageVerificationAttemptCount: 1,
      remoteMessageVerificationAbsentCount: 0,
      remoteMessageVerificationPresentCount: 1,
    };
    const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const persistenceError = new Error('route-health write failed');
    const rollback = jest.fn();
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcastDelivery: { updateMany: deliveryUpdateMany },
      chatBotMembership: { updateMany: jest.fn().mockRejectedValue(persistenceError) },
    };
    const transaction = jest.fn(async (callback) => {
      try {
        return await callback(tx);
      } catch (error: unknown) {
        rollback();
        throw error;
      }
    });
    const logger = { warn: jest.fn() };
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        $transaction: transaction,
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([delivery]),
          updateMany: deliveryUpdateMany,
        },
      },
      maxClient: {
        getExactMessagePresences: jest
          .fn()
          .mockResolvedValue([{ chatId: 'chat-1', messageId: 'mid-verify', presence: 'present' }]),
      },
      logger,
    } as never);

    await expect(
      verification.verifyAfterSend(
        { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toEqual(new Set());

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: persistenceError.message }),
      'Managed publication verification was deferred after a persistence failure',
    );
  });

  it('bounds inconclusive verification as ambiguous', async () => {
    const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'delivery-verify',
              targetChatId: 'chat-1',
              botId: 'bot-1',
              status: ManagedBroadcastDeliveryStatus.SENT,
              sentAt: new Date('2026-07-25T08:00:00.000Z'),
              remoteMessageId: 'mid-verify',
              remoteMessageVerifiedAt: null,
              remoteMessageVerificationAttemptCount: 5,
              remoteMessageVerificationAbsentCount: 0,
              remoteMessageVerificationPresentCount: 0,
            },
          ]),
          updateMany: deliveryUpdateMany,
        },
      },
      maxClient: {
        getExactMessagePresences: jest.fn().mockResolvedValue([
          {
            chatId: 'chat-1',
            messageId: 'mid-verify',
            error: new Error('MAX API request failed with HTTP 503'),
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
    ).resolves.toEqual(new Set(['chat-1']));
    expect(deliveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          remoteMessageVerificationAttemptCount: 5,
          remoteMessageVerificationAbsentCount: 0,
          remoteMessageVerificationPresentCount: 0,
          remoteMessageVerificationAttemptedAt: null,
          remoteMessageVerificationNextAt: null,
          remoteMessageVerificationLastError: null,
        }),
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
          remoteMessageVerificationAttemptCount: 6,
        }),
      }),
    );
  });

  it('persists bounded retry state for an entire bot batch after a transient lookup failure', async () => {
    const deliveries = ['mid-1', 'mid-2'].map((remoteMessageId, index) => ({
      id: `delivery-${index + 1}`,
      targetChatId: `chat-${index + 1}`,
      botId: 'bot-1',
      status: ManagedBroadcastDeliveryStatus.SENT,
      sentAt: new Date('2026-07-25T08:00:00.000Z'),
      remoteMessageId,
      remoteMessageVerifiedAt: null,
      remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
    }));
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
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
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          remoteMessageVerificationAttemptCount: 1,
          remoteMessageVerificationNextAt: expect.any(Date),
          remoteMessageVerificationLastError: expect.stringContaining('503'),
        }),
      }),
    );
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
        remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
      },
      {
        id: 'delivery-2',
        targetChatId: 'chat-2',
        botId: 'bot-1',
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date('2026-07-25T08:00:01.000Z'),
        remoteMessageId: 'mid-shared',
        remoteMessageVerifiedAt: null,
        remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
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

    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'delivery-1' }) }),
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'delivery-2' }) }),
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
        remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
      },
      {
        id: 'delivery-2',
        targetChatId: 'chat-2',
        botId: 'bot-1',
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date('2026-07-25T08:00:01.000Z'),
        remoteMessageId: 'mid-2',
        remoteMessageVerifiedAt: null,
        remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
      },
      {
        id: 'delivery-3',
        targetChatId: 'chat-3',
        botId: 'bot-2',
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date('2026-07-25T08:00:02.000Z'),
        remoteMessageId: 'mid-3',
        remoteMessageVerifiedAt: null,
        remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
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

  it('defers verification when the delivery has no recorded bot route', async () => {
    const delivery = {
      id: 'delivery-without-bot',
      targetChatId: 'chat-1',
      botId: null,
      status: ManagedBroadcastDeliveryStatus.SENT,
      sentAt: new Date('2026-07-25T08:00:00.000Z'),
      remoteMessageId: 'mid-1',
      remoteMessageVerifiedAt: null,
      remoteMessageVerificationAttemptCount: 0,
      remoteMessageVerificationAbsentCount: 0,
      remoteMessageVerificationPresentCount: 0,
      remoteMessageVerificationAttemptedAt: null,
      remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
      remoteMessageVerificationLastError: null,
    };
    const getExactMessagePresences = jest.fn();
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([delivery]),
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

    expect(getExactMessagePresences).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          remoteMessageVerificationAbsentCount: 0,
          remoteMessageVerificationLastError: expect.stringContaining('no recorded bot route'),
        }),
      }),
    );
  });

  it('bounds each persisted publication verification batch', async () => {
    const deliveries = Array.from(
      { length: PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE + 1 },
      (_, index) => ({
        id: `delivery-${index + 1}`,
        targetChatId: `chat-${index + 1}`,
        botId: 'bot-1',
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date(`2026-07-25T08:00:${String(index).padStart(2, '0')}.000Z`),
        remoteMessageId: `mid-${index + 1}`,
        remoteMessageVerifiedAt: null,
        remoteMessageVerificationAttemptCount: 0,
        remoteMessageVerificationAbsentCount: 0,
        remoteMessageVerificationPresentCount: 0,
        remoteMessageVerificationAttemptedAt: null,
        remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
        remoteMessageVerificationLastError: null,
      }),
    );
    const findMany = jest.fn(async ({ take }: { take: number }) => deliveries.slice(0, take));
    const getExactMessagePresences = jest
      .fn()
      .mockImplementation(async (requests: Array<{ chatId: string; messageId: string }>) =>
        requests.map((request) => ({ ...request, presence: 'present' })),
      );
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: { managedBroadcastDelivery: { findMany, updateMany } },
      maxClient: { getExactMessagePresences },
      logger: { warn: jest.fn() },
    } as never);

    await verification.verifyAfterSend(
      { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
      1,
      { trafficClass: 'background', sourceTag: 'managed_broadcast' },
      jest.fn().mockResolvedValue(undefined),
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE }),
    );
    const requestedCount = getExactMessagePresences.mock.calls.reduce(
      (count, [requests]) => count + requests.length,
      0,
    );
    expect(requestedCount).toBe(PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE);
    expect(updateMany).toHaveBeenCalledTimes(PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE);
  });

  it('shares one verification budget across multiple publication envelopes', async () => {
    const makeDeliveries = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `${prefix}-delivery-${index + 1}`,
        targetChatId: `${prefix}-chat-${index + 1}`,
        botId: 'bot-1',
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date('2026-07-25T08:00:00.000Z'),
        remoteMessageId: `${prefix}-mid-${index + 1}`,
        remoteMessageVerifiedAt: null,
        remoteMessageVerificationAttemptCount: 0,
        remoteMessageVerificationAbsentCount: 0,
        remoteMessageVerificationPresentCount: 0,
        remoteMessageVerificationAttemptedAt: null,
        remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
        remoteMessageVerificationLastError: null,
      }));
    const batches = [makeDeliveries('first', 30), makeDeliveries('second', 30)];
    const requestedTake: number[] = [];
    const findMany = jest.fn(async ({ take }: { take: number }) => {
      requestedTake.push(take);
      return (batches.shift() ?? []).slice(0, take);
    });
    const getExactMessagePresences = jest.fn(
      async (requests: Array<{ chatId: string; messageId: string }>) =>
        requests.map((request) => ({ ...request, presence: 'present' as const })),
    );
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: {
          findMany,
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      },
      maxClient: { getExactMessagePresences },
      logger: { warn: jest.fn() },
    } as never);
    const budget = { remaining: PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE };

    await verification.verifyAfterSend(
      { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
      1,
      { trafficClass: 'background', sourceTag: 'managed_broadcast' },
      jest.fn().mockResolvedValue(undefined),
      budget,
    );
    await verification.verifyAfterSend(
      { id: 'broadcast-2', publicationOccurrenceId: 'occurrence-2' } as never,
      1,
      { trafficClass: 'background', sourceTag: 'managed_broadcast' },
      jest.fn().mockResolvedValue(undefined),
      budget,
    );

    expect(requestedTake).toEqual([PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE, 20]);
    expect(budget.remaining).toBe(0);
    expect(
      getExactMessagePresences.mock.calls.reduce((total, [requests]) => total + requests.length, 0),
    ).toBe(PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE);
  });

  it('defers a verification persistence failure without failing the publication envelope', async () => {
    const persistenceError = new Error('database write unavailable');
    const logger = { warn: jest.fn() };
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'delivery-db-error',
              targetChatId: 'chat-1',
              botId: 'bot-1',
              status: ManagedBroadcastDeliveryStatus.SENT,
              sentAt: new Date('2026-07-25T08:00:00.000Z'),
              remoteMessageId: 'mid-db-error',
              remoteMessageVerifiedAt: null,
              remoteMessageVerificationAttemptCount: 0,
              remoteMessageVerificationAbsentCount: 0,
              remoteMessageVerificationPresentCount: 0,
              remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
            },
          ]),
          updateMany: jest.fn().mockRejectedValue(persistenceError),
        },
      },
      maxClient: {
        getExactMessagePresences: jest
          .fn()
          .mockResolvedValue([
            { chatId: 'chat-1', messageId: 'mid-db-error', presence: 'present' },
          ]),
      },
      logger,
    } as never);

    await expect(
      verification.verifyAfterSend(
        { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toEqual(new Set());
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'database write unavailable' }),
      'Managed publication verification was deferred after a persistence failure',
    );
  });

  it('still propagates a publication lease heartbeat failure from verification', async () => {
    const heartbeatError = new Error('publication lease lost');
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'delivery-heartbeat',
              targetChatId: 'chat-1',
              botId: 'bot-1',
              status: ManagedBroadcastDeliveryStatus.SENT,
              sentAt: new Date('2026-07-25T08:00:00.000Z'),
              remoteMessageId: 'mid-heartbeat',
              remoteMessageVerifiedAt: null,
              remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
            },
          ]),
        },
      },
      maxClient: { getExactMessagePresences: jest.fn() },
      logger: { warn: jest.fn() },
    } as never);

    await expect(
      verification.verifyAfterSend(
        { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockRejectedValue(heartbeatError),
      ),
    ).rejects.toBe(heartbeatError);
  });

  it('does not overwrite a concurrent verification observation from a stale snapshot', async () => {
    const persistedDelivery: Record<string, any> = {
      id: 'delivery-race',
      targetChatId: 'chat-1',
      botId: 'bot-1',
      status: ManagedBroadcastDeliveryStatus.SENT,
      sentAt: new Date('2026-07-25T08:00:00.000Z'),
      remoteMessageId: 'mid-race',
      remoteMessageVerifiedAt: null,
      remoteMessageVerificationAttemptCount: 0,
      remoteMessageVerificationAbsentCount: 0,
      remoteMessageVerificationPresentCount: 0,
      remoteMessageVerificationAttemptedAt: null,
      remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
      remoteMessageVerificationLastError: null,
    };
    let verificationReadCount = 0;
    let releaseVerificationReads!: () => void;
    const verificationReadsReady = new Promise<void>((resolve) => {
      releaseVerificationReads = resolve;
    });
    const findMany = jest.fn(async () => {
      const snapshot = { ...persistedDelivery };
      verificationReadCount += 1;
      if (verificationReadCount === 2) {
        releaseVerificationReads();
      }
      await verificationReadsReady;
      return [snapshot];
    });
    let maxLookupCount = 0;
    let releaseStaleLookup!: () => void;
    const firstObservationPersisted = new Promise<void>((resolve) => {
      releaseStaleLookup = resolve;
    });
    const getExactMessagePresences = jest.fn(async () => {
      maxLookupCount += 1;
      if (maxLookupCount === 1) {
        return [{ chatId: 'chat-1', messageId: 'mid-race', presence: 'present' }];
      }
      await firstObservationPersisted;
      return [{ chatId: 'chat-1', messageId: 'mid-race', presence: 'absent' }];
    });
    const verificationStateFields = [
      'remoteMessageVerificationAttemptCount',
      'remoteMessageVerificationAbsentCount',
      'remoteMessageVerificationPresentCount',
      'remoteMessageVerificationAttemptedAt',
      'remoteMessageVerificationNextAt',
      'remoteMessageVerificationLastError',
    ] as const;
    const normalizeCasValue = (value: unknown): unknown =>
      value instanceof Date ? value.getTime() : value;
    const updateMany = jest.fn(async ({ where, data }: Record<string, any>) => {
      const matchesSnapshot =
        where.id === persistedDelivery.id &&
        where.status === persistedDelivery.status &&
        where.remoteMessageId === persistedDelivery.remoteMessageId &&
        where.remoteMessageVerifiedAt === persistedDelivery.remoteMessageVerifiedAt &&
        verificationStateFields.every(
          (field) =>
            normalizeCasValue(where[field]) === normalizeCasValue(persistedDelivery[field]),
        );
      if (!matchesSnapshot) {
        return { count: 0 };
      }
      Object.assign(persistedDelivery, data);
      releaseStaleLookup();
      return { count: 1 };
    });
    const logger = { warn: jest.fn() };
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: { managedBroadcastDelivery: { findMany, updateMany } },
      maxClient: { getExactMessagePresences },
      logger,
    } as never);
    const verify = () =>
      verification.verifyAfterSend(
        { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockResolvedValue(undefined),
      );

    await expect(Promise.all([verify(), verify()])).resolves.toEqual([new Set(), new Set()]);

    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(persistedDelivery).toEqual(
      expect.objectContaining({
        remoteMessageVerificationAttemptCount: 1,
        remoteMessageVerificationAbsentCount: 0,
        remoteMessageVerificationPresentCount: 1,
        remoteMessageVerificationLastError: null,
      }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
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
              remoteMessageVerificationNextAt: new Date(Date.now() + 15_000),
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

  it('skips a verification attempt until its persisted retry time is due', async () => {
    const nextVerificationAt = new Date(Date.now() + 60_000);
    const getExactMessagePresences = jest.fn();
    const updateMany = jest.fn();
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'delivery-deferred',
              targetChatId: 'chat-1',
              botId: 'bot-1',
              status: ManagedBroadcastDeliveryStatus.SENT,
              sentAt: new Date('2026-07-25T08:00:00.000Z'),
              remoteMessageId: 'mid-deferred',
              remoteMessageVerifiedAt: null,
              remoteMessageVerificationNextAt: nextVerificationAt,
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
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toEqual(new Set());
    expect(getExactMessagePresences).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
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

  it('runs priority half-open verification without sending a pending sibling', async () => {
    const now = new Date('2026-08-07T15:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    try {
      const sentAt = new Date('2026-08-07T14:49:00.000Z');
      const row = {
        id: 'half-open-broadcast',
        sourceChatId: 'source-chat',
        entityType: 'CHANNEL',
        actorUserId: 'admin-1',
        text: 'Publication',
        textFormat: 'plain',
        applyToAllChats: false,
        targetChatIds: ['half-open-chat', 'pending-chat'],
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
        nextSendAt: new Date('2026-08-07T20:47:00.000Z'),
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
      const sentDelivery = {
        id: 'sent-delivery',
        broadcastId: row.id,
        occurrenceIndex: 1,
        targetChatId: 'half-open-chat',
        botId: 'bot-1',
        status: ManagedBroadcastDeliveryStatus.SENT,
        attemptCount: 1,
        remoteMessageId: 'message-1',
        remoteMessageVerifiedAt: null,
        remoteMessageVerificationAttemptCount: 0,
        remoteMessageVerificationAbsentCount: 0,
        remoteMessageVerificationPresentCount: 0,
        remoteMessageVerificationAttemptedAt: null,
        remoteMessageVerificationNextAt: new Date('2026-08-07T14:49:15.000Z'),
        remoteMessageVerificationLastError: null,
        remoteMessageVerificationSource: null,
        legacySentWithoutRemoteId: false,
        lastErrorCode: null,
        lastError: null,
        sentAt,
        lockedAt: null,
        lockToken: null,
      };
      const pendingDelivery = {
        ...sentDelivery,
        id: 'pending-delivery',
        targetChatId: 'pending-chat',
        botId: null,
        status: ManagedBroadcastDeliveryStatus.PENDING,
        attemptCount: 0,
        remoteMessageId: null,
        remoteMessageVerificationNextAt: null,
        sentAt: null,
      };
      const olderSentSibling = {
        ...sentDelivery,
        id: 'older-sent-delivery',
        targetChatId: 'older-chat',
        remoteMessageId: 'older-message',
        sentAt: new Date('2026-08-07T14:40:00.000Z'),
      };
      const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const deliveryFindMany = jest
        .fn()
        .mockImplementation(async ({ where }: any) =>
          where.status === ManagedBroadcastDeliveryStatus.SENT
            ? [olderSentSibling, sentDelivery]
            : [sentDelivery, pendingDelivery],
        );
      const publish = jest.fn();
      const getExactMessagePresences = jest.fn().mockResolvedValue([
        {
          chatId: sentDelivery.targetChatId,
          messageId: sentDelivery.remoteMessageId,
          presence: 'present',
        },
      ]);
      const verificationBudget = { remaining: 4 };
      const runtime = new AdminManagedBroadcastRuntime({
        prisma: {
          $queryRaw: jest.fn().mockResolvedValue([{ id: row.id, deliveryId: sentDelivery.id }]),
          managedBroadcast: {
            updateMany: broadcastUpdateMany,
            findUnique: jest.fn().mockResolvedValue(row),
            findMany: jest.fn().mockResolvedValue([]),
          },
          managedBroadcastDelivery: {
            findMany: deliveryFindMany,
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          chatBotMembership: {
            findMany: jest.fn().mockResolvedValue([
              {
                chatId: sentDelivery.targetChatId,
                botId: sentDelivery.botId,
                sendRouteLastFailureAt: new Date('2026-08-07T14:48:00.000Z'),
              },
            ]),
          },
          managedBroadcastOccurrence: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
        },
        maxClient: { getExactMessagePresences },
        maxRoutedPublicationService: { publish },
        logger: { log: jest.fn(), warn: jest.fn() },
      } as never);
      const targetResolutionSpy = jest.spyOn(
        runtime as any,
        'resolveManagedBroadcastTargetsFromRow',
      );
      const mediaSpy = jest.spyOn(
        (runtime as any).mediaRuntime,
        'loadManagedBroadcastRequestMedia',
      );
      const sendSpy = jest.spyOn(runtime as any, 'sendManagedBroadcastMessageImmediateWithId');

      const result = await runtime.processDueImmediatePublicationBroadcasts(verificationBudget);

      expect(result).toBe(verificationBudget);
      expect(verificationBudget.remaining).toBe(3);
      expect(getExactMessagePresences).toHaveBeenCalledWith(
        [{ chatId: 'half-open-chat', messageId: 'message-1' }],
        expect.objectContaining({
          botId: 'bot-1',
          trafficClass: 'background',
          sourceTag: 'managed_broadcast',
        }),
      );
      expect(deliveryFindMany.mock.calls[0]?.[0]?.where.id).toEqual({
        in: [sentDelivery.id],
      });
      expect(broadcastUpdateMany.mock.calls[0]?.[0]?.where).not.toHaveProperty('nextSendAt');
      expect(targetResolutionSpy).not.toHaveBeenCalled();
      expect(mediaSpy).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(deliveryFindMany).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('defers priority verification infrastructure errors without failing the envelope', async () => {
    const row = {
      id: 'half-open-broadcast',
      sourceChatId: 'source-chat',
      nextSendAt: new Date('2026-08-07T20:47:00.000Z'),
      cycleCount: 1,
      sentCount: 0,
      status: ManagedBroadcastStatus.ACTIVE,
      publicationOccurrenceId: 'occurrence-1',
      publicationContentRevisionId: 'content-1',
    };
    const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const publish = jest.fn();
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        $queryRaw: jest.fn().mockResolvedValue([{ id: row.id, deliveryId: 'selected-delivery' }]),
        managedBroadcast: {
          updateMany: broadcastUpdateMany,
          findUnique: jest.fn().mockResolvedValue(row),
          findMany: jest.fn().mockResolvedValue([]),
        },
        managedBroadcastDelivery: {
          findMany: jest.fn().mockRejectedValue(new Error('database unavailable')),
        },
      },
      maxRoutedPublicationService: { publish },
      logger: { log: jest.fn(), warn: jest.fn() },
    } as never);
    await expect(
      runtime.processDueImmediatePublicationBroadcasts({ remaining: 2 }),
    ).resolves.toEqual({ remaining: 2 });

    expect(broadcastUpdateMany).toHaveBeenCalledTimes(2);
    expect(broadcastUpdateMany.mock.calls[1]?.[0]?.data).toEqual({
      lockedAt: null,
      lockToken: null,
    });
    expect(
      broadcastUpdateMany.mock.calls.some(
        ([request]) => request.data?.status === ManagedBroadcastStatus.FAILED,
      ),
    ).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not select priority verifications after the shared exact-read budget is exhausted', async () => {
    const queryRaw = jest.fn();
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        $queryRaw: queryRaw,
        managedBroadcast: { findMany: jest.fn().mockResolvedValue([]) },
      },
      logger: { log: jest.fn(), warn: jest.fn() },
    } as never);

    await expect(
      runtime.processDueImmediatePublicationBroadcasts({ remaining: 0 }),
    ).resolves.toEqual({ remaining: 0 });

    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('continues the immediate pass when priority verification selection fails', async () => {
    const immediateFindMany = jest.fn().mockResolvedValue([]);
    const warn = jest.fn();
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        $queryRaw: jest.fn().mockRejectedValue(new Error('priority selector unavailable')),
        managedBroadcast: { findMany: immediateFindMany },
      },
      logger: { log: jest.fn(), warn },
    } as never);

    await expect(runtime.processDueImmediatePublicationBroadcasts()).resolves.toEqual({
      remaining: PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE,
    });

    expect(immediateFindMany).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      { err: 'priority selector unavailable' },
      'Priority half-open publication verification was deferred',
    );
  });

  it('only unlocks when a selected delivery belongs to an occurrence that already advanced', async () => {
    const futureNextSendAt = new Date('2026-08-08T12:00:00.000Z');
    const row = {
      id: 'advanced-broadcast',
      sourceChatId: 'source-chat',
      nextSendAt: futureNextSendAt,
      cycleCount: 2,
      sentCount: 1,
      status: ManagedBroadcastStatus.ACTIVE,
      publicationOccurrenceId: 'occurrence-2',
      publicationContentRevisionId: 'content-2',
    };
    const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const deliveryFindMany = jest.fn().mockResolvedValue([]);
    const publish = jest.fn();
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        $queryRaw: jest
          .fn()
          .mockResolvedValue([{ id: row.id, deliveryId: 'occurrence-1-delivery' }]),
        managedBroadcast: {
          updateMany: broadcastUpdateMany,
          findUnique: jest.fn().mockResolvedValue(row),
          findMany: jest.fn().mockResolvedValue([]),
        },
        managedBroadcastDelivery: { findMany: deliveryFindMany },
      },
      maxRoutedPublicationService: { publish },
      logger: { log: jest.fn(), warn: jest.fn() },
    } as never);
    await runtime.processDueImmediatePublicationBroadcasts({ remaining: 2 });

    expect(deliveryFindMany).toHaveBeenCalledTimes(1);
    expect(deliveryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          occurrenceIndex: 2,
          id: { in: ['occurrence-1-delivery'] },
        }),
      }),
    );
    expect(broadcastUpdateMany.mock.calls[1]?.[0]?.data).toEqual({
      lockedAt: null,
      lockToken: null,
    });
    expect(
      broadcastUpdateMany.mock.calls.some(([request]) => request.data?.nextSendAt !== undefined),
    ).toBe(false);
    expect(publish).not.toHaveBeenCalled();
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
    expect(processSpy).toHaveBeenCalledWith(
      'broadcast-now',
      'immediate',
      expect.any(Date),
      [
        ManagedBroadcastStatus.ACTIVE,
        ManagedBroadcastStatus.PARTIAL,
        ManagedBroadcastStatus.FAILED,
      ],
      undefined,
      { remaining: PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE },
    );
    expect(managedBroadcast.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        take: 10,
        where: expect.objectContaining({
          status: ManagedBroadcastStatus.ACTIVE,
          publicationOccurrence: {
            is: { schedule: { is: { mode: { in: [PublicationScheduleMode.NOW] } } } },
          },
          deliveries: {
            some: {
              status: {
                in: [
                  ManagedBroadcastDeliveryStatus.PENDING,
                  ManagedBroadcastDeliveryStatus.SENDING,
                ],
              },
            },
          },
        }),
      }),
    );
    expect(managedBroadcast.findMany).toHaveBeenCalledTimes(3);
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
    expect(processSpy).toHaveBeenCalledWith(
      'broadcast-once',
      'deadline',
      expect.any(Date),
      [
        ManagedBroadcastStatus.ACTIVE,
        ManagedBroadcastStatus.PARTIAL,
        ManagedBroadcastStatus.FAILED,
      ],
      undefined,
      { remaining: PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE },
    );
    expect(managedBroadcast.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        take: 7,
        where: expect.objectContaining({
          status: ManagedBroadcastStatus.ACTIVE,
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
          deliveries: {
            some: {
              status: {
                in: [
                  ManagedBroadcastDeliveryStatus.PENDING,
                  ManagedBroadcastDeliveryStatus.SENDING,
                ],
              },
            },
          },
        }),
      }),
    );
    expect(managedBroadcast.findMany).toHaveBeenCalledTimes(3);
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

  it('checks that a publication envelope is active before revalidating target access', async () => {
    const row = createPublicationEnvelopeRow();
    const assertManagedEntityAdminAccess = jest.fn();
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedBroadcast: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue(row),
        },
      },
      assertManagedEntityAdminAccess,
      logger: { log: jest.fn(), warn: jest.fn() },
    } as never);
    const executionActive = jest
      .spyOn(runtime as any, 'ensureManagedBroadcastPublicationExecutionActive')
      .mockResolvedValue(false);

    const result = await (runtime as any).processManagedBroadcastOccurrence(
      row.id,
      'deadline',
      new Date('2026-07-12T09:55:00.000Z'),
      [ManagedBroadcastStatus.ACTIVE],
    );

    expect(executionActive).toHaveBeenCalledTimes(1);
    expect(assertManagedEntityAdminAccess).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        status: ManagedBroadcastStatus.CANCELED,
        canRetry: false,
        nextSendAt: null,
      }),
    );
  });

  it('terminally fails a publication envelope when target admin access is denied', async () => {
    const row = createPublicationEnvelopeRow();
    const accessError = new ForbiddenException(
      'Пользователь больше не является администратором чата.',
    );
    const assertManagedEntityAdminAccess = jest.fn().mockRejectedValue(accessError);
    const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const occurrenceUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const reservationDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedBroadcast: {
          updateMany: broadcastUpdateMany,
          findUnique: jest.fn().mockResolvedValue(row),
        },
        managedBroadcastDelivery: { updateMany: deliveryUpdateMany },
        managedBroadcastCalendarReservation: { deleteMany: reservationDeleteMany },
        managedBroadcastOccurrence: { updateMany: occurrenceUpdateMany },
      },
      assertManagedEntityAdminAccess,
      logger: { log: jest.fn(), warn: jest.fn() },
    } as never);
    const executionActive = jest
      .spyOn(runtime as any, 'ensureManagedBroadcastPublicationExecutionActive')
      .mockResolvedValue(true);
    const reconcile = jest
      .spyOn(runtime as any, 'reconcileStaleManagedBroadcastDeliveries')
      .mockResolvedValue(undefined);
    jest
      .spyOn(runtime as any, 'deferManagedBroadcastOccurrenceWithFreshSendingDeliveries')
      .mockResolvedValue(false);

    const result = await (runtime as any).processManagedBroadcastOccurrence(
      row.id,
      'deadline',
      new Date('2026-07-12T09:55:00.000Z'),
      [ManagedBroadcastStatus.ACTIVE],
    );

    expect(executionActive.mock.invocationCallOrder[0]).toBeLessThan(
      assertManagedEntityAdminAccess.mock.invocationCallOrder[0]!,
    );
    expect(assertManagedEntityAdminAccess).toHaveBeenCalledWith('chat-target', 'admin-1', 'chat');
    expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(
      assertManagedEntityAdminAccess.mock.invocationCallOrder[0]!,
    );
    expect(broadcastUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          status: ManagedBroadcastStatus.FAILED,
          lastError: accessError.message,
          nextSendAt: null,
          lockedAt: null,
          lockToken: null,
        },
      }),
    );
    expect(deliveryUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        broadcastId: row.id,
        occurrenceIndex: 1,
        status: {
          in: [ManagedBroadcastDeliveryStatus.PENDING, ManagedBroadcastDeliveryStatus.FAILED],
        },
      },
      data: {
        status: ManagedBroadcastDeliveryStatus.CANCELED,
        lockedAt: null,
        lockToken: null,
        lastErrorCode: PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE,
        lastError: accessError.message,
      },
    });
    expect(deliveryUpdateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ occurrenceIndex: { gt: 1 } }),
        data: expect.objectContaining({ status: ManagedBroadcastDeliveryStatus.CANCELED }),
      }),
    );
    expect(occurrenceUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { broadcastId: row.id, occurrenceIndex: 1 },
      data: { status: ManagedBroadcastStatus.FAILED },
    });
    expect(occurrenceUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { broadcastId: row.id, occurrenceIndex: { gt: 1 } },
      data: { status: ManagedBroadcastStatus.CANCELED },
    });
    expect(reservationDeleteMany).toHaveBeenCalledWith({
      where: { broadcastId: row.id, occurrenceIndex: { gte: 1 } },
    });
    expect(
      deliveryUpdateMany.mock.calls.some(([query]) =>
        query.where.status.in.some(
          (status: ManagedBroadcastDeliveryStatus) =>
            status === ManagedBroadcastDeliveryStatus.SENDING ||
            status === ManagedBroadcastDeliveryStatus.AMBIGUOUS,
        ),
      ),
    ).toBe(false);
    expect(result).toEqual(
      expect.objectContaining({
        status: ManagedBroadcastStatus.FAILED,
        pendingChatIds: [],
        canRetry: false,
        firstSendError: accessError,
        nextSendAt: null,
      }),
    );
  });

  it('does not classify a downstream forbidden error as target access loss', async () => {
    const row = createPublicationEnvelopeRow();
    const downstreamError = new ForbiddenException('Вложение недоступно.');
    const assertManagedEntityAdminAccess = jest.fn().mockResolvedValue(undefined);
    const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const deliveryUpdateMany = jest.fn();
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedBroadcast: {
          updateMany: broadcastUpdateMany,
          findUnique: jest.fn().mockResolvedValue(row),
        },
        managedBroadcastDelivery: {
          findMany: jest.fn().mockRejectedValue(downstreamError),
          updateMany: deliveryUpdateMany,
        },
      },
      assertManagedEntityAdminAccess,
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

    const result = await (runtime as any).processManagedBroadcastOccurrence(
      row.id,
      'deadline',
      new Date('2026-07-12T09:55:00.000Z'),
      [ManagedBroadcastStatus.ACTIVE],
    );

    expect(assertManagedEntityAdminAccess).toHaveBeenCalledTimes(1);
    expect(deliveryUpdateMany).not.toHaveBeenCalled();
    expect(broadcastUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          status: ManagedBroadcastStatus.FAILED,
          lastError: downstreamError.message,
          lockedAt: null,
          lockToken: null,
        },
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: ManagedBroadcastStatus.FAILED,
        firstSendError: downstreamError,
        nextSendAt: row.nextSendAt,
      }),
    );
  });

  it('keeps a publication envelope retryable when target access cannot be checked temporarily', async () => {
    const row = createPublicationEnvelopeRow();
    const accessError = new ServiceUnavailableException(
      'Не удалось проверить права администратора в MAX. Повторите попытку.',
    );
    const assertManagedEntityAdminAccess = jest.fn().mockRejectedValue(accessError);
    const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const deliveryUpdateMany = jest.fn();
    const occurrenceUpdateMany = jest.fn();
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedBroadcast: {
          updateMany: broadcastUpdateMany,
          findUnique: jest.fn().mockResolvedValue(row),
        },
        managedBroadcastDelivery: { updateMany: deliveryUpdateMany },
        managedBroadcastOccurrence: { updateMany: occurrenceUpdateMany },
      },
      assertManagedEntityAdminAccess,
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

    const result = await (runtime as any).processManagedBroadcastOccurrence(
      row.id,
      'deadline',
      new Date('2026-07-12T09:55:00.000Z'),
      [ManagedBroadcastStatus.ACTIVE],
    );

    expect(broadcastUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          status: ManagedBroadcastStatus.FAILED,
          lastError: accessError.message,
          lockedAt: null,
          lockToken: null,
        },
      }),
    );
    expect(deliveryUpdateMany).not.toHaveBeenCalled();
    expect(occurrenceUpdateMany).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        status: ManagedBroadcastStatus.FAILED,
        canRetry: true,
        firstSendError: accessError,
        nextSendAt: row.nextSendAt,
      }),
    );
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
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
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
    jest.spyOn((runtime as any).messageRuntime, 'buildMessage').mockResolvedValue({
      messageText: 'Publication',
      messageOptions: {},
      commentDialogReference: null,
    });
    jest
      .spyOn(runtime as any, 'heartbeatManagedBroadcastProcessingLock')
      .mockResolvedValue(undefined);
    jest
      .spyOn((runtime as any).messageRuntime, 'recordDialogReference')
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
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
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
        sendRouteHalfOpenProbe: 'publication_exact_verification',
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

  it('sends PUBLIK_V1 directly through its persisted exact bot without routed failover', async () => {
    const nextSendAt = new Date('2026-08-26T10:00:00.000Z');
    const row = {
      id: 'broadcast-publik',
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
      publicationOccurrenceId: 'occurrence-publik',
      publicationContentRevisionId: 'content-publik',
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: 'publisher-bot',
    };
    const delivery = {
      id: 'delivery-publik',
      broadcastId: row.id,
      occurrenceIndex: 1,
      targetChatId: 'chat-1',
      botId: null,
      status: ManagedBroadcastDeliveryStatus.PENDING,
      attemptCount: 0,
      remoteMessageId: null,
      lastError: null,
      sentAt: null,
      lockedAt: null,
      lockToken: null,
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: 'publisher-bot',
      dialogBotId: 'publisher-bot',
    };
    const publish = jest.fn();
    const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const managedBroadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const publicationOccurrenceUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const actorAccessFindMany = jest.fn().mockResolvedValue([
      {
        chatId: 'chat-1',
        userId: 'admin-1',
        botId: 'publisher-bot',
        state: ManagedEntityAccessState.GRANTED,
        userRole: ManagedEntityAccessRole.ADMIN,
        checkedAt: new Date('2026-08-27T09:59:00.000Z'),
        expiresAt: new Date('2099-08-27T10:14:00.000Z'),
      },
    ]);
    const tx = {
      managedBroadcast: { updateMany: managedBroadcastUpdateMany },
      managedBroadcastDelivery: { updateMany: deliveryUpdateMany },
      publicationOccurrence: { updateMany: publicationOccurrenceUpdateMany },
    };
    const runtime = new AdminManagedBroadcastRuntime(
      {
        prisma: {
          $transaction: (callback: (client: typeof tx) => unknown) => callback(tx),
          managedBroadcast: {
            updateMany: managedBroadcastUpdateMany,
            findUnique: jest.fn().mockResolvedValue(row),
          },
          managedBroadcastDelivery: {
            findMany: jest.fn().mockResolvedValue([delivery]),
            updateMany: deliveryUpdateMany,
          },
          managedEntityAccessEdge: { findMany: actorAccessFindMany },
        },
        maxRoutedPublicationService: { publish },
        publisherRuntimeBoundaryService: { assertDispatchEnabled: jest.fn() },
        publisherReadinessService: {
          assertEntityReady: jest.fn().mockResolvedValue({
            chatId: 'chat-1',
            entityType: 'chat',
            requiredBotId: 'publisher-bot',
            policyRevision: 1,
          }),
        },
        publisherDispatchHealthService: {
          assertDispatchAllowed: jest.fn().mockResolvedValue(undefined),
          recordSendSuccess: jest.fn().mockResolvedValue(undefined),
          recordSendFailure: jest.fn().mockResolvedValue('transient'),
        },
        assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
        logger: { log: jest.fn(), warn: jest.fn() },
      } as never,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    jest
      .spyOn(runtime as any, 'ensureManagedBroadcastPublicationExecutionActive')
      .mockResolvedValue(true);
    jest
      .spyOn(runtime as any, 'reconcileStaleManagedBroadcastDeliveries')
      .mockResolvedValue(undefined);
    jest
      .spyOn(runtime as any, 'deferManagedBroadcastOccurrenceWithFreshSendingDeliveries')
      .mockResolvedValue(false);
    jest
      .spyOn((runtime as any).publisherDispatch, 'ensureRuntimeBoundary')
      .mockResolvedValue({ ready: true });
    jest.spyOn(runtime as any, 'resolveManagedBroadcastTargetsFromRow').mockReturnValue({
      targetMode: 'selected',
      targetChatIds: ['chat-1'],
    });
    jest.spyOn(runtime as any, 'ensureManagedBroadcastDeliveryRows').mockResolvedValue([delivery]);
    jest
      .spyOn((runtime as any).mediaRuntime, 'loadManagedBroadcastRequestMedia')
      .mockResolvedValue({});
    jest.spyOn((runtime as any).mediaRuntime, 'resolveManagedBroadcastMedia').mockResolvedValue({});
    jest
      .spyOn((runtime as any).publicationVerification, 'verifyAfterSend')
      .mockResolvedValue(new Set());
    jest
      .spyOn((runtime as any).publicationVerification, 'persistResponseTargetMismatch')
      .mockResolvedValue(null);
    jest
      .spyOn(runtime as any, 'heartbeatManagedBroadcastProcessingLock')
      .mockResolvedValue(undefined);
    jest.spyOn((runtime as any).messageRuntime, 'buildMessage').mockResolvedValue({
      messageText: 'Publication',
      messageOptions: undefined,
      commentDialogReference: null,
    });
    const send = jest
      .spyOn(runtime as any, 'sendManagedBroadcastMessageImmediateWithId')
      .mockResolvedValue({ messageId: 'mid-publik', url: null, chatId: 'chat-1' });
    jest
      .spyOn((runtime as any).messageRuntime, 'recordDialogReference')
      .mockResolvedValue(undefined);
    jest.spyOn(runtime as any, 'finalizeManagedBroadcastOccurrence').mockResolvedValue({
      status: ManagedBroadcastStatus.COMPLETED,
      currentOccurrence: 1,
      sentChatIds: ['chat-1'],
      failedChatIds: [],
      pendingChatIds: [],
      canRetry: false,
      firstSendError: null,
      nextSendAt: null,
    });

    await (runtime as any).processManagedBroadcastOccurrence(
      row.id,
      'deadline',
      new Date('2026-08-26T09:55:00.000Z'),
      [ManagedBroadcastStatus.ACTIVE],
    );

    expect(publish).not.toHaveBeenCalled();
    expect(actorAccessFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: { in: ['chat-1'] },
          userId: 'admin-1',
          botId: 'publisher-bot',
          state: ManagedEntityAccessState.GRANTED,
          userRole: {
            in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN],
          },
          OR: expect.arrayContaining([
            expect.objectContaining({ expiresAt: { gt: expect.any(Date) } }),
          ]),
        }),
      }),
    );
    expect(send).toHaveBeenCalledWith(
      'chat-1',
      'Publication',
      undefined,
      'publisher-bot',
      expect.any(Object),
      expect.any(Function),
      expect.any(Function),
    );
    expect(deliveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          requiredBotId: 'publisher-bot',
        }),
        data: expect.objectContaining({
          botId: 'publisher-bot',
          dialogBotId: 'publisher-bot',
        }),
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

  it('preserves the earliest route retry when every pending target is quarantined', async () => {
    const now = new Date('2026-07-12T10:05:00.000Z');
    const retryAt = new Date('2026-07-12T16:05:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    try {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const runtime = new AdminManagedBroadcastRuntime({
        prisma: {
          managedBroadcastDelivery: {
            findMany: jest.fn().mockResolvedValue([
              {
                status: ManagedBroadcastDeliveryStatus.PENDING,
                targetChatId: 'chat-1',
                lastErrorCode: PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
              },
              {
                status: ManagedBroadcastDeliveryStatus.PENDING,
                targetChatId: 'chat-2',
                lastErrorCode: PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
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
          nextSendAt: now,
          publicationOccurrenceId: 'occurrence-1',
        },
        1,
        [],
        [],
        null,
        { pendingNotBefore: retryAt },
      );

      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ManagedBroadcastStatus.ACTIVE,
            nextSendAt: retryAt,
          }),
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          status: ManagedBroadcastStatus.ACTIVE,
          pendingChatIds: ['chat-1', 'chat-2'],
          nextSendAt: retryAt,
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('schedules an unverified publication at its persisted verification retry time', async () => {
    const now = new Date('2026-07-12T10:05:00.000Z');
    const nextVerificationAt = new Date('2026-07-12T10:15:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    try {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const runtime = new AdminManagedBroadcastRuntime({
        prisma: {
          managedBroadcastDelivery: {
            findMany: jest.fn().mockResolvedValue([
              {
                status: ManagedBroadcastDeliveryStatus.SENT,
                targetChatId: 'chat-1',
                sentAt: new Date('2026-07-12T10:00:00.000Z'),
                remoteMessageId: 'mid-1',
                remoteMessageVerifiedAt: null,
                remoteMessageVerificationNextAt: nextVerificationAt,
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
            nextSendAt: nextVerificationAt,
          }),
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          status: ManagedBroadcastStatus.ACTIVE,
          pendingChatIds: [],
          nextSendAt: nextVerificationAt,
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not keep an envelope active for untouched legacy SENT verification state', async () => {
    const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const occurrenceUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const reservationDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([
            {
              status: ManagedBroadcastDeliveryStatus.SENT,
              targetChatId: 'chat-legacy',
              sentAt: new Date('2026-07-11T10:00:00.000Z'),
              remoteMessageId: 'mid-legacy',
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
        managedBroadcast: { updateMany: broadcastUpdateMany },
        managedBroadcastOccurrence: { updateMany: occurrenceUpdateMany },
        managedBroadcastCalendarReservation: { deleteMany: reservationDeleteMany },
      },
    } as never);

    const result = await (runtime as any).finalizeManagedBroadcastOccurrence(
      {
        id: 'broadcast-legacy',
        scheduleMode: 'calendar',
        cycleCount: 1,
        nextSendAt: new Date('2026-07-11T10:00:00.000Z'),
        publicationOccurrenceId: 'occurrence-legacy',
      },
      1,
      [],
      [],
      null,
    );

    expect(broadcastUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ManagedBroadcastStatus.COMPLETED,
          nextSendAt: null,
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: ManagedBroadcastStatus.COMPLETED,
        sentChatIds: ['chat-legacy'],
        nextSendAt: null,
      }),
    );
    expect(reservationDeleteMany).toHaveBeenCalledTimes(1);
    expect(occurrenceUpdateMany).toHaveBeenCalledTimes(1);
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
    const runtime = new AdminManagedBroadcastRuntime({
      prisma,
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
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
          remoteMessageVerificationNextAt: new Date(completedAt.getTime() + 15_000),
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
    'deletes an unattempted envelope safely when its publication becomes %s',
    async (lifecycle) => {
      const broadcastUpdateMany = jest.fn().mockResolvedValueOnce({ count: 1 });
      const broadcastDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
      const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const tx = {
        managedBroadcastDelivery: {
          count: jest.fn().mockResolvedValue(0),
          updateMany: deliveryUpdateMany,
        },
        managedBroadcastCalendarReservation: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        managedBroadcast: {
          updateMany: broadcastUpdateMany,
          deleteMany: broadcastDeleteMany,
        },
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
            lockToken: 'lease-1',
          },
          1,
        ),
      ).resolves.toBe(false);

      expect(deliveryUpdateMany).toHaveBeenCalledWith({
        where: {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          status: {
            in: [ManagedBroadcastDeliveryStatus.PENDING, ManagedBroadcastDeliveryStatus.FAILED],
          },
        },
        data: {
          status: ManagedBroadcastDeliveryStatus.CANCELED,
          lockedAt: null,
          lockToken: null,
          lastError: 'Публикация остановлена до отправки.',
        },
      });
      expect(broadcastUpdateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'broadcast-1', lockToken: 'lease-1' },
        data: { lockedAt: expect.any(Date) },
      });
      expect(broadcastDeleteMany).toHaveBeenCalledWith({
        where: {
          id: 'broadcast-1',
          lockToken: 'lease-1',
          sentCount: 0,
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
      });
      expect(broadcastUpdateMany).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves an in-flight delivery when its publication is stopped', async () => {
    const broadcastUpdateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
    const tx = {
      managedBroadcastDelivery: {
        updateMany: deliveryUpdateMany,
        count: jest.fn().mockResolvedValue(1),
      },
      managedBroadcastCalendarReservation: { deleteMany: jest.fn() },
      managedBroadcast: { updateMany: broadcastUpdateMany, deleteMany: jest.fn() },
    };
    const prisma = {
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          scheduleRevision: 2,
          contentRevisionId: 'content-1',
          publication: { lifecycle: PublicationLifecycle.PAUSED },
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
          lockToken: 'lease-current',
        },
        1,
      ),
    ).resolves.toBe(false);

    expect(deliveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: [ManagedBroadcastDeliveryStatus.PENDING, ManagedBroadcastDeliveryStatus.FAILED],
          },
        }),
      }),
    );
    expect(broadcastUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'broadcast-1', lockToken: 'lease-current' },
      data: { lockedAt: null, lockToken: null },
    });
    expect(tx.managedBroadcastCalendarReservation.deleteMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcast.deleteMany).not.toHaveBeenCalled();
  });

  it('retains an attempted envelope for audit when safe deletion is rejected', async () => {
    const broadcastUpdateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const tx = {
      managedBroadcastDelivery: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
      },
      managedBroadcastCalendarReservation: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcast: {
        updateMany: broadcastUpdateMany,
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const prisma = {
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          scheduleRevision: 2,
          contentRevisionId: 'content-1',
          publication: { lifecycle: PublicationLifecycle.PAUSED },
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
          lockToken: 'lease-current',
        },
        1,
      ),
    ).resolves.toBe(false);

    expect(tx.managedBroadcast.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'broadcast-1',
          lockToken: 'lease-current',
          deliveries: { none: expect.any(Object) },
        }),
      }),
    );
    expect(broadcastUpdateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: 'broadcast-1', lockToken: 'lease-current' },
        data: expect.objectContaining({ status: ManagedBroadcastStatus.CANCELED }),
      }),
    );
  });

  it('does not mutate deliveries after losing the publication envelope lease', async () => {
    const deliveryUpdateMany = jest.fn();
    const tx = {
      managedBroadcastDelivery: { updateMany: deliveryUpdateMany, count: jest.fn() },
      managedBroadcastCalendarReservation: { deleteMany: jest.fn() },
      managedBroadcast: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        deleteMany: jest.fn(),
      },
    };
    const prisma = {
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          scheduleRevision: 2,
          contentRevisionId: 'content-1',
          publication: { lifecycle: PublicationLifecycle.PAUSED },
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
          lockToken: 'lease-stale',
        },
        1,
      ),
    ).resolves.toBe(false);

    expect(deliveryUpdateMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcastDelivery.count).not.toHaveBeenCalled();
    expect(tx.managedBroadcastCalendarReservation.deleteMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcast.deleteMany).not.toHaveBeenCalled();
  });

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
