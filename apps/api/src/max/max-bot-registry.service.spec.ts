import { ConfigService } from '@nestjs/config';
import { MaxBotRegistryService } from './max-bot-registry.service';
import { MAX_REQUIRED_WEBHOOK_UPDATE_TYPES } from './max-webhook-subscription.constants';

describe('MaxBotRegistryService webhook base URL', () => {
  function createService(overrides: Partial<Record<string, string>> = {}) {
    const values: Record<string, string> = {
      APP_BASE_URL: 'https://maxim.play-team.ru',
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
      url: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/secret-path',
      maskedUrl: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/***',
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
      url: 'https://maxim.play-team.ru/api/webhook/max/id613002203036_5_bot/rex-secret',
      maskedUrl: 'https://maxim.play-team.ru/api/webhook/max/id613002203036_5_bot/***',
    });
    expect(service.isKnownBotUserId('613002203036_5')).toBe(true);
  });

  it('keeps registry webhook requirements aligned with the shared subscription constants', () => {
    const service = createService();

    expect(service.getRequiredWebhookUpdateTypes()).toEqual([...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES]);
  });
});
