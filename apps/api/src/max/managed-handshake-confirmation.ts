export const PUBLISHER_HANDSHAKE_CONFIRMATION_TEXT =
  'Готово. Чат или канал подключен к Публику и появился в мини-приложении.';

export function buildManagedHandshakeConfirmationText(
  entityType: 'chat' | 'channel',
  wasConnected: boolean,
): string {
  const entityLabel = entityType === 'channel' ? 'Канал' : 'Чат';
  return wasConnected
    ? `${entityLabel} уже подключен. Доступ обновлен.`
    : `Готово, ${entityLabel.toLowerCase()} подключен.`;
}

const confirmationTexts = new Set([
  PUBLISHER_HANDSHAKE_CONFIRMATION_TEXT,
  ...(['chat', 'channel'] as const).flatMap((entityType) => [
    buildManagedHandshakeConfirmationText(entityType, false),
    buildManagedHandshakeConfirmationText(entityType, true),
  ]),
]);

export function isManagedHandshakeConfirmationText(text: string): boolean {
  return confirmationTexts.has(text.trim());
}
