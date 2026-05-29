import {
  Clock,
  OpenNewWindow,
  Pause,
  Play,
  PlusCircle,
  RefreshCircle,
  Trash,
  WarningCircle,
} from 'iconoir-react';
import type { FormEvent } from 'react';
import type {
  BulkUpdateVkParsingSourcesRequest,
  UpdateVkParsingSourceRequest,
  VkParsingSource,
} from '@maxim/contracts';
import { cn } from '../../lib/cn';

type SourceDashboardProps = {
  sourceUrl: string;
  sources: VkParsingSource[];
  selectedSourceId: string | null;
  selectedBulkSourceIds: string[];
  isAdding: boolean;
  isRefreshing: boolean;
  isRemoving: boolean;
  isSavingSource: boolean;
  isApplyingPreset: boolean;
  refreshingSourceId: string | null;
  onSourceUrlChange: (value: string) => void;
  onSubmitSource: (event: FormEvent<HTMLFormElement>) => void;
  onSelectSource: (sourceId: string | null) => void;
  onToggleBulkSource: (sourceId: string) => void;
  onSelectAllBulkSources: () => void;
  onApplyPreset: (preset: BulkUpdateVkParsingSourcesRequest['preset']) => void;
  onUpdateSource: (sourceId: string, payload: UpdateVkParsingSourceRequest) => void;
  onRefresh: () => void;
  onRefreshSource: (sourceId: string) => void;
  onRemoveSource: (sourceId: string) => void;
};

const PRESETS: Array<{ value: BulkUpdateVkParsingSourcesRequest['preset']; label: string }> = [
  { value: 'CLEAN', label: 'Безопасно' },
  { value: 'SLOW', label: 'Обычно' },
  { value: 'NEWS', label: 'Активно' },
];

const FREQUENCY_PRESETS = [
  { value: 'SLOW', label: 'Редко', minutes: 180 },
  { value: 'NORMAL', label: 'Норма', minutes: 60 },
  { value: 'FAST', label: 'Чаще', minutes: 20 },
  { value: 'CUSTOM', label: 'Свой', minutes: null },
] as const;

const CUSTOM_FREQUENCY_MINUTES = 90;

type FrequencyPresetValue = (typeof FREQUENCY_PRESETS)[number]['value'];
type SourceModeValue = NonNullable<UpdateVkParsingSourceRequest['publishMode']>;

const SOURCE_MODE_OPTIONS: Array<{ value: SourceModeValue; label: string }> = [
  { value: 'IMMEDIATE', label: 'Сразу' },
  { value: 'QUEUE', label: 'Очередь' },
  { value: 'REVIEW', label: 'Проверка' },
];

function NativeSwitch({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label className="settings-native-switch" aria-label={label}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-switch" aria-hidden>
        <span className="toggle-switch__thumb" />
      </span>
    </label>
  );
}

function SourceAutoControl({
  source,
  disabled,
  onChange,
}: {
  source: VkParsingSource;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const active = source.importEnabled && source.autoPublishEnabled;
  return (
    <label
      className={cn(
        'vk-source-auto-control',
        active && 'is-on',
        !source.importEnabled && 'is-paused',
      )}
      title="Автопостинг источника"
    >
      <span>
        <b>Авто</b>
        <small>{source.importEnabled ? formatSourceMode(source) : 'Пауза'}</small>
      </span>
      <NativeSwitch
        checked={active}
        disabled={disabled || !source.importEnabled}
        label={`Автопостинг ${source.title}`}
        onChange={onChange}
      />
    </label>
  );
}

function SourceForm({
  sourceUrl,
  isAdding,
  onSourceUrlChange,
  onSubmitSource,
}: {
  sourceUrl: string;
  isAdding: boolean;
  onSourceUrlChange: (value: string) => void;
  onSubmitSource: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="vk-parsing-card__source-form" onSubmit={onSubmitSource}>
      <label className="vk-parsing-source-input">
        <span className="vk-parsing-sr-only">Источник VK</span>
        <input
          type="text"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={sourceUrl}
          onChange={(event) => onSourceUrlChange(event.target.value)}
          placeholder="vk.com/..."
          disabled={isAdding}
        />
      </label>
      <button
        type="submit"
        className="vk-parsing-icon-button vk-parsing-icon-button--accent"
        aria-label="Добавить источник"
        title="Добавить источник"
        disabled={isAdding || !sourceUrl.trim()}
      >
        <PlusCircle aria-hidden />
      </button>
    </form>
  );
}

function formatShortDate(value: string | null): string {
  if (!value) {
    return '-';
  }
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(new Date(value))
    .replace(',', '');
}

function resolveSourceTone(source: VkParsingSource): 'active' | 'paused' | 'warning' | 'danger' {
  if (source.syncStatus === 'ERROR' || source.autoPublishPausedReason === 'circuit_breaker') {
    return 'danger';
  }
  if (!source.importEnabled) {
    return 'paused';
  }
  if (
    source.syncStatus === 'QUEUED' ||
    source.syncStatus === 'SYNCING' ||
    source.syncStatus === 'BACKOFF'
  ) {
    return 'warning';
  }
  return 'active';
}

function resolveSourceLabel(source: VkParsingSource): string {
  if (source.autoPublishPausedReason === 'circuit_breaker') {
    return 'Ошибка';
  }
  if (!source.importEnabled) {
    return 'Пауза';
  }
  if (source.syncStatus === 'QUEUED') {
    return 'Очередь';
  }
  if (source.syncStatus === 'SYNCING') {
    return 'Обновление';
  }
  if (source.syncStatus === 'BACKOFF') {
    return 'Повтор';
  }
  return 'Активно';
}

function formatSourceMode(source: VkParsingSource): string {
  if (!source.autoPublishEnabled) {
    return 'Выкл';
  }
  if (source.publishMode === 'IMMEDIATE') {
    return 'Сразу';
  }
  if (source.publishMode === 'REVIEW') {
    return 'Проверка';
  }
  return 'Очередь';
}

function resolveFrequencyPreset(minutes: number): FrequencyPresetValue {
  const preset = FREQUENCY_PRESETS.find((item) => item.minutes === minutes);
  return preset?.value ?? 'CUSTOM';
}

export function SourceDashboard({
  sourceUrl,
  sources,
  selectedSourceId,
  selectedBulkSourceIds,
  isAdding,
  isRefreshing,
  isRemoving,
  isSavingSource,
  isApplyingPreset,
  refreshingSourceId,
  onSourceUrlChange,
  onSubmitSource,
  onSelectSource,
  onToggleBulkSource,
  onSelectAllBulkSources,
  onApplyPreset,
  onUpdateSource,
  onRefresh,
  onRefreshSource,
  onRemoveSource,
}: SourceDashboardProps) {
  const allSelected = sources.length > 0 && selectedBulkSourceIds.length === sources.length;

  return (
    <section id="vk-parsing-source-section" className="vk-source-dashboard" aria-label="VK-группы">
      {sources.length > 0 ? (
        <div className="vk-parsing-command">
          <SourceForm
            sourceUrl={sourceUrl}
            isAdding={isAdding}
            onSourceUrlChange={onSourceUrlChange}
            onSubmitSource={onSubmitSource}
          />
          <button
            type="button"
            className="vk-parsing-icon-button"
            aria-label="Обновить все"
            title="Обновить все"
            disabled={isRefreshing || sources.length === 0}
            onClick={onRefresh}
          >
            <RefreshCircle aria-hidden />
          </button>
        </div>
      ) : null}

      {selectedBulkSourceIds.length > 0 ? (
        <div className="vk-source-bulk">
          <label className="vk-source-select-all">
            <input type="checkbox" checked={allSelected} onChange={onSelectAllBulkSources} />
            <span>{selectedBulkSourceIds.length}</span>
          </label>
          {PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              className="vk-source-preset"
              disabled={selectedBulkSourceIds.length === 0 || isApplyingPreset}
              onClick={() => onApplyPreset(preset.value)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      ) : null}

      {sources.length === 0 ? (
        <div className="vk-source-empty">
          <SourceForm
            sourceUrl={sourceUrl}
            isAdding={isAdding}
            onSourceUrlChange={onSourceUrlChange}
            onSubmitSource={onSubmitSource}
          />
        </div>
      ) : (
        <div className="vk-source-grid">
          {sources.map((source) => {
            const tone = resolveSourceTone(source);
            const selected = selectedSourceId === source.id;
            const bulkSelected = selectedBulkSourceIds.includes(source.id);
            const frequencyPreset = resolveFrequencyPreset(source.publishIntervalMinutes);
            return (
              <article
                key={source.id}
                className={cn(
                  'vk-source-card',
                  `vk-source-card--${tone}`,
                  source.importEnabled && source.autoPublishEnabled && 'is-autopublish',
                  selected && 'is-selected',
                )}
              >
                <header className="vk-source-card__head">
                  <button
                    type="button"
                    className="vk-source-card__title"
                    onClick={() => onSelectSource(selected ? null : source.id)}
                  >
                    <strong>{source.title}</strong>
                    <span>{source.screenName}</span>
                  </button>
                  <div className="vk-source-card__tools">
                    <span className="vk-source-status">
                      {tone === 'danger' ? <WarningCircle aria-hidden /> : <Clock aria-hidden />}
                      {resolveSourceLabel(source)}
                    </span>
                    <button
                      type="button"
                      className="vk-parsing-icon-button vk-source-card__pause"
                      aria-label={source.importEnabled ? 'Поставить на паузу' : 'Включить'}
                      title={source.importEnabled ? 'Пауза' : 'Включить'}
                      disabled={isSavingSource}
                      onClick={() =>
                        onUpdateSource(source.id, { importEnabled: !source.importEnabled })
                      }
                    >
                      {source.importEnabled ? <Pause aria-hidden /> : <Play aria-hidden />}
                    </button>
                  </div>
                </header>

                <div className="vk-source-card__main-row">
                  <SourceAutoControl
                    source={source}
                    disabled={isSavingSource || !source.importEnabled}
                    onChange={(checked) =>
                      onUpdateSource(source.id, { autoPublishEnabled: checked })
                    }
                  />
                  <div className="vk-source-card__metrics" aria-label="Сводка источника">
                    <span title="Следующее обновление">
                      <b>{formatShortDate(source.nextRetryAt ?? source.nextSyncAt)}</b>
                      <small>Обнов.</small>
                    </span>
                    <span title="Постов в очереди">
                      <b>{source.queuedPostCount}</b>
                      <small>Очередь</small>
                    </span>
                    <span title="Ошибки публикации">
                      <b>{source.failedPostCount}</b>
                      <small>Ошибки</small>
                    </span>
                  </div>
                </div>

                <details
                  className="vk-source-details"
                  open={selected}
                  onToggle={(event) => {
                    const nextOpen = event.currentTarget.open;
                    if (nextOpen !== selected) {
                      onSelectSource(nextOpen ? source.id : null);
                    }
                  }}
                >
                  <summary>Настройки</summary>

                  {selected ? (
                    <div className="vk-source-config">
                      <div className="vk-source-detail-actions">
                        <label className="vk-source-select-all vk-source-select-all--compact">
                          <input
                            type="checkbox"
                            checked={bulkSelected}
                            onChange={() => onToggleBulkSource(source.id)}
                          />
                          <span>Выбрать</span>
                        </label>
                        <button
                          type="button"
                          className="vk-parsing-icon-button"
                          aria-label="Обновить"
                          title="Обновить"
                          disabled={refreshingSourceId === source.id || !source.importEnabled}
                          onClick={() => onRefreshSource(source.id)}
                        >
                          <RefreshCircle aria-hidden />
                        </button>
                        <a
                          className="vk-parsing-icon-button"
                          aria-label="Открыть VK"
                          title="Открыть VK"
                          href={source.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <OpenNewWindow aria-hidden />
                        </a>
                        <button
                          type="button"
                          className="vk-parsing-icon-button vk-parsing-icon-button--danger"
                          aria-label="Удалить"
                          title="Удалить"
                          disabled={isRemoving}
                          onClick={() => onRemoveSource(source.id)}
                        >
                          <Trash aria-hidden />
                        </button>
                      </div>

                      <div className="vk-source-detail-strip">
                        <span title="Опубликовано из источника">
                          <b>Опубл.</b>
                          {source.publishedPostCount}
                        </span>
                        <span title="Следующее обновление">
                          <b>Обнов.</b>
                          {formatShortDate(source.nextRetryAt ?? source.nextSyncAt)}
                        </span>
                        <span title="Постов в очереди">
                          <b>Очередь</b>
                          {source.queuedPostCount}
                        </span>
                        <span title="Ошибки публикации">
                          <b>Ошибки</b>
                          {source.failedPostCount}
                        </span>
                      </div>

                      <section className="vk-source-control-group">
                        <h4>Режим</h4>
                        <div className="vk-source-controls">
                          <div className="vk-source-field vk-source-field--wide">
                            <div
                              className="vk-segmented-buttons vk-segmented-buttons--mode"
                              role="group"
                            >
                              {SOURCE_MODE_OPTIONS.map((option) => (
                                <button
                                  key={option.value}
                                  type="button"
                                  className={cn(source.publishMode === option.value && 'is-active')}
                                  disabled={isSavingSource}
                                  onClick={() =>
                                    onUpdateSource(source.id, { publishMode: option.value })
                                  }
                                >
                                  {option.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      </section>

                      <section className="vk-source-control-group">
                        <h4>Темп</h4>
                        <div className="vk-source-controls">
                          <div className="vk-source-field vk-source-field--wide">
                            <span>Частота</span>
                            <div className="vk-segmented-buttons" role="group">
                              {FREQUENCY_PRESETS.map((preset) => (
                                <button
                                  key={preset.value}
                                  type="button"
                                  className={cn(frequencyPreset === preset.value && 'is-active')}
                                  disabled={isSavingSource}
                                  onClick={() =>
                                    onUpdateSource(source.id, {
                                      publishIntervalMinutes:
                                        preset.minutes ?? CUSTOM_FREQUENCY_MINUTES,
                                    })
                                  }
                                >
                                  {preset.label}
                                </button>
                              ))}
                            </div>
                          </div>
                          {frequencyPreset === 'CUSTOM' ? (
                            <label>
                              <span>Мин</span>
                              <input
                                type="number"
                                min={5}
                                max={10080}
                                value={source.publishIntervalMinutes}
                                disabled={isSavingSource}
                                onChange={(event) =>
                                  onUpdateSource(source.id, {
                                    publishIntervalMinutes: Number(event.target.value),
                                  })
                                }
                              />
                            </label>
                          ) : null}
                          <label>
                            <span>Мин. пауза</span>
                            <input
                              type="number"
                              min={0}
                              max={1440}
                              value={source.minPublishIntervalMinutes}
                              disabled={isSavingSource}
                              onChange={(event) =>
                                onUpdateSource(source.id, {
                                  minPublishIntervalMinutes: Number(event.target.value),
                                })
                              }
                            />
                          </label>
                        </div>
                      </section>

                      <section className="vk-source-control-group">
                        <h4>Тихие часы</h4>
                        <div className="vk-source-controls">
                          <label>
                            <span>С</span>
                            <input
                              type="time"
                              value={source.quietHoursStart ?? ''}
                              disabled={isSavingSource}
                              onChange={(event) =>
                                onUpdateSource(source.id, {
                                  quietHoursStart: event.target.value || null,
                                })
                              }
                            />
                          </label>
                          <label>
                            <span>До</span>
                            <input
                              type="time"
                              value={source.quietHoursEnd ?? ''}
                              disabled={isSavingSource}
                              onChange={(event) =>
                                onUpdateSource(source.id, {
                                  quietHoursEnd: event.target.value || null,
                                })
                              }
                            />
                          </label>
                        </div>
                      </section>

                      <section className="vk-source-control-group">
                        <h4>Лимиты</h4>
                        <div className="vk-source-controls">
                          <label>
                            <span>Лимит в день</span>
                            <input
                              type="number"
                              min={1}
                              max={500}
                              value={source.dailyLimit}
                              disabled={isSavingSource}
                              onChange={(event) =>
                                onUpdateSource(source.id, {
                                  dailyLimit: Number(event.target.value),
                                })
                              }
                            />
                          </label>
                          <label>
                            <span>Приоритет</span>
                            <select
                              value={source.priority}
                              disabled={isSavingSource}
                              onChange={(event) =>
                                onUpdateSource(source.id, {
                                  priority: event.target
                                    .value as UpdateVkParsingSourceRequest['priority'],
                                })
                              }
                            >
                              <option value="HIGH">Высокий</option>
                              <option value="NORMAL">Обычный</option>
                              <option value="LOW">Низкий</option>
                            </select>
                          </label>
                        </div>
                      </section>
                    </div>
                  ) : null}
                </details>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
