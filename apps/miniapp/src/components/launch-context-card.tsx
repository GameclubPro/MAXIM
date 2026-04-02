import { Link } from 'react-router-dom';
import { EntityAvatar } from './ui/entity-avatar';
import { GlassCard } from './ui/glass-card';

export function LaunchContextCard({
  badge,
  title,
  description,
  entityType,
  avatarUrl,
  isChecking,
  primaryRoute,
  primaryLabel,
  primaryState,
  onPrimaryOpen,
  secondaryRoute,
  secondaryLabel,
  secondaryState,
  onSecondaryOpen,
  onRetry,
  retryDisabled = false,
}: {
  badge: string;
  title: string;
  description: string;
  entityType: 'chat' | 'channel';
  avatarUrl: string | null;
  isChecking: boolean;
  primaryRoute: string;
  primaryLabel: string;
  primaryState: unknown;
  onPrimaryOpen: () => void;
  secondaryRoute?: string | null;
  secondaryLabel?: string;
  secondaryState?: unknown;
  onSecondaryOpen?: () => void;
  onRetry?: () => void;
  retryDisabled?: boolean;
}) {
  return (
    <GlassCard className="launch-context-card" elevated>
      <div className="launch-context-card__head">
        <span className="chip launch-context-card__badge">{badge}</span>
        {isChecking ? <span className="launch-context-card__meta">Проверка идёт</span> : null}
      </div>
      <div className="launch-context-card__body">
        <div className="launch-context-card__identity">
          <EntityAvatar
            title={title}
            entityType={entityType}
            avatarUrl={avatarUrl}
            className="launch-context-card__avatar"
          />
          <div className="launch-context-card__copy">
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
        </div>

        <div className="launch-context-card__actions">
          <Link
            to={primaryRoute}
            className="button button--accent"
            state={primaryState}
            onClick={onPrimaryOpen}
          >
            {primaryLabel}
          </Link>
          {secondaryRoute && secondaryLabel && onSecondaryOpen ? (
            <Link
              to={secondaryRoute}
              className="button button--ghost"
              state={secondaryState}
              onClick={onSecondaryOpen}
            >
              {secondaryLabel}
            </Link>
          ) : (
            <button
              type="button"
              className="button button--ghost"
              onClick={onRetry}
              disabled={retryDisabled}
            >
              {isChecking ? 'Проверяем...' : 'Проверить снова'}
            </button>
          )}
        </div>
      </div>
    </GlassCard>
  );
}
