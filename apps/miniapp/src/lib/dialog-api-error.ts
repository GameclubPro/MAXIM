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
    normalized.includes('срок входа истёк') ||
    normalized.includes('init data has expired') ||
    normalized.includes('missing initdata authorization header') ||
    normalized.includes('invalid init data signature')
  );
}

export function isAccessDeniedApiMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes('доступ запрещ') ||
    normalized.includes('недостаточно прав') ||
    normalized.includes('forbidden')
  );
}

export function isTerminalDialogApiMessage(message: string): boolean {
  const normalized = message.trim();
  if (!normalized) {
    return false;
  }

  return (
    isSessionExpiredApiMessage(normalized) ||
    isAccessDeniedApiMessage(normalized) ||
    DIALOG_TERMINAL_ERROR_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}
