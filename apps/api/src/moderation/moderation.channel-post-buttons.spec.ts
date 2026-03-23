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

function createAdminServiceMock() {
  return {
    buildChannelSuggestionStartPayload: jest.fn(
      (chatId: string, threadId: string) => `cds-${chatId}:${threadId}`,
    ),
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
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
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
    const adminService = createAdminServiceMock();

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      adminService as never,
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
              text: '💬 Комментарии · 0',
            }),
          ],
          [
            expect.objectContaining({
              type: 'link',
              text: '📰 Предложить пост',
              url: expect.stringContaining('https://max.ru/777000_bot?start=cds-channel-1%3A'),
            }),
          ],
        ],
      }),
    );
    expect(adminService.buildChannelSuggestionStartPayload).toHaveBeenCalledWith(
      'channel-1',
      expect.any(String),
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

  it('does not auto-attach when the channel mode is off and comments are disabled', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Ищу модель | Ростов',
          entityType: 'CHANNEL',
          channelSettings: {
            autoPostButtonsMode: 'OFF',
            postSuggestionsEnabled: false,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: false,
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

  it('auto-attaches the comments button when comments are enabled and the mode is off', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Ищу модель | Ростов',
          entityType: 'CHANNEL',
          channelSettings: {
            autoPostButtonsMode: 'OFF',
            postSuggestionsEnabled: false,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
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

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-1',
      'Новый пост в канале',
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: '💬 Комментарии · 0' })]],
      }),
    );
  });

  it('auto-attaches the suggestion button when suggestions are enabled even if the legacy mode is off', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Ищу модель | Ростов',
          entityType: 'CHANNEL',
          channelSettings: {
            autoPostButtonsMode: 'OFF',
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: false,
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
    const adminService = createAdminServiceMock();

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      adminService as never,
    );

    await service.handleUpdate(createChannelPostUpdate());

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-1',
      'Новый пост в канале',
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              type: 'link',
              text: '📰 Предложить пост',
              url: expect.stringContaining('https://max.ru/777000_bot?start=cds-channel-1%3A'),
            }),
          ],
        ],
      }),
    );
  });

  it('polls channel posts and attaches buttons even without webhook delivery', async () => {
    const prisma = {
      channelSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'channel-1',
            autoPostButtonsMode: 'BOTH',
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
            updatedAt: new Date('2026-03-06T15:00:00.000Z'),
            chat: {
              admins: [],
            },
          },
        ]),
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
      listMessages: jest.fn().mockResolvedValue([
        {
          timestamp: 1772810100000,
          body: {
            mid: 'mid-polled-1',
            text: 'Пост из канала',
            attachments: [],
          },
        },
      ]),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      getChatAdminIds: jest.fn(),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = createAdminServiceMock();

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      adminService as never,
    );

    await (service as any).processChannelAutoPostButtons();

    expect(prisma.channelSettings.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          {
            autoPostButtonsMode: {
              in: ['COMMENTS', 'BOTH'],
            },
          },
          {
            commentsEnabled: true,
          },
          {
            postSuggestionsEnabled: true,
          },
        ],
      },
      include: {
        chat: {
          include: {
            admins: {
              select: {
                userId: true,
              },
            },
          },
        },
      },
    });
    expect(maxClient.listMessages).toHaveBeenCalledWith('channel-1', {
      count: 10,
      trafficClass: 'background',
    });
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-polled-1',
      'Пост из канала',
      expect.objectContaining({
        buttons: [
          [expect.objectContaining({ text: '💬 Комментарии · 0' })],
          [
            expect.objectContaining({
              type: 'link',
              text: '📰 Предложить пост',
              url: expect.stringContaining('https://max.ru/777000_bot?start=cds-channel-1%3A'),
            }),
          ],
        ],
        debugContext: {
          screen: 'channel-auto-post',
          action: 'scan-attach-buttons',
        },
      }),
    );
  });

  it('backs off channel polling after MAX API rate limit errors', async () => {
    const prisma = {
      channelSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'channel-1',
            autoPostButtonsMode: 'BOTH',
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
            updatedAt: new Date('2026-03-06T15:00:00.000Z'),
            chat: {
              admins: [],
            },
          },
          {
            chatId: 'channel-2',
            autoPostButtonsMode: 'BOTH',
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
            updatedAt: new Date('2026-03-06T15:00:00.000Z'),
            chat: {
              admins: [],
            },
          },
        ]),
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
      listMessages: jest.fn().mockRejectedValue(new Error('MAX API global rate limit exceeded')),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      getChatAdminIds: jest.fn(),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = createAdminServiceMock();

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      adminService as never,
    );

    await (service as any).processChannelAutoPostButtons();
    await (service as any).processChannelAutoPostButtons();

    expect(prisma.channelSettings.findMany).toHaveBeenCalledTimes(1);
    expect(maxClient.listMessages).toHaveBeenCalledTimes(1);
    expect(maxClient.listMessages).toHaveBeenCalledWith('channel-1', {
      count: 10,
      trafficClass: 'background',
    });
  });

  it('pauses channel polling while the shared system mode is degraded', async () => {
    const prisma = {
      channelSettings: {
        findMany: jest.fn(),
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
      listMessages: jest.fn(),
      editMessageInlineKeyboard: jest.fn(),
      getChatAdminIds: jest.fn(),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const systemModeService = {
      getEffectiveSnapshot: jest.fn().mockResolvedValue({
        mode: 'degrade',
        source: 'auto',
        reason: 'queue lag 20.0s',
        updatedAt: new Date().toISOString(),
        manualMode: null,
        queueLagSec: 20,
        action: {
          windowSec: 60,
          total: 100,
          success: 95,
          failure: 5,
          critical: 0,
          errorRate: 0.05,
          criticalRate: 0,
        },
      }),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      systemModeService as never,
      createConfigMock() as never,
    );

    await (service as any).processChannelAutoPostButtons();

    expect(systemModeService.getEffectiveSnapshot).toHaveBeenCalled();
    expect(prisma.channelSettings.findMany).not.toHaveBeenCalled();
    expect(maxClient.listMessages).not.toHaveBeenCalled();
  });
});
