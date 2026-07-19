import {
  Clock,
  OpenNewWindow,
  PlusCircle,
  RefreshCircle,
  Settings,
  Trash,
  WarningCircle,
  Xmark,
} from 'iconoir-react';
import { useEffect, useState, type FormEvent } from 'react';
import type {
  BulkUpdateVkParsingSourcesRequest,
  UpdateVkParsingSourceRequest,
  VkParsingSource,
} from '@maxim/contracts';
import { cn } from '../../lib/cn';
import { AsyncRadioGroup } from '../ui/async-radio-group';
import { TimeField } from '../ui/time-field';
import { formatVkSourceProblem } from './format';

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
  onUpdateSource: (sourceId: string, payload: UpdateVkParsingSourceRequest) => Promise<boolean>;
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

type SourceRunMode = 'manual' | 'auto' | 'pause';

const SOURCE_RUN_MODE_OPTIONS: ReadonlyArray<{ value: SourceRunMode; label: string }> = [
  { value: 'manual', label: 'Ручной' },
  { value: 'auto', label: 'Авто' },
  { value: 'pause', label: 'Пауза' },
];

function resolveSourceRunMode(source: VkParsingSource): SourceRunMode {
  if (!source.importEnabled) {
    return 'pause';
  }
  return source.autoPublishEnabled ? 'auto' : 'manual';
}

function SourceModeControl({
  source,
  disabled,
  onChange,
}: {
  source: VkParsingSource;
  disabled: boolean;
  onChange: (mode: SourceRunMode) => Promise<boolean>;
}) {
  return (
    <AsyncRadioGroup
      className="vk-source-mode-control"
      ariaLabel={`Режим ${source.title}`}
      value={resolveSourceRunMode(source)}
      options={SOURCE_RUN_MODE_OPTIONS}
      disabled={disabled}
      onChange={onChange}
    />
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

function formatSourceNextRun(source: VkParsingSource): string {
  const value = source.nextRetryAt ?? source.nextSyncAt;
  if (!value) {
    return 'Сейчас';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
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
  const [isAddOpen, setIsAddOpen] = useState(sources.length === 0);

  useEffect(() => {
    if (sources.length === 0) {
      setIsAddOpen(true);
    }
  }, [sources.length]);

  useEffect(() => {
    if (sources.length > 0 && !isAdding && sourceUrl.length === 0) {
      setIsAddOpen(false);
    }
  }, [isAdding, sourceUrl.length, sources.length]);

  return (
    <section id="vk-parsing-source-section" className="vk-source-dashboard" aria-label="VK-группы">
      {sources.length > 0 ? (
        <div className={cn('vk-source-toolbar', isAddOpen && 'is-open')}>
          {isAddOpen ? (
            <SourceForm
              sourceUrl={sourceUrl}
              isAdding={isAdding}
              onSourceUrlChange={onSourceUrlChange}
              onSubmitSource={onSubmitSource}
            />
          ) : (
            <button
              type="button"
              className="vk-source-add-button"
              onClick={() => setIsAddOpen(true)}
            >
              <PlusCircle aria-hidden />
              Добавить
            </button>
          )}
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
          {isAddOpen ? (
            <button
              type="button"
              className="vk-parsing-icon-button"
              aria-label="Скрыть добавление"
              title="Скрыть добавление"
              onClick={() => {
                onSourceUrlChange('');
                setIsAddOpen(false);
              }}
            >
              <Xmark aria-hidden />
            </button>
          ) : null}
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
            const problem = formatVkSourceProblem(source);
            const nextRun = formatSourceNextRun(source);
            const workCount = source.newPostCount + source.queuedPostCount;
            const statusLabel = resolveSourceLabel(source);
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
                    {tone === 'warning' || tone === 'danger' ? (
                      <span className="vk-source-status" title={statusLabel}>
                        {tone === 'danger' ? <WarningCircle aria-hidden /> : <Clock aria-hidden />}
                        {statusLabel}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className={cn(
                        'vk-parsing-icon-button vk-source-settings-button',
                        selected && 'is-active',
                      )}
                      aria-label={selected ? 'Скрыть настройки' : 'Настройки источника'}
                      title="Настройки"
                      onClick={() => onSelectSource(selected ? null : source.id)}
                    >
                      <Settings aria-hidden />
                    </button>
                  </div>
                </header>

                <div className="vk-source-card__summary-row">
                  <SourceModeControl
                    source={source}
                    disabled={isSavingSource}
                    onChange={(mode) =>
                      onUpdateSource(source.id, {
                        importEnabled: mode !== 'pause',
                        autoPublishEnabled: mode === 'auto',
                      })
                    }
                  />
                  <div className="vk-source-card__metrics" aria-label="Сводка источника">
                    <span title="Следующее обновление">
                      <b>{nextRun}</b>
                      <small>Следующее</small>
                    </span>
                    <span title="Новые посты и очередь">
                      <b>{workCount}</b>
                      <small>В работе</small>
                    </span>
                    <span
                      className={source.failedPostCount > 0 ? 'is-danger' : undefined}
                      title="Ошибки публикации"
                    >
                      <b>{source.failedPostCount}</b>
                      <small>Ошибки</small>
                    </span>
                  </div>
                </div>

                {problem ? (
                  <div className="vk-source-card__problem" title={problem}>
                    <WarningCircle aria-hidden />
                    <span>{problem}</span>
                  </div>
                ) : null}

                {selected ? (
                  <div className="vk-source-config">
                    <div className="vk-source-detail-actions">
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

                    <label className="vk-source-select-all vk-source-select-all--compact">
                      <input
                        type="checkbox"
                        checked={bulkSelected}
                        onChange={() => onToggleBulkSource(source.id)}
                      />
                      <span>Массовое действие</span>
                    </label>

                    <section className="vk-source-control-group">
                      <h4>Публикация</h4>
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
                      <h4>Интервал</h4>
                      <div className="vk-source-controls">
                        <div className="vk-source-field vk-source-field--wide">
                          <span className="vk-parsing-sr-only">Частота</span>
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
                            <span>Интервал, мин</span>
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
                          <span>Минимальная пауза</span>
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
                      <h4>Пауза</h4>
                      <div className="vk-source-controls">
                        <div className="vk-time-field">
                          <span>С</span>
                          <TimeField
                            label="С"
                            value={source.quietHoursStart ?? ''}
                            variant="compact"
                            allowEmpty
                            disabled={isSavingSource}
                            onChange={(nextValue) =>
                              onUpdateSource(source.id, {
                                quietHoursStart: nextValue || null,
                              })
                            }
                          />
                        </div>
                        <div className="vk-time-field">
                          <span>До</span>
                          <TimeField
                            label="До"
                            value={source.quietHoursEnd ?? ''}
                            variant="compact"
                            allowEmpty
                            disabled={isSavingSource}
                            onChange={(nextValue) =>
                              onUpdateSource(source.id, {
                                quietHoursEnd: nextValue || null,
                              })
                            }
                          />
                        </div>
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
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
