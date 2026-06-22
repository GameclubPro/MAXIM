import type {
  ManagedEntityAccessDiagnostics,
  ManagedEntityAccessLossReason,
} from '@maxim/contracts/managed-entities';
import { cn } from '../lib/cn';

const REASON_LABELS: Record<ManagedEntityAccessLossReason, string> = {
  chat_not_found: 'чат не найден',
  bot_denied: 'доступ запрещен',
  bot_removed: 'бот удален',
  chat_inaccessible: 'чат недоступен',
};

export function ManagedEntityAccessDiagnosticsBanner({
  diagnostics,
  entityLabel,
  isRechecking,
  onRecheck,
}: {
  diagnostics: ManagedEntityAccessDiagnostics | null | undefined;
  entityLabel: 'чат' | 'канал';
  isRechecking: boolean;
  onRecheck: () => void;
}) {
  if (diagnostics?.state !== 'bot_access_lost' || diagnostics.lostBots.length === 0) {
    return null;
  }

  const lostBots = diagnostics.lostBots;
  const lostCount = lostBots.length;
  const pluralBot = formatBotCount(lostCount);

  return (
    <section className="managed-access-alert" aria-live="polite">
      <div className="managed-access-alert__copy">
        <span className="managed-access-alert__kicker">
          {lostCount > 1 ? 'Боты потеряли доступ' : 'Бот потерял доступ'}
        </span>
        <strong>
          {pluralBot} · {entityLabel} недоступен
        </strong>
        <ul className="managed-access-alert__bots" aria-label="Причины потери доступа">
          {lostBots.map((item, index) => (
            <li key={`${item.reason}:${item.detectedAt}:${index}`}>
              <span>{REASON_LABELS[item.reason]}</span>
              <span>{formatDateTime(item.detectedAt)}</span>
            </li>
          ))}
        </ul>
        <span>
          Верните {lostCount > 1 ? 'ботов' : 'бота'} в администраторы MAX, затем поставьте
          проверку в очередь
        </span>
      </div>
      <button
        type="button"
        className={cn(
          'button button--ghost managed-access-alert__button',
          isRechecking && 'is-loading',
        )}
        disabled={isRechecking}
        onClick={onRecheck}
      >
        {isRechecking ? 'Ставим в очередь' : 'Проверить снова'}
      </button>
    </section>
  );
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

function formatDateTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}
