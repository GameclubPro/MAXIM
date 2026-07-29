import { NotFoundException } from '@nestjs/common';
import { AdminPollController } from './admin-poll.controller';

describe('AdminPollController', () => {
  it('routes channel reads and chat mutations through the matching entity scope', () => {
    const managedPollService = {
      listChannelPolls: jest.fn().mockReturnValue({ items: [], nextCursor: null }),
      createChannelPoll: jest.fn().mockReturnValue({ id: 'poll-1' }),
    };
    const controller = new AdminPollController(managedPollService as never);
    const user = { userId: 'admin-1' } as never;
    const body = { question: 'Текст администратора' };

    expect(controller.list('channels', 'channel-1', user, {})).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(managedPollService.listChannelPolls).toHaveBeenCalledWith(
      'channel-1',
      user,
      {},
      'channel',
    );

    expect(controller.create('chats', 'chat-1', user, body)).toEqual({ id: 'poll-1' });
    expect(managedPollService.createChannelPoll).toHaveBeenCalledWith('chat-1', user, body, 'chat');
  });

  it('rejects unsupported entity collections', () => {
    const controller = new AdminPollController({ listChannelPolls: jest.fn() } as never);

    expect(() => controller.list('groups', 'chat-1', { userId: 'admin-1' } as never, {})).toThrow(
      NotFoundException,
    );
  });
});
