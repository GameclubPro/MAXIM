import { CheckCircle, Clock, Pause, WarningCircle } from 'iconoir-react';
import type {
  BulkUpdateVkParsingSourcesRequest,
  UpdateVkParsingSettingsRequest,
  UpdateVkParsingSourceRequest,
  VkParsingSettings,
  VkParsingSource,
} from '@maxim/contracts';
import { cn } from '../../lib/cn';

type SchedulerPanelProps = {
  settings: VkParsingSettings;
  sources: VkParsingSource[];
  status: AutopostStatusModel;
  queueCount: number;
  publishedCount: number;
  isSaving: boolean;
  isSavingSource: boolean;
  onUpdateSetting: (payload: UpdateVkParsingSettingsRequest) => void;
  onUpdateSources: (sourceIds: string[], payload: UpdateVkParsingSourceRequest) => void;
  onApplyPreset: (preset: BulkUpdateVkParsingSourcesRequest['preset']) => void;
};

export type AutopostStatusTone = 'success' | 'warning' | 'danger' | 'muted';

export type AutopostStatusModel = {
  title: string;
  reason: string;
  tone: AutopostStatusTone;
};

const SOURCE_MODE_OPTIONS: Array<{
  value: NonNullable<UpdateVkParsingSourceRequest['publishMode']>;
  label: string;
}> = [
  { value: 'IMMEDIATE', label: 'Сразу' },
  { value: 'QUEUE', label: 'Очередь' },
  { value: 'REVIEW', label: 'Проверка' },
];

const FREQUENCY_OPTIONS = [
  { value: 'SLOW', label: 'Редко', minutes: 180 },
  { value: 'NORMAL', label: 'Норма', minutes: 60 },
  { value: 'FAST', label: 'Чаще', minutes: 20 },
  { value: 'CUSTOM', label: 'Свой', minutes: null },
] as const;

const CUSTOM_FREQUENCY_MINUTES = 90;

type FrequencyOption = (typeof FREQUENCY_OPTIONS)[number]['value'];

const QUICK_PRESETS: Array<{
  value: BulkUpdateVkParsingSourcesRequest['preset'];
  label: string;
  title: string;
}> = [
  {
    value: 'CLEAN',
    label: 'Безопасно',
    title: 'Очередь, умеренный темп, ссылки и реклама выключены',
  },
  { value: 'SLOW', label: 'Обычно', title: 'Очередь и спокойный темп публикаций' },
  { value: 'NEWS', label: 'Активно', title: 'Очередь, высокий приоритет и быстрый темп' },
];

function SwitchRow({
  label,
  checked,
  disabled,
  danger = false,
  id,
  title,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  danger?: boolean;
  id?: string;
  title?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={cn('vk-setup-switch', danger && 'vk-setup-switch--danger')} title={title}>
      <span>{label}</span>
      <span className="settings-native-switch">
        <input
          id={id}
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

function renderAutopostStatusIcon(tone: AutopostStatusTone) {
  if (tone === 'success') {
    return <CheckCircle aria-hidden />;
  }
  if (tone === 'danger') {
    return <Pause aria-hidden />;
  }
  if (tone === 'warning') {
    return <WarningCircle aria-hidden />;
  }
  return <Clock aria-hidden />;
}

export function SchedulerPanel({
  settings,
  sources,
  status,
  queueCount,
  publishedCount,
  isSaving,
  isSavingSource,
  onUpdateSetting,
  onUpdateSources,
  onApplyPreset,
}: SchedulerPanelProps) {
  const sourceIds = sources.map((source) => source.id);
  const sourceMode = resolveCommonValue(sources.map((source) => source.publishMode));
  const commonInterval = resolveCommonValue(sources.map((source) => source.publishIntervalMinutes));
  const frequencyPreset = commonInterval === null ? null : resolveFrequencyPreset(commonInterval);
  const customInterval = commonInterval ?? CUSTOM_FREQUENCY_MINUTES;
  const sourceControlsDisabled = sourceIds.length === 0 || isSavingSource;
  const presetDisabled = sourceIds.length === 0 || isSavingSource || isSaving;

  return (
    <section
      className={`vk-scheduler-panel vk-setup-center vk-setup-center--${status.tone}`}
      aria-label="Автопостинг"
    >
      <div className="vk-setup-center__top">
        <div className="vk-setup-center__status" aria-label="Статус автопостинга">
          <span className="vk-setup-center__status-icon">
            {renderAutopostStatusIcon(status.tone)}
          </span>
          <span className="vk-setup-center__status-copy">
            <strong>{status.title}</strong>
            <small>{status.reason}</small>
          </span>
          <span className="vk-setup-center__status-facts" aria-label="Сводка автопостинга">
            <span>
              <b>{queueCount}</b>
              <small>Очередь</small>
            </span>
            <span>
              <b>{publishedCount}</b>
              <small>Вышло</small>
            </span>
          </span>
        </div>
        <div className="vk-setup-center__switches" aria-label="Включение автопостинга">
          <SwitchRow
            id="vk-parsing-automation-switch"
            label="Авто"
            checked={settings.autoPublishEnabled}
            disabled={isSaving || settings.autoPublishKillSwitchEnabled}
            title="Общее включение автоматической публикации"
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
        </div>
      </div>

      <div className="vk-setup-center__presets">
        <span>Профиль</span>
        <div className="vk-quick-preset-row" aria-label="Пресеты автопостинга">
          {QUICK_PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              disabled={presetDisabled}
              title={preset.title}
              onClick={() => {
                onUpdateSetting({ autoPublishEnabled: true, autoPublishKillSwitchEnabled: false });
                onApplyPreset(preset.value);
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div id="vk-parsing-publish-mode" className="vk-quick-setup__row">
        <span>Режим</span>
        <div
          className="vk-segmented-buttons vk-segmented-buttons--mode"
          role="group"
          aria-label="Режим публикации"
        >
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

      <details className="vk-advanced-fold">
        <summary>Расписание и защита</summary>
        <div id="vk-parsing-work-time" className="vk-quick-setup__row">
          <span>Время</span>
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
        </div>
        <div className="vk-scheduler-toggles">
          <SwitchRow
            label="Убирать ссылки"
            checked={settings.stripLinksEnabled}
            disabled={isSaving}
            title="Удалять ссылки перед публикацией"
            onChange={(checked) => onUpdateSetting({ stripLinksEnabled: checked })}
          />
          <SwitchRow
            label="Без рекламы"
            checked={settings.skipAdsEnabled}
            disabled={isSaving}
            title="Пропускать рекламные посты"
            onChange={(checked) => onUpdateSetting({ skipAdsEnabled: checked })}
          />
          <SwitchRow
            label="Равномерно"
            checked={settings.distributeEvenlyEnabled}
            disabled={isSaving}
            title="Распределять публикации по рабочему времени"
            onChange={(checked) => onUpdateSetting({ distributeEvenlyEnabled: checked })}
          />
          <SwitchRow
            label="Чередовать"
            checked={settings.roundRobinEnabled}
            disabled={isSaving}
            title="Чередовать источники"
            onChange={(checked) => onUpdateSetting({ roundRobinEnabled: checked })}
          />
          <SwitchRow
            label="Защита"
            checked={settings.circuitBreakerEnabled}
            disabled={isSaving}
            title="Останавливать автопостинг при подозрительном всплеске"
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
