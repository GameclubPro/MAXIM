import type { MaxUpdate } from '@maxim/contracts';
import { ModerationService } from './moderation.service';

function createChannelPostUpdate(): MaxUpdate {
  return {
    updateId: 'upd-channel-1',
    type: 'message_created',
    message: {
      messageId: 'mid-channel-1',
      chatId: 'channel-1',
      senderId: 'admin-1',
      senderName: 'Админ',
      text: 'Новый пост в канале',
      createdAt: new Date('2026-03-06T15:10:00.000Z').toISOString(),
    },
    raw: {
      message: {
        recipient: {
          chat_id: 'channel-1',
          chat_type: 'channel',
        },
        sender: {
          user_id: 'admin-1',
          is_bot: false,
        },
      },
    },
  };
}

function createConfigMock() {
  return {
    get: jest.fn((key: string) => {
      if (key === 'MAX_BOT_TOKEN') {
        return 'test-max-bot-token';
      }
      if (key === 'MAX_BOT_ID') {
        return '777000_bot';
      }
      if (key === 'MAX_BOT_CONTACT_ID') {
        return '777000';
      }
      if (key === 'APP_BASE_URL') {
        return 'https://maxim.play-team.ru';
      }
      return undefined;
    }),
  };
}

describe('ModerationService channel auto post buttons', () => {
  it('auto-attaches buttons to a fresh admin post in a managed channel', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Ищу модель | Ростов',
          entityType: 'CHANNEL',
          channelSettings: {
            autoPostButtonsMode: 'BOTH',
            postSuggestionsButtonText: '📰 Предложить пост',
          },
          admins: [],
        }),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
    );

    await service.handleUpdate(createChannelPostUpdate());

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-1',
      'Новый пост в канале',
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              type: 'link',
              text: '💬 Комментарии',
            }),
          ],
          [
            expect.objectContaining({
              type: 'link',
              text: '📰 Предложить пост',
            }),
          ],
        ],
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'channel-1',
          actorUserId: 'admin-1',
          action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
        }),
      }),
    );
    expect(ruleEngine.detect).not.toHaveBeenCalled();
  });

  it('does not auto-attach when the channel mode is off', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Ищу модель | Ростов',
          entityType: 'CHANNEL',
          channelSettings: {
            autoPostButtonsMode: 'OFF',
            postSuggestionsButtonText: '📰 Предложить пост',
          },
          admins: [],
        }),
      },
      auditLog: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
    );

    await service.handleUpdate(createChannelPostUpdate());

    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
