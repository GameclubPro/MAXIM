import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { InitDataService } from './init-data.service';

const secret = 'test-secret';

function sign(params: URLSearchParams): string {
  const rows = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  return createHmac('sha256', secret).update(rows).digest('hex');
}

describe('InitDataService', () => {
  const configService = {
    getOrThrow: jest.fn().mockReturnValue(secret),
  } as unknown as ConfigService;

  it('validates correct init data', () => {
    const service = new InitDataService(configService);
    const params = new URLSearchParams();
    params.set('user', JSON.stringify({ id: '42', username: 'mod' }));
    params.set('auth_date', '1700000000');
    params.set('hash', sign(params));

    const user = service.validate(params.toString());
    expect(user.userId).toBe('42');
  });

  it('throws on invalid hash', () => {
    const service = new InitDataService(configService);
    const params = new URLSearchParams();
    params.set('user', JSON.stringify({ id: '42' }));
    params.set('hash', 'bad-hash');

    expect(() => service.validate(params.toString())).toThrow(UnauthorizedException);
  });
});
