import { PublisherAutoReplyAuthoringState } from '../prisma/prisma-client';
import { PublisherAutoReplyAuthoringDeliveryService } from './publisher-auto-reply-authoring-delivery.service';

function notificationSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    publisherBotId: 'publik_bot',
    actorUserId: '42',
    startToken: 'token-1',
    targetChatId: '-100500',
    state: PublisherAutoReplyAuthoringState.REVIEW,
    phrase: 'Каталог',
    failureCode: null,
    privateChatId: '42',
    botStatusMessageId: null,
    notificationPending: true,
    notificationKind: 'ready',
    notificationRevision: 7,
    notificationLockedAt: null,
    notificationLockToken: null,
    notificationDispatchStartedAt: null,
    rule: {
      currentContentRevision: { text: '**Ответ**', textFormat: 'markdown', _count: { assets: 2 } },
    },
    ...overrides,
  };
}

const readyJob = {
  version: 1 as const,
  kind: 'notify' as const,
  sessionId: 'session-1',
  notification: 'ready' as const,
  requestedAt: '2026-08-29T12:00:00.000Z',
};

describe('PublisherAutoReplyAuthoringDeliveryService', () => {
  it('does not clear a newer notification revision after an older send completes', async () => {
    const updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = {
      publisherAutoReplyAuthoringSession: {
        findUnique: jest.fn().mockResolvedValue(notificationSession()),
        updateMany,
      },
    };
    const maxClient = {
      sendMessageImmediateWithId: jest
        .fn()
        .mockImplementation(
          async (_chatId: string, _text: string, options: { beforeSend?: () => Promise<void> }) => {
            await options.beforeSend?.();
            return { messageId: 'status-mid-1' };
          },
        ),
    };
    const service = new PublisherAutoReplyAuthoringDeliveryService(
      prisma as never,
      maxClient as never,
    );

    await expect(service.deliver(readyJob)).resolves.toBeUndefined();

    expect(updateMany.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'session-1',
          notificationKind: 'ready',
          notificationRevision: 7,
        }),
        data: expect.objectContaining({ notificationPending: false, notificationKind: null }),
      }),
    );
    const supersededRelease = updateMany.mock.calls[3]?.[0];
    expect(supersededRelease.where).toEqual({
      id: 'session-1',
      notificationLockToken: expect.any(String),
      notificationClaimRevision: 7,
    });
    expect(supersededRelease.data).toEqual({
      notificationLockedAt: null,
      notificationLockToken: null,
      notificationClaimRevision: null,
      notificationDispatchStartedAt: null,
      botStatusMessageId: 'status-mid-1',
    });
    expect(supersededRelease.data).not.toHaveProperty('notificationPending');
    expect(supersededRelease.data).not.toHaveProperty('notificationKind');
  });

  it('quarantines an attempted send as ambiguous instead of retrying it', async () => {
    const updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = {
      publisherAutoReplyAuthoringSession: {
        findUnique: jest.fn().mockResolvedValue(notificationSession()),
        updateMany,
      },
    };
    const maxClient = {
      sendMessageImmediateWithId: jest
        .fn()
        .mockImplementation(
          async (_chatId: string, _text: string, options: { beforeSend?: () => Promise<void> }) => {
            await options.beforeSend?.();
            throw new Error('transport timed out after dispatch');
          },
        ),
    };
    const service = new PublisherAutoReplyAuthoringDeliveryService(
      prisma as never,
      maxClient as never,
    );

    await expect(service.deliver(readyJob)).resolves.toBeUndefined();

    expect(updateMany).toHaveBeenCalledTimes(3);
    expect(updateMany.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'session-1',
          state: PublisherAutoReplyAuthoringState.REVIEW,
          notificationKind: 'ready',
          notificationRevision: 7,
          notificationClaimRevision: 7,
        }),
        data: {
          notificationPending: false,
          notificationKind: null,
          notificationLockedAt: null,
          notificationLockToken: null,
          notificationClaimRevision: null,
          notificationLastAmbiguousRevision: 7,
          notificationDispatchStartedAt: null,
        },
      }),
    );
  });
});
