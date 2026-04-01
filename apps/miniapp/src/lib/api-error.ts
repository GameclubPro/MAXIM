function looksLikeHtmlPayload(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.startsWith('<!doctype') ||
    normalized.startsWith('<html') ||
    normalized.startsWith('<head') ||
    normalized.startsWith('<body') ||
    /<\/?[a-z][\s\S]*>/i.test(normalized.slice(0, 256))
  );
}

function extractApiMessageFromJsonPayload(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // Ignore invalid JSON payloads and fall back to status-based formatting.
  }

  return null;
}

function formatStatusFallback(status: number): string {
  if (status === 401 || status === 403) {
    return 'Сессия истекла или доступ запрещён. Откройте мини-приложение заново.';
  }

  if (status === 404) {
    return 'Нужный ресурс не найден.';
  }

  if (status === 413) {
    return 'Файл слишком большой для сервера. Уменьшите размер и повторите.';
  }

  if (status === 429) {
    return 'Слишком много запросов. Повторите чуть позже.';
  }

  if (status === 502 || status === 503 || status === 504) {
    return 'Сервис временно недоступен. Повторите позже.';
  }

  if (status >= 500) {
    return 'Ошибка сервера. Повторите позже.';
  }

  return `Ошибка запроса (${status}).`;
}

const DIALOG_TERMINAL_ERROR_PATTERNS = [
  /^Комментарии для этого (чата|канала) сейчас закрыты\.$/u,
  /^Кнопка устарела\./u,
  /^Неверный токен кнопки\./u,
] as const;

export function isSessionExpiredApiMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes('сессия истекла') ||
    normalized.includes('доступ запрещ') ||
    normalized.includes('init data has expired') ||
    normalized.includes('missing initdata authorization header') ||
    normalized.includes('invalid init data signature')
  );
}

export function isTerminalDialogApiMessage(message: string): boolean {
  const normalized = message.trim();
  if (!normalized) {
    return false;
  }

  return (
    isSessionExpiredApiMessage(normalized) ||
    DIALOG_TERMINAL_ERROR_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

export function buildApiErrorMessage(
  status: number,
  payload: string,
  contentType: string | null = null,
): string {
  const trimmedPayload = payload.trim();
  const apiMessage = extractApiMessageFromJsonPayload(trimmedPayload);
  if (apiMessage) {
    return apiMessage;
  }

  if (status === 401 || status === 403) {
    return formatStatusFallback(status);
  }

  if (!trimmedPayload) {
    return formatStatusFallback(status);
  }

  const normalizedContentType = contentType?.toLowerCase() ?? null;
  const payloadIsHtml =
    normalizedContentType?.includes('text/html') || looksLikeHtmlPayload(trimmedPayload);

  if (payloadIsHtml || status >= 500) {
    return formatStatusFallback(status);
  }

  return trimmedPayload;
}

export function describeApiError(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (!message) {
      return fallback;
    }

    const match = message.match(/^API request failed:\s*(\d+)\s*([\s\S]*)$/i);
    if (match) {
      const status = Number.parseInt(match[1] ?? '', 10);
      const payload = match[2] ?? '';
      if (Number.isFinite(status)) {
        return buildApiErrorMessage(status, payload);
      }
    }

    return message;
  }

  return fallback;
}
