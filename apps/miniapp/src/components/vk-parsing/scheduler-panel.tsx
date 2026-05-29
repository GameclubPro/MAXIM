import type {
  UpdateVkParsingSettingsRequest,
  UpdateVkParsingSourceRequest,
  VkParsingSettings,
  VkParsingSource,
} from '@maxim/contracts';
import { cn } from '../../lib/cn';

type SchedulerPanelProps = {
  settings: VkParsingSettings;
  sources: VkParsingSource[];
  isSaving: boolean;
  isSavingSource: boolean;
  onUpdateSetting: (payload: UpdateVkParsingSettingsRequest) => void;
  onUpdateSources: (sourceIds: string[], payload: UpdateVkParsingSourceRequest) => void;
};

const SOURCE_MODE_OPTIONS: Array<{
  value: NonNullable<UpdateVkParsingSourceRequest['publishMode']>;
  label: string;
}> = [
  { value: 'IMMEDIATE', label: 'Сразу' },
  { value: 'QUEUE', label: 'Очередь' },
  { value: 'REVIEW', label: 'На проверку' },
];

const FREQUENCY_OPTIONS = [
  { value: 'SLOW', label: 'Редко', minutes: 180 },
  { value: 'NORMAL', label: 'Обычно', minutes: 60 },
  { value: 'FAST', label: 'Быстро', minutes: 20 },
  { value: 'CUSTOM', label: 'Свой', minutes: null },
] as const;

const CUSTOM_FREQUENCY_MINUTES = 90;

type FrequencyOption = (typeof FREQUENCY_OPTIONS)[number]['value'];

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

function resolveCommonValue<T>(values: T[]): T | null {
  if (values.length === 0) {
    return null;
  }
  const [first] = values;
  return values.every((value) => value === first) ? first : null;
}

function resolveFrequencyPreset(minutes: number | null): FrequencyOption {
  if (minutes === null) {
    return 'CUSTOM';
  }
  return FREQUENCY_OPTIONS.find((item) => item.minutes === minutes)?.value ?? 'CUSTOM';
}

export function SchedulerPanel({
  settings,
  sources,
  isSaving,
  isSavingSource,
  onUpdateSetting,
  onUpdateSources,
}: SchedulerPanelProps) {
  const sourceIds = sources.map((source) => source.id);
  const sourceMode = resolveCommonValue(sources.map((source) => source.publishMode));
  const commonInterval = resolveCommonValue(sources.map((source) => source.publishIntervalMinutes));
  const frequencyPreset = resolveFrequencyPreset(commonInterval);
  const customInterval = commonInterval ?? CUSTOM_FREQUENCY_MINUTES;
  const sourceControlsDisabled = sourceIds.length === 0 || isSavingSource;

  return (
    <section className="vk-scheduler-panel vk-quick-setup" aria-label="Быстрая настройка">
      <div className="vk-quick-setup__title">
        <strong>Быстрая настройка</strong>
      </div>
      <div className="vk-quick-setup__head">
        <SwitchRow
          label="Автопостинг"
          checked={settings.autoPublishEnabled}
          disabled={isSaving || settings.autoPublishKillSwitchEnabled}
          onChange={(checked) => onUpdateSetting({ autoPublishEnabled: checked })}
        />
        <SwitchRow
          label="Пауза всего"
          checked={settings.autoPublishKillSwitchEnabled}
          disabled={isSaving}
          danger
          onChange={(checked) => onUpdateSetting({ autoPublishKillSwitchEnabled: checked })}
        />
      </div>

      <div className="vk-quick-setup__row">
        <span>Публиковать</span>
        <div className="vk-segmented-buttons" role="group" aria-label="Режим публикации">
          {SOURCE_MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={cn(sourceMode === option.value && 'is-active')}
              disabled={sourceControlsDisabled}
              onClick={() => onUpdateSources(sourceIds, { publishMode: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="vk-quick-setup__row">
        <span>Темп</span>
        <div className="vk-segmented-buttons" role="group" aria-label="Темп публикации">
          {FREQUENCY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={cn(frequencyPreset === option.value && 'is-active')}
              disabled={sourceControlsDisabled}
              onClick={() =>
                onUpdateSources(sourceIds, {
                  publishIntervalMinutes: option.minutes ?? CUSTOM_FREQUENCY_MINUTES,
                })
              }
            >
              {option.label}
            </button>
          ))}
        </div>
        {frequencyPreset === 'CUSTOM' ? (
          <label className="vk-quick-custom-field">
            <span>Мин</span>
            <input
              type="number"
              min={5}
              max={10080}
              value={customInterval}
              disabled={sourceControlsDisabled}
              onChange={(event) =>
                onUpdateSources(sourceIds, { publishIntervalMinutes: Number(event.target.value) })
              }
            />
          </label>
        ) : null}
      </div>

      <div className="vk-quick-time">
        <label>
          <span>С</span>
          <input
            type="time"
            value={settings.workHoursStart}
            disabled={isSaving}
            onChange={(event) => onUpdateSetting({ workHoursStart: event.target.value })}
          />
        </label>
        <label>
          <span>До</span>
          <input
            type="time"
            value={settings.workHoursEnd}
            disabled={isSaving}
            onChange={(event) => onUpdateSetting({ workHoursEnd: event.target.value })}
          />
        </label>
      </div>

      <details className="vk-advanced-fold">
        <summary>Защита и баланс</summary>
        <div className="vk-scheduler-toggles">
          <SwitchRow
            label="Убирать ссылки"
            checked={settings.stripLinksEnabled}
            disabled={isSaving}
            onChange={(checked) => onUpdateSetting({ stripLinksEnabled: checked })}
          />
          <SwitchRow
            label="Без рекламы"
            checked={settings.skipAdsEnabled}
            disabled={isSaving}
            onChange={(checked) => onUpdateSetting({ skipAdsEnabled: checked })}
          />
          <SwitchRow
            label="Равномерно"
            checked={settings.distributeEvenlyEnabled}
            disabled={isSaving}
            onChange={(checked) => onUpdateSetting({ distributeEvenlyEnabled: checked })}
          />
          <SwitchRow
            label="Чередовать"
            checked={settings.roundRobinEnabled}
            disabled={isSaving}
            onChange={(checked) => onUpdateSetting({ roundRobinEnabled: checked })}
          />
          <SwitchRow
            label="Защита"
            checked={settings.circuitBreakerEnabled}
            disabled={isSaving}
            onChange={(checked) => onUpdateSetting({ circuitBreakerEnabled: checked })}
          />
        </div>

        <div className="vk-scheduler-grid">
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
      </details>
    </section>
  );
}
