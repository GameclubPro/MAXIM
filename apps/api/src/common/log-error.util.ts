type UnknownRecord = Record<string, unknown>;

export type SanitizedLogError = {
  type: string;
  message: string;
  code?: string;
  status?: number;
  method?: string;
  url?: string;
  timeout?: number;
  stack?: string;
};

export function sanitizeErrorForLogs(error: unknown): SanitizedLogError {
  const record = asRecord(error);
  const config = asRecord(record?.config);
  const response = asRecord(record?.response);

  const type =
    readString(record?.name) ??
    readString(asRecord(record?.constructor)?.name) ??
    (error instanceof Error ? error.name : typeof error);
  const message = readString(record?.message) ?? String(error);

  const sanitized: SanitizedLogError = {
    type,
    message,
  };

  const code = readString(record?.code);
  if (code) {
    sanitized.code = code;
  }

  const responseStatus = readNumber(response?.status);
  if (responseStatus !== null) {
    sanitized.status = responseStatus;
  }

  const method = readString(config?.method);
  if (method) {
    sanitized.method = method.toUpperCase();
  }

  const url = readString(config?.url);
  if (url) {
    sanitized.url = stripQuery(url);
  }

  const timeout = readNumber(config?.timeout);
  if (timeout !== null) {
    sanitized.timeout = timeout;
  }

  const stack = readString(record?.stack);
  if (stack) {
    sanitized.stack = stack;
  }

  return sanitized;
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' ? (value as UnknownRecord) : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stripQuery(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    const queryIndex = value.indexOf('?');
    return queryIndex >= 0 ? value.slice(0, queryIndex) : value;
  }
}
