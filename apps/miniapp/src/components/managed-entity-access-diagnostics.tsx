import type { ManagedEntityAccessDiagnostics } from '@maxim/contracts/managed-entities';
import { cn } from '../lib/cn';
import { formatManagedEntityAccessLossHeadline } from './managed-entity-access-diagnostics.model';
import './managed-entity-access-diagnostics.css';

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

  const lostCount = diagnostics.lostBots.length;
  const headline = formatManagedEntityAccessLossHeadline(diagnostics, entityLabel);

  return (
    <section className="managed-access-alert" aria-live="polite">
      <div className="managed-access-alert__copy">
        <strong>{headline}</strong>
        <span>Верните {lostCount > 1 ? 'ботов' : 'бота'} в администраторы и проверьте снова.</span>
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
        {isRechecking ? 'Проверяем...' : 'Проверить снова'}
      </button>
    </section>
  );
}
