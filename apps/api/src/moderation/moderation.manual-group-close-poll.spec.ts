import { ModerationService } from './moderation.service';

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
        return 'id613002203036_bot';
      }
      if (key === 'MAX_BOT_CONTACT_ID') {
        return '209468578';
      }
      if (key === 'APP_BASE_URL') {
        return 'https://maxim.play-team.ru';
      }
      return undefined;
    }),
  };
}

describe('ModerationService manual group close polling', () => {
  it('deletes fresh non-admin messages in manually closed chats via background polling', async () => {
    const prisma = {
      chatSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'chat-1',
            updatedAt: new Date('2026-04-03T23:15:00.000Z'),
            nightModeForceCloseEnabled: true,
            nightModeForceCloseForever: true,
            nightModeForceCloseUntil: '',
            chat: {
              admins: [
                {
                  userId: '98315271',
                },
              ],
            },
          },
        ]),
      },
      moderationEvent: {
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      listMessages: jest.fn().mockResolvedValue([
        {
          timestamp: 1775258000000,
          body: {
            mid: 'mid-old-1',
            text: 'Старое сообщение',
          },
          sender: {
            user_id: 195714583,
          },
        },
        {
          timestamp: 1775260410000,
          body: {
            mid: 'mid-admin-1',
            text: 'Админ пишет',
          },
          sender: {
            user_id: 98315271,
          },
        },
        {
          timestamp: 1775260420000,
          body: {
            mid: 'mid-user-1',
            text: 'Тест 2',
          },
          sender: {
            user_id: 195714583,
          },
        },
      ]),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      notifyModerators: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotIdForCapability: jest.fn().mockResolvedValue('id613002203036_bot'),
    };

    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    await (service as any).processManualGroupCloseChats();

    expect(maxBotLinkService.resolveBotIdForCapability).toHaveBeenCalledWith({
      chatId: 'chat-1',
      capability: 'background_scans',
    });
    expect(maxClient.listMessages).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        count: 20,
        trafficClass: 'background',
        botId: 'id613002203036_bot',
      }),
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-user-1');
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: '195714583',
          messageId: 'mid-user-1',
          ruleCode: 'MANUAL_GROUP_CLOSE_DELETE',
        }),
      }),
    );
  });

  it('does not re-delete the same message after the scan state advances', async () => {
    const prisma = {
      chatSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'chat-1',
            updatedAt: new Date('2026-04-03T23:15:00.000Z'),
            nightModeForceCloseEnabled: true,
            nightModeForceCloseForever: true,
            nightModeForceCloseUntil: '',
            chat: {
              admins: [],
            },
          },
        ]),
      },
      moderationEvent: {
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      listMessages: jest.fn().mockResolvedValue([
        {
          timestamp: 1775260420000,
          body: {
            mid: 'mid-user-1',
            text: 'Тест 2',
          },
          sender: {
            user_id: 195714583,
          },
        },
      ]),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      notifyModerators: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
    );

    await (service as any).processManualGroupCloseChats();
    (service as any).manualGroupCloseScanState.set('chat-1', {
      ...(service as any).manualGroupCloseScanState.get('chat-1'),
      nextScanAtMs: 0,
    });
    await (service as any).processManualGroupCloseChats();

    expect(maxClient.deleteMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-user-1');
  });
});
