import { BadRequestException } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { PublicationMetricsInterceptor } from './publication-metrics.interceptor';

function createContext(statusCode = 200, method = 'GET') {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method,
        routeOptions: { url: '/v1/publications/:publicationId' },
      }),
      getResponse: () => ({ statusCode }),
    }),
  } as never;
}

describe('PublicationMetricsInterceptor', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs a route template without request params or query values', async () => {
    const interceptor = new PublicationMetricsInterceptor();
    const log = jest.spyOn((interceptor as any).logger, 'log').mockImplementation(() => undefined);

    await lastValueFrom(interceptor.intercept(createContext(), { handle: () => of({ ok: true }) }));

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        route: '/v1/publications/:publicationId',
        method: 'GET',
        statusCode: 200,
        outcome: 'ok',
        requestCount: 1,
      }),
      'Publication request completed',
    );
  });

  it('aggregates successful GET polling at most once per route and status per minute', async () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const interceptor = new PublicationMetricsInterceptor();
    const log = jest.spyOn((interceptor as any).logger, 'log').mockImplementation(() => undefined);

    await lastValueFrom(interceptor.intercept(createContext(), { handle: () => of({ ok: true }) }));
    now = 2_000;
    await lastValueFrom(interceptor.intercept(createContext(), { handle: () => of({ ok: true }) }));

    expect(log).toHaveBeenCalledTimes(1);

    now = 61_001;
    await lastValueFrom(interceptor.intercept(createContext(), { handle: () => of({ ok: true }) }));

    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        route: '/v1/publications/:publicationId',
        statusCode: 200,
        requestCount: 2,
        windowMs: 60_001,
      }),
      'Publication request completed',
    );
  });

  it('logs successful mutations immediately', async () => {
    const interceptor = new PublicationMetricsInterceptor();
    const log = jest.spyOn((interceptor as any).logger, 'log').mockImplementation(() => undefined);

    await lastValueFrom(
      interceptor.intercept(createContext(200, 'POST'), { handle: () => of({ ok: true }) }),
    );
    await lastValueFrom(
      interceptor.intercept(createContext(200, 'POST'), { handle: () => of({ ok: true }) }),
    );

    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: 'POST', statusCode: 200, outcome: 'ok' }),
      'Publication request completed',
    );
  });

  it('uses the exception status before the reply is finalized', async () => {
    const interceptor = new PublicationMetricsInterceptor();
    const log = jest.spyOn((interceptor as any).logger, 'log').mockImplementation(() => undefined);

    await expect(
      lastValueFrom(
        interceptor.intercept(createContext(), {
          handle: () => throwError(() => new BadRequestException('invalid')),
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, outcome: 'client_error' }),
      'Publication request completed',
    );
  });

  it('classifies an unhandled error as an immediate server error', async () => {
    const interceptor = new PublicationMetricsInterceptor();
    const log = jest.spyOn((interceptor as any).logger, 'log').mockImplementation(() => undefined);

    await expect(
      lastValueFrom(
        interceptor.intercept(createContext(), {
          handle: () => throwError(() => new Error('database failed')),
        }),
      ),
    ).rejects.toThrow('database failed');

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500, outcome: 'server_error' }),
      'Publication request completed',
    );
  });
});
