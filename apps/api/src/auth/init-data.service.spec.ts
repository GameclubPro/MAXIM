import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { InitDataService } from './init-data.service';

const botToken = 'max-bot-token-test';
const previousBotToken = 'max-bot-token-previous-test';

function sign(params: URLSearchParams, token = botToken): string {
  const rows = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(token).digest();
  return createHmac('sha256', secretKey).update(rows).digest('hex');
}

function createConfigMock(
  previousToken?: string,
  overrides: Partial<Record<string, string | number>> = {},
): ConfigService {
  return {
    getOrThrow: jest.fn((key: string) => {
      const values: Record<string, string> = {
        MAX_BOT_TOKEN: botToken,
      };
      return values[key];
    }),
    get: jest.fn((key: string) => {
      if (key === 'MAX_BOT_TOKEN_PREVIOUS') {
        return previousToken;
      }
      if (key in overrides) {
        return overrides[key];
      }
      return undefined;
    }),
  } as unknown as ConfigService;
}

function captureUnauthorizedException(run: () => unknown): UnauthorizedException {
  try {
    run();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(UnauthorizedException);
    return error as UnauthorizedException;
  }

  throw new Error('Expected validation to throw UnauthorizedException');
}

describe('InitDataService', () => {
  function createRegistryMock(previousToken?: string) {
    const tokens = previousToken ? [botToken, previousBotToken] : [botToken];
    return {
      getAllBots: jest.fn().mockReturnValue([{ id: 'default-bot' }]),
      getValidationTokensForBot: jest.fn().mockReturnValue(tokens),
    };
  }

  it('validates correct init data', () => {
    const configService = createConfigMock();
    const service = new InitDataService(createRegistryMock() as never, configService);
    const params = new URLSearchParams();
    params.set(
      'user',
      JSON.stringify({
        id: '42',
        username: 'mod',
        photo_url: 'https://cdn.max.ru/u/42/avatar.jpg',
      }),
    );
    params.set('auth_date', String(Math.floor(Date.now() / 1000)));
    params.set('hash', sign(params));

    const user = service.validate(params.toString());
    expect(user.userId).toBe('42');
    expect(user.launchBotId).toBe('default-bot');
    expect(user.avatarUrl).toBe('https://cdn.max.ru/u/42/avatar.jpg');
  });

  it('builds display name from first and last name', () => {
    const configService = createConfigMock();
    const service = new InitDataService(createRegistryMock() as never, configService);
    const params = new URLSearchParams();
    params.set(
      'user',
      JSON.stringify({
        id: '42',
        username: 'mod',
        first_name: 'Анна',
        last_name: 'Каренина',
        name: 'Анна',
        nickname: 'Аня',
      }),
    );
    params.set('auth_date', String(Math.floor(Date.now() / 1000)));
    params.set('hash', sign(params));

    const user = service.validate(params.toString());
    expect(user.displayName).toBe('Анна Каренина');
  });

  it('extracts direct MAX profile url from user payload', () => {
    const configService = createConfigMock();
    const service = new InitDataService(createRegistryMock() as never, configService);
    const params = new URLSearchParams();
    params.set(
      'user',
      JSON.stringify({
        id: '42',
        url: 'https://max.ru/designer',
      }),
    );
    params.set('auth_date', String(Math.floor(Date.now() / 1000)));
    params.set('hash', sign(params));

    const user = service.validate(params.toString());
    expect(user.profileUrl).toBe('https://max.ru/designer');
  });

  it('throws on invalid hash', () => {
    const configService = createConfigMock();
    const service = new InitDataService(createRegistryMock() as never, configService);
    const params = new URLSearchParams();
    params.set('user', JSON.stringify({ id: '42' }));
    params.set('hash', 'bad-hash');

    const error = captureUnauthorizedException(() => service.validate(params.toString()));
    expect(error.getResponse()).toEqual({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Invalid init data signature',
      code: 'MINIAPP_AUTH_INVALID',
      retryable: false,
      recovery: 'relaunch_miniapp',
    });
  });

  it('returns a machine-readable error when init data is missing', () => {
    const service = new InitDataService(createRegistryMock() as never, createConfigMock());

    const error = captureUnauthorizedException(() => service.validate(''));
    expect(error.getResponse()).toEqual({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Init data is empty',
      code: 'MINIAPP_AUTH_MISSING',
      retryable: false,
      recovery: 'relaunch_miniapp',
    });
  });

  it('validates urlencoded payload', () => {
    const configService = createConfigMock();
    const service = new InitDataService(createRegistryMock() as never, configService);
    const params = new URLSearchParams();
    params.set('user', JSON.stringify({ id: '100' }));
    params.set('auth_date', String(Math.floor(Date.now() / 1000)));
    params.set('hash', sign(params));

    const encoded = encodeURIComponent(params.toString());
    const user = service.validate(encoded);
    expect(user.userId).toBe('100');
  });

  it('extracts chat context when chat payload is present', () => {
    const configService = createConfigMock();
    const service = new InitDataService(createRegistryMock() as never, configService);
    const params = new URLSearchParams();
    params.set('user', JSON.stringify({ id: '777' }));
    params.set('chat', JSON.stringify({ id: '152517912', title: 'MAXIM Chat', type: 'channel' }));
    params.set('auth_date', String(Math.floor(Date.now() / 1000)));
    params.set('hash', sign(params));

    const user = service.validate(params.toString());
    expect(user.userId).toBe('777');
    expect(user.chatId).toBe('152517912');
    expect(user.chatTitle).toBe('MAXIM Chat');
    expect(user.chatType).toBe('channel');
  });

  it('accepts init data wrapped as WebAppData from the MAX launch fragment', () => {
    const service = new InitDataService(createRegistryMock() as never, createConfigMock());
    const params = new URLSearchParams();
    params.set('user', JSON.stringify({ id: '701' }));
    params.set('auth_date', String(Math.floor(Date.now() / 1000)));
    params.set('hash', sign(params));

    const wrapped = `#WebAppData=${encodeURIComponent(params.toString())}&WebAppVersion=26.2.8`;
    const user = service.validate(wrapped);
    expect(user.userId).toBe('701');
  });

  it('accepts init data signed with the previous bot token', () => {
    const service = new InitDataService(
      createRegistryMock(previousBotToken) as never,
      createConfigMock(previousBotToken),
    );
    const params = new URLSearchParams();
    params.set('user', JSON.stringify({ id: '555' }));
    params.set('auth_date', String(Math.floor(Date.now() / 1000)));
    params.set('hash', sign(params, previousBotToken));

    const user = service.validate(params.toString());
    expect(user.userId).toBe('555');
    expect(user.launchBotId).toBe('default-bot');
  });

  it('attributes init data to the additional bot whose token signed it', () => {
    const additionalToken = 'max-additional-bot-token-test';
    const registry = {
      getAllBots: jest.fn().mockReturnValue([{ id: 'default-bot' }, { id: 'additional-bot' }]),
      getValidationTokensForBot: jest.fn((botId: string) =>
        botId === 'additional-bot' ? [additionalToken] : [botToken],
      ),
    };
    const service = new InitDataService(registry as never, createConfigMock());
    const params = new URLSearchParams();
    params.set('user', JSON.stringify({ id: '556' }));
    params.set('auth_date', String(Math.floor(Date.now() / 1000)));
    params.set('hash', sign(params, additionalToken));

    expect(service.validate(params.toString())).toMatchObject({
      userId: '556',
      launchBotId: 'additional-bot',
    });
  });

  it('accepts init data inside the default one-hour freshness window', () => {
    const service = new InitDataService(createRegistryMock() as never, createConfigMock());
    const params = new URLSearchParams();
    params.set('user', JSON.stringify({ id: '808' }));
    params.set('auth_date', String(Math.floor(Date.now() / 1000) - 3_590));
    params.set('hash', sign(params));

    const user = service.validate(params.toString());
    expect(user.userId).toBe('808');
  });

  it('rejects expired init data', () => {
    const service = new InitDataService(
      createRegistryMock() as never,
      createConfigMock(undefined, { INIT_DATA_MAX_AGE_SEC: 300 }),
    );
    const params = new URLSearchParams();
    params.set('user', JSON.stringify({ id: '42' }));
    params.set('auth_date', String(Math.floor(Date.now() / 1000) - 301));
    params.set('hash', sign(params));

    const error = captureUnauthorizedException(() => service.validate(params.toString()));
    expect(error.getResponse()).toEqual({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Init data has expired',
      code: 'MINIAPP_AUTH_EXPIRED',
      retryable: false,
      recovery: 'relaunch_miniapp',
    });
    expect(service.validateForSessionRecovery(params.toString())).toMatchObject({
      userId: '42',
      launchBotId: 'default-bot',
    });
  });

  it.each([
    {
      label: 'invalid signature',
      createPayload: () => {
        const params = new URLSearchParams({
          user: JSON.stringify({ id: '42' }),
          auth_date: String(Math.floor(Date.now() / 1_000) - 10_000),
          hash: '0'.repeat(64),
        });
        return params.toString();
      },
      message: 'Invalid init data signature',
    },
    {
      label: 'missing user',
      createPayload: () => {
        const params = new URLSearchParams({
          auth_date: String(Math.floor(Date.now() / 1_000) - 10_000),
        });
        params.set('hash', sign(params));
        return params.toString();
      },
      message: 'Missing user payload',
    },
    {
      label: 'missing auth date',
      createPayload: () => {
        const params = new URLSearchParams({ user: JSON.stringify({ id: '42' }) });
        params.set('hash', sign(params));
        return params.toString();
      },
      message: 'Missing auth_date in init data',
    },
    {
      label: 'future auth date',
      createPayload: () => {
        const params = new URLSearchParams({
          user: JSON.stringify({ id: '42' }),
          auth_date: String(Math.floor(Date.now() / 1_000) + 31),
        });
        params.set('hash', sign(params));
        return params.toString();
      },
      message: 'Init data auth_date is in the future',
    },
  ])('does not recover a session identity from $label', ({ createPayload, message }) => {
    const service = new InitDataService(createRegistryMock() as never, createConfigMock());
    expect(() => service.validateForSessionRecovery(createPayload())).toThrow(message);
  });

  it('returns clock recovery guidance for init data from the future', () => {
    const service = new InitDataService(createRegistryMock() as never, createConfigMock());
    const params = new URLSearchParams();
    params.set('user', JSON.stringify({ id: '42' }));
    params.set('auth_date', String(Math.floor(Date.now() / 1000) + 31));
    params.set('hash', sign(params));

    const error = captureUnauthorizedException(() => service.validate(params.toString()));
    expect(error.getResponse()).toEqual({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Init data auth_date is in the future',
      code: 'MINIAPP_AUTH_FUTURE',
      retryable: false,
      recovery: 'check_clock_and_relaunch',
    });
  });

  it('rejects duplicated launch parameters before signature verification', () => {
    const service = new InitDataService(createRegistryMock() as never, createConfigMock());
    const params = new URLSearchParams();
    params.set('user', JSON.stringify({ id: '42' }));
    params.set('auth_date', String(Math.floor(Date.now() / 1000)));
    params.set('hash', sign(params));

    const duplicated = `${params.toString()}&auth_date=${params.get('auth_date')}`;
    expect(() => service.validate(duplicated)).toThrow('Duplicate init data parameter: auth_date');
  });
});
