import { buildModerationReleaseCallbackPayload } from '../moderation/moderation-release-callback.util';
import { sendManualBanChatNotice } from './manual-moderation-notice.util';

describe('manual moderation notice', () => {
  it.each([
    ['Иван Петров', 'Иван Петров'],
    ['user-3', 'Пользователь'],
  ] as const)('renders %s as a linked target label', async (displayName, expectedLabel) => {
    const maxClient = {
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };

    await sendManualBanChatNotice(
      maxClient as never,
      { warn: jest.fn() },
      {
        chatId: 'chat-1',
        targetUserId: 'user-3',
        sanctionEventId: 'sanction-event-ban-1',
        targetDisplayName: displayName,
        source: 'miniapp',
        removedOnly: false,
      },
    );

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      `Для участника [${expectedLabel}](max://user/user-3) включён бан.`,
      {
        buttons: [
          [
            {
              type: 'callback',
              text: 'Разбанить',
              payload: buildModerationReleaseCallbackPayload('UNBAN', 'sanction-event-ban-1'),
              intent: 'positive',
            },
          ],
        ],
        textFormat: 'markdown',
      },
      { immediate: true },
    );
  });
});
