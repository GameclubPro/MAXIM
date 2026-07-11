import { ConfigService } from '@nestjs/config';
import { MaxBotRegistryService } from './max-bot-registry.service';
import { MAX_REQUIRED_WEBHOOK_UPDATE_TYPES } from './max-webhook-subscription.constants';

describe('MaxBotRegistryService webhook base URL', () => {
  function createService(overrides: Partial<Record<string, string>> = {}) {
    const values: Record<string, string> = {
      APP_BASE_URL: 'https://major-maksimov.ru',
      MAX_BOT_ID: '777000_bot',
      MAX_BOT_TOKEN: 'token-1234567890',
      MAX_WEBHOOK_SECRET_PATH: 'secret-path',
      MAX_WEBHOOK_HEADER_SECRET: 'header-secret',
      ...overrides,
    };

    const configService = {
      get: jest.fn((key: string) => values[key]),
      getOrThrow: jest.fn((key: string) => {
        const value = values[key];
        if (typeof value !== 'string') {
          throw new Error(`Missing config ${key}`);
        }
        return value;
      }),
    } satisfies Partial<ConfigService>;

    return new MaxBotRegistryService(configService as unknown as ConfigService);
  }

  it('uses APP_BASE_URL for webhook subscriptions by default', () => {
    const service = createService();

    expect(service.getConfiguredWebhookSubscriptionTarget('777000_bot')).toEqual({
      url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
      maskedUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/***',
    });
  });

  it('uses MAX_WEBHOOK_BASE_URL when it is configured', () => {
    const service = createService({
      MAX_WEBHOOK_BASE_URL: 'https://hook.maxim.play-team.ru',
    });

    expect(service.getConfiguredWebhookSubscriptionTarget('777000_bot')).toEqual({
      url: 'https://hook.maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
      maskedUrl: 'https://hook.maxim.play-team.ru/api/webhook/max/777000_bot/***',
    });
  });

  it('registers a third active bot with its own webhook target and validation token', () => {
    const service = createService({
      MAX_BOTS_JSON: JSON.stringify([
        {
          id: 'id613002203036_4_bot',
          label: 'Майор Максимова',
          characterName: 'Майор Максимова',
          speechPersona: 'female',
          token: 'token-secondary-123456',
          webhookSecretPath: 'secondary-secret',
          webhookHeaderSecret: 'secondary-header',
          state: 'active',
        },
        {
          id: 'id613002203036_5_bot',
          label: 'Рэкс',
          characterName: 'Рэкс',
          speechPersona: 'male',
          token: 'token-rex-123456',
          webhookSecretPath: 'rex-secret',
          webhookHeaderSecret: 'rex-header',
          state: 'active',
        },
      ]),
    });

    expect(service.getAllBots().map((bot) => bot.id)).toEqual([
      '777000_bot',
      'id613002203036_4_bot',
      'id613002203036_5_bot',
    ]);
    expect(service.getOperationalBots().map((bot) => bot.id)).toContain('id613002203036_5_bot');
    expect(service.getValidationTokensForBot('id613002203036_5_bot')).toEqual(['token-rex-123456']);
    expect(service.getConfiguredWebhookSubscriptionTarget('id613002203036_5_bot')).toEqual({
      url: 'https://major-maksimov.ru/api/webhook/max/id613002203036_5_bot/rex-secret',
      maskedUrl: 'https://major-maksimov.ru/api/webhook/max/id613002203036_5_bot/***',
    });
    expect(service.isKnownBotUserId('613002203036_5')).toBe(true);
  });

  it('treats explicit bot contact ids as protected bot user ids', () => {
    const service = createService({
      MAX_BOTS_JSON: JSON.stringify([
        {
          id: 'custom-secondary-bot',
          contactId: '700000000001',
          token: 'token-secondary-123456',
          webhookSecretPath: 'secondary-secret',
          webhookHeaderSecret: 'secondary-header',
          state: 'active',
        },
      ]),
    });

    expect(service.isKnownBotUserId('700000000001')).toBe(true);
  });

  it('resolves id, numeric suffix, and contact ids to canonical bot ids', () => {
    const service = createService({
      MAX_BOT_ID: 'id613002203036_bot',
      MAX_BOT_CONTACT_ID: '214634782',
      MAX_BOTS_JSON: JSON.stringify([
        {
          id: 'id613002203036_4_bot',
          contactId: '214634783',
          token: 'token-secondary-123456',
          webhookSecretPath: 'secondary-secret',
          webhookHeaderSecret: 'secondary-header',
          state: 'active',
        },
      ]),
    });

    expect(service.resolveBotIdFromUserId('id613002203036_4_bot')).toBe('id613002203036_4_bot');
    expect(service.resolveBotIdFromUserId('613002203036_4')).toBe('id613002203036_4_bot');
    expect(service.resolveBotIdFromUserId(214634783)).toBe('id613002203036_4_bot');
    expect(service.resolveBotIdFromUserId('214634782')).toBe('id613002203036_bot');
  });

  it('fails startup when bot contact identities are ambiguous', () => {
    expect(() =>
      createService({
        MAX_BOT_ID: 'id613002203036_bot',
        MAX_BOT_CONTACT_ID: '214634782',
        MAX_BOTS_JSON: JSON.stringify([
          {
            id: 'custom-secondary-bot',
            contactId: '214634782',
            token: 'token-secondary-123456',
            webhookSecretPath: 'secondary-secret',
            webhookHeaderSecret: 'secondary-header',
            state: 'active',
          },
        ]),
      }),
    ).toThrow(/contact identity must be unique/u);
  });

  it('accepts dormant bot tokens for init data without making them operational', () => {
    const service = createService({
      MAX_BOTS_JSON: JSON.stringify([
        {
          id: 'id613070470872_5_bot',
          label: 'Майор Максимова',
          token: 'token-majorova-123456',
          webhookSecretPath: 'majorova-secret',
          webhookHeaderSecret: 'majorova-header',
          state: 'dormant',
        },
        {
          id: 'id613070470872_6_bot',
          label: 'Рэкс',
          token: 'token-rex-123456',
          webhookSecretPath: 'rex-secret',
          webhookHeaderSecret: 'rex-header',
          state: 'dormant',
        },
        {
          id: 'disabled-helper-bot',
          token: 'token-disabled-123456',
          webhookSecretPath: 'disabled-secret',
          webhookHeaderSecret: 'disabled-header',
          state: 'disabled',
        },
      ]),
    });

    expect(service.getOperationalBots().map((bot) => bot.id)).toEqual(['777000_bot']);
    expect(service.getValidationTokens()).toEqual([
      'token-1234567890',
      'token-majorova-123456',
      'token-rex-123456',
    ]);
    expect(service.getValidationTokensForBot('id613070470872_5_bot')).toEqual([
      'token-majorova-123456',
    ]);
    expect(service.getValidationTokensForBot('id613070470872_6_bot')).toEqual(['token-rex-123456']);
    expect(service.getValidationTokensForBot('disabled-helper-bot')).toEqual([]);
    expect(service.getConfiguredWebhookSubscriptionTarget('id613070470872_6_bot')).toEqual({
      url: null,
      maskedUrl: null,
    });
  });

  it('keeps registry webhook requirements aligned with the shared subscription constants', () => {
    const service = createService();

    expect(service.getRequiredWebhookUpdateTypes()).toEqual([...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES]);
  });

  it('uses the first active additional bot as entry when the default bot is draining', () => {
    const service = createService({
      MAX_BOT_STATE: 'draining',
      MAX_BOTS_JSON: JSON.stringify([
        {
          id: 'active-entry-bot',
          token: 'token-entry-123456',
          webhookSecretPath: 'entry-secret-path',
          webhookHeaderSecret: 'entry-header-secret',
          state: 'active',
          ownershipWeight: 3,
        },
      ]),
    });

    expect(service.getDefaultBot()).toMatchObject({ state: 'draining', ownershipWeight: 1 });
    expect(service.getEntryBot()).toMatchObject({ id: 'active-entry-bot', ownershipWeight: 3 });
  });

  it('fails startup when an explicitly configured entry bot is not active', () => {
    expect(() =>
      createService({
        MAX_ENTRY_BOT_ID: 'draining-entry-bot',
        MAX_BOTS_JSON: JSON.stringify([
          {
            id: 'draining-entry-bot',
            token: 'token-entry-123456',
            webhookSecretPath: 'entry-secret-path',
            webhookHeaderSecret: 'entry-header-secret',
            state: 'draining',
          },
        ]),
      }),
    ).toThrow(/must reference an active bot/u);
  });
});
