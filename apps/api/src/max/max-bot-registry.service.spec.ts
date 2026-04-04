import { ConfigService } from '@nestjs/config';
import { MaxBotRegistryService } from './max-bot-registry.service';

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
});
