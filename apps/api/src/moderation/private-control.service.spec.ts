import { chatSettingsSchema, type MaxUpdate } from '@maxim/contracts';
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

describe('PrivateControlService', () => {
  const defaultSettings = chatSettingsSchema.parse({});

  it('renders chat selection for /menu in private dialog', async () => {
    const maxClient = {
      sendMessage: jest.fn().mockResolvedValue(undefined),
      answerCallback: jest.fn().mockResolvedValue(undefined),
    };
    const adminService = {
      listManagedEntities: jest.fn().mockResolvedValue([
        {
          id: '-70000000000001',
          title: 'Тестовый чат 1',
          createdAt: new Date().toISOString(),
          entityType: 'chat',
        },
      ]),
      listChats: jest.fn().mockResolvedValue([
        {
          id: '-70000000000001',
          title: 'Тестовый чат 1',
          createdAt: new Date().toISOString(),
          entityType: 'chat',
        },
      ]),
      getSettings: jest.fn(),
      updateSettings: jest.fn(),
      applySettingsToAllChats: jest.fn(),
      getDomainAllowlistDetails: jest.fn(),
      addDomain: jest.fn(),
      removeDomain: jest.fn(),
      scheduleDomainRemoval: jest.fn(),
      getGlobalUserBlacklist: jest.fn(),
      addGlobalUserBlacklistUser: jest.fn(),
      removeGlobalUserBlacklistUser: jest.fn(),
      sendBroadcast: jest.fn(),
      getEvents: jest.fn(),
      getLogsDashboard: jest.fn(),
      applyManualModerationAction: jest.fn(),
    };

    const service = new PrivateControlService(
      maxClient as never,
      adminService as never,
      undefined,
      undefined,
    );

    await service.handleUpdate(createPrivateTextUpdate('/menu'));

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      '152517912',
      expect.stringContaining('Выберите чат'),
      expect.objectContaining({
        buttons: expect.any(Array),
      }),
      { immediate: true },
    );
    expect(adminService.listManagedEntities).toHaveBeenCalledTimes(1);
  });

  it('selects chat, edits callback card, and toggles section setting via private source', async () => {
    const maxClient = {
      sendMessage: jest.fn().mockResolvedValue(undefined),
      answerCallback: jest.fn().mockResolvedValue(undefined),
    };
    const adminService = {
      listManagedEntities: jest.fn().mockResolvedValue([
        {
          id: '-70000000000001',
          title: 'Тестовый чат 1',
          createdAt: new Date().toISOString(),
          entityType: 'chat',
        },
      ]),
      listChats: jest.fn().mockResolvedValue([
        {
          id: '-70000000000001',
          title: 'Тестовый чат 1',
          createdAt: new Date().toISOString(),
          entityType: 'chat',
        },
      ]),
      getSettings: jest.fn().mockResolvedValue(defaultSettings),
      updateSettings: jest.fn().mockResolvedValue({
        ...defaultSettings,
        greetingEnabled: true,
      }),
      applySettingsToAllChats: jest.fn(),
      getDomainAllowlistDetails: jest.fn(),
      addDomain: jest.fn(),
      removeDomain: jest.fn(),
      scheduleDomainRemoval: jest.fn(),
      getGlobalUserBlacklist: jest.fn(),
      addGlobalUserBlacklistUser: jest.fn(),
      removeGlobalUserBlacklistUser: jest.fn(),
      sendBroadcast: jest.fn(),
      getEvents: jest.fn(),
      getLogsDashboard: jest.fn(),
      applyManualModerationAction: jest.fn(),
    };

    const service = new PrivateControlService(
      maxClient as never,
      adminService as never,
      undefined,
      undefined,
    );

    await service.handleUpdate(createPrivateCallbackUpdate('pc|chat_select|-70000000000001'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc|open_section|greeting'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc|toggle|greeting|greetingEnabled'));

    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-1',
      expect.any(String),
      expect.objectContaining({
        text: expect.any(String),
      }),
    );

    expect(adminService.updateSettings).toHaveBeenCalledWith(
      '-70000000000001',
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({ greetingEnabled: true }),
      'private_bot',
    );
  });

  it('switches between legacy and modern UI modes by commands', async () => {
    const maxClient = {
      sendMessage: jest.fn().mockResolvedValue(undefined),
      answerCallback: jest.fn().mockResolvedValue(undefined),
    };
    const adminService = {
      listManagedEntities: jest.fn().mockResolvedValue([
        {
          id: '-70000000000001',
          title: 'Тестовый чат 1',
          createdAt: new Date().toISOString(),
          entityType: 'chat',
        },
      ]),
      listChats: jest.fn().mockResolvedValue([
        {
          id: '-70000000000001',
          title: 'Тестовый чат 1',
          createdAt: new Date().toISOString(),
          entityType: 'chat',
        },
      ]),
      getSettings: jest.fn().mockResolvedValue(defaultSettings),
      updateSettings: jest.fn(),
      applySettingsToAllChats: jest.fn(),
      getDomainAllowlistDetails: jest.fn(),
      addDomain: jest.fn(),
      removeDomain: jest.fn(),
      scheduleDomainRemoval: jest.fn(),
      getGlobalUserBlacklist: jest.fn(),
      addGlobalUserBlacklistUser: jest.fn(),
      removeGlobalUserBlacklistUser: jest.fn(),
      sendBroadcast: jest.fn(),
      getEvents: jest.fn().mockResolvedValue([]),
      getLogsDashboard: jest.fn().mockResolvedValue({
        membership: { joinedUsers: 0, leftUsers: 0 },
        violationsSummary: { warn: 0, deleteMessage: 0, kick: 0, ban: 0, total: 0 },
        violations: [],
      }),
      applyManualModerationAction: jest.fn(),
    };

    const service = new PrivateControlService(
      maxClient as never,
      adminService as never,
      undefined,
      undefined,
    );

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|chat_select|-70000000000001'));
    await service.handleUpdate(createPrivateTextUpdate('/legacy'));
    await service.handleUpdate(createPrivateTextUpdate('/modern'));

    const sentMessages = maxClient.sendMessage.mock.calls.map((call) => String(call[1]));
    expect(sentMessages.some((text) => text.includes('классический вид'))).toBe(true);
    expect(sentMessages.some((text) => text.includes('Управление чатом'))).toBe(true);
  });

  it('handles stale legacy callback payload and refreshes current screen', async () => {
    const maxClient = {
      sendMessage: jest.fn().mockResolvedValue(undefined),
      answerCallback: jest.fn().mockResolvedValue(undefined),
    };
    const adminService = {
      listManagedEntities: jest.fn().mockResolvedValue([
        {
          id: '-70000000000001',
          title: 'Тестовый чат 1',
          createdAt: new Date().toISOString(),
          entityType: 'chat',
        },
      ]),
      listChats: jest.fn().mockResolvedValue([
        {
          id: '-70000000000001',
          title: 'Тестовый чат 1',
          createdAt: new Date().toISOString(),
          entityType: 'chat',
        },
      ]),
      getSettings: jest.fn(),
      updateSettings: jest.fn(),
      applySettingsToAllChats: jest.fn(),
      getDomainAllowlistDetails: jest.fn(),
      addDomain: jest.fn(),
      removeDomain: jest.fn(),
      scheduleDomainRemoval: jest.fn(),
      getGlobalUserBlacklist: jest.fn(),
      addGlobalUserBlacklistUser: jest.fn(),
      removeGlobalUserBlacklistUser: jest.fn(),
      sendBroadcast: jest.fn(),
      getEvents: jest.fn(),
      getLogsDashboard: jest.fn(),
      applyManualModerationAction: jest.fn(),
    };

    const service = new PrivateControlService(
      maxClient as never,
      adminService as never,
      undefined,
      undefined,
    );

    await service.handleUpdate(createPrivateCallbackUpdate('private_menu:chats'));

    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-1',
      expect.stringContaining('Кнопки устарели'),
      expect.objectContaining({
        text: expect.any(String),
      }),
    );
  });
});
