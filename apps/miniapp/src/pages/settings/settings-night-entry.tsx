import { Suspense } from 'react';
import { GlassCard } from '../../components/ui/glass-card';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import type { SettingsNightSectionProps } from './settings-night-section';

const ExpandedNight = recoverableLazyNamedComponent<SettingsNightSectionProps>(
  () => import('./settings-night-section'),
  'SettingsNightSection',
);

export function SettingsNightSection(props: SettingsNightSectionProps) {
  const entry = (
    <GlassCard
      className="settings-section settings-home-entry settings-home-entry--list stagger-in"
      style={{ animationDelay: '250ms', order: 16 }}
      aria-label="Ночной режим"
    >
      <div className="settings-section__head settings-section__head--interactive">
        <SettingsSectionToggle
          title="Ночной режим"
          summary={props.nightHeaderSummary}
          status={props.nightCardStatus}
          icon="moon"
          tone="ink"
          open={props.expanded}
          controls="settings-night-content"
          onClick={() => props.toggleSection('night')}
        />
      </div>
    </GlassCard>
  );
  return props.expanded ? (
    <Suspense fallback={entry}>
      <ExpandedNight {...props} />
    </Suspense>
  ) : (
    entry
  );
}
