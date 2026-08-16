import type { ArgumentsHost } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { SanitizedExceptionFilter } from './sanitized-exception.filter';

describe('SanitizedExceptionFilter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs the route template without raw query credentials', () => {
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const response = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          url: '/api/v1/channels/42/dialog?token=signed-dialog-token',
          routeOptions: { url: '/api/v1/channels/:chatId/dialog' },
        }),
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;

    new SanitizedExceptionFilter().catch(new Error('database unavailable'), host);

    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: '/api/v1/channels/:chatId/dialog',
      }),
      'Unhandled HTTP exception',
    );
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain('signed-dialog-token');
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.send).toHaveBeenCalledWith({
      statusCode: 500,
      message: 'Internal server error',
    });
  });

  it('strips the query when route metadata is unavailable', () => {
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const response = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          url: '/api/v1/_mutation-tunnel?body=encoded-secret',
        }),
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;

    new SanitizedExceptionFilter().catch(new Error('tunnel failure'), host);

    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/api/v1/_mutation-tunnel' }),
      'Unhandled HTTP exception',
    );
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain('encoded-secret');
  });
});
