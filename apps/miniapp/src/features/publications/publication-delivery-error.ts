const PUBLICATION_DELIVERY_ERROR_FALLBACK = 'Не удалось доставить публикацию.';

const RATE_LIMIT_PATTERN =
  /rate[ _-]?limit|too many requests|ограничил(?:а|и)?\s+(?:запрос|отправ)|\b429\b/iu;
const TRANSIENT_PATTERN =
  /\b(?:timeout|timed out|etimedout|econn\w*|network error|socket hang up|service unavailable|temporarily unavailable)\b|тайм[ -]?аут/iu;
const ACCESS_PATTERN =
  /\b(?:unauthori[sz]ed|forbidden|access denied|permission denied|not an? admin)\b|\b(?:401|403)\b|нет (?:доступа|прав)|недостаточно прав/iu;
const MEDIA_PATTERN = /attachment[._ ]not[._ ]ready|media upload|content-length/iu;
const INTERNAL_CONTEXT_PATTERN =
  /\b(?:worker|prisma|redis|bullmq|sql|stack|exception|payload|webhook|database|circuit breaker|idempotenc\w*)\b|внутренн|техническ|служебн|ошибка сервера|база данных|стек|исключени/iu;
const TECHNICAL_PATTERN =
  /\b(?:api|worker|prisma|redis|bullmq|sql|stack|exception|statuscode|payload|webhook|request|response|axios|fetch|database|circuit breaker|idempotenc\w*)\b|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|\b(?:4\d\d|5\d\d)\b/iu;
const SENSITIVE_PATTERN =
  /\b(?:token|secret|password|authorization|cookie|init[ _-]?data|chat[ _-]?id|user[ _-]?id|message[ _-]?id|request[ _-]?id)\b|токен|секрет|парол|авторизац|идентификатор/iu;
const UNSAFE_SHAPE_PATTERN =
  /[{}[\]<>`]|https?:\/\/|www\.|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|(?:\d[\s-]*){6,}|(?:^|\s)at\s+\S+\s*\(|[\\/](?:usr|var|home|app|src|node_modules)[\\/]/iu;

export function formatPublicationDeliveryError(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    return null;
  }
  if (
    trimmed.length > 180 ||
    /[\r\n\t]/u.test(trimmed) ||
    INTERNAL_CONTEXT_PATTERN.test(trimmed) ||
    SENSITIVE_PATTERN.test(trimmed) ||
    UNSAFE_SHAPE_PATTERN.test(trimmed)
  ) {
    return PUBLICATION_DELIVERY_ERROR_FALLBACK;
  }
  if (RATE_LIMIT_PATTERN.test(trimmed)) {
    return 'MAX временно ограничил отправку.';
  }
  if (TRANSIENT_PATTERN.test(trimmed)) {
    return 'MAX временно не ответил.';
  }
  if (ACCESS_PATTERN.test(trimmed)) {
    return 'Нет доступа для отправки.';
  }
  if (MEDIA_PATTERN.test(trimmed)) {
    return 'Не удалось подготовить медиа.';
  }

  const normalized = trimmed.replace(/ {2,}/gu, ' ');
  const withoutMaxBrand = normalized.replace(/\bMAX\b/gu, '');
  if (
    !/[А-Яа-яЁё]/u.test(normalized) ||
    /[A-Za-z]/u.test(withoutMaxBrand) ||
    /\d{4,}/u.test(normalized) ||
    TECHNICAL_PATTERN.test(normalized) ||
    SENSITIVE_PATTERN.test(normalized)
  ) {
    return PUBLICATION_DELIVERY_ERROR_FALLBACK;
  }

  return normalized;
}
