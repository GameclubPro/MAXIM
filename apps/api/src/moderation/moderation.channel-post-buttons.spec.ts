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

function createRichForwardedChannelPostUpdateWithoutSender(): MaxUpdate {
  const sourceText = '🔥MAX Docs\n\nВторой абзац';
  return {
    updateId: 'upd-channel-forward-rich-no-sender-1',
    type: 'message_created',
    message: {
      messageId: 'mid-channel-forward-rich-no-sender-1',
      chatId: 'channel-1',
      senderId: '',
      senderName: '',
      text: sourceText,
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
          mid: 'mid-channel-forward-rich-no-sender-1',
          text: '',
        },
        link: {
          type: 'forward',
          message: {
            text: sourceText,
            markup: [
              {
                from: 2,
                type: 'strong',
                length: 8,
              },
              {
                from: 2,
                type: 'underline',
                length: 8,
              },
            ],
          },
        },
      },
    },
  };
}

function createConfigMock(overrides: Partial<Record<string, string | number | boolean>> = {}) {
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
      (chatId: string, threadId: string) => `cds-${chatId}-${threadId}`,
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
            postSuggestionsEntryMode: 'BOT',
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
              url: expect.stringContaining('https://max.ru/777000_bot?startapp='),
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
      undefined,
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

  it('opens channel suggestions in the mini app when admins select mini app mode', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Ищу модель | Ростов',
          entityType: 'CHANNEL',
          channelSettings: {
            autoPostButtonsMode: 'BOTH',
            postSuggestionsEnabled: true,
            postSuggestionsEntryMode: 'MINIAPP',
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
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );

    await service.handleUpdate(createChannelPostUpdate());

    const options = maxClient.editMessageInlineKeyboard.mock.calls[0]?.[3];
    const suggestButton = options?.buttons?.[1]?.[0];
    expect(suggestButton).toMatchObject({
      type: 'link',
      text: '📰 Предложить пост',
    });
    expect(suggestButton?.url).toContain('https://max.ru/777000_bot?startapp=');
    expect(new URL(suggestButton.url).searchParams.get('startapp')).toBeTruthy();
    expect(new URL(suggestButton.url).searchParams.get('start')).toBeNull();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            suggestionEntryMode: 'MINIAPP',
          }),
        }),
      }),
    );
  });

  it('does not auto-attach comments when channel settings are auto-created with fresh defaults', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Ищу модель | Ростов',
          entityType: 'CHANNEL',
          channelSettings: null,
          admins: [],
        }),
        update: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Ищу модель | Ростов',
          entityType: 'CHANNEL',
          channelSettings: {
            autoPostButtonsMode: 'OFF',
            postSuggestionsEnabled: false,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: false,
            updatedAt: new Date('2026-03-06T15:00:00.000Z'),
          },
          admins: [
            {
              userId: 'admin-1',
            },
          ],
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

    expect(prisma.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'channel-1' },
        data: expect.objectContaining({
          channelSettings: {
            upsert: {
              update: {},
              create: {
                commentsEnabled: false,
              },
            },
          },
        }),
      }),
    );
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
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
      undefined,
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
      undefined,
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
            publishedUrl: 'https://max.ru/chats/channel-1/message/1001',
            originalDeleted: true,
          }),
        }),
      }),
    );
  });

  it('preserves MAX markup from forwarded channel post webhooks when publishing the bot copy', async () => {
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
        messageId: 'mid-forward-rich-copy-1',
        url: 'https://max.ru/chats/channel-1/message/1003',
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

    await service.handleUpdate(createRichForwardedChannelPostUpdateWithoutSender());

    expect(maxClient.sendMessageCopyWithInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-forward-rich-no-sender-1',
      '🔥<strong><u>MAX Docs</u></strong>\n\nВторой абзац',
      expect.objectContaining({
        textFormat: 'html',
        buttons: [
          [expect.objectContaining({ text: '💬 Комментарии · 0' })],
          [expect.objectContaining({ text: 'Предложить пост' })],
        ],
      }),
      undefined,
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-forward-rich-no-sender-1',
      {
        immediate: true,
      },
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
      undefined,
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
      undefined,
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
      undefined,
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
      undefined,
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

    expect(prisma.channelSettings.findMany).toHaveBeenNthCalledWith(1, {
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
      select: {
        chatId: true,
      },
      orderBy: {
        updatedAt: 'desc',
      },
    });
    expect(prisma.channelSettings.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        chatId: {
          in: ['channel-1'],
        },
      },
      include: {
        chat: {
          select: {
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
      sourceTag: 'channel_auto_post',
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
      {
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'channel_auto_post',
      },
    );
  });

  it('treats polling as a repair sweep and skips scans right after a webhook-seen channel post', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-06T15:10:00.000Z'));

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
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      listMessages: jest.fn().mockResolvedValue([]),
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
        CHANNEL_AUTO_POST_REPAIR_SWEEP_MS: 60_000,
      }) as never,
      undefined,
      undefined,
      adminService as never,
    );

    await service.handleUpdate(createChannelPostUpdate());
    await (service as any).processChannelAutoPostButtons();

    expect(maxClient.listMessages).not.toHaveBeenCalled();

    jest.setSystemTime(new Date('2026-03-06T15:11:01.000Z'));
    await (service as any).processChannelAutoPostButtons();

    expect(maxClient.listMessages).toHaveBeenCalledTimes(1);
    expect(maxClient.listMessages).toHaveBeenCalledWith('channel-1', {
      count: 10,
      trafficClass: 'background',
      sourceTag: 'channel_auto_post',
    });
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
      {
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'channel_auto_post',
      },
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
      {
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'channel_auto_post',
      },
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('channel-1', 'mid-polled-forward-1', {
      immediate: true,
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: 'channel_auto_post',
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

    expect(prisma.channelSettings.findMany).toHaveBeenCalledTimes(2);
    expect(maxClient.listMessages).toHaveBeenCalledTimes(1);
    expect(maxClient.listMessages).toHaveBeenCalledWith('channel-1', {
      count: 10,
      trafficClass: 'background',
      sourceTag: 'channel_auto_post',
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

  it('skips not-yet-due channels when selecting the next polling batch', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-30T02:30:00.000Z'));

    const prisma = {
      channelSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'channel-skip',
            autoPostButtonsMode: 'BOTH',
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
            updatedAt: new Date('2026-03-06T15:00:00.000Z'),
            chat: {
              admins: [{ userId: 'admin-1' }],
            },
          },
          {
            chatId: 'channel-due',
            autoPostButtonsMode: 'BOTH',
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
            updatedAt: new Date('2026-03-06T15:00:00.000Z'),
            chat: {
              admins: [{ userId: 'admin-1' }],
            },
          },
        ]),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      listMessages: jest.fn().mockResolvedValue([]),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      getChatAdminIds: jest.fn(),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock({
        CHANNEL_AUTO_POST_SCAN_MAX_CHANNELS: 2,
      }) as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );

    (service as any).channelAutoPostScanState.set('channel-skip', {
      latestTimestampMs: 0,
      latestMessageIdsAtTimestamp: [],
      idleStreak: 4,
      nextScanAtMs: Date.now() + 60_000,
    });

    await (service as any).processChannelAutoPostButtons();

    expect(maxClient.listMessages).toHaveBeenCalledTimes(1);
    expect(maxClient.listMessages).toHaveBeenCalledWith('channel-due', {
      count: 10,
      trafficClass: 'background',
      sourceTag: 'channel_auto_post',
    });
  });

  it('limits background auto-attach work per channel scan and catches up gradually', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-30T03:00:00.000Z'));

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
          timestamp: 1774810000000,
          sender: { user_id: 'admin-1' },
          body: { mid: 'mid-polled-batch-1', text: 'Пост 1', attachments: [] },
        },
        {
          timestamp: 1774810001000,
          sender: { user_id: 'admin-1' },
          body: { mid: 'mid-polled-batch-2', text: 'Пост 2', attachments: [] },
        },
        {
          timestamp: 1774810002000,
          sender: { user_id: 'admin-1' },
          body: { mid: 'mid-polled-batch-3', text: 'Пост 3', attachments: [] },
        },
        {
          timestamp: 1774810003000,
          sender: { user_id: 'admin-1' },
          body: { mid: 'mid-polled-batch-4', text: 'Пост 4', attachments: [] },
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
        CHANNEL_AUTO_POST_MAX_NEW_MESSAGES_PER_SCAN: 2,
      }) as never,
      undefined,
      undefined,
      adminService as never,
    );

    await (service as any).processChannelAutoPostButtons();
    jest.advanceTimersByTime(30_000);
    await (service as any).processChannelAutoPostButtons();

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(4);
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenNthCalledWith(
      1,
      'channel-1',
      'mid-polled-batch-1',
      'Пост 1',
      expect.any(Object),
      {
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'channel_auto_post',
      },
    );
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenNthCalledWith(
      2,
      'channel-1',
      'mid-polled-batch-2',
      'Пост 2',
      expect.any(Object),
      {
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'channel_auto_post',
      },
    );
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenNthCalledWith(
      3,
      'channel-1',
      'mid-polled-batch-3',
      'Пост 3',
      expect.any(Object),
      {
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'channel_auto_post',
      },
    );
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenNthCalledWith(
      4,
      'channel-1',
      'mid-polled-batch-4',
      'Пост 4',
      expect.any(Object),
      {
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'channel_auto_post',
      },
    );
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

  it('does not pause channel polling during recovery window without active pressure', async () => {
    const prisma = {
      channelSettings: {
        findMany: jest.fn().mockResolvedValue([]),
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
        reason: 'recovery window in progress',
        updatedAt: new Date().toISOString(),
        manualMode: null,
        queueLagSec: 0,
        action: {
          windowSec: 60,
          total: 100,
          success: 100,
          failure: 0,
          critical: 0,
          errorRate: 0,
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
    expect(prisma.channelSettings.findMany).toHaveBeenCalled();
  });

  it('routes poll-based auto-attach mutations through the background action lane', async () => {
    const prisma = {
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
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );

    await (
      service as unknown as {
        tryAutoAttachChannelMessageButtons: (params: {
          chatId: string;
          messageId: string;
          text: string | null;
          linkType: string | null;
          managedChannel: {
            channelSettings: {
              autoPostButtonsMode: 'BOTH';
              postSuggestionsEnabled: true;
              postSuggestionsButtonText: string;
              commentsEnabled: true;
            };
            adminUserIds: string[];
          };
          source: 'poll';
          senderId: string | null;
        }) => Promise<void>;
      }
    ).tryAutoAttachChannelMessageButtons({
      chatId: 'channel-1',
      messageId: 'mid-poll-1',
      text: 'Пост из фонового сканирования',
      linkType: null,
      managedChannel: {
        channelSettings: {
          autoPostButtonsMode: 'BOTH',
          postSuggestionsEnabled: true,
          postSuggestionsButtonText: '📰 Предложить пост',
          commentsEnabled: true,
        },
        adminUserIds: ['admin-1'],
      },
      source: 'poll',
      senderId: null,
    });

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-poll-1',
      'Пост из фонового сканирования',
      expect.objectContaining({
        buttons: expect.any(Array),
      }),
      {
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'channel_auto_post',
      },
    );
  });
});
