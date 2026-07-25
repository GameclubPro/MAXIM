import { NavArrowRight } from 'iconoir-react';
import { Link } from 'react-router';
import type { ManagedEntityType } from '@maxim/contracts';
import { cn } from '../lib/cn';
import { SettingsSectionIcon } from './ui/settings-section-toggle';
import './publication-workspace-handoff.css';

type PublicationWorkspaceHandoffProps = {
  entityType: ManagedEntityType;
  entityId: string;
  variant?: 'action' | 'settings-entry' | 'settings-tile';
};

export function PublicationWorkspaceHandoff({
  entityType,
  entityId,
  variant = 'action',
}: PublicationWorkspaceHandoffProps) {
  return (
    <Link
      className={cn(
        'publication-workspace-handoff',
        variant === 'settings-entry' && 'publication-workspace-handoff--settings-entry',
        variant === 'settings-tile' &&
          'publication-workspace-handoff--settings-tile settings-section__toggle is-stateless',
      )}
      to={`/publications?compose=1&entityType=${entityType}&entityId=${encodeURIComponent(entityId)}`}
      aria-label={variant !== 'action' ? 'Открыть посты' : undefined}
    >
      {variant === 'settings-tile' ? (
        <>
          <span className="settings-section__icon-badge is-mint" aria-hidden>
            <SettingsSectionIcon name="send" />
          </span>
          <span className="settings-section__toggle-main">
            <h3>Посты</h3>
          </span>
        </>
      ) : variant === 'settings-entry' ? (
        <>
          <span className="publication-workspace-handoff__icon" aria-hidden>
            <SettingsSectionIcon name="send" />
          </span>
          <span className="publication-workspace-handoff__copy">
            <strong>Посты</strong>
            <small>Публикации и расписание</small>
          </span>
          <span className="publication-workspace-handoff__status">Открыть</span>
        </>
      ) : (
        <span>Открыть публикации</span>
      )}
      {variant === 'settings-tile' ? null : <NavArrowRight aria-hidden />}
    </Link>
  );
}
