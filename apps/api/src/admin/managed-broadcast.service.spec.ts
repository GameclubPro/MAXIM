import { AdminService } from './admin.service';
import { ManagedBroadcastService } from './managed-broadcast.service';
import { LEGACY_PUBLICATION_WRITES_DISABLED_CODE } from './legacy-publication-write-freeze';

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
      sendChannelBroadcast: jest
        .fn()
        .mockResolvedValue({ targetChats: 1, sentChats: 1, failedChats: 0 }),
      sendBroadcastTest: jest.fn().mockResolvedValue({ sent: true }),
      sendChannelBroadcastTest: jest.fn().mockResolvedValue({ sent: true }),
      sendPublicationBroadcastTest: jest.fn().mockResolvedValue({ sent: true }),
      sendPublicationChannelBroadcastTest: jest.fn().mockResolvedValue({ sent: true }),
      listChannelManagedBroadcasts: jest.fn().mockResolvedValue([{ id: 'broadcast-1' }]),
      updateManagedBroadcast: jest.fn().mockResolvedValue({ id: 'broadcast-1' }),
      updateChannelManagedBroadcast: jest.fn().mockResolvedValue({ id: 'broadcast-1' }),
      cancelManagedBroadcast: jest.fn().mockResolvedValue({ id: 'broadcast-1' }),
      cancelChannelManagedBroadcast: jest.fn().mockResolvedValue({ id: 'broadcast-1' }),
      retryManagedBroadcast: jest.fn().mockResolvedValue({ id: 'broadcast-1' }),
      retryChannelManagedBroadcast: jest.fn().mockResolvedValue({ id: 'broadcast-1' }),
      processDueManagedBroadcasts: jest.fn().mockResolvedValue(undefined),
      processDueImmediatePublicationBroadcasts: jest.fn().mockResolvedValue(undefined),
      processTargetedImmediatePublicationBroadcasts: jest.fn().mockResolvedValue(undefined),
      processTargetedDeadlinePublicationBroadcasts: jest.fn().mockResolvedValue(undefined),
      processDueDeadlinePublicationBroadcasts: jest.fn().mockResolvedValue(undefined),
    };

    return {
      runtime,
      service: new ManagedBroadcastService(runtime as never),
    };
  }

  it('rejects legacy create from every source plus edit, retry, and test writes', async () => {
    const { runtime, service } = createService();
    const body = { text: 'Всем привет' };
    const attempts = [
      () => service.sendBroadcast('chat-1', user as never, body),
      () => service.sendBroadcast('chat-1', user as never, body, 'autopost_rule'),
      () => service.sendChannelBroadcast('channel-1', user as never, body, 'private_bot'),
      () => service.sendChannelBroadcast('channel-1', user as never, body, 'autopost_rule'),
      () => service.sendBroadcastTest('chat-1', user as never, body),
      () => service.sendChannelBroadcastTest('channel-1', user as never, body),
      () => service.updateManagedBroadcast('chat-1', 'broadcast-1', user as never, body),
      () => service.updateChannelManagedBroadcast('channel-1', 'broadcast-1', user as never, body),
      () => service.retryManagedBroadcast('chat-1', 'broadcast-1', user as never),
      () => service.retryChannelManagedBroadcast('channel-1', 'broadcast-1', user as never),
    ];

    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({
        status: 410,
        response: expect.objectContaining({
          code: LEGACY_PUBLICATION_WRITES_DISABLED_CODE,
          message: expect.stringContaining('«Публикации»'),
        }),
      });
    }

    expect(runtime.sendBroadcast).not.toHaveBeenCalled();
    expect(runtime.sendChannelBroadcast).not.toHaveBeenCalled();
    expect(runtime.sendBroadcastTest).not.toHaveBeenCalled();
    expect(runtime.sendChannelBroadcastTest).not.toHaveBeenCalled();
    expect(runtime.updateManagedBroadcast).not.toHaveBeenCalled();
    expect(runtime.updateChannelManagedBroadcast).not.toHaveBeenCalled();
    expect(runtime.retryManagedBroadcast).not.toHaveBeenCalled();
    expect(runtime.retryChannelManagedBroadcast).not.toHaveBeenCalled();
  });

  it('rejects direct AdminService write bypasses without exposing or invoking its runtime', async () => {
    const { runtime } = createService();
    const adminService = Object.create(AdminService.prototype) as AdminService;
    (adminService as any).managedBroadcastRuntime = runtime;
    const attempts = [
      () => adminService.sendBroadcast('chat-1', user as never, {}, 'autopost_rule'),
      () => adminService.sendChannelBroadcast('channel-1', user as never, {}, 'autopost_rule'),
      () => adminService.sendBroadcastTest('chat-1', user as never, {}),
      () => adminService.sendChannelBroadcastTest('channel-1', user as never, {}),
      () => adminService.updateManagedBroadcast('chat-1', 'broadcast-1', user as never, {}),
      () =>
        adminService.updateChannelManagedBroadcast('channel-1', 'broadcast-1', user as never, {}),
      () => adminService.retryManagedBroadcast('chat-1', 'broadcast-1', user as never),
      () => adminService.retryChannelManagedBroadcast('channel-1', 'broadcast-1', user as never),
    ];

    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({
        status: 410,
        response: expect.objectContaining({ code: LEGACY_PUBLICATION_WRITES_DISABLED_CODE }),
      });
    }

    expect((adminService as any).getManagedBroadcastRuntimeForBroadcastService).toBeUndefined();
    for (const method of [
      'sendBroadcast',
      'sendChannelBroadcast',
      'sendBroadcastTest',
      'sendChannelBroadcastTest',
      'updateManagedBroadcast',
      'updateChannelManagedBroadcast',
      'retryManagedBroadcast',
      'retryChannelManagedBroadcast',
    ] as const) {
      expect(runtime[method]).not.toHaveBeenCalled();
    }
  });

  it('keeps publication tests and legacy cancellation available', async () => {
    const { runtime, service } = createService();
    const body = { text: 'Проверка' };

    await service.sendPublicationBroadcastTest('chat-1', user as never, body);
    await service.sendPublicationChannelBroadcastTest('channel-1', user as never, body);
    await service.cancelManagedBroadcast('chat-1', 'broadcast-1', user as never);
    await service.cancelChannelManagedBroadcast('channel-1', 'broadcast-1', user as never);

    expect(runtime.sendPublicationBroadcastTest).toHaveBeenCalledWith('chat-1', user, body);
    expect(runtime.sendPublicationChannelBroadcastTest).toHaveBeenCalledWith(
      'channel-1',
      user,
      body,
    );
    expect(runtime.cancelManagedBroadcast).toHaveBeenCalledWith('chat-1', 'broadcast-1', user);
    expect(runtime.cancelChannelManagedBroadcast).toHaveBeenCalledWith(
      'channel-1',
      'broadcast-1',
      user,
    );
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

  it('delegates deadline publication recovery directly to the runtime', async () => {
    const { runtime, service } = createService();

    await service.processDueDeadlinePublicationBroadcasts(7);

    expect(runtime.processDueDeadlinePublicationBroadcasts).toHaveBeenCalledWith(7);
  });

  it('delegates a targeted Publisher NOW wake directly to the runtime', async () => {
    const { runtime, service } = createService();

    await service.processTargetedImmediatePublicationBroadcasts('publication-1', 'occurrence-1');

    expect(runtime.processTargetedImmediatePublicationBroadcasts).toHaveBeenCalledWith(
      'publication-1',
      'occurrence-1',
    );
  });

  it('delegates a targeted Publisher deadline wake directly to the runtime', async () => {
    const { runtime, service } = createService();

    await service.processTargetedDeadlinePublicationBroadcasts('publication-1', 'occurrence-1');

    expect(runtime.processTargetedDeadlinePublicationBroadcasts).toHaveBeenCalledWith(
      'publication-1',
      'occurrence-1',
    );
  });

  it('forwards one shared verification budget across publication execution lanes', async () => {
    const { runtime, service } = createService();
    const verificationBudget = { remaining: 17 };

    await service.processDueImmediatePublicationBroadcasts(verificationBudget);
    await service.processDueDeadlinePublicationBroadcasts(7, verificationBudget);

    expect(runtime.processDueImmediatePublicationBroadcasts).toHaveBeenCalledWith(
      verificationBudget,
    );
    expect(runtime.processDueDeadlinePublicationBroadcasts).toHaveBeenCalledWith(
      7,
      verificationBudget,
    );
  });
});
