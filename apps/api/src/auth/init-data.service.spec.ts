import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { InitDataService } from './init-data.service';

const botToken = 'max-bot-token-test';

function sign(params: URLSearchParams): string {
  const rows = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return createHmac('sha256', secretKey).update(rows).digest('hex');
}

describe('InitDataService', () => {
  const configService = {
    getOrThrow: jest.fn((key: string) => {
      const values: Record<string, string> = {
        MAX_BOT_TOKEN: botToken,
      };
      return values[key];
    }),
  } as unknown as ConfigService;

  it('validates correct init data', () => {
    const service = new InitDataService(configService);
    const params = new URLSearchParams();
    params.set(
      'user',
      JSON.stringify({
        id: '42',
        username: 'mod',
        photo_url: 'https://cdn.max.ru/u/42/avatar.jpg',
      }),
    );
    params.set('auth_date', '1700000000');
    params.set('hash', sign(params));

    const user = service.validate(params.toString());
    expect(user.userId).toBe('42');
    expect(user.avatarUrl).toBe('https://cdn.max.ru/u/42/avatar.jpg');
  });

  it('throws on invalid hash', () => {
    const service = new InitDataService(configService);
    const params = new URLSearchParams();
    params.set('user', JSON.stringify({ id: '42' }));
    params.set('hash', 'bad-hash');

    expect(() => service.validate(params.toString())).toThrow(UnauthorizedException);
  });

  it('validates urlencoded payload', () => {
    const service = new InitDataService(configService);
    const params = new URLSearchParams();
    params.set('user', JSON.stringify({ id: '100' }));
    params.set('auth_date', '1700000001');
    params.set('hash', sign(params));

    const encoded = encodeURIComponent(params.toString());
    const user = service.validate(encoded);
    expect(user.userId).toBe('100');
  });

  it('extracts chat context when chat payload is present', () => {
    const service = new InitDataService(configService);
    const params = new URLSearchParams();
    params.set('user', JSON.stringify({ id: '777' }));
    params.set('chat', JSON.stringify({ id: '152517912', title: 'MAXIM Chat' }));
    params.set('auth_date', '1700000002');
    params.set('hash', sign(params));

    const user = service.validate(params.toString());
    expect(user.userId).toBe('777');
    expect(user.chatId).toBe('152517912');
    expect(user.chatTitle).toBe('MAXIM Chat');
  });
});
