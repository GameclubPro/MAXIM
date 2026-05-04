import { chatSettingsSchema, type MaxUpdate } from '@maxim/contracts';
import { ModerationService } from './moderation.service';

function createChatMessageUpdate(options?: {
  senderId?: string;
  senderName?: string;
  messageId?: string;
  text?: string;
  inlineKeyboard?: boolean;
}): MaxUpdate {
  const senderId = options?.senderId ?? 'user-1';
  const senderName = options?.senderName ?? 'Участник';
  const messageId = options?.messageId ?? 'mid-chat-1';
  const text = options?.text ?? 'Новое сообщение в чате';

  return {
    updateId: `upd-${messageId}`,
    type: 'message_created',
    message: {
      messageId,
      chatId: 'chat-1',
      senderId,
      senderName,
      text,
      createdAt: new Date('2026-03-20T07:10:00.000Z').toISOString(),
    },
    raw: {
      message: {
        recipient: {
          chat_id: 'chat-1',
          chat_type: 'chat',
        },
        sender: {
          user_id: senderId,
          is_bot: false,
        },
        body: {
          attachments: options?.inlineKeyboard ? [{ type: 'inline_keyboard' }] : [],
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

function createService(
  settingsOverrides: Record<string, unknown>,
  adminUserIds: string[] = ['admin-1'],
) {
  const prisma = {
    chat: {
      upsert: jest.fn().mockResolvedValue({
        id: 'chat-1',
        title: 'Общий чат',
        settings: chatSettingsSchema.parse(settingsOverrides),
        rules: null,
        domains: [],
        admins: [],
      }),
    },
    auditLog: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(undefined),
    },
    violation: {
      create: jest.fn(),
    },
    moderationEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
  };
  const ruleEngine = {
    detect: jest.fn().mockResolvedValue({
      violations: [],
      duplicateDecision: null,
      duplicateHit: null,
    }),
  };
  const sanctionService = {
    resolveAction: jest.fn(),
  };
  const maxClient = {
    getChatAdminIds: jest.fn().mockResolvedValue(adminUserIds),
    editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    sendMessageCopyWithInlineKeyboard: jest.fn().mockResolvedValue({
      messageId: 'mid-bot-copy-1',
      url: 'https://max.ru/chats/chat-1/message/bot-copy-1',
    }),
    sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
      messageId: 'mid-bot-reply-1',
      url: 'https://max.ru/chats/chat-1/message/bot-reply-1',
    }),
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

  return {
    prisma,
    ruleEngine,
    maxClient,
    service,
  };
}

describe('ModerationService chat comment buttons', () => {
  it('auto-attaches the comments button to a fresh admin message', async () => {
    const { prisma, ruleEngine, maxClient, service } = createService({
      commentsEnabled: true,
      commentsAdminsEnabled: true,
      commentsAllEnabled: false,
      commentsChatBroadcastsEnabled: false,
    });

    await service.handleUpdate(
      createChatMessageUpdate({
        senderId: 'admin-1',
        senderName: 'Админ',
        messageId: 'mid-admin-1',
        text: 'Пост админа',
      }),
    );

    expect(maxClient.sendMessageCopyWithInlineKeyboard).toHaveBeenCalledWith(
      'chat-1',
      'mid-admin-1',
      'Пост админа',
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: '💬 Комментарии · 0', type: 'link' })]],
        debugContext: {
          screen: 'chat-auto-comments',
          action: 'replace-admin-message-with-bot-copy',
        },
      }),
      undefined,
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-admin-1', {
      immediate: true,
    });
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          actorUserId: 'admin-1',
          action: 'AUTO_ATTACH_CHAT_COMMENTS',
          payload: expect.objectContaining({
            deliveryMode: 'replace_with_bot_message',
            replacementMessageId: 'mid-bot-copy-1',
            originalDeleted: true,
          }),
        }),
      }),
    );
    expect(ruleEngine.detect).not.toHaveBeenCalled();
  });

  it('keeps the bot copy if deleting the original admin message fails', async () => {
    const { prisma, maxClient, service } = createService({
      commentsEnabled: true,
      commentsAdminsEnabled: true,
      commentsAllEnabled: false,
      commentsChatBroadcastsEnabled: false,
    });
    maxClient.deleteMessage.mockRejectedValue({
      response: {
        status: 200,
      },
      message: 'Delete failed',
    });

    await service.handleUpdate(
      createChatMessageUpdate({
        senderId: 'admin-1',
        senderName: 'Админ',
        messageId: 'mid-admin-fallback',
        text: 'Пост админа для fallback',
      }),
    );

    expect(maxClient.sendMessageCopyWithInlineKeyboard).toHaveBeenCalledWith(
      'chat-1',
      'mid-admin-fallback',
      'Пост админа для fallback',
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: '💬 Комментарии · 0', type: 'link' })]],
      }),
      undefined,
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            messageId: 'mid-admin-fallback',
            deliveryMode: 'replace_with_bot_message',
            replacementMessageId: 'mid-bot-copy-1',
            originalDeleted: false,
          }),
        }),
      }),
    );
  });

  it('does not attach the comments button to a regular message when only the legacy all toggle is enabled', async () => {
    const { maxClient, service } = createService({
      commentsEnabled: true,
      commentsAdminsEnabled: false,
      commentsAllEnabled: true,
      commentsChatBroadcastsEnabled: false,
    });

    await service.handleUpdate(
      createChatMessageUpdate({
        senderId: 'user-2',
        senderName: 'Обычный участник',
        messageId: 'mid-user-2',
        text: 'Сообщение участника',
      }),
    );

    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('does not attach the comments button to a regular message when only admin posts are enabled', async () => {
    const { maxClient, service } = createService({
      commentsEnabled: true,
      commentsAdminsEnabled: true,
      commentsAllEnabled: false,
      commentsChatBroadcastsEnabled: false,
    });

    await service.handleUpdate(
      createChatMessageUpdate({
        senderId: 'user-3',
        senderName: 'Участник',
        messageId: 'mid-user-3',
      }),
    );

    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
  });

  it('does not overwrite an existing inline keyboard on the message', async () => {
    const { maxClient, service } = createService({
      commentsEnabled: true,
      commentsAdminsEnabled: true,
      commentsAllEnabled: false,
      commentsChatBroadcastsEnabled: false,
    });

    await service.handleUpdate(
      createChatMessageUpdate({
        senderId: 'admin-1',
        senderName: 'Админ',
        messageId: 'mid-admin-inline',
        inlineKeyboard: true,
      }),
    );

    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
  });
});
