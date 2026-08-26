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
