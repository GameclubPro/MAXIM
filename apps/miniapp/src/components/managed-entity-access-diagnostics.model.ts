import type { ManagedEntityAccessDiagnostics } from '@maxim/contracts/managed-entities';

export function formatManagedEntityAccessLossHeadline(
  diagnostics: Pick<ManagedEntityAccessDiagnostics, 'activeBotCount' | 'lostBots'>,
  entityLabel: 'чат' | 'канал',
): string {
  const lostBotLabel = formatBotCount(diagnostics.lostBots.length);
  const activeBotCount = Math.max(0, diagnostics.activeBotCount ?? 0);
  if (activeBotCount > 0) {
    return `${lostBotLabel} · ${formatActiveBotAccess(activeBotCount)}`;
  }

  return `${lostBotLabel} · ${entityLabel} недоступен`;
}

function formatActiveBotAccess(count: number): string {
  const botLabel = formatBotCount(count);
  return count === 1 ? `${botLabel} продолжает работать` : `${botLabel} продолжают работать`;
}

function formatBotCount(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const noun =
    mod10 === 1 && mod100 !== 11
      ? 'бот'
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? 'бота'
        : 'ботов';
  return `${count} ${noun}`;
}
