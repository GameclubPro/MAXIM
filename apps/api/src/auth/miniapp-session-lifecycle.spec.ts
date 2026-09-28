import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InitDataGuard } from './init-data.guard';
import { MiniappAuthException } from './miniapp-auth.error';
import { MiniappProfileForbiddenException } from './miniapp-profile.error';
import { MiniappProfileGuard } from './miniapp-profile.guard';

describe('Mini app lifecycle across authentication paths', () => {
  it.each(['active', 'draining', 'dormant', 'disabled'] as const)(
    'enforces %s for fresh, expired and cookie-only credentials',
    async (state) => {
      for (const source of ['fresh', 'expired', 'cookie'] as const) {
        const user = { userId: 'actor', launchBotId: 'main', username: null, displayName: null };
        const profile = new MiniappProfileGuard(new Reflector(), {
          getPublisherBotDescriptor: () => ({ id: 'publisher' }),
          getBotById: (id: string) => (id === 'main' ? { id, state } : null),
        } as never);
        const guard = new InitDataGuard(
          {
            validate: () => {
              if (source === 'expired')
                throw new MiniappAuthException('expired', 'Expired init data');
              return user;
            },
            validateForSessionRecovery: () => user,
          } as never,
          undefined,
          {
            resolve: async () => ({ keyHash: 'session', record: { user } }),
          } as never,
          undefined,
          profile,
        );
        const request = {
          method: 'GET',
          headers: source === 'cookie' ? {} : { authorization: 'InitData signed' },
          cookies: { '__Host-maxim_session': 'session' },
        };
        const context = {
          getHandler: () => () => undefined,
          getClass: () => class TestController {},
          switchToHttp: () => ({ getRequest: () => request }),
        } as unknown as ExecutionContext;
        if (state === 'disabled') {
          await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
            MiniappProfileForbiddenException,
          );
        } else {
          await expect(guard.canActivate(context)).resolves.toBe(true);
        }
      }
    },
  );
});
