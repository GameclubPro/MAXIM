import type { MaxActionJob } from './max-client.service';
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
      execute: jest.fn().mockImplementation(async (job: MaxActionJob, options: any) => {
        const prepared = await options.prepareAttempt({ botId: 'bot-2', job });
        options.onDispatchAttempt({ botId: 'bot-2', job: { ...job, ...prepared } });
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
      resolveBotRouteForChannelPoll: jest.fn().mockResolvedValue({
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

    expect(maxBotLinkService.resolveBotRouteForChannelPoll).toHaveBeenCalledWith({
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
});
