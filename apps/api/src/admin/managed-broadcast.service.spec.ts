import { ManagedBroadcastService } from './managed-broadcast.service';

describe('ManagedBroadcastService', () => {
  const user = {
    userId: 'admin-1',
    username: null,
    displayName: null,
    chatTitle: null,
  };

  function createService() {
    const runtime = {
      sendBroadcast: jest.fn().mockResolvedValue({ targetChats: 1, sentChats: 1, failedChats: 0 }),
      listChannelManagedBroadcasts: jest.fn().mockResolvedValue([{ id: 'broadcast-1' }]),
      processDueManagedBroadcasts: jest.fn().mockResolvedValue(undefined),
      processDueImmediatePublicationBroadcasts: jest.fn().mockResolvedValue(undefined),
    };

    return {
      runtime,
      service: new ManagedBroadcastService(runtime as never),
    };
  }

  it('delegates user broadcast writes directly to the runtime', async () => {
    const { runtime, service } = createService();
    const body = { text: 'Всем привет' };

    await service.sendBroadcast('chat-1', user as never, body, 'private_bot');

    expect(runtime.sendBroadcast).toHaveBeenCalledWith('chat-1', user, body, 'private_bot');
  });

  it('delegates channel broadcast reads directly to the runtime', async () => {
    const { runtime, service } = createService();

    await service.listChannelManagedBroadcasts('channel-1', user as never, {
      skipAdminCheck: true,
      skipEntityCheck: true,
    });

    expect(runtime.listChannelManagedBroadcasts).toHaveBeenCalledWith('channel-1', user, {
      skipAdminCheck: true,
      skipEntityCheck: true,
    });
  });

  it('delegates background processing directly to the runtime', async () => {
    const { runtime, service } = createService();

    await service.processDueManagedBroadcasts('scheduled');

    expect(runtime.processDueManagedBroadcasts).toHaveBeenCalledWith('scheduled');
  });

  it('delegates immediate publication recovery directly to the runtime', async () => {
    const { runtime, service } = createService();

    await service.processDueImmediatePublicationBroadcasts();

    expect(runtime.processDueImmediatePublicationBroadcasts).toHaveBeenCalledTimes(1);
  });
});
