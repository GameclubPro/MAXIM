import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { SafetyDeskAdminGuard } from './safety-desk-admin.guard';

function createContext(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

function createGuard(
  options: { accessCode?: string; allowedHosts?: string; nodeEnv?: string } = {},
) {
  return new SafetyDeskAdminGuard({
    get: jest.fn((key: string) => {
      if (key === 'SAFETY_DESK_ALLOWED_HOSTS') {
        return options.allowedHosts;
      }

      if (key === 'NODE_ENV') {
        return options.nodeEnv ?? 'production';
      }

      if (key === 'ADMIN_ACCESS_CODE') {
        return options.accessCode ?? 'server-admin-code';
      }

      return undefined;
    }),
  } as never);
}

function createAdminHeaders(host = 'admin.major-maksimov.ru') {
  return {
    host,
    'x-forwarded-host': host,
    'x-remote-user': 'owner',
    'x-admin-access-code': 'server-admin-code',
  };
}

describe('SafetyDeskAdminGuard', () => {
  it('allows the closed admin host', () => {
    const guard = createGuard({ allowedHosts: 'admin.major-maksimov.ru' });

    expect(guard.canActivate(createContext(createAdminHeaders()))).toBe(true);
  });

  it('allows the closed admin host with a same-origin Origin header', () => {
    const guard = createGuard({ allowedHosts: 'admin.major-maksimov.ru' });

    expect(
      guard.canActivate(
        createContext({
          ...createAdminHeaders(),
          origin: 'https://admin.major-maksimov.ru',
          'sec-fetch-site': 'same-origin',
        }),
      ),
    ).toBe(true);
  });

  it('rejects the closed admin host with a cross-origin Origin header', () => {
    const guard = createGuard({ allowedHosts: 'admin.major-maksimov.ru' });

    expect(() =>
      guard.canActivate(
        createContext({
          ...createAdminHeaders(),
          origin: 'https://evil.test',
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects the closed admin host with cross-site fetch metadata', () => {
    const guard = createGuard({ allowedHosts: 'admin.major-maksimov.ru' });

    expect(() =>
      guard.canActivate(
        createContext({
          ...createAdminHeaders(),
          origin: 'https://admin.major-maksimov.ru',
          'sec-fetch-site': 'cross-site',
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects non-https production admin origins', () => {
    const guard = createGuard({ allowedHosts: 'admin.major-maksimov.ru' });

    expect(() =>
      guard.canActivate(
        createContext({
          ...createAdminHeaders(),
          origin: 'http://admin.major-maksimov.ru',
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects the public app host', () => {
    const guard = createGuard({ allowedHosts: 'admin.major-maksimov.ru' });

    expect(() => guard.canActivate(createContext(createAdminHeaders('major-maksimov.ru')))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects production localhost when allowed hosts are not explicitly configured', () => {
    const guard = createGuard();

    expect(() => guard.canActivate(createContext(createAdminHeaders('localhost')))).toThrow(
      ForbiddenException,
    );
    expect(() => guard.canActivate(createContext(createAdminHeaders('127.0.0.1')))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects production admin host without the Basic Auth remote user header', () => {
    const guard = createGuard({ allowedHosts: 'admin.major-maksimov.ru' });

    expect(() =>
      guard.canActivate(
        createContext({
          host: 'admin.major-maksimov.ru',
          'x-forwarded-host': 'admin.major-maksimov.ru',
          'x-admin-access-code': 'server-admin-code',
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects mismatched production host and forwarded host headers', () => {
    const guard = createGuard({ allowedHosts: 'admin.major-maksimov.ru' });

    expect(() =>
      guard.canActivate(
        createContext({
          host: 'major-maksimov.ru',
          'x-forwarded-host': 'admin.major-maksimov.ru',
          'x-remote-user': 'owner',
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('allows localhost in non-production for local development', () => {
    const guard = createGuard({ accessCode: '', nodeEnv: 'development' });

    expect(
      guard.canActivate(
        createContext({ host: 'localhost:3002', 'x-admin-access-code': 'maxim-local' }),
      ),
    ).toBe(true);
    expect(
      guard.canActivate(
        createContext({ host: '[::1]:3002', 'x-admin-access-code': 'maxim-local' }),
      ),
    ).toBe(true);
  });

  it('allows explicitly configured production hosts with admin proxy headers', () => {
    const guard = createGuard({ allowedHosts: 'admin.major-maksimov.ru,localhost' });

    expect(guard.canActivate(createContext(createAdminHeaders('localhost')))).toBe(true);
  });

  it('rejects explicitly configured production hosts without admin proxy headers', () => {
    const guard = createGuard({ allowedHosts: 'admin.major-maksimov.ru,localhost' });

    expect(() => guard.canActivate(createContext({ host: 'localhost' }))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects a missing or incorrect server-side access code', () => {
    const guard = createGuard({ accessCode: 'expected-admin-code' });

    expect(() =>
      guard.canActivate(
        createContext({
          ...createAdminHeaders(),
          'x-admin-access-code': 'incorrect-admin-code',
        }),
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      guard.canActivate(
        createContext({
          host: 'admin.major-maksimov.ru',
          'x-forwarded-host': 'admin.major-maksimov.ru',
          'x-remote-user': 'owner',
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('fails closed when the production access code is missing or left at its placeholder', () => {
    for (const accessCode of ['', 'change-me', 'replace-with-random-admin-code']) {
      const guard = createGuard({ accessCode });
      expect(() => guard.canActivate(createContext(createAdminHeaders()))).toThrow(
        ForbiddenException,
      );
    }
  });
});
