import type { MaxUpdate } from '@maxim/contracts';
import { SanctionAction } from '@prisma/client';
import { ModerationService } from './moderation.service';

function createSettings(overrides: Record<string, unknown> = {}) {
  return {
    id: 'settings-1',
    chatId: 'chat-1',
    duplicateWarnEnabled: true,
    duplicateKickEnabled: true,
    duplicateBanEnabled: true,
    antiDuplicateEnabled: true,
    duplicateWarnWindowSec: 12 * 60 * 60,
    duplicateWarnMaxCount: 2,
    duplicateKickWindowSec: 24 * 60 * 60,
    duplicateKickMaxCount: 3,
    duplicateBanWindowSec: 48 * 60 * 60,
    duplicateBanMaxCount: 4,
    linkPolicy: 'ALLOWLIST_ONLY',
    greetingEnabled: false,
    greetingBotMessageEnabled: true,
    greetingBotMessageText: '',
    greetingBotButtonEnabled: false,
    greetingBotButtonUrl: '',
    greetingBotButtonText: 'Открыть',
    deleteBotMessagesEnabled: true,
    deleteBotMessagesDelayMinutes: 2,
    removeBotsFromGroupEnabled: false,
    globalUserBlacklistEnabled: false,
    antiSpamEnabled: true,
    maxMessageLengthEnabled: false,
    maxMessageLength: 1500,
    photoMessageCooldownEnabled: false,
    photoMessageCooldownHours: 1,
    videoMessagesEnabled: true,
    fileMessagesEnabled: true,
    voiceMessagesEnabled: true,
    messageLimitsBotMessageEnabled: false,
    messageLimitsBotMessageText: '',
    messageLimitsBotButtonEnabled: false,
    messageLimitsBotButtonUrl: '',
    messageLimitsBotButtonText: 'Открыть',
    russianProfanityFilterEnabled: true,
    commercialAdsFilterEnabled: false,
    commercialAdsSensitivity: 'BALANCED',
    commercialAdsWarnThreshold: 45,
    commercialAdsDeleteThreshold: 65,
    profanityBotMessageEnabled: false,
    profanityWarnEnabled: false,
    profanityBanEnabled: false,
    profanityKickEnabled: false,
    textFiltersBotMessageEnabled: false,
    textFiltersBotMessageText: '',
    textFiltersWarnEnabled: false,
    textFiltersWarnMessageText: '',
    textFiltersBanEnabled: false,
    textFiltersKickEnabled: false,
    textFiltersBotButtonEnabled: false,
    textFiltersBotButtonUrl: '',
    textFiltersBotButtonText: 'Открыть',
    nightModeEnabled: false,
    nightModeStartTimeMinutes: 23 * 60,
    nightModeEndTimeMinutes: 8 * 60,
    nightModeTimezone: 'Europe/Moscow',
    nightModeBotMessageEnabled: true,
    nightModeBotMessageText: '',
    nightModeBotButtonEnabled: false,
    nightModeBotButtonUrl: '',
    nightModeBotButtonText: 'Открыть',
    linkBotMessageEnabled: true,
    linkBotMessageText: '',
    linkWarnEnabled: false,
    linkWarnMessageText: '',
    linkBanEnabled: false,
    linkKickEnabled: false,
    linkBotButtonEnabled: false,
    linkBotButtonUrl: '',
    linkBotButtonText: 'Открыть',
    duplicateBotMessageEnabled: false,
    duplicateBotMessageText: '',
    duplicateBotButtonEnabled: false,
    duplicateBotButtonUrl: '',
    duplicateBotButtonText: 'Открыть',
    banDurationHours: 6,
    warnThreshold: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createUpdate(): MaxUpdate {
  return {
    updateId: 'upd-1',
    type: 'message_created',
    message: {
      messageId: 'msg-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: 'same text',
      createdAt: new Date().toISOString(),
    },
    raw: {},
  };
}

function createBotAuthoredUpdate(): MaxUpdate {
  return {
    updateId: 'upd-bot-1',
    type: 'message_created',
    message: {
      messageId: 'msg-bot-1',
      chatId: 'chat-1',
      senderId: 'bot-1',
      text: 'service notice',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        sender: {
          id: 'bot-1',
          type: 'bot',
          is_bot: true,
        },
      },
    },
  };
}

function createServiceBotJoinedUpdate(): MaxUpdate {
  return {
    updateId: 'upd-service-bot-join-1',
    type: 'message_created',
    message: {
      messageId: 'msg-service-bot-join-1',
      chatId: 'chat-1',
      senderId: 'service-1',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        sender: {
          id: 'service-1',
          type: 'service',
          is_service: true,
        },
        body: {
          new_members: [
            {
              user_id: 'bot-joined-1',
              type: 'bot',
              is_bot: true,
            },
          ],
        },
      },
    },
  };
}

function createServiceUserJoinedUpdate(): MaxUpdate {
  return {
    updateId: 'upd-service-user-join-1',
    type: 'message_created',
    message: {
      messageId: 'msg-service-user-join-1',
      chatId: 'chat-1',
      senderId: 'service-1',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        sender: {
          id: 'service-1',
          type: 'service',
          is_service: true,
        },
        body: {
          new_members: [
            {
              user_id: 'user-black-2',
              type: 'user',
              display_name: 'Новый участник',
            },
          ],
        },
      },
    },
  };
}

function createServiceUserJoinedUpdateInDataEnvelope(): MaxUpdate {
  return {
    updateId: 'upd-service-user-join-envelope-1',
    type: 'message_created',
    message: {
      messageId: 'msg-service-user-join-envelope-1',
      chatId: 'chat-1',
      senderId: 'service-1',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      data: {
        message: {
          sender: {
            id: 'service-1',
            type: 'service',
            is_service: true,
          },
          body: {
            new_members: [
              {
                user_id: 'user-envelope-2',
                type: 'user',
                display_name: 'Новый участник из data',
              },
            ],
          },
        },
      },
    },
  };
}

function createServiceUserJoinedUpdateWithoutServiceSender(): MaxUpdate {
  return {
    updateId: 'upd-service-user-join-no-sender-1',
    type: 'message_created',
    message: {
      messageId: 'msg-service-user-join-no-sender-1',
      chatId: 'chat-1',
      senderId: '',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        body: {
          new_members: [
            {
              user_id: 'user-no-sender-2',
              type: 'user',
              display_name: 'Новый участник без sender',
            },
          ],
        },
      },
    },
  };
}

function createUserAddedUpdate(): MaxUpdate {
  return {
    updateId: 'upd-user-added-1',
    type: 'user_added',
    message: {
      messageId: 'user_added:upd-user-added-1',
      chatId: 'chat-1',
      senderId: 'user-added-1',
      senderName: 'Новый участник user_added',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'user_added',
      chat_id: 'chat-1',
      user: {
        user_id: 'user-added-1',
        type: 'user',
        display_name: 'Новый участник user_added',
      },
      timestamp: Date.now(),
    },
  };
}

function createBotStartedPrivateUpdate(): MaxUpdate {
  return {
    updateId: 'upd-bot-started-private-1',
    type: 'bot_started',
    message: {
      messageId: 'bot_started:upd-bot-started-private-1',
      chatId: '152517912',
      senderId: 'user-started-1',
      senderName: 'Пользователь bot_started',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'bot_started',
      chat_id: 152517912,
      chat: {
        id: 152517912,
        type: 'dialog',
      },
      user: {
        user_id: 'user-started-1',
        type: 'user',
        display_name: 'Пользователь bot_started',
      },
      timestamp: Date.now(),
    },
  };
}

function createBotStartedGroupUpdate(): MaxUpdate {
  return {
    updateId: 'upd-bot-started-group-1',
    type: 'bot_started',
    message: {
      messageId: 'bot_started:upd-bot-started-group-1',
      chatId: '-71527833503751',
      senderId: 'user-started-group-1',
      senderName: 'Пользователь bot_started group',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'bot_started',
      chat_id: -71527833503751,
      chat: {
        id: -71527833503751,
        type: 'chat',
      },
      user: {
        user_id: 'user-started-group-1',
        type: 'user',
        display_name: 'Пользователь bot_started group',
      },
      timestamp: Date.now(),
    },
  };
}

function createOldUpdate(): MaxUpdate {
  return {
    updateId: 'upd-old-1',
    type: 'message_created',
    message: {
      messageId: 'msg-old-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: 'old text',
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    },
    raw: {},
  };
}

function createForwardedUpdate(forwardedText: string): MaxUpdate {
  return {
    updateId: 'upd-forwarded-1',
    type: 'message_created',
    message: {
      messageId: 'msg-forwarded-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: 'коротко',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        body: {
          text: 'коротко',
          forwarded_message: {
            body: {
              text: forwardedText,
            },
          },
        },
      },
    },
  };
}

function createVideoAttachmentUpdate(): MaxUpdate {
  return {
    updateId: 'upd-video-1',
    type: 'message_created',
    message: {
      messageId: 'msg-video-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        attachments: [
          {
            type: 'video',
            payload: {
              url: 'https://cdn.example/video.mp4',
            },
          },
        ],
      },
    },
  };
}

function createVoiceAttachmentUpdate(): MaxUpdate {
  return {
    updateId: 'upd-voice-1',
    type: 'message_created',
    message: {
      messageId: 'msg-voice-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        attachments: [
          {
            type: 'voice',
            payload: {
              url: 'https://cdn.example/voice.ogg',
            },
          },
        ],
      },
    },
  };
}

function createForwardedVideoAttachmentUpdate(): MaxUpdate {
  return {
    updateId: 'upd-forwarded-video-1',
    type: 'message_created',
    message: {
      messageId: 'msg-forwarded-video-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: 'переслано',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        body: {
          text: 'переслано',
          forwarded_message: {
            attachments: [
              {
                type: 'video',
                payload: {
                  url: 'https://cdn.example/forwarded-video.mp4',
                },
              },
            ],
          },
        },
      },
    },
  };
}

function createForwardedVoiceAttachmentUpdate(): MaxUpdate {
  return {
    updateId: 'upd-forwarded-voice-1',
    type: 'message_created',
    message: {
      messageId: 'msg-forwarded-voice-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: 'переслано',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        body: {
          text: 'переслано',
          forwarded_message: {
            attachments: [
              {
                type: 'voice',
                payload: {
                  url: 'https://cdn.example/forwarded-voice.ogg',
                },
              },
            ],
          },
        },
      },
    },
  };
}

function createForwardedFileAttachmentUpdate(): MaxUpdate {
  return {
    updateId: 'upd-forwarded-file-1',
    type: 'message_created',
    message: {
      messageId: 'msg-forwarded-file-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: 'переслано',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        body: {
          text: 'переслано',
          forwarded_message: {
            attachments: [
              {
                type: 'file',
                payload: {
                  file_name: 'forwarded.pdf',
                  url: 'https://cdn.example/forwarded.pdf',
                },
              },
            ],
          },
        },
      },
    },
  };
}

describe('ModerationService', () => {
  it('ignores bot-authored messages when delete-bot toggle is disabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            removeBotsFromGroupEnabled: false,
            deleteBotMessagesEnabled: false,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalUserBlacklist: {
        upsert: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createBotAuthoredUpdate());

    expect(prisma.chat.upsert).toHaveBeenCalledTimes(1);
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('schedules auto-delete for bot-authored messages when toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            removeBotsFromGroupEnabled: false,
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalUserBlacklist: {
        upsert: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
      {
        get: jest.fn().mockReturnValue('bot-1'),
      } as never,
    );

    await service.handleUpdate(createBotAuthoredUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-bot-1', {
      delayMs: 2 * 60 * 1000,
    });
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'bot-1',
        messageId: 'msg-bot-1',
        ruleCode: 'BOT_MESSAGE_AUTO_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
  });

  it('removes bot-authored accounts from group when toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ removeBotsFromGroupEnabled: true }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalUserBlacklist: {
        upsert: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createBotAuthoredUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-bot-1');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).toHaveBeenCalledWith('chat-1', 'bot-1');
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'bot-1',
        messageId: 'msg-bot-1',
        ruleCode: 'BOT_ACCOUNT_KICK',
        action: SanctionAction.KICK,
      }),
    });
  });

  it('kicks bots immediately from service join events when toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ removeBotsFromGroupEnabled: true }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createServiceBotJoinedUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).toHaveBeenCalledWith('chat-1', 'bot-joined-1');
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'bot-joined-1',
        messageId: 'msg-service-bot-join-1',
        ruleCode: 'BOT_ACCOUNT_KICK',
        action: SanctionAction.KICK,
      }),
    });
  });

  it('sends greeting message for joined human members when greeting is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createServiceUserJoinedUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Добро пожаловать, "Новый участник"! добро пожаловать в чат.',
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-black-2',
        messageId: 'msg-service-user-join-1',
        ruleCode: 'GREETING_MESSAGE',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('sends greeting message for service join event wrapped in data.message envelope', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createServiceUserJoinedUpdateInDataEnvelope());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Добро пожаловать, "Новый участник из data"! добро пожаловать в чат.',
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-envelope-2',
        messageId: 'msg-service-user-join-envelope-1',
        ruleCode: 'GREETING_MESSAGE',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('sends greeting message when service sender marker is absent but new_members exists', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createServiceUserJoinedUpdateWithoutServiceSender());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Добро пожаловать, "Новый участник без sender"! добро пожаловать в чат.',
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-no-sender-2',
        messageId: 'msg-service-user-join-no-sender-1',
        ruleCode: 'GREETING_MESSAGE',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('sends greeting message for user_added update', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createUserAddedUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Добро пожаловать, "Новый участник user_added"! добро пожаловать в чат.',
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-added-1',
        messageId: 'user_added:upd-user-added-1',
        ruleCode: 'GREETING_MESSAGE',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('sends instruction for personal bot_started update and skips moderation flow', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createBotStartedPrivateUpdate());

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      '152517912',
      [
        'Отдел чат-порядка «Майор Максимов» на месте. Чат взят под контроль.',
        '',
        'Коротко по делу:',
        '- Мат, реклама и мутные ссылки - под нож.',
        '- Повторяешь одно и то же - сначала предупреждение, потом дверь.',
        '- Слишком длинные простыни, лишние файлы и голосовые тоже ловлю.',
        '- Ночью в чате тишина: шумных быстро успокаиваю.',
        '- Новых людей встречаю, ботов из группы вывожу.',
        '- Могу сделать рассылку: текст, кнопка, фото, сразу или по времени.',
        '',
        'Настройка в mini app: открой бота в MAX и нажми «Открыть».',
        'Там включаешь правила и тексты так, как нужно вашему чату.',
        '',
        'Схема простая: сначала слово, потом протокол.',
      ].join('\n'),
      {
        button: {
          text: 'Поддержка',
          url: 'https://max.ru/join/qX7U_Hj-L-xMJG8V7wlF6dD-6a6cXIzTBGRtU2mRMzk',
        },
      },
    );
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('does not send instruction for group bot_started update and skips moderation flow', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createBotStartedGroupUpdate());

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('does not send greeting message when greeting toggle is disabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: false,
            greetingBotMessageEnabled: true,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createServiceUserJoinedUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('kicks and deletes message from globally blacklisted sender when toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            globalUserBlacklistEnabled: true,
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
          }),
          domains: [],
          admins: [],
        }),
      },
      globalUserBlacklist: {
        findUnique: jest.fn().mockResolvedValue({ userId: 'user-1' }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.kickMember).toHaveBeenCalledWith('chat-1', 'user-1');
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'GLOBAL_USER_BLACKLIST_KICK',
        action: SanctionAction.KICK,
      }),
    });
  });

  it('kicks globally blacklisted user on service join event when toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ globalUserBlacklistEnabled: true }),
          domains: [],
          admins: [],
        }),
      },
      globalUserBlacklist: {
        findMany: jest.fn().mockResolvedValue([{ userId: 'user-black-2' }]),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createServiceUserJoinedUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).toHaveBeenCalledWith('chat-1', 'user-black-2');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-black-2',
        messageId: 'msg-service-user-join-1',
        ruleCode: 'GLOBAL_USER_BLACKLIST_KICK',
        action: SanctionAction.KICK,
      }),
    });
  });

  it('deletes messages silently while 6h active ban is in effect', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'ban-1',
          createdAt: new Date(Date.now() - 5 * 60 * 1000),
        }),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'BAN_ACTIVE_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
  });

  it('deletes messages during night mode silently', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            nightModeEnabled: true,
            nightModeStartTimeMinutes: 0,
            nightModeEndTimeMinutes: 0,
            nightModeBotMessageEnabled: true,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'NIGHT_MODE_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
  });

  it('sends scheduled night closed notice once per active window', async () => {
    let noticeCreated = false;
    const nowParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const currentHour = Number(nowParts.find((item) => item.type === 'hour')?.value ?? '0');
    const currentMinute = Number(nowParts.find((item) => item.type === 'minute')?.value ?? '0');
    const startMinutes = currentHour * 60 + currentMinute;
    const endMinutes = (startMinutes + 60) % (24 * 60);

    const prisma = {
      chatSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'chat-1',
            nightModeStartTimeMinutes: startMinutes,
            nightModeEndTimeMinutes: endMinutes,
            nightModeTimezone: 'Europe/Moscow',
            nightModeBotMessageText: '',
            nightModeBotButtonEnabled: false,
            nightModeBotButtonUrl: '',
            nightModeBotButtonText: 'Открыть',
          },
        ]),
      },
      moderationEvent: {
        findFirst: jest.fn().mockImplementation((query: { where?: Record<string, unknown> }) => {
          if (query.where?.ruleCode === 'NIGHT_MODE_NOTICE') {
            return Promise.resolve(noticeCreated ? { id: 'evt-night-notice-1' } : null);
          }

          return Promise.resolve(null);
        }),
        create: jest.fn().mockImplementation((payload: { data: { ruleCode?: string } }) => {
          if (payload.data.ruleCode === 'NIGHT_MODE_NOTICE') {
            noticeCreated = true;
          }
          return Promise.resolve(payload);
        }),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await (service as unknown as { processNightModeAnnouncements: () => Promise<void> })
      .processNightModeAnnouncements();
    await (service as unknown as { processNightModeAnnouncements: () => Promise<void> })
      .processNightModeAnnouncements();

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('Чат сейчас закрыт на ночь'),
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        ruleCode: 'NIGHT_MODE_NOTICE',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('does not apply night mode deletion to chat admins', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            nightModeEnabled: true,
            nightModeStartTimeMinutes: 0,
            nightModeEndTimeMinutes: 0,
            nightModeBotMessageEnabled: true,
          }),
          domains: [],
          admins: [{ userId: 'user-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.findFirst).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('handles duplicate escalation separately and does not call SanctionService', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'KICK',
          count: 3,
          threshold: 3,
          windowSec: 24 * 60 * 60,
          hash: 'abc123',
          nextAction: 'BAN',
        },
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createUpdate());

    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).toHaveBeenCalledWith('chat-1', 'user-1');
    expect(maxClient.banMember).not.toHaveBeenCalled();

    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'DUPLICATE_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'DUPLICATE_KICK',
        action: SanctionAction.KICK,
        metadata: expect.objectContaining({
          windowSec: 24 * 60 * 60,
          count: 3,
          threshold: 3,
          nextStep: 'BAN',
        }),
      }),
    });
  });

  it('sends duplicate explanation when duplicate bot toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ duplicateBotMessageEnabled: true }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'WARN',
          count: 2,
          threshold: 2,
          windowSec: 12 * 60 * 60,
          hash: 'dup-hash-1',
          nextAction: 'KICK',
        },
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Сообщение пользователя "Алексей" удалено как дубль. Пользователю вынесено предупреждение.',
    );
  });

  it('sends duplicate explanation with inline button when button toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            duplicateBotMessageEnabled: true,
            duplicateBotButtonEnabled: true,
            duplicateBotButtonUrl: 'https://max.ru/help/bots',
            duplicateBotButtonText: 'Правила',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'WARN',
          count: 2,
          threshold: 2,
          windowSec: 12 * 60 * 60,
          hash: 'dup-hash-button',
          nextAction: 'KICK',
        },
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Сообщение пользователя "Алексей" удалено как дубль. Пользователю вынесено предупреждение.',
      {
        button: {
          text: 'Правила',
          url: 'https://max.ru/help/bots',
        },
      },
    );
  });

  it('sends 6h ban notice for duplicate BAN even when duplicate toggle is disabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ duplicateBotMessageEnabled: false }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'BAN',
          count: 4,
          threshold: 4,
          windowSec: 48 * 60 * 60,
          hash: 'dup-ban-1',
          nextAction: null,
        },
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Пользователю "Алексей" выдан временный бан на 6ч.',
    );
  });

  it('uses configured ban duration in ban notice', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ duplicateBotMessageEnabled: false, banDurationHours: 12 }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'BAN',
          count: 4,
          threshold: 4,
          windowSec: 48 * 60 * 60,
          hash: 'dup-ban-12h',
          nextAction: null,
        },
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Пользователю "Алексей" выдан временный бан на 12ч.',
    );
  });

  it('deletes duplicate hit and sends explanation before WARN stage', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ duplicateBotMessageEnabled: true }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateHit: {
          count: 1,
          windowSec: 60,
          hash: 'dup-hit-1',
        },
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createUpdate());

    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Сообщение пользователя "Алексей" удалено: в этом чате нельзя отправлять дубли сообщений.',
    );
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'DUPLICATE_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
  });

  it('does not call SanctionService for text filter violations', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'PROFANITY', score: 0.95, reason: 'Profanity detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn().mockResolvedValue(SanctionAction.WARN),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createUpdate());

    expect(prisma.violation.create).toHaveBeenCalledTimes(1);
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        ruleCode: 'PROFANITY_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'PROFANITY',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('issues WARN on second text-filter violation in 24h when warning stage is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            profanityBotMessageEnabled: false,
            profanityWarnEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'PROFANITY', score: 0.95, reason: 'Profanity detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Пользователю "Алексей" вынесено предупреждение за нецензурную лексику.',
    );
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'PROFANITY',
        action: SanctionAction.WARN,
        metadata: expect.objectContaining({
          textFilterViolationCount24h: 2,
          textFilterEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it('uses configured ban duration for text-filter BAN escalation', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            profanityBotMessageEnabled: false,
            profanityBanEnabled: true,
            banDurationHours: 12,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(3),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'PROFANITY', score: 0.95, reason: 'Profanity detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Пользователю "Алексей" выдан временный бан на 12ч.',
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'PROFANITY',
        action: SanctionAction.BAN,
        metadata: expect.objectContaining({
          banDurationHours: 12,
          textFilterViolationCount24h: 3,
          textFilterEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it('kicks user on fourth text-filter violation in 24h when kick stage is enabled', async () => {
    const globalUserBlacklist = {
      upsert: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            profanityBotMessageEnabled: false,
            profanityKickEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(4),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalUserBlacklist,
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'PROFANITY', score: 0.95, reason: 'Profanity detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.kickMember).toHaveBeenCalledWith('chat-1', 'user-1');
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Пользователь "Алексей" удален из чата за повторную нецензурную лексику.',
    );
    expect(globalUserBlacklist.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      create: {
        userId: 'user-1',
        sourceChatId: 'chat-1',
        reason: 'KICK_SANCTION',
      },
      update: {
        sourceChatId: 'chat-1',
        reason: 'KICK_SANCTION',
      },
    });
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'PROFANITY',
        action: SanctionAction.KICK,
        metadata: expect.objectContaining({
          textFilterViolationCount24h: 4,
          textFilterEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it('does not send link explanation when link bot toggle is disabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ linkBotMessageEnabled: false }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn().mockResolvedValue(SanctionAction.WARN),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'LINK_BLOCKED',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('deletes commercial ad and sends first-step explanation with button', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            commercialAdsFilterEnabled: true,
            textFiltersBotMessageEnabled: true,
            textFiltersWarnEnabled: true,
            textFiltersBotButtonEnabled: true,
            textFiltersBotButtonUrl: 'https://max.ru/channel/rules',
            textFiltersBotButtonText: 'Правила',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'COMMERCIAL_AD',
            score: 0.9,
            reason: 'Detected ad',
            metadata: {
              confidenceScore: 88,
              decisionBand: 'HIGH',
              matchedSignals: ['intent:продам', 'contact:пишите в лс'],
              negativeSignals: [],
              appliedThresholds: {
                warnThreshold: 45,
                deleteThreshold: 65,
                sensitivity: 'BALANCED',
              },
            },
          },
        ],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Сообщение пользователя "Алексей" удалено: коммерческие объявления в этом чате запрещены.',
      {
        button: {
          text: 'Правила',
          url: 'https://max.ru/channel/rules',
        },
      },
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        ruleCode: 'COMMERCIAL_AD_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'COMMERCIAL_AD',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('deletes low confidence COMMERCIAL_AD as regular text-filter violation', async () => {
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            commercialAdsFilterEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'COMMERCIAL_AD',
            score: 0.34,
            reason: 'Low confidence ad',
            metadata: {
              confidenceScore: 34,
              decisionBand: 'LOW',
              matchedSignals: ['promo:скидк'],
              negativeSignals: ['context:question'],
              appliedThresholds: {
                warnThreshold: 45,
                deleteThreshold: 65,
                sensitivity: 'BALANCED',
              },
            },
          },
        ],
      }),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(prisma.violation.create).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        ruleCode: 'COMMERCIAL_AD_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'COMMERCIAL_AD',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('sends warning on second commercial violation when explanation and warning are enabled', async () => {
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            commercialAdsFilterEnabled: true,
            textFiltersBotMessageEnabled: true,
            textFiltersWarnEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'COMMERCIAL_AD',
            score: 0.92,
            reason: 'High confidence ad',
            metadata: {
              confidenceScore: 92,
              decisionBand: 'HIGH',
              matchedSignals: ['intent:продам', 'contact:пишите в лс', 'transaction:price'],
              negativeSignals: [],
              appliedThresholds: {
                warnThreshold: 45,
                deleteThreshold: 65,
                sensitivity: 'BALANCED',
              },
            },
          },
        ],
      }),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Пользователю "Алексей" вынесено предупреждение за коммерческую рекламу.',
    );
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'COMMERCIAL_AD',
        action: SanctionAction.WARN,
        metadata: expect.objectContaining({
          textFilterViolationCount24h: 2,
          textFilterEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it('prioritizes link moderation over duplicate escalation for link messages', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ linkBotMessageEnabled: true }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
        duplicateDecision: {
          action: 'KICK',
          count: 3,
          threshold: 3,
          windowSec: 24 * 60 * 60,
          hash: 'dup-link-1',
          nextAction: 'BAN',
        },
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Сообщение пользователя "Алексей" удалено: в этом чате нельзя отправлять ссылки. Пожалуйста, без ссылок.',
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'LINK_BLOCKED',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('sends link explanation with inline button when button toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkBotButtonEnabled: true,
            linkBotButtonUrl: 'https://max.ru/channel/news',
            linkBotButtonText: 'Канал',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Сообщение пользователя "Алексей" удалено: в этом чате нельзя отправлять ссылки. Пожалуйста, без ссылок.',
      {
        button: {
          text: 'Канал',
          url: 'https://max.ru/channel/news',
        },
      },
    );
  });

  it('sends link explanation for old messages when link bot toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ linkBotMessageEnabled: true }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn().mockResolvedValue(SanctionAction.WARN),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createOldUpdate());

    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.notifyModerators).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Сообщение пользователя "Алексей" нарушает правило: в этом чате нельзя отправлять ссылки. Пожалуйста, без ссылок.',
    );
  });

  it('issues WARN on second link in 24h when link warning stage is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: false,
            linkWarnEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Пользователю "Алексей" вынесено предупреждение за ссылку. В этом чате нельзя отправлять ссылки.',
    );
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'LINK_BLOCKED',
        action: SanctionAction.WARN,
        metadata: expect.objectContaining({
          linkViolationCount24h: 2,
          linkEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it('uses configured ban duration for link BAN escalation', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: false,
            linkBanEnabled: true,
            banDurationHours: 12,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(3),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Пользователю "Алексей" выдан временный бан на 12ч.',
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'LINK_BLOCKED',
        action: SanctionAction.BAN,
        metadata: expect.objectContaining({
          banDurationHours: 12,
          linkViolationCount24h: 3,
          linkEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it('kicks user on fourth link in 24h when link kick stage is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: false,
            linkKickEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(4),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.kickMember).toHaveBeenCalledWith('chat-1', 'user-1');
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Пользователь "Алексей" удален из чата за повторные сообщения со ссылками.',
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'LINK_BLOCKED',
        action: SanctionAction.KICK,
        metadata: expect.objectContaining({
          linkViolationCount24h: 4,
          linkEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it('still sends duplicate explanation when message deletion fails', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ duplicateBotMessageEnabled: true }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'WARN',
          count: 2,
          threshold: 2,
          windowSec: 12 * 60 * 60,
          hash: 'hash-1',
          nextAction: 'KICK',
        },
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn().mockRejectedValue(new Error('delete failed')),
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
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'DUPLICATE_WARN',
        action: SanctionAction.WARN,
      }),
    });
  });

  it('counts forwarded text length for MESSAGE_TOO_LONG and skips sanctions', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ maxMessageLengthEnabled: true, maxMessageLength: 100 }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest
        .fn()
        .mockImplementation(
          async (params: { effectiveLength?: number; settings: { maxMessageLength: number } }) => {
            const length = params.effectiveLength ?? 0;
            if (length > params.settings.maxMessageLength) {
              return {
                violations: [
                  {
                    ruleCode: 'MESSAGE_TOO_LONG',
                    score: 0.82,
                    reason: 'Message too long',
                  },
                ],
              };
            }

            return { violations: [] };
          },
        ),
    };
    const sanctionService = {
      resolveAction: jest.fn().mockResolvedValue(SanctionAction.WARN),
    };
    const maxClient = {
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
    );

    const forwarded = 'x'.repeat(180);
    await service.handleUpdate(createForwardedUpdate(forwarded));

    expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      effectiveLength?: number;
    };
    expect(detectionArgs.effectiveLength).toBeGreaterThan('коротко'.length);
    expect(detectionArgs.effectiveLength).toBeGreaterThan(100);

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-forwarded-1');
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-forwarded-1',
        ruleCode: 'MESSAGE_TOO_LONG',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('includes actual and required length in MESSAGE_TOO_LONG bot explanation', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            maxMessageLengthEnabled: true,
            maxMessageLength: 100,
            messageLimitsBotMessageEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest
        .fn()
        .mockImplementation(
          async (params: { effectiveLength?: number; settings: { maxMessageLength: number } }) => {
            const length = params.effectiveLength ?? 0;
            if (length > params.settings.maxMessageLength) {
              return {
                violations: [
                  {
                    ruleCode: 'MESSAGE_TOO_LONG',
                    score: 0.82,
                    reason: 'Message too long',
                  },
                ],
              };
            }

            return { violations: [] };
          },
        ),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    const forwarded = 'x'.repeat(180);
    await service.handleUpdate(createForwardedUpdate(forwarded));

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Сообщение пользователя "Алексей" удалено: длина сообщения 187 символов, лимит 100.',
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
  });

  it('detects video attachment in raw payload and deletes message without sanctions', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ videoMessagesEnabled: false }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockImplementation(async (params: { hasVideoAttachment?: boolean }) => {
        if (params.hasVideoAttachment) {
          return {
            violations: [{ ruleCode: 'VIDEO_BLOCKED', score: 0.88, reason: 'Video disabled' }],
          };
        }

        return { violations: [] };
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createVideoAttachmentUpdate());

    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      hasVideoAttachment?: boolean;
    };
    expect(detectionArgs.hasVideoAttachment).toBe(true);
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-video-1');
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'VIDEO_BLOCKED',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('detects forwarded video attachment and moderates it as regular message content', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ videoMessagesEnabled: false }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockImplementation(async (params: { hasVideoAttachment?: boolean }) => {
        if (params.hasVideoAttachment) {
          return {
            violations: [{ ruleCode: 'VIDEO_BLOCKED', score: 0.88, reason: 'Video disabled' }],
          };
        }

        return { violations: [] };
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createForwardedVideoAttachmentUpdate());

    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      hasVideoAttachment?: boolean;
    };
    expect(detectionArgs.hasVideoAttachment).toBe(true);
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-forwarded-video-1');
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'VIDEO_BLOCKED',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('detects forwarded voice attachment and moderates it as regular message content', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ voiceMessagesEnabled: false }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockImplementation(async (params: { hasVoiceAttachment?: boolean }) => {
        if (params.hasVoiceAttachment) {
          return {
            violations: [{ ruleCode: 'VOICE_BLOCKED', score: 0.88, reason: 'Voice disabled' }],
          };
        }

        return { violations: [] };
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createForwardedVoiceAttachmentUpdate());

    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      hasVoiceAttachment?: boolean;
    };
    expect(detectionArgs.hasVoiceAttachment).toBe(true);
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-forwarded-voice-1');
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'VOICE_BLOCKED',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('detects forwarded file attachment and moderates it as regular message content', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ fileMessagesEnabled: false }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockImplementation(async (params: { hasFileAttachment?: boolean }) => {
        if (params.hasFileAttachment) {
          return {
            violations: [{ ruleCode: 'FILE_BLOCKED', score: 0.88, reason: 'File disabled' }],
          };
        }

        return { violations: [] };
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createForwardedFileAttachmentUpdate());

    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      hasFileAttachment?: boolean;
    };
    expect(detectionArgs.hasFileAttachment).toBe(true);
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-forwarded-file-1');
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'FILE_BLOCKED',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('sends voice restriction explanation with button when message-limits toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            voiceMessagesEnabled: false,
            messageLimitsBotMessageEnabled: true,
            messageLimitsBotButtonEnabled: true,
            messageLimitsBotButtonUrl: 'https://max.ru/channel/rules',
            messageLimitsBotButtonText: 'Правила чата',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockImplementation(async (params: { hasVoiceAttachment?: boolean }) => {
        if (params.hasVoiceAttachment) {
          return {
            violations: [{ ruleCode: 'VOICE_BLOCKED', score: 0.88, reason: 'Voice disabled' }],
          };
        }

        return { violations: [] };
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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
    );

    await service.handleUpdate(createVoiceAttachmentUpdate());

    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      hasVoiceAttachment?: boolean;
    };
    expect(detectionArgs.hasVoiceAttachment).toBe(true);
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-voice-1');
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Сообщение пользователя "Алексей" удалено: голосовые сообщения в этом чате отключены.',
      {
        button: {
          text: 'Правила чата',
          url: 'https://max.ru/channel/rules',
        },
      },
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
  });
});
