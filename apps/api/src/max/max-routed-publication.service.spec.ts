import type { MaxActionJob } from './max-client.service';
import { UnrecoverableError } from 'bullmq';
import { MaxActionNoExecutableRouteError } from './max-action-dispatch-error';
import { MaxRoutedPublicationService } from './max-routed-publication.service';

describe('MaxRoutedPublicationService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

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
        await options.beforeSendMutation({ botId: 'bot-2', job: { ...job, ...prepared } });
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
    const beforeSendMutation = jest.fn();
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
        beforeSendMutation,
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
    expect(beforeSendMutation).toHaveBeenCalledWith(expect.objectContaining({ botId: 'bot-2' }));
    expect(
      (maxActionDispatchService.execute.mock.calls[0]?.[0] as MaxActionJob).idempotencyKey,
    ).not.toContain('bot-1');
  });

  it('restricts a bot-scoped publication to its required executable token owner', async () => {
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'channel-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'media-bot'],
        reason: 'primary_confirmed',
        routingVersion: 8,
      }),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn().mockResolvedValue({
        messageId: 'mid-media-1',
        url: null,
        botId: 'media-bot',
      }),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      { resolveMessageLink: jest.fn().mockResolvedValue(null) } as never,
    );

    await service.publish({
      entityId: 'channel-1',
      logicalIdempotencyKey: 'channel-suggestion:publish:v1:suggestion-1',
      text: 'video',
      trafficClass: 'interactive',
      sourceTag: 'suggestion_delivery',
      preferredBotId: 'media-bot',
      requiredBotId: 'media-bot',
    });

    expect(maxActionDispatchService.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'media-bot',
        candidateBotIds: ['media-bot'],
        routing: expect.objectContaining({ requiredBotId: 'media-bot' }),
      }),
      {},
    );
  });

  it('fails closed before dispatch when a required media bot left the fresh route', async () => {
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'channel-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        reason: 'primary_confirmed',
        routingVersion: 8,
      }),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn(),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      { resolveMessageLink: jest.fn() } as never,
    );

    await expect(
      service.publish({
        entityId: 'channel-1',
        logicalIdempotencyKey: 'channel-suggestion:publish:v1:suggestion-2',
        text: 'video',
        trafficClass: 'interactive',
        sourceTag: 'suggestion_delivery',
        requiredBotId: 'media-bot',
      }),
    ).rejects.toBeInstanceOf(MaxActionNoExecutableRouteError);
    expect(maxActionDispatchService.execute).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'another bot', recoveredBotId: 'foreign-bot' },
    { label: 'no proven bot', recoveredBotId: null },
  ])(
    'fails closed without a resend when a completed required publication has $label',
    async ({ recoveredBotId }) => {
      const maxBotLinkService = {
        resolveBotRoute: jest.fn(),
      };
      const maxActionDispatchService = {
        recoverCompletedSend: jest.fn().mockResolvedValue({
          messageId: 'mid-recovered-required',
          url: null,
          botId: recoveredBotId,
        }),
        execute: jest.fn(),
      };
      const service = new MaxRoutedPublicationService(
        maxBotLinkService as never,
        maxActionDispatchService as never,
        { resolveMessageLink: jest.fn() } as never,
      );

      await expect(
        service.publish({
          entityId: 'channel-1',
          logicalIdempotencyKey: 'channel-suggestion:publish:v1:suggestion-recovered-required',
          text: 'video',
          trafficClass: 'interactive',
          sourceTag: 'suggestion_delivery',
          requiredBotId: 'media-bot',
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);

      expect(maxActionDispatchService.recoverCompletedSend).toHaveBeenCalledWith(
        expect.objectContaining({
          routing: { purpose: 'send_message', requiredBotId: 'media-bot' },
        }),
      );
      expect(maxBotLinkService.resolveBotRoute).not.toHaveBeenCalled();
      expect(maxActionDispatchService.execute).not.toHaveBeenCalled();
    },
  );

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
    const accessProbeStartedAt = new Date('2026-08-20T10:00:00.000Z');
    jest.useFakeTimers().setSystemTime(accessProbeStartedAt);
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
      getCurrentChatMemberAccess: jest.fn().mockImplementation(async () => {
        jest.setSystemTime(new Date('2026-08-20T10:00:05.000Z'));
        return access;
      }),
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
      checkedAt: accessProbeStartedAt,
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

  it('uses a fresh poll grant persisted between its initial route reads', async () => {
    const emptyRoute = {
      purpose: 'send_message',
      chatId: 'chat-concurrent-poll-grant',
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
        reason: 'primary_confirmed',
      }),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValue(false),
      recordBotAccessProbe: jest.fn(),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn().mockResolvedValue({
        messageId: 'mid-concurrent-poll-grant',
        url: null,
        botId: 'bot-1',
      }),
    };
    const maxClientService = {
      getCurrentChatMemberAccess: jest.fn(),
      resolveMessageLink: jest.fn().mockResolvedValue(null),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      maxClientService as never,
    );

    await expect(
      service.publish({
        entityId: 'chat-concurrent-poll-grant',
        logicalIdempotencyKey: 'managed-poll:publish:concurrent-grant',
        routePurpose: 'channel_poll',
        text: 'poll',
        trafficClass: 'interactive',
        sourceTag: 'managed_poll',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routingVersion: 5,
      }),
    );

    expect(maxBotLinkService.resolveBotRouteForManagedPoll).toHaveBeenCalledTimes(2);
    expect(maxClientService.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxBotLinkService.recordBotAccessProbe).not.toHaveBeenCalled();
    expect(maxActionDispatchService.execute).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-1', candidateBotIds: ['bot-1'] }),
      {},
    );
  });

  it('uses a poll grant persisted after an empty general-route read', async () => {
    const emptyRoute = {
      purpose: 'send_message',
      chatId: 'chat-late-poll-grant',
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
      resolveBotRoute: jest.fn().mockResolvedValue(emptyRoute),
      isBotAccessSnapshotStale: jest.fn(),
      recordBotAccessProbe: jest.fn(),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn().mockResolvedValue({
        messageId: 'mid-late-poll-grant',
        url: null,
        botId: 'bot-1',
      }),
    };
    const maxClientService = {
      getCurrentChatMemberAccess: jest.fn(),
      resolveMessageLink: jest.fn().mockResolvedValue(null),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      maxClientService as never,
    );

    await expect(
      service.publish({
        entityId: 'chat-late-poll-grant',
        logicalIdempotencyKey: 'managed-poll:publish:late-grant',
        routePurpose: 'channel_poll',
        text: 'poll',
        trafficClass: 'interactive',
        sourceTag: 'managed_poll',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routingVersion: 5,
      }),
    );

    expect(maxBotLinkService.resolveBotRouteForManagedPoll).toHaveBeenCalledTimes(2);
    expect(maxBotLinkService.isBotAccessSnapshotStale).not.toHaveBeenCalled();
    expect(maxClientService.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxActionDispatchService.execute).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-1', candidateBotIds: ['bot-1'] }),
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

  it('persists a terminal poll access lookup failure before closing the route', async () => {
    const accessProbeStartedAt = new Date('2026-08-20T10:00:00.000Z');
    jest.useFakeTimers().setSystemTime(accessProbeStartedAt);
    const emptyRoute = {
      purpose: 'send_message',
      chatId: 'chat-terminal-poll-lookup',
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
    const maxClientService = {
      getCurrentChatMemberAccess: jest.fn().mockRejectedValue(
        Object.assign(new Error('chat not found'), {
          response: { status: 404, data: { code: 'chat.not.found' } },
        }),
      ),
      resolveMessageLink: jest.fn(),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(null),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      maxClientService as never,
      managedEntityAccessLossService as never,
    );

    await expect(
      service.publish({
        entityId: 'chat-terminal-poll-lookup',
        logicalIdempotencyKey: 'managed-poll:publish:terminal-lookup',
        routePurpose: 'channel_poll',
        text: 'poll',
        trafficClass: 'interactive',
        sourceTag: 'managed_poll',
      }),
    ).rejects.toBeInstanceOf(MaxActionNoExecutableRouteError);

    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith({
      chatId: 'chat-terminal-poll-lookup',
      botId: 'bot-1',
      access: null,
      source: 'managed_poll_route_hydration',
      checkedAt: accessProbeStartedAt,
      lastErrorCode: 'chat.not.found',
    });
    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'chat-terminal-poll-lookup',
      botId: 'bot-1',
      operation: 'lookup',
      source: 'managed_poll_route_hydration',
      error: expect.objectContaining({ message: 'chat not found' }),
      lifecycleEventAt: accessProbeStartedAt,
      lifecycleEventType: 'live_probe',
      lifecycleSource: 'live_probe',
    });
    expect(maxBotLinkService.resolveBotRouteForManagedPoll).toHaveBeenCalledTimes(2);
    expect(maxActionDispatchService.execute).not.toHaveBeenCalled();
  });

  it('keeps a poll route closed when live access persistence is superseded', async () => {
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
      recordBotAccessProbe: jest.fn().mockResolvedValue(false),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn(),
    };
    const maxClientService = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-user-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
      }),
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
        logicalIdempotencyKey: 'managed-poll:publish:superseded-access',
        routePurpose: 'channel_poll',
        text: 'poll',
        trafficClass: 'interactive',
        sourceTag: 'managed_poll',
      }),
    ).rejects.toBeInstanceOf(MaxActionNoExecutableRouteError);

    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.resolveBotRouteForManagedPoll).toHaveBeenCalledTimes(2);
    expect(maxActionDispatchService.execute).not.toHaveBeenCalled();
  });

  it('uses a newer persisted poll grant when its own access CAS is superseded', async () => {
    const emptyRoute = {
      purpose: 'send_message',
      chatId: 'chat-1',
      primaryBotId: 'bot-1',
      botId: null,
      candidateBotIds: [],
      reason: null,
      routingVersion: 4,
    };
    const refreshedRoute = {
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
        .mockResolvedValueOnce(refreshedRoute),
      resolveBotRoute: jest.fn().mockResolvedValue({
        ...emptyRoute,
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
      }),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValue(true),
      recordBotAccessProbe: jest.fn().mockResolvedValue(false),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn().mockResolvedValue({
        messageId: 'poll-message-1',
        url: null,
        botId: 'bot-1',
      }),
    };
    const maxClientService = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-user-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
      }),
      resolveMessageLink: jest.fn().mockResolvedValue(null),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      maxClientService as never,
    );

    await expect(
      service.publish({
        entityId: 'chat-1',
        logicalIdempotencyKey: 'managed-poll:publish:newer-access',
        routePurpose: 'channel_poll',
        text: 'poll',
        trafficClass: 'interactive',
        sourceTag: 'managed_poll',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        messageId: 'poll-message-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routingVersion: 5,
      }),
    );

    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.resolveBotRouteForManagedPoll).toHaveBeenCalledTimes(2);
    expect(maxActionDispatchService.execute).toHaveBeenCalledTimes(1);
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
