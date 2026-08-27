import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { PublisherEntitiesSummary, PublisherEntity } from '@maxim/contracts/publisher';
import { CheckCircle, NavArrowRight, Refresh, Search, WarningCircle, Xmark } from 'iconoir-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useSearchParams } from 'react-router';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { useToast } from '../components/ui/toast';
import { formatRussianCountLabel } from '../lib/broadcast-audience';
import { cn } from '../lib/cn';
import {
  getPublisherEntity,
  listPublisherEntities,
  refreshPublisherEntities,
  refreshPublisherEntity,
} from '../lib/api/publisher-client';
import type { ApiTransport } from '../lib/api/transport';
import { openMaxBotLinkAndClose } from '../lib/max-bridge';
import { getPublisherReadinessPresentation } from '../lib/publisher-readiness';
import { describeUserFacingError } from '../lib/user-facing-error';
import { resolveVirtualListRange } from '../lib/virtual-list';
import {
  buildPublisherEntityViewRoute,
  fingerprintPublisherEntities,
  normalizePublisherEntityView,
  pollPublisherEntityRefresh,
  PUBLISHER_ENTITY_REFRESH_POLL_DELAYS_MS,
  resolvePublisherHomeView,
  retryPublisherEntitiesNextPage,
  shouldOfferPublisherRecheck,
  waitForPublisherRefresh,
  type PublisherEntityReadinessFilter,
} from './publisher-entities-page-model';
import { buildPublisherEntityModulesRoute } from './publisher-entity-modules-page-model';
import './publisher-entities-page.css';

const PUBLISHER_ENTITIES_QUERY_ROOT = ['publications', 'sources', 'publisher'] as const;
const PUBLISHER_ENTITY_PAGE_SIZE = 30;
const PUBLISHER_ENTITY_ROW_HEIGHT = 154;
const PUBLISHER_ENTITY_LIST_INITIAL_HEIGHT = 680;
const PUBLISHER_ENTITY_VIRTUALIZATION_THRESHOLD = 60;
const PUBLISHER_ENTITY_LIST_OVERSCAN = 4;
const PUBLISHER_ENTITY_SEARCH_DEBOUNCE_MS = 250;
const PUBLISHER_BULK_REFRESH_POLL_DELAYS_MS = [1_200, 2_400, 4_200, 7_200] as const;

type PublisherEntityRefreshState = {
  entityKey: string;
  phase: 'enqueueing' | 'polling';
};

type PublisherBulkRefreshState = {
  phase: 'enqueueing' | 'polling';
  queuedCount: number;
};

const EMPTY_PUBLISHER_SUMMARY: PublisherEntitiesSummary = {
  total: 0,
  chat: 0,
  channel: 0,
  ready: 0,
  attention: 0,
};

const READINESS_FILTERS: Array<{
  value: PublisherEntityReadinessFilter;
  label: string;
}> = [
  { value: 'all', label: 'Все' },
  { value: 'ready', label: 'Готовы' },
  { value: 'attention', label: 'Требуют внимания' },
];

function formatEntityListStatus(
  visibleCount: number,
  totalCount: number,
  loading: boolean,
): string {
  if (loading) {
    return 'Загружаю список';
  }
  if (visibleCount === totalCount) {
    return formatRussianCountLabel(totalCount, 'получатель', 'получателя', 'получателей');
  }
  return `${visibleCount} из ${totalCount}`;
}

function fingerprintPublisherEntityPage(
  entities: readonly PublisherEntity[],
  summary: PublisherEntitiesSummary,
): string {
  return `${summary.chat}:${summary.channel}:${summary.ready}:${summary.attention}\n${fingerprintPublisherEntities(
    entities,
  )}`;
}

export function PublisherEntitiesPage({
  api,
  botDialogUrl = null,
}: {
  api: ApiTransport;
  botDialogUrl?: string | null;
}) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [readinessFilter, setReadinessFilter] = useState<PublisherEntityReadinessFilter>('all');
  const [listScrollTop, setListScrollTop] = useState(0);
  const [listViewportHeight, setListViewportHeight] = useState(
    PUBLISHER_ENTITY_LIST_INITIAL_HEIGHT,
  );
  const [entityRefresh, setEntityRefresh] = useState<PublisherEntityRefreshState | null>(null);
  const [bulkRefresh, setBulkRefresh] = useState<PublisherBulkRefreshState | null>(null);
  const [openingBotDialog, setOpeningBotDialog] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const bulkRefreshAbortRef = useRef<AbortController | null>(null);
  const requestedView = searchParams.get('view');
  const view = normalizePublisherEntityView(requestedView);
  const readiness = readinessFilter === 'all' ? undefined : readinessFilter;
  const searchSettling = query.trim() !== debouncedQuery;
  const entitiesQueryKey = useMemo(
    () =>
      [
        ...PUBLISHER_ENTITIES_QUERY_ROOT,
        'cursor',
        { query: debouncedQuery, entityType: view, readiness: readiness ?? null },
      ] as const,
    [debouncedQuery, readiness, view],
  );
  const entitiesQuery = useInfiniteQuery({
    queryKey: entitiesQueryKey,
    queryFn: ({ pageParam, signal }) =>
      listPublisherEntities(api, {
        pagination: 'cursor',
        limit: PUBLISHER_ENTITY_PAGE_SIZE,
        query: debouncedQuery,
        entityType: view,
        readiness,
        cursor: pageParam,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const entities = useMemo(
    () => entitiesQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [entitiesQuery.data?.pages],
  );
  const summary = entitiesQuery.data?.pages[0]?.summary ?? EMPTY_PUBLISHER_SUMMARY;
  const filteredTotal = entitiesQuery.data?.pages[0]?.filteredTotal ?? 0;
  const homeViewResolution = resolvePublisherHomeView(requestedView, summary);
  const shouldAutoOpenChannels =
    entitiesQuery.data !== undefined && homeViewResolution.shouldReplace;
  const activeTypeCount = summary[view];
  const otherView = view === 'channel' ? 'chat' : 'channel';
  const otherTypeCount = summary[otherView];
  const shouldVirtualize = entities.length > PUBLISHER_ENTITY_VIRTUALIZATION_THRESHOLD;
  const virtualRange = useMemo(
    () =>
      resolveVirtualListRange({
        itemCount: entities.length,
        scrollTop: listScrollTop,
        viewportHeight: listViewportHeight,
        rowHeight: PUBLISHER_ENTITY_ROW_HEIGHT,
        overscan: PUBLISHER_ENTITY_LIST_OVERSCAN,
      }),
    [entities.length, listScrollTop, listViewportHeight],
  );
  const renderedEntities = shouldVirtualize
    ? entities.slice(virtualRange.startIndex, virtualRange.endIndex)
    : entities;
  const renderedOffset = virtualRange.startIndex * PUBLISHER_ENTITY_ROW_HEIGHT;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshAbortRef.current?.abort();
      bulkRefreshAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(
      () => setDebouncedQuery(query.trim()),
      PUBLISHER_ENTITY_SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [query]);

  useEffect(() => {
    setListScrollTop(0);
    listRef.current?.scrollTo({ top: 0 });
  }, [debouncedQuery, readinessFilter, view]);

  useEffect(() => {
    if (!shouldAutoOpenChannels) {
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.set('view', homeViewResolution.view);
    setSearchParams(next, { replace: true });
  }, [homeViewResolution.view, searchParams, setSearchParams, shouldAutoOpenChannels]);

  useEffect(() => {
    const now = Date.now();
    const nextRetryAt = entities.reduce<number | null>((earliest, entity) => {
      const retryAt = Date.parse(entity.readiness.retryAt ?? '');
      if (!Number.isFinite(retryAt) || retryAt <= now) {
        return earliest;
      }
      return earliest === null ? retryAt : Math.min(earliest, retryAt);
    }, null);
    if (nextRetryAt === null) {
      return undefined;
    }

    const timeoutId = window.setTimeout(
      () => void queryClient.resetQueries({ queryKey: entitiesQueryKey, exact: true }),
      Math.min(nextRetryAt - now + 250, 2_147_000_000),
    );
    return () => window.clearTimeout(timeoutId);
  }, [entities, entitiesQueryKey, queryClient]);

  async function handleRefreshEntities(): Promise<void> {
    if (bulkRefresh || bulkRefreshAbortRef.current) {
      return;
    }
    const abortController = new AbortController();
    bulkRefreshAbortRef.current = abortController;
    setBulkRefresh({ phase: 'enqueueing', queuedCount: 0 });
    const initialFingerprint = fingerprintPublisherEntityPage(entities, summary);

    try {
      const refresh = await refreshPublisherEntities(api);
      if (abortController.signal.aborted) {
        return;
      }
      if (refresh.queuedCount === 0) {
        await queryClient.resetQueries({ queryKey: PUBLISHER_ENTITIES_QUERY_ROOT });
        pushToast({
          tone: 'info',
          title: 'Список обновлён',
          description: 'Новых проверок доступа не потребовалось.',
        });
        return;
      }

      setBulkRefresh({ phase: 'polling', queuedCount: refresh.queuedCount });
      pushToast({
        tone: 'info',
        title: 'Проверка запущена',
        description: `В очереди ${formatRussianCountLabel(
          refresh.queuedCount,
          'подключение',
          'подключения',
          'подключений',
        )}.`,
      });

      let consecutiveReadFailures = 0;
      for (const delayMs of PUBLISHER_BULK_REFRESH_POLL_DELAYS_MS) {
        await waitForPublisherRefresh(delayMs, abortController.signal);
        if (abortController.signal.aborted) {
          return;
        }
        const result = await entitiesQuery.refetch();
        if (result.isError || !result.data) {
          consecutiveReadFailures += 1;
          if (consecutiveReadFailures >= 2) {
            break;
          }
          continue;
        }
        consecutiveReadFailures = 0;
        const nextEntities = result.data.pages.flatMap((page) => page.items);
        const nextSummary = result.data.pages[0]?.summary ?? EMPTY_PUBLISHER_SUMMARY;
        if (fingerprintPublisherEntityPage(nextEntities, nextSummary) !== initialFingerprint) {
          await queryClient.invalidateQueries({ queryKey: PUBLISHER_ENTITIES_QUERY_ROOT });
          pushToast({
            tone: 'success',
            title: 'Подключения обновлены',
            description: 'Показаны свежие статусы доступа Публика.',
          });
          return;
        }
      }

      await queryClient.invalidateQueries({ queryKey: PUBLISHER_ENTITIES_QUERY_ROOT });
      pushToast({
        tone: consecutiveReadFailures >= 2 ? 'danger' : 'info',
        title:
          consecutiveReadFailures >= 2
            ? 'Проверка запущена, но список недоступен'
            : 'MAX ещё проверяет подключения',
        description:
          consecutiveReadFailures >= 2
            ? 'Повторите обновление списка позже.'
            : 'Запрос принят. Свежий статус появится после завершения проверки.',
      });
    } catch (error: unknown) {
      if (!abortController.signal.aborted) {
        pushToast({
          tone: 'danger',
          title: 'Не удалось запустить проверку',
          description: describeUserFacingError(error, 'Повторите запрос позже.'),
        });
      }
    } finally {
      if (bulkRefreshAbortRef.current === abortController) {
        bulkRefreshAbortRef.current = null;
      }
      if (mountedRef.current) {
        setBulkRefresh(null);
      }
    }
  }

  function handleOpenBotDialog(): void {
    if (!botDialogUrl) {
      pushToast({
        tone: 'danger',
        title: 'Диалог Публика недоступен',
        description: 'Закройте мини-приложение и откройте диалог с ботом вручную.',
      });
      return;
    }
    setOpeningBotDialog(true);
    if (!openMaxBotLinkAndClose(botDialogUrl)) {
      setOpeningBotDialog(false);
      pushToast({ tone: 'danger', title: 'Не удалось открыть диалог Публика' });
    }
  }

  async function handleRefreshEntity(entity: PublisherEntity): Promise<void> {
    const entityKey = `${entity.entityType}:${entity.id}`;
    if (entityRefresh || refreshAbortRef.current || bulkRefresh) {
      return;
    }
    const abortController = new AbortController();
    refreshAbortRef.current = abortController;
    setEntityRefresh({ entityKey, phase: 'enqueueing' });

    try {
      try {
        await refreshPublisherEntity(api, entity.entityType, entity.id);
      } catch (error: unknown) {
        if (!abortController.signal.aborted) {
          pushToast({
            tone: 'danger',
            title: 'Не удалось запустить проверку',
            description: describeUserFacingError(error, 'Повторите запрос позже.'),
          });
        }
        return;
      }
      if (abortController.signal.aborted) {
        return;
      }
      setEntityRefresh({ entityKey, phase: 'polling' });
      pushToast({
        tone: 'info',
        title: 'Проверка поставлена в очередь',
        description: 'Жду новый статус от MAX.',
      });

      const result = await pollPublisherEntityRefresh({
        initialEntity: entity,
        delaysMs: PUBLISHER_ENTITY_REFRESH_POLL_DELAYS_MS,
        wait: (delayMs) => waitForPublisherRefresh(delayMs, abortController.signal),
        readEntity: () =>
          getPublisherEntity(api, entity.entityType, entity.id, {
            signal: abortController.signal,
          }),
        isCancelled: () => abortController.signal.aborted,
      });
      if (result.status === 'cancelled') {
        return;
      }
      if (result.status === 'updated') {
        await queryClient.resetQueries({ queryKey: PUBLISHER_ENTITIES_QUERY_ROOT });
        const presentation = getPublisherReadinessPresentation(result.entity.readiness);
        pushToast({
          tone: 'success',
          title: result.entity.readiness.canPublish
            ? 'Доступ Публика подтверждён'
            : 'Проверка завершена',
          description: presentation.detail,
        });
        return;
      }
      if (result.status === 'read_failed') {
        pushToast({
          tone: 'danger',
          title: 'Проверка запущена, но статус недоступен',
          description: describeUserFacingError(result.error, 'Обновите список позже.'),
        });
        return;
      }
      pushToast({
        tone: 'info',
        title: 'Статус пока не обновился',
        description: 'Запрос принят. Повторите проверку через минуту.',
      });
    } catch (error: unknown) {
      if (!abortController.signal.aborted) {
        pushToast({
          tone: 'danger',
          title: 'Проверка запущена, но статус недоступен',
          description: describeUserFacingError(error, 'Обновите список позже.'),
        });
      }
    } finally {
      if (refreshAbortRef.current === abortController) {
        refreshAbortRef.current = null;
      }
      if (mountedRef.current) {
        setEntityRefresh((current) => (current?.entityKey === entityKey ? null : current));
      }
    }
  }

  function renderEntity(entity: PublisherEntity, renderedIndex: number) {
    const presentation = getPublisherReadinessPresentation(entity.readiness);
    const entityKey = `${entity.entityType}:${entity.id}`;
    const refreshPhase = entityRefresh?.entityKey === entityKey ? entityRefresh.phase : null;
    const refreshing = refreshPhase !== null;
    const absoluteIndex = shouldVirtualize
      ? virtualRange.startIndex + renderedIndex
      : renderedIndex;
    const canRecheck = shouldOfferPublisherRecheck(entity);

    return (
      <article
        key={entityKey}
        className={cn('publisher-entity-row', `is-${presentation.tone}`)}
        role="listitem"
        aria-busy={refreshing || undefined}
        aria-posinset={absoluteIndex + 1}
        aria-setsize={filteredTotal}
      >
        <div className="publisher-entity-row__identity">
          <EntityAvatar
            title={entity.title}
            entityType={entity.entityType}
            avatarUrl={entity.avatarUrl}
            className="publisher-entity-row__avatar"
          />
          <span className="publisher-entity-row__title">
            <strong>
              {entity.title.trim() || (entity.entityType === 'channel' ? 'Канал' : 'Чат')}
            </strong>
            <small>{entity.entityType === 'channel' ? 'Канал' : 'Чат'}</small>
          </span>
          <span className="publisher-entity-row__status">
            {entity.readiness.canPublish ? (
              <CheckCircle aria-hidden />
            ) : (
              <WarningCircle aria-hidden />
            )}
            <span>{presentation.label}</span>
          </span>
        </div>

        {refreshPhase || !entity.readiness.canPublish ? (
          <p className="publisher-entity-row__detail" aria-live={refreshing ? 'polite' : undefined}>
            {refreshPhase === 'enqueueing'
              ? 'Ставлю проверку в очередь…'
              : refreshPhase === 'polling'
                ? 'Проверка в очереди. Жду новый статус от MAX.'
                : presentation.detail}
          </p>
        ) : null}

        <div className="publisher-entity-row__actions">
          <Link
            to={buildPublisherEntityModulesRoute(entity)}
            className="publisher-entity-row__module-action"
            aria-label={`Открыть модули для ${entity.title || entity.id}`}
          >
            <span>Модули</span>
            <NavArrowRight aria-hidden />
          </Link>
          {canRecheck ? (
            <button
              type="button"
              className={cn('publisher-entity-row__refresh', refreshing && 'is-refreshing')}
              aria-label={
                refreshing
                  ? `Проверяется доступ для ${entity.title || entity.id}`
                  : `Обновить доступ для ${entity.title || entity.id}`
              }
              title={refreshing ? 'Проверяю доступ' : 'Обновить доступ'}
              disabled={Boolean(entityRefresh || bulkRefresh)}
              onClick={() => void handleRefreshEntity(entity)}
            >
              <Refresh aria-hidden />
            </button>
          ) : null}
        </div>
      </article>
    );
  }

  return (
    <section
      className="publisher-entities-page"
      aria-busy={
        searchSettling ||
        entitiesQuery.isLoading ||
        entitiesQuery.isFetching ||
        Boolean(entityRefresh) ||
        Boolean(bulkRefresh)
      }
    >
      <header className="publisher-entities-page__header">
        <div className="publisher-entities-page__brand">
          <span>
            <strong>Публик</strong>
            <small>{view === 'channel' ? 'Каналы' : 'Чаты'}</small>
          </span>
          <button
            type="button"
            className={cn('publisher-entities-page__refresh', bulkRefresh && 'is-refreshing')}
            aria-label={
              bulkRefresh?.phase === 'polling'
                ? 'Проверяются подключения в MAX'
                : 'Перепроверить подключения в MAX'
            }
            title={bulkRefresh ? 'Проверяю подключения' : 'Перепроверить подключения'}
            disabled={Boolean(bulkRefresh || entityRefresh)}
            onClick={() => void handleRefreshEntities()}
          >
            <Refresh aria-hidden />
          </button>
        </div>
      </header>

      <nav className="publisher-entities-page__views" aria-label="Получатели Публика">
        <Link
          to={buildPublisherEntityViewRoute('chat', searchParams.toString())}
          className={cn(view === 'chat' && 'is-active')}
          aria-current={view === 'chat' ? 'page' : undefined}
        >
          <span>Чаты</span>
          <strong>{summary.chat}</strong>
        </Link>
        <Link
          to={buildPublisherEntityViewRoute('channel', searchParams.toString())}
          className={cn(view === 'channel' && 'is-active')}
          aria-current={view === 'channel' ? 'page' : undefined}
        >
          <span>Каналы</span>
          <strong>{summary.channel}</strong>
        </Link>
      </nav>

      {bulkRefresh ? (
        <div className="publisher-entities-page__refresh-status" role="status" aria-live="polite">
          <Refresh className="is-refreshing" aria-hidden />
          <span>
            {bulkRefresh.phase === 'enqueueing'
              ? 'Запускаю проверку MAX'
              : `Проверяю подключений: ${bulkRefresh.queuedCount}`}
          </span>
        </div>
      ) : null}

      <label className="publisher-entities-page__search">
        <Search aria-hidden />
        <input
          type="search"
          value={query}
          maxLength={120}
          placeholder={view === 'channel' ? 'Найти канал' : 'Найти чат'}
          aria-label={view === 'channel' ? 'Найти канал' : 'Найти чат'}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        {query ? (
          <button type="button" onClick={() => setQuery('')} aria-label="Очистить поиск">
            <Xmark aria-hidden />
          </button>
        ) : null}
      </label>

      <div className="publisher-entities-page__filter-row">
        <div className="publisher-entities-page__filters" role="group" aria-label="Готовность">
          {READINESS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={cn(readinessFilter === filter.value && 'is-active')}
              aria-pressed={readinessFilter === filter.value}
              onClick={() => setReadinessFilter(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <span role="status">
          {formatEntityListStatus(
            entities.length,
            filteredTotal,
            entitiesQuery.isLoading || searchSettling,
          )}
        </span>
      </div>

      {!searchSettling && entitiesQuery.isError && entities.length > 0 ? (
        <div className="publisher-entities-page__inline-error" role="alert">
          <span>Не удалось обновить список. Показаны последние данные.</span>
          <button
            type="button"
            onClick={() =>
              void queryClient.resetQueries({ queryKey: entitiesQueryKey, exact: true })
            }
          >
            Повторить
          </button>
        </div>
      ) : null}

      {searchSettling ? (
        <div className="publisher-entities-page__state" role="status">
          <Search aria-hidden />
          <strong>Ищу получателей</strong>
        </div>
      ) : entitiesQuery.isLoading && entities.length === 0 ? (
        <div className="publisher-entities-page__state" role="status">
          <Refresh className="is-refreshing" aria-hidden />
          <strong>Загружаю {view === 'channel' ? 'каналы' : 'чаты'}</strong>
        </div>
      ) : entitiesQuery.isError && entities.length === 0 ? (
        <div className="publisher-entities-page__state has-error" role="alert">
          <WarningCircle aria-hidden />
          <strong>Не удалось загрузить получателей</strong>
          <span>Проверьте соединение и повторите запрос.</span>
          <button
            type="button"
            onClick={() =>
              void queryClient.resetQueries({ queryKey: entitiesQueryKey, exact: true })
            }
          >
            <Refresh aria-hidden />
            <span>Повторить</span>
          </button>
        </div>
      ) : shouldAutoOpenChannels ? (
        <div className="publisher-entities-page__state" role="status">
          <Refresh className="is-refreshing" aria-hidden />
          <strong>Открываю каналы</strong>
        </div>
      ) : activeTypeCount === 0 && otherTypeCount > 0 ? (
        <div className="publisher-entities-page__state" role="status">
          <strong>{view === 'channel' ? 'Каналов пока нет' : 'Чатов пока нет'}</strong>
          <span>
            В соседнем разделе:{' '}
            {formatRussianCountLabel(
              otherTypeCount,
              view === 'channel' ? 'чат' : 'канал',
              view === 'channel' ? 'чата' : 'канала',
              view === 'channel' ? 'чатов' : 'каналов',
            )}
            .
          </span>
          <Link to={buildPublisherEntityViewRoute(otherView, searchParams.toString())}>
            {view === 'channel' ? 'Открыть чаты' : 'Открыть каналы'}
            <NavArrowRight aria-hidden />
          </Link>
        </div>
      ) : activeTypeCount === 0 ? (
        <div className="publisher-entities-page__state is-onboarding" role="status">
          <strong>Подключите первый чат или канал</strong>
          <span>
            Добавьте Публик администратором, затем перешлите ему сообщение или пост из нужного чата
            или канала.
          </span>
          <button
            type="button"
            disabled={openingBotDialog || !botDialogUrl}
            onClick={handleOpenBotDialog}
          >
            <span>{openingBotDialog ? 'Открываю...' : 'Открыть диалог Публика'}</span>
            <NavArrowRight aria-hidden />
          </button>
        </div>
      ) : entities.length === 0 ? (
        <div className="publisher-entities-page__state" role="status">
          <Search aria-hidden />
          <strong>Ничего не найдено</strong>
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setReadinessFilter('all');
            }}
          >
            Сбросить фильтры
          </button>
        </div>
      ) : (
        <div
          ref={listRef}
          className={cn('publisher-entities-page__list', shouldVirtualize && 'is-virtual')}
          role="list"
          aria-label={view === 'channel' ? 'Каналы Публика' : 'Чаты Публика'}
          onScroll={
            shouldVirtualize
              ? (event) => {
                  setListScrollTop(event.currentTarget.scrollTop);
                  setListViewportHeight(event.currentTarget.clientHeight);
                }
              : undefined
          }
        >
          {shouldVirtualize ? (
            <div
              className="publisher-entities-page__virtual-spacer"
              style={{ height: `${virtualRange.totalHeight}px` } as CSSProperties}
            >
              <div
                className="publisher-entities-page__virtual-window"
                style={{ transform: `translateY(${renderedOffset}px)` }}
              >
                {renderedEntities.map(renderEntity)}
              </div>
            </div>
          ) : (
            renderedEntities.map(renderEntity)
          )}
        </div>
      )}
      {!searchSettling && entities.length > 0 && entitiesQuery.hasNextPage ? (
        <button
          type="button"
          className="publisher-entities-page__load-more"
          onClick={() =>
            void retryPublisherEntitiesNextPage({
              fetchNextPage: () => entitiesQuery.fetchNextPage(),
              resetInvalidCursor: () =>
                queryClient.resetQueries({ queryKey: entitiesQueryKey, exact: true }),
            })
          }
          disabled={entitiesQuery.isFetchingNextPage}
        >
          {entitiesQuery.isFetchingNextPage
            ? 'Загрузка...'
            : entitiesQuery.isFetchNextPageError
              ? 'Повторить'
              : 'Показать ещё'}
        </button>
      ) : null}
    </section>
  );
}
