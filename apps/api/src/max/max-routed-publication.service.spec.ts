import type { MaxActionJob } from './max-client.service';
import { MaxActionNoExecutableRouteError } from './max-action-dispatch-error';
import { MaxRoutedPublicationService } from './max-routed-publication.service';

describe('MaxRoutedPublicationService', () => {
  it('uses a fresh route while keeping the logical idempotency key bot-independent', async () => {
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'channel-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        reason: 'primary_confirmed',
        routingVersion: 7,
      }),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn().mockImplementation(async (job: MaxActionJob, options: any) => {
        const prepared = await options.prepareAttempt({ botId: 'bot-2', job });
        await options.onDispatchAttempt({ botId: 'bot-2', job: { ...job, ...prepared } });
        return {
          messageId: 'mid-1',
          url: 'https://max.ru/channel-1/mid-1',
          botId: 'bot-2',
        };
      }),
    };
    const prepareAttempt = jest.fn().mockResolvedValue({
      options: { imagePayload: { token: 'bot-2-upload' } },
    });
    const onDispatchAttempt = jest.fn();
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      { resolveMessageLink: jest.fn() } as never,
    );

    await expect(
      service.publish({
        entityId: 'channel-1',
        logicalIdempotencyKey: 'publication:logical-1',
        text: 'publication',
        trafficClass: 'interactive',
        sourceTag: 'test_publication',
        ignoreFailureMetricStatuses: [403, 404],
        prepareAttempt,
        onDispatchAttempt,
      }),
    ).resolves.toEqual({
      messageId: 'mid-1',
      url: 'https://max.ru/channel-1/mid-1',
      botId: 'bot-2',
      candidateBotIds: ['bot-1', 'bot-2'],
      routingVersion: 7,
    });

    expect(maxActionDispatchService.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        idempotencyKey: 'publication:logical-1',
        ignoreFailureMetricStatuses: [403, 404],
        routing: expect.objectContaining({
          purpose: 'send_message',
          routingVersion: 7,
        }),
      }),
      expect.any(Object),
    );
    expect(prepareAttempt).toHaveBeenCalledWith(expect.objectContaining({ botId: 'bot-2' }));
    expect(onDispatchAttempt).toHaveBeenCalledWith(expect.objectContaining({ botId: 'bot-2' }));
    expect(
      (maxActionDispatchService.execute.mock.calls[0]?.[0] as MaxActionJob).idempotencyKey,
    ).not.toContain('bot-1');
  });

  it('uses the poll-specific eligible candidate route', async () => {
    const maxBotLinkService = {
      resolveBotRouteForManagedPoll: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'channel-1',
        primaryBotId: 'bot-1',
        botId: 'bot-2',
        candidateBotIds: ['bot-2', 'bot-3'],
        reason: 'alternate_confirmed',
        routingVersion: 9,
      }),
      resolveBotRoute: jest.fn(),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn().mockResolvedValue({
        messageId: 'mid-poll-1',
        url: null,
        botId: 'bot-2',
      }),
    };
    const maxClientService = {
      resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/channel-1/mid-poll-1'),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      maxClientService as never,
    );

    await expect(
      service.publish({
        entityId: 'channel-1',
        logicalIdempotencyKey: 'managed-poll:publish:poll-1',
        routePurpose: 'channel_poll',
        text: 'poll',
        trafficClass: 'interactive',
        sourceTag: 'managed_poll',
        ignoreFailureMetricStatuses: [403, 404],
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        botId: 'bot-2',
        url: 'https://max.ru/channel-1/mid-poll-1',
      }),
    );

    expect(maxBotLinkService.resolveBotRouteForManagedPoll).toHaveBeenCalledWith({
      chatId: 'channel-1',
    });
    expect(maxBotLinkService.resolveBotRoute).not.toHaveBeenCalled();
    expect(maxActionDispatchService.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-2',
        candidateBotIds: ['bot-2', 'bot-3'],
        routing: expect.objectContaining({ purpose: 'channel_poll', routingVersion: 9 }),
      }),
      {},
    );
    expect(maxClientService.resolveMessageLink).toHaveBeenCalledWith('mid-poll-1', {
      botId: 'bot-2',
      trafficClass: 'interactive',
      sourceTag: 'managed_poll',
      ignoreFailureMetricStatuses: [403, 404],
    });
  });

  it('recovers a completed poll before rejecting its now-empty route', async () => {
    const emptyRoute = {
      purpose: 'send_message',
      chatId: 'channel-1',
      primaryBotId: 'former-dispatch-bot',
      botId: null,
      candidateBotIds: [],
      reason: null,
      routingVersion: 10,
    };
    const maxBotLinkService = {
      resolveBotRouteForManagedPoll: jest.fn().mockResolvedValue(emptyRoute),
      resolveBotRoute: jest.fn().mockResolvedValue(emptyRoute),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue({
        messageId: 'mid-recovered-poll-1',
        url: null,
        botId: 'former-dispatch-bot',
      }),
      execute: jest.fn(),
    };
    const maxClientService = {
      getCurrentChatMemberAccess: jest.fn(),
      resolveMessageLink: jest
        .fn()
        .mockResolvedValue('https://max.ru/channel-1/mid-recovered-poll-1'),
    };
    const prepareAttempt = jest.fn();
    const onDispatchAttempt = jest.fn();
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      maxClientService as never,
    );

    await expect(
      service.publish({
        entityId: 'channel-1',
        logicalIdempotencyKey: 'managed-poll:publish:poll-recovered-1',
        routePurpose: 'channel_poll',
        text: 'admin-authored poll question',
        trafficClass: 'interactive',
        sourceTag: 'managed_poll',
        ignoreFailureMetricStatuses: [403, 404],
        prepareAttempt,
        onDispatchAttempt,
      }),
    ).resolves.toEqual({
      messageId: 'mid-recovered-poll-1',
      url: 'https://max.ru/channel-1/mid-recovered-poll-1',
      botId: 'former-dispatch-bot',
      candidateBotIds: ['former-dispatch-bot'],
      routingVersion: null,
    });

    expect(maxActionDispatchService.recoverCompletedSend).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'SEND_MESSAGE',
        chatId: 'channel-1',
        idempotencyKey: 'managed-poll:publish:poll-recovered-1',
        text: 'admin-authored poll question',
      }),
    );
    expect(maxClientService.resolveMessageLink).toHaveBeenCalledWith('mid-recovered-poll-1', {
      botId: 'former-dispatch-bot',
      trafficClass: 'interactive',
      sourceTag: 'managed_poll',
      ignoreFailureMetricStatuses: [403, 404],
    });
    expect(maxBotLinkService.resolveBotRouteForManagedPoll).not.toHaveBeenCalled();
    expect(maxBotLinkService.resolveBotRoute).not.toHaveBeenCalled();
    expect(maxClientService.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxActionDispatchService.execute).not.toHaveBeenCalled();
    expect(prepareAttempt).not.toHaveBeenCalled();
    expect(onDispatchAttempt).not.toHaveBeenCalled();
  });

  it('hydrates an unknown poll route candidate before dispatch', async () => {
    const emptyRoute = {
      purpose: 'send_message',
      chatId: 'chat-1',
      primaryBotId: 'bot-1',
      botId: null,
      candidateBotIds: [],
      reason: null,
      routingVersion: 4,
    };
    const confirmedRoute = {
      ...emptyRoute,
      botId: 'bot-1',
      candidateBotIds: ['bot-1'],
      reason: 'primary_confirmed',
      routingVersion: 5,
    };
    const maxBotLinkService = {
      resolveBotRouteForManagedPoll: jest
        .fn()
        .mockResolvedValueOnce(emptyRoute)
        .mockResolvedValueOnce(confirmedRoute),
      resolveBotRoute: jest.fn().mockResolvedValue({
        ...emptyRoute,
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        reason: 'primary_fallback',
      }),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValue(true),
      recordBotAccessProbe: jest.fn().mockResolvedValue(true),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn().mockResolvedValue({
        messageId: 'mid-chat-poll-1',
        url: 'https://max.ru/chat-1/mid-chat-poll-1',
        botId: 'bot-1',
      }),
    };
    const access = {
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
    };
    const maxClientService = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue(access),
      resolveMessageLink: jest.fn(),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      maxClientService as never,
    );

    await expect(
      service.publish({
        entityId: 'chat-1',
        logicalIdempotencyKey: 'managed-poll:publish:poll-chat-1',
        routePurpose: 'channel_poll',
        text: 'poll',
        trafficClass: 'interactive',
        sourceTag: 'managed_poll',
        timeoutMs: 12_000,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        messageId: 'mid-chat-poll-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routingVersion: 5,
      }),
    );

    expect(maxClientService.getCurrentChatMemberAccess).toHaveBeenCalledWith('chat-1', {
      botId: 'bot-1',
      bypassCache: true,
      trafficClass: 'interactive',
      sourceTag: 'managed_poll',
      timeoutMs: 12_000,
    });
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: 'bot-1',
      access,
      source: 'managed_poll_route_hydration',
    });
    expect(maxActionDispatchService.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routing: expect.objectContaining({ purpose: 'channel_poll', routingVersion: 5 }),
      }),
      {},
    );
  });

  it('keeps a probed non-admin poll route closed without dispatching', async () => {
    const emptyRoute = {
      purpose: 'send_message',
      chatId: 'chat-1',
      primaryBotId: 'bot-1',
      botId: null,
      candidateBotIds: [],
      reason: null,
      routingVersion: 4,
    };
    const maxBotLinkService = {
      resolveBotRouteForManagedPoll: jest.fn().mockResolvedValue(emptyRoute),
      resolveBotRoute: jest.fn().mockResolvedValue({
        ...emptyRoute,
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
      }),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValue(true),
      recordBotAccessProbe: jest.fn().mockResolvedValue(true),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn(),
    };
    const memberAccess = {
      userId: 'bot-user-1',
      isAdmin: false,
      isOwner: false,
      permissions: [],
    };
    const maxClientService = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue(memberAccess),
      resolveMessageLink: jest.fn(),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      maxClientService as never,
    );

    await expect(
      service.publish({
        entityId: 'chat-1',
        logicalIdempotencyKey: 'managed-poll:publish:poll-chat-member',
        routePurpose: 'channel_poll',
        text: 'poll',
        trafficClass: 'interactive',
        sourceTag: 'managed_poll',
      }),
    ).rejects.toBeInstanceOf(MaxActionNoExecutableRouteError);

    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith(
      expect.objectContaining({ access: memberAccess }),
    );
    expect(maxActionDispatchService.execute).not.toHaveBeenCalled();
  });

  it('keeps a rejected poll access probe closed without dispatching', async () => {
    const emptyRoute = {
      purpose: 'send_message',
      chatId: 'chat-1',
      primaryBotId: 'bot-1',
      botId: null,
      candidateBotIds: [],
      reason: null,
      routingVersion: 4,
    };
    const maxBotLinkService = {
      resolveBotRouteForManagedPoll: jest.fn().mockResolvedValue(emptyRoute),
      resolveBotRoute: jest.fn().mockResolvedValue({
        ...emptyRoute,
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
      }),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValue(true),
      recordBotAccessProbe: jest.fn(),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn(),
    };
    const maxClientService = {
      getCurrentChatMemberAccess: jest.fn().mockRejectedValue(new Error('chat denied')),
      resolveMessageLink: jest.fn(),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      maxClientService as never,
    );

    await expect(
      service.publish({
        entityId: 'chat-1',
        logicalIdempotencyKey: 'managed-poll:publish:poll-chat-denied',
        routePurpose: 'channel_poll',
        text: 'poll',
        trafficClass: 'interactive',
        sourceTag: 'managed_poll',
      }),
    ).rejects.toBeInstanceOf(MaxActionNoExecutableRouteError);

    expect(maxBotLinkService.recordBotAccessProbe).not.toHaveBeenCalled();
    expect(maxActionDispatchService.execute).not.toHaveBeenCalled();
  });

  it('tries the next unknown poll candidate after the first remains ineligible', async () => {
    const emptyRoute = {
      purpose: 'send_message',
      chatId: 'chat-1',
      primaryBotId: 'bot-1',
      botId: null,
      candidateBotIds: [],
      reason: null,
      routingVersion: 4,
    };
    const alternateRoute = {
      ...emptyRoute,
      botId: 'bot-2',
      candidateBotIds: ['bot-2'],
      reason: 'alternate_confirmed',
      routingVersion: 6,
    };
    const maxBotLinkService = {
      resolveBotRouteForManagedPoll: jest
        .fn()
        .mockResolvedValueOnce(emptyRoute)
        .mockResolvedValueOnce(emptyRoute)
        .mockResolvedValueOnce(alternateRoute),
      resolveBotRoute: jest.fn().mockResolvedValue({
        ...emptyRoute,
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
      }),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValue(true),
      recordBotAccessProbe: jest.fn().mockResolvedValue(true),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn().mockResolvedValue({
        messageId: 'mid-chat-poll-2',
        url: null,
        botId: 'bot-2',
      }),
    };
    const maxClientService = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'bot-user-1',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })
        .mockResolvedValueOnce({
          userId: 'bot-user-2',
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        }),
      resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/chat-1/mid-chat-poll-2'),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      maxClientService as never,
    );

    await expect(
      service.publish({
        entityId: 'chat-1',
        logicalIdempotencyKey: 'managed-poll:publish:poll-chat-alternate',
        routePurpose: 'channel_poll',
        text: 'poll',
        trafficClass: 'interactive',
        sourceTag: 'managed_poll',
      }),
    ).resolves.toEqual(expect.objectContaining({ botId: 'bot-2' }));

    expect(maxClientService.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxActionDispatchService.execute).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-2', candidateBotIds: ['bot-2'] }),
      {},
    );
  });
});
