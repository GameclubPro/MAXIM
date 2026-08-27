import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { PublisherEntityRefreshService } from './publisher-entity-refresh.service';

describe('PublisherEntityRefreshService', () => {
  const user = {
    userId: 'admin-1',
    username: null,
    displayName: null,
  };

  function createFixture() {
    const policyService = {
      getEntity: jest.fn().mockResolvedValue({
        id: 'channel-1',
        entityType: 'channel',
      }),
      listRefreshableEntityIds: jest.fn().mockResolvedValue(['channel-1', 'chat-2']),
    };
    const refreshQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const botRegistry = {
      getPublisherBotDescriptor: jest.fn().mockReturnValue({ id: 'publik-bot' }),
    };
    const service = new PublisherEntityRefreshService(
      policyService as never,
      refreshQueue as never,
      botRegistry as never,
    );
    return { service, policyService, refreshQueue, botRegistry };
  }

  it('authorizes the user-scoped entity before enqueueing one targeted refresh', async () => {
    const fixture = createFixture();

    await expect(fixture.service.requestRefresh('channel', 'channel-1', user)).resolves.toEqual({
      accepted: true,
    });

    expect(fixture.policyService.getEntity).toHaveBeenCalledWith('channel', 'channel-1', user);
    expect(fixture.refreshQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(fixture.refreshQueue.enqueue).toHaveBeenCalledWith({
      chatId: 'channel-1',
      publisherBotId: 'publik-bot',
      reason: 'manual_recheck',
    });
  });

  it('does not reveal or enqueue an entity outside the requesting user scope', async () => {
    const fixture = createFixture();
    fixture.policyService.getEntity.mockRejectedValueOnce(
      new BadRequestException('Managed entity is unavailable'),
    );

    await expect(fixture.service.requestRefresh('chat', 'foreign-chat', user)).rejects.toThrow(
      BadRequestException,
    );

    expect(fixture.refreshQueue.enqueue).not.toHaveBeenCalled();
    expect(fixture.botRegistry.getPublisherBotDescriptor).not.toHaveBeenCalled();
  });

  it('propagates queue failures instead of claiming that a refresh was accepted', async () => {
    const fixture = createFixture();
    fixture.refreshQueue.enqueue.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(fixture.service.requestRefresh('channel', 'channel-1', user)).rejects.toThrow(
      'redis unavailable',
    );
  });

  it('queues a bounded deduplicated bulk recheck from the server-authorized scope', async () => {
    const fixture = createFixture();
    fixture.policyService.listRefreshableEntityIds.mockResolvedValueOnce([
      ...Array.from({ length: 55 }, (_, index) => `chat-${index}`),
      'chat-0',
    ]);

    await expect(fixture.service.requestBulkRefresh(user)).resolves.toEqual({
      accepted: true,
      queuedCount: 50,
    });

    expect(fixture.policyService.listRefreshableEntityIds).toHaveBeenCalledWith(user, 50, []);
    expect(fixture.refreshQueue.enqueue).toHaveBeenCalledTimes(50);
    expect(fixture.refreshQueue.enqueue).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chatId: 'chat-0',
        publisherBotId: 'publik-bot',
        reason: 'manual_recheck',
        requestedAt: expect.any(Date),
      }),
    );
    expect(
      new Set(fixture.refreshQueue.enqueue.mock.calls.map(([request]) => request.requestedAt)).size,
    ).toBe(1);
  });

  it('rotates consecutive bulk requests beyond the first fifty entities', async () => {
    const fixture = createFixture();
    const allEntityIds = Array.from(
      { length: 80 },
      (_, index) => `chat-${String(index).padStart(3, '0')}`,
    );
    fixture.policyService.listRefreshableEntityIds.mockImplementation(
      async (_user: typeof user, limit: number, excludedEntityIds: readonly string[]) => {
        const excluded = new Set(excludedEntityIds);
        return allEntityIds.filter((entityId) => !excluded.has(entityId)).slice(0, limit);
      },
    );

    const first = await fixture.service.requestBulkRefresh(user);
    const second = await fixture.service.requestBulkRefresh(user);

    expect(first).toEqual({ accepted: true, queuedCount: 50 });
    expect(second).toEqual({ accepted: true, queuedCount: 30 });
    const firstBatch = fixture.refreshQueue.enqueue.mock.calls
      .slice(0, 50)
      .map(([request]) => request.chatId);
    const secondBatch = fixture.refreshQueue.enqueue.mock.calls
      .slice(50)
      .map(([request]) => request.chatId);
    const firstBatchSet = new Set(firstBatch);
    expect(firstBatch).toEqual(allEntityIds.slice(0, 50));
    expect(secondBatch).toEqual(allEntityIds.slice(50));
    expect(secondBatch.some((entityId) => firstBatchSet.has(entityId))).toBe(false);
    expect(fixture.policyService.listRefreshableEntityIds.mock.calls[1]?.[2]).toEqual(firstBatch);
  });

  it('rotates only successfully queued ids after a partial queue failure', async () => {
    const fixture = createFixture();
    const allEntityIds = ['chat-a', 'chat-b', 'chat-c'];
    fixture.policyService.listRefreshableEntityIds.mockImplementation(
      async (_user: typeof user, limit: number, excludedEntityIds: readonly string[]) => {
        const excluded = new Set(excludedEntityIds);
        return allEntityIds.filter((entityId) => !excluded.has(entityId)).slice(0, limit);
      },
    );
    fixture.refreshQueue.enqueue
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(fixture.service.requestBulkRefresh(user)).rejects.toThrow('redis unavailable');
    await expect(fixture.service.requestBulkRefresh(user)).resolves.toEqual({
      accepted: true,
      queuedCount: 2,
    });

    expect(fixture.policyService.listRefreshableEntityIds.mock.calls[1]?.[2]).toEqual(['chat-a']);
    expect(
      fixture.refreshQueue.enqueue.mock.calls.slice(2).map(([request]) => request.chatId),
    ).toEqual(['chat-b', 'chat-c']);
  });

  it('rate limits bulk rechecks separately per user', async () => {
    const fixture = createFixture();
    fixture.policyService.listRefreshableEntityIds.mockResolvedValue([]);

    for (let index = 0; index < 3; index += 1) {
      await fixture.service.requestBulkRefresh(user);
    }
    const rejection = await fixture.service.requestBulkRefresh(user).catch((error) => error);
    expect(rejection).toBeInstanceOf(HttpException);
    expect((rejection as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    await expect(
      fixture.service.requestBulkRefresh({ ...user, userId: 'admin-2' }),
    ).resolves.toEqual({ accepted: true, queuedCount: 0 });

    expect(fixture.policyService.listRefreshableEntityIds).toHaveBeenCalledTimes(4);
    expect(fixture.refreshQueue.enqueue).not.toHaveBeenCalled();
  });

  it('bounds distinct manual refreshes per user without a stack-wide bot limiter', async () => {
    const fixture = createFixture();

    for (let index = 0; index < 10; index += 1) {
      await fixture.service.requestRefresh('channel', `channel-${index}`, user);
    }
    const rejection = await fixture.service
      .requestRefresh('channel', 'channel-11', user)
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(HttpException);
    expect((rejection as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);

    expect(fixture.refreshQueue.enqueue).toHaveBeenCalledTimes(10);
    await expect(
      fixture.service.requestRefresh('channel', 'channel-other-user', {
        ...user,
        userId: 'admin-2',
      }),
    ).resolves.toEqual({ accepted: true });
  });
});
