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
    triggerPhrases: ['Каталог'],
    matchInContext: false,
    fuzzyMatch: false,
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
    action?:
      | 'activate'
      | 'cancel'
      | 'replace_content'
      | 'replace_phrase'
      | 'toggle_context'
      | 'toggle_fuzzy';
    callbackId?: string | null;
    updateId?: string;
  } = {},
): MaxUpdate {
  return {
    updateId:
      params.updateId ?? `callback-${params.actorUserId ?? '42'}-${params.token ?? 'token-1'}`,
    botId: 'publik_bot',
    type: 'message_callback',
    raw: {
      callback: {
        ...(params.callbackId === null ? {} : { callback_id: params.callbackId ?? 'callback-1' }),
        payload: `ar:${params.action ?? 'cancel'}:${params.token ?? 'token-1'}`,
        user: { user_id: params.actorUserId ?? '42' },
      },
    },
  };
}

function privateMessageUpdate(messageId: string, text = 'Ответ с форматированием'): MaxUpdate {
  return {
    updateId: `update-${messageId}`,
    botId: 'publik_bot',
    type: 'message_created',
    message: {
      messageId,
      chatId: '42',
      senderId: '42',
      text,
      createdAt: NOW.toISOString(),
    },
    raw: {
      message: {
        mid: messageId,
        sender: { user_id: 42 },
        recipient: { chat_id: 42, chat_type: 'dialog' },
        body: { text },
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
    publisherAutoReplyRule: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    publisherAutoReplyTrigger: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const publisherAutoReplyAuthoringSession = {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const publisherAutoReplyAuthoringMessage = { findUnique: jest.fn().mockResolvedValue(null) };
  const prisma = {
    publisherAutoReplyAuthoringSession,
    publisherAutoReplyAuthoringMessage,
    publisherAutoReplyRule: { findFirst: jest.fn() },
    publisherAutoReplyTrigger: { findFirst: jest.fn() },
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

  it('captures normalized multiline phrases in their authored order', async () => {
    const {
      service,
      prisma,
      transactionClient,
      publisherAutoReplyAuthoringSession,
      publisherAutoReplyAuthoringMessage,
      queue,
      privateFlows,
    } = createFixture();
    const awaitingPhrase = authoringSession({
      state: PublisherAutoReplyAuthoringState.AWAITING_PHRASE,
      stageRevision: 1,
      phrase: null,
      normalizedPhrase: null,
      triggerPhrases: [],
      phraseMessageId: null,
    });
    publisherAutoReplyAuthoringMessage.findUnique.mockResolvedValue(null);
    privateFlows.read.mockResolvedValue({
      publisherBotId: 'publik_bot',
      actorUserId: '42',
      flowType: PublisherPrivateFlowType.AUTO_REPLY_AUTHORING,
      flowId: 'session-1',
      leaseToken: 'session-1',
      expiresAt: awaitingPhrase.expiresAt,
    });
    publisherAutoReplyAuthoringSession.findFirst.mockResolvedValue(awaitingPhrase);
    prisma.publisherAutoReplyTrigger.findFirst.mockResolvedValue(null);

    await expect(
      service.observeWebhook(
        privateMessageUpdate('phrase-mid-2', '  ПРАЙС  \n Стоимость услуги  '),
        'webhook-event-phrase-2',
      ),
    ).resolves.toBe(true);

    expect(prisma.publisherAutoReplyTrigger.findFirst).toHaveBeenCalledWith({
      where: {
        chatId: '-100500',
        normalizedPhrase: { in: ['прайс', 'стоимость услуги'] },
        archivedAt: null,
      },
      select: { id: true },
    });
    expect(transactionClient.publisherAutoReplyAuthoringSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'session-1',
          state: PublisherAutoReplyAuthoringState.AWAITING_PHRASE,
          stageRevision: 1,
        },
        data: expect.objectContaining({
          state: PublisherAutoReplyAuthoringState.AWAITING_CONTENT,
          phrase: 'ПРАЙС',
          normalizedPhrase: 'прайс',
          triggerPhrases: ['ПРАЙС', 'Стоимость услуги'],
          phraseMessageId: 'phrase-mid-2',
        }),
      }),
    );
    expect(transactionClient.publisherAutoReplyAuthoringMessage.create).toHaveBeenCalledWith({
      data: {
        sessionId: 'session-1',
        publisherBotId: 'publik_bot',
        messageId: 'phrase-mid-2',
        kind: 'PHRASE',
        stageRevision: 1,
      },
    });
    expect(queue.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ notification: 'prompt_content', dedupeKey: 'phrase-mid-2' }),
    );
  });

  it('keeps a fuzzy replacement awaiting phrases when any phrase is too short', async () => {
    const {
      service,
      prisma,
      transactionClient,
      publisherAutoReplyAuthoringSession,
      publisherAutoReplyAuthoringMessage,
      queue,
      privateFlows,
    } = createFixture();
    const awaitingPhrase = authoringSession({
      state: PublisherAutoReplyAuthoringState.AWAITING_PHRASE,
      stageRevision: 4,
      phrase: null,
      normalizedPhrase: null,
      triggerPhrases: [],
      fuzzyMatch: true,
      phraseMessageId: null,
      ruleId: 'rule-1',
      contentRevisionId: 'content-1',
    });
    publisherAutoReplyAuthoringMessage.findUnique.mockResolvedValue(null);
    privateFlows.read.mockResolvedValue({
      publisherBotId: 'publik_bot',
      actorUserId: '42',
      flowType: PublisherPrivateFlowType.AUTO_REPLY_AUTHORING,
      flowId: 'session-1',
      leaseToken: 'session-1',
      expiresAt: awaitingPhrase.expiresAt,
    });
    publisherAutoReplyAuthoringSession.findFirst.mockResolvedValue(awaitingPhrase);

    await expect(
      service.observeWebhook(
        privateMessageUpdate('short-fuzzy-phrase-mid', 'Стоимость\nA-1'),
        null,
      ),
    ).resolves.toBe(true);

    expect(prisma.publisherAutoReplyTrigger.findFirst).not.toHaveBeenCalled();
    const sessionUpdate =
      transactionClient.publisherAutoReplyAuthoringSession.updateMany.mock.calls[0]?.[0];
    expect(sessionUpdate).toEqual(
      expect.objectContaining({
        where: {
          id: 'session-1',
          state: PublisherAutoReplyAuthoringState.AWAITING_PHRASE,
          stageRevision: 4,
        },
        data: expect.objectContaining({
          failureCode: 'fuzzy_phrase_too_short',
          notificationKind: 'prompt_phrase',
          notificationPending: true,
          privateChatId: '42',
        }),
      }),
    );
    expect(sessionUpdate.data).not.toHaveProperty('state');
    expect(transactionClient.publisherAutoReplyRule.updateMany).not.toHaveBeenCalled();
    expect(transactionClient.publisherAutoReplyTrigger.deleteMany).not.toHaveBeenCalled();
    expect(transactionClient.publisherAutoReplyAuthoringMessage.create).toHaveBeenCalledWith({
      data: {
        sessionId: 'session-1',
        publisherBotId: 'publik_bot',
        messageId: 'short-fuzzy-phrase-mid',
        kind: 'PHRASE',
        stageRevision: 4,
      },
    });
    expect(queue.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        notification: 'prompt_phrase',
        dedupeKey: 'short-fuzzy-phrase-mid',
      }),
    );
  });

  it('reorders an alias into primary before the legacy trigger sync can collide', async () => {
    const {
      service,
      prisma,
      transactionClient,
      publisherAutoReplyAuthoringSession,
      publisherAutoReplyAuthoringMessage,
      queue,
      privateFlows,
    } = createFixture();
    const awaitingPhrase = authoringSession({
      state: PublisherAutoReplyAuthoringState.AWAITING_PHRASE,
      stageRevision: 4,
      phrase: null,
      normalizedPhrase: null,
      triggerPhrases: [],
      phraseMessageId: null,
      ruleId: 'rule-1',
      contentRevisionId: 'content-1',
    });
    publisherAutoReplyAuthoringMessage.findUnique.mockResolvedValue(null);
    privateFlows.read.mockResolvedValue({
      publisherBotId: 'publik_bot',
      actorUserId: '42',
      flowType: PublisherPrivateFlowType.AUTO_REPLY_AUTHORING,
      flowId: 'session-1',
      leaseToken: 'session-1',
      expiresAt: awaitingPhrase.expiresAt,
    });
    publisherAutoReplyAuthoringSession.findFirst.mockResolvedValue(awaitingPhrase);
    prisma.publisherAutoReplyTrigger.findFirst.mockResolvedValue(null);
    let oldAliasStillExists = true;
    transactionClient.publisherAutoReplyTrigger.deleteMany.mockImplementation(async () => {
      oldAliasStillExists = false;
      return { count: 1 };
    });
    transactionClient.publisherAutoReplyRule.updateMany.mockImplementation(async () => {
      if (oldAliasStillExists) {
        throw Object.assign(new Error('duplicate normalized phrase'), { code: 'P2002' });
      }
      return { count: 1 };
    });

    await expect(
      service.observeWebhook(privateMessageUpdate('reordered-phrase-mid', 'Стоимость\nЦена'), null),
    ).resolves.toBe(true);

    expect(transactionClient.publisherAutoReplyTrigger.deleteMany).toHaveBeenCalledWith({
      where: { ruleId: 'rule-1', position: { gt: 0 } },
    });
    expect(
      transactionClient.publisherAutoReplyTrigger.deleteMany.mock.invocationCallOrder[0],
    ).toBeLessThan(
      transactionClient.publisherAutoReplyRule.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(transactionClient.publisherAutoReplyRule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          phrase: 'Стоимость',
          normalizedPhrase: 'стоимость',
        }),
      }),
    );
    expect(transactionClient.publisherAutoReplyTrigger.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          ruleId: 'rule-1',
          position: 1,
          phrase: 'Цена',
          normalizedPhrase: 'цена',
        }),
      ],
    });
    expect(queue.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        notification: 'ready',
        dedupeKey: 'reordered-phrase-mid',
      }),
    );
  });

  it('recovers the winning notification instead of swallowing a message-ledger P2002', async () => {
    const {
      service,
      prisma,
      transactionClient,
      publisherAutoReplyAuthoringSession,
      publisherAutoReplyAuthoringMessage,
      queue,
      privateFlows,
    } = createFixture();
    const awaitingPhrase = authoringSession({
      state: PublisherAutoReplyAuthoringState.AWAITING_PHRASE,
      stageRevision: 4,
      phrase: null,
      normalizedPhrase: null,
      triggerPhrases: [],
      phraseMessageId: null,
      ruleId: 'rule-1',
      contentRevisionId: 'content-1',
    });
    publisherAutoReplyAuthoringMessage.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ sessionId: 'session-1' });
    privateFlows.read.mockResolvedValue({
      publisherBotId: 'publik_bot',
      actorUserId: '42',
      flowType: PublisherPrivateFlowType.AUTO_REPLY_AUTHORING,
      flowId: 'session-1',
      leaseToken: 'session-1',
      expiresAt: awaitingPhrase.expiresAt,
    });
    publisherAutoReplyAuthoringSession.findFirst.mockResolvedValue(awaitingPhrase);
    publisherAutoReplyAuthoringSession.findUnique.mockResolvedValue(
      authoringSession({
        state: PublisherAutoReplyAuthoringState.REVIEW,
        stageRevision: 5,
        phrase: 'Стоимость',
        normalizedPhrase: 'стоимость',
        triggerPhrases: ['Стоимость', 'Цена'],
        phraseMessageId: 'concurrent-phrase-mid',
        ruleId: 'rule-1',
        contentRevisionId: 'content-1',
        notificationKind: 'ready',
        notificationPending: true,
      }),
    );
    prisma.publisherAutoReplyTrigger.findFirst.mockResolvedValue(null);
    transactionClient.publisherAutoReplyAuthoringMessage.create.mockRejectedValueOnce(
      Object.assign(new Error('message already consumed'), { code: 'P2002' }),
    );

    await expect(
      service.observeWebhook(
        privateMessageUpdate('concurrent-phrase-mid', 'Стоимость\nЦена'),
        null,
      ),
    ).resolves.toBe(true);

    expect(publisherAutoReplyAuthoringMessage.findUnique).toHaveBeenNthCalledWith(2, {
      where: {
        publisherBotId_messageId: {
          publisherBotId: 'publik_bot',
          messageId: 'concurrent-phrase-mid',
        },
      },
      select: { sessionId: true },
    });
    expect(queue.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        notification: 'ready',
        dedupeKey: 'duplicate-concurrent-phrase-mid',
      }),
    );
  });

  it.each([
    ['toggle_context', { matchInContext: true, fuzzyMatch: false }],
    ['toggle_fuzzy', { matchInContext: false, fuzzyMatch: true }],
  ] as const)('applies the %s callback to both session and draft rule', async (action, modes) => {
    const { service, transactionClient, publisherAutoReplyAuthoringSession, queue, privateFlows } =
      createFixture();
    publisherAutoReplyAuthoringSession.findFirst.mockResolvedValue(
      authoringSession({
        state: PublisherAutoReplyAuthoringState.REVIEW,
        ruleId: 'rule-1',
        contentRevisionId: 'content-1',
      }),
    );

    await expect(service.observeWebhook(callbackUpdate({ action }), null)).resolves.toBe(true);

    expect(transactionClient.publisherAutoReplyAuthoringSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining(modes) }),
    );
    expect(transactionClient.publisherAutoReplyRule.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'rule-1',
        chatId: '-100500',
        currentContentRevisionId: 'content-1',
        archivedAt: { not: null },
      },
      data: expect.objectContaining({ ...modes, version: { increment: 1 } }),
    });
    expect(transactionClient.publisherAutoReplyAuthoringMessage.create).toHaveBeenCalledWith({
      data: {
        sessionId: 'session-1',
        publisherBotId: 'publik_bot',
        messageId: 'callback-id:callback-1',
        kind: 'CALLBACK',
        stageRevision: 2,
      },
    });
    expect(privateFlows.renew).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: 'session-1', leaseToken: 'session-1' }),
      transactionClient,
    );
    expect(queue.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        notification: 'ready',
        callbackId: 'callback-1',
      }),
    );
  });

  it('does not apply a previously consumed toggle callback again', async () => {
    const {
      service,
      transactionClient,
      publisherAutoReplyAuthoringSession,
      publisherAutoReplyAuthoringMessage,
      queue,
    } = createFixture();
    publisherAutoReplyAuthoringSession.findFirst.mockResolvedValue(
      authoringSession({
        state: PublisherAutoReplyAuthoringState.REVIEW,
        stageRevision: 5,
        ruleId: 'rule-1',
        contentRevisionId: 'content-1',
        matchInContext: true,
        callbackId: 'another-callback',
        notificationPending: false,
      }),
    );
    publisherAutoReplyAuthoringMessage.findUnique.mockResolvedValue({ sessionId: 'session-1' });

    await expect(
      service.observeWebhook(callbackUpdate({ action: 'toggle_context' }), null, {
        duplicate: true,
      }),
    ).resolves.toBe(true);

    expect(publisherAutoReplyAuthoringMessage.findUnique).toHaveBeenCalledWith({
      where: {
        publisherBotId_messageId: {
          publisherBotId: 'publik_bot',
          messageId: 'callback-id:callback-1',
        },
      },
      select: { sessionId: true },
    });
    expect(transactionClient.publisherAutoReplyAuthoringSession.updateMany).not.toHaveBeenCalled();
    expect(transactionClient.publisherAutoReplyRule.updateMany).not.toHaveBeenCalled();
    expect(queue.enqueueNotification).not.toHaveBeenCalled();
  });

  it('uses the webhook update id to fence duplicate toggles without a callback id', async () => {
    const {
      service,
      transactionClient,
      publisherAutoReplyAuthoringSession,
      publisherAutoReplyAuthoringMessage,
    } = createFixture();
    publisherAutoReplyAuthoringSession.findFirst.mockResolvedValue(
      authoringSession({
        state: PublisherAutoReplyAuthoringState.REVIEW,
        ruleId: 'rule-1',
        contentRevisionId: 'content-1',
      }),
    );
    const callback = callbackUpdate({
      action: 'toggle_context',
      callbackId: null,
      updateId: 'callback-update-without-id',
    });

    await expect(service.observeWebhook(callback, null)).resolves.toBe(true);
    expect(transactionClient.publisherAutoReplyAuthoringMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        messageId: 'callback-update:callback-update-without-id',
        kind: 'CALLBACK',
      }),
    });

    publisherAutoReplyAuthoringMessage.findUnique.mockResolvedValue({ sessionId: 'session-1' });
    await expect(service.observeWebhook(callback, null, { duplicate: true })).resolves.toBe(true);

    expect(transactionClient.publisherAutoReplyAuthoringSession.updateMany).toHaveBeenCalledTimes(
      1,
    );
    expect(transactionClient.publisherAutoReplyRule.updateMany).toHaveBeenCalledTimes(1);
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
