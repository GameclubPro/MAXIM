import type { MaxUpdate } from '@maxim/contracts';
import { ConflictException } from '@nestjs/common';
import { PublisherPostImportStatus, PublisherPrivateFlowType } from '../prisma/prisma-client';
import { PublisherPostImportService } from './publisher-post-import.service';

const NOW = new Date('2026-08-29T12:00:00.000Z');
const USER = { userId: '42', username: null, displayName: null };

function session(status: PublisherPostImportStatus) {
  return {
    id: 'session-1',
    publisherBotId: 'publik_bot',
    actorUserId: '42',
    requestId: 'request_123456',
    startToken: 'token_1234567890',
    status,
    privateChatId: '42',
    incomingMessageId: status === PublisherPostImportStatus.WAITING ? null : 'source-mid-1',
    publicationId: null,
    failureCode: null,
    omissions: [],
    captureGuardUntil: new Date(NOW.getTime() + 60_000),
    lockedAt: null,
    lockToken: null,
    expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    createdAt: NOW,
    updatedAt: NOW,
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
      text: '',
      createdAt: NOW.toISOString(),
    },
    raw: {
      message: {
        mid: messageId,
        sender: { user_id: 42 },
        recipient: { chat_id: 42, chat_type: 'dialog' },
        link: { type: 'forward', message: { mid: 'source-mid-1', body: { text: 'Post' } } },
        body: { text: '' },
      },
    },
  };
}

function cancelUpdate(): MaxUpdate {
  return {
    updateId: 'callback-cancel-1',
    botId: 'publik_bot',
    type: 'message_callback',
    raw: {
      callback: {
        callback_id: 'callback-1',
        payload: 'pi_cancel_token_1234567890',
        user: { user_id: 42 },
      },
    },
  };
}

function fixture() {
  const publisherPostImportSession = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  };
  const tx = { publisherPostImportSession };
  const prisma = {
    publisherPostImportSession,
    publicationAsset: { findFirst: jest.fn() },
    $transaction: jest.fn((operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
  };
  const queue = {
    enqueueProcess: jest.fn().mockResolvedValue(undefined),
    enqueueNotification: jest.fn().mockResolvedValue(undefined),
  };
  const privateFlows = {
    acquire: jest.fn(),
    read: jest.fn(),
    release: jest.fn().mockResolvedValue(true),
  };
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === 'MAX_PUBLISHER_BOT_ID') return 'publik_bot';
      if (key === 'PUBLISHER_POST_IMPORT_ENABLED') return true;
      return fallback;
    }),
  };
  return {
    service: new PublisherPostImportService(
      prisma as never,
      queue as never,
      config as never,
      privateFlows as never,
    ),
    publisherPostImportSession,
    queue,
    privateFlows,
  };
}

describe('PublisherPostImportService private flow fencing', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not create a session when another private flow owns the actor', async () => {
    const { service, publisherPostImportSession, privateFlows } = fixture();
    publisherPostImportSession.findUnique.mockResolvedValue(null);
    publisherPostImportSession.findFirst.mockResolvedValue(null);
    privateFlows.acquire.mockResolvedValue(null);

    await expect(service.create(USER, { requestId: 'request_123456' })).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(privateFlows.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ flowType: PublisherPrivateFlowType.POST_IMPORT }),
      expect.any(Object),
    );
    expect(publisherPostImportSession.create).not.toHaveBeenCalled();
  });

  it('does not reacquire the private flow for a terminal request replay', async () => {
    const { service, publisherPostImportSession, privateFlows } = fixture();
    publisherPostImportSession.findUnique.mockResolvedValue(
      session(PublisherPostImportStatus.CANCELED),
    );

    await expect(service.create(USER, { requestId: 'request_123456' })).resolves.toMatchObject({
      id: 'session-1',
      status: 'canceled',
    });
    expect(privateFlows.acquire).not.toHaveBeenCalled();
  });

  it('keeps the second-forward shield after capture released its input lease', async () => {
    const { service, publisherPostImportSession, privateFlows } = fixture();
    publisherPostImportSession.findUnique.mockResolvedValue(null);
    publisherPostImportSession.findFirst.mockResolvedValue(
      session(PublisherPostImportStatus.PROCESSING),
    );
    privateFlows.read.mockResolvedValue(null);

    await expect(service.observeWebhook(forwardedUpdate(), null)).resolves.toBe(true);
    expect(privateFlows.acquire).not.toHaveBeenCalled();
  });

  it('does not release a callback lease when the cancel transition lost its race', async () => {
    const { service, publisherPostImportSession, queue, privateFlows } = fixture();
    publisherPostImportSession.findFirst.mockResolvedValue(
      session(PublisherPostImportStatus.WAITING),
    );
    publisherPostImportSession.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.observeWebhook(cancelUpdate(), null)).resolves.toBe(true);
    expect(privateFlows.release).not.toHaveBeenCalled();
    expect(queue.enqueueNotification).not.toHaveBeenCalled();
  });
});
