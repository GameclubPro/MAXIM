import { type FormEvent } from 'react';
import { InfoCircleSolid, PlusCircle, RefreshCircle, Trash } from 'iconoir-react';
import type { VkParsingSource } from '@maxim/contracts';
import { cn } from '../../lib/cn';
import { formatVkSourceSyncLabel } from './format';
import { SOURCE_HINT, type VkParsingHintKey } from './types';

type SourcesBarProps = {
  sourceUrl: string;
  sources: VkParsingSource[];
  selectedSourceId: string | null;
  openHintKey: VkParsingHintKey | null;
  isAdding: boolean;
  isRefreshing: boolean;
  isRemoving: boolean;
  onSourceUrlChange: (value: string) => void;
  onSubmitSource: (event: FormEvent<HTMLFormElement>) => void;
  onToggleHint: (key: VkParsingHintKey) => void;
  onRefresh: () => void;
  onSelectSource: (sourceId: string | null) => void;
  onRemoveSource: (sourceId: string) => void;
};

function formatSourceErrorTitle(source: VkParsingSource): string | undefined {
  if (!source.lastError && !source.lastErrorCode) {
    return undefined;
  }

  return [source.lastErrorCode, source.lastError].filter(Boolean).join(': ');
}

export function SourcesBar({
  sourceUrl,
  sources,
  selectedSourceId,
  openHintKey,
  isAdding,
  isRefreshing,
  isRemoving,
  onSourceUrlChange,
  onSubmitSource,
  onToggleHint,
  onRefresh,
  onSelectSource,
  onRemoveSource,
}: SourcesBarProps) {
  return (
    <>
      <div className="vk-parsing-command">
        <form className="vk-parsing-card__source-form" onSubmit={onSubmitSource}>
          <label className="vk-parsing-source-input">
            <span className="vk-parsing-sr-only">Источник VK</span>
            <input
              type="url"
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
          className={cn('vk-parsing-icon-button', openHintKey === 'source' && 'is-active')}
          aria-label="О VK-источниках"
          aria-expanded={openHintKey === 'source'}
          aria-controls="vk-parsing-source-hint"
          title="О VK-источниках"
          onClick={() => onToggleHint('source')}
        >
          <InfoCircleSolid aria-hidden />
        </button>

        <button
          type="button"
          className="vk-parsing-icon-button"
          aria-label="Обновить посты"
          title="Обновить посты"
          disabled={isRefreshing || sources.length === 0}
          onClick={onRefresh}
        >
          <RefreshCircle aria-hidden />
        </button>
        {openHintKey === 'source' ? (
          <div id="vk-parsing-source-hint" className="vk-parsing-hint-popover" role="status">
            {SOURCE_HINT}
          </div>
        ) : null}
      </div>

      {sources.length > 0 ? (
        <div className="vk-parsing-card__sources" aria-label="VK источники">
          {sources.length > 1 ? (
            <span className={cn('vk-parsing-source-chip', !selectedSourceId && 'is-selected')}>
              <button
                type="button"
                className="vk-parsing-source-chip__select vk-parsing-source-chip__select--all"
                aria-pressed={!selectedSourceId}
                onClick={() => onSelectSource(null)}
              >
                Все
              </button>
            </span>
          ) : null}
          {sources.map((source) => {
            const syncLabel = formatVkSourceSyncLabel(source);
            const errorTitle = formatSourceErrorTitle(source);
            return (
              <span
                key={source.id}
                className={cn(
                  'vk-parsing-source-chip',
                  selectedSourceId === source.id && 'is-selected',
                  source.syncStatus === 'SYNCING' && 'is-syncing',
                  source.syncStatus === 'BACKOFF' && 'is-backoff',
                  (source.syncStatus === 'ERROR' || source.syncStatus === 'BACKOFF') && 'has-error',
                )}
              >
                <button
                  type="button"
                  className="vk-parsing-source-chip__select"
                  aria-pressed={selectedSourceId === source.id}
                  title={source.title}
                  onClick={() => onSelectSource(source.id)}
                >
                  <span>{source.title}</span>
                </button>
                {syncLabel ? <small title={errorTitle ?? undefined}>{syncLabel}</small> : null}
                <button
                  type="button"
                  className="vk-parsing-source-chip__remove"
                  aria-label={`Отключить источник ${source.title}`}
                  title="Отключить источник"
                  disabled={isRemoving}
                  onClick={() => onRemoveSource(source.id)}
                >
                  <Trash aria-hidden />
                </button>
              </span>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
