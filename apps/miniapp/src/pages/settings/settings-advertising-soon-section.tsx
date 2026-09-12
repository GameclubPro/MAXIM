import { GlassCard } from '../../components/ui/glass-card';
import { SettingsSectionIcon } from '../../components/ui/settings-section-toggle';

export function SettingsAdvertisingSoonSection() {
  return (
    <GlassCard
      className="settings-section settings-home-entry settings-advertising-soon stagger-in"
      style={{ order: 32 }}
    >
      <div className="settings-section__head">
        <button
          type="button"
          className="settings-section__toggle settings-advertising-soon__entry"
          disabled
          aria-label="Рекламная площадка"
          aria-describedby="settings-advertising-soon-status"
          data-settings-search="Рекламная площадка Связка реклама взаимопиар биржа размещение"
        >
          <span className="settings-section__icon-badge is-sky" aria-hidden>
            <SettingsSectionIcon name="ads" />
          </span>
          <span className="settings-section__toggle-main">
            <span className="settings-section__title">Рекламная площадка</span>
          </span>
          <span id="settings-advertising-soon-status" className="settings-advertising-soon__badge">
            Скоро
          </span>
        </button>
      </div>
    </GlassCard>
  );
}
