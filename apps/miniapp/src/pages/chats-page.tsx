import { useQueryClient } from '@tanstack/react-query';
import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  RefreshDouble as IconoirRefreshDouble,
  Search as IconoirSearch,
  Star as IconoirStar,
  Xmark as IconoirXmark,
} from 'iconoir-react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ManagedEntitiesRefreshState } from '@maxim/contracts';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { describeApiError } from '../lib/api-error';
import { getMe } from '../lib/api/root-client';
import type { ApiTransport } from '../lib/api/transport';
import { saveChatTitle, saveChatTitles } from '../lib/chat-titles';
import { cn } from '../lib/cn';
import {
  getHomeEntityFavoritesFallbackScope,
  isHomeEntityFavorite,
  mergeHomeEntityFavorites,
  orderHomeEntitiesByFavorites,
  readHomeEntityFavorites,
  saveHomeEntityFavorites,
  toggleHomeEntityFavorite,
} from '../lib/home-entity-favorites';
import { getInitDataUserId } from '../lib/init-data';
import {
  buildHomeView,
  normalizeEntityType,
  readLastEntityType,
  saveLastEntityId,
  saveLastEntityType,
} from '../lib/last-chat';
import { useManagedEntitiesSync } from '../lib/use-managed-entities-sync';
import {
  MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_HIDDEN_MS,
  buildManagedEntitiesSettledMarker,
  useManagedEntitiesVisibilityRefresh,
} from '../lib/use-managed-entities-visibility-refresh';
import {
  preloadChannelSettingsPage,
  preloadChannelStatsPage,
  preloadEventsPage,
  preloadSettingsPage,
} from './lazy-pages';

type ManagedTab = 'chat' | 'channel';
type HomeSyncTone = 'ready' | 'syncing' | 'cache' | 'warning';
type ManagedEntitiesReloadRequest = {
  nonce: number;
  behavior: 'default' | 'manual' | 'recovery';
};

const CHAT_CARD_STAGGER_STEP_MS = 45;
const CHAT_CARD_STAGGER_LIMIT = 10;
const CHAT_CARD_STAGGER_THRESHOLD = 24;
const DEFAULT_DASHBOARD_RANGE = '24h';
const DEFAULT_CHANNEL_STATS_RANGE = '7d';
const HOME_MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_INTERVAL_MS = 2_000;
const HOME_BOT_BADGE_LABEL = import.meta.env.VITE_APP_NAME?.trim() || 'Майор Максимов';

const LazySystemEntryCard = lazy(async () => {
  const module = await import('../components/system-entry-card');
  return { default: module.SystemEntryCard };
});

const LazyChatOnboardingSection = lazy(async () => {
  const module = await import('../components/chat-onboarding-section');
  return { default: module.ChatOnboardingSection };
});

function getEntitiesKey(tab: ManagedTab): 'chats' | 'channels' {
  return tab === 'chat' ? 'chats' : 'channels';
}

function shouldPrefetchFromPointerEvent(event: ReactPointerEvent<HTMLElement>): boolean {
  return event.pointerType === 'mouse';
}

function formatRefreshProgress(refreshState: ManagedEntitiesRefreshState | null): string | null {
  if (
    typeof refreshState?.processedCandidates === 'number' &&
    typeof refreshState.totalCandidates === 'number' &&
    refreshState.totalCandidates >= refreshState.processedCandidates
  ) {
    return `${refreshState.processedCandidates} из ${refreshState.totalCandidates}`;
  }
  if (typeof refreshState?.progressPercent === 'number') {
    return `${refreshState.progressPercent}%`;
  }

  return null;
}

function buildPendingSyncDescription(options: {
  tab: ManagedTab;
  refreshState: ManagedEntitiesRefreshState | null;
  hasLoadedFromServer: boolean;
}): string {
  const entityPlural = options.tab === 'chat' ? 'чаты' : 'каналы';
  const progress = formatRefreshProgress(options.refreshState);

  if (!options.hasLoadedFromServer) {
    return `Проверяем ${entityPlural} на сервере и подтягиваем контекст запуска.`;
  }
  if (progress) {
    return `Сверяем права администратора в MAX. Прогресс: ${progress}.`;
  }

  return 'Обновляем локальный список и сверяем права администратора в MAX.';
}

function buildHomeSyncStatus(options: {
  isRefreshing: boolean;
  isBackoffActive: boolean;
  hasLoadedFromServer: boolean;
  snapshotStale: boolean | null | undefined;
  isSyncComplete: boolean;
}): { label: string; tone: HomeSyncTone } {
  if (options.isBackoffActive) {
    return { label: 'Пауза', tone: 'warning' };
  }
  if (options.isRefreshing || options.snapshotStale === true) {
    return { label: 'Синк', tone: 'syncing' };
  }
  if (!options.hasLoadedFromServer) {
    return { label: 'Кеш', tone: 'cache' };
  }
  if (options.isSyncComplete) {
    return { label: 'Готово', tone: 'ready' };
  }

  return { label: 'Синк', tone: 'syncing' };
}

export function ChatsPage({ api }: { api: ApiTransport }) {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [canAccessSystem, setCanAccessSystem] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(() => getInitDataUserId());
  const favoriteStorageScope = useMemo(() => {
    const normalizedUserId = currentUserId?.trim();
    return normalizedUserId ? `u:${normalizedUserId}` : getHomeEntityFavoritesFallbackScope();
  }, [currentUserId]);
  const favoriteStorageScopeRef = useRef(favoriteStorageScope);
  const [homeEntityFavorites, setHomeEntityFavorites] = useState(() =>
    readHomeEntityFavorites(favoriteStorageScope),
  );
  const [refreshRequestByTab, setRefreshRequestByTab] = useState<
    Record<ManagedTab, ManagedEntitiesReloadRequest>
  >({
    chat: { nonce: 0, behavior: 'default' },
    channel: { nonce: 0, behavior: 'default' },
  });
  const activeTab = normalizeEntityType(
    searchParams.get('view'),
    readLastEntityType(),
  ) as ManagedTab;
  const activeEntitiesKey = getEntitiesKey(activeTab);
  const chatsState = useManagedEntitiesSync({
    api,
    entityType: 'chat',
    enabled: activeTab === 'chat',
    reloadNonce: refreshRequestByTab.chat.nonce,
    reloadBehavior: refreshRequestByTab.chat.behavior,
    resumeOnVisibilityReturn: true,
    backgroundRefreshOnFirstLoad: true,
    freshOnBackgroundRefresh: false,
    freshOnManualReload: false,
    persistLocalCache: true,
    localCacheScope: 'home',
    preserveVisibleDataOnEmptyComplete: true,
    keepVisibleOnSameSnapshotVersion: true,
  });
  const channelsState = useManagedEntitiesSync({
    api,
    entityType: 'channel',
    enabled: activeTab === 'channel',
    reloadNonce: refreshRequestByTab.channel.nonce,
    reloadBehavior: refreshRequestByTab.channel.behavior,
    resumeOnVisibilityReturn: true,
    backgroundRefreshOnFirstLoad: true,
    freshOnBackgroundRefresh: false,
    freshOnManualReload: false,
    persistLocalCache: true,
    localCacheScope: 'home',
    preserveVisibleDataOnEmptyComplete: true,
    keepVisibleOnSameSnapshotVersion: true,
  });

  const activeEntities = useMemo(() => {
    return activeEntitiesKey === 'chats' ? chatsState.data : channelsState.data;
  }, [activeEntitiesKey, channelsState.data, chatsState.data]);

  const activeEntitiesState = activeTab === 'chat' ? chatsState : channelsState;
  const isLoading = activeEntitiesState.isLoading;
  const isFetching = activeEntitiesState.isRefreshing;
  const queryError = activeEntitiesState.error;
  const refreshState = activeEntitiesState.refreshState;
  const manualRefreshBlockedReason = refreshState?.manualRefreshBlockedReason ?? null;
  const manualRefreshRetryAfterSec =
    typeof refreshState?.manualRefreshRetryAfterMs === 'number' &&
    refreshState.manualRefreshRetryAfterMs > 0
      ? Math.max(1, Math.ceil(refreshState.manualRefreshRetryAfterMs / 1_000))
      : null;
  const isSyncSettled = activeEntitiesState.isSyncComplete || activeEntitiesState.isBackoffActive;
  const isSyncPending = !isLoading && !queryError && !isSyncSettled;
  const isRefreshTemporarilyBlocked =
    manualRefreshBlockedReason === 'backoff' && (manualRefreshRetryAfterSec ?? 0) > 0;
  const isManualRefreshCoolingDown =
    manualRefreshBlockedReason === 'recent_sync' && (manualRefreshRetryAfterSec ?? 0) > 0;
  const isManualRefreshInProgressByState =
    manualRefreshBlockedReason === 'in_progress' &&
    !activeEntitiesState.isRefreshing &&
    !activeEntitiesState.isSyncComplete;
  const isManualRefreshBlocked =
    isRefreshTemporarilyBlocked || isManualRefreshCoolingDown || isManualRefreshInProgressByState;
  const homeSyncStatus = buildHomeSyncStatus({
    isRefreshing: isFetching,
    isBackoffActive: activeEntitiesState.isBackoffActive,
    hasLoadedFromServer: activeEntitiesState.hasLoadedFromServer,
    snapshotStale: activeEntitiesState.snapshot?.stale ?? null,
    isSyncComplete: activeEntitiesState.isSyncComplete,
  });
  const refreshProgressPercent =
    !activeEntitiesState.isSyncComplete &&
    !activeEntitiesState.isBackoffActive &&
    typeof refreshState?.progressPercent === 'number'
      ? Math.max(0, Math.min(100, refreshState.progressPercent))
      : null;

  const hasNoActiveEntities =
    !isLoading && !queryError && Array.isArray(activeEntities) && activeEntities.length === 0;
  const showTransientEmptyState = hasNoActiveEntities && activeEntitiesState.isBackoffActive;
  const isNoEntitiesForTab = hasNoActiveEntities && isSyncSettled && !showTransientEmptyState;

  const [filteredEntities, visibleEntitiesCount] = useMemo(() => {
    const [matchingEntities, matchingCount] = buildHomeView({
      entities: activeEntities,
      query,
    });

    return [
      orderHomeEntitiesByFavorites(matchingEntities, homeEntityFavorites[activeTab]),
      matchingCount,
    ] as const;
  }, [activeEntities, activeTab, homeEntityFavorites, query]);
  const totalEntitiesCount = Array.isArray(activeEntities) ? activeEntities.length : 0;
  const favoriteEntitiesCount = useMemo(() => {
    if (!Array.isArray(activeEntities) || activeEntities.length === 0) {
      return 0;
    }

    return activeEntities.filter((entity) =>
      isHomeEntityFavorite(homeEntityFavorites, activeTab, entity.id),
    ).length;
  }, [activeEntities, activeTab, homeEntityFavorites]);
  const hasSearchQuery = query.trim().length > 0;
  const showEmptyState = isNoEntitiesForTab;
  const limitedStagger =
    filteredEntities.length > CHAT_CARD_STAGGER_THRESHOLD ? CHAT_CARD_STAGGER_LIMIT : null;
  const settledRefreshMarker = useMemo(
    () =>
      buildManagedEntitiesSettledMarker({
        scopeKey: activeTab,
        hasLoadedFromServer: activeEntitiesState.hasLoadedFromServer,
        isSyncComplete: activeEntitiesState.isSyncComplete,
        isBackoffActive: activeEntitiesState.isBackoffActive,
        snapshotVersion: activeEntitiesState.snapshot?.version,
        snapshotBuiltAt: activeEntitiesState.snapshot?.builtAt,
        lastSyncedAt: activeEntitiesState.refreshState?.lastSyncedAt,
      }),
    [
      activeEntitiesState.hasLoadedFromServer,
      activeEntitiesState.isBackoffActive,
      activeEntitiesState.isSyncComplete,
      activeEntitiesState.refreshState?.lastSyncedAt,
      activeEntitiesState.snapshot?.builtAt,
      activeEntitiesState.snapshot?.version,
      activeTab,
    ],
  );
  const { noteRefreshRequested } = useManagedEntitiesVisibilityRefresh({
    enabled: true,
    hasLoadedFromServer: activeEntitiesState.hasLoadedFromServer,
    isLoading: activeEntitiesState.isLoading,
    isRefreshing: activeEntitiesState.isRefreshing,
    isSyncComplete: activeEntitiesState.isSyncComplete,
    snapshotStale: activeEntitiesState.snapshot?.stale ?? null,
    settledMarker: settledRefreshMarker,
    minIntervalMs: HOME_MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_INTERVAL_MS,
    minHiddenDurationMs: MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_HIDDEN_MS,
    onVisibilityReturnRefresh: () => {
      handleRefresh(activeTab, 'recovery');
    },
  });

  function queueRefresh(tab: ManagedTab, behavior: ManagedEntitiesReloadRequest['behavior']) {
    noteRefreshRequested();
    setRefreshRequestByTab((current) => ({
      ...current,
      [tab]: {
        nonce: current[tab].nonce + 1,
        behavior,
      },
    }));
  }

  function handleRefresh(
    tab: ManagedTab = activeTab,
    behavior: ManagedEntitiesReloadRequest['behavior'] = 'default',
  ) {
    if (isFetching) {
      return;
    }
    if (behavior !== 'recovery' && isManualRefreshBlocked) {
      return;
    }

    queueRefresh(tab, behavior);
  }

  useEffect(() => {
    const allEntities = [...(chatsState.data ?? []), ...(channelsState.data ?? [])];
    if (allEntities.length === 0) {
      return;
    }

    saveChatTitles(allEntities);
  }, [channelsState.data, chatsState.data]);

  useEffect(() => {
    saveLastEntityType(activeTab);
  }, [activeTab]);

  useEffect(() => {
    const previousScope = favoriteStorageScopeRef.current;
    if (previousScope === favoriteStorageScope) {
      return;
    }

    const storedFavorites = readHomeEntityFavorites(favoriteStorageScope);
    const nextFavorites =
      previousScope === getHomeEntityFavoritesFallbackScope() &&
      favoriteStorageScope !== getHomeEntityFavoritesFallbackScope()
        ? mergeHomeEntityFavorites(storedFavorites, readHomeEntityFavorites(previousScope))
        : storedFavorites;

    if (nextFavorites !== storedFavorites) {
      saveHomeEntityFavorites(favoriteStorageScope, nextFavorites);
    }

    favoriteStorageScopeRef.current = favoriteStorageScope;
    setHomeEntityFavorites(nextFavorites);
  }, [favoriteStorageScope]);

  useEffect(() => {
    const controller = new AbortController();

    void getMe(api, { signal: controller.signal })
      .then((me) => {
        if (!controller.signal.aborted) {
          setCurrentUserId(me.userId);
          setCanAccessSystem(me.canAccessSystem === true);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setCanAccessSystem(false);
        }
      });

    return () => controller.abort();
  }, [api]);

  function prefetchChatSettings(chatId: string) {
    void chatId;
    preloadSettingsPage();
  }

  function prefetchChatEvents(chatId: string) {
    preloadEventsPage();
    void queryClient
      .prefetchQuery({
        queryKey: ['logs-dashboard', chatId, DEFAULT_DASHBOARD_RANGE, false, true],
        queryFn: () =>
          api.request(
            `/chats/${chatId}/logs-dashboard?range=${encodeURIComponent(
              DEFAULT_DASHBOARD_RANGE,
            )}&includeActivityPreview=false`,
          ),
      })
      .catch(() => undefined);
  }

  function prefetchChannelSettings(chatId: string) {
    void chatId;
    preloadChannelSettingsPage();
  }

  function handleToggleHomeEntityFavorite(entityType: ManagedTab, entityId: string) {
    setHomeEntityFavorites((current) => {
      const next = toggleHomeEntityFavorite(current, entityType, entityId).favorites;
      saveHomeEntityFavorites(favoriteStorageScope, next);
      return next;
    });
  }

  function prefetchChannelStats(chatId: string) {
    preloadChannelStatsPage();
    void queryClient
      .prefetchQuery({
        queryKey: ['channel-stats', chatId, DEFAULT_CHANNEL_STATS_RANGE],
        queryFn: () =>
          api.request(
            `/channels/${chatId}/stats?range=${encodeURIComponent(DEFAULT_CHANNEL_STATS_RANGE)}`,
          ),
      })
      .catch(() => undefined);
  }

  const tabLabel = activeTab === 'chat' ? 'Чаты' : 'Каналы';
  const searchLabel = activeTab === 'chat' ? 'Поиск чата' : 'Поиск канала';
  const searchPlaceholder = activeTab === 'chat' ? 'Поиск чата' : 'Поиск канала';
  const showSystemCard = canAccessSystem;

  return (
    <div className={cn('page-stack page-enter chats-home', `chats-home--${activeTab}`)}>
      <GlassCard
        className={cn('chats-search-card', isFetching && 'is-syncing')}
        padding="sm"
        elevated
      >
        <div className="chats-search-card__head">
          <div className="chats-search-card__title">
            <div className="chats-search-card__title-row">
              <div className="chats-search-card__heading">
                <span className="chats-search-card__eyebrow" title={HOME_BOT_BADGE_LABEL}>
                  {HOME_BOT_BADGE_LABEL}
                </span>
                <h1>{tabLabel}</h1>
              </div>
              <div className="chats-search-card__meta">
                <span className={cn('chats-search-card__sync-chip', `is-${homeSyncStatus.tone}`)}>
                  <span className="chats-search-card__sync-dot" aria-hidden />
                  {homeSyncStatus.label}
                </span>
                <button
                  type="button"
                  className="button button--ghost chats-search-card__refresh"
                  onClick={() => handleRefresh(activeTab, 'manual')}
                  disabled={isFetching || isManualRefreshBlocked}
                  aria-label="Обновить"
                  title="Обновить"
                >
                  <IconoirRefreshDouble
                    aria-hidden
                    className={isFetching ? 'is-spinning' : undefined}
                  />
                </button>
              </div>
            </div>
            {refreshProgressPercent !== null ? (
              <div
                className="chats-search-card__progress"
                aria-label={`Синхронизация ${refreshProgressPercent}%`}
                style={
                  {
                    '--chats-sync-progress': `${refreshProgressPercent}%`,
                  } as CSSProperties
                }
              />
            ) : null}
          </div>
        </div>

        <div className="chats-search-card__metrics" aria-label="Сводка">
          <span className="chats-search-card__metric">
            <strong>{hasSearchQuery ? visibleEntitiesCount : totalEntitiesCount}</strong>
            <span>{hasSearchQuery ? 'Найдено' : 'В списке'}</span>
          </span>
          <span className="chats-search-card__metric">
            <strong>{favoriteEntitiesCount}</strong>
            <span>Избранное</span>
          </span>
        </div>

        <label className="field field--search chats-search-card__field" htmlFor="chat-search">
          <span>{searchLabel}</span>
          <div className="chats-search-card__field-shell">
            <IconoirSearch aria-hidden className="chats-search-card__search-icon" />
            <input
              id="chat-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
            />
            {hasSearchQuery ? (
              <button
                type="button"
                className="chats-search-card__clear"
                onClick={() => setQuery('')}
                aria-label="Очистить поиск"
                title="Очистить поиск"
              >
                <IconoirXmark aria-hidden />
              </button>
            ) : null}
          </div>
        </label>
      </GlassCard>

      {showSystemCard ? (
        <Suspense fallback={null}>
          <LazySystemEntryCard api={api} />
        </Suspense>
      ) : null}

      {showTransientEmptyState ? (
        <GlassCard className="chats-transient-state">
          <StatusState
            tone="warning"
            title="MAX на паузе"
            description={
              manualRefreshRetryAfterSec
                ? `Повтор через ${manualRefreshRetryAfterSec} сек.`
                : 'Список восстановится автоматически.'
            }
            action={
              <button
                type="button"
                className="button button--ghost"
                onClick={() => handleRefresh(activeTab, 'recovery')}
                disabled={isFetching || isRefreshTemporarilyBlocked}
              >
                Проверить
              </button>
            }
          />
        </GlassCard>
      ) : null}

      {isLoading ? (
        <section className="chat-grid" aria-label="Загрузка">
          {Array.from({ length: 4 }).map((_, index) => (
            <GlassCard key={index} as="article" className="chat-card">
              <SkeletonCard lines={3} />
            </GlassCard>
          ))}
        </section>
      ) : null}

      {queryError ? (
        <GlassCard>
          <StatusState
            tone="danger"
            title="Не удалось загрузить список"
            description={describeApiError(queryError, 'Не удалось загрузить список.')}
            action={
              <button
                type="button"
                className="button button--danger"
                onClick={() => handleRefresh(activeTab, 'manual')}
              >
                Повторить
              </button>
            }
          />
        </GlassCard>
      ) : null}

      {isSyncPending && Array.isArray(activeEntities) && activeEntities.length === 0 ? (
        <GlassCard>
          <StatusState
            tone="neutral"
            title={`Синхронизируем ${tabLabel.toLowerCase()}`}
            description={buildPendingSyncDescription({
              tab: activeTab,
              refreshState,
              hasLoadedFromServer: activeEntitiesState.hasLoadedFromServer,
            })}
          />
        </GlassCard>
      ) : null}

      {showEmptyState && activeTab === 'chat' ? (
        <Suspense
          fallback={
            <GlassCard>
              <StatusState
                tone="neutral"
                title="Нет доступных чатов"
                description="Загружаем подсказки по подключению."
              />
            </GlassCard>
          }
        >
          <LazyChatOnboardingSection
            isFetching={isFetching}
            isRefreshBlocked={isRefreshTemporarilyBlocked}
            onRefresh={() => handleRefresh(activeTab, 'manual')}
          />
        </Suspense>
      ) : null}

      {showEmptyState && activeTab === 'channel' ? (
        <GlassCard>
          <StatusState
            tone="neutral"
            title="Каналы не найдены"
            description="Добавьте бота в канал с правами администратора, затем откройте mini app из этого канала и дождитесь серверной проверки."
            action={
              <button
                type="button"
                className="button button--accent"
                onClick={() => handleRefresh(activeTab, 'manual')}
                disabled={isFetching || isRefreshTemporarilyBlocked}
              >
                {isFetching ? 'Обновляем...' : 'Обновить'}
              </button>
            }
          />
        </GlassCard>
      ) : null}

      {!isLoading &&
      !queryError &&
      !showEmptyState &&
      Array.isArray(activeEntities) &&
      activeEntities.length > 0 &&
      filteredEntities.length === 0 ? (
        <GlassCard>
          <StatusState
            tone="neutral"
            title={`${tabLabel} не найдены`}
            description="Попробуйте изменить поисковый запрос."
          />
        </GlassCard>
      ) : null}

      {!isLoading && !queryError && !showEmptyState && filteredEntities.length > 0 ? (
        <section className="chat-grid" aria-label="Список">
          {filteredEntities.map((entity, index) => {
            const favorite = isHomeEntityFavorite(homeEntityFavorites, activeTab, entity.id);
            const staggerIndex =
              limitedStagger === null ? index : index < limitedStagger ? index : null;
            const className = cn(
              'chat-card',
              favorite && 'is-favorite',
              staggerIndex !== null && 'stagger-in',
              homeSyncStatus.tone === 'cache' && 'is-from-cache',
              homeSyncStatus.tone === 'warning' && 'is-paused',
            );
            const style =
              staggerIndex === null
                ? undefined
                : { animationDelay: `${staggerIndex * CHAT_CARD_STAGGER_STEP_MS}ms` };

            return (
              <GlassCard as="article" key={entity.id} className={className} style={style}>
                <div className="chat-card__header">
                  <div className="chat-card__identity">
                    <EntityAvatar
                      title={entity.title}
                      entityType={activeTab}
                      avatarUrl={entity.avatarUrl ?? null}
                      className="chat-card__avatar"
                    />
                    <div className="chat-card__title-wrap">
                      <h3>{entity.title}</h3>
                    </div>
                  </div>
                  <button
                    type="button"
                    className={cn('chat-card__favorite', favorite && 'is-active')}
                    onClick={() => handleToggleHomeEntityFavorite(activeTab, entity.id)}
                    aria-pressed={favorite}
                    aria-label={favorite ? 'Убрать из избранного' : 'Добавить в избранное'}
                    title={favorite ? 'Убрать из избранного' : 'Добавить в избранное'}
                  >
                    <IconoirStar aria-hidden />
                  </button>
                </div>

                {activeTab === 'chat' ? (
                  <div className="chat-card__actions">
                    <Link
                      to={`/chat/${entity.id}/settings`}
                      className="button button--accent"
                      state={{ chatTitle: entity.title, avatarUrl: entity.avatarUrl ?? null }}
                      onClick={() => {
                        saveLastEntityId('chat', entity.id);
                        saveChatTitle(entity.id, entity.title);
                      }}
                      onPointerEnter={(event) => {
                        if (shouldPrefetchFromPointerEvent(event)) {
                          prefetchChatSettings(entity.id);
                        }
                      }}
                    >
                      Настройки
                    </Link>
                    <Link
                      to={`/chat/${entity.id}/events`}
                      className="button button--ghost"
                      state={{ chatTitle: entity.title, avatarUrl: entity.avatarUrl ?? null }}
                      onClick={() => {
                        prefetchChatEvents(entity.id);
                        saveLastEntityId('chat', entity.id);
                        saveChatTitle(entity.id, entity.title);
                      }}
                      onPointerEnter={(event) => {
                        if (shouldPrefetchFromPointerEvent(event)) {
                          prefetchChatEvents(entity.id);
                        }
                      }}
                    >
                      События
                    </Link>
                  </div>
                ) : (
                  <div className="chat-card__actions">
                    <Link
                      to={`/channel/${entity.id}/settings`}
                      className="button button--accent"
                      state={{
                        chatTitle: entity.title,
                        chatLink: entity.link ?? '',
                        avatarUrl: entity.avatarUrl ?? null,
                      }}
                      onClick={() => {
                        saveLastEntityId('channel', entity.id);
                        saveChatTitle(entity.id, entity.title);
                      }}
                      onPointerEnter={(event) => {
                        if (shouldPrefetchFromPointerEvent(event)) {
                          prefetchChannelSettings(entity.id);
                        }
                      }}
                    >
                      Настройки
                    </Link>
                    <Link
                      to={`/channel/${entity.id}/stats`}
                      className="button button--ghost"
                      state={{ chatTitle: entity.title, avatarUrl: entity.avatarUrl ?? null }}
                      onClick={() => {
                        saveLastEntityId('channel', entity.id);
                        saveChatTitle(entity.id, entity.title);
                      }}
                      onPointerEnter={(event) => {
                        if (shouldPrefetchFromPointerEvent(event)) {
                          prefetchChannelStats(entity.id);
                        }
                      }}
                    >
                      Статистика
                    </Link>
                  </div>
                )}
              </GlassCard>
            );
          })}
        </section>
      ) : null}
    </div>
  );
}
