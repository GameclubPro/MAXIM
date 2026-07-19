import { channelSettingsSchema } from '@maxim/contracts';
import {
  normalizeChannelAutoPostButtonsMode,
  normalizeChannelSettings,
  readChannelSettings,
} from './admin-channel-settings';

describe('channel auto post button mode', () => {
  it('repairs a malformed stored button with an optimistic version guard', async () => {
    const updatedAt = new Date('2026-07-19T08:00:00.000Z');
    const storedSettings = {
      ...channelSettingsSchema.parse({
        commentsEnabled: true,
        postSuggestionsButtonEnabled: true,
        postSuggestionsButtonUrl: 'https://max.ru/chat/example/https://nested.example.test',
      }),
      updatedAt,
    };
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });

    const result = await readChannelSettings({
      prisma: {
        chat: { upsert: jest.fn().mockResolvedValue({ channelSettings: storedSettings }) },
        channelSettings: { updateMany },
      } as never,
      logger: { warn: jest.fn() },
      chatId: 'channel-1',
    });

    expect(result.commentsEnabled).toBe(true);
    expect(result.postSuggestionsButtonEnabled).toBe(false);
    expect(result.postSuggestionsButtonUrl).toBe('');
    expect(updateMany).toHaveBeenCalledWith({
      where: { chatId: 'channel-1', updatedAt },
      data: expect.objectContaining({
        postSuggestionsButtonEnabled: false,
        postSuggestionsButtonUrl: '',
      }),
    });
  });

  it.each([
    ['BOTH', false, true],
    ['COMMENTS', false, true],
    ['SUGGEST', true, false],
    ['OFF', true, true],
  ] as const)(
    'keeps %s as the selected mode when feature availability changes',
    (mode, commentsEnabled, postSuggestionsEnabled) => {
      const settings = channelSettingsSchema.parse({
        autoPostButtonsMode: mode,
        commentsEnabled,
        postSuggestionsEnabled,
      });

      expect(normalizeChannelAutoPostButtonsMode(settings)).toBe(mode);
      expect(normalizeChannelSettings(settings).autoPostButtonsMode).toBe(mode);
    },
  );
});
