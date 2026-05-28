import type { UpdateVkParsingSettingsRequest, VkParsingSettings } from '@maxim/contracts';

type SchedulerPanelProps = {
  settings: VkParsingSettings;
  isSaving: boolean;
  onUpdateSetting: (payload: UpdateVkParsingSettingsRequest) => void;
};

function SwitchRow({
  label,
  checked,
  disabled,
  danger = false,
  title,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  danger?: boolean;
  title?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={danger ? 'vk-source-toggle vk-source-toggle--danger' : 'vk-source-toggle'}
      title={title}
    >
      <span>{label}</span>
      <span className="settings-native-switch">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="toggle-switch" aria-hidden>
          <span className="toggle-switch__thumb" />
        </span>
      </span>
    </label>
  );
}

export function SchedulerPanel({ settings, isSaving, onUpdateSetting }: SchedulerPanelProps) {
  return (
    <section className="vk-scheduler-panel" aria-label="Автопостинг">
      <div className="vk-scheduler-toggles">
        <SwitchRow
          label="Авто"
          checked={settings.autoPublishEnabled}
          disabled={isSaving || settings.autoPublishKillSwitchEnabled}
          onChange={(checked) => onUpdateSetting({ autoPublishEnabled: checked })}
        />
        <SwitchRow
          label="Стоп"
          checked={settings.autoPublishKillSwitchEnabled}
          disabled={isSaving}
          danger
          title="Остановить автопубликацию"
          onChange={(checked) => onUpdateSetting({ autoPublishKillSwitchEnabled: checked })}
        />
        <SwitchRow
          label="Ссылки"
          checked={settings.stripLinksEnabled}
          disabled={isSaving}
          title="Убирать ссылки перед публикацией"
          onChange={(checked) => onUpdateSetting({ stripLinksEnabled: checked })}
        />
        <SwitchRow
          label="Реклама"
          checked={settings.skipAdsEnabled}
          disabled={isSaving}
          title="Пропускать рекламные посты"
          onChange={(checked) => onUpdateSetting({ skipAdsEnabled: checked })}
        />
        <SwitchRow
          label="Ровно"
          checked={settings.distributeEvenlyEnabled}
          disabled={isSaving}
          onChange={(checked) => onUpdateSetting({ distributeEvenlyEnabled: checked })}
        />
        <SwitchRow
          label="Ротация"
          checked={settings.roundRobinEnabled}
          disabled={isSaving}
          onChange={(checked) => onUpdateSetting({ roundRobinEnabled: checked })}
        />
        <SwitchRow
          label="Лимит"
          checked={settings.circuitBreakerEnabled}
          disabled={isSaving}
          title="Останавливать источник при всплеске публикаций"
          onChange={(checked) => onUpdateSetting({ circuitBreakerEnabled: checked })}
        />
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
