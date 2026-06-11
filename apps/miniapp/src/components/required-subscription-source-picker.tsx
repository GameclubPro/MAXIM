import type { ManagedEntityHeader } from '@maxim/contracts/managed-entities';
import {
  useEffect,
  useDeferredValue,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type UIEvent,
} from 'react';
import { filterBroadcastAudienceChoices } from '../lib/broadcast-audience-search';
import { cn } from '../lib/cn';
import { resolveVirtualListRange } from '../lib/virtual-list';
import { EntityAvatar } from './ui/entity-avatar';
import { SegmentedControl, type SegmentedOption } from './ui/segmented-control';

type RequiredSubscriptionSourceFilter = 'all' | 'channel' | 'chat';

export type RequiredSubscriptionSourcePickerProps = {
  choices: ManagedEntityHeader[];
  selectedCount: number;
  maxSelectedCount: number;
  loading: boolean;
  syncing: boolean;
  error: string | null;
  backoffActive: boolean;
  emptyState: string;
  onAdd: (channelId: string) => void;
  onRefresh: () => void;
};

const SOURCE_PICKER_ROW_HEIGHT = 70;
const SOURCE_PICKER_MAX_VISIBLE_ROWS = 6;
const SOURCE_PICKER_OVERSCAN = 4;

function formatSourceLinkPreview(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  try {
    const url = new URL(normalized);
    const host = url.hostname.replace(/^www\./u, '');
    const pathTail = url.pathname.split('/').filter(Boolean).at(-1);
    return pathTail ? `${host}/${decodeURIComponent(pathTail)}` : host;
  } catch {
    return normalized.length > 42 ? `${normalized.slice(0, 39)}...` : normalized;
  }
}

function formatSourceTypeLabel(entityType: ManagedEntityHeader['entityType']): string {
  return entityType === 'channel' ? 'Канал' : 'Чат';
}

function formatSourceCount(count: number, fallback: string): string {
  if (count <= 0) {
    return fallback;
  }

  const normalized = Math.max(0, Math.trunc(count));
  const mod10 = normalized % 10;
  const mod100 = normalized % 100;
  const noun =
    mod10 === 1 && mod100 !== 11
      ? 'источник'
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? 'источника'
        : 'источников';

  return `${normalized} ${noun}`;
}

function getFilteredChoices(
  choices: ManagedEntityHeader[],
  filter: RequiredSubscriptionSourceFilter,
  query: string,
): ManagedEntityHeader[] {
  const typedChoices =
    filter === 'all' ? choices : choices.filter((choice) => choice.entityType === filter);
  return filterBroadcastAudienceChoices(typedChoices, query);
}

export function RequiredSubscriptionSourcePicker({
  choices,
  selectedCount,
  maxSelectedCount,
  loading,
  syncing,
  error,
  backoffActive,
  emptyState,
  onAdd,
  onRefresh,
}: RequiredSubscriptionSourcePickerProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RequiredSubscriptionSourceFilter>('all');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(
    SOURCE_PICKER_ROW_HEIGHT * SOURCE_PICKER_MAX_VISIBLE_ROWS,
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const trimmedQuery = query.trim();
  const deferredQuery = useDeferredValue(trimmedQuery);
  const choiceCounts = useMemo(
    () => ({
      all: choices.length,
      channel: choices.filter((choice) => choice.entityType === 'channel').length,
      chat: choices.filter((choice) => choice.entityType === 'chat').length,
    }),
    [choices],
  );
  const filterOptions = useMemo<Array<SegmentedOption<RequiredSubscriptionSourceFilter>>>(
    () => [
      { value: 'all', label: 'Все', count: choiceCounts.all },
      { value: 'channel', label: 'Каналы', count: choiceCounts.channel },
      { value: 'chat', label: 'Чаты', count: choiceCounts.chat },
    ],
    [choiceCounts],
  );
  const filteredChoices = useMemo(
    () => getFilteredChoices(choices, filter, deferredQuery),
    [choices, deferredQuery, filter],
  );
  const hasReachedLimit = selectedCount >= maxSelectedCount;
  const listHeight =
    filteredChoices.length > 0
      ? Math.min(
          filteredChoices.length * SOURCE_PICKER_ROW_HEIGHT,
          SOURCE_PICKER_ROW_HEIGHT * SOURCE_PICKER_MAX_VISIBLE_ROWS,
        )
      : 0;
  const virtualRange = useMemo(
    () =>
      resolveVirtualListRange({
        itemCount: filteredChoices.length,
        scrollTop,
        viewportHeight: viewportHeight || listHeight,
        rowHeight: SOURCE_PICKER_ROW_HEIGHT,
        overscan: SOURCE_PICKER_OVERSCAN,
      }),
    [filteredChoices.length, listHeight, scrollTop, viewportHeight],
  );
  const visibleChoices = filteredChoices.slice(virtualRange.startIndex, virtualRange.endIndex);
  const visibleOffset = virtualRange.startIndex * SOURCE_PICKER_ROW_HEIGHT;
  const statusText = loading
    ? 'Загружаем список с главной...'
    : syncing
      ? 'Синхронизируем чаты и каналы...'
      : error
        ? `Ошибка загрузки списка: ${error}`
        : backoffActive
          ? 'MAX временно ограничил обновление. Повторите позже.'
          : hasReachedLimit
            ? `Лимит ${maxSelectedCount} источников достигнут.`
            : formatSourceCount(filteredChoices.length, emptyState);
  const emptySearchText = trimmedQuery
    ? 'Ничего не нашли. Очистите поиск или добавьте источник ссылкой ниже.'
    : emptyState;

  useEffect(() => {
    setScrollTop(0);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [deferredQuery, filter]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const observer = new ResizeObserver(([entry]) => {
      setViewportHeight(Math.max(0, entry?.contentRect.height ?? element.clientHeight));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    setScrollTop(event.currentTarget.scrollTop);
  }

  return (
    <div className="required-subscription__source-picker">
      <div className="required-subscription__source-toolbar">
        <label className="required-subscription__source-search">
          <span className="sr-only">Поиск чата или канала</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Найти по названию, ссылке или ID"
            autoComplete="off"
          />
        </label>
        <button
          type="button"
          className="button button--ghost required-subscription__source-refresh"
          disabled={loading || syncing}
          onClick={onRefresh}
        >
          {syncing ? 'Обновляем...' : 'Обновить'}
        </button>
      </div>

      <SegmentedControl
        value={filter}
        options={filterOptions}
        onChange={setFilter}
        className="required-subscription__source-segments"
        ariaLabel="Фильтр источников обязательной подписки"
      />

      <div
        className={cn(
          'required-subscription__source-status',
          error && 'is-danger',
          backoffActive && !error && 'is-warning',
        )}
        aria-live="polite"
      >
        <span>{statusText}</span>
        {trimmedQuery ? (
          <button type="button" onClick={() => setQuery('')}>
            Очистить поиск
          </button>
        ) : null}
      </div>

      {loading ? (
        <div className="required-subscription__source-skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ) : null}

      {!loading && !error && filteredChoices.length > 0 ? (
        <div
          ref={scrollRef}
          className="required-subscription__source-list"
          style={{ '--required-subscription-source-list-height': `${listHeight}px` } as CSSProperties}
          onScroll={handleScroll}
          role="listbox"
          aria-label="Доступные чаты и каналы для обязательной подписки"
        >
          <div
            className="required-subscription__source-list-spacer"
            style={{ height: `${virtualRange.totalHeight}px` }}
          >
            <div
              className="required-subscription__source-list-window"
              style={{ transform: `translateY(${visibleOffset}px)` }}
            >
              {visibleChoices.map((choice) => {
                const linkPreview = formatSourceLinkPreview(choice.link);
                const typeLabel = formatSourceTypeLabel(choice.entityType);

                return (
                  <button
                    key={`required-subscription-source-${choice.id}`}
                    type="button"
                    className="required-subscription__source-card"
                    onClick={() => onAdd(choice.id)}
                    disabled={hasReachedLimit}
                    role="option"
                    aria-selected="false"
                    aria-label={`Добавить ${typeLabel.toLowerCase()} ${choice.title}`}
                  >
                    <EntityAvatar
                      title={choice.title}
                      entityType={choice.entityType}
                      avatarUrl={choice.avatarUrl ?? null}
                      className="required-subscription__source-avatar"
                    />
                    <span className="required-subscription__source-copy">
                      <strong className="required-subscription__source-title">{choice.title}</strong>
                      <span className="required-subscription__source-meta">
                        <span className="required-subscription__source-type">{typeLabel}</span>
                        <span className="required-subscription__source-link">
                          {linkPreview ?? choice.id}
                        </span>
                      </span>
                    </span>
                    <span className="required-subscription__source-add" aria-hidden="true">
                      +
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}

      {!loading && !error && filteredChoices.length === 0 ? (
        <div className="required-subscription__source-empty">
          <strong>{trimmedQuery ? 'Ничего не найдено' : 'Список пуст'}</strong>
          <span>{emptySearchText}</span>
        </div>
      ) : null}
    </div>
  );
}
