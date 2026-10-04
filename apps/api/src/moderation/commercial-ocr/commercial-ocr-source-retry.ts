import { isMaxApiCircuitOpenError } from '../../max/max-client.service';

const TIMEOUT_CODES = new Set([
  'ECONNABORTED',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** FLAG: A read can retry only an explicitly temporary transport failure, never an unknown error. */
export function resolveCommercialOcrSourceRetry(
  error: unknown,
  nowMs = Date.now(),
): { retryAfterMs?: number } | null {
  if (!error || typeof error !== 'object') return null;
  const row = error as {
    code?: unknown;
    response?: { status?: unknown; headers?: Record<string, unknown> };
    retryAfterMs?: unknown;
  };
  const status = row.response?.status;
  // Explicit access/missing errors take precedence even if a nested timeout code is present.
  if (status === 401 || status === 403 || status === 404 || status === 410) return null;
  const temporary =
    isMaxApiCircuitOpenError(error) ||
    row.code === 'MAX_API_INTERNAL_RATE_LIMIT' ||
    TIMEOUT_CODES.has(typeof row.code === 'string' ? row.code.toUpperCase() : '') ||
    status === 408 ||
    status === 429 ||
    (typeof status === 'number' && status >= 500 && status <= 599);
  if (!temporary) return null;
  const header = row.response?.headers?.['retry-after'];
  const seconds = typeof header === 'number' || typeof header === 'string' ? Number(header) : NaN;
  const headerMs =
    Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : typeof header === 'string'
        ? Date.parse(header) - nowMs
        : NaN;
  const localMs = typeof row.retryAfterMs === 'number' ? row.retryAfterMs : NaN;
  const delay = Math.max(
    Number.isFinite(headerMs) ? headerMs : 0,
    Number.isFinite(localMs) ? localMs : 0,
  );
  return delay > 0 ? { retryAfterMs: Math.min(600_000, Math.ceil(delay)) } : {};
}
