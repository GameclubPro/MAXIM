import { MAX_PUBLICATION_TARGETS } from '@maxim/contracts/publication';
import { Check, NavArrowDown, Search, Xmark } from 'iconoir-react';
import {
  type CSSProperties,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { EntityAvatar } from '../../components/ui/entity-avatar';
import { cn } from '../../lib/cn';
import { getPublisherReadinessLabel } from '../../lib/publisher-readiness-label';
import { resolveVirtualListRange } from '../../lib/virtual-list';
import {
  getPublicationTargetKey,
  getPublicationTargetTitle,
  matchesPublicationSearch,
  type PublicationEntityFilter,
  type PublicationTarget,
} from './publication-model';
import { togglePublicationTargetSelection } from './publication-target-selection';
import './publication-target-picker.css';

type PublicationTargetPickerProps = {
  choices: PublicationTarget[];
  value: PublicationTarget[];
  remoteSource?: {
    query: string;
    entityFilter: PublicationEntityFilter;
    settling: boolean;
    loading: boolean;
    filteredTotal: number | null;
    hasNextPage: boolean;
    fetchingNextPage: boolean;
    fetchNextPageError: boolean;
    onQueryChange: (query: string) => void;
    onEntityFilterChange: (filter: PublicationEntityFilter) => void;
    onLoadMore: () => void;
  };
  disabled?: boolean;
  error?: string | null;
  maxTargets?: number;
  onChange: (targets: PublicationTarget[]) => void;
  onLimitReached?: () => void;
};

const FILTERS: Array<{ value: PublicationEntityFilter; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'chat', label: 'Чаты' },
  { value: 'channel', label: 'Каналы' },
];
const TARGET_ROW_HEIGHT = 58;
const TARGET_LIST_VIEWPORT_HEIGHT = 266;
const TARGET_LIST_VIRTUALIZATION_THRESHOLD = 60;
const TARGET_LIST_OVERSCAN = 3;

export function PublicationTargetPicker({
  choices,
  value,
  remoteSource,
  disabled = false,
  error = null,
  maxTargets = MAX_PUBLICATION_TARGETS,
  onChange,
  onLimitReached,
}: PublicationTargetPickerProps) {
  const [localQuery, setLocalQuery] = useState('');
  const [localFilter, setLocalFilter] = useState<PublicationEntityFilter>('all');
  const [expanded, setExpanded] = useState(false);
  const [shouldRevealEditor, setShouldRevealEditor] = useState(false);
  const [listScrollTop, setListScrollTop] = useState(0);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const editorId = useId();
  const errorId = useId();
  const query = remoteSource?.query ?? localQuery;
  const filter = remoteSource?.entityFilter ?? localFilter;
  const deferredQuery = useDeferredValue(query.trim());
  const selectedKeys = useMemo(
    () => new Set(value.map((target) => getPublicationTargetKey(target))),
    [value],
  );
  const filteredChoices = useMemo(
    () =>
      remoteSource
        ? remoteSource.settling
          ? []
          : choices
        : choices.filter(
            (choice) =>
              (filter === 'all' || choice.entityType === filter) &&
              matchesPublicationSearch([choice.title], deferredQuery),
          ),
    [choices, deferredQuery, filter, remoteSource],
  );
  const shouldVirtualize = filteredChoices.length > TARGET_LIST_VIRTUALIZATION_THRESHOLD;
  const virtualRange = useMemo(
    () =>
      resolveVirtualListRange({
        itemCount: filteredChoices.length,
        scrollTop: listScrollTop,
        viewportHeight: TARGET_LIST_VIEWPORT_HEIGHT,
        rowHeight: TARGET_ROW_HEIGHT,
        overscan: TARGET_LIST_OVERSCAN,
      }),
    [filteredChoices.length, listScrollTop],
  );
  const renderedChoices = shouldVirtualize
    ? filteredChoices.slice(virtualRange.startIndex, virtualRange.endIndex)
    : filteredChoices;
  const renderedOffset = virtualRange.startIndex * TARGET_ROW_HEIGHT;
  const collapsedSelectedSummary =
    value.length === 0
      ? 'Выберите получателей'
      : value.length === 1
        ? value[0]
          ? getPublicationTargetTitle(value[0])
          : '1 получатель'
        : `Выбрано: ${value.length}`;
  const summaryTitle = collapsedSelectedSummary;
  const summaryMeta =
    value.length === 0
      ? expanded
        ? 'Выберите чаты и каналы'
        : 'Чаты и каналы'
      : expanded
        ? `Выбрано: ${value.length}`
        : value.length === 1
          ? value[0]?.entityType === 'channel'
            ? 'Канал'
            : 'Чат'
          : 'Чаты и каналы';
  const hasHiddenSelection = value.some(
    (target) =>
      !filteredChoices.some(
        (choice) => getPublicationTargetKey(choice) === getPublicationTargetKey(target),
      ),
  );
  const shouldShowSelectedChips = value.length > 1 || hasHiddenSelection;

  useEffect(() => {
    if (error) {
      setExpanded(true);
      setShouldRevealEditor(true);
    }
  }, [error]);

  useEffect(() => {
    if (!expanded || !shouldRevealEditor) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      pickerRef.current?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'start',
      });
      setShouldRevealEditor(false);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [expanded, shouldRevealEditor]);

  useEffect(() => {
    setListScrollTop(0);
    listRef.current?.scrollTo({ top: 0 });
  }, [deferredQuery, filter]);

  function toggleTarget(target: PublicationTarget) {
    const result = togglePublicationTargetSelection(value, target, maxTargets);
    if (result.outcome === 'blocked_limit') {
      onLimitReached?.();
      return;
    }
    if (result.outcome === 'blocked_unavailable') {
      return;
    }
    onChange(result.targets);
  }

  function toggleEditor() {
    if (expanded) {
      setExpanded(false);
      setShouldRevealEditor(false);
      return;
    }

    setExpanded(true);
    setShouldRevealEditor(true);
  }

  function changeQuery(nextQuery: string): void {
    if (remoteSource) {
      remoteSource.onQueryChange(nextQuery);
      return;
    }
    setLocalQuery(nextQuery);
  }

  function changeFilter(nextFilter: PublicationEntityFilter): void {
    if (remoteSource) {
      remoteSource.onEntityFilterChange(nextFilter);
      return;
    }
    setLocalFilter(nextFilter);
  }

  function renderChoice(choice: PublicationTarget) {
    const selected = selectedKeys.has(getPublicationTargetKey(choice));
    const unavailable = Boolean(choice.readiness && !choice.readiness.canPublish);
    const readinessLabel = choice.readiness
      ? getPublisherReadinessLabel(choice.readiness)
      : choice.entityType === 'channel'
        ? 'Канал'
        : 'Чат';
    return (
      <button
        key={getPublicationTargetKey(choice)}
        type="button"
        className={cn(
          'publication-target-row',
          selected && 'is-selected',
          unavailable && 'is-unavailable',
        )}
        aria-pressed={selected}
        aria-disabled={disabled || (unavailable && !selected)}
        aria-label={
          unavailable && !selected
            ? `${choice.title}, ${readinessLabel}`
            : `${selected ? 'Убрать' : 'Выбрать'} ${choice.title}, ${
                choice.entityType === 'channel' ? 'канал' : 'чат'
              }`
        }
        onClick={() => toggleTarget(choice)}
        disabled={disabled}
      >
        <EntityAvatar
          title={choice.title}
          entityType={choice.entityType}
          avatarUrl={choice.avatarUrl}
          className="publication-target-row__avatar"
        />
        <span className="publication-target-row__copy">
          <strong>{choice.title}</strong>
          <small>{readinessLabel}</small>
        </span>
        <span className="publication-target-row__check" aria-hidden>
          {selected ? <Check /> : null}
        </span>
      </button>
    );
  }

  return (
    <div ref={pickerRef} className={cn('publication-target-picker', error && 'has-error')}>
      <button
        type="button"
        className={cn(
          'publication-target-picker__summary',
          value.length === 0 && 'is-empty',
          expanded && 'is-expanded',
        )}
        onClick={toggleEditor}
        disabled={disabled}
        aria-expanded={expanded}
        aria-controls={editorId}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? 'true' : undefined}
      >
        <span>
          <strong>{summaryTitle}</strong>
          <small>{summaryMeta}</small>
        </span>
        <span className="publication-target-picker__summary-action">
          {expanded ? 'Свернуть' : 'Изменить'}
        </span>
        <NavArrowDown aria-hidden />
      </button>

      {expanded ? (
        <div
          id={editorId}
          className="publication-target-picker__editor"
          role="region"
          aria-label="Выбор получателей"
        >
          {shouldShowSelectedChips ? (
            <div
              className="publication-target-picker__selected"
              role="list"
              aria-label="Выбранные получатели"
            >
              {value.map((target) => (
                <span
                  key={getPublicationTargetKey(target)}
                  className="publication-target-chip"
                  role="listitem"
                >
                  <span>{getPublicationTargetTitle(target)}</span>
                  <button
                    type="button"
                    onClick={() => toggleTarget(target)}
                    disabled={disabled}
                    aria-label={`Убрать ${getPublicationTargetTitle(target)}`}
                  >
                    <Xmark aria-hidden />
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          <label className="publication-search">
            <Search aria-hidden />
            <input
              type="search"
              value={query}
              maxLength={120}
              placeholder="Найти чат или канал"
              aria-label="Найти получателя"
              onChange={(event) => changeQuery(event.currentTarget.value)}
              disabled={disabled}
            />
            {query ? (
              <button
                type="button"
                onClick={() => changeQuery('')}
                aria-label="Очистить поиск"
                disabled={disabled}
              >
                <Xmark aria-hidden />
              </button>
            ) : null}
          </label>

          <div
            className="publication-target-picker__filters"
            role="group"
            aria-label="Тип получателя"
          >
            {FILTERS.map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={filter === item.value}
                className={cn(filter === item.value && 'is-active')}
                onClick={() => changeFilter(item.value)}
                disabled={disabled}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div
            ref={listRef}
            className={cn('publication-target-picker__list', shouldVirtualize && 'is-virtual')}
            role="group"
            aria-label="Получатели"
            onScroll={
              shouldVirtualize
                ? (event) => setListScrollTop(event.currentTarget.scrollTop)
                : undefined
            }
          >
            {filteredChoices.length > 0 ? (
              shouldVirtualize ? (
                <div
                  className="publication-target-picker__virtual-spacer"
                  style={{ height: `${virtualRange.totalHeight}px` } as CSSProperties}
                >
                  <div
                    className="publication-target-picker__virtual-window"
                    style={{ transform: `translateY(${renderedOffset}px)` }}
                  >
                    {renderedChoices.map(renderChoice)}
                  </div>
                </div>
              ) : (
                renderedChoices.map(renderChoice)
              )
            ) : remoteSource?.loading || remoteSource?.settling ? (
              <span className="publication-target-picker__empty" role="status">
                Загружаю получателей
              </span>
            ) : (
              <span className="publication-target-picker__empty" role="status">
                Ничего не найдено
              </span>
            )}
          </div>
          {remoteSource && !remoteSource.settling && remoteSource.filteredTotal !== null ? (
            <span className="publication-target-picker__loaded" role="status">
              {filteredChoices.length === remoteSource.filteredTotal
                ? `Получателей: ${remoteSource.filteredTotal}`
                : `${filteredChoices.length} из ${remoteSource.filteredTotal}`}
            </span>
          ) : null}
          {remoteSource?.hasNextPage && !remoteSource.settling ? (
            <button
              type="button"
              className="publication-target-picker__load-more"
              onClick={remoteSource.onLoadMore}
              disabled={disabled || remoteSource.fetchingNextPage}
            >
              {remoteSource.fetchingNextPage
                ? 'Загрузка...'
                : remoteSource.fetchNextPageError
                  ? 'Повторить'
                  : 'Показать ещё'}
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p id={errorId} className="publication-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
