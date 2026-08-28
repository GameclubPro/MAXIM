import type { MaxUpdate } from '@maxim/contracts';
import { PublisherPostImportStatus } from '../prisma/prisma-client';
import { PublisherPostImportService } from './publisher-post-import.service';

const NOW = new Date('2026-08-28T12:00:00.000Z');

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    publisherBotId: 'publik_bot',
    actorUserId: '42',
    requestId: 'request_123456',
    startToken: 'start-token-1',
    status: PublisherPostImportStatus.WAITING,
    privateChatId: '42',
    incomingMessageId: null,
    sourceWebhookEventId: null,
    botStatusMessageId: null,
    callbackId: null,
    publicationId: null,
    failureCode: null,
    omissions: [],
    capturedAt: null,
    captureGuardUntil: null,
    lockedAt: null,
    lockToken: null,
    expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function forwardedUpdate(messageId = 'incoming-mid-1'): MaxUpdate {
  return {
    updateId: `update-${messageId}`,
    botId: 'publik_bot',
    type: 'message_created',
    message: {
      messageId,
      chatId: '42',
      senderId: '42',
      text: 'outer text must be ignored by processing',
      createdAt: NOW.toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        mid: messageId,
        sender: { user_id: 42 },
        recipient: { chat_id: 42, chat_type: 'dialog' },
        body: { text: 'outer text must be ignored by processing' },
        link: {
          type: 'forward',
          message: { mid: 'source-mid-1', text: 'source text', attachments: [] },
        },
      },
    },
  };
}

function createFixture() {
  const publisherPostImportSession = {
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
  };
  const prisma = {
    publisherPostImportSession,
    publicationAsset: { findFirst: jest.fn() },
  };
  const queue = {
    enqueueProcess: jest.fn().mockResolvedValue(undefined),
    enqueueNotification: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === 'MAX_PUBLISHER_BOT_ID') return 'publik_bot';
      if (key === 'PUBLISHER_POST_IMPORT_ENABLED') return true;
      return fallback;
    }),
  };
  return {
    service: new PublisherPostImportService(prisma as never, queue as never, config as never),
    publisherPostImportSession,
    queue,
  };
}

describe('PublisherPostImportService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('atomically captures the first private forward and enqueues only identifiers', async () => {
    const { service, publisherPostImportSession, queue } = createFixture();
    publisherPostImportSession.findFirst.mockResolvedValue(session());
    publisherPostImportSession.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(service.observeWebhook(forwardedUpdate(), 'webhook-event-1')).resolves.toBe(true);

    expect(publisherPostImportSession.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'session-1',
          status: PublisherPostImportStatus.WAITING,
          incomingMessageId: null,
        }),
        data: expect.objectContaining({
          status: PublisherPostImportStatus.PROCESSING,
          incomingMessageId: 'incoming-mid-1',
          sourceWebhookEventId: 'webhook-event-1',
        }),
      }),
    );
    expect(publisherPostImportSession.updateMany.mock.calls.at(-1)?.[0].data).not.toHaveProperty(
      'sourcePayload',
    );
    expect(queue.enqueueProcess).toHaveBeenCalledWith('session-1');
    expect(queue.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ notification: 'processing', sessionId: 'session-1' }),
    );
  });

  it('consumes direct text while waiting and asks for a forward through the queue', async () => {
    const { service, publisherPostImportSession, queue } = createFixture();
    publisherPostImportSession.findFirst.mockResolvedValue(session());
    const update = forwardedUpdate();
    const rawMessage = (update.raw as { message: Record<string, unknown> }).message;
    rawMessage.link = undefined;

    await expect(service.observeWebhook(update)).resolves.toBe(true);

    expect(queue.enqueueProcess).not.toHaveBeenCalled();
    expect(queue.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        notification: 'need_forward',
      }),
    );
  });

  it('does not let duplicate import A capture a newer waiting session B', async () => {
    const { service, publisherPostImportSession, queue } = createFixture();
    publisherPostImportSession.findUnique.mockResolvedValue(
      session({
        id: 'session-a',
        status: PublisherPostImportStatus.READY,
        incomingMessageId: 'incoming-mid-a',
        publicationId: 'publication-a',
      }),
    );
    publisherPostImportSession.findFirst.mockResolvedValue(
      session({ id: 'session-b', requestId: 'request_b_123456' }),
    );

    await expect(
      service.observeWebhook(forwardedUpdate('incoming-mid-a'), null, { duplicate: true }),
    ).resolves.toBe(true);

    expect(publisherPostImportSession.findFirst).not.toHaveBeenCalled();
    expect(
      publisherPostImportSession.updateMany.mock.calls.some(
        ([args]) => args.data?.status === PublisherPostImportStatus.PROCESSING,
      ),
    ).toBe(false);
    expect(queue.enqueueProcess).not.toHaveBeenCalled();
  });

  it('keeps the second-forward shield after a terminal result', async () => {
    const { service, publisherPostImportSession, queue } = createFixture();
    publisherPostImportSession.findFirst.mockResolvedValue(
      session({
        status: PublisherPostImportStatus.READY,
        incomingMessageId: 'first-mid',
        captureGuardUntil: new Date(NOW.getTime() + 30_000),
      }),
    );

    await expect(service.observeWebhook(forwardedUpdate('second-mid'))).resolves.toBe(true);

    expect(queue.enqueueProcess).not.toHaveBeenCalled();
    expect(
      publisherPostImportSession.updateMany.mock.calls.some(
        ([args]) => args.data?.status === PublisherPostImportStatus.PROCESSING,
      ),
    ).toBe(false);
  });

  it('does not let a terminal forward shield consume unrelated direct text', async () => {
    const { service, publisherPostImportSession, queue } = createFixture();
    publisherPostImportSession.findFirst.mockResolvedValue(
      session({
        status: PublisherPostImportStatus.READY,
        incomingMessageId: 'first-mid',
        captureGuardUntil: new Date(NOW.getTime() + 30_000),
      }),
    );
    const update = forwardedUpdate('direct-mid');
    const rawMessage = (update.raw as { message: Record<string, unknown> }).message;
    rawMessage.link = undefined;

    await expect(service.observeWebhook(update)).resolves.toBe(false);

    expect(queue.enqueueNotification).not.toHaveBeenCalled();
    expect(queue.enqueueProcess).not.toHaveBeenCalled();
  });

  it('retains and exposes an expired state before bounded cleanup', async () => {
    const { service, publisherPostImportSession } = createFixture();
    publisherPostImportSession.findFirst.mockResolvedValue(
      session({
        status: PublisherPostImportStatus.EXPIRED,
        expiresAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
      }),
    );

    await expect(
      service.getCurrent({ userId: '42', username: null, displayName: null }),
    ).resolves.toMatchObject({ session: { status: 'expired' } });

    expect(publisherPostImportSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PublisherPostImportStatus.EXPIRED,
          expiresAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
        }),
      }),
    );
  });

  it('returns READY only while its linked publication is still a draft', async () => {
    const { service, publisherPostImportSession } = createFixture();
    publisherPostImportSession.findFirst.mockResolvedValue(null);

    await service.getCurrent({ userId: '42', username: null, displayName: null });

    expect(publisherPostImportSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            {
              status: PublisherPostImportStatus.READY,
              publication: { is: { lifecycle: 'DRAFT' } },
            },
          ]),
        }),
      }),
    );
  });

  it('builds the waiting handoff against the exact Publisher bot on admin roles', async () => {
    const { service, publisherPostImportSession } = createFixture();
    publisherPostImportSession.findFirst.mockResolvedValue(session());

    await expect(
      service.getCurrent({ userId: '42', username: null, displayName: null }),
    ).resolves.toMatchObject({
      session: {
        botUrl: 'https://max.ru/publik_bot?start=pi_start-token-1',
      },
    });
  });

  it('resolves a ready launcher token only inside the authenticated actor scope', async () => {
    const { service, publisherPostImportSession } = createFixture();
    publisherPostImportSession.findFirst.mockResolvedValue(
      session({
        status: PublisherPostImportStatus.READY,
        publicationId: 'publication-1',
      }),
    );

    await expect(
      service.getByToken({ userId: '42', username: null, displayName: null }, 'start-token-1'),
    ).resolves.toMatchObject({
      session: { status: 'ready', publicationId: 'publication-1' },
    });
    expect(publisherPostImportSession.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        startToken: 'start-token-1',
        publisherBotId: 'publik_bot',
        actorUserId: '42',
        status: PublisherPostImportStatus.READY,
        publication: { is: { lifecycle: 'DRAFT' } },
      }),
    });
  });
});
