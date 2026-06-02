import { Link } from 'react-router-dom';
import { cn } from '../lib/cn';
import { GlassCard } from './ui/glass-card';
import './handoff.css';

type SettingsHandoffStateProps = {
  entityType?: 'chat' | 'channel';
  mode: 'loading' | 'error';
  retryCount?: number;
  onRetry?: () => void;
  backTo?: string;
};

export default function SettingsHandoffState({
  entityType = 'chat',
  mode,
  retryCount = 0,
  onRetry,
  backTo,
}: SettingsHandoffStateProps) {
  const entityLabel = entityType === 'channel' ? 'канал' : 'чат';
  const settingsLabel = entityType === 'channel' ? 'настройки канала' : 'настройки чата';
  const fallbackBackTo = entityType === 'channel' ? '/?view=channel' : '/?view=chat';
  const isError = mode === 'error';
  const statusText = isError
    ? 'MAX ещё подтверждает доступ.'
    : retryCount > 0
      ? 'MAX применяет права. Пробуем снова...'
      : 'Обычно это занимает несколько секунд.';

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
          <span className="settings-handoff__eyebrow">Подключение</span>
          <h3>
            {isError ? `${capitalizeFirst(entityLabel)} пока не готов` : `Готовим ${settingsLabel}`}
          </h3>
          <p>
            {isError
              ? 'Вернитесь к списку и попробуйте открыть экран ещё раз через несколько секунд.'
              : 'Проверяем права бота и загружаем экран управления.'}
          </p>
        </div>

        <div className="settings-handoff__steps" aria-hidden>
          <span className="settings-handoff__step is-complete">
            {entityType === 'channel' ? 'Канал' : 'Чат'}
          </span>
          <span className={cn('settings-handoff__step', isError ? 'is-error' : 'is-active')}>
            Права
          </span>
          <span
            className={cn('settings-handoff__step', !isError && retryCount === 0 && 'is-pending')}
          >
            Настройки
          </span>
        </div>

        <p className="settings-handoff__status">{statusText}</p>

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
