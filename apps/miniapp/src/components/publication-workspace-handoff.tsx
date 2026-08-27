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
      to="/publications"
      aria-label={
        variant !== 'action' ? 'Расписания. Старые публикации. Статус: открыть' : undefined
      }
      data-settings-search={
        variant !== 'action' ? 'Расписания старые публикации автопостинг' : undefined
      }
    >
      {variant === 'settings-tile' ? (
        <>
          <span className="settings-section__icon-badge is-mint" aria-hidden>
            <SettingsSectionIcon name="send" />
          </span>
          <span className="settings-section__toggle-main">
            <span className="settings-section__title">Расписания</span>
          </span>
          <span className="settings-section__chevron" aria-hidden>
            <NavArrowRight className="settings-section__chevron-icon" />
          </span>
        </>
      ) : variant === 'settings-entry' ? (
        <>
          <span className="publication-workspace-handoff__icon" aria-hidden>
            <SettingsSectionIcon name="send" />
          </span>
          <span className="publication-workspace-handoff__copy">
            <strong>Расписания</strong>
            <small>Старые публикации</small>
          </span>
          <span className="publication-workspace-handoff__status">Открыть</span>
        </>
      ) : (
        <span>Открыть расписания</span>
      )}
      {variant === 'settings-tile' ? null : <NavArrowRight aria-hidden />}
    </Link>
  );
}
