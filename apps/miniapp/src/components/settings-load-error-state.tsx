import { Link } from 'react-router';
import { describeUserFacingError } from '../lib/user-facing-error';
import { buildManagedEntitiesRoute } from '../lib/last-chat';
import { closeMaxMiniApp } from '../lib/max-bridge';
import { resolveSettingsLoadErrorKind } from '../lib/settings-load-error';
import { GlassCard } from './ui/glass-card';
import { StatusState } from './ui/status-state';

type SettingsLoadErrorStateProps = {
  entityType: 'chat' | 'channel';
  error: unknown;
  onRetry: () => void;
};

export function SettingsLoadErrorState({
  entityType,
  error,
  onRetry,
}: SettingsLoadErrorStateProps) {
  const kind = resolveSettingsLoadErrorKind(error);

  if (kind === 'auth-expired' || kind === 'auth-relaunch') {
    return (
      <GlassCard>
        <StatusState
          tone="danger"
          title={kind === 'auth-expired' ? 'Срок входа истёк' : 'Нужно открыть приложение заново'}
          description="Закройте мини-приложение и откройте его снова из MAX."
          action={
            <button
              type="button"
              className="button button--danger"
              onClick={() => closeMaxMiniApp()}
            >
              Закрыть приложение
            </button>
          }
        />
      </GlassCard>
    );
  }

  if (kind === 'access-denied') {
    const entityLabel = entityType === 'channel' ? 'канал' : 'чат';
    return (
      <GlassCard>
        <StatusState
          tone="warning"
          title="Нет доступа к настройкам"
          description={`Проверьте права администратора или выберите другой ${entityLabel}.`}
          action={
            <Link to={buildManagedEntitiesRoute(entityType)} className="button button--accent">
              К списку
            </Link>
          }
        />
      </GlassCard>
    );
  }

  return (
    <GlassCard>
      <StatusState
        tone="danger"
        title="Не удалось загрузить настройки"
        description={describeUserFacingError(error, 'Не удалось загрузить настройки.')}
        action={
          <button type="button" className="button button--danger" onClick={onRetry}>
            Повторить
          </button>
        }
      />
    </GlassCard>
  );
}
