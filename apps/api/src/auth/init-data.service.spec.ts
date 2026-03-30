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

describe('InitDataService', () => {
  function createRegistryMock(previousToken?: string) {
    return {
      getValidationTokens: jest
        .fn()
        .mockReturnValue(
          previousToken ? [botToken, previousBotToken] : [botToken],
        ),
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
    expect(user.avatarUrl).toBe('https://cdn.max.ru/u/42/avatar.jpg');
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

    expect(() => service.validate(params.toString())).toThrow(UnauthorizedException);
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

    expect(() => service.validate(params.toString())).toThrow('Init data has expired');
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
