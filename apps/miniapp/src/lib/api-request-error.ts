const MAX_STRUCTURED_API_ERROR_PAYLOAD_LENGTH = 64_000;
const MAX_STRUCTURED_API_ERROR_PAYLOAD_DEPTH = 8;
const SENSITIVE_API_ERROR_PAYLOAD_KEY =
  /^(?:authorization|cookie|set-cookie|password|secret|signature|token|access[_-]?token|refresh[_-]?token|api[_-]?key|init[_-]?data|stack|trace)$/iu;
const UNSAFE_API_ERROR_PAYLOAD_KEY = /^(?:__proto__|constructor|prototype)$/u;
const API_ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

export type ApiErrorPayloadValue =
  | string
  | number
  | boolean
  | null
  | readonly ApiErrorPayloadValue[]
  | ApiErrorPayload;

export interface ApiErrorPayload {
  readonly [key: string]: ApiErrorPayloadValue;
}

function isApiErrorPayload(value: ApiErrorPayloadValue | undefined): value is ApiErrorPayload {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sanitizeApiErrorPayloadValue(
  value: unknown,
  depth: number,
): ApiErrorPayloadValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (depth >= MAX_STRUCTURED_API_ERROR_PAYLOAD_DEPTH) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const items = value
      .map((item) => sanitizeApiErrorPayloadValue(item, depth + 1))
      .filter((item): item is ApiErrorPayloadValue => item !== undefined);
    return Object.freeze(items);
  }

  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const safe: Record<string, ApiErrorPayloadValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_API_ERROR_PAYLOAD_KEY.test(key) || SENSITIVE_API_ERROR_PAYLOAD_KEY.test(key)) {
      continue;
    }

    const sanitized = sanitizeApiErrorPayloadValue(item, depth + 1);
    if (sanitized !== undefined) {
      safe[key] = sanitized;
    }
  }

  return Object.freeze(safe);
}

export function parseApiErrorPayload(payload: string): ApiErrorPayload | null {
  const trimmedPayload = payload.trim();
  if (!trimmedPayload || trimmedPayload.length > MAX_STRUCTURED_API_ERROR_PAYLOAD_LENGTH) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmedPayload) as unknown;
    const sanitized = sanitizeApiErrorPayloadValue(parsed, 0);
    if (!isApiErrorPayload(sanitized)) {
      return null;
    }

    return sanitized;
  } catch {
    return null;
  }
}

function extractApiErrorCode(payload: ApiErrorPayload | null): string | null {
  const code = payload?.code;
  if (typeof code !== 'string') {
    return null;
  }

  const normalized = code.trim();
  return API_ERROR_CODE_PATTERN.test(normalized) ? normalized : null;
}

function constrainServerErrorPayload(
  status: number,
  payload: ApiErrorPayload | null,
): ApiErrorPayload | null {
  if (!payload) {
    return null;
  }

  const safe: Record<string, ApiErrorPayloadValue> = {
    statusCode: status,
  };
  const code = extractApiErrorCode(payload);
  if (code) {
    safe.code = code;
  }
  if (typeof payload.retryable === 'boolean') {
    safe.retryable = payload.retryable;
  }
  return Object.freeze(safe);
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly payload: ApiErrorPayload | null;

  constructor(status: number, payload: string, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    const parsedPayload = parseApiErrorPayload(payload);
    this.payload =
      status >= 500 ? constrainServerErrorPayload(status, parsedPayload) : parsedPayload;
    this.code = extractApiErrorCode(this.payload);
  }
}

export function createApiRequestError(
  status: number,
  payload: string,
  message: string,
): ApiRequestError {
  return new ApiRequestError(status, payload, message);
}
