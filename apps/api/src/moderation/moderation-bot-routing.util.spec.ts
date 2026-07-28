import type { MaxUpdate } from '@maxim/contracts';
import type { MaxBotRoute } from '../max/max-bot-link.service';
import {
  readExecutionOwnerBotId,
  resolveAutoAttachBotId,
  resolveChatReadBotId,
  resolveModerationActionBotIds,
  resolveNightModeTransitionBotId,
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

  it('resolves night mode transition bot id from send route first', async () => {
    const resolveBotRoute = jest.fn().mockResolvedValue(
      createRoute({
        purpose: 'send_message',
        botId: ' send-route-bot ',
      }),
    );
    const resolveBotIdForCapability = jest.fn().mockResolvedValue('scan-helper-bot');
    const resolveBotIdForRead = jest.fn().mockResolvedValue('read-bot');

    await expect(
      resolveNightModeTransitionBotId(
        {
          maxBotLinkService: {
            resolveBotRoute,
            resolveBotIdForCapability,
            resolveBotIdForRead,
          } as never,
        },
        'chat-1',
      ),
    ).resolves.toBe('send-route-bot');

    expect(resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'send_message',
      chatId: 'chat-1',
      fallbackToPrimary: true,
    });
    expect(resolveBotIdForCapability).not.toHaveBeenCalled();
    expect(resolveBotIdForRead).not.toHaveBeenCalled();
  });

  it('falls back from empty night mode send route to capability helper and trims it', async () => {
    const resolveBotRoute = jest
      .fn()
      .mockResolvedValueOnce(
        createRoute({
          purpose: 'send_message',
          botId: null,
        }),
      )
      .mockResolvedValueOnce(
        createRoute({
          purpose: 'capability',
          capability: 'background_scans',
          botId: null,
        }),
      );
    const resolveBotIdForCapability = jest.fn().mockResolvedValue(' scan-helper-bot ');
    const resolveBotIdForRead = jest.fn().mockResolvedValue('read-bot');

    await expect(
      resolveNightModeTransitionBotId(
        {
          maxBotLinkService: {
            resolveBotRoute,
            resolveBotIdForCapability,
            resolveBotIdForRead,
          } as never,
        },
        'chat-1',
      ),
    ).resolves.toBe('scan-helper-bot');

    expect(resolveBotIdForCapability).toHaveBeenCalledWith({
      chatId: 'chat-1',
      capability: 'background_scans',
    });
    expect(resolveBotIdForRead).not.toHaveBeenCalled();
    expect(resolveBotRoute).toHaveBeenNthCalledWith(1, {
      purpose: 'send_message',
      chatId: 'chat-1',
      fallbackToPrimary: true,
    });
    expect(resolveBotRoute).toHaveBeenNthCalledWith(2, {
      purpose: 'capability',
      chatId: 'chat-1',
      capability: 'background_scans',
      fallbackToPrimary: true,
    });
  });

  it('does not bypass a quarantined night mode send route through a read capability', async () => {
    const resolveBotRoute = jest.fn().mockResolvedValue(
      createRoute({
        purpose: 'send_message',
        botId: null,
        candidateBotIds: [],
        quarantinedCandidateBotIds: ['bot-1'],
      }),
    );
    const resolveBotIdForCapability = jest.fn().mockResolvedValue('scan-helper-bot');
    const resolveBotIdForRead = jest.fn().mockResolvedValue('read-bot');

    await expect(
      resolveNightModeTransitionBotId(
        {
          maxBotLinkService: {
            resolveBotRoute,
            resolveBotIdForCapability,
            resolveBotIdForRead,
          } as never,
        },
        'chat-1',
      ),
    ).resolves.toBeNull();

    expect(resolveBotRoute).toHaveBeenCalledTimes(1);
    expect(resolveBotIdForCapability).not.toHaveBeenCalled();
    expect(resolveBotIdForRead).not.toHaveBeenCalled();
  });

  it('falls back from empty night mode capability helper to read routing', async () => {
    const resolveBotRoute = jest
      .fn()
      .mockResolvedValueOnce(
        createRoute({
          purpose: 'send_message',
          botId: null,
        }),
      )
      .mockResolvedValueOnce(
        createRoute({
          purpose: 'capability',
          capability: 'background_scans',
          botId: null,
        }),
      )
      .mockResolvedValueOnce(
        createRoute({
          purpose: 'read',
          botId: 'read-route-bot',
        }),
      );

    await expect(
      resolveNightModeTransitionBotId(
        {
          maxBotLinkService: {
            resolveBotRoute,
            resolveBotIdForCapability: jest.fn().mockResolvedValue(null),
          } as never,
        },
        'chat-1',
      ),
    ).resolves.toBe('read-route-bot');

    expect(resolveBotRoute).toHaveBeenNthCalledWith(1, {
      purpose: 'send_message',
      chatId: 'chat-1',
      fallbackToPrimary: true,
    });
    expect(resolveBotRoute).toHaveBeenNthCalledWith(2, {
      purpose: 'capability',
      chatId: 'chat-1',
      capability: 'background_scans',
      fallbackToPrimary: true,
    });
    expect(resolveBotRoute).toHaveBeenNthCalledWith(3, {
      purpose: 'read',
      chatId: 'chat-1',
    });
  });

  it('returns null when night mode routing has no usable bot id', async () => {
    await expect(
      resolveNightModeTransitionBotId(
        {
          maxBotLinkService: {
            resolveBotRoute: jest.fn().mockResolvedValue(
              createRoute({
                purpose: 'capability',
                capability: 'background_scans',
                botId: '   ',
              }),
            ),
            resolveBotIdForCapability: jest.fn().mockResolvedValue(''),
            resolveBotIdForRead: jest.fn().mockResolvedValue('  '),
            resolveBotId: jest.fn().mockResolvedValue(null),
          } as never,
        },
        'chat-1',
      ),
    ).resolves.toBeNull();
  });

  it('prefers an explicit moderation action bot id', async () => {
    const resolveBotRoutes = jest.fn();

    await expect(
      resolveModerationActionBotIds(
        {
          maxBotLinkService: {
            resolveBotRoutes,
          } as never,
        },
        {
          chatId: 'chat-1',
          action: 'delete_message',
          explicitBotId: ' action-bot ',
        },
      ),
    ).resolves.toEqual(['action-bot']);

    expect(resolveBotRoutes).not.toHaveBeenCalled();
  });

  it('resolves moderation action candidates from multi-route routing', async () => {
    const resolveBotRoutes = jest.fn().mockResolvedValue(
      createRoute({
        purpose: 'moderation_action',
        action: 'delete_message',
        candidateBotIds: [' bot-a ', 'bot-b', 'bot-a', '', '   '],
      }),
    );
    const resolveBotIdsForModerationAction = jest.fn();
    const resolveBotIdForModerationAction = jest.fn();

    await expect(
      resolveModerationActionBotIds(
        {
          maxBotLinkService: {
            resolveBotRoutes,
            resolveBotIdsForModerationAction,
            resolveBotIdForModerationAction,
          } as never,
        },
        {
          chatId: 'chat-1',
          action: 'delete_message',
        },
      ),
    ).resolves.toEqual(['bot-a', 'bot-b']);

    expect(resolveBotRoutes).toHaveBeenCalledWith({
      purpose: 'moderation_action',
      chatId: 'chat-1',
      action: 'delete_message',
      fallbackToPrimary: true,
    });
    expect(resolveBotIdsForModerationAction).not.toHaveBeenCalled();
    expect(resolveBotIdForModerationAction).not.toHaveBeenCalled();
  });

  it('keeps an empty moderation action route as no candidates', async () => {
    const resolveBotRoutes = jest.fn().mockResolvedValue(
      createRoute({
        purpose: 'moderation_action',
        action: 'moderate_member',
        candidateBotIds: [],
      }),
    );
    const resolveBotIdsForModerationAction = jest.fn().mockResolvedValue(['fallback-bot']);

    await expect(
      resolveModerationActionBotIds(
        {
          maxBotLinkService: {
            resolveBotRoutes,
            resolveBotIdsForModerationAction,
          } as never,
        },
        {
          chatId: 'chat-1',
          action: 'moderate_member',
        },
      ),
    ).resolves.toEqual([]);

    expect(resolveBotIdsForModerationAction).not.toHaveBeenCalled();
  });

  it('falls back to moderation action bot helper list, single helper, then null candidate', async () => {
    const listResolver = {
      resolveBotIdsForModerationAction: jest
        .fn()
        .mockResolvedValue([' helper-a ', 'helper-b', 'helper-a', '']),
    };
    await expect(
      resolveModerationActionBotIds(
        {
          maxBotLinkService: listResolver as never,
        },
        {
          chatId: 'chat-1',
          action: 'delete_message',
        },
      ),
    ).resolves.toEqual(['helper-a', 'helper-b']);
    expect(listResolver.resolveBotIdsForModerationAction).toHaveBeenCalledWith({
      chatId: 'chat-1',
      action: 'delete_message',
      fallbackToPrimary: true,
    });

    const singleResolver = {
      resolveBotIdForModerationAction: jest.fn().mockResolvedValue('single-bot'),
    };
    await expect(
      resolveModerationActionBotIds(
        {
          maxBotLinkService: singleResolver as never,
        },
        {
          chatId: 'chat-1',
          action: 'moderate_member',
        },
      ),
    ).resolves.toEqual(['single-bot']);
    expect(singleResolver.resolveBotIdForModerationAction).toHaveBeenCalledWith({
      chatId: 'chat-1',
      action: 'moderate_member',
      fallbackToPrimary: true,
    });

    await expect(
      resolveModerationActionBotIds(
        {},
        {
          chatId: 'chat-1',
          action: 'delete_message',
        },
      ),
    ).resolves.toEqual([null]);
  });
});
