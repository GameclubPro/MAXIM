import {
  channelSettingsSchema,
  chatSettingsSchema,
  type ManagedPoll,
  type MaxUpdate,
} from '@maxim/contracts';
import { PrivateControlService } from './private-control.service';

function createPrivateTextUpdate(text: string): MaxUpdate {
  return {
    updateId: `upd-text-${Date.now()}`,
    type: 'message_created',
    message: {
      messageId: `msg-${Date.now()}`,
      chatId: '152517912',
      senderId: 'user-1',
      senderName: 'Тестовый пользователь',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        body: {
          text,
        },
        sender: {
          user_id: 'user-1',
          name: 'Тестовый пользователь',
        },
        recipient: {
          chat_id: 152517912,
          chat_type: 'dialog',
        },
      },
    },
  };
}

function createPrivateCallbackUpdate(payload: string): MaxUpdate {
  return {
    updateId: `upd-cb-${Date.now()}`,
    type: 'message_callback',
    message: {
      messageId: `msg-cb-${Date.now()}`,
      chatId: '152517912',
      senderId: '613002203036',
      senderName: 'Майор Максимов',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_callback',
      callback: {
        callback_id: 'callback-1',
        payload,
        user: {
          user_id: 'user-1',
          name: 'Тестовый пользователь',
        },
      },
      message: {
        recipient: {
          chat_id: 152517912,
          chat_type: 'dialog',
        },
      },
    },
  };
}

function createBotStartedPrivateUpdate(): MaxUpdate {
  return {
    updateId: `upd-bot-started-${Date.now()}`,
    type: 'bot_started',
    message: {
      messageId: `bot-started-${Date.now()}`,
      chatId: '152517912',
      senderId: 'user-1',
      senderName: 'Тестовый пользователь',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'bot_started',
      chat_id: 152517912,
      start_payload: 'broadcast_handoff',
      user: {
        user_id: 'user-1',
        name: 'Тестовый пользователь',
      },
      chat: {
        chat_id: 152517912,
        type: 'dialog',
      },
    },
  };
}

const defaultSettings = chatSettingsSchema.parse({});
const defaultChannelSettings = channelSettingsSchema.parse({});

function createPoll(overrides: Partial<ManagedPoll> = {}): ManagedPoll {
  return {
    question: '',
    options: ['', ''],
    status: 'DRAFT',
    activeVersion: 0,
    publishedMessageId: null,
    publishedUrl: null,
    publishedAt: null,
    closedAt: null,
    totalVotes: 0,
    optionResults: [
      { option: '', votes: 0, percent: 0 },
      { option: '', votes: 0, percent: 0 },
    ],
    ...overrides,
  };
}

function createHarness(
  overrides: {
    settings?: typeof defaultSettings;
    channelSettings?: typeof defaultChannelSettings;
    adminService?: Record<string, unknown>;
  } = {},
) {
  const chats = [
    {
      id: '-70000000000001',
      title: 'Тестовый чат 1',
      createdAt: new Date().toISOString(),
      entityType: 'chat' as const,
    },
  ];
  const channels = [
    {
      id: '-80000000000001',
      title: 'Тестовый канал 1',
      createdAt: new Date().toISOString(),
      entityType: 'channel' as const,
    },
  ];

  const maxClient = {
    sendMessage: jest.fn().mockResolvedValue(undefined),
    answerCallback: jest.fn().mockResolvedValue(undefined),
  };

  const adminService = {
    listManagedEntities: jest.fn().mockImplementation(async (_actor, entityType = 'all') => {
      if (entityType === 'channel') {
        return channels;
      }
      if (entityType === 'chat') {
        return chats;
      }
      return [...chats, ...channels];
    }),
    listChats: jest.fn().mockResolvedValue(chats),
    getSettings: jest.fn().mockResolvedValue(overrides.settings ?? defaultSettings),
    updateSettings: jest.fn().mockResolvedValue(overrides.settings ?? defaultSettings),
    applySettingsToAllChats: jest.fn().mockResolvedValue({
      sourceChatId: chats[0].id,
      updatedChats: 1,
      appliedChatIds: [chats[0].id],
    }),
    getDomainAllowlistDetails: jest.fn().mockResolvedValue([]),
    addDomain: jest.fn().mockResolvedValue(undefined),
    removeDomain: jest.fn().mockResolvedValue(undefined),
    scheduleDomainRemoval: jest.fn().mockResolvedValue(undefined),
    getGlobalUserBlacklist: jest.fn().mockResolvedValue([]),
    addGlobalUserBlacklistUser: jest.fn().mockResolvedValue(undefined),
    removeGlobalUserBlacklistUser: jest.fn().mockResolvedValue(undefined),
    sendBroadcast: jest.fn().mockResolvedValue({ targetChats: 1, sentChats: 1, failedChats: 0 }),
    sendChannelBroadcast: jest
      .fn()
      .mockResolvedValue({ targetChats: 1, sentChats: 1, failedChats: 0 }),
    getEvents: jest.fn().mockResolvedValue([]),
    getLogsDashboard: jest.fn().mockResolvedValue({
      membership: { joinedUsers: 0, leftUsers: 0 },
      violationsSummary: { warn: 0, deleteMessage: 0, kick: 0, ban: 0, total: 0 },
      violations: [],
    }),
    applyManualModerationAction: jest.fn().mockResolvedValue({ success: true, message: 'Готово' }),
    getChatPoll: jest.fn().mockResolvedValue(createPoll()),
    updateChatPoll: jest.fn().mockImplementation(async (_chatId, _actor, draft) =>
      createPoll({
        question: draft.question,
        options: draft.options,
      }),
    ),
    publishChatPoll: jest.fn().mockResolvedValue(
      createPoll({
        question: 'Выбираем режим?',
        status: 'ACTIVE',
        activeVersion: 1,
        publishedMessageId: 'mid-poll-1',
        publishedUrl: 'https://max.ru/chats/chat-1/message/1',
      }),
    ),
    closeChatPoll: jest.fn().mockResolvedValue(
      createPoll({
        status: 'CLOSED',
      }),
    ),
    getChannelPoll: jest.fn().mockResolvedValue(createPoll()),
    updateChannelPoll: jest.fn().mockResolvedValue(createPoll()),
    publishChannelPoll: jest.fn().mockResolvedValue(
      createPoll({
        status: 'ACTIVE',
        activeVersion: 1,
        publishedMessageId: 'mid-channel-poll-1',
        publishedUrl: 'https://max.ru/chats/channel-1/message/1',
      }),
    ),
    closeChannelPoll: jest.fn().mockResolvedValue(createPoll({ status: 'CLOSED' })),
    getChannelSettings: jest
      .fn()
      .mockResolvedValue(overrides.channelSettings ?? defaultChannelSettings),
    updateChannelSettings: jest
      .fn()
      .mockResolvedValue(overrides.channelSettings ?? defaultChannelSettings),
    publishChannelEngagementMessage: jest.fn().mockResolvedValue(undefined),
    ...overrides.adminService,
  };

  const service = new PrivateControlService(
    maxClient as never,
    adminService as never,
    undefined,
    {
      get: jest.fn((key: string) => {
        if (key === 'MAX_BOT_ID') {
          return '777000_bot';
        }
        if (key === 'APP_BASE_URL') {
          return 'https://maxim.play-team.ru';
        }
        return undefined;
      }),
    } as never,
  );

  return { service, maxClient, adminService, chats, channels };
}

function getLastSentText(maxClient: { sendMessage: jest.Mock }): string {
  const call = maxClient.sendMessage.mock.calls.at(-1);
  return call ? String(call[1]) : '';
}

function getLastEditedText(maxClient: { answerCallback: jest.Mock }): string {
  const call = maxClient.answerCallback.mock.calls.at(-1);
  return call?.[2]?.text ? String(call[2].text) : '';
}

function getLastButtons(maxClient: { sendMessage: jest.Mock; answerCallback: jest.Mock }) {
  const sendButtons = maxClient.sendMessage.mock.calls.at(-1)?.[2]?.buttons;
  if (sendButtons) {
    return sendButtons as Array<Array<unknown>>;
  }

  const callbackButtons = maxClient.answerCallback.mock.calls.at(-1)?.[2]?.options?.buttons;
  return (callbackButtons ?? []) as Array<Array<unknown>>;
}

describe('PrivateControlService', () => {
  it('renders the new entity picker for /menu in private dialog', async () => {
    const { service, maxClient, adminService } = createHarness();

    await service.handleUpdate(createPrivateTextUpdate('/menu'));

    expect(getLastSentText(maxClient)).toContain('Центр управления MAX');
    expect(getLastSentText(maxClient)).toContain('Выберите чат');
    expect(getLastButtons(maxClient).length).toBeGreaterThan(0);
    expect(adminService.listManagedEntities).toHaveBeenCalledTimes(1);
  });

  it('opens chat home, settings hub, and toggles a section setting via callback edit', async () => {
    const { service, maxClient, adminService, chats } = createHarness({
      settings: {
        ...defaultSettings,
        greetingEnabled: false,
      },
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_settings_hub'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_section|greeting'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|toggle|greeting|greetingEnabled'));

    expect(getLastEditedText(maxClient)).toContain('Приветствие');
    expect(adminService.updateSettings).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({ greetingEnabled: true }),
      'private_bot',
    );
  });

  it('treats /legacy and /modern as aliases for the current interface', async () => {
    const { service, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateTextUpdate('/legacy'));
    await service.handleUpdate(createPrivateTextUpdate('/modern'));

    const sentMessages = maxClient.sendMessage.mock.calls.map((call) => String(call[1]));
    expect(sentMessages.some((text) => text.includes('Центр управления чатом'))).toBe(true);
    expect(sentMessages.some((text) => text.includes('классический вид'))).toBe(false);
  });

  it('handles stale legacy callback payload and refreshes current screen', async () => {
    const { service, maxClient } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate('private_menu:chats'));

    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-1',
      expect.stringContaining('Кнопки устарели'),
      expect.objectContaining({
        text: expect.any(String),
      }),
    );
  });

  it('updates bounded number settings through callback presets and stepper buttons', async () => {
    const { service, adminService, chats } = createHarness({
      settings: {
        ...defaultSettings,
        duplicateWarnMaxCount: 2,
        banDurationHours: 6,
      },
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_section|duplicates'));
    await service.handleUpdate(
      createPrivateCallbackUpdate('pc2|set_number_preset|duplicates|duplicateWarnMaxCount|5'),
    );
    await service.handleUpdate(
      createPrivateCallbackUpdate('pc2|step_number|duplicates|banDurationHours|1'),
    );

    expect(adminService.updateSettings).toHaveBeenNthCalledWith(
      1,
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({ duplicateWarnMaxCount: 5 }),
      'private_bot',
    );
    expect(adminService.updateSettings).toHaveBeenNthCalledWith(
      2,
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({ banDurationHours: 7 }),
      'private_bot',
    );
  });

  it('supports search results with return through history stack', async () => {
    const { service, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_settings_hub'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_search'));
    await service.handleUpdate(createPrivateTextUpdate('привет'));

    expect(getLastSentText(maxClient)).toContain('Результаты поиска');

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|back'));
    expect(getLastEditedText(maxClient)).toContain('Разделы настроек');
  });

  it('sends a channel broadcast from private control', async () => {
    const { service, adminService, channels } = createHarness();

    await service.handleUpdate(
      createPrivateCallbackUpdate(`pc2|chat_select|channel|${channels[0].id}`),
    );
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_broadcast'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_input_prompt|text'));
    await service.handleUpdate(createPrivateTextUpdate('Новый пост для канала'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_send'));

    expect(adminService.sendChannelBroadcast).toHaveBeenCalledWith(
      channels[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        text: 'Новый пост для канала',
        applyToAllChats: false,
      }),
      'private_bot',
    );
  });

  it('hands off chat broadcast from miniapp into private bot content flow', async () => {
    const { service, adminService, maxClient, chats } = createHarness();
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: chats[0].id,
      chatTitle: chats[0].title,
    };

    const result = await service.handoffBroadcastFromMiniapp(
      chats[0].id,
      actor,
      {
        applyToAllChats: true,
        buttonEnabled: true,
        buttonUrl: 'https://max.ru/channel/test',
        buttonText: 'Открыть',
        sendAt: '2026-03-13T12:00:00.000Z',
        cycleEnabled: true,
        cycleEveryHours: 6,
        cycleCount: 3,
      },
      'chat',
    );

    expect(result.botUrl).toBe('https://max.ru/777000_bot?start=broadcast_handoff');

    await service.handleBotStarted(createBotStartedPrivateUpdate());

    expect(getLastSentText(maxClient)).toContain('Рассылка');
    expect(getLastSentText(maxClient)).toContain('Контент: жду следующее сообщение');

    await service.handleUpdate(createPrivateTextUpdate('Контент из лички бота'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|broadcast_send'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|mass_confirm'));

    expect(adminService.sendBroadcast).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        text: 'Контент из лички бота',
        applyToAllChats: true,
        buttonEnabled: true,
        buttonUrl: 'https://max.ru/channel/test',
        sendAt: '2026-03-13T12:00:00.000Z',
        cycleEnabled: true,
        cycleEveryHours: 6,
        cycleCount: 3,
      }),
      'private_bot',
    );
  });

  it('opens the poll screen and publishes a poll from private control', async () => {
    const { service, maxClient, adminService, chats } = createHarness({
      adminService: {
        getChatPoll: jest.fn().mockResolvedValue(createPoll()),
        updateChatPoll: jest.fn().mockImplementation(async (_chatId, _actor, draft) =>
          createPoll({
            question: draft.question,
            options: draft.options,
          }),
        ),
        publishChatPoll: jest.fn().mockResolvedValue(
          createPoll({
            question: 'Выбираем режим?',
            status: 'ACTIVE',
            activeVersion: 1,
            publishedMessageId: 'mid-poll-1',
            publishedUrl: 'https://max.ru/chats/chat-1/message/1',
          }),
        ),
      },
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_poll'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|poll_input_prompt|question'));
    await service.handleUpdate(createPrivateTextUpdate('Выбираем режим?'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|poll_publish'));

    expect(adminService.getChatPoll).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(adminService.updateChatPoll).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      {
        question: 'Выбираем режим?',
        options: ['', ''],
      },
      'private_bot',
    );
    expect(adminService.publishChatPoll).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      'private_bot',
    );
    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-1',
      'Опрос опубликован',
      expect.objectContaining({
        text: expect.stringContaining('Статус: Активен'),
      }),
    );
  });

  it('keeps key private screens under a safe inline-button count', async () => {
    const { service, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateTextUpdate('/menu'));
    expect(getLastButtons(maxClient).flat().length).toBeLessThanOrEqual(20);

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    expect(getLastButtons(maxClient).flat().length).toBeLessThanOrEqual(20);

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_settings_hub'));
    expect(getLastButtons(maxClient).flat().length).toBeLessThanOrEqual(20);

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_section|duplicates'));
    expect(getLastButtons(maxClient).flat().length).toBeLessThanOrEqual(40);
  });
});
