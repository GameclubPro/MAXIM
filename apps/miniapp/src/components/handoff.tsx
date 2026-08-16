import { Link } from 'react-router';
import { cn } from '../lib/cn';
import { SettingsLoadErrorState } from './settings-load-error-state';
import { GlassCard } from './ui/glass-card';
import './handoff.css';

type SettingsHandoffStateProps = {
  entityType?: 'chat' | 'channel';
  mode: 'loading' | 'error';
  retryCount?: number;
  onRetry?: () => void;
  backTo?: string;
  error?: unknown;
};

export default function SettingsHandoffState({
  entityType = 'chat',
  mode,
  onRetry,
  backTo,
  error,
}: SettingsHandoffStateProps) {
  const entityLabel = entityType === 'channel' ? 'канал' : 'чат';
  const fallbackBackTo = entityType === 'channel' ? '/?view=channel' : '/?view=chat';
  const isError = mode === 'error';

  if (error && onRetry) {
    return <SettingsLoadErrorState entityType={entityType} error={error} onRetry={onRetry} />;
  }

  return (
    <GlassCard className={cn('settings-handoff-card', isError && 'is-error')} elevated>
      <section className="settings-handoff" role="status" aria-live="polite">
        <div className={cn('settings-handoff__visual', isError && 'is-error')} aria-hidden>
          <span className="settings-handoff__ring settings-handoff__ring--outer" />
          <span className="settings-handoff__ring settings-handoff__ring--inner" />
          {isError ? (
            <span className="settings-handoff__error-mark">!</span>
          ) : (
            <span className="settings-handoff__spinner" />
          )}
        </div>

        <div className="settings-handoff__copy">
          <h3>{isError ? `${capitalizeFirst(entityLabel)} недоступен` : 'Загружаем настройки'}</h3>
        </div>

        {isError ? (
          <div className="settings-handoff__actions">
            <button type="button" className="button button--accent" onClick={onRetry}>
              Проверить снова
            </button>
            <Link to={backTo ?? fallbackBackTo} className="button button--ghost">
              К списку
            </Link>
          </div>
        ) : null}
      </section>
    </GlassCard>
  );
}

function capitalizeFirst(value: string): string {
  return value ? `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}` : value;
}
