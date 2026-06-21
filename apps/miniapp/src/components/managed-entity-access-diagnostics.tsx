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

const FALLBACK_BOT_LABEL = 'Бот модерации';

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

  const latest = diagnostics.lostBots[0];
  const botLabel = latest.botLabel?.trim() || FALLBACK_BOT_LABEL;

  return (
    <section className="managed-access-alert" aria-live="polite">
      <div className="managed-access-alert__copy">
        <span className="managed-access-alert__kicker">Бот потерял доступ</span>
        <strong>{botLabel}</strong>
        <span>
          {entityLabel} недоступен · {REASON_LABELS[latest.reason]}
        </span>
        <span>
          Верните бота в администраторы MAX, затем поставьте проверку в очередь ·{' '}
          {formatDateTime(latest.detectedAt)}
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
