import type { MaxMessageButton } from '../max/max-client.service';
import {
  buildChannelCommentCountKeyboard,
  prepareStoredChannelCommentsKeyboard,
  refreshCommentsButtonCount,
} from './admin-channel-comment-keyboard';

function link(text: string, url: string): MaxMessageButton {
  return { type: 'link', text, url };
}

describe('channel comment count keyboard', () => {
  it('defers the Major count read until the transport holds the message lock', async () => {
    const count = jest.fn().mockResolvedValue(6);
    const editMessageInlineKeyboard = jest.fn().mockResolvedValue(undefined);
    const button = link('Comments 1', 'https://max.ru/comments');
    await refreshCommentsButtonCount(
      {
        prisma: { auditLog: { count } } as never,
        maxClient: { editMessageInlineKeyboard } as never,
        logger: { warn: jest.fn() } as never,
        resolveBotId: async () => 'major-bot',
      },
      {
        chatId: 'channel-1',
        messageId: 'message-1',
        threadId: 'thread-1',
        entityType: 'channel',
        buttons: [[button]],
        commentsButton: { rowIndex: 0, columnIndex: 0, baseText: 'Comments' },
      },
    );
    expect(count).not.toHaveBeenCalled();
    const options = editMessageInlineKeyboard.mock.calls[0]![3];
    expect(options.refreshButtonText.button).toBe(button);
    await expect(options.refreshButtonText.readText()).resolves.toBe('Comments · 6');
    expect(count).toHaveBeenCalledWith({
      where: {
        chatId: 'channel-1',
        action: 'CHANNEL_DIALOG_COMMENT',
        payload: { path: ['threadId'], equals: 'thread-1' },
      },
    });
    count.mockResolvedValueOnce(0);
    await expect(options.refreshButtonText.readText()).resolves.toBe('Comments · 0');
    count.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(options.refreshButtonText.readText()).rejects.toThrow('database unavailable');
  });

  it('keeps comments, suggestions, CTA, and custom buttons in product order', () => {
    const result = buildChannelCommentCountKeyboard({
      includeCommentsButton: true,
      includeSuggestButton: true,
      commentsButtonText: '💬 Комментарии',
      suggestButtonText: '✍️ Предложить объявление',
      suggestionEntryMode: 'MINIAPP',
      count: 7,
      ctaButton: link('📞 Заказать рекламу', 'https://example.test/ads'),
      customButtonRows: [[link('Подробнее', 'https://example.test/details')]],
      buildDialogButton: (type, text) => link(text, `https://max.ru/${type}`),
    });

    expect(result).toEqual({
      buttons: [
        [link('💬 Комментарии · 7', 'https://max.ru/comments')],
        [link('✍️ Предложить объявление', 'https://max.ru/suggest')],
        [link('📞 Заказать рекламу', 'https://example.test/ads')],
        [link('Подробнее', 'https://example.test/details')],
      ],
      commentsButton: { rowIndex: 0, columnIndex: 0, baseText: '💬 Комментарии' },
    });
  });

  it('fails closed when a required signed dialog button cannot be built', () => {
    expect(
      buildChannelCommentCountKeyboard({
        includeCommentsButton: true,
        includeSuggestButton: false,
        commentsButtonText: null,
        suggestButtonText: 'Suggest',
        suggestionEntryMode: 'BOT',
        count: 0,
        ctaButton: null,
        customButtonRows: [],
        buildDialogButton: () => null,
      }),
    ).toBeNull();
  });

  it('patches only the frozen comments slot', () => {
    expect(
      prepareStoredChannelCommentsKeyboard(
        {
          buttonRows: [
            [link('💬 Комментарии · 0', 'https://max.ru/comments')],
            [link('📞 Заказать рекламу', 'https://example.test/ads')],
          ],
          commentsButton: { rowIndex: 0, columnIndex: 0, baseText: '💬 Комментарии' },
        },
        12,
      ),
    ).toEqual({
      buttons: [
        [link('💬 Комментарии · 12', 'https://max.ru/comments')],
        [link('📞 Заказать рекламу', 'https://example.test/ads')],
      ],
      commentsButton: { rowIndex: 0, columnIndex: 0, baseText: '💬 Комментарии' },
    });
  });
});
