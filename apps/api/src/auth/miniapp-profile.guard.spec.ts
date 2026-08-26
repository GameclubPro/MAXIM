import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MiniappProfileForbiddenException } from './miniapp-profile.error';
import { MINIAPP_PROFILES_METADATA } from './miniapp-profile';
import { MiniappProfileGuard } from './miniapp-profile.guard';

function createContext(
  request: Record<string, unknown>,
  handler = () => undefined,
  controller: new () => unknown = class TestController {},
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function createGuard() {
  return new MiniappProfileGuard(new Reflector(), {
    getPublisherBotDescriptor: () => ({ id: 'publik-bot', label: 'Публик', kind: 'publisher' }),
    getBotById: (botId: string) => (botId === 'main-bot' ? { id: botId } : null),
  } as never);
}

describe('MiniappProfileGuard', () => {
  it('allows a main-bot launch on default moderation surfaces', () => {
    const request = { user: { launchBotId: 'main-bot' } };
    expect(createGuard().canActivate(createContext(request))).toBe(true);
    expect(request).toMatchObject({ miniappProfile: 'moderation' });
  });

  it('denies a publisher launch on an unannotated surface', () => {
    const request = { user: { launchBotId: 'publik-bot' } };
    expect(() => createGuard().canActivate(createContext(request))).toThrow(
      MiniappProfileForbiddenException,
    );
  });

  it('allows publisher only when the handler opts in', () => {
    const handler = () => undefined;
    Reflect.defineMetadata(MINIAPP_PROFILES_METADATA, ['moderation', 'publisher'], handler);
    const request = { user: { launchBotId: 'publik-bot' } };

    expect(createGuard().canActivate(createContext(request, handler))).toBe(true);
    expect(request).toMatchObject({ miniappProfile: 'publisher' });
  });

  it('lets handler-level moderation narrowing override a both-profile controller', () => {
    class PublisherController {}
    const updatePolicy = () => undefined;
    Reflect.defineMetadata(
      MINIAPP_PROFILES_METADATA,
      ['moderation', 'publisher'],
      PublisherController,
    );
    Reflect.defineMetadata(MINIAPP_PROFILES_METADATA, ['moderation'], updatePolicy);

    expect(() =>
      createGuard().canActivate(
        createContext(
          { user: { launchBotId: 'publik-bot' } },
          updatePolicy,
          PublisherController,
        ),
      ),
    ).toThrow(MiniappProfileForbiddenException);
    const moderationRequest = { user: { launchBotId: 'main-bot' } };
    expect(
      createGuard().canActivate(
        createContext(moderationRequest, updatePolicy, PublisherController),
      ),
    ).toBe(true);
    expect(moderationRequest).toMatchObject({ miniappProfile: 'moderation' });
  });

  it('fails closed for an unknown launch bot', () => {
    const handler = () => undefined;
    Reflect.defineMetadata(MINIAPP_PROFILES_METADATA, ['moderation', 'publisher'], handler);
    expect(() =>
      createGuard().canActivate(createContext({ user: { launchBotId: 'unknown-bot' } }, handler)),
    ).toThrow(MiniappProfileForbiddenException);
  });
});
