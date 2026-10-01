import { Suspense } from 'react';
import { GlassCard } from '../../components/ui/glass-card';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import type { SettingsDuplicatesSectionProps } from './settings-duplicates-section';

const ExpandedDuplicates = recoverableLazyNamedComponent<SettingsDuplicatesSectionProps>(
  () => import('./settings-duplicates-section'),
  'SettingsDuplicatesSection',
);

export function SettingsDuplicatesSection(props: SettingsDuplicatesSectionProps) {
  const entry = (
    <GlassCard
      className="settings-section settings-home-entry settings-home-entry--list stagger-in"
      style={{ animationDelay: '180ms', order: 15 }}
      aria-label="Антидубль"
    >
      <div className="settings-section__head settings-section__head--interactive">
        <SettingsSectionToggle
          title="Антидубль"
          summary={props.duplicatesHeaderSummary}
          status={props.draft.antiDuplicateEnabled ? 'Вкл' : 'Выкл'}
          icon="repeat"
          tone="rose"
          open={props.expanded}
          controls="settings-duplicates-content"
          onClick={() => props.toggleSection('duplicates')}
        />
      </div>
    </GlassCard>
  );
  return props.expanded ? (
    <Suspense fallback={entry}>
      <ExpandedDuplicates {...props} />
    </Suspense>
  ) : (
    entry
  );
}
