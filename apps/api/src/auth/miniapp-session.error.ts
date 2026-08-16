import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

export type MiniappSessionErrorCode =
  | 'MINIAPP_SESSION_EXPIRED'
  | 'MINIAPP_SESSION_RATE_LIMITED'
  | 'MINIAPP_SESSION_UNAVAILABLE'
  | 'MINIAPP_CSRF_REJECTED'
  | 'MINIAPP_ORIGIN_REJECTED';

export class MiniappSessionExpiredException extends UnauthorizedException {
  readonly code = 'MINIAPP_SESSION_EXPIRED' as const;
  readonly retryable = false;
  readonly recovery = 'relaunch_miniapp' as const;

  constructor(message = 'Mini app session is missing or expired') {
    super({
      statusCode: HttpStatus.UNAUTHORIZED,
      error: 'Unauthorized',
      message,
      code: 'MINIAPP_SESSION_EXPIRED',
      retryable: false,
      recovery: 'relaunch_miniapp',
    });
  }
}

export class MiniappSessionUnavailableException extends ServiceUnavailableException {
  readonly code = 'MINIAPP_SESSION_UNAVAILABLE' as const;
  readonly retryable = true;
  readonly recovery = 'retry' as const;

  constructor() {
    super({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      error: 'Service Unavailable',
      message: 'Mini app session storage is temporarily unavailable',
      code: 'MINIAPP_SESSION_UNAVAILABLE',
      retryable: true,
      recovery: 'retry',
    });
  }
}

export class MiniappSessionRateLimitedException extends HttpException {
  readonly code = 'MINIAPP_SESSION_RATE_LIMITED' as const;
  readonly retryable = true;
  readonly recovery = 'retry' as const;

  constructor() {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message: 'Too many mini app session creation attempts',
        code: 'MINIAPP_SESSION_RATE_LIMITED',
        retryable: true,
        recovery: 'retry',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export class MiniappCsrfRejectedException extends ForbiddenException {
  readonly code = 'MINIAPP_CSRF_REJECTED' as const;
  readonly retryable = false;
  readonly recovery = 'refresh_session' as const;

  constructor(message = 'Mini app CSRF token is missing or invalid') {
    super({
      statusCode: HttpStatus.FORBIDDEN,
      error: 'Forbidden',
      message,
      code: 'MINIAPP_CSRF_REJECTED',
      retryable: false,
      recovery: 'refresh_session',
    });
  }
}

export class MiniappOriginRejectedException extends ForbiddenException {
  readonly code = 'MINIAPP_ORIGIN_REJECTED' as const;
  readonly retryable = false;
  readonly recovery = 'relaunch_miniapp' as const;

  constructor() {
    super({
      statusCode: HttpStatus.FORBIDDEN,
      error: 'Forbidden',
      message: 'Mini app request origin is not allowed',
      code: 'MINIAPP_ORIGIN_REJECTED',
      retryable: false,
      recovery: 'relaunch_miniapp',
    });
  }
}

export function isMiniappSessionError(
  error: unknown,
): error is
  | MiniappSessionExpiredException
  | MiniappSessionRateLimitedException
  | MiniappSessionUnavailableException
  | MiniappCsrfRejectedException
  | MiniappOriginRejectedException {
  return (
    error instanceof MiniappSessionExpiredException ||
    error instanceof MiniappSessionRateLimitedException ||
    error instanceof MiniappSessionUnavailableException ||
    error instanceof MiniappCsrfRejectedException ||
    error instanceof MiniappOriginRejectedException
  );
}
