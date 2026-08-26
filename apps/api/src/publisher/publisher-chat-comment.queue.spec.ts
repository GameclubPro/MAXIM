import { PublisherChatCommentQueueService } from './publisher-chat-comment.queue';

describe('PublisherChatCommentQueueService', () => {
  it('enqueues a durable attach envelope without publisher credentials', async () => {
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const service = new PublisherChatCommentQueueService(
      queue as never,
      {
        get: () => 'publik-bot',
      } as never,
    );

    await service.enqueueAttach({
      markerId: `ccr1_${'a'.repeat(32)}`,
      lockToken: 'claim-lock-1',
      chatId: 'chat-1',
      messageId: 'message-1',
      senderId: 'admin-1',
      dialogBotId: 'main-bot',
      button: { type: 'link', text: 'Comments', url: 'https://max.ru/main-bot?startapp=x' },
      createdAt: new Date('2026-08-26T09:00:00.000Z'),
    });

    expect(queue.add).toHaveBeenCalledWith(
      'attach-chat-reply',
      expect.objectContaining({
        version: 1,
        kind: 'attach_chat_reply',
        requiredBotId: 'publik-bot',
        dialogBotId: 'main-bot',
        retryPolicyName: 'publisher-chat-comment',
        createdAt: '2026-08-26T09:00:00.000Z',
      }),
      expect.objectContaining({
        attempts: 12,
        backoff: { type: 'fixed', delay: 30_000 },
        jobId: expect.stringMatching(/^publisher-chat-comment-[a-f0-9]{32}$/u),
        removeOnFail: false,
      }),
    );
  });

  it('keys keyboard edits by the count snapshot while preserving exact origin attribution', async () => {
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const service = new PublisherChatCommentQueueService(
      queue as never,
      {
        get: () => 'publik-bot',
      } as never,
    );
    const params = {
      entityType: 'channel' as const,
      readinessFeature: 'publication' as const,
      chatId: 'channel-1',
      messageId: 'publisher-message-1',
      threadId: 'thread-1',
      requiredBotId: 'publik-bot',
      dialogBotId: 'main-bot',
      buttons: [[{ type: 'link' as const, text: 'Comments 4', url: 'https://example.test' }]],
      commentsButton: { rowIndex: 0, columnIndex: 0, baseText: 'Comments' },
      countSnapshot: 4,
      createdAt: new Date('2026-08-26T09:01:00.000Z'),
    };

    await service.enqueueKeyboardEdit(params);
    await service.enqueueKeyboardEdit({ ...params, countSnapshot: 5 });

    const first = queue.add.mock.calls[0];
    const second = queue.add.mock.calls[1];
    expect(first?.[1]).toEqual(
      expect.objectContaining({
        kind: 'edit_comment_keyboard',
        requiredBotId: 'publik-bot',
        dialogBotId: 'main-bot',
        countSnapshot: 4,
      }),
    );
    expect(first?.[2]?.jobId).not.toBe(second?.[2]?.jobId);
  });
});
