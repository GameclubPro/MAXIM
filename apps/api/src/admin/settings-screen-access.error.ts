import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { extractHttpStatusCode } from '../common/http-error.util';

export type SettingsScreenAccessErrorCode =
  | 'SETTINGS_ACCESS_BOT_DENIED'
  | 'SETTINGS_ACCESS_CHECK_UNAVAILABLE'
  | 'SETTINGS_ACCESS_USER_DENIED';
export type SettingsScreenAccessRecovery = 'recheck_bot_access' | 'retry' | 'return_to_entities';

export type ClassifiedSettingsScreenAccessError = {
  exception: ForbiddenException | ServiceUnavailableException;
  metric: {
    scope: 'settings_screen';
    code: SettingsScreenAccessErrorCode;
    retryable: boolean;
    recovery: SettingsScreenAccessRecovery;
  };
};

const BOT_ACCESS_DENIED_MESSAGE_FRAGMENT = 'бот больше не состоит';

export function classifySettingsScreenAccessError(
  error: unknown,
): ClassifiedSettingsScreenAccessError | null {
  const statusCode = extractHttpStatusCode(error);
  if (statusCode !== HttpStatus.FORBIDDEN && statusCode !== HttpStatus.SERVICE_UNAVAILABLE) {
    return null;
  }

  const message = readSafeHttpExceptionMessage(error, statusCode);
  if (statusCode === HttpStatus.SERVICE_UNAVAILABLE) {
    const metric = {
      scope: 'settings_screen',
      code: 'SETTINGS_ACCESS_CHECK_UNAVAILABLE',
      retryable: true,
      recovery: 'retry',
    } as const;
    return {
      exception: new ServiceUnavailableException({
        statusCode,
        error: 'Service Unavailable',
        message,
        code: metric.code,
        retryable: metric.retryable,
        recovery: metric.recovery,
      }),
      metric,
    };
  }

  const botDenied = message.toLowerCase().includes(BOT_ACCESS_DENIED_MESSAGE_FRAGMENT);
  const metric = botDenied
    ? ({
        scope: 'settings_screen',
        code: 'SETTINGS_ACCESS_BOT_DENIED',
        retryable: false,
        recovery: 'recheck_bot_access',
      } as const)
    : ({
        scope: 'settings_screen',
        code: 'SETTINGS_ACCESS_USER_DENIED',
        retryable: false,
        recovery: 'return_to_entities',
      } as const);

  return {
    exception: new ForbiddenException({
      statusCode,
      error: 'Forbidden',
      message,
      code: metric.code,
      retryable: metric.retryable,
      recovery: metric.recovery,
    }),
    metric,
  };
}

function readSafeHttpExceptionMessage(error: unknown, statusCode: number): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'string' && response.trim()) {
      return response.trim();
    }
    if (response && typeof response === 'object') {
      const message = (response as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) {
        return message.trim();
      }
    }
  }

  return statusCode === HttpStatus.FORBIDDEN
    ? 'Managed entity administrator access is required.'
    : 'Administrator access check is temporarily unavailable.';
}
