import type { MaxUpdate } from '@maxim/contracts';
import {
  PublisherAutoReplyAuthoringState,
  PublisherPrivateFlowType,
} from '../prisma/prisma-client';
import { PublisherAutoReplyAuthoringService } from './publisher-auto-reply-authoring.service';

const NOW = new Date('2026-08-29T12:00:00.000Z');

function authoringSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    publisherBotId: 'publik_bot',
    actorUserId: '42',
    requestId: 'request_123456',
    startToken: 'token-1',
    targetChatId: '-100500',
    state: PublisherAutoReplyAuthoringState.AWAITING_CONTENT,
    stageRevision: 2,
    privateChatId: '42',
    phrase: 'Каталог',
    normalizedPhrase: 'каталог',
    phraseMessageId: 'phrase-mid-1',
    contentMessageId: null,
    sourceWebhookEventId: null,
    ruleId: null,
    contentRevisionId: null,
    callbackId: null,
    notificationKind: 'prompt_content',
    notificationPending: false,
    notificationRevision: 2,
    notificationLockedAt: null,
    notificationLockToken: null,
    notificationDispatchStartedAt: null,
    botStatusMessageId: null,
    failureCode: null,
    lockedAt: null,
    lockToken: null,
    captureGuardUntil: null,
    expiresAt: new Date(NOW.getTime() + 15 * 60_000),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function callbackUpdate(
  params: {
    actorUserId?: string;
    token?: string;
    action?: 'activate' | 'cancel' | 'replace_content' | 'replace_phrase';
  } = {},
): MaxUpdate {
  return {
    updateId: `callback-${params.actorUserId ?? '42'}-${params.token ?? 'token-1'}`,
    botId: 'publik_bot',
    type: 'message_callback',
    raw: {
      callback: {
        callback_id: 'callback-1',
        payload: `ar:${params.action ?? 'cancel'}:${params.token ?? 'token-1'}`,
        user: { user_id: params.actorUserId ?? '42' },
      },
    },
  };
}

function privateMessageUpdate(messageId: string): MaxUpdate {
  return {
    updateId: `update-${messageId}`,
    botId: 'publik_bot',
    type: 'message_created',
    message: {
      messageId,
      chatId: '42',
      senderId: '42',
      text: 'Ответ с форматированием',
      createdAt: NOW.toISOString(),
    },
    raw: {
      message: {
        mid: messageId,
        sender: { user_id: 42 },
        recipient: { chat_id: 42, chat_type: 'dialog' },
        body: { text: 'Ответ с форматированием' },
      },
    },
  };
}

function createFixture() {
  const transactionClient = {
    publisherAutoReplyAuthoringSession: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    publisherAutoReplyAuthoringMessage: {
      create: jest.fn().mockResolvedValue({}),
    },
  };
  const publisherAutoReplyAuthoringSession = {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const publisherAutoReplyAuthoringMessage = { findUnique: jest.fn() };
  const prisma = {
    publisherAutoReplyAuthoringSession,
    publisherAutoReplyAuthoringMessage,
    publisherAutoReplyRule: { findFirst: jest.fn() },
    webhookEvent: { findUnique: jest.fn() },
    $transaction: jest.fn((operation: (tx: typeof transactionClient) => Promise<unknown>) =>
      operation(transactionClient),
    ),
  };
  const queue = {
    enqueueProcessContent: jest.fn().mockResolvedValue(undefined),
    enqueueActivation: jest.fn().mockResolvedValue(undefined),
    enqueueNotification: jest.fn().mockResolvedValue(undefined),
  };
  const privateFlows = {
    acquire: jest.fn(),
    read: jest.fn(),
    renew: jest.fn().mockResolvedValue(true),
    release: jest.fn().mockResolvedValue(true),
  };
  const config = {
    get: jest.fn((key: string) => (key === 'MAX_PUBLISHER_BOT_ID' ? 'publik_bot' : undefined)),
  };
  return {
    service: new PublisherAutoReplyAuthoringService(
      prisma as never,
      queue as never,
      privateFlows as never,
      config as never,
    ),
    prisma,
    transactionClient,
    publisherAutoReplyAuthoringSession,
    publisherAutoReplyAuthoringMessage,
    queue,
    privateFlows,
  };
}

describe('PublisherAutoReplyAuthoringService callback and message fences', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('requires the callback actor, token, and live expiry to identify one session', async () => {
    const { service, publisherAutoReplyAuthoringSession, queue, privateFlows } = createFixture();
    const stored = authoringSession();
    publisherAutoReplyAuthoringSession.findFirst.mockImplementation(
      async (args: {
        where: { startToken: string; actorUserId: string; expiresAt: { gt: Date } };
      }) =>
        args.where.startToken === stored.startToken &&
        args.where.actorUserId === stored.actorUserId &&
        stored.expiresAt > args.where.expiresAt.gt
          ? stored
          : null,
    );

    await expect(service.observeWebhook(callbackUpdate({ actorUserId: '99' }), null)).resolves.toBe(
      true,
    );
    await expect(
      service.observeWebhook(callbackUpdate({ token: 'another-token' }), null),
    ).resolves.toBe(true);
    jest.setSystemTime(new Date(stored.expiresAt.getTime() + 1));
    await expect(service.observeWebhook(callbackUpdate(), null)).resolves.toBe(true);

    expect(publisherAutoReplyAuthoringSession.findFirst).toHaveBeenCalledTimes(3);
    expect(publisherAutoReplyAuthoringSession.updateMany).not.toHaveBeenCalled();
    expect(privateFlows.release).not.toHaveBeenCalled();
    expect(queue.enqueueNotification).not.toHaveBeenCalled();
  });

  it('accepts a valid callback only for its owner and releases the exact flow lease', async () => {
    const { service, publisherAutoReplyAuthoringSession, queue, privateFlows } = createFixture();
    publisherAutoReplyAuthoringSession.findFirst.mockResolvedValue(
      authoringSession({ state: PublisherAutoReplyAuthoringState.REVIEW }),
    );

    await expect(service.observeWebhook(callbackUpdate(), null)).resolves.toBe(true);

    expect(publisherAutoReplyAuthoringSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'session-1',
          state: PublisherAutoReplyAuthoringState.REVIEW,
          stageRevision: 2,
        }),
        data: expect.objectContaining({ state: PublisherAutoReplyAuthoringState.CANCELED }),
      }),
    );
    expect(privateFlows.release).toHaveBeenCalledWith({
      publisherBotId: 'publik_bot',
      actorUserId: '42',
      flowType: PublisherPrivateFlowType.AUTO_REPLY_AUTHORING,
      flowId: 'session-1',
      leaseToken: 'session-1',
    });
    expect(queue.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        notification: 'canceled',
        callbackId: 'callback-1',
      }),
    );
  });

  it('uses the durable message ledger before consulting the actor current lease', async () => {
    const {
      service,
      publisherAutoReplyAuthoringSession,
      publisherAutoReplyAuthoringMessage,
      queue,
      privateFlows,
    } = createFixture();
    publisherAutoReplyAuthoringMessage.findUnique.mockResolvedValue({ sessionId: 'session-1' });
    publisherAutoReplyAuthoringSession.findUnique.mockResolvedValue(
      authoringSession({
        state: PublisherAutoReplyAuthoringState.PROCESSING,
        contentMessageId: 'content-mid-1',
        notificationKind: 'processing',
        notificationPending: true,
      }),
    );

    await expect(
      service.observeWebhook(privateMessageUpdate('content-mid-1'), null, { duplicate: true }),
    ).resolves.toBe(true);

    expect(privateFlows.read).not.toHaveBeenCalled();
    expect(publisherAutoReplyAuthoringSession.findFirst).not.toHaveBeenCalled();
    expect(queue.enqueueProcessContent).toHaveBeenCalledWith('session-1');
    expect(queue.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        notification: 'processing',
        dedupeKey: 'duplicate-content-mid-1',
      }),
    );
  });

  it('captures an unledgered duplicate through the active lease and records it transactionally', async () => {
    const {
      service,
      transactionClient,
      publisherAutoReplyAuthoringSession,
      publisherAutoReplyAuthoringMessage,
      queue,
      privateFlows,
    } = createFixture();
    const active = authoringSession();
    publisherAutoReplyAuthoringMessage.findUnique.mockResolvedValue(null);
    privateFlows.read.mockResolvedValue({
      publisherBotId: 'publik_bot',
      actorUserId: '42',
      flowType: PublisherPrivateFlowType.AUTO_REPLY_AUTHORING,
      flowId: 'session-1',
      leaseToken: 'session-1',
      expiresAt: active.expiresAt,
    });
    publisherAutoReplyAuthoringSession.findFirst.mockResolvedValue(active);

    await expect(
      service.observeWebhook(privateMessageUpdate('content-mid-2'), 'webhook-event-2', {
        duplicate: true,
      }),
    ).resolves.toBe(true);

    expect(privateFlows.read).toHaveBeenCalledWith('publik_bot', '42');
    expect(transactionClient.publisherAutoReplyAuthoringSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'session-1', state: active.state, stageRevision: 2 },
        data: expect.objectContaining({
          state: PublisherAutoReplyAuthoringState.PROCESSING,
          contentMessageId: 'content-mid-2',
          sourceWebhookEventId: 'webhook-event-2',
        }),
      }),
    );
    expect(transactionClient.publisherAutoReplyAuthoringMessage.create).toHaveBeenCalledWith({
      data: {
        sessionId: 'session-1',
        publisherBotId: 'publik_bot',
        messageId: 'content-mid-2',
        kind: 'CONTENT',
        stageRevision: 2,
      },
    });
    expect(privateFlows.renew).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: 'session-1', leaseToken: 'session-1' }),
      transactionClient,
    );
    expect(queue.enqueueProcessContent).toHaveBeenCalledWith('session-1');
  });
});
