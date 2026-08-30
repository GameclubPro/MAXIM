import { AdminSettingsBotCapabilityService } from './admin-settings-bot-capability.service';

type CapabilityState = 'confirmed_capable' | 'explicitly_incapable' | 'stale_or_unknown';

function capabilityRoute(
  capabilityState: CapabilityState,
  overrides: { botId?: string | null; checkedAt?: string | null } = {},
) {
  return {
    botId:
      overrides.botId !== undefined
        ? overrides.botId
        : capabilityState === 'confirmed_capable'
          ? 'bot-1'
          : null,
    capabilityState,
    checkedAt: overrides.checkedAt ?? '2026-08-30T10:00:00.000Z',
  };
}

function createService() {
  const maxBotLinkService = {
    resolveStrictMemberModerationBotRoute: jest
      .fn()
      .mockResolvedValue(capabilityRoute('confirmed_capable')),
    resolveStrictWriteModerationBotRoute: jest
      .fn()
      .mockResolvedValue(capabilityRoute('confirmed_capable')),
  };
  const maxBotExecutionPlanner = {
    refreshChatBotCapabilitySnapshots: jest.fn().mockResolvedValue({}),
  };
  const service = new AdminSettingsBotCapabilityService(
    maxBotLinkService as never,
    maxBotExecutionPlanner as never,
  );
  return { maxBotExecutionPlanner, maxBotLinkService, service };
}

describe('AdminSettingsBotCapabilityService', () => {
  it('uses fresh strict routes without a MAX refresh', async () => {
    const { maxBotExecutionPlanner, maxBotLinkService, service } = createService();

    await service.assertChatSettingsBotCapabilities('chat-1', [
      { permission: 'write', featureKeys: ['nightModeEnabled'] },
      { permission: 'add_remove_members', featureKeys: ['deleteSpammersEnabled'] },
    ]);

    expect(maxBotLinkService.resolveStrictWriteModerationBotRoute).toHaveBeenCalledWith({
      chatId: 'chat-1',
    });
    expect(maxBotLinkService.resolveStrictMemberModerationBotRoute).toHaveBeenCalledWith({
      chatId: 'chat-1',
    });
    expect(maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots).not.toHaveBeenCalled();
  });

  it('refreshes all active memberships once when a strict route is stale', async () => {
    const { maxBotExecutionPlanner, maxBotLinkService, service } = createService();
    maxBotLinkService.resolveStrictWriteModerationBotRoute
      .mockResolvedValueOnce(capabilityRoute('stale_or_unknown'))
      .mockResolvedValueOnce(
        capabilityRoute('confirmed_capable', { checkedAt: '2026-08-30T10:00:01.000Z' }),
      );

    await service.assertChatSettingsBotCapabilities('chat-1', [
      { permission: 'write', featureKeys: ['commercialAdsFilterEnabled'] },
    ]);

    expect(maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots).toHaveBeenCalledWith({
      chatId: 'chat-1',
      entityType: 'chat',
      force: false,
    });
    expect(maxBotLinkService.resolveStrictWriteModerationBotRoute).toHaveBeenCalledTimes(2);
  });

  it('forces live refresh and accepts only a route checked during that refresh', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-30T10:00:01.000Z'));
    const { maxBotExecutionPlanner, maxBotLinkService, service } = createService();
    maxBotLinkService.resolveStrictWriteModerationBotRoute
      .mockResolvedValueOnce(capabilityRoute('explicitly_incapable'))
      .mockResolvedValueOnce(
        capabilityRoute('confirmed_capable', { checkedAt: '2026-08-30T10:00:01.000Z' }),
      );

    try {
      await service.assertChatSettingsBotCapabilities(
        'chat-1',
        [{ permission: 'write', featureKeys: ['nightModeEnabled'] }],
        { forceLive: true },
      );
    } finally {
      jest.useRealTimers();
    }

    expect(maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots).toHaveBeenCalledWith({
      chatId: 'chat-1',
      entityType: 'chat',
      force: true,
    });
  });

  it('rejects a force-live retry when the route still contains only old evidence', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-30T10:00:01.000Z'));
    const { service } = createService();

    try {
      await expect(
        service.assertChatSettingsBotCapabilities(
          'chat-1',
          [{ permission: 'write', featureKeys: ['nightModeEnabled'] }],
          { forceLive: true },
        ),
      ).rejects.toMatchObject({
        status: 503,
        response: expect.objectContaining({
          code: 'BOT_CAPABILITY_CHECK_UNAVAILABLE',
          featureKeys: ['nightModeEnabled'],
        }),
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns only definitively missing permissions and their feature keys', async () => {
    const { maxBotLinkService, service } = createService();
    maxBotLinkService.resolveStrictWriteModerationBotRoute.mockResolvedValue(
      capabilityRoute('explicitly_incapable'),
    );
    maxBotLinkService.resolveStrictMemberModerationBotRoute.mockResolvedValue(
      capabilityRoute('explicitly_incapable'),
    );

    await expect(
      service.assertChatSettingsBotCapabilities('chat-1', [
        { permission: 'write', featureKeys: ['antiSpamEnabled', 'nightModeEnabled'] },
        { permission: 'add_remove_members', featureKeys: ['antiSpamEnabled'] },
      ]),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: 'BOT_CAPABILITY_REQUIRED',
        missingPermissions: ['write', 'add_remove_members'],
        featureKeys: ['antiSpamEnabled', 'nightModeEnabled'],
        checkedAt: '2026-08-30T10:00:00.000Z',
      }),
    });
  });

  it('keeps stale or unknown post-refresh evidence as a structured 503', async () => {
    const { maxBotLinkService, service } = createService();
    maxBotLinkService.resolveStrictMemberModerationBotRoute.mockResolvedValue(
      capabilityRoute('stale_or_unknown'),
    );

    await expect(
      service.assertChatSettingsBotCapabilities('chat-1', [
        { permission: 'add_remove_members', featureKeys: ['deleteSpammersEnabled'] },
      ]),
    ).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({
        code: 'BOT_CAPABILITY_CHECK_UNAVAILABLE',
        featureKeys: ['deleteSpammersEnabled'],
      }),
    });
  });

  it('maps planner failures to a structured 503', async () => {
    const { maxBotExecutionPlanner, maxBotLinkService, service } = createService();
    maxBotLinkService.resolveStrictWriteModerationBotRoute.mockResolvedValue(
      capabilityRoute('stale_or_unknown'),
    );
    maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots.mockRejectedValue(
      new Error('MAX timeout'),
    );

    await expect(
      service.assertChatSettingsBotCapabilities('chat-1', [
        { permission: 'write', featureKeys: ['greetingEnabled'] },
      ]),
    ).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({ code: 'BOT_CAPABILITY_CHECK_UNAVAILABLE' }),
    });
  });

  it('maps initial and post-refresh route read failures to a structured 503', async () => {
    const first = createService();
    first.maxBotLinkService.resolveStrictWriteModerationBotRoute.mockRejectedValue(
      new Error('database unavailable'),
    );
    await expect(
      first.service.assertChatSettingsBotCapabilities('chat-1', [
        { permission: 'write', featureKeys: ['greetingEnabled'] },
      ]),
    ).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({
        code: 'BOT_CAPABILITY_CHECK_UNAVAILABLE',
        featureKeys: ['greetingEnabled'],
      }),
    });

    const second = createService();
    second.maxBotLinkService.resolveStrictWriteModerationBotRoute
      .mockResolvedValueOnce(capabilityRoute('stale_or_unknown'))
      .mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      second.service.assertChatSettingsBotCapabilities('chat-1', [
        { permission: 'write', featureKeys: ['greetingEnabled'] },
      ]),
    ).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({ code: 'BOT_CAPABILITY_CHECK_UNAVAILABLE' }),
    });
  });
});
