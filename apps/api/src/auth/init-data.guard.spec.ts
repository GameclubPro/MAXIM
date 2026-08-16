import type { ExecutionContext } from '@nestjs/common';
import { InitDataGuard } from './init-data.guard';
import { MiniappAuthException } from './miniapp-auth.error';
import {
  MiniappCsrfRejectedException,
  MiniappSessionExpiredException,
} from './miniapp-session.error';

type RequestMock = {
  headers: Record<string, string>;
  cookies?: Record<string, string>;
  method?: string;
  url?: string;
  routeOptions?: { url: string };
  user?: unknown;
  miniappAuth?: unknown;
};

function createContext(request: RequestMock): ExecutionContext {
  request.method ??= 'GET';
  request.url ??= '/api/v1/me';
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('InitDataGuard', () => {
  it('returns a machine-readable error and records only its classification when auth is missing', async () => {
    const initDataService = { validate: jest.fn() };
    const accessObservability = { recordRejection: jest.fn() };
    const guard = new InitDataGuard(initDataService as never, accessObservability as never);

    const rejected = await guard
      .canActivate(createContext({ headers: {} }))
      .catch((error: unknown) => error as MiniappAuthException);

    expect(rejected).toBeInstanceOf(MiniappAuthException);
    expect((rejected as MiniappAuthException).getResponse()).toEqual({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Missing InitData authorization header',
      code: 'MINIAPP_AUTH_MISSING',
      retryable: false,
      recovery: 'relaunch_miniapp',
    });
    expect(accessObservability.recordRejection).toHaveBeenCalledWith({
      scope: 'auth',
      code: 'MINIAPP_AUTH_MISSING',
      retryable: false,
      recovery: 'relaunch_miniapp',
    });
    expect(initDataService.validate).not.toHaveBeenCalled();
  });

  it('attaches a validated user without recording a rejection', async () => {
    const validatedUser = { userId: '42' };
    const initDataService = { validate: jest.fn().mockReturnValue(validatedUser) };
    const accessObservability = { recordRejection: jest.fn() };
    const guard = new InitDataGuard(initDataService as never, accessObservability as never);
    const request = { headers: { authorization: 'InitData signed-payload' }, user: undefined };

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(initDataService.validate).toHaveBeenCalledWith('signed-payload');
    expect(request.user).toBe(validatedUser);
    expect(accessObservability.recordRejection).not.toHaveBeenCalled();
  });

  it('records classified validation failures without logging init data', async () => {
    const sourceError = new MiniappAuthException('expired', 'Init data has expired');
    const initDataService = {
      validate: jest.fn(() => {
        throw sourceError;
      }),
      validateForSessionRecovery: jest.fn().mockReturnValue({
        userId: '42',
        launchBotId: 'bot-main',
        username: null,
        displayName: null,
      }),
    };
    const accessObservability = { recordRejection: jest.fn() };
    const guard = new InitDataGuard(initDataService as never, accessObservability as never);

    await expect(
      guard.canActivate(createContext({ headers: { authorization: 'InitData secret-init-data' } })),
    ).rejects.toBe(sourceError);
    expect(accessObservability.recordRejection).toHaveBeenCalledWith({
      scope: 'auth',
      code: 'MINIAPP_AUTH_EXPIRED',
      retryable: false,
      recovery: 'relaunch_miniapp',
    });
  });

  it('falls back to a matching server session only when init data has expired', async () => {
    const expired = new MiniappAuthException('expired', 'Init data has expired');
    const expiredInitDataUser = {
      userId: '42',
      launchBotId: 'bot-main',
      username: null,
      displayName: null,
      chatId: 'current-chat',
      chatTitle: 'Current chat',
      chatType: 'chat' as const,
    };
    const sessionUser = {
      userId: '42',
      launchBotId: 'bot-main',
      username: null,
      displayName: null,
      chatId: 'other-chat',
      chatTitle: 'Other chat',
      chatType: 'chat' as const,
    };
    const initDataService = {
      validate: jest.fn(() => {
        throw expired;
      }),
      validateForSessionRecovery: jest.fn().mockReturnValue(expiredInitDataUser),
    };
    const session = {
      keyHash: 'session-key-hash',
      record: {
        version: 1,
        createdAt: Date.now() - 1_000,
        expiresAt: Date.now() + 60_000,
        csrfToken: 'a'.repeat(43),
        user: sessionUser,
      },
    };
    const sessionService = {
      resolve: jest.fn().mockResolvedValue(session),
      verifyCsrf: jest.fn().mockReturnValue(true),
    };
    const requestSecurity = { assertSessionRequestOrigin: jest.fn() };
    const guard = new InitDataGuard(
      initDataService as never,
      undefined,
      sessionService as never,
      requestSecurity as never,
    );
    const request: RequestMock = {
      headers: { authorization: 'InitData expired-payload' },
      cookies: { '__Host-maxim_session': 's'.repeat(43) },
    };

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.user).toBe(expiredInitDataUser);
    expect(request.miniappAuth).toMatchObject({
      source: 'session',
      principalKey: 'session-key-hash',
    });
    expect(requestSecurity.assertSessionRequestOrigin).toHaveBeenCalled();
    expect(initDataService.validateForSessionRecovery).toHaveBeenCalledWith('expired-payload');
  });

  it.each([
    {
      label: 'MAX user',
      recoveryUser: {
        userId: 'other-user',
        launchBotId: 'bot-main',
        username: null,
        displayName: null,
      },
    },
    {
      label: 'launch bot',
      recoveryUser: {
        userId: '42',
        launchBotId: 'other-bot',
        username: null,
        displayName: null,
      },
    },
  ])(
    'rejects an expired credential whose $label differs from the cookie session',
    async ({ recoveryUser }) => {
      const expired = new MiniappAuthException('expired', 'Init data has expired');
      const sessionService = {
        resolve: jest.fn().mockResolvedValue({
          keyHash: 'session-key-hash',
          record: {
            version: 1,
            createdAt: Date.now() - 1_000,
            expiresAt: Date.now() + 60_000,
            csrfToken: 'a'.repeat(43),
            user: {
              userId: '42',
              launchBotId: 'bot-main',
              username: null,
              displayName: null,
            },
          },
        }),
        verifyCsrf: jest.fn(),
      };
      const requestSecurity = { assertSessionRequestOrigin: jest.fn() };
      const guard = new InitDataGuard(
        {
          validate: jest.fn(() => {
            throw expired;
          }),
          validateForSessionRecovery: jest.fn().mockReturnValue(recoveryUser),
        } as never,
        undefined,
        sessionService as never,
        requestSecurity as never,
      );
      const request: RequestMock = {
        headers: { authorization: 'InitData expired-payload' },
        cookies: { '__Host-maxim_session': 's'.repeat(43) },
      };

      await expect(guard.canActivate(createContext(request))).rejects.toBeInstanceOf(
        MiniappSessionExpiredException,
      );
      expect(request.user).toBeUndefined();
      expect(sessionService.verifyCsrf).not.toHaveBeenCalled();
      expect(requestSecurity.assertSessionRequestOrigin).not.toHaveBeenCalled();
    },
  );

  it('does not hide an invalid init data signature behind an existing session', async () => {
    const invalid = new MiniappAuthException('invalid', 'Invalid init data signature');
    const initDataService = {
      validate: jest.fn(() => {
        throw invalid;
      }),
    };
    const sessionService = { resolve: jest.fn() };
    const guard = new InitDataGuard(
      initDataService as never,
      undefined,
      sessionService as never,
      undefined,
    );

    await expect(
      guard.canActivate(
        createContext({
          headers: { authorization: 'InitData forged-payload' },
          cookies: { '__Host-maxim_session': 's'.repeat(43) },
        }),
      ),
    ).rejects.toBe(invalid);
    expect(sessionService.resolve).not.toHaveBeenCalled();
  });

  it.each([
    { method: 'POST', url: '/api/v1/chats/1/settings' },
    {
      method: 'GET',
      url: '/api/v1/_mutation-tunnel?method=PUT',
      routeUrl: '/api/v1/_mutation-tunnel',
    },
    {
      method: 'GET',
      url: '/api/v1/_mutation%2Dtunnel?method=PUT',
      routeUrl: '/api/v1/_mutation-tunnel',
    },
    {
      method: 'GET',
      url: '/api/v1/%5Fmutation-tunnel?method=PUT',
      routeUrl: '/api/v1/_mutation-tunnel',
    },
  ])(
    'requires CSRF for a session-authenticated $method request to $url',
    async ({ method, url, routeUrl }) => {
      const session = {
        keyHash: 'session-key-hash',
        record: {
          version: 1,
          createdAt: Date.now() - 1_000,
          expiresAt: Date.now() + 60_000,
          csrfToken: 'a'.repeat(43),
          user: { userId: '42', username: null, displayName: null },
        },
      };
      const sessionService = {
        resolve: jest.fn().mockResolvedValue(session),
        verifyCsrf: jest.fn().mockReturnValue(false),
      };
      const guard = new InitDataGuard(
        { validate: jest.fn() } as never,
        undefined,
        sessionService as never,
        { assertSessionRequestOrigin: jest.fn() } as never,
      );

      await expect(
        guard.canActivate(
          createContext({
            headers: {},
            cookies: { '__Host-maxim_session': 's'.repeat(43) },
            method,
            url,
            routeOptions: routeUrl ? { url: routeUrl } : undefined,
          }),
        ),
      ).rejects.toBeInstanceOf(MiniappCsrfRejectedException);
    },
  );

  it('prefers fresh init data over an old cookie session', async () => {
    const freshUser = { userId: 'new-user' };
    const sessionService = { resolve: jest.fn() };
    const request: RequestMock = {
      headers: { authorization: 'InitData fresh-payload' },
      cookies: { '__Host-maxim_session': 's'.repeat(43) },
    };
    const guard = new InitDataGuard(
      { validate: jest.fn().mockReturnValue(freshUser) } as never,
      undefined,
      sessionService as never,
      undefined,
    );

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.user).toBe(freshUser);
    expect(request.miniappAuth).toMatchObject({ source: 'init_data' });
    expect(sessionService.resolve).not.toHaveBeenCalled();
  });
});
