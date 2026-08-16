import type { AuthUser } from '../common/decorators/current-user.decorator';
import { MiniappAuthException } from './miniapp-auth.error';
import { MINIAPP_SESSION_COOKIE_NAME } from './miniapp-session.constants';
import { MiniappSessionController } from './miniapp-session.controller';
import {
  MiniappCsrfRejectedException,
  MiniappSessionExpiredException,
} from './miniapp-session.error';

const TEST_USER: AuthUser = {
  userId: 'user-42',
  launchBotId: 'bot-main',
  username: null,
  displayName: 'Test User',
};
const TEST_NOW = Date.parse('2026-08-16T12:00:00.000Z');
const TEST_EXPIRES_AT = Date.parse('2026-08-16T20:00:00.000Z');
const TEST_EXPIRES_IN_SEC = 8 * 60 * 60;

function createRequest(sessionToken?: string) {
  return {
    headers: {},
    cookies: sessionToken ? { [MINIAPP_SESSION_COOKIE_NAME]: sessionToken } : {},
  };
}

function createReply() {
  return {
    setCookie: jest.fn(),
    clearCookie: jest.fn(),
    header: jest.fn(),
  };
}

function createController() {
  const initDataService = {
    validate: jest.fn().mockReturnValue(TEST_USER),
    validateForSessionRecovery: jest.fn().mockReturnValue(TEST_USER),
  };
  const sessionService = {
    create: jest.fn(),
    resolve: jest.fn(),
    refreshUser: jest.fn(),
    verifyCsrf: jest.fn(),
    destroy: jest.fn().mockResolvedValue(undefined),
    destroyResolved: jest.fn().mockResolvedValue(undefined),
  };
  const requestSecurity = {
    assertSessionRequestOrigin: jest.fn(),
  };
  const controller = new MiniappSessionController(
    initDataService as never,
    sessionService as never,
    requestSecurity as never,
  );
  return { controller, initDataService, sessionService, requestSecurity };
}

describe('MiniappSessionController', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(TEST_NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates a session and sets a host-only secure HttpOnly cookie', async () => {
    const { controller, initDataService, sessionService, requestSecurity } = createController();
    sessionService.create.mockResolvedValue({
      sessionToken: 's'.repeat(43),
      csrfToken: 'c'.repeat(43),
      expiresAt: TEST_EXPIRES_AT,
    });
    const request = createRequest('p'.repeat(43));
    const reply = createReply();

    await expect(
      controller.create('InitData signed-payload', request as never, reply as never),
    ).resolves.toEqual({
      authenticated: true,
      csrfToken: 'c'.repeat(43),
      expiresAt: '2026-08-16T20:00:00.000Z',
      expiresInSec: TEST_EXPIRES_IN_SEC,
    });

    expect(requestSecurity.assertSessionRequestOrigin).toHaveBeenCalledWith(request);
    expect(initDataService.validate).toHaveBeenCalledWith('signed-payload');
    expect(sessionService.create).toHaveBeenCalledWith(TEST_USER);
    expect(reply.setCookie).toHaveBeenCalledWith(MINIAPP_SESSION_COOKIE_NAME, 's'.repeat(43), {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      expires: new Date(TEST_EXPIRES_AT),
    });
    const cookieOptions = reply.setCookie.mock.calls[0]?.[2];
    expect(cookieOptions).not.toHaveProperty('domain');
    expect(sessionService.destroy).toHaveBeenCalledWith('p'.repeat(43));
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'no-store, private');
    expect(reply.header).toHaveBeenCalledWith('Pragma', 'no-cache');
  });

  it('reuses a valid cookie session and refreshes its user snapshot without rotation', async () => {
    const { controller, initDataService, sessionService } = createController();
    const existing = {
      keyHash: 'hash',
      record: {
        version: 1,
        createdAt: TEST_NOW,
        expiresAt: TEST_EXPIRES_AT,
        csrfToken: 'c'.repeat(43),
        user: TEST_USER,
      },
    };
    const refreshedUser = {
      ...TEST_USER,
      displayName: 'Updated User',
      chatId: 'chat-99',
      chatTitle: 'Updated Chat',
      chatType: 'chat' as const,
    };
    const refreshed = {
      ...existing,
      record: { ...existing.record, user: refreshedUser },
    };
    initDataService.validate.mockReturnValue(refreshedUser);
    sessionService.resolve.mockResolvedValue(existing);
    sessionService.refreshUser.mockResolvedValue(refreshed);
    const request = createRequest('s'.repeat(43));
    const reply = createReply();

    await expect(
      controller.create('InitData fresh-payload', request as never, reply as never),
    ).resolves.toEqual({
      authenticated: true,
      csrfToken: 'c'.repeat(43),
      expiresAt: '2026-08-16T20:00:00.000Z',
      expiresInSec: TEST_EXPIRES_IN_SEC,
    });

    expect(sessionService.refreshUser).toHaveBeenCalledWith(existing, refreshedUser);
    expect(sessionService.create).not.toHaveBeenCalled();
    expect(sessionService.destroy).not.toHaveBeenCalled();
    expect(reply.setCookie).not.toHaveBeenCalled();
  });

  it('recovers the same stable CSRF token without extending the absolute expiry', async () => {
    const { controller, initDataService, sessionService, requestSecurity } = createController();
    sessionService.resolve.mockResolvedValue({
      keyHash: 'hash',
      record: {
        version: 1,
        createdAt: TEST_NOW,
        expiresAt: TEST_EXPIRES_AT,
        csrfToken: 'n'.repeat(43),
        user: TEST_USER,
      },
    });
    const request = createRequest('s'.repeat(43));
    const reply = createReply();

    await expect(
      controller.recover('InitData expired-payload', request as never, reply as never),
    ).resolves.toEqual({
      authenticated: true,
      csrfToken: 'n'.repeat(43),
      expiresAt: '2026-08-16T20:00:00.000Z',
      expiresInSec: TEST_EXPIRES_IN_SEC,
    });

    expect(requestSecurity.assertSessionRequestOrigin).toHaveBeenCalledWith(request);
    expect(initDataService.validateForSessionRecovery).toHaveBeenCalledWith('expired-payload');
    expect(sessionService.resolve).toHaveBeenCalledWith('s'.repeat(43));
    expect(sessionService.create).not.toHaveBeenCalled();
    expect(reply.setCookie).not.toHaveBeenCalled();
    expect(reply.clearCookie).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'missing authorization',
      authorization: undefined,
      expectedKind: 'missing' as const,
    },
    {
      label: 'invalid authorization scheme',
      authorization: 'Bearer forged',
      expectedKind: 'invalid' as const,
    },
  ])(
    'rejects recovery with $label before reading the cookie session',
    async ({ authorization, expectedKind }) => {
      const { controller, sessionService } = createController();
      const reply = createReply();

      let error: MiniappAuthException | undefined;
      try {
        await controller.recover(
          authorization,
          createRequest('s'.repeat(43)) as never,
          reply as never,
        );
      } catch (caught: unknown) {
        error = caught as MiniappAuthException;
      }

      expect(error).toBeInstanceOf(MiniappAuthException);
      expect(error?.kind).toBe(expectedKind);
      expect(sessionService.resolve).not.toHaveBeenCalled();
      expect(reply.clearCookie).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid signed init data before reading the cookie session', async () => {
    const { controller, initDataService, sessionService } = createController();
    const invalid = new MiniappAuthException('invalid', 'Invalid init data signature');
    initDataService.validateForSessionRecovery.mockImplementation(() => {
      throw invalid;
    });

    await expect(
      controller.recover(
        'InitData forged-payload',
        createRequest('s'.repeat(43)) as never,
        createReply() as never,
      ),
    ).rejects.toBe(invalid);
    expect(sessionService.resolve).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'MAX user',
      recoveryUser: { ...TEST_USER, userId: 'other-user' },
    },
    {
      label: 'launch bot',
      recoveryUser: { ...TEST_USER, launchBotId: 'other-bot' },
    },
  ])(
    'clears the cookie and rejects recovery when the $label does not match',
    async ({ recoveryUser }) => {
      const { controller, initDataService, sessionService } = createController();
      initDataService.validateForSessionRecovery.mockReturnValue(recoveryUser);
      sessionService.resolve.mockResolvedValue({
        keyHash: 'hash',
        record: {
          version: 1,
          createdAt: TEST_NOW,
          expiresAt: TEST_EXPIRES_AT,
          csrfToken: 'c'.repeat(43),
          user: TEST_USER,
        },
      });
      const reply = createReply();

      await expect(
        controller.recover(
          'InitData expired-payload',
          createRequest('s'.repeat(43)) as never,
          reply as never,
        ),
      ).rejects.toMatchObject({
        message: 'Mini app session identity does not match',
      });

      expect(reply.clearCookie).toHaveBeenCalledWith(MINIAPP_SESSION_COOKIE_NAME, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
      });
      expect(sessionService.create).not.toHaveBeenCalled();
    },
  );

  it('clears an invalid cookie when recovery cannot resolve the session', async () => {
    const { controller, sessionService } = createController();
    sessionService.resolve.mockResolvedValue(null);
    const reply = createReply();

    await expect(
      controller.recover(
        'InitData expired-payload',
        createRequest('s'.repeat(43)) as never,
        reply as never,
      ),
    ).rejects.toBeInstanceOf(MiniappSessionExpiredException);

    expect(reply.clearCookie).toHaveBeenCalledWith(MINIAPP_SESSION_COOKIE_NAME, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
  });

  it('requires a valid CSRF token before deleting and clearing the session', async () => {
    const { controller, sessionService, requestSecurity } = createController();
    const session = {
      keyHash: 'hash',
      record: {
        version: 1 as const,
        createdAt: Date.parse('2026-08-16T12:00:00.000Z'),
        expiresAt: Date.parse('2026-08-16T20:00:00.000Z'),
        csrfToken: 'c'.repeat(43),
        user: TEST_USER,
      },
    };
    sessionService.resolve.mockResolvedValue(session);
    sessionService.verifyCsrf.mockReturnValue(true);
    const request = createRequest('s'.repeat(43));
    const reply = createReply();

    await expect(
      controller.destroy('c'.repeat(43), request as never, reply as never),
    ).resolves.toEqual({ authenticated: false });

    expect(requestSecurity.assertSessionRequestOrigin).toHaveBeenCalledWith(request);
    expect(sessionService.resolve).toHaveBeenCalledWith('s'.repeat(43));
    expect(sessionService.verifyCsrf).toHaveBeenCalledWith(session, 'c'.repeat(43));
    expect(sessionService.destroyResolved).toHaveBeenCalledWith('s'.repeat(43), session);
    expect(reply.clearCookie).toHaveBeenCalledWith(MINIAPP_SESSION_COOKIE_NAME, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'no-store, private');
    expect(reply.header).toHaveBeenCalledWith('Pragma', 'no-cache');
  });

  it('does not destroy or clear a session when CSRF verification fails', async () => {
    const { controller, sessionService } = createController();
    sessionService.resolve.mockResolvedValue({
      keyHash: 'hash',
      record: {
        version: 1,
        createdAt: 1,
        expiresAt: 2,
        csrfToken: 'c'.repeat(43),
        user: TEST_USER,
      },
    });
    sessionService.verifyCsrf.mockReturnValue(false);
    const reply = createReply();

    await expect(
      controller.destroy(undefined, createRequest('s'.repeat(43)) as never, reply as never),
    ).rejects.toBeInstanceOf(MiniappCsrfRejectedException);

    expect(sessionService.destroy).not.toHaveBeenCalled();
    expect(reply.clearCookie).not.toHaveBeenCalled();
  });
});
