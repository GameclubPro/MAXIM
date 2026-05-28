import type { UpdateVkParsingSettingsRequest, VkParsingSettings } from '@maxim/contracts';

type SchedulerPanelProps = {
  settings: VkParsingSettings;
  isSaving: boolean;
  onUpdateSetting: (payload: UpdateVkParsingSettingsRequest) => void;
};

export function SchedulerPanel({ settings, isSaving, onUpdateSetting }: SchedulerPanelProps) {
  return (
    <section className="vk-scheduler-panel" aria-label="Автопостинг">
      <div className="vk-scheduler-toggles">
        <label className="vk-source-toggle">
          <span>Авто</span>
          <input
            type="checkbox"
            checked={settings.autoPublishEnabled}
            disabled={isSaving || settings.autoPublishKillSwitchEnabled}
            onChange={(event) => onUpdateSetting({ autoPublishEnabled: event.target.checked })}
          />
        </label>
        <label className="vk-source-toggle vk-source-toggle--danger">
          <span>Stop</span>
          <input
            type="checkbox"
            checked={settings.autoPublishKillSwitchEnabled}
            disabled={isSaving}
            onChange={(event) =>
              onUpdateSetting({ autoPublishKillSwitchEnabled: event.target.checked })
            }
          />
        </label>
        <label className="vk-source-toggle">
          <span>Ссылки</span>
          <input
            type="checkbox"
            checked={settings.stripLinksEnabled}
            disabled={isSaving}
            onChange={(event) => onUpdateSetting({ stripLinksEnabled: event.target.checked })}
          />
        </label>
        <label className="vk-source-toggle">
          <span>Реклама</span>
          <input
            type="checkbox"
            checked={settings.skipAdsEnabled}
            disabled={isSaving}
            onChange={(event) => onUpdateSetting({ skipAdsEnabled: event.target.checked })}
          />
        </label>
        <label className="vk-source-toggle">
          <span>Ровно</span>
          <input
            type="checkbox"
            checked={settings.distributeEvenlyEnabled}
            disabled={isSaving}
            onChange={(event) => onUpdateSetting({ distributeEvenlyEnabled: event.target.checked })}
          />
        </label>
        <label className="vk-source-toggle">
          <span>Круг</span>
          <input
            type="checkbox"
            checked={settings.roundRobinEnabled}
            disabled={isSaving}
            onChange={(event) => onUpdateSetting({ roundRobinEnabled: event.target.checked })}
          />
        </label>
        <label className="vk-source-toggle">
          <span>Guard</span>
          <input
            type="checkbox"
            checked={settings.circuitBreakerEnabled}
            disabled={isSaving}
            onChange={(event) => onUpdateSetting({ circuitBreakerEnabled: event.target.checked })}
          />
        </label>
      </div>

      <div className="vk-scheduler-grid">
        <label>
          <span>Работа с</span>
          <input
            type="time"
            value={settings.workHoursStart}
            disabled={isSaving}
            onChange={(event) => onUpdateSetting({ workHoursStart: event.target.value })}
          />
        </label>
        <label>
          <span>Работа до</span>
          <input
            type="time"
            value={settings.workHoursEnd}
            disabled={isSaving}
            onChange={(event) => onUpdateSetting({ workHoursEnd: event.target.value })}
          />
        </label>
        <label>
          <span>Тихо с</span>
          <input
            type="time"
            value={settings.quietHoursStart ?? ''}
            disabled={isSaving}
            onChange={(event) => onUpdateSetting({ quietHoursStart: event.target.value || null })}
          />
        </label>
        <label>
          <span>Тихо до</span>
          <input
            type="time"
            value={settings.quietHoursEnd ?? ''}
            disabled={isSaving}
            onChange={(event) => onUpdateSetting({ quietHoursEnd: event.target.value || null })}
          />
        </label>
        <label>
          <span>Окно</span>
          <input
            type="number"
            min={1}
            max={1440}
            value={settings.circuitBreakerWindowMinutes}
            disabled={isSaving}
            onChange={(event) =>
              onUpdateSetting({ circuitBreakerWindowMinutes: Number(event.target.value) })
            }
          />
        </label>
        <label>
          <span>Порог</span>
          <input
            type="number"
            min={1}
            max={500}
            value={settings.circuitBreakerPostLimit}
            disabled={isSaving}
            onChange={(event) =>
              onUpdateSetting({ circuitBreakerPostLimit: Number(event.target.value) })
            }
          />
        </label>
      </div>
    </section>
  );
}
