import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { PublisherEntitiesSummary, PublisherEntity } from '@maxim/contracts/publisher';
import {
  CheckCircle,
  OpenNewWindow,
  Plus,
  Refresh,
  Search,
  WarningCircle,
  Xmark,
} from 'iconoir-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useSearchParams } from 'react-router';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { useToast } from '../components/ui/toast';
import { formatRussianCountLabel } from '../lib/broadcast-audience';
import { cn } from '../lib/cn';
import {
  getPublisherEntity,
  listPublisherEntities,
  refreshPublisherEntity,
  updatePublisherPolicy,
} from '../lib/api/publisher-client';
import type { ApiTransport } from '../lib/api/transport';
import { openMaxBotLinkAndClose } from '../lib/max-bridge';
import { getPublisherReadinessPresentation } from '../lib/publisher-readiness';
import { describeUserFacingError } from '../lib/user-facing-error';
import { resolveVirtualListRange } from '../lib/virtual-list';
import {
  getPublisherEntityCapabilities,
  normalizePublisherEntityView,
  pollPublisherEntityRefresh,
  PUBLISHER_ENTITY_REFRESH_POLL_DELAYS_MS,
  resolvePublisherEntityPrimaryAction,
  retryPublisherEntitiesNextPage,
  shouldOfferPublisherRecheck,
  type PublisherEntityReadinessFilter,
} from './publisher-entities-page-model';
import './publisher-entities-page.css';

const PUBLISHER_ENTITIES_QUERY_ROOT = ['publications', 'sources', 'publisher'] as const;
const PUBLISHER_ENTITY_PAGE_SIZE = 30;
const PUBLISHER_ENTITY_ROW_HEIGHT = 196;
const PUBLISHER_ENTITY_LIST_INITIAL_HEIGHT = 680;
const PUBLISHER_ENTITY_VIRTUALIZATION_THRESHOLD = 60;
const PUBLISHER_ENTITY_LIST_OVERSCAN = 4;
const PUBLISHER_ENTITY_SEARCH_DEBOUNCE_MS = 250;

type PublisherEntityRefreshState = {
  entityKey: string;
  phase: 'enqueueing' | 'polling';
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

function waitForPublisherRefresh(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let timeoutId: number | null = null;
    const finish = () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      signal.removeEventListener('abort', finish);
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    timeoutId = window.setTimeout(finish, delayMs);
  });
}

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

export function PublisherEntitiesPage({
  api,
  botDialogUrl = null,
}: {
  api: ApiTransport;
  botDialogUrl?: string | null;
}) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [readinessFilter, setReadinessFilter] = useState<PublisherEntityReadinessFilter>('all');
  const [listScrollTop, setListScrollTop] = useState(0);
  const [listViewportHeight, setListViewportHeight] = useState(
    PUBLISHER_ENTITY_LIST_INITIAL_HEIGHT,
  );
  const [entityRefresh, setEntityRefresh] = useState<PublisherEntityRefreshState | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const view = normalizePublisherEntityView(searchParams.get('view'));
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
  const policyMutation = useMutation({
    mutationFn: ({ entity, enabled }: { entity: PublisherEntity; enabled: boolean }) =>
      updatePublisherPolicy(api, entity.entityType, entity.id, {
        expectedRevision: entity.policy.revision,
        suggestionsViaPublik: enabled,
      }),
    onSuccess: async () => {
      await queryClient.resetQueries({ queryKey: PUBLISHER_ENTITIES_QUERY_ROOT });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось сохранить настройки предложек'),
      });
    },
  });
  const entities = useMemo(
    () => entitiesQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [entitiesQuery.data?.pages],
  );
  const summary = entitiesQuery.data?.pages[0]?.summary ?? EMPTY_PUBLISHER_SUMMARY;
  const filteredTotal = entitiesQuery.data?.pages[0]?.filteredTotal ?? 0;
  const activeTypeCount = summary[view];
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

  async function handleRefreshEntity(entity: PublisherEntity): Promise<void> {
    const entityKey = `${entity.entityType}:${entity.id}`;
    if (entityRefresh || refreshAbortRef.current) {
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

  function handleOpenMaxAction(url: string, label: string): void {
    if (!openMaxBotLinkAndClose(url)) {
      pushToast({ tone: 'danger', title: `Не удалось ${label.toLocaleLowerCase('ru-RU')}` });
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
    const primaryAction = resolvePublisherEntityPrimaryAction(entity, botDialogUrl);
    const canRecheck = shouldOfferPublisherRecheck(entity);
    const capabilities = getPublisherEntityCapabilities(entity).filter(
      (capability) =>
        capability.key !== 'suggestions' &&
        !(capability.key === 'posting' && primaryAction.kind === 'compose'),
    );

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

        <div className="publisher-entity-row__capabilities" aria-label="Возможности получателя">
          {primaryAction.kind === 'compose' ? (
            <Link
              to={primaryAction.href}
              className="publisher-entity-row__module-action"
              aria-label={`Создать пост для ${entity.title || entity.id}`}
            >
              <Plus aria-hidden />
              <span>{primaryAction.label}</span>
            </Link>
          ) : null}
          {capabilities.map((capability) => (
            <span key={capability.key} className={`is-${capability.tone}`}>
              {capability.label}
            </span>
          ))}
          {entity.entityType === 'channel' ? (
            <label className="publisher-entity-row__module-toggle">
              <span>Предложки</span>
              <input
                type="checkbox"
                checked={entity.policy.suggestionsViaPublik}
                disabled={policyMutation.isPending || !entity.policy.publikEnabled}
                aria-label={`${
                  entity.policy.suggestionsViaPublik ? 'Выключить' : 'Включить'
                } предложки через Публик для ${entity.title || entity.id}`}
                onChange={(event) =>
                  policyMutation.mutate({ entity, enabled: event.target.checked })
                }
              />
              <span className="publisher-entity-row__module-track" aria-hidden>
                <span className="publisher-entity-row__module-thumb" />
              </span>
            </label>
          ) : null}
        </div>

        {primaryAction.kind !== 'compose' || canRecheck ? (
          <div className="publisher-entity-row__actions">
            {primaryAction.kind === 'max_link' ? (
              <button
                type="button"
                className="publisher-entity-row__primary"
                onClick={() => handleOpenMaxAction(primaryAction.url, primaryAction.label)}
              >
                <OpenNewWindow aria-hidden />
                <span>{primaryAction.label}</span>
              </button>
            ) : primaryAction.kind === 'note' ? (
              <span className="publisher-entity-row__action-note">{primaryAction.label}</span>
            ) : null}
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
                disabled={Boolean(entityRefresh)}
                onClick={() => void handleRefreshEntity(entity)}
              >
                <Refresh aria-hidden />
              </button>
            ) : null}
          </div>
        ) : null}
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
        Boolean(entityRefresh)
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
            className={cn(
              'publisher-entities-page__refresh',
              entitiesQuery.isFetching && 'is-refreshing',
            )}
            aria-label="Обновить чаты и каналы"
            title="Обновить"
            disabled={entitiesQuery.isFetching}
            onClick={() =>
              void queryClient.resetQueries({ queryKey: entitiesQueryKey, exact: true })
            }
          >
            <Refresh aria-hidden />
          </button>
        </div>
        <div className="publisher-entities-page__totals" aria-live="polite">
          <span className="is-ready">
            <CheckCircle aria-hidden />
            {formatRussianCountLabel(summary.ready, 'готов', 'готовы', 'готовы')}
          </span>
          <span className={cn(summary.attention > 0 && 'is-attention')}>
            <WarningCircle aria-hidden />
            {formatRussianCountLabel(
              summary.attention,
              'требует внимания',
              'требуют внимания',
              'требуют внимания',
            )}
          </span>
        </div>
      </header>

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
      ) : activeTypeCount === 0 ? (
        <div className="publisher-entities-page__state" role="status">
          <WarningCircle aria-hidden />
          <strong>{view === 'channel' ? 'Каналов пока нет' : 'Чатов пока нет'}</strong>
          <span>
            Добавьте Публик {view === 'channel' ? 'в канал' : 'в чат'} администратором и отправьте
            «Старт».
          </span>
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
