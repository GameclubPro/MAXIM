import type { ManagedEntityHeader } from '@maxim/contracts/managed-entities';
import {
  useEffect,
  useDeferredValue,
  memo,
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
const SOURCE_PICKER_VIRTUALIZE_THRESHOLD = 40;

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

function useIsFinePointer(): boolean {
  const [isFinePointer, setIsFinePointer] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }

    const query = window.matchMedia('(hover: hover) and (pointer: fine)');
    const handleChange = () => setIsFinePointer(query.matches);
    handleChange();
    query.addEventListener?.('change', handleChange);
    return () => query.removeEventListener?.('change', handleChange);
  }, []);

  return isFinePointer;
}

type RequiredSubscriptionSourceRowProps = {
  choice: ManagedEntityHeader;
  disabled: boolean;
  onAdd: (channelId: string) => void;
};

const RequiredSubscriptionSourceRow = memo(function RequiredSubscriptionSourceRow({
  choice,
  disabled,
  onAdd,
}: RequiredSubscriptionSourceRowProps) {
  const linkPreview = formatSourceLinkPreview(choice.link);
  const typeLabel = formatSourceTypeLabel(choice.entityType);

  return (
    <div className="required-subscription__source-row" role="presentation">
      <button
        type="button"
        className="required-subscription__source-card"
        onClick={() => onAdd(choice.id)}
        disabled={disabled}
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
          Добавить
        </span>
      </button>
    </div>
  );
});

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
  const pendingScrollTopRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const trimmedQuery = query.trim();
  const deferredQuery = useDeferredValue(trimmedQuery);
  const isFinePointer = useIsFinePointer();
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
  const shouldVirtualize =
    isFinePointer && filteredChoices.length > SOURCE_PICKER_VIRTUALIZE_THRESHOLD;
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
  const visibleChoices = shouldVirtualize
    ? filteredChoices.slice(virtualRange.startIndex, virtualRange.endIndex)
    : filteredChoices;
  const visibleOffset = virtualRange.startIndex * SOURCE_PICKER_ROW_HEIGHT;
  const visibleFrom = filteredChoices.length === 0 ? 0 : virtualRange.startIndex + 1;
  const visibleTo = shouldVirtualize
    ? Math.min(virtualRange.endIndex, filteredChoices.length)
    : filteredChoices.length;
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
            : shouldVirtualize && filteredChoices.length > 0
              ? `${formatSourceCount(filteredChoices.length, emptyState)} · показано ${visibleFrom}-${visibleTo}`
              : formatSourceCount(filteredChoices.length, emptyState);
  const emptySearchText = trimmedQuery
    ? 'Ничего не нашли. Очистите поиск или добавьте источник ссылкой ниже.'
    : emptyState;

  useEffect(() => {
    setScrollTop(0);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [deferredQuery, filter]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    },
    [],
  );

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
    if (!shouldVirtualize) {
      return;
    }

    pendingScrollTopRef.current = event.currentTarget.scrollTop;
    if (scrollFrameRef.current !== null) {
      return;
    }

    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const nextScrollTop = pendingScrollTopRef.current ?? 0;
      pendingScrollTopRef.current = null;
      setScrollTop((current) => {
        const currentStart = Math.floor(current / SOURCE_PICKER_ROW_HEIGHT);
        const nextStart = Math.floor(nextScrollTop / SOURCE_PICKER_ROW_HEIGHT);
        return currentStart === nextStart ? current : nextScrollTop;
      });
    });
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
          className={cn(
            'required-subscription__source-list',
            !shouldVirtualize && 'is-static',
          )}
          style={
            {
              '--required-subscription-source-list-height': shouldVirtualize
                ? `${listHeight}px`
                : 'auto',
            } as CSSProperties
          }
          onScroll={handleScroll}
          role="listbox"
          aria-label="Доступные чаты и каналы для обязательной подписки"
        >
          {shouldVirtualize ? (
            <div
              className="required-subscription__source-list-spacer"
              style={{ height: `${virtualRange.totalHeight}px` }}
            >
              <div
                className="required-subscription__source-list-window"
                style={{ transform: `translateY(${visibleOffset}px)` }}
              >
                {visibleChoices.map((choice) => (
                  <RequiredSubscriptionSourceRow
                    key={`required-subscription-source-${choice.id}`}
                    choice={choice}
                    disabled={hasReachedLimit}
                    onAdd={onAdd}
                  />
                ))}
              </div>
            </div>
          ) : (
            visibleChoices.map((choice) => (
              <RequiredSubscriptionSourceRow
                key={`required-subscription-source-${choice.id}`}
                choice={choice}
                disabled={hasReachedLimit}
                onAdd={onAdd}
              />
            ))
          )}
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
