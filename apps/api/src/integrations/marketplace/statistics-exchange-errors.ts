import { HttpException } from '@nestjs/common';
import { isNativeError } from 'node:util/types';

export type ExchangeFailureCode =
  | 'ACCESS_DENIED'
  | 'REVISION_CONFLICT'
  | 'SNAPSHOT_EXPIRED'
  | 'THROTTLED'
  | 'TIMEOUT'
  | 'TRANSPORT'
  | 'REMOTE_UNAVAILABLE'
  | 'INVALID_PAYLOAD'
  | 'CHECKSUM_MISMATCH'
  | 'UNKNOWN';

export type ExchangeFailure = {
  code: ExchangeFailureCode;
  resetStaging: boolean;
  recheckAccess: boolean;
  retryAfterMs: number | null;
};

const MAX_RETRY_AFTER_MS = 86_400_000;
const MAX_RETRY_DELAY_MS = 300_000;

const protocolCodes = {
  EXCHANGE_ACCESS_DENIED: 'ACCESS_DENIED',
  EXCHANGE_REVISION_CONFLICT: 'REVISION_CONFLICT',
  EXCHANGE_REVISION_CHANGED: 'REVISION_CONFLICT',
  EXCHANGE_IDENTITY_MISMATCH: 'INVALID_PAYLOAD',
  EXCHANGE_DUPLICATE_ROW: 'INVALID_PAYLOAD',
  EXCHANGE_CURSOR_LOOP: 'INVALID_PAYLOAD',
  EXCHANGE_ROW_LIMIT: 'INVALID_PAYLOAD',
  EXCHANGE_METRIC_SCOPE_MISMATCH: 'INVALID_PAYLOAD',
  EXCHANGE_RESPONSE_LIMIT: 'INVALID_PAYLOAD',
  EXCHANGE_INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  EXCHANGE_CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
  EXCHANGE_DOWNLOAD_AUTHORITY_CHANGED: 'REVISION_CONFLICT',
  EXCHANGE_DOWNLOAD_CHANGED: 'REVISION_CONFLICT',
  EXCHANGE_DOWNLOAD_CURSOR_CHANGED: 'REVISION_CONFLICT',
  EXCHANGE_DOWNLOAD_LEASE_CHANGED: 'REVISION_CONFLICT',
  EXCHANGE_DOWNLOAD_LEASE_BUSY: 'REVISION_CONFLICT',
  EXCHANGE_AUTHORITY_CHECK_SUPERSEDED: 'REVISION_CONFLICT',
  EXCHANGE_DOWNLOAD_EXPIRED: 'SNAPSHOT_EXPIRED',
  EXCHANGE_PAGE_CONFLICT: 'REVISION_CONFLICT',
  EXCHANGE_PAGE_SEQUENCE: 'INVALID_PAYLOAD',
  EXCHANGE_DEADLINE: 'TIMEOUT',
  EXCHANGE_UNAVAILABLE: 'REMOTE_UNAVAILABLE',
  'Duplicate exchange measurement identity': 'INVALID_PAYLOAD',
  'Invalid exchange generation window': 'INVALID_PAYLOAD',
  'Invalid exchange measurement identity or interval': 'INVALID_PAYLOAD',
  'Invalid exchange audience observation': 'INVALID_PAYLOAD',
  'Invalid exchange timed views': 'INVALID_PAYLOAD',
  'Invalid exchange v3 page identity': 'INVALID_PAYLOAD',
  'Invalid exchange v3 metric scope': 'INVALID_PAYLOAD',
  'Invalid exchange v3 observation time': 'INVALID_PAYLOAD',
  'Invalid exchange v3 conditional identity': 'INVALID_PAYLOAD',
} as const satisfies Record<string, ExchangeFailureCode>;

type ExchangeProtocolDetail = keyof typeof protocolCodes;
type ExchangeProtocolCode =
  | 'ACCESS_DENIED'
  | 'REVISION_CONFLICT'
  | 'INVALID_PAYLOAD'
  | 'CHECKSUM_MISMATCH';

function boundedRetryAfter(milliseconds: number | null): number | null {
  return milliseconds !== null && Number.isFinite(milliseconds) && milliseconds >= 0
    ? Math.min(milliseconds, MAX_RETRY_AFTER_MS)
    : null;
}

// FLAG: Error messages and persisted classifications contain fixed operational codes, never peer bodies.
export class ExchangeResponseError extends Error {
  readonly retryAfterMs: number | null;
  constructor(
    readonly status: number,
    retryAfterMs: number | null = null,
  ) {
    super(
      `EXCHANGE_HTTP_${Number.isInteger(status) && status >= 100 && status <= 599 ? status : 'INVALID'}`,
    );
    this.retryAfterMs = boundedRetryAfter(retryAfterMs);
  }
}

export class ExchangeProtocolError extends Error {
  constructor(
    readonly code: ExchangeProtocolCode,
    detail?: ExchangeProtocolDetail,
  ) {
    super(detail && protocolCodes[detail] === code ? detail : `EXCHANGE_${code}`);
  }
}

export function exchangeRetryAfter(value: string | null, now = Date.now()): number | null {
  if (
    value === null ||
    value.length > 128 ||
    Buffer.byteLength(value, 'utf8') > 128 ||
    !Number.isFinite(now)
  )
    return null;
  const input = value.trim();
  const milliseconds = /^\d{1,10}$/u.test(input)
    ? Number(input) * 1000
    : /^[A-Za-z]{3},/u.test(input)
      ? Date.parse(input) - now
      : NaN;
  return boundedRetryAfter(milliseconds);
}

function httpFailureCode(status: number): ExchangeFailureCode {
  if (status === 401 || status === 403) return 'ACCESS_DENIED';
  if (status === 404 || status === 410) return 'SNAPSHOT_EXPIRED';
  if (status === 409 || status === 412) return 'REVISION_CONFLICT';
  if (status === 429) return 'THROTTLED';
  if (status >= 500 && status <= 599) return 'REMOTE_UNAVAILABLE';
  return 'INVALID_PAYLOAD';
}

function transportCode(error: Error): ExchangeFailureCode | null {
  const codes = [
    (error as Error & { code?: unknown }).code,
    error.cause && typeof error.cause === 'object'
      ? (error.cause as { code?: unknown }).code
      : undefined,
  ];
  if (
    codes.some(
      (code) =>
        typeof code === 'string' &&
        [
          'ETIMEDOUT',
          'UND_ERR_CONNECT_TIMEOUT',
          'UND_ERR_HEADERS_TIMEOUT',
          'UND_ERR_BODY_TIMEOUT',
        ].includes(code),
    )
  )
    return 'TIMEOUT';
  return codes.some(
    (code) =>
      typeof code === 'string' &&
      ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET'].includes(
        code,
      ),
  )
    ? 'TRANSPORT'
    : null;
}

export function classifyExchangeFailure(error: unknown): ExchangeFailure {
  let code: ExchangeFailureCode = 'UNKNOWN';
  let retryAfterMs: number | null = null;
  const supersededOwner =
    (error instanceof Error || isNativeError(error)) &&
    (error.message === 'EXCHANGE_DOWNLOAD_LEASE_CHANGED' ||
      error.message === 'EXCHANGE_DOWNLOAD_LEASE_BUSY' ||
      error.message === 'EXCHANGE_AUTHORITY_CHECK_SUPERSEDED');
  if (error instanceof ExchangeResponseError) {
    code = httpFailureCode(error.status);
    retryAfterMs = error.retryAfterMs;
  } else if (error instanceof ExchangeProtocolError) {
    code = error.code;
  } else if (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  ) {
    code = 'TIMEOUT';
  } else if (error instanceof Error || isNativeError(error)) {
    if (Object.hasOwn(protocolCodes, error.message)) {
      code = protocolCodes[error.message as ExchangeProtocolDetail];
    } else if (error instanceof HttpException) code = httpFailureCode(error.getStatus());
    else if (error.name === 'AbortError' || error.name === 'TimeoutError') code = 'TIMEOUT';
    else if (error.name === 'ZodError' || error.name === 'SyntaxError') code = 'INVALID_PAYLOAD';
    else code = transportCode(error) ?? (error.name === 'TypeError' ? 'TRANSPORT' : 'UNKNOWN');
  }
  return {
    code,
    resetStaging:
      !supersededOwner &&
      [
        'ACCESS_DENIED',
        'REVISION_CONFLICT',
        'SNAPSHOT_EXPIRED',
        'INVALID_PAYLOAD',
        'CHECKSUM_MISMATCH',
      ].includes(code),
    recheckAccess: !supersededOwner && (code === 'ACCESS_DENIED' || code === 'REVISION_CONFLICT'),
    retryAfterMs,
  };
}

export function exchangeRetryDelay(
  failure: ExchangeFailure,
  attempts: number,
  random = Math.random,
): number {
  const attempt = Number.isNaN(attempts) ? 1 : attempts;
  const exponent = Math.max(0, Math.min(6, Math.trunc(attempt) - 1));
  const base =
    failure.code === 'INVALID_PAYLOAD' || failure.code === 'CHECKSUM_MISMATCH'
      ? MAX_RETRY_DELAY_MS
      : Math.min(MAX_RETRY_DELAY_MS, 5000 * 2 ** exponent);
  const sample = random();
  const jitter = 0.75 + (Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5) * 0.5;
  return Math.max(
    Math.min(MAX_RETRY_DELAY_MS, Math.round(base * jitter)),
    boundedRetryAfter(failure.retryAfterMs) ?? 0,
  );
}
