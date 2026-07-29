import { AdminService } from './admin.service';
import { createChatContextCacheMock, createConfigMock } from './admin-service-test-support';

function createService(resolveBotIdForManagedPoll: jest.Mock) {
  return new AdminService(
    {} as never,
    {} as never,
    createChatContextCacheMock() as never,
    createConfigMock() as never,
    undefined,
    undefined,
    undefined,
    undefined,
    { resolveBotIdForManagedPoll } as never,
  );
}

describe('AdminService managed poll bot routing', () => {
  it('selects one bot that can publish and update a channel poll', async () => {
    const resolveBotIdForManagedPoll = jest.fn().mockResolvedValue('both-bot');
    const service = createService(resolveBotIdForManagedPoll);

    await expect(service.resolveChannelPollBotId('channel-1')).resolves.toBe('both-bot');
    expect(resolveBotIdForManagedPoll).toHaveBeenCalledWith({ chatId: 'channel-1' });
  });

  it('rejects a channel route without one eligible bot', async () => {
    const service = createService(jest.fn().mockResolvedValue(null));

    await expect(service.resolveChannelPollBotId('channel-1')).rejects.toThrow(
      'Не найден бот MAX, который может опубликовать и обновлять опрос в канале.',
    );
  });

  it('selects a confirmed managed-poll bot for a chat', async () => {
    const resolveBotIdForManagedPoll = jest.fn().mockResolvedValue('chat-bot');
    const service = createService(resolveBotIdForManagedPoll);

    await expect(service.resolveChatPollBotId('chat-1')).resolves.toBe('chat-bot');
    expect(resolveBotIdForManagedPoll).toHaveBeenCalledWith({ chatId: 'chat-1' });
  });
});
