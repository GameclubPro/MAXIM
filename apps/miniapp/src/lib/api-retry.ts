const TRANSIENT_CLIENT_STATUSES = new Set([408, 425, 429]);

export function getApiErrorStatus(error: unknown): number | null {
  if (!(error instanceof Error) || error.name !== 'ApiRequestError') {
    return null;
  }

  const status = (error as Error & { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : null;
}

export function isTransientHttpStatus(status: number): boolean {
  return TRANSIENT_CLIENT_STATUSES.has(status) || status >= 500;
}

export function isTerminalApiClientError(error: unknown): boolean {
  const status = getApiErrorStatus(error);
  return status !== null && status >= 400 && status < 500 && !isTransientHttpStatus(status);
}

export function isTransientApiError(error: unknown): boolean {
  const status = getApiErrorStatus(error);
  if (status !== null) {
    return isTransientHttpStatus(status);
  }

  return !(error instanceof Error && error.name === 'AbortError');
}

export function shouldRetryTransientApiError(
  failureCount: number,
  error: unknown,
  maxRetries = 1,
): boolean {
  const retryLimit = Math.max(0, Math.trunc(maxRetries));
  return failureCount < retryLimit && isTransientApiError(error);
}
