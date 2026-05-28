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
  { value: 'NEWS', label: 'Новости' },
  { value: 'SLOW', label: 'Медленно' },
  { value: 'REVIEW', label: 'Модерация' },
  { value: 'CLEAN', label: 'Чисто' },
];

const FREQUENCY_PRESETS = [
  { value: 'FAST', label: 'Быстро', minutes: 20 },
  { value: 'NORMAL', label: 'Обычно', minutes: 60 },
  { value: 'SLOW', label: 'Редко', minutes: 180 },
  { value: 'CUSTOM', label: 'Своё', minutes: null },
] as const;

const CUSTOM_FREQUENCY_MINUTES = 90;

type FrequencyPresetValue = (typeof FREQUENCY_PRESETS)[number]['value'];

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

function formatInterval(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) {
    return `${minutes / 1440}д`;
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    return `${minutes / 60}ч`;
  }
  return `${minutes}м`;
}

function formatSourceMode(source: VkParsingSource): string {
  if (!source.autoPublishEnabled) {
    return 'Ручной';
  }
  if (source.publishMode === 'IMMEDIATE') {
    return 'Сразу';
  }
  if (source.publishMode === 'REVIEW') {
    return 'Ручной';
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
    <section className="vk-source-dashboard" aria-label="VK-группы">
      <div className="vk-parsing-command">
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
        <div className="vk-source-empty">Добавьте источник VK</div>
      ) : (
        <div className="vk-source-grid">
          {sources.map((source) => {
            const tone = resolveSourceTone(source);
            const selected = selectedSourceId === source.id;
            const bulkSelected = selectedBulkSourceIds.includes(source.id);
            const frequencyPreset = resolveFrequencyPreset(source.publishIntervalMinutes);
            const sourceFacts = [
              {
                label: 'Импорт',
                value: formatShortDate(source.lastSuccessAt ?? source.lastSyncAt),
                title: 'Последний импорт',
              },
              {
                label: 'Очередь',
                value: String(source.queuedPostCount),
                title: 'Постов в очереди',
              },
              {
                label: 'Авто',
                value: formatSourceMode(source),
                title: 'Режим публикации',
              },
            ];
            if (selected) {
              sourceFacts.push(
                {
                  label: 'След.',
                  value: formatShortDate(source.nextRetryAt ?? source.nextSyncAt),
                  title: 'Следующий импорт',
                },
                {
                  label: 'Шаг',
                  value: formatInterval(source.publishIntervalMinutes),
                  title: 'Интервал публикации',
                },
              );
            }
            if (source.failedPostCount > 0) {
              sourceFacts.push({
                label: 'Ошибки',
                value: String(source.failedPostCount),
                title: 'Ошибки публикации',
              });
            }
            return (
              <article
                key={source.id}
                className={cn(
                  'vk-source-card',
                  `vk-source-card--${tone}`,
                  selected && 'is-selected',
                )}
              >
                <header className="vk-source-card__head">
                  <label className="vk-source-card__check">
                    <input
                      type="checkbox"
                      checked={bulkSelected}
                      onChange={() => onToggleBulkSource(source.id)}
                    />
                    <span className="vk-parsing-sr-only">{source.title}</span>
                  </label>
                  <button
                    type="button"
                    className="vk-source-card__title"
                    onClick={() => onSelectSource(selected ? null : source.id)}
                  >
                    <strong>{source.title}</strong>
                    <span>{source.screenName}</span>
                  </button>
                  <span className="vk-source-status">
                    {tone === 'danger' ? <WarningCircle aria-hidden /> : <Clock aria-hidden />}
                    {resolveSourceLabel(source)}
                  </span>
                </header>

                <div className="vk-source-card__facts">
                  {sourceFacts.map((fact) => (
                    <span key={fact.label} title={fact.title}>
                      <b>{fact.label}</b>
                      {fact.value}
                    </span>
                  ))}
                </div>

                <div className="vk-source-card__actions">
                  <button
                    type="button"
                    className="vk-parsing-icon-button"
                    aria-label={source.importEnabled ? 'Пауза' : 'Включить'}
                    title={source.importEnabled ? 'Пауза' : 'Включить'}
                    disabled={isSavingSource}
                    onClick={() =>
                      onUpdateSource(source.id, { importEnabled: !source.importEnabled })
                    }
                  >
                    {source.importEnabled ? <Pause aria-hidden /> : <Play aria-hidden />}
                  </button>
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

                {selected ? (
                  <div className="vk-source-controls">
                    <div className="vk-source-toggle">
                      <span>Импорт</span>
                      <NativeSwitch
                        checked={source.importEnabled}
                        disabled={isSavingSource}
                        label="Импорт"
                        onChange={(checked) =>
                          onUpdateSource(source.id, { importEnabled: checked })
                        }
                      />
                    </div>
                    <div className="vk-source-toggle">
                      <span>Авто</span>
                      <NativeSwitch
                        checked={source.autoPublishEnabled}
                        disabled={isSavingSource}
                        label="Автопубликация"
                        onChange={(checked) =>
                          onUpdateSource(source.id, { autoPublishEnabled: checked })
                        }
                      />
                    </div>
                    <label>
                      <span>Частота</span>
                      <select
                        value={frequencyPreset}
                        onChange={(event) => {
                          const nextPreset = FREQUENCY_PRESETS.find(
                            (item) => item.value === event.target.value,
                          );
                          onUpdateSource(source.id, {
                            publishIntervalMinutes: nextPreset?.minutes ?? CUSTOM_FREQUENCY_MINUTES,
                          });
                        }}
                      >
                        {FREQUENCY_PRESETS.map((preset) => (
                          <option key={preset.value} value={preset.value}>
                            {preset.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {frequencyPreset === 'CUSTOM' ? (
                      <label>
                        <span>Мин</span>
                        <input
                          type="number"
                          min={5}
                          max={10080}
                          value={source.publishIntervalMinutes}
                          onChange={(event) =>
                            onUpdateSource(source.id, {
                              publishIntervalMinutes: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                    ) : null}
                    <label>
                      <span>Лимит</span>
                      <input
                        type="number"
                        min={1}
                        max={500}
                        value={source.dailyLimit}
                        onChange={(event) =>
                          onUpdateSource(source.id, { dailyLimit: Number(event.target.value) })
                        }
                      />
                    </label>
                    <label>
                      <span>Пауза</span>
                      <input
                        type="number"
                        min={0}
                        max={1440}
                        value={source.minPublishIntervalMinutes}
                        onChange={(event) =>
                          onUpdateSource(source.id, {
                            minPublishIntervalMinutes: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>Режим</span>
                      <select
                        value={source.publishMode}
                        onChange={(event) =>
                          onUpdateSource(source.id, {
                            publishMode: event.target
                              .value as UpdateVkParsingSourceRequest['publishMode'],
                          })
                        }
                      >
                        <option value="IMMEDIATE">Сразу</option>
                        <option value="QUEUE">Очередь</option>
                        <option value="REVIEW">Ручной</option>
                      </select>
                    </label>
                    <label>
                      <span>Приор.</span>
                      <select
                        value={source.priority}
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
                    <label>
                      <span>Тихо с</span>
                      <input
                        type="time"
                        value={source.quietHoursStart ?? ''}
                        onChange={(event) =>
                          onUpdateSource(source.id, { quietHoursStart: event.target.value || null })
                        }
                      />
                    </label>
                    <label>
                      <span>Тихо до</span>
                      <input
                        type="time"
                        value={source.quietHoursEnd ?? ''}
                        onChange={(event) =>
                          onUpdateSource(source.id, { quietHoursEnd: event.target.value || null })
                        }
                      />
                    </label>
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
