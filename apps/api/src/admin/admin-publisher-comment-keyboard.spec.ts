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
    buildChannelDialogButton: jest.fn(
      (_chatId: string, _type: string, _threadId: string, text: string) => ({
        type: 'link' as const,
        text,
        url: 'https://max.ru/publik-bot?startapp=publisher-channel-signed',
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
  it('queues an exact Publik edit for a chat reply with its Publisher-signed link', async () => {
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
          dialogBotId: 'publik-bot',
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
        dialogBotId: 'publik-bot',
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
          dialogBotId: 'publik-bot',
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
          dialogBotId: 'publik-bot',
          includeCommentsButton: true,
          commentsButtonText: 'Обсуждение',
          includeSuggestButton: false,
          customButtons: [],
        },
      },
    ]);

    await (harness.service as any).syncChannelCommentsButtonCount(
      'channel-1',
      'thread-2',
      12,
      'publisher',
    );

    expect(harness.queue.enqueueKeyboardEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'channel',
        readinessFeature: 'publication',
        messageId: 'publik-channel-post-1',
        requiredBotId: 'publik-bot',
        dialogBotId: 'publik-bot',
        countSnapshot: 12,
        commentsButton: expect.objectContaining({ baseText: 'Обсуждение' }),
        buttons: [
          [
            expect.objectContaining({
              url: 'https://max.ru/publik-bot?startapp=publisher-channel-signed',
            }),
          ],
        ],
      }),
    );
    expect(harness.publisherDialogLinkService.buildChannelDialogButton).toHaveBeenCalledWith(
      'channel-1',
      'comments',
      'thread-2',
      'Обсуждение · 12',
      'MINIAPP',
    );
    expect(harness.maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
  });

  it('patches only the frozen comments slot and preserves the original CTA', async () => {
    const buttonRows = [
      [
        {
          type: 'link' as const,
          text: '💬 Комментарии · 0',
          url: 'https://max.ru/publik-bot?startapp=comments-original',
        },
      ],
      [
        {
          type: 'link' as const,
          text: '✍️ Предложить объявление',
          url: 'https://max.ru/publik-bot?startapp=suggest-original',
        },
      ],
      [
        {
          type: 'link' as const,
          text: '📞 Заказать рекламу',
          url: 'https://ads.example/original',
        },
      ],
    ];
    const harness = createService([
      {
        id: 'audit-frozen',
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
        payload: {
          threadId: 'thread-frozen',
          messageId: 'publik-channel-frozen',
          botId: 'publik-bot',
          dialogBotId: 'publik-bot',
          includeCommentsButton: true,
          includeSuggestButton: true,
          buttonRows,
          commentsButton: { rowIndex: 0, columnIndex: 0, baseText: '💬 Комментарии' },
        },
      },
    ]);

    await (harness.service as any).syncChannelCommentsButtonCount(
      'channel-1',
      'thread-frozen',
      14,
      'publisher',
    );

    expect(harness.queue.enqueueKeyboardEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'publik-channel-frozen',
        commentsButton: { rowIndex: 0, columnIndex: 0, baseText: '💬 Комментарии' },
        buttons: [
          [expect.objectContaining({ text: '💬 Комментарии · 14' })],
          [expect.objectContaining({ url: 'https://max.ru/publik-bot?startapp=suggest-original' })],
          [expect.objectContaining({ url: 'https://ads.example/original' })],
        ],
      }),
    );
    expect(harness.publisherDialogLinkService.buildChannelDialogButton).not.toHaveBeenCalled();
  });

  it('keeps same-thread Major and Publisher channel counters on their owning posts', async () => {
    const harness = createService([
      {
        id: 'major-channel-audit',
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
        payload: {
          threadId: 'shared-channel-thread',
          messageId: 'major-channel-post',
          botId: 'main-bot',
          dialogBotId: 'main-bot',
          includeCommentsButton: true,
          includeSuggestButton: false,
        },
      },
      {
        id: 'publisher-channel-audit',
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
        payload: {
          threadId: 'shared-channel-thread',
          messageId: 'publisher-channel-post',
          botId: 'publik-bot',
          dialogBotId: 'publik-bot',
          includeCommentsButton: true,
          includeSuggestButton: false,
        },
      },
    ]);

    await (harness.service as any).syncChannelCommentsButtonCount(
      'channel-1',
      'shared-channel-thread',
      9,
      'publisher',
    );

    expect(harness.queue.enqueueKeyboardEdit).toHaveBeenCalledTimes(1);
    expect(harness.queue.enqueueKeyboardEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'publisher-channel-post',
        countSnapshot: 9,
      }),
    );
    expect(harness.maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();

    await (harness.service as any).syncChannelCommentsButtonCount(
      'channel-1',
      'shared-channel-thread',
      4,
      'moderation',
    );

    expect(harness.queue.enqueueKeyboardEdit).toHaveBeenCalledTimes(1);
    expect(harness.maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
    expect(harness.maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'major-channel-post',
      null,
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: '💬 Комментарии · 4' })]],
      }),
      { botId: 'main-bot' },
    );
  });

  it('treats explicitly disabled publisher keyboard admission as a clean handled skip', async () => {
    const reason = 'dispatch_disabled' as const;
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
  });

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
