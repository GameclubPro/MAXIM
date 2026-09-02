export const MAX_SEND_AUTO_DELETE_VERIFICATION_UNKNOWN_ERROR_CODE =
  'send_auto_delete_exact_verification_unknown';
export const MAX_SEND_AUTO_DELETE_VERIFICATION_ERROR_NAME = 'MaxSendAutoDeleteVerificationError';
export const MAX_SEND_AUTO_DELETE_VERIFICATION_ERROR_MESSAGE =
  'Could not verify sent bot message for auto-delete';

export const MAX_SEND_AUTO_DELETE_VERIFICATION_CAUSE_KINDS = [
  'access_ambiguous',
  'rate_limit',
  'upstream_5xx',
  'timeout',
  'transport',
  'http_other',
  'circuit_open',
  'unknown',
] as const;

export type MaxSendAutoDeleteVerificationCauseKind =
  (typeof MAX_SEND_AUTO_DELETE_VERIFICATION_CAUSE_KINDS)[number];

export type MaxSendAutoDeleteVerificationDiagnostic = Readonly<{
  kind: MaxSendAutoDeleteVerificationCauseKind;
  statusCode: number | null;
  errorCode: string | null;
}>;

export type MaxSendAutoDeleteVerificationError = Error & {
  code: typeof MAX_SEND_AUTO_DELETE_VERIFICATION_UNKNOWN_ERROR_CODE;
  maxSendAutoDeleteVerificationDiagnostic: MaxSendAutoDeleteVerificationDiagnostic;
};

const CAUSE_KIND_SET: ReadonlySet<string> = new Set(MAX_SEND_AUTO_DELETE_VERIFICATION_CAUSE_KINDS);
const BRANDED_VERIFICATION_ERRORS = new WeakSet<object>();
const TIMEOUT_ERROR_CODES: ReadonlySet<string> = new Set(['ECONNABORTED', 'ETIMEDOUT']);
const TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPROTO',
  'ERR_NETWORK',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);
const SAFE_MAX_ERROR_CODES: ReadonlySet<string> = new Set([
  'ACCESS.DENIED',
  'CHAT.DENIED',
  'CHAT.NOT.FOUND',
  'MESSAGE.NOT.FOUND',
  'RATE.LIMIT.EXCEEDED',
  'SERVER.FAILURE',
  'TOO.MANY.REQUESTS',
]);
const ACCESS_ERROR_CODES: ReadonlySet<string> = new Set([
  'ACCESS.DENIED',
  'CHAT.DENIED',
  'CHAT.NOT.FOUND',
  'MESSAGE.NOT.FOUND',
]);
const RATE_LIMIT_ERROR_CODES: ReadonlySet<string> = new Set([
  'MAX_API_INTERNAL_RATE_LIMIT',
  'RATE.LIMIT.EXCEEDED',
  'TOO.MANY.REQUESTS',
]);
const CIRCUIT_OPEN_ERROR_CODE = 'MAX_API_CIRCUIT_OPEN';

export function classifyMaxSendAutoDeleteVerificationCause(
  error: unknown,
): MaxSendAutoDeleteVerificationDiagnostic {
  const statusCode = readHttpStatusCode(error);
  const rawErrorCode = readErrorCode(error);
  const errorCode = allowlistedErrorCode(rawErrorCode);
  const kind = resolveCauseKind(statusCode, rawErrorCode);
  return Object.freeze({ kind, statusCode, errorCode });
}

export function createMaxSendAutoDeleteVerificationError(
  cause: unknown,
): MaxSendAutoDeleteVerificationError {
  const error = new Error(MAX_SEND_AUTO_DELETE_VERIFICATION_ERROR_MESSAGE, {
    cause,
  }) as MaxSendAutoDeleteVerificationError;
  error.name = MAX_SEND_AUTO_DELETE_VERIFICATION_ERROR_NAME;
  error.code = MAX_SEND_AUTO_DELETE_VERIFICATION_UNKNOWN_ERROR_CODE;
  error.maxSendAutoDeleteVerificationDiagnostic = classifyMaxSendAutoDeleteVerificationCause(cause);
  BRANDED_VERIFICATION_ERRORS.add(error);
  return error;
}

export function readMaxSendAutoDeleteVerificationDiagnostic(
  error: unknown,
): MaxSendAutoDeleteVerificationDiagnostic | null {
  if (
    !error ||
    typeof error !== 'object' ||
    !BRANDED_VERIFICATION_ERRORS.has(error) ||
    (error as { code?: unknown }).code !== MAX_SEND_AUTO_DELETE_VERIFICATION_UNKNOWN_ERROR_CODE
  ) {
    return null;
  }
  const candidate = (
    error as {
      maxSendAutoDeleteVerificationDiagnostic?: Partial<MaxSendAutoDeleteVerificationDiagnostic>;
    }
  ).maxSendAutoDeleteVerificationDiagnostic;
  if (
    !candidate ||
    typeof candidate.kind !== 'string' ||
    !CAUSE_KIND_SET.has(candidate.kind) ||
    !isNullableHttpStatus(candidate.statusCode) ||
    !isNullableAllowlistedErrorCode(candidate.errorCode)
  ) {
    return null;
  }
  return Object.freeze({
    kind: candidate.kind as MaxSendAutoDeleteVerificationCauseKind,
    statusCode: candidate.statusCode ?? null,
    errorCode: candidate.errorCode ?? null,
  });
}

export function buildMaxSendAutoDeleteVerificationLedgerErrorCode(
  diagnostic: MaxSendAutoDeleteVerificationDiagnostic,
): string {
  return `send_auto_delete_exact_verification_${diagnostic.kind}`;
}

export function buildMaxSendAutoDeleteVerificationLedgerErrorMessage(
  diagnostic: MaxSendAutoDeleteVerificationDiagnostic,
): string {
  return `Send-side auto-delete exact presence verification failed (${diagnostic.kind})`;
}

function resolveCauseKind(
  statusCode: number | null,
  rawErrorCode: string | null,
): MaxSendAutoDeleteVerificationCauseKind {
  if (rawErrorCode === CIRCUIT_OPEN_ERROR_CODE) {
    return 'circuit_open';
  }
  if (statusCode === 429 || (rawErrorCode && RATE_LIMIT_ERROR_CODES.has(rawErrorCode))) {
    return 'rate_limit';
  }
  if (
    statusCode === 403 ||
    statusCode === 404 ||
    (rawErrorCode && ACCESS_ERROR_CODES.has(rawErrorCode))
  ) {
    return 'access_ambiguous';
  }
  if (statusCode !== null && statusCode >= 500 && statusCode <= 599) {
    return 'upstream_5xx';
  }
  if (rawErrorCode && TIMEOUT_ERROR_CODES.has(rawErrorCode)) {
    return 'timeout';
  }
  if (rawErrorCode && TRANSPORT_ERROR_CODES.has(rawErrorCode)) {
    return 'transport';
  }
  if (statusCode !== null) {
    return 'http_other';
  }
  return 'unknown';
}

function readHttpStatusCode(error: unknown): number | null {
  const value = (error as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}

function readErrorCode(error: unknown): string | null {
  const responseCode = (error as { response?: { data?: { code?: unknown } } } | null)?.response
    ?.data?.code;
  const value =
    typeof responseCode === 'string' ? responseCode : (error as { code?: unknown } | null)?.code;
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 && normalized.length <= 80 ? normalized : null;
}

function allowlistedErrorCode(value: string | null): string | null {
  if (!value) {
    return null;
  }
  if (
    value === CIRCUIT_OPEN_ERROR_CODE ||
    value === 'MAX_API_INTERNAL_RATE_LIMIT' ||
    TIMEOUT_ERROR_CODES.has(value) ||
    TRANSPORT_ERROR_CODES.has(value) ||
    SAFE_MAX_ERROR_CODES.has(value)
  ) {
    return value.toLowerCase();
  }
  return null;
}

function isNullableHttpStatus(value: unknown): value is number | null | undefined {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599)
  );
}

function isNullableAllowlistedErrorCode(value: unknown): value is string | null | undefined {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && allowlistedErrorCode(value.toUpperCase()) === value)
  );
}
