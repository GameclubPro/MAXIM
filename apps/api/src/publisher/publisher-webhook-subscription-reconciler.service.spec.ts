import { PublisherWebhookSubscriptionReconcilerService } from './publisher-webhook-subscription-reconciler.service';

describe('PublisherWebhookSubscriptionReconcilerService', () => {
  const previousRole = process.env.APP_ROLE;
  const previousServiceName = process.env.APP_SERVICE_NAME;

  beforeEach(() => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
  });

  afterAll(() => {
    if (previousRole === undefined) {
      delete process.env.APP_ROLE;
    } else {
      process.env.APP_ROLE = previousRole;
    }
    if (previousServiceName === undefined) {
      delete process.env.APP_SERVICE_NAME;
    } else {
      process.env.APP_SERVICE_NAME = previousServiceName;
    }
  });

  it('confirms the new publisher target before deleting only obsolete publisher-owned URLs', async () => {
    const currentUrl = 'https://major-maksimov.ru/api/webhook/max/publik_bot/current-secret';
    const oldUrl = 'https://major-maksimov.ru/api/webhook/max/publik_bot/old-secret';
    const unrelatedUrl = 'https://hooks.example.net/max/publik_bot';
    const required = [
      'message_created',
      'message_edited',
      'message_callback',
      'user_added',
      'user_removed',
      'bot_added',
      'bot_removed',
      'bot_started',
      'chat_title_changed',
      'message_removed',
      'bot_stopped',
      'dialog_removed',
    ];
    const old = { url: oldUrl, updateTypes: required };
    const current = { url: currentUrl, updateTypes: required };
    const unrelated = { url: unrelatedUrl, updateTypes: required };
    const maxClient = {
      getConfiguredWebhookSubscriptionTarget: jest.fn(() => ({
        url: currentUrl,
        maskedUrl: 'https://major-maksimov.ru/api/webhook/max/publik_bot/***',
      })),
      listWebhookSubscriptions: jest
        .fn()
        .mockResolvedValueOnce([old, unrelated])
        .mockResolvedValueOnce([current, old, unrelated])
        .mockResolvedValueOnce([current, unrelated]),
      matchesConfiguredWebhookUrl: jest.fn((url: string) => url === currentUrl),
      ensureWebhookSubscription: jest.fn(async () => current),
      deleteWebhookSubscription: jest.fn(async () => undefined),
    };
    const credentials = {
      getBotId: jest.fn(() => 'publik_bot'),
      getRequiredActionToken: jest.fn(() => 'not-a-real-token'),
    };
    const webhookCredentials = {
      getConfiguredCredential: jest.fn(() => ({
        botId: 'publik_bot',
        secretPath: 'current-secret',
        headerSecrets: ['not-a-real-secret'],
      })),
    };
    const dispatchHealth = {
      recordAuthenticatedSuccess: jest.fn(async () => undefined),
      recordGlobalAuthorizationFailure: jest.fn(async () => undefined),
    };
    const identityAttestation = {
      assertAttested: jest.fn(async () => undefined),
    };
    const config = {
      get: jest.fn((key: string, fallback: unknown) => {
        if (key === 'MAX_EXTENDED_WEBHOOK_LIFECYCLE_MODE') {
          return 'shadow';
        }
        return fallback;
      }),
    };
    const service = new PublisherWebhookSubscriptionReconcilerService(
      maxClient as never,
      credentials as never,
      webhookCredentials as never,
      identityAttestation as never,
      dispatchHealth as never,
      config as never,
    );

    await service.reconcile('startup');

    expect(maxClient.ensureWebhookSubscription).toHaveBeenCalledWith(
      expect.arrayContaining(['bot_added', 'bot_removed']),
      expect.objectContaining({ botId: 'publik_bot' }),
    );
    expect(maxClient.deleteWebhookSubscription).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteWebhookSubscription).toHaveBeenCalledWith(
      oldUrl,
      expect.objectContaining({ botId: 'publik_bot' }),
    );
    expect(dispatchHealth.recordAuthenticatedSuccess).toHaveBeenCalledTimes(1);
    expect(identityAttestation.assertAttested).toHaveBeenCalledTimes(1);
    expect(maxClient.ensureWebhookSubscription.mock.invocationCallOrder[0]).toBeLessThan(
      maxClient.deleteWebhookSubscription.mock.invocationCallOrder[0]!,
    );
    expect(maxClient.listWebhookSubscriptions.mock.invocationCallOrder[1]).toBeLessThan(
      maxClient.deleteWebhookSubscription.mock.invocationCallOrder[0]!,
    );
    expect(maxClient.listWebhookSubscriptions).toHaveBeenCalledTimes(3);

    maxClient.listWebhookSubscriptions.mockResolvedValue([current, unrelated]);
    await service.reconcile('scheduled');

    expect(maxClient.listWebhookSubscriptions).toHaveBeenCalledTimes(4);
    expect(maxClient.ensureWebhookSubscription).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteWebhookSubscription).toHaveBeenCalledTimes(1);
    expect(dispatchHealth.recordAuthenticatedSuccess).toHaveBeenCalledTimes(2);

    maxClient.listWebhookSubscriptions
      .mockResolvedValueOnce([current, old, unrelated])
      .mockResolvedValueOnce([current, unrelated]);
    await service.reconcile('scheduled');

    expect(maxClient.listWebhookSubscriptions).toHaveBeenCalledTimes(6);
    expect(maxClient.ensureWebhookSubscription).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteWebhookSubscription).toHaveBeenCalledTimes(2);
    expect(maxClient.deleteWebhookSubscription.mock.invocationCallOrder[1]).toBeLessThan(
      maxClient.listWebhookSubscriptions.mock.invocationCallOrder[5]!,
    );
    expect(dispatchHealth.recordAuthenticatedSuccess).toHaveBeenCalledTimes(3);
  });

  it.each([new Error('not attested'), { response: { status: 401 } }])(
    'does not inspect or mutate subscriptions before attestation even when failure reporting fails (%j)',
    async (attestationError) => {
      const maxClient = {
        getConfiguredWebhookSubscriptionTarget: jest.fn(),
        listWebhookSubscriptions: jest.fn(),
        ensureWebhookSubscription: jest.fn(),
        deleteWebhookSubscription: jest.fn(),
      };
      const credentials = {
        getBotId: jest.fn(() => 'publik_bot'),
        getRequiredActionToken: jest.fn(() => 'not-a-real-token'),
      };
      const webhookCredentials = {
        getConfiguredCredential: jest.fn(() => ({
          botId: 'publik_bot',
          secretPath: 'current-secret',
          headerSecrets: ['not-a-real-secret'],
        })),
      };
      const identityAttestation = {
        assertAttested: jest.fn().mockRejectedValue(attestationError),
      };
      const dispatchHealth = {
        recordAuthenticatedSuccess: jest.fn(),
        recordGlobalAuthorizationFailure: jest
          .fn()
          .mockRejectedValue(new Error('Redis unavailable')),
      };
      const config = { get: jest.fn((_key: string, fallback: unknown) => fallback) };
      const service = new PublisherWebhookSubscriptionReconcilerService(
        maxClient as never,
        credentials as never,
        webhookCredentials as never,
        identityAttestation as never,
        dispatchHealth as never,
        config as never,
      );

      await expect(service.reconcile('startup')).resolves.toBeUndefined();
      await expect(service.reconcile('scheduled')).resolves.toBeUndefined();

      expect(identityAttestation.assertAttested).toHaveBeenCalledTimes(2);
      expect(dispatchHealth.recordGlobalAuthorizationFailure).toHaveBeenCalledTimes(
        attestationError instanceof Error ? 0 : 2,
      );
      expect(maxClient.getConfiguredWebhookSubscriptionTarget).not.toHaveBeenCalled();
      expect(maxClient.listWebhookSubscriptions).not.toHaveBeenCalled();
      expect(maxClient.ensureWebhookSubscription).not.toHaveBeenCalled();
    },
  );
});
