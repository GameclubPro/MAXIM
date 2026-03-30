import { MaxWebhookSubscriptionReconcilerService } from './max-webhook-subscription-reconciler.service';
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

  it('repairs missing webhook update types and stores a healthy snapshot', async () => {
    process.env.APP_ROLE = 'ingress';

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
      statusService as never,
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
      { trafficClass: 'background' },
    );
    expect(statusService.writeSyncState).toHaveBeenCalledWith(
      expect.objectContaining({
        configuredUrl: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
      }),
    );
    expect(statusService.writeSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'healthy',
        configured: true,
        url: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/***',
        missingUpdateTypes: [],
        actualUpdateTypes: expect.arrayContaining([...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES]),
      }),
    );

    await service.onModuleDestroy();
  });

  it('stores a disabled snapshot when reconcile is not active on the current app role', async () => {
    process.env.APP_ROLE = 'admin';

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
      statusService as never,
      {
        get: jest.fn((_: string, fallback?: number) => fallback),
      } as never,
    );

    await service.onModuleInit();

    expect(maxClient.listWebhookSubscriptions).not.toHaveBeenCalled();
    expect(statusService.writeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'disabled',
        configured: false,
      }),
    );
  });

  it('recreates the current webhook subscription once when header secret rotation is pending', async () => {
    process.env.APP_ROLE = 'ingress';

    const statusService = {
      getSyncState: jest.fn().mockResolvedValue({
        configuredUrl: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
        headerSecretFingerprint: null,
        updatedAt: '2026-03-30T00:00:00.000Z',
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
      statusService as never,
      {
        get: jest.fn((key: string, fallback?: number | string) => {
          if (key === 'MAX_WEBHOOK_RECONCILE_INTERVAL_MS') {
            return 60_000;
          }
          if (key === 'MAX_WEBHOOK_HEADER_SECRET') {
            return 'secret-header-current';
          }
          if (key === 'MAX_WEBHOOK_HEADER_SECRET_PREVIOUS') {
            return 'secret-header-previous';
          }
          return fallback;
        }),
      } as never,
    );

    await service.onModuleInit();

    expect(maxClient.deleteWebhookSubscription).toHaveBeenCalledWith(
      'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
      { trafficClass: 'background' },
    );
    expect(maxClient.ensureWebhookSubscription).toHaveBeenCalledWith(
      [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      { trafficClass: 'background' },
    );
    expect(statusService.writeSyncState).toHaveBeenCalledWith(
      expect.objectContaining({
        configuredUrl: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
        headerSecretFingerprint: expect.any(String),
      }),
    );

    await service.onModuleDestroy();
  });
});
