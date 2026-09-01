import { MAX_PUBLICATION_TARGETS } from '@maxim/contracts/publication';
import { Check, NavArrowDown, Search, Xmark } from 'iconoir-react';
import {
  type CSSProperties,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from 'react';
import { EntityAvatar } from '../../components/ui/entity-avatar';
import { cn } from '../../lib/cn';
import { useDialogFocusTrap } from '../../lib/dialog-focus';
import { useNativeBackHandler } from '../../lib/native-back';
import { getPublisherReadinessLabel } from '../../lib/publisher-readiness-label';
import { formatRussianCountLabel } from '../../lib/broadcast-audience';
import { useVisualViewportOverlayStyle } from '../../lib/use-visual-viewport-overlay-style';
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
  notice?: string | null;
  maxTargets?: number;
  compactSummary?: boolean;
  onChange: (targets: PublicationTarget[]) => void;
  onLimitReached?: () => void;
};

const FILTERS: Array<{ value: PublicationEntityFilter; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'chat', label: 'Чаты' },
  { value: 'channel', label: 'Каналы' },
];
const TARGET_ROW_HEIGHT = 58;
const TARGET_LIST_INITIAL_VIEWPORT_HEIGHT = 266;
const TARGET_LIST_VIRTUALIZATION_THRESHOLD = 60;
const TARGET_LIST_OVERSCAN = 3;
const TARGET_LIST_AUTO_LOAD_THRESHOLD = TARGET_ROW_HEIGHT * 2;

export function PublicationTargetPicker({
  choices,
  value,
  remoteSource,
  disabled = false,
  error = null,
  notice = null,
  maxTargets = MAX_PUBLICATION_TARGETS,
  compactSummary = false,
  onChange,
  onLimitReached,
}: PublicationTargetPickerProps) {
  const [localQuery, setLocalQuery] = useState('');
  const [localFilter, setLocalFilter] = useState<PublicationEntityFilter>('all');
  const [expanded, setExpanded] = useState(false);
  const [shouldRevealEditor, setShouldRevealEditor] = useState(false);
  const [listScrollTop, setListScrollTop] = useState(0);
  const [listViewportHeight, setListViewportHeight] = useState(TARGET_LIST_INITIAL_VIEWPORT_HEIGHT);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const autoLoadArmedRef = useRef(true);
  const loadMoreRequestRef = useRef(false);
  const remoteSourceRef = useRef(remoteSource);
  remoteSourceRef.current = remoteSource;
  const editorId = useId();
  const editorTitleId = useId();
  const errorId = useId();
  const sheetOpen = expanded && Boolean(remoteSource);
  const sheetStyle = useVisualViewportOverlayStyle(sheetOpen);
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
        viewportHeight: listViewportHeight,
        rowHeight: TARGET_ROW_HEIGHT,
        overscan: TARGET_LIST_OVERSCAN,
      }),
    [filteredChoices.length, listScrollTop, listViewportHeight],
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
        : formatRussianCountLabel(value.length, 'получатель', 'получателя', 'получателей');
  const summaryTitle = collapsedSelectedSummary;
  const summaryMeta = notice
    ? notice
    : value.length === 0
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

    if (remoteSource) {
      setShouldRevealEditor(false);
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
  }, [expanded, remoteSource, shouldRevealEditor]);

  useEffect(() => {
    if (!expanded || !listRef.current) {
      return undefined;
    }
    const list = listRef.current;
    const updateHeight = () => {
      setListViewportHeight(Math.max(1, list.clientHeight));
    };
    updateHeight();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateHeight);
    observer?.observe(list);
    window.addEventListener('resize', updateHeight);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateHeight);
    };
  }, [expanded]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!expanded || !shouldVirtualize || !list) {
      return;
    }

    setListScrollTop(list.scrollTop);
  }, [expanded, filteredChoices.length, shouldVirtualize]);

  useEffect(() => {
    if (!sheetOpen) {
      return undefined;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [sheetOpen]);

  useDialogFocusTrap(sheetOpen, editorRef, searchInputRef);
  useNativeBackHandler(
    () => {
      setExpanded(false);
      setShouldRevealEditor(false);
      return true;
    },
    { enabled: sheetOpen, priority: 705 },
  );

  useEffect(() => {
    if (!sheetOpen) {
      return undefined;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      setExpanded(false);
      setShouldRevealEditor(false);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [sheetOpen]);

  useEffect(() => {
    autoLoadArmedRef.current = true;
    loadMoreRequestRef.current = false;
    setListScrollTop(0);
    listRef.current?.scrollTo({ top: 0 });
  }, [deferredQuery, filter]);

  useEffect(() => {
    if (remoteSource?.fetchingNextPage) {
      return;
    }

    loadMoreRequestRef.current = false;
    autoLoadArmedRef.current = true;
    const list = listRef.current;
    if (
      !expanded ||
      !list ||
      !remoteSource?.hasNextPage ||
      remoteSource.settling ||
      remoteSource.fetchNextPageError ||
      list.scrollHeight - list.scrollTop - list.clientHeight > TARGET_LIST_AUTO_LOAD_THRESHOLD
    ) {
      return;
    }

    autoLoadArmedRef.current = false;
    loadMoreRequestRef.current = true;
    remoteSourceRef.current?.onLoadMore();
  }, [
    expanded,
    filteredChoices.length,
    remoteSource?.fetchNextPageError,
    remoteSource?.fetchingNextPage,
    remoteSource?.hasNextPage,
    remoteSource?.settling,
  ]);

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

  function loadMoreTargets(): void {
    if (
      !remoteSource ||
      remoteSource.settling ||
      !remoteSource.hasNextPage ||
      remoteSource.fetchingNextPage ||
      loadMoreRequestRef.current
    ) {
      return;
    }

    loadMoreRequestRef.current = true;
    remoteSource.onLoadMore();
  }

  function handleTargetListScroll(event: UIEvent<HTMLDivElement>): void {
    const list = event.currentTarget;
    setListScrollTop(list.scrollTop);

    const nearEnd =
      list.scrollHeight - list.scrollTop - list.clientHeight <= TARGET_LIST_AUTO_LOAD_THRESHOLD;
    if (!nearEnd) {
      autoLoadArmedRef.current = true;
      return;
    }
    if (autoLoadArmedRef.current) {
      autoLoadArmedRef.current = false;
      loadMoreTargets();
    }
  }

  function renderChoice(choice: PublicationTarget, renderedIndex: number) {
    const selected = selectedKeys.has(getPublicationTargetKey(choice));
    const unavailable = Boolean(choice.readiness && !choice.readiness.canPublish);
    const absoluteIndex = shouldVirtualize
      ? virtualRange.startIndex + renderedIndex
      : renderedIndex;
    const entityTypeLabel = choice.entityType === 'channel' ? 'Канал' : 'Чат';
    const readinessLabel =
      choice.readiness && !choice.readiness.canPublish
        ? getPublisherReadinessLabel(choice.readiness)
        : entityTypeLabel;
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
        data-target-position={absoluteIndex + 1}
        aria-label={
          unavailable && !selected
            ? `${choice.title}, ${readinessLabel}`
            : `${selected ? 'Убрать' : 'Выбрать'} ${choice.title}, ${
                choice.entityType === 'channel' ? 'канал' : 'чат'
              }`
        }
        onClick={() => toggleTarget(choice)}
        disabled={disabled || (unavailable && !selected)}
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
    <div
      ref={pickerRef}
      className={cn(
        'publication-target-picker',
        compactSummary && 'is-compact',
        error && 'has-error',
      )}
    >
      <button
        type="button"
        className={cn(
          'publication-target-picker__summary',
          value.length === 0 && 'is-empty',
          expanded && 'is-expanded',
          notice && 'has-notice',
          compactSummary && value[0] && 'has-avatar',
        )}
        onClick={toggleEditor}
        disabled={disabled}
        aria-expanded={expanded}
        aria-controls={editorId}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? 'true' : undefined}
      >
        {compactSummary && value[0] ? (
          <EntityAvatar
            title={value[0].title}
            entityType={value[0].entityType}
            avatarUrl={value[0].avatarUrl}
            className="publication-target-picker__summary-avatar"
          />
        ) : null}
        <span className="publication-target-picker__summary-copy">
          <strong>{summaryTitle}</strong>
          <small>{summaryMeta}</small>
        </span>
        {!compactSummary ? (
          <span className="publication-target-picker__summary-action">
            {expanded ? 'Свернуть' : 'Изменить'}
          </span>
        ) : null}
        <NavArrowDown aria-hidden />
      </button>

      {expanded ? (
        <div
          ref={editorRef}
          id={editorId}
          className={cn('publication-target-picker__editor', remoteSource && 'is-sheet')}
          style={remoteSource ? sheetStyle : undefined}
          role={remoteSource ? 'dialog' : 'region'}
          aria-modal={remoteSource ? 'true' : undefined}
          aria-labelledby={remoteSource ? editorTitleId : undefined}
          aria-label={remoteSource ? undefined : 'Выбор получателей'}
        >
          {remoteSource ? (
            <header className="publication-target-picker__sheet-header">
              <span>
                <strong id={editorTitleId}>Получатели</strong>
                {notice || value.length > 0 ? (
                  <small>{notice ?? `Выбрано: ${value.length}`}</small>
                ) : null}
              </span>
              <button
                type="button"
                onClick={() => {
                  setExpanded(false);
                  setShouldRevealEditor(false);
                }}
                aria-label="Завершить выбор получателей"
                title="Готово"
              >
                <Check aria-hidden />
              </button>
            </header>
          ) : null}
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
              ref={searchInputRef}
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
            onScroll={handleTargetListScroll}
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
            {remoteSource && !remoteSource.settling ? (
              <div className="publication-target-picker__pagination">
                {remoteSource.filteredTotal !== null &&
                (remoteSource.hasNextPage ||
                  remoteSource.fetchingNextPage ||
                  remoteSource.fetchNextPageError ||
                  query.trim().length > 0 ||
                  filter !== 'all' ||
                  filteredChoices.length > TARGET_LIST_VIRTUALIZATION_THRESHOLD) ? (
                  <span className="publication-target-picker__loaded" role="status">
                    {`Показано ${filteredChoices.length} из ${remoteSource.filteredTotal}`}
                  </span>
                ) : null}
                {remoteSource.hasNextPage ? (
                  <button
                    type="button"
                    className="publication-target-picker__load-more"
                    onClick={loadMoreTargets}
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
          </div>
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
