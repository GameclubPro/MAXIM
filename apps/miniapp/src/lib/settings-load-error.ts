import { ApiRequestError } from './api-request-error';
import { getApiErrorStatus } from './api-retry';

export type SettingsLoadErrorKind =
  | 'auth-expired'
  | 'auth-relaunch'
  | 'access-denied'
  | 'retryable';

const MINIAPP_RELAUNCH_ERROR_CODES = new Set(['MINIAPP_ORIGIN_REJECTED', 'MINIAPP_CSRF_REJECTED']);

export function findTerminalSettingsLoadError(...errors: unknown[]): unknown | undefined {
  return errors.find((error) => {
    const status = getApiErrorStatus(error);
    return status === 401 || status === 403;
  });
}

export function resolveSettingsLoadErrorKind(error: unknown): SettingsLoadErrorKind {
  if (
    error instanceof ApiRequestError &&
    error.code !== null &&
    MINIAPP_RELAUNCH_ERROR_CODES.has(error.code)
  ) {
    return 'auth-relaunch';
  }

  const status = getApiErrorStatus(error);
  if (status === 401) {
    return 'auth-expired';
  }
  if (status === 403) {
    return 'access-denied';
  }
  return 'retryable';
}
