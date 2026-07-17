import { describeApiError, isSessionExpiredApiMessage } from './api-error';

const TECHNICAL_ERROR_PATTERN =
  /\b(?:api|rps|p95|worker|rollback|dry[- ]?run|prisma|redis|bullmq|sql|stack|exception|statuscode|payload|webhook|token|uuid|econn\w*|etimedout|invalid|failed)\b|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[{}[\]<>]|[\r\n]/iu;

export function describeUserFacingError(error: unknown, fallback: string): string {
  const message = describeApiError(error, fallback).trim();

  if (!message || message === fallback) {
    return fallback;
  }

  if (isSessionExpiredApiMessage(message)) {
    return 'Сессия истекла или доступ запрещён. Откройте мини-приложение заново.';
  }

  if (/rate[ _-]?limit|too many requests|\b429\b/iu.test(message)) {
    return 'Слишком много запросов. Повторите позже.';
  }

  if (/network(?:error)?|failed to fetch|load failed|timeout|timed out|econn/iu.test(message)) {
    return 'Нет соединения. Повторите.';
  }

  if (message.includes('BROADCAST_TARGET_SLOT_CONFLICT')) {
    return 'Выбранное время занято у одного из получателей.';
  }

  if (message.includes('BROADCAST_SLOT_CONFLICT')) {
    return 'Выбранное время уже занято.';
  }

  if (
    message.length > 220 ||
    !/[А-Яа-яЁё]/u.test(message) ||
    TECHNICAL_ERROR_PATTERN.test(message)
  ) {
    return fallback;
  }

  return message;
}
