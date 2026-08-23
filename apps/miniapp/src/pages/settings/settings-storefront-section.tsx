import type { ReactNode } from 'react';
import type { ChatSettings } from '@maxim/contracts/settings';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import { GlassCard } from '../../components/ui/glass-card';
import { cn } from '../../lib/cn';

type SettingsStorefrontSectionProps = {
  draft: Pick<ChatSettings, 'karavanStorefrontEnabled'>;
  expanded: boolean;
  summary: string;
  status: string;
  headerAction?: ReactNode;
  footer: ReactNode;
  hasChanges: boolean;
  onDiscardChanges: () => void;
  onToggleSection: () => void;
  onFieldChange: (value: boolean) => void;
};

export function SettingsStorefrontSection({
  draft,
  expanded,
  summary,
  status,
  headerAction,
  footer,
  hasChanges,
  onDiscardChanges,
  onToggleSection,
  onFieldChange,
}: SettingsStorefrontSectionProps) {
  return (
    <GlassCard
      className="settings-section settings-home-entry settings-home-entry--priority stagger-in"
      style={{ animationDelay: '386ms', order: 31 }}
      aria-label="Интернет-витрина"
    >
      <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
        <SettingsSectionToggle
          title="Интернет-витрина"
          summary={summary}
          status={status}
          icon="storefront"
          tone="sky"
          open={expanded}
          controls="settings-storefront-content"
          onClick={onToggleSection}
        />
      </div>

      <SettingsDrilldownPanel
        id="settings-storefront-content"
        open={expanded}
        title="Интернет-витрина"
        summary={summary}
        tone="sky"
        className="settings-drilldown__panel--notice"
        onClose={onToggleSection}
        headerAction={headerAction}
        confirmCloseWhen={hasChanges}
        onDiscardChanges={onDiscardChanges}
        footer={hasChanges ? footer : null}
      >
        <div
          id="settings-storefront-collapse"
          className={cn('settings-section__collapse', expanded && 'is-open')}
        >
          {expanded ? (
            <div className="settings-section__collapse-inner">
              <div className="settings-native-toggle">
                <div className="settings-native-toggle__row">
                  <div className="settings-native-toggle__title-wrap">
                    <span className="settings-native-toggle__title">Караван</span>
                  </div>

                  <label
                    className="settings-native-switch"
                    aria-label="Включить кнопку витрины Караван"
                  >
                    <input
                      type="checkbox"
                      checked={draft.karavanStorefrontEnabled}
                      onChange={(event) => onFieldChange(event.target.checked)}
                    />
                    <span className="toggle-switch" aria-hidden>
                      <span className="toggle-switch__thumb" />
                    </span>
                  </label>
                </div>
                <p className="settings-native-toggle__hint">
                  Для одиночного $ без витрины бот покажет «Смотреть витрины» и «Открыть витрину».
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </SettingsDrilldownPanel>
    </GlassCard>
  );
}
