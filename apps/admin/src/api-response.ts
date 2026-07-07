const INVALID_JSON_RESPONSE_MESSAGE = 'Safety Desk API недоступен или вернул некорректный ответ.';

function isJsonContentType(contentType: string | null): boolean {
  return Boolean(contentType && /(?:^|[/+])json(?:$|[;\s])/iu.test(contentType));
}

function shouldParseJsonPayload(text: string, contentType: string | null): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }

  if (isJsonContentType(contentType)) {
    return true;
  }

  return !contentType && /^[{[]/u.test(trimmed);
}

export async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const contentType = response.headers.get('content-type');
  const shouldParseJson = shouldParseJsonPayload(text, contentType);

  if (!response.ok) {
    const payload = shouldParseJson ? tryParseJsonPayload(text) : null;
    throw new Error(readApiErrorMessage(payload, response.status));
  }

  if (!text.trim()) {
    return null;
  }

  if (!shouldParseJson) {
    throw new Error(INVALID_JSON_RESPONSE_MESSAGE);
  }

  return parseJsonPayload(text);
}

export function readApiErrorMessage(payload: unknown, status: number): string {
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>;
    const message = formatApiErrorValue(record.message);
    if (message) {
      return message;
    }

    const error = formatApiErrorValue(record.error);
    if (error) {
      return error;
    }
  }

  return `Ошибка API: ${status}`;
}

function formatApiErrorValue(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value.map(formatApiErrorValue).filter(Boolean).join('; ');
  }

  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>)
      .map(formatApiErrorValue)
      .filter(Boolean)
      .join('; ');
  }

  return '';
}

function parseJsonPayload(text: string): unknown {
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(INVALID_JSON_RESPONSE_MESSAGE);
  }
}

function tryParseJsonPayload(text: string): unknown {
  try {
    return parseJsonPayload(text);
  } catch {
    return null;
  }
}
