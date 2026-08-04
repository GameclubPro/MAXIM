import {
  buildModerationReleaseCallbackPayload,
  parseModerationReleaseCallbackPayload,
  withModerationReleaseButton,
} from './moderation-release-callback.util';

describe('moderation release callback', () => {
  it.each([
    ['UNBAN', 'sanction-event-ban-1'],
    ['UNMUTE', 'sanction:event/with-slash'],
  ] as const)('round-trips v2 %s payloads', (action, sanctionEventId) => {
    const payload = buildModerationReleaseCallbackPayload(action, sanctionEventId);

    expect(parseModerationReleaseCallbackPayload(payload)).toEqual({
      action,
      sanctionEventId,
    });
  });

  it('rejects legacy v1 payloads', () => {
    expect(
      parseModerationReleaseCallbackPayload(
        'moderation-release:v1:unban:Y2hhdC0x:dXNlci0x',
      ),
    ).toBeNull();
  });

  it('rejects malformed and non-canonical payloads', () => {
    expect(
      parseModerationReleaseCallbackPayload('moderation-release:v2:ban:c2FuY3Rpb24tZXZlbnQtMQ'),
    ).toBeNull();
    expect(
      parseModerationReleaseCallbackPayload('moderation-release:v2:unban:***'),
    ).toBeNull();
    expect(
      parseModerationReleaseCallbackPayload(
        'moderation-release:v2:unban:c2FuY3Rpb24tZXZlbnQtMQ=',
      ),
    ).toBeNull();
  });

  it('rejects a callback whose encoded event ID exceeds the MAX payload limit', () => {
    expect(() => buildModerationReleaseCallbackPayload('UNBAN', '界'.repeat(128))).toThrow(
      'Moderation release callback payload exceeds the MAX limit',
    );
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
        { action: 'UNMUTE', sanctionEventId: 'sanction-event-mute-1' },
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
            payload: buildModerationReleaseCallbackPayload('UNMUTE', 'sanction-event-mute-1'),
            intent: 'positive',
          },
        ],
      ],
      textFormat: 'markdown',
    });
  });
});
