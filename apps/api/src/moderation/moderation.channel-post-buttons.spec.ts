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

function createChannelPostUpdateWithoutSender(): MaxUpdate {
  return {
    updateId: 'upd-channel-no-sender-1',
    type: 'message_created',
    message: {
      messageId: 'mid-channel-no-sender-1',
      chatId: 'channel-1',
      senderId: '',
      senderName: '',
      text: 'Новый пост без senderId',
      createdAt: new Date('2026-03-06T15:10:00.000Z').toISOString(),
    },
    raw: {
      message: {
        recipient: {
          chat_id: 'channel-1',
          chat_type: 'channel',
        },
        timestamp: 1772810100000,
        body: {
          mid: 'mid-channel-no-sender-1',
          text: 'Новый пост без senderId',
        },
      },
    },
  };
}

function createForwardedChannelPostUpdateWithoutSender(): MaxUpdate {
  return {
    updateId: 'upd-channel-forward-no-sender-1',
    type: 'message_created',
    message: {
      messageId: 'mid-channel-forward-no-sender-1',
      chatId: 'channel-1',
      senderId: '',
      senderName: '',
      text: 'Пересланный пост',
      createdAt: new Date('2026-03-06T15:10:00.000Z').toISOString(),
    },
    raw: {
      message: {
        recipient: {
          chat_id: 'channel-1',
          chat_type: 'channel',
        },
        timestamp: 1772810100000,
        body: {
          mid: 'mid-channel-forward-no-sender-1',
          text: '',
        },
        link: {
          type: 'forward',
          message: {
            text: 'Пересланный пост',
          },
        },
      },
    },
  };
}

function createConfigMock(
  overrides: Partial<Record<string, string | number | boolean>> = {},
) {
  return {
    get: jest.fn((key: string) => {
      if (key in overrides) {
        return overrides[key];
      }
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
              url: expect.stringContaining('https://max.ru/777000_bot?start='),
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

  it('auto-attaches buttons when MAX omits sender metadata for a channel post', async () => {
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

    await service.handleUpdate(createChannelPostUpdateWithoutSender());

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-no-sender-1',
      'Новый пост без senderId',
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              type: 'link',
              text: '📰 Предложить пост',
            }),
          ],
        ],
      }),
    );
  });

  it('falls back to a bot reply with buttons for forwarded channel posts', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Ищу модель | Ростов',
          entityType: 'CHANNEL',
          channelSettings: {
            autoPostButtonsMode: 'BOTH',
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: 'Предложить пост',
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
      sendMessageCopyWithInlineKeyboard: jest.fn().mockResolvedValue({
        messageId: 'mid-forward-copy-1',
        url: 'https://max.ru/chats/channel-1/message/1001',
      }),
      sendMessageReplyWithInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
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

    await service.handleUpdate(createForwardedChannelPostUpdateWithoutSender());

    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.sendMessageReplyWithInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.sendMessageCopyWithInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-forward-no-sender-1',
      'Пересланный пост',
      expect.objectContaining({
        buttons: [
          [expect.objectContaining({ text: '💬 Комментарии · 0' })],
          [expect.objectContaining({ text: 'Предложить пост' })],
        ],
      }),
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-forward-no-sender-1',
      {
        immediate: true,
      },
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            deliveryMode: 'replace_with_bot_message',
            linkType: 'forward',
            replacementMessageId: 'mid-forward-copy-1',
            originalDeleted: true,
          }),
        }),
      }),
    );
  });

  it('auto-attaches comments even when a legacy channel record still stores suggestion-only mode', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Ищу модель | Ростов',
          entityType: 'CHANNEL',
          channelSettings: {
            autoPostButtonsMode: 'SUGGEST',
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

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-1',
      'Новый пост в канале',
      expect.objectContaining({
        buttons: [
          [expect.objectContaining({ text: '💬 Комментарии · 0' })],
          [expect.objectContaining({ text: '📰 Предложить пост' })],
        ],
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            includeCommentsButton: true,
            includeSuggestButton: true,
            autoPostButtonsMode: 'BOTH',
          }),
        }),
      }),
    );
  });

  it('stores reply message id when forwarded channel post falls back to reply button delivery', async () => {
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
      sendMessageCopyWithInlineKeyboard: jest.fn().mockRejectedValue({
        response: {
          status: 400,
        },
        message: 'cannot replace forwarded message',
      }),
      sendMessageReplyWithInlineKeyboard: jest.fn().mockResolvedValue({
        messageId: 'mid-forward-reply-1',
        url: 'https://max.ru/chats/channel-1/message/forward-reply-1',
      }),
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

    await service.handleUpdate(createForwardedChannelPostUpdateWithoutSender());

    expect(maxClient.sendMessageReplyWithInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-forward-no-sender-1',
      'Действия к посту',
      expect.objectContaining({
        debugContext: {
          screen: 'channel-auto-post',
          action: 'attach-buttons-reply-fallback',
        },
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            deliveryMode: 'reply_message',
            replyMessageId: 'mid-forward-reply-1',
            linkType: 'forward',
          }),
        }),
      }),
    );
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
              url: expect.stringContaining('https://max.ru/777000_bot?start='),
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
              admins: [
                {
                  userId: 'admin-1',
                },
              ],
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
          sender: {
            user_id: 'admin-1',
          },
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
      orderBy: {
        updatedAt: 'desc',
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
              url: expect.stringContaining('https://max.ru/777000_bot?start='),
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

  it('records a terminal skip marker for non-retryable channel post edit failures', async () => {
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
      editMessageInlineKeyboard: jest.fn().mockRejectedValue({
        response: {
          status: 400,
        },
        message: 'Error on message edit',
      }),
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

    expect(prisma.auditLog.findFirst).toHaveBeenCalledWith({
      where: {
        chatId: 'channel-1',
        action: {
          in: ['AUTO_ATTACH_CHANNEL_ENGAGEMENT', 'AUTO_ATTACH_CHANNEL_ENGAGEMENT_SKIPPED'],
        },
        payload: {
          path: ['messageId'],
          equals: 'mid-channel-1',
        },
      },
      select: {
        id: true,
      },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        chatId: 'channel-1',
        actorUserId: 'admin-1',
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT_SKIPPED',
        payload: {
          messageId: 'mid-channel-1',
          reason: 'terminal_delivery_failure',
          linkType: null,
          source: 'webhook',
          deliveryMode: 'edit_message',
          status: 400,
          error: 'Error on message edit',
        },
      },
    });
  });

  it('skips polled channel posts from non-admin authors', async () => {
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
              admins: [
                {
                  userId: 'admin-1',
                },
              ],
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
          sender: {
            user_id: 'user-2',
          },
          body: {
            mid: 'mid-polled-non-admin-1',
            text: 'Пост не админа',
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

    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('allows polled channel posts when MAX does not provide sender metadata', async () => {
    const prisma = {
      channelSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'channel-1',
            autoPostButtonsMode: 'OFF',
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: false,
            updatedAt: new Date('2026-03-06T15:00:00.000Z'),
            chat: {
              admins: [
                {
                  userId: 'admin-1',
                },
              ],
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
            mid: 'mid-polled-unknown-author-1',
            text: 'Пост без sender metadata',
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

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-polled-unknown-author-1',
      'Пост без sender metadata',
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              type: 'link',
              text: '📰 Предложить пост',
            }),
          ],
        ],
      }),
    );
  });

  it('polls forwarded channel posts when MAX omits body.mid and stores text under link.message', async () => {
    const prisma = {
      channelSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'channel-1',
            autoPostButtonsMode: 'OFF',
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: false,
            updatedAt: new Date('2026-03-06T15:00:00.000Z'),
            chat: {
              admins: [
                {
                  userId: 'admin-1',
                },
              ],
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
          id: 'mid-polled-forward-1',
          timestamp: 1772810100000,
          sender: {
            user_id: 'admin-1',
          },
          body: null,
          link: {
            type: 'forward',
            message: {
              text: 'Пересланный пост',
            },
          },
        },
      ]),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      sendMessageCopyWithInlineKeyboard: jest.fn().mockResolvedValue({
        messageId: 'mid-polled-forward-copy-1',
        url: 'https://max.ru/chats/channel-1/message/1002',
      }),
      sendMessageReplyWithInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      getChatAdminIds: jest.fn(),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
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

    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.sendMessageReplyWithInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.sendMessageCopyWithInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-polled-forward-1',
      'Пересланный пост',
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              type: 'link',
              text: '📰 Предложить пост',
            }),
          ],
        ],
      }),
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('channel-1', 'mid-polled-forward-1', {
      immediate: true,
    });
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

  it('applies idle backoff to channel polling when no new posts appear', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-30T02:00:00.000Z'));

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
              admins: [
                {
                  userId: 'admin-1',
                },
              ],
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
          timestamp: 1774810100000,
          sender: {
            user_id: 'admin-1',
          },
          body: {
            mid: 'mid-polled-idle-1',
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
      createConfigMock({
        CHANNEL_AUTO_POST_SCAN_INTERVAL_MS: 30_000,
        CHANNEL_AUTO_POST_IDLE_BACKOFF_MAX_MS: 120_000,
      }) as never,
      undefined,
      undefined,
      adminService as never,
    );

    await (service as any).processChannelAutoPostButtons();
    jest.advanceTimersByTime(30_000);
    await (service as any).processChannelAutoPostButtons();
    jest.advanceTimersByTime(30_000);
    await (service as any).processChannelAutoPostButtons();
    jest.advanceTimersByTime(30_000);
    await (service as any).processChannelAutoPostButtons();

    expect(maxClient.listMessages).toHaveBeenCalledTimes(3);
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
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
