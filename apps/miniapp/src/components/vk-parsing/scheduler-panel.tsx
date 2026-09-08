import { CheckCircle, Clock, Pause, WarningCircle } from 'iconoir-react';
import { useState } from 'react';
import type {
  BulkUpdateVkParsingSourcesRequest,
  UpdateVkParsingSettingsRequest,
  UpdateVkParsingSourceRequest,
  VkParsingSettings,
  VkParsingSource,
} from '@maxim/contracts';
import { cn } from '../../lib/cn';
import { AsyncRadioGroup } from '../ui/async-radio-group';
import { ScheduleTimePanel } from './schedule-time-panel';
import type { AutopostStatusModel, AutopostStatusTone } from './autopost-status';
import { CommittedNumberField } from './committed-number-field';
import {
  buildVkParsingAutopostModeUpdate,
  buildVkParsingSourceIntervalUpdate,
  resolveCommonVkParsingSourceValue,
  resolveVkParsingCommonNumericInput,
  resolveVkParsingAutopostMode,
  type VkParsingAutopostMode,
} from './model';

type SchedulerPanelProps = {
  settings: VkParsingSettings;
  sources: VkParsingSource[];
  status: AutopostStatusModel;
  queueCount: number;
  publishedCount: number;
  isSaving: boolean;
  isSavingSource: boolean;
  settingsSaved: boolean;
  onUpdateSetting: (payload: UpdateVkParsingSettingsRequest) => Promise<boolean>;
  onUpdateSources: (sourceIds: string[], payload: UpdateVkParsingSourceRequest) => Promise<boolean>;
  onApplyPreset: (preset: BulkUpdateVkParsingSourcesRequest['preset']) => void;
};

const AUTOPOST_MODES: ReadonlyArray<{ value: VkParsingAutopostMode; label: string }> = [
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
  { value: 'SLOW', label: '3 часа', minutes: 180 },
  { value: 'NORMAL', label: '1 час', minutes: 60 },
  { value: 'FAST', label: '20 мин', minutes: 20 },
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
  settingsSaved,
  onUpdateSetting,
  onUpdateSources,
  onApplyPreset,
}: SchedulerPanelProps) {
  const [section, setSection] = useState<'publication' | 'time' | 'safety'>('publication');
  const sourceIds = sources.map((source) => source.id);
  const sourceMode = resolveCommonVkParsingSourceValue(sources.map((source) => source.publishMode));
  const intervalInput = resolveVkParsingCommonNumericInput(
    sources.map((source) => source.publishIntervalMinutes),
  );
  const commonInterval = intervalInput.value === '' ? null : intervalInput.value;
  const dailyLimitInput = resolveVkParsingCommonNumericInput(
    sources.map((source) => source.dailyLimit),
  );
  const frequencyPreset = commonInterval === null ? null : resolveFrequencyPreset(commonInterval);
  const sourceControlsDisabled = sourceIds.length === 0 || isSavingSource || isSaving;
  const presetDisabled = sourceIds.length === 0 || isSavingSource || isSaving;
  const autopostMode: VkParsingAutopostMode = resolveVkParsingAutopostMode(settings, sources);

  return (
    <section
      className={`vk-scheduler-panel vk-autopost-panel vk-autopost-panel--${status.tone}`}
      aria-label="Публикация VK"
    >
      <header className="vk-autopost-panel__heading">
        <h2>Автопостинг</h2>
        <span aria-live="polite">
          {isSaving || isSavingSource
            ? 'Сохраняю...'
            : settingsSaved
              ? 'Сохранено'
              : `${sources.length} ист.`}
        </span>
      </header>
      <div className="vk-autopost-panel__main" aria-label="Автопостинг">
        <div className="vk-autopost-status" role="status" aria-label="Статус автопостинга">
          <span className="vk-autopost-status__icon">{renderAutopostStatusIcon(status.tone)}</span>
          <span className="vk-autopost-status__copy">
            <strong>{status.title}</strong>
            <small>{status.reason}</small>
          </span>
        </div>

        <div className="vk-autopost-metrics" aria-label="Сводка автопостинга">
          <span>
            <b>{queueCount}</b>
            <small>В очереди</small>
          </span>
          <span>
            <b>{publishedCount}</b>
            <small>Вышло</small>
          </span>
        </div>

        <AsyncRadioGroup
          className="vk-autopost-mode"
          ariaLabel="Режим автопостинга"
          value={autopostMode}
          options={AUTOPOST_MODES}
          disabled={isSaving || isSavingSource}
          onChange={(mode) => onUpdateSetting(buildVkParsingAutopostModeUpdate(mode))}
        />
      </div>

      <div className="vk-autopost-panel__schedule">
        <Clock aria-hidden />
        <span>
          {settings.workHoursStart === settings.workHoursEnd
            ? 'Круглосуточно'
            : `${settings.workHoursStart} - ${settings.workHoursEnd}`}
        </span>
        <span>{settings.schedulerTimezone}</span>
      </div>

      <details className="vk-autopost-advanced">
        <summary>Настройки автопостинга</summary>
        <div className="vk-autopost-advanced__body">
          <div
            className="vk-scheduler-sections vk-segmented-buttons"
            role="group"
            aria-label="Раздел настроек автопостинга"
          >
            {(
              [
                { value: 'publication', label: 'Публикация' },
                { value: 'time', label: 'Время' },
                { value: 'safety', label: 'Защита' },
              ] as const
            ).map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={section === item.value}
                className={cn(section === item.value && 'is-active')}
                onClick={() => setSection(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <section className="vk-advanced-group" hidden={section !== 'publication'}>
            <h3>Пресет для всех источников</h3>
            <div className="vk-quick-preset-row" aria-label="Быстрые настройки автопостинга">
              {QUICK_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  disabled={presetDisabled}
                  title={preset.title}
                  onClick={() => onApplyPreset(preset.value)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </section>

          <section
            id="vk-parsing-publish-mode"
            className="vk-advanced-group"
            hidden={section !== 'publication'}
          >
            <h3>Режим источников{sourceMode === null && sources.length ? ' · разные' : ''}</h3>
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
                    aria-pressed={sourceMode === option.value}
                    disabled={sourceControlsDisabled}
                    onClick={() => {
                      void onUpdateSources(sourceIds, { publishMode: option.value });
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="vk-advanced-group" hidden={section !== 'publication'}>
            <h3>Темп каждого источника</h3>
            <div className="vk-tempo-controls">
              <div className="vk-tempo-controls__frequency">
                <div className="vk-segmented-buttons" role="group" aria-label="Темп публикации">
                  {FREQUENCY_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={cn(frequencyPreset === option.value && 'is-active')}
                      aria-pressed={frequencyPreset === option.value}
                      disabled={sourceControlsDisabled}
                      onClick={() => {
                        void onUpdateSources(
                          sourceIds,
                          buildVkParsingSourceIntervalUpdate(
                            option.minutes ?? CUSTOM_FREQUENCY_MINUTES,
                          ),
                        );
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {frequencyPreset === 'CUSTOM' || intervalInput.mixed ? (
                  <CommittedNumberField
                    className="vk-quick-custom-field"
                    label="Интервал, мин"
                    ariaLabel="Интервал публикаций в минутах"
                    value={intervalInput.value}
                    mixed={intervalInput.mixed}
                    min={5}
                    max={10080}
                    available={sourceIds.length > 0}
                    disabled={isSavingSource}
                    onCommit={(publishIntervalMinutes) =>
                      onUpdateSources(sourceIds, { publishIntervalMinutes })
                    }
                  />
                ) : null}
              </div>
              <CommittedNumberField
                className="vk-quick-custom-field vk-tempo-controls__daily-limit"
                label="Лимит в день"
                ariaLabel="Лимит публикаций в день"
                value={dailyLimitInput.value}
                mixed={dailyLimitInput.mixed}
                min={1}
                max={500}
                available={sourceIds.length > 0}
                disabled={isSavingSource}
                onCommit={(dailyLimit) => onUpdateSources(sourceIds, { dailyLimit })}
              />
            </div>
          </section>

          <section
            id="vk-parsing-work-time"
            className="vk-advanced-group"
            hidden={section !== 'time'}
          >
            <ScheduleTimePanel
              settings={settings}
              disabled={isSaving || isSavingSource}
              onUpdate={onUpdateSetting}
            />
          </section>

          <section className="vk-advanced-group" hidden={section !== 'safety'}>
            <h3>Контент и очередь</h3>
            <div className="vk-scheduler-toggles">
              <SwitchRow
                label="Удалять ссылки"
                checked={settings.stripLinksEnabled}
                disabled={isSaving}
                title="Удалять ссылки перед публикацией"
                onChange={(checked) => onUpdateSetting({ stripLinksEnabled: checked })}
              />
              <SwitchRow
                label="Пропускать рекламу"
                checked={settings.skipAdsEnabled}
                disabled={isSaving}
                title="Пропускать рекламные посты"
                onChange={(checked) => onUpdateSetting({ skipAdsEnabled: checked })}
              />
              <SwitchRow
                label="Равномерно по времени"
                checked={settings.distributeEvenlyEnabled}
                disabled={isSaving}
                title="Распределять публикации по рабочему времени"
                onChange={(checked) => onUpdateSetting({ distributeEvenlyEnabled: checked })}
              />
              <SwitchRow
                label="Чередовать источники"
                checked={settings.roundRobinEnabled}
                disabled={isSaving}
                title="Чередовать источники"
                onChange={(checked) => onUpdateSetting({ roundRobinEnabled: checked })}
              />
            </div>
          </section>

          <section className="vk-advanced-group" hidden={section !== 'safety'}>
            <h3>Защита от всплеска</h3>
            <div className="vk-scheduler-protection">
              <SwitchRow
                label="Приостанавливать автопостинг"
                checked={settings.circuitBreakerEnabled}
                disabled={isSaving}
                title="Останавливать автопостинг при подозрительном всплеске"
                onChange={(checked) => onUpdateSetting({ circuitBreakerEnabled: checked })}
              />
              <CommittedNumberField
                label="Окно, мин"
                ariaLabel="Окно защиты в минутах"
                min={1}
                max={1440}
                value={settings.circuitBreakerWindowMinutes}
                disabled={isSaving || isSavingSource || !settings.circuitBreakerEnabled}
                onCommit={(circuitBreakerWindowMinutes) =>
                  onUpdateSetting({ circuitBreakerWindowMinutes })
                }
              />
              <CommittedNumberField
                label="Порог постов"
                ariaLabel="Порог постов для защиты"
                min={1}
                max={500}
                value={settings.circuitBreakerPostLimit}
                disabled={isSaving || isSavingSource || !settings.circuitBreakerEnabled}
                onCommit={(circuitBreakerPostLimit) => onUpdateSetting({ circuitBreakerPostLimit })}
              />
            </div>
          </section>
        </div>
      </details>
    </section>
  );
}
