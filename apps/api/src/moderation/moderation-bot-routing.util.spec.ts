import type { MaxUpdate } from '@maxim/contracts';
import type { MaxBotRoute } from '../max/max-bot-link.service';
import {
  readExecutionOwnerBotId,
  resolveAutoAttachBotId,
  resolveChatReadBotId,
  resolveUnifiedBotRoute,
} from './moderation-bot-routing.util';

function createRoute(params: Partial<MaxBotRoute> & Pick<MaxBotRoute, 'purpose'>): MaxBotRoute {
  return {
    chatId: 'chat-1',
    primaryBotId: null,
    botId: 'route-bot',
    candidateBotIds: ['route-bot'],
    reason: 'primary_confirmed',
    ...params,
  } as MaxBotRoute;
}

describe('moderation bot routing util', () => {
  it('reads a trimmed execution owner bot id from the update extension', () => {
    expect(
      readExecutionOwnerBotId({
        executionOwnerBotId: ' bot-1 ',
      } as MaxUpdate & { executionOwnerBotId: unknown }),
    ).toBe('bot-1');
    expect(
      readExecutionOwnerBotId({
        executionOwnerBotId: '   ',
      } as MaxUpdate & { executionOwnerBotId: unknown }),
    ).toBeNull();
    expect(
      readExecutionOwnerBotId({
        executionOwnerBotId: 123,
      } as MaxUpdate & { executionOwnerBotId: unknown }),
    ).toBeNull();
    expect(readExecutionOwnerBotId({} as MaxUpdate)).toBeNull();
  });

  it('uses multi-route resolution for moderation actions only', async () => {
    const moderationRoute = createRoute({
      purpose: 'moderation_action',
      action: 'delete_message',
    });
    const resolveBotRoutes = jest.fn().mockResolvedValue(moderationRoute);
    const resolveBotRoute = jest.fn().mockResolvedValue(
      createRoute({
        purpose: 'read',
        botId: 'read-route-bot',
      }),
    );

    await expect(
      resolveUnifiedBotRoute(
        {
          maxBotLinkService: {
            resolveBotRoutes,
            resolveBotRoute,
          } as never,
        },
        {
          purpose: 'moderation_action',
          chatId: 'chat-1',
          action: 'delete_message',
        },
      ),
    ).resolves.toBe(moderationRoute);

    expect(resolveBotRoutes).toHaveBeenCalledWith({
      purpose: 'moderation_action',
      chatId: 'chat-1',
      action: 'delete_message',
    });
    expect(resolveBotRoute).not.toHaveBeenCalled();

    await resolveUnifiedBotRoute(
      {
        maxBotLinkService: {
          resolveBotRoutes,
          resolveBotRoute,
        } as never,
      },
      {
        purpose: 'read',
        chatId: 'chat-1',
      },
    );

    expect(resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'read',
      chatId: 'chat-1',
    });
  });

  it('returns null when no route resolver is available', async () => {
    await expect(
      resolveUnifiedBotRoute(
        {},
        {
          purpose: 'read',
          chatId: 'chat-1',
        },
      ),
    ).resolves.toBeNull();
  });

  it('resolves read bot id from route, read fallback, default fallback, then null', async () => {
    const resolveBotRoute = jest.fn().mockResolvedValue(
      createRoute({
        purpose: 'read',
        botId: 'route-read-bot',
      }),
    );
    const resolveBotIdForRead = jest.fn().mockResolvedValue('fallback-read-bot');
    const resolveBotId = jest.fn().mockResolvedValue('fallback-default-bot');

    await expect(
      resolveChatReadBotId(
        {
          maxBotLinkService: {
            resolveBotRoute,
            resolveBotIdForRead,
            resolveBotId,
          } as never,
        },
        'chat-1',
      ),
    ).resolves.toBe('route-read-bot');
    expect(resolveBotIdForRead).not.toHaveBeenCalled();
    expect(resolveBotId).not.toHaveBeenCalled();

    resolveBotRoute.mockResolvedValueOnce(
      createRoute({
        purpose: 'read',
        botId: null,
      }),
    );
    await expect(
      resolveChatReadBotId(
        {
          maxBotLinkService: {
            resolveBotRoute,
            resolveBotIdForRead,
            resolveBotId,
          } as never,
        },
        'chat-1',
      ),
    ).resolves.toBe('fallback-read-bot');

    resolveBotRoute.mockResolvedValueOnce(
      createRoute({
        purpose: 'read',
        botId: null,
      }),
    );
    resolveBotIdForRead.mockResolvedValueOnce(null);
    await expect(
      resolveChatReadBotId(
        {
          maxBotLinkService: {
            resolveBotRoute,
            resolveBotIdForRead,
            resolveBotId,
          } as never,
        },
        'chat-1',
      ),
    ).resolves.toBe('fallback-default-bot');

    resolveBotIdForRead.mockResolvedValueOnce(null);
    resolveBotId.mockResolvedValueOnce(null);
    await expect(resolveChatReadBotId({}, 'chat-1')).resolves.toBeNull();
  });

  it('prefers active context bot for auto attach', async () => {
    const resolveBotRoute = jest.fn();

    await expect(
      resolveAutoAttachBotId(
        {
          maxBotContextService: {
            getActiveBotId: jest.fn().mockReturnValue(' active-bot '),
          } as never,
          maxBotLinkService: {
            resolveBotRoute,
          } as never,
        },
        'chat-1',
        'poll',
      ),
    ).resolves.toBe('active-bot');

    expect(resolveBotRoute).not.toHaveBeenCalled();
  });

  it('uses background scan capability before read fallback for poll auto attach', async () => {
    const resolveBotRoute = jest.fn().mockResolvedValue(
      createRoute({
        purpose: 'capability',
        capability: 'background_scans',
        botId: 'scan-route-bot',
      }),
    );
    const resolveBotIdForCapability = jest.fn().mockResolvedValue('scan-fallback-bot');

    await expect(
      resolveAutoAttachBotId(
        {
          maxBotContextService: {
            getActiveBotId: jest.fn().mockReturnValue(null),
          } as never,
          maxBotLinkService: {
            resolveBotRoute,
            resolveBotIdForCapability,
          } as never,
        },
        'chat-1',
        'poll',
      ),
    ).resolves.toBe('scan-route-bot');

    expect(resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'capability',
      chatId: 'chat-1',
      capability: 'background_scans',
      fallbackToPrimary: true,
    });
    expect(resolveBotIdForCapability).not.toHaveBeenCalled();
  });

  it('falls back from poll capability route to capability helper and trims it', async () => {
    const resolveBotRoute = jest.fn().mockResolvedValue(
      createRoute({
        purpose: 'capability',
        capability: 'background_scans',
        botId: null,
      }),
    );

    await expect(
      resolveAutoAttachBotId(
        {
          maxBotContextService: {
            getActiveBotId: jest.fn().mockReturnValue(null),
          } as never,
          maxBotLinkService: {
            resolveBotRoute,
            resolveBotIdForCapability: jest.fn().mockResolvedValue(' scan-helper-bot '),
          } as never,
        },
        'chat-1',
        'poll',
      ),
    ).resolves.toBe('scan-helper-bot');
  });

  it('uses read routing for webhook auto attach', async () => {
    const resolveBotRoute = jest.fn().mockResolvedValue(
      createRoute({
        purpose: 'read',
        botId: 'read-route-bot',
      }),
    );
    const resolveBotIdForCapability = jest.fn();

    await expect(
      resolveAutoAttachBotId(
        {
          maxBotContextService: {
            getActiveBotId: jest.fn().mockReturnValue(null),
          } as never,
          maxBotLinkService: {
            resolveBotRoute,
            resolveBotIdForCapability,
          } as never,
        },
        'chat-1',
        'webhook',
      ),
    ).resolves.toBe('read-route-bot');

    expect(resolveBotIdForCapability).not.toHaveBeenCalled();
    expect(resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'read',
      chatId: 'chat-1',
    });
  });
});
