import { MaxWebhookSubscriptionReconcilerService } from './max-webhook-subscription-reconciler.service';
import { MAX_API_SOURCE_TAGS } from './max-client.service';
import { MAX_REQUIRED_WEBHOOK_UPDATE_TYPES } from './max-webhook-subscription.constants';

describe('MaxWebhookSubscriptionReconcilerService', () => {
  const originalAppRole = process.env.APP_ROLE;

  afterEach(() => {
    if (originalAppRole === undefined) {
      delete process.env.APP_ROLE;
    } else {
      process.env.APP_ROLE = originalAppRole;
    }
    jest.clearAllMocks();
  });

  function createPrismaMock(
    params: {
      latestWebhookByBot?: Record<string, Date | null>;
      activeMembershipsByBot?: Record<string, { count: number; lastWebhookAt: Date | null }>;
    } = {},
  ) {
    const latestWebhookByBot = params.latestWebhookByBot ?? {};
    const activeMembershipsByBot = params.activeMembershipsByBot ?? {};
    return {
      chatBotMembership: {
        aggregate: jest.fn().mockResolvedValue({ _max: { lastWebhookAt: null } }),
        groupBy: jest.fn().mockImplementation((args: { where?: { status?: unknown } }) => {
          if (args.where?.status === 'ACTIVE') {
            return Promise.resolve(
              Object.entries(activeMembershipsByBot).map(([botId, value]) => ({
                botId,
                _count: { _all: value.count },
                _max: { lastWebhookAt: value.lastWebhookAt },
              })),
            );
          }

          return Promise.resolve(
            Object.entries(latestWebhookByBot)
              .filter(([, value]) => value !== null)
              .map(([botId, value]) => ({
                botId,
                _max: { lastWebhookAt: value },
              })),
          );
        }),
      },
    };
  }

  it('repairs missing webhook update types and stores a healthy snapshot', async () => {
    process.env.APP_ROLE = 'ingress';

    const botRegistry = {
      getAllBots: jest.fn().mockReturnValue([
        {
          id: '777000_bot',
          webhookHeaderSecrets: ['secret-header-current'],
        },
      ]),
      getDefaultBot: jest.fn().mockReturnValue({ id: '777000_bot' }),
      computeWebhookHeaderSecretFingerprint: jest.fn().mockReturnValue('fingerprint-777000_bot'),
    };
    const statusService = {
      getSyncState: jest.fn().mockResolvedValue(null),
      writeSnapshot: jest.fn().mockResolvedValue(undefined),
      writeSyncState: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn(),
    };
    const maxClient = {
      getConfiguredWebhookSubscriptionTarget: jest.fn().mockReturnValue({
        url: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
        maskedUrl: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/***',
      }),
      listWebhookSubscriptions: jest.fn().mockResolvedValue([
        {
          url: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
          updateTypes: ['message_created', 'message_callback', 'user_added'],
        },
      ]),
      matchesConfiguredWebhookUrl: jest.fn().mockImplementation((url: string) => {
        return url === 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path';
      }),
      deleteWebhookSubscription: jest.fn().mockResolvedValue(undefined),
      ensureWebhookSubscription: jest.fn().mockResolvedValue({
        url: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
        updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      }),
    };
    const service = new MaxWebhookSubscriptionReconcilerService(
      maxClient as never,
      botRegistry as never,
      statusService as never,
      createPrismaMock() as never,
      {
        get: jest.fn((key: string, fallback?: number) => {
          if (key === 'MAX_WEBHOOK_RECONCILE_INTERVAL_MS') {
            return 60_000;
          }
          return fallback;
        }),
      } as never,
    );

    await service.onModuleInit();

    expect(maxClient.ensureWebhookSubscription).toHaveBeenCalledWith(
      [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      {
        trafficClass: 'background',
        botId: '777000_bot',
        sourceTag: MAX_API_SOURCE_TAGS.WEBHOOK_SUBSCRIPTION_RECONCILE,
      },
    );
    expect(statusService.writeSyncState).toHaveBeenCalledWith(
      expect.objectContaining({
        bots: expect.objectContaining({
          '777000_bot': expect.objectContaining({
            configuredUrl: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
          }),
        }),
      }),
    );
    expect(statusService.writeSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'healthy',
        configured: true,
        url: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/***',
        missingUpdateTypes: [],
        actualUpdateTypes: expect.arrayContaining([...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES]),
        botCount: 1,
        bots: expect.objectContaining({
          '777000_bot': expect.objectContaining({
            configured: true,
            status: 'healthy',
          }),
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('marks an active bot with a subscription but no memberships or incoming webhook as warning', async () => {
    process.env.APP_ROLE = 'ingress';

    const botRegistry = {
      getAllBots: jest.fn().mockReturnValue([
        {
          id: 'idle_bot',
          state: 'active',
          webhookHeaderSecrets: ['secret-header-current'],
        },
      ]),
      getDefaultBot: jest.fn().mockReturnValue({ id: 'idle_bot' }),
      computeWebhookHeaderSecretFingerprint: jest.fn().mockReturnValue('fingerprint-idle_bot'),
    };
    const statusService = {
      getSyncState: jest.fn().mockResolvedValue({
        bots: {},
        lastGlobalIncomingWebhookAt: null,
        lastGlobalAutoRecreateAt: null,
      }),
      writeSnapshot: jest.fn().mockResolvedValue(undefined),
      writeSyncState: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn(),
    };
    const maxClient = {
      getConfiguredWebhookSubscriptionTarget: jest.fn().mockReturnValue({
        url: 'https://maxim.play-team.ru/api/webhook/max/idle_bot/secret-path',
        maskedUrl: 'https://maxim.play-team.ru/api/webhook/max/idle_bot/***',
      }),
      listWebhookSubscriptions: jest.fn().mockResolvedValue([
        {
          url: 'https://maxim.play-team.ru/api/webhook/max/idle_bot/secret-path',
          updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
        },
      ]),
      matchesConfiguredWebhookUrl: jest.fn().mockImplementation((url: string) => {
        return url === 'https://maxim.play-team.ru/api/webhook/max/idle_bot/secret-path';
      }),
      deleteWebhookSubscription: jest.fn().mockResolvedValue(undefined),
      ensureWebhookSubscription: jest.fn().mockResolvedValue({
        url: 'https://maxim.play-team.ru/api/webhook/max/idle_bot/secret-path',
        updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      }),
    };
    const service = new MaxWebhookSubscriptionReconcilerService(
      maxClient as never,
      botRegistry as never,
      statusService as never,
      createPrismaMock() as never,
      {
        get: jest.fn((key: string, fallback?: number) => {
          if (key === 'MAX_WEBHOOK_RECONCILE_INTERVAL_MS') {
            return 60_000;
          }
          return fallback;
        }),
      } as never,
    );

    await service.onModuleInit();

    expect(maxClient.deleteWebhookSubscription).not.toHaveBeenCalled();
    expect(maxClient.ensureWebhookSubscription).not.toHaveBeenCalled();
    expect(statusService.writeSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'warning',
        operationalDiagnostics: {
          warningBotCount: 1,
          warningBotIds: ['idle_bot'],
          noActiveMembershipBotIds: ['idle_bot'],
          noIncomingWebhookBotIds: ['idle_bot'],
        },
        bots: expect.objectContaining({
          idle_bot: expect.objectContaining({
            status: 'warning',
            operationalDiagnostics: {
              lifecycleState: 'active',
              activeMemberships: 0,
              hasCurrentSubscription: true,
              lastIncomingWebhookAt: null,
              lastMembershipWebhookAt: null,
              issueCodes: ['no-active-memberships', 'no-incoming-webhooks'],
            },
            note: expect.stringContaining('нет active chat_bot_memberships'),
          }),
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('leaves the shared snapshot untouched when reconcile is not active on the current app role', async () => {
    process.env.APP_ROLE = 'admin';

    const botRegistry = {
      getAllBots: jest.fn().mockReturnValue([
        {
          id: '777000_bot',
          webhookHeaderSecrets: ['secret-header-current'],
        },
      ]),
      getDefaultBot: jest.fn().mockReturnValue({ id: '777000_bot' }),
      computeWebhookHeaderSecretFingerprint: jest.fn().mockReturnValue('fingerprint-777000_bot'),
    };
    const statusService = {
      getSyncState: jest.fn(),
      writeSnapshot: jest.fn().mockResolvedValue(undefined),
      writeSyncState: jest.fn(),
      getSnapshot: jest.fn(),
    };
    const maxClient = {
      getConfiguredWebhookSubscriptionTarget: jest.fn(),
      listWebhookSubscriptions: jest.fn(),
      matchesConfiguredWebhookUrl: jest.fn(),
      deleteWebhookSubscription: jest.fn(),
      ensureWebhookSubscription: jest.fn(),
    };
    const service = new MaxWebhookSubscriptionReconcilerService(
      maxClient as never,
      botRegistry as never,
      statusService as never,
      createPrismaMock() as never,
      {
        get: jest.fn((_: string, fallback?: number) => fallback),
      } as never,
    );

    await service.onModuleInit();

    expect(maxClient.listWebhookSubscriptions).not.toHaveBeenCalled();
    expect(statusService.writeSnapshot).not.toHaveBeenCalled();
    expect(statusService.writeSyncState).not.toHaveBeenCalled();
  });

  it('recreates the current webhook subscription once when header secret rotation is pending', async () => {
    process.env.APP_ROLE = 'ingress';

    const botRegistry = {
      getAllBots: jest.fn().mockReturnValue([
        {
          id: '777000_bot',
          webhookHeaderSecrets: ['secret-header-current', 'secret-header-previous'],
        },
      ]),
      getDefaultBot: jest.fn().mockReturnValue({ id: '777000_bot' }),
      computeWebhookHeaderSecretFingerprint: jest.fn().mockReturnValue('fingerprint-777000_bot'),
    };
    const statusService = {
      getSyncState: jest.fn().mockResolvedValue({
        bots: {
          '777000_bot': {
            configuredUrl: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
            headerSecretFingerprint: null,
            updatedAt: '2026-03-30T00:00:00.000Z',
            lastIncomingWebhookAt: null,
            lastAutoRecreateAt: null,
          },
        },
        lastGlobalIncomingWebhookAt: null,
        lastGlobalAutoRecreateAt: null,
      }),
      writeSnapshot: jest.fn().mockResolvedValue(undefined),
      writeSyncState: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn(),
    };
    const maxClient = {
      getConfiguredWebhookSubscriptionTarget: jest.fn().mockReturnValue({
        url: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
        maskedUrl: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/***',
      }),
      listWebhookSubscriptions: jest.fn().mockResolvedValue([
        {
          url: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
          updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
        },
      ]),
      matchesConfiguredWebhookUrl: jest.fn().mockImplementation((url: string) => {
        return url === 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path';
      }),
      deleteWebhookSubscription: jest.fn().mockResolvedValue(undefined),
      ensureWebhookSubscription: jest.fn().mockResolvedValue({
        url: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
        updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      }),
    };
    const service = new MaxWebhookSubscriptionReconcilerService(
      maxClient as never,
      botRegistry as never,
      statusService as never,
      createPrismaMock() as never,
      {
        get: jest.fn((key: string, fallback?: number | string) => {
          if (key === 'MAX_WEBHOOK_RECONCILE_INTERVAL_MS') {
            return 60_000;
          }
          return fallback;
        }),
      } as never,
    );

    await service.onModuleInit();

    expect(maxClient.deleteWebhookSubscription).toHaveBeenCalledWith(
      'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
      {
        trafficClass: 'background',
        botId: '777000_bot',
        sourceTag: MAX_API_SOURCE_TAGS.WEBHOOK_SUBSCRIPTION_RECONCILE,
      },
    );
    expect(maxClient.ensureWebhookSubscription).toHaveBeenCalledWith(
      [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      {
        trafficClass: 'background',
        botId: '777000_bot',
        sourceTag: MAX_API_SOURCE_TAGS.WEBHOOK_SUBSCRIPTION_RECONCILE,
      },
    );
    expect(statusService.writeSyncState).toHaveBeenCalledWith(
      expect.objectContaining({
        bots: expect.objectContaining({
          '777000_bot': expect.objectContaining({
            configuredUrl: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
            headerSecretFingerprint: expect.any(String),
          }),
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('auto-recreates healthy subscriptions when ingress is stale', async () => {
    process.env.APP_ROLE = 'ingress';

    const botRegistry = {
      getAllBots: jest.fn().mockReturnValue([
        {
          id: '777000_bot',
          webhookHeaderSecrets: ['secret-header-current'],
        },
      ]),
      getDefaultBot: jest.fn().mockReturnValue({ id: '777000_bot' }),
      computeWebhookHeaderSecretFingerprint: jest.fn().mockReturnValue('fingerprint-777000_bot'),
    };
    const staleAt = new Date(Date.now() - 40 * 60 * 1_000).toISOString();
    const statusService = {
      getSyncState: jest.fn().mockResolvedValue({
        bots: {
          '777000_bot': {
            configuredUrl: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
            headerSecretFingerprint: 'fingerprint-777000_bot',
            updatedAt: '2026-03-30T00:00:00.000Z',
            lastIncomingWebhookAt: staleAt,
            lastAutoRecreateAt: null,
          },
        },
        lastGlobalIncomingWebhookAt: staleAt,
        lastGlobalAutoRecreateAt: null,
      }),
      writeSnapshot: jest.fn().mockResolvedValue(undefined),
      writeSyncState: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn(),
    };
    const maxClient = {
      getConfiguredWebhookSubscriptionTarget: jest.fn().mockReturnValue({
        url: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
        maskedUrl: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/***',
      }),
      listWebhookSubscriptions: jest.fn().mockResolvedValue([
        {
          url: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
          updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
        },
      ]),
      matchesConfiguredWebhookUrl: jest.fn().mockImplementation((url: string) => {
        return url === 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path';
      }),
      deleteWebhookSubscription: jest.fn().mockResolvedValue(undefined),
      ensureWebhookSubscription: jest.fn().mockResolvedValue({
        url: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
        updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      }),
    };
    const service = new MaxWebhookSubscriptionReconcilerService(
      maxClient as never,
      botRegistry as never,
      statusService as never,
      createPrismaMock() as never,
      {
        get: jest.fn((key: string, fallback?: number | string) => {
          if (key === 'MAX_WEBHOOK_RECONCILE_INTERVAL_MS') {
            return 60_000;
          }
          if (key === 'MAX_WEBHOOK_STALE_INGRESS_MS') {
            return 10 * 60 * 1_000;
          }
          if (key === 'MAX_WEBHOOK_STALE_RECREATE_COOLDOWN_MS') {
            return 30 * 60 * 1_000;
          }
          return fallback;
        }),
      } as never,
    );

    await service.onModuleInit();

    expect(maxClient.deleteWebhookSubscription).toHaveBeenCalledWith(
      'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
      {
        trafficClass: 'background',
        botId: '777000_bot',
        sourceTag: MAX_API_SOURCE_TAGS.WEBHOOK_SUBSCRIPTION_RECONCILE,
      },
    );
    expect(maxClient.ensureWebhookSubscription).toHaveBeenCalledWith(
      [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      {
        trafficClass: 'background',
        botId: '777000_bot',
        sourceTag: MAX_API_SOURCE_TAGS.WEBHOOK_SUBSCRIPTION_RECONCILE,
      },
    );
    expect(statusService.writeSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'warning',
        bots: expect.objectContaining({
          '777000_bot': expect.objectContaining({
            status: 'warning',
            note: expect.stringContaining('подписка была пересоздана автоматически'),
          }),
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('auto-recreates only the bot whose incoming webhook stream is stale', async () => {
    process.env.APP_ROLE = 'ingress';

    const botRegistry = {
      getAllBots: jest.fn().mockReturnValue([
        {
          id: 'fresh_bot',
          webhookHeaderSecrets: ['secret-header-current'],
        },
        {
          id: 'stale_bot',
          webhookHeaderSecrets: ['secret-header-current'],
        },
      ]),
      getDefaultBot: jest.fn().mockReturnValue({ id: 'fresh_bot' }),
      computeWebhookHeaderSecretFingerprint: jest
        .fn()
        .mockImplementation((botId: string) => `fingerprint-${botId}`),
    };
    const freshAt = new Date(Date.now() - 60_000).toISOString();
    const staleAt = new Date(Date.now() - 40 * 60 * 1_000).toISOString();
    const statusService = {
      getSyncState: jest.fn().mockResolvedValue({
        bots: {
          fresh_bot: {
            configuredUrl: 'https://maxim.play-team.ru/api/webhook/max/fresh_bot/secret-path',
            headerSecretFingerprint: 'fingerprint-fresh_bot',
            updatedAt: '2026-03-30T00:00:00.000Z',
            lastIncomingWebhookAt: freshAt,
            lastAutoRecreateAt: null,
          },
          stale_bot: {
            configuredUrl: 'https://maxim.play-team.ru/api/webhook/max/stale_bot/secret-path',
            headerSecretFingerprint: 'fingerprint-stale_bot',
            updatedAt: '2026-03-30T00:00:00.000Z',
            lastIncomingWebhookAt: staleAt,
            lastAutoRecreateAt: null,
          },
        },
        lastGlobalIncomingWebhookAt: freshAt,
        lastGlobalAutoRecreateAt: null,
      }),
      writeSnapshot: jest.fn().mockResolvedValue(undefined),
      writeSyncState: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn(),
    };
    const maxClient = {
      getConfiguredWebhookSubscriptionTarget: jest.fn().mockImplementation((botId: string) => ({
        url: `https://maxim.play-team.ru/api/webhook/max/${botId}/secret-path`,
        maskedUrl: `https://maxim.play-team.ru/api/webhook/max/${botId}/***`,
      })),
      listWebhookSubscriptions: jest.fn().mockImplementation(({ botId }: { botId: string }) =>
        Promise.resolve([
          {
            url: `https://maxim.play-team.ru/api/webhook/max/${botId}/secret-path`,
            updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
          },
        ]),
      ),
      matchesConfiguredWebhookUrl: jest
        .fn()
        .mockImplementation(
          (url: string, botId: string) =>
            url === `https://maxim.play-team.ru/api/webhook/max/${botId}/secret-path`,
        ),
      deleteWebhookSubscription: jest.fn().mockResolvedValue(undefined),
      ensureWebhookSubscription: jest.fn().mockImplementation((updateTypes, { botId }) =>
        Promise.resolve({
          url: `https://maxim.play-team.ru/api/webhook/max/${botId}/secret-path`,
          updateTypes,
        }),
      ),
    };
    const service = new MaxWebhookSubscriptionReconcilerService(
      maxClient as never,
      botRegistry as never,
      statusService as never,
      createPrismaMock() as never,
      {
        get: jest.fn((key: string, fallback?: number | string) => {
          if (key === 'MAX_WEBHOOK_RECONCILE_INTERVAL_MS') {
            return 60_000;
          }
          if (key === 'MAX_WEBHOOK_STALE_INGRESS_MS') {
            return 10 * 60 * 1_000;
          }
          if (key === 'MAX_WEBHOOK_STALE_RECREATE_COOLDOWN_MS') {
            return 30 * 60 * 1_000;
          }
          return fallback;
        }),
      } as never,
    );

    await service.onModuleInit();

    expect(maxClient.deleteWebhookSubscription).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteWebhookSubscription).toHaveBeenCalledWith(
      'https://maxim.play-team.ru/api/webhook/max/stale_bot/secret-path',
      expect.objectContaining({ botId: 'stale_bot' }),
    );
    expect(maxClient.deleteWebhookSubscription).not.toHaveBeenCalledWith(
      'https://maxim.play-team.ru/api/webhook/max/fresh_bot/secret-path',
      expect.anything(),
    );
    expect(statusService.writeSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'warning',
        bots: expect.objectContaining({
          fresh_bot: expect.objectContaining({ status: 'healthy' }),
          stale_bot: expect.objectContaining({
            status: 'warning',
            note: expect.stringContaining('подписка была пересоздана автоматически'),
          }),
        }),
      }),
    );
    expect(statusService.writeSyncState).toHaveBeenCalledWith(
      expect.objectContaining({
        lastGlobalIncomingWebhookAt: freshAt,
      }),
    );

    await service.onModuleDestroy();
  });
});
