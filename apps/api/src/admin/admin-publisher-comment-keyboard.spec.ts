import { AdminService } from './admin.service';
import { PublisherCommentKeyboardRouting } from './publisher-comment-keyboard-routing';

function createService(rows: Array<{ id: string; action: string; payload: unknown }>) {
  const prisma = {
    auditLog: {
      findMany: jest.fn().mockResolvedValue(rows),
    },
  };
  const maxClient = {
    editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
  };
  const queue = {
    enqueueKeyboardEdit: jest.fn().mockResolvedValue(undefined),
  };
  const registry = {
    getPublisherBotDescriptor: () => ({ id: 'publik-bot' }),
    getBotById: jest.fn(),
  };
  const service = new AdminService(
    prisma as never,
    maxClient as never,
    { invalidate: jest.fn() } as never,
    {
      get: jest.fn((key: string) => {
        if (key === 'MAX_BOT_TOKEN') return 'main-bot-token-test';
        if (key === 'MAX_BOT_ID') return 'main-bot';
        if (key === 'APP_BASE_URL') return 'https://major-maksimov.ru';
        return undefined;
      }),
      getOrThrow: jest.fn((key: string) => {
        if (key === 'MAX_BOT_TOKEN') return 'main-bot-token-test';
        throw new Error(`Missing test config: ${key}`);
      }),
    } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    registry as never,
  );
  Object.assign(service as object, {
    publisherChatCommentQueueService: queue,
    publisherCommentKeyboardRouting: new PublisherCommentKeyboardRouting(
      registry as never,
      queue as never,
      { warn: jest.fn() } as never,
    ),
  });
  return { maxClient, prisma, queue, service };
}

describe('AdminService publisher-origin comment keyboard routing', () => {
  it('queues an exact Publik edit for a chat reply while rebuilding its link for the main bot', async () => {
    const harness = createService([
      {
        id: 'audit-1',
        action: 'AUTO_ATTACH_CHAT_COMMENTS',
        payload: {
          threadId: 'thread-1',
          messageId: 'admin-message-1',
          deliveryMode: 'reply_message',
          replyMessageId: 'publik-reply-1',
          botId: 'publik-bot',
          dialogBotId: 'main-bot',
        },
      },
    ]);

    await (harness.service as any).syncChatCommentsButtonCount('chat-1', 'thread-1', 7);

    expect(harness.queue.enqueueKeyboardEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'chat',
        readinessFeature: 'chat_comments',
        messageId: 'publik-reply-1',
        requiredBotId: 'publik-bot',
        dialogBotId: 'main-bot',
        countSnapshot: 7,
        buttons: [[expect.objectContaining({ text: '💬 Комментарии · 7' })]],
      }),
    );
    expect(harness.maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
  });

  it('queues an exact Publik edit for a publisher-origin channel post', async () => {
    const harness = createService([
      {
        id: 'audit-2',
        action: 'PUBLISH_CHANNEL_ENGAGEMENT',
        payload: {
          threadId: 'thread-2',
          messageId: 'publik-channel-post-1',
          botId: 'publik-bot',
          dialogBotId: 'main-bot',
          includeCommentsButton: true,
          commentsButtonText: 'Обсуждение',
          includeSuggestButton: false,
          customButtons: [],
        },
      },
    ]);

    await (harness.service as any).syncChannelCommentsButtonCount('channel-1', 'thread-2', 12);

    expect(harness.queue.enqueueKeyboardEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'channel',
        readinessFeature: 'publication',
        messageId: 'publik-channel-post-1',
        requiredBotId: 'publik-bot',
        dialogBotId: 'main-bot',
        countSnapshot: 12,
        commentsButton: expect.objectContaining({ baseText: 'Обсуждение' }),
      }),
    );
    expect(harness.maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
  });
});
