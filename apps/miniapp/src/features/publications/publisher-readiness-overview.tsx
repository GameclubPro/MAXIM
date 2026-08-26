import { CheckCircle, NavArrowDown, OpenNewWindow, Post, Refresh, Search, Xmark } from 'iconoir-react';
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { EntityAvatar } from '../../components/ui/entity-avatar';
import { formatRussianCountLabel } from '../../lib/broadcast-audience';
import { cn } from '../../lib/cn';
import { getPublisherReadinessPresentation } from '../../lib/publisher-readiness';
import { resolveVirtualListRange } from '../../lib/virtual-list';
import { matchesPublicationSearch, type PublicationTarget } from './publication-model';
import './publisher-readiness-overview.css';

type ReadinessFilter = 'all' | 'ready' | 'attention';

const FILTERS: Array<{ value: ReadinessFilter; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'ready', label: 'Готовы' },
  { value: 'attention', label: 'Настройка' },
];
const READINESS_ROW_HEIGHT = 78;
const READINESS_LIST_VIEWPORT_HEIGHT = 310;
const READINESS_LIST_VIRTUALIZATION_THRESHOLD = 60;
const READINESS_LIST_OVERSCAN = 3;

function formatSummary(targets: readonly PublicationTarget[], loading: boolean, error: boolean) {
  if (loading && targets.length === 0) {
    return 'Проверяю доступ';
  }
  if (error && targets.length === 0) {
    return 'Не удалось проверить';
  }
  if (targets.length === 0) {
    return 'Нет подключённых получателей';
  }

  const ready = targets.filter((target) => target.readiness?.canPublish === true).length;
  const attention = targets.length - ready;
  const readyLabel = formatRussianCountLabel(ready, 'готов', 'готовы', 'готовы');
  if (attention === 0) {
    return readyLabel;
  }
  return `${readyLabel} · ${formatRussianCountLabel(
    attention,
    'требует внимания',
    'требуют внимания',
    'требуют внимания',
  )}`;
}

export function PublisherReadinessOverview({
  targets,
  loading,
  fetching,
  error,
  botDialogUrl,
  onRefresh,
  onOpenBot,
}: {
  targets: PublicationTarget[];
  loading: boolean;
  fetching: boolean;
  error: boolean;
  botDialogUrl?: string | null;
  onRefresh: () => void;
  onOpenBot: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ReadinessFilter>('all');
  const [listScrollTop, setListScrollTop] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const regionId = useId();
  const deferredQuery = useDeferredValue(query.trim());
  const filteredTargets = useMemo(
    () =>
      targets.filter((target) => {
        const isReady = target.readiness?.canPublish === true;
        return (
          (filter === 'all' || (filter === 'ready' ? isReady : !isReady)) &&
          matchesPublicationSearch([target.title], deferredQuery)
        );
      }),
    [deferredQuery, filter, targets],
  );
  const shouldVirtualize =
    filteredTargets.length > READINESS_LIST_VIRTUALIZATION_THRESHOLD;
  const virtualRange = useMemo(
    () =>
      resolveVirtualListRange({
        itemCount: filteredTargets.length,
        scrollTop: listScrollTop,
        viewportHeight: READINESS_LIST_VIEWPORT_HEIGHT,
        rowHeight: READINESS_ROW_HEIGHT,
        overscan: READINESS_LIST_OVERSCAN,
      }),
    [filteredTargets.length, listScrollTop],
  );
  const renderedTargets = shouldVirtualize
    ? filteredTargets.slice(virtualRange.startIndex, virtualRange.endIndex)
    : filteredTargets;
  const renderedOffset = virtualRange.startIndex * READINESS_ROW_HEIGHT;
  const hasSetupBlocker = targets.some(
    (target) =>
      !target.readiness?.canPublish &&
      target.readiness?.blockerCode !== 'policy_disabled' &&
      target.readiness?.blockerCode !== 'publisher_runtime_unavailable' &&
      target.readiness?.blockerCode !== 'route_quarantined',
  );
  const summary = formatSummary(targets, loading, error);

  useEffect(() => {
    setListScrollTop(0);
    listRef.current?.scrollTo({ top: 0 });
  }, [deferredQuery, filter]);

  function renderTarget(target: PublicationTarget) {
    const presentation = getPublisherReadinessPresentation(target.readiness);
    return (
      <div
        key={`${target.entityType}:${target.id}`}
        className={cn('publisher-readiness-overview__row', `is-${presentation.tone}`)}
        role="listitem"
      >
        <EntityAvatar
          title={target.title}
          entityType={target.entityType}
          avatarUrl={target.avatarUrl}
          className="publisher-readiness-overview__avatar"
        />
        <span className="publisher-readiness-overview__entity">
          <strong>{target.title}</strong>
          <small>{target.entityType === 'channel' ? 'Канал' : 'Чат'}</small>
        </span>
        <span className="publisher-readiness-overview__status">{presentation.label}</span>
      </div>
    );
  }

  return (
    <section
      className={cn(
        'publisher-readiness-overview',
        expanded && 'is-expanded',
        error && 'has-error',
      )}
      aria-busy={loading || fetching}
      aria-label="Доступность получателей Публика"
    >
      <div className="publisher-readiness-overview__head">
        <button
          type="button"
          className="publisher-readiness-overview__summary"
          aria-expanded={expanded}
          aria-controls={regionId}
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="publisher-readiness-overview__mark" aria-hidden>
            {targets.length > 0 && targets.every((target) => target.readiness?.canPublish) ? (
              <CheckCircle />
            ) : (
              <Post />
            )}
          </span>
          <span className="publisher-readiness-overview__copy">
            <strong>Получатели</strong>
            <small role="status" aria-live="polite">
              {summary}
            </small>
          </span>
          <NavArrowDown className="publisher-readiness-overview__chevron" aria-hidden />
        </button>
        <button
          type="button"
          className="publisher-readiness-overview__refresh"
          aria-label="Обновить доступность получателей"
          title="Обновить"
          disabled={fetching}
          onClick={onRefresh}
        >
          <Refresh aria-hidden />
        </button>
      </div>

      {expanded ? (
        <div id={regionId} className="publisher-readiness-overview__body">
          {error && targets.length === 0 ? (
            <div className="publisher-readiness-overview__state" role="alert">
              <strong>Получатели временно недоступны</strong>
              <span>Обновите список и повторите попытку.</span>
              <button type="button" onClick={onRefresh} disabled={fetching}>
                <Refresh aria-hidden />
                <span>{fetching ? 'Обновляю' : 'Повторить'}</span>
              </button>
            </div>
          ) : loading && targets.length === 0 ? (
            <div className="publisher-readiness-overview__state" role="status">
              <strong>Проверяю получателей</strong>
              <span>Загружаю доступные чаты и каналы.</span>
            </div>
          ) : targets.length === 0 ? (
            <div className="publisher-readiness-overview__state" role="status">
              <strong>Получателей пока нет</strong>
              <span>Подключённые в основных ботах чаты и каналы появятся здесь.</span>
              <button type="button" onClick={onRefresh} disabled={fetching}>
                <Refresh aria-hidden />
                <span>{fetching ? 'Обновляю' : 'Обновить'}</span>
              </button>
            </div>
          ) : (
            <>
              <label className="publisher-readiness-overview__search">
                <Search aria-hidden />
                <input
                  type="search"
                  value={query}
                  maxLength={120}
                  placeholder="Найти чат или канал"
                  aria-label="Найти получателя Публика"
                  onChange={(event) => setQuery(event.currentTarget.value)}
                />
                {query ? (
                  <button type="button" onClick={() => setQuery('')} aria-label="Очистить поиск">
                    <Xmark aria-hidden />
                  </button>
                ) : null}
              </label>

              <div
                className="publisher-readiness-overview__filters"
                role="group"
                aria-label="Готовность получателей"
              >
                {FILTERS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    className={cn(filter === item.value && 'is-active')}
                    aria-pressed={filter === item.value}
                    onClick={() => setFilter(item.value)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <div
                ref={listRef}
                className={cn(
                  'publisher-readiness-overview__list',
                  shouldVirtualize && 'is-virtual',
                )}
                role="list"
                onScroll={
                  shouldVirtualize
                    ? (event) => setListScrollTop(event.currentTarget.scrollTop)
                    : undefined
                }
              >
                {filteredTargets.length > 0 ? (
                  shouldVirtualize ? (
                    <div
                      className="publisher-readiness-overview__virtual-spacer"
                      style={{ height: `${virtualRange.totalHeight}px` }}
                    >
                      <div
                        className="publisher-readiness-overview__virtual-window"
                        style={{ transform: `translateY(${renderedOffset}px)` }}
                      >
                        {renderedTargets.map(renderTarget)}
                      </div>
                    </div>
                  ) : (
                    renderedTargets.map(renderTarget)
                  )
                ) : (
                  <span className="publisher-readiness-overview__not-found" role="status">
                    Ничего не найдено
                  </span>
                )}
              </div>

              {botDialogUrl && hasSetupBlocker ? (
                <button
                  type="button"
                  className="publisher-readiness-overview__open-bot"
                  onClick={onOpenBot}
                >
                  <OpenNewWindow aria-hidden />
                  <span>Открыть Публик</span>
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
