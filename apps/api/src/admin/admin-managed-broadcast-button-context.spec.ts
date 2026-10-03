import {
  resolveManagedBroadcastButtonContext,
  type ManagedBroadcastButtonDependencies,
} from './admin-managed-broadcast-button-context';
import type { MaxMessageButton } from '../max/max-client.service';

function fixture(commentsEnabled: boolean, postSuggestionsEnabled: boolean) {
  const upsert = jest.fn().mockResolvedValue({
    commentsEnabled,
    postSuggestionsEnabled,
    postSuggestionsEntryMode: 'MINIAPP',
    postSuggestionsButtonText: 'Предложить',
  });
  const buildChannelDialogButton = jest.fn(
    (_chatId, type, _threadId, text, botId): MaxMessageButton => ({
      type: 'link',
      text,
      url: `https://example.com/${botId}/${type}`,
    }),
  );
  const dependencies: ManagedBroadcastButtonDependencies = {
    prisma: { channelSettings: { upsert } } as never,
    shouldIncludeChatCommentsButton: (settings) =>
      settings.commentsEnabled && settings.commentsChatBroadcastsEnabled,
    buildChatDialogButton: jest.fn(),
    buildChannelDialogButton,
  };
  return { dependencies, upsert, buildChannelDialogButton };
}

const options = {
  includeCustomButton: false,
  customButtonText: '',
  customButtonUrl: '',
  customButtons: [{ text: 'Автор', url: 'https://example.com/author' }],
};

describe('broadcast button construction without AdminService', () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'preserves comments=%s and suggestions=%s, bot scope and independent stored rows',
    async (comments, suggestions) => {
      const f = fixture(comments, suggestions);
      const result = await resolveManagedBroadcastButtonContext(
        f.dependencies,
        'channel-1',
        'channel',
        options,
        'bot-1',
      );
      expect(result.buttons.flat().map((button) => button.text)).toEqual([
        ...(comments ? ['💬 Комментарии · 0'] : []),
        ...(suggestions ? ['Предложить'] : []),
        'Автор',
      ]);
      expect(f.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { chatId: 'channel-1' }, update: {} }),
      );
      if (comments || suggestions) {
        expect(result.commentDialogReference).toEqual(
          expect.objectContaining({
            botId: 'bot-1',
            includeCommentsButton: comments,
            includeSuggestButton: suggestions,
            suggestionEntryMode: 'MINIAPP',
            customButtons: options.customButtons,
          }),
        );
        for (const call of f.buildChannelDialogButton.mock.calls) expect(call[4]).toBe('bot-1');
        expect(result.commentDialogReference?.buttonRows).toEqual(result.buttons);
        const storedText = result.commentDialogReference?.buttonRows?.[0]?.[0]?.text;
        result.buttons[0][0].text = 'modified';
        expect(result.commentDialogReference?.buttonRows?.[0]?.[0]?.text).toBe(storedText);
      } else {
        expect(result.commentDialogReference).toBeNull();
      }
    },
  );
});

describe('custom broadcast button rows', () => {
  it.each(['chat', 'channel'] as const)(
    'preserves MAX-safe custom rows for %s',
    async (entityType) => {
      const f = fixture(false, false);
      f.dependencies.prisma = {
        channelSettings: { upsert: f.upsert },
        chatSettings: {
          upsert: jest
            .fn()
            .mockResolvedValue({ commentsEnabled: true, commentsChatBroadcastsEnabled: true }),
        },
      } as never;
      f.dependencies.buildChatDialogButton = (_chatId, _type, _threadId, text) => ({
        type: 'link',
        text,
        url: 'https://example.com/comments',
      });
      const customButtons = ['one', 'two', 'three', 'four'].map((id) => ({
        text: id,
        url: `https://max.ru/${id}`,
      }));
      const result = await resolveManagedBroadcastButtonContext(
        f.dependencies,
        'entity-1',
        entityType,
        { ...options, customButtons },
      );
      const expected = customButtons.map((button) => ({ type: 'link', ...button }));
      if (entityType === 'chat') {
        expect(result.buttons.slice(0, 2)).toEqual([expected.slice(0, 3), expected.slice(3)]);
        expect(result.buttons[2][0].text).toBe('💬 Комментарии · 0');
      } else {
        expect(result.buttons).toEqual(expected.map((button) => [button]));
      }
    },
  );
});
