import type { MaxMessageButton } from '../max/max-client.service';
import {
  buildChannelCommentCountKeyboard,
  prepareStoredChannelCommentsKeyboard,
} from './admin-channel-comment-keyboard';

function link(text: string, url: string): MaxMessageButton {
  return { type: 'link', text, url };
}

describe('channel comment count keyboard', () => {
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
