import { CheckCircle, Clock, Pause, WarningCircle } from 'iconoir-react';
import type {
  BulkUpdateVkParsingSourcesRequest,
  UpdateVkParsingSettingsRequest,
  UpdateVkParsingSourceRequest,
  VkParsingSettings,
  VkParsingSource,
} from '@maxim/contracts';
import { cn } from '../../lib/cn';
import { TimeField } from '../ui/time-field';

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

type AutopostMode = 'manual' | 'auto' | 'pause';

const AUTOPOST_MODES: Array<{ value: AutopostMode; label: string }> = [
  { value: 'manual', label: 'Ручной' },
  { value: 'auto', label: 'Авто' },
  { value: 'pause', label: 'Пауза' },
];

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
  const autopostMode: AutopostMode = settings.autoPublishKillSwitchEnabled
    ? 'pause'
    : settings.autoPublishEnabled
      ? 'auto'
      : 'manual';

  return (
    <section
      className={`vk-scheduler-panel vk-autopost-panel vk-autopost-panel--${status.tone}`}
      aria-label="Автопостинг"
    >
      <div className="vk-autopost-panel__main">
        <div className="vk-autopost-status" aria-label="Статус автопостинга">
          <span className="vk-autopost-status__icon">{renderAutopostStatusIcon(status.tone)}</span>
          <span className="vk-autopost-status__copy">
            <strong>{status.title}</strong>
            <small>{status.reason}</small>
          </span>
        </div>

        <div className="vk-autopost-metrics" aria-label="Сводка автопостинга">
          <span>
            <b>{queueCount}</b>
            <small>Очередь</small>
          </span>
          <span>
            <b>{publishedCount}</b>
            <small>Вышло</small>
          </span>
        </div>

        <div className="vk-autopost-mode" role="radiogroup" aria-label="Режим автопостинга">
          {AUTOPOST_MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              role="radio"
              aria-checked={autopostMode === mode.value}
              className={cn(autopostMode === mode.value && 'is-active')}
              disabled={isSaving}
              onClick={() =>
                onUpdateSetting({
                  autoPublishEnabled: mode.value !== 'manual',
                  autoPublishKillSwitchEnabled: mode.value === 'pause',
                })
              }
            >
              {mode.label}
            </button>
          ))}
        </div>
      </div>

      <details className="vk-autopost-advanced">
        <summary>Параметры</summary>
        <div className="vk-autopost-advanced__body">
          <section className="vk-advanced-group">
            <h3>Быстро</h3>
            <div className="vk-quick-preset-row" aria-label="Быстрые настройки автопостинга">
              {QUICK_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  disabled={presetDisabled}
                  title={preset.title}
                  onClick={() => {
                    onUpdateSetting({
                      autoPublishEnabled: true,
                      autoPublishKillSwitchEnabled: false,
                    });
                    onApplyPreset(preset.value);
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </section>

          <section id="vk-parsing-publish-mode" className="vk-advanced-group">
            <h3>Режим</h3>
            <div className="vk-quick-setup__row">
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
          </section>

          <section className="vk-advanced-group">
            <h3>Темп</h3>
            <div className="vk-quick-setup__row">
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
                  <span>Интервал, мин</span>
                  <input
                    type="number"
                    min={5}
                    max={10080}
                    value={customInterval}
                    disabled={sourceControlsDisabled}
                    onChange={(event) =>
                      onUpdateSources(sourceIds, {
                        publishIntervalMinutes: Number(event.target.value),
                      })
                    }
                  />
                </label>
              ) : null}
            </div>
          </section>

          <section id="vk-parsing-work-time" className="vk-advanced-group">
            <h3>Время</h3>
            <div className="vk-scheduler-grid vk-scheduler-grid--time">
              <div className="vk-time-field">
                <span>Работает с</span>
                <TimeField
                  label="Работает с"
                  value={settings.workHoursStart}
                  variant="compact"
                  disabled={isSaving}
                  onChange={(nextValue) => onUpdateSetting({ workHoursStart: nextValue })}
                />
              </div>
              <div className="vk-time-field">
                <span>Работает до</span>
                <TimeField
                  label="Работает до"
                  value={settings.workHoursEnd}
                  variant="compact"
                  disabled={isSaving}
                  onChange={(nextValue) => onUpdateSetting({ workHoursEnd: nextValue })}
                />
              </div>
              <div className="vk-time-field">
                <span>Тишина с</span>
                <TimeField
                  label="Тишина с"
                  value={settings.quietHoursStart ?? ''}
                  variant="compact"
                  allowEmpty
                  disabled={isSaving}
                  onChange={(nextValue) => onUpdateSetting({ quietHoursStart: nextValue || null })}
                />
              </div>
              <div className="vk-time-field">
                <span>Тишина до</span>
                <TimeField
                  label="Тишина до"
                  value={settings.quietHoursEnd ?? ''}
                  variant="compact"
                  allowEmpty
                  disabled={isSaving}
                  onChange={(nextValue) => onUpdateSetting({ quietHoursEnd: nextValue || null })}
                />
              </div>
            </div>
          </section>

          <section className="vk-advanced-group">
            <h3>Правила</h3>
            <div className="vk-scheduler-toggles">
              <SwitchRow
                label="Без ссылок"
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
                label="Распределять"
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
            </div>
          </section>

          <section className="vk-advanced-group">
            <h3>Защита</h3>
            <div className="vk-scheduler-protection">
              <SwitchRow
                label="Останов при всплеске"
                checked={settings.circuitBreakerEnabled}
                disabled={isSaving}
                title="Останавливать автопостинг при подозрительном всплеске"
                onChange={(checked) => onUpdateSetting({ circuitBreakerEnabled: checked })}
              />
              <label>
                <span>Окно, мин</span>
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
                <span>Порог постов</span>
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
        </div>
      </details>
    </section>
  );
}
