import { AdminService } from './admin.service';
import { PublisherChatCommentAdmissionError } from '../publisher/publisher-chat-comment.queue';
import { PublisherCommentKeyboardRouting } from './publisher-comment-keyboard-routing';

const keyboardRoute = {
  chatId: 'chat-1',
  messageId: 'publik-reply-1',
  threadId: 'thread-1',
  entityType: 'chat' as const,
  botId: 'publik-bot',
  dialogBotId: 'main-bot',
  buttons: [[{ type: 'link' as const, text: 'Комментарии', url: 'https://example.test' }]],
  commentsButton: { rowIndex: 0, columnIndex: 0, baseText: 'Комментарии' },
  count: 7,
};

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
  const publisherDialogLinkService = {
    buildChatDialogButton: jest.fn(
      (_chatId: string, _type: string, _threadId: string, text: string) => ({
        type: 'link' as const,
        text,
        url: 'https://max.ru/publik-bot?startapp=publisher-signed',
      }),
    ),
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
    publisherDialogLinkService,
  });
  return { maxClient, prisma, publisherDialogLinkService, queue, service };
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

  it('routes same-thread Major and Publisher counters only to their owning buttons', async () => {
    const harness = createService([
      {
        id: 'major-audit',
        action: 'AUTO_ATTACH_CHAT_COMMENTS',
        payload: {
          threadId: 'shared-thread',
          deliveryMode: 'reply_message',
          replyMessageId: 'major-reply',
          botId: 'main-bot',
          dialogBotId: 'main-bot',
        },
      },
      {
        id: 'publisher-audit',
        action: 'AUTO_ATTACH_CHAT_COMMENTS',
        payload: {
          threadId: 'shared-thread',
          deliveryMode: 'reply_message',
          replyMessageId: 'publisher-reply',
          botId: 'publik-bot',
          publisherBotId: 'publik-bot',
          dialogBotId: 'publik-bot',
          publisherQueueVersion: 1,
        },
      },
    ]);

    await (harness.service as any).syncChatCommentsButtonCount(
      'chat-1',
      'shared-thread',
      8,
      'publisher',
    );

    expect(harness.queue.enqueueKeyboardEdit).toHaveBeenCalledTimes(1);
    expect(harness.queue.enqueueKeyboardEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'publisher-reply',
        requiredBotId: 'publik-bot',
        dialogBotId: 'publik-bot',
        countSnapshot: 8,
        buttons: [
          [
            expect.objectContaining({
              url: 'https://max.ru/publik-bot?startapp=publisher-signed',
            }),
          ],
        ],
      }),
    );
    expect(harness.publisherDialogLinkService.buildChatDialogButton).toHaveBeenCalledTimes(1);
    expect(harness.maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();

    await (harness.service as any).syncChatCommentsButtonCount(
      'chat-1',
      'shared-thread',
      3,
      'moderation',
    );

    expect(harness.queue.enqueueKeyboardEdit).toHaveBeenCalledTimes(1);
    expect(harness.maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
    expect(harness.maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'chat-1',
      'major-reply',
      null,
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: '💬 Комментарии · 3' })]],
      }),
      { botId: 'main-bot' },
    );
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

  it.each(['heartbeat_missing', 'dispatch_disabled'] as const)(
    'treats publisher keyboard admission %s as a clean handled skip',
    async (reason) => {
      const queue = {
        enqueueKeyboardEdit: jest
          .fn()
          .mockRejectedValue(new PublisherChatCommentAdmissionError(reason)),
      };
      const logger = { debug: jest.fn(), warn: jest.fn() };
      const routing = new PublisherCommentKeyboardRouting(
        { getPublisherBotDescriptor: () => ({ id: 'publik-bot' }) } as never,
        queue as never,
        logger as never,
      );

      await expect(routing.tryEnqueue(keyboardRoute)).resolves.toBe(true);

      expect(queue.enqueueKeyboardEdit).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ reason }),
        'Skipped publisher-origin comments counter while admission is closed',
      );
    },
  );

  it('keeps generic publisher keyboard enqueue failures on the existing error path', async () => {
    const failure = new Error('queue unavailable');
    const queue = { enqueueKeyboardEdit: jest.fn().mockRejectedValue(failure) };
    const logger = { debug: jest.fn(), warn: jest.fn() };
    const routing = new PublisherCommentKeyboardRouting(
      { getPublisherBotDescriptor: () => ({ id: 'publik-bot' }) } as never,
      queue as never,
      logger as never,
    );

    await expect(routing.tryEnqueue(keyboardRoute)).rejects.toBe(failure);

    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
