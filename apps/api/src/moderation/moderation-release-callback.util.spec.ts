import {
  buildModerationReleaseCallbackPayload,
  parseModerationReleaseCallbackPayload,
  withModerationReleaseButton,
} from './moderation-release-callback.util';

describe('moderation release callback', () => {
  it.each([
    ['UNBAN', '613002203036_5'],
    ['UNMUTE', 'user:with/slash'],
  ] as const)('round-trips %s payloads', (action, targetUserId) => {
    const payload = buildModerationReleaseCallbackPayload(action, 'chat-1', targetUserId);

    expect(parseModerationReleaseCallbackPayload(payload)).toEqual({
      action,
      chatId: 'chat-1',
      targetUserId,
    });
  });

  it('rejects malformed and non-canonical payloads', () => {
    expect(
      parseModerationReleaseCallbackPayload('moderation-release:v1:ban:Y2hhdC0x:dXNlci0x'),
    ).toBeNull();
    expect(
      parseModerationReleaseCallbackPayload('moderation-release:v1:unban:***:dXNlci0x'),
    ).toBeNull();
    expect(
      parseModerationReleaseCallbackPayload('moderation-release:v1:unban:Y2hhdC0x:dXNlci0x='),
    ).toBeNull();
  });

  it('rejects a callback whose encoded identifiers exceed the MAX payload limit', () => {
    expect(() =>
      buildModerationReleaseCallbackPayload('UNBAN', 'я'.repeat(128), 'ю'.repeat(128)),
    ).toThrow('Moderation release callback payload exceeds the MAX limit');
  });

  it('appends the release action after existing notice buttons', () => {
    expect(
      withModerationReleaseButton(
        {
          button: {
            text: 'Правила',
            url: 'https://example.com/rules',
          },
          textFormat: 'markdown',
        },
        { action: 'UNMUTE', chatId: 'chat-1', targetUserId: 'user-1' },
      ),
    ).toEqual({
      buttons: [
        [
          {
            text: 'Правила',
            url: 'https://example.com/rules',
          },
        ],
        [
          {
            type: 'callback',
            text: 'Снять мут',
            payload: buildModerationReleaseCallbackPayload('UNMUTE', 'chat-1', 'user-1'),
            intent: 'positive',
          },
        ],
      ],
      textFormat: 'markdown',
    });
  });
});
