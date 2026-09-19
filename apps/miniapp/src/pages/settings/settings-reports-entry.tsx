import { lazy, Suspense } from 'react';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import type { SettingsReportsSectionProps } from './settings-reports-section';

const ExpandedReports = lazy(() =>
  import('./settings-reports-section').then((module) => ({
    default: module.SettingsReportsSection,
  })),
);

export function SettingsReportsSection(props: SettingsReportsSectionProps) {
  const entry = (
    <section
      className="settings-section settings-home-entry settings-home-entry--list"
      style={{ order: 13 }}
      aria-label="Жалобы"
    >
      <div className="settings-section__head settings-section__head--interactive">
        <SettingsSectionToggle
          title="Жалобы"
          summary={props.draft.reportsEnabled ? `Порог: ${props.draft.reportsThreshold}` : ''}
          status={
            props.draft.reportsEnabled ? (props.reportsAvailable ? 'Вкл' : 'Приостановлен') : 'Выкл'
          }
          icon="warning"
          tone="rose"
          open={props.expanded}
          controls="settings-reports-content"
          onClick={() => props.toggleSection('reports')}
        />
      </div>
    </section>
  );
  return props.expanded ? (
    <Suspense fallback={entry}>
      <ExpandedReports {...props} />
    </Suspense>
  ) : (
    entry
  );
}
