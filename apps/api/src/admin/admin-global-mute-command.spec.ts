import { buildModerationReleaseCallbackPayload } from '../moderation/moderation-release-callback.util';
import { AdminService } from './admin.service';
import {
  createChatContextCacheMock,
  createConfigMock,
  createPrismaMock,
} from './admin-service-test-support';

describe('AdminService global mute group command', () => {
  it('durably queues fanout after the source mute and before the terminal notice', async () => {
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const adminManualFanoutQueue = { add: jest.fn().mockResolvedValue(undefined) };
    const service = new AdminService(
      createPrismaMock() as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      adminManualFanoutQueue as never,
    );
    const sourceMute = jest
      .spyOn(service, 'applyManualModerationAction')
      .mockImplementation(async (_chatId, _targetUserId, _actor, _body, _source, options) => {
        options?.onModerationEventRecorded?.('sanction-event-mute-1');
        return {
          ok: true,
          action: 'MUTE',
          userId: 'user-2',
          muteDurationHours: 24,
          muteExpiresAt: '2026-07-21T12:00:00.000Z',
          message: 'Мут включён на 24 ч.',
        };
      });

    await service.processManualModerationFanoutJob({
      kind: 'manual_group_moderation_command',
      jobId: 'job-command-global-mute-1',
      sourceChatId: 'chat-1',
      commandBotId: 'bot-1',
      targetUserId: 'user-2',
      targetSenderName: 'Нарушитель',
      targetMessageId: 'mid-target-1',
      commandMessageId: 'mid-command-1',
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      },
      action: 'MUTE',
      fanoutAllChats: true,
      muteDurationHours: 24,
      deleteBotMessagesEnabled: false,
      deleteBotMessagesDelayMinutes: 3,
    });

    expect(sourceMute).toHaveBeenCalledWith(
      'chat-1',
      'user-2',
      expect.any(Object),
      { action: 'MUTE', muteDurationHours: 24, scope: 'current_chat' },
      'group_command',
      expect.objectContaining({ fanoutAllChats: false }),
    );
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Мут включён на 24 ч.\nУчастник: [Нарушитель](max://user/user-2)',
      {
        buttons: [
          [
            {
              type: 'callback',
              text: 'Снять мут',
              payload: buildModerationReleaseCallbackPayload('UNMUTE', 'sanction-event-mute-1'),
              intent: 'positive',
            },
          ],
        ],
        textFormat: 'markdown',
      },
      expect.objectContaining({ immediate: true, trafficClass: 'interactive' }),
    );
    expect(adminManualFanoutQueue.add).toHaveBeenCalledWith(
      'execute-admin-manual-fanout',
      expect.objectContaining({
        kind: 'manual_mute_fanout',
        sourceChatId: 'chat-1',
        targetUserId: 'user-2',
        cleanupSourceChatMessages: true,
        muteDurationHours: 24,
        muteExpiresAt: '2026-07-21T12:00:00.000Z',
        source: 'group_command',
      }),
      expect.objectContaining({ priority: 20 }),
    );
    expect(sourceMute.mock.invocationCallOrder[0]).toBeLessThan(
      maxClient.sendMessage.mock.invocationCallOrder[0],
    );
    expect(adminManualFanoutQueue.add.mock.invocationCallOrder[0]).toBeLessThan(
      maxClient.sendMessage.mock.invocationCallOrder[0],
    );
  });
});
