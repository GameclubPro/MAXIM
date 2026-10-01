import { Suspense } from 'react';
import { GlassCard } from '../../components/ui/glass-card';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import type { SettingsExtraSectionProps } from './settings-extra-section';

const ExpandedExtra = recoverableLazyNamedComponent<SettingsExtraSectionProps>(
  () => import('./settings-extra-section'),
  'SettingsExtraSection',
);

export function SettingsExtraSection(props: SettingsExtraSectionProps) {
  const entry = (
    <GlassCard
      className="settings-section settings-home-entry settings-home-entry--list stagger-in"
      style={{ animationDelay: '372ms', order: 32 }}
      aria-label="Сервис"
    >
      <div className="settings-section__head settings-section__head--interactive">
        <SettingsSectionToggle
          title="Сообщения и боты"
          summary={props.summary}
          status={props.status}
          icon="tools"
          tone="amber"
          open={props.expanded}
          controls="settings-extra-content"
          onClick={props.onToggleSection}
        />
      </div>
    </GlassCard>
  );
  return props.expanded ? (
    <Suspense fallback={entry}>
      <ExpandedExtra {...props} />
    </Suspense>
  ) : (
    entry
  );
}
