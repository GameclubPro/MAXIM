import type { ConfigService } from '@nestjs/config';
import { MiniappRequestSecurityService } from './miniapp-request-security.service';
import { MiniappOriginRejectedException } from './miniapp-session.error';

function createService(): MiniappRequestSecurityService {
  const config = {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'APP_BASE_URL') {
        return 'https://major-maksimov.ru/app/';
      }
      throw new Error(`Missing config key ${key}`);
    }),
  } as unknown as ConfigService;
  return new MiniappRequestSecurityService(config);
}

function createRequest(headers: Record<string, string | string[] | undefined>) {
  return { headers };
}

describe('MiniappRequestSecurityService', () => {
  it('allows only the exact configured origin for CORS', () => {
    const service = createService();

    expect(service.isCorsOriginAllowed(undefined)).toBe(true);
    expect(service.isCorsOriginAllowed('https://major-maksimov.ru')).toBe(true);
    expect(service.isCorsOriginAllowed('https://major-maksimov.ru/')).toBe(false);
  });

  it.each([
    'https://major-maksimov.ru.evil.test',
    'https://evil-major-maksimov.ru',
    'http://major-maksimov.ru',
    'https://major-maksimov.ru:444',
    'https://major-maksimov.ru@app.evil.test',
    'not-a-url',
  ])('rejects lookalike origin %s', (origin) => {
    const service = createService();

    expect(service.isCorsOriginAllowed(origin)).toBe(false);
    expect(() => service.assertSessionRequestOrigin(createRequest({ origin }) as never)).toThrow(
      MiniappOriginRejectedException,
    );
  });

  it('allows the exact Origin header and same-origin fetch metadata fallback', () => {
    const service = createService();

    expect(() =>
      service.assertSessionRequestOrigin(
        createRequest({ origin: ' https://major-maksimov.ru ' }) as never,
      ),
    ).not.toThrow();
    expect(() =>
      service.assertSessionRequestOrigin(
        createRequest({ 'sec-fetch-site': 'same-origin' }) as never,
      ),
    ).not.toThrow();
  });

  it('rejects cross-site fetch metadata when Origin is absent', () => {
    const service = createService();

    let error: MiniappOriginRejectedException | undefined;
    try {
      service.assertSessionRequestOrigin(
        createRequest({ 'sec-fetch-site': ['cross-site'] }) as never,
      );
    } catch (caught: unknown) {
      error = caught as MiniappOriginRejectedException;
    }

    expect(error).toBeInstanceOf(MiniappOriginRejectedException);
    expect(error?.getStatus()).toBe(403);
    expect(error?.getResponse()).toEqual({
      statusCode: 403,
      error: 'Forbidden',
      message: 'Mini app request origin is not allowed',
      code: 'MINIAPP_ORIGIN_REJECTED',
      retryable: false,
      recovery: 'relaunch_miniapp',
    });
  });
});
