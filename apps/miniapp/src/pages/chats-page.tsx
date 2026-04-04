import { useQueryClient } from '@tanstack/react-query';
import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ManagedEntitiesRefreshState } from '@maxim/contracts';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { describeApiError } from '../lib/api-error';
import type { ApiTransport } from '../lib/api/transport';
import { saveChatTitle, saveChatTitles } from '../lib/chat-titles';
import {
  buildHomeView,
  normalizeEntityType,
  readLastEntityType,
  saveLastEntityId,
  saveLastEntityType,
  type VisibleLaunchContext,
} from '../lib/last-chat';
import { useManagedEntitiesSync } from '../lib/use-managed-entities-sync';
import {
  preloadChannelSettingsPage,
  preloadChannelStatsPage,
  preloadEventsPage,
  preloadSettingsPage,
} from './lazy-pages';

type ManagedTab = 'chat' | 'channel';
type ManagedEntitiesReloadRequest = {
  nonce: number;
  behavior: 'default' | 'manual' | 'recovery';
};

const LIST_VISIBILITY_REFRESH_MIN_INTERVAL_MS = 15_000;
const CHAT_CARD_STAGGER_STEP_MS = 45;
const CHAT_CARD_STAGGER_LIMIT = 10;
const CHAT_CARD_STAGGER_THRESHOLD = 24;
const DEFAULT_DASHBOARD_RANGE = '24h';
const DEFAULT_CHANNEL_STATS_RANGE = '7d';

const LazySystemEntryCard = lazy(async () => {
  const module = await import('../components/system-entry-card');
  return { default: module.SystemEntryCard };
});

const LazyChatOnboardingSection = lazy(async () => {
  const module = await import('../components/chat-onboarding-section');
  return { default: module.ChatOnboardingSection };
});

const LazyLaunchContextSection = lazy(async () => {
  const module = await import('../components/launch-context-section');
  return { default: module.LaunchContextSection };
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

function formatRefreshTime(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return new Date(timestamp).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function buildRefreshStatusLabel(options: {
  refreshState: ManagedEntitiesRefreshState | null;
  isRefreshing: boolean;
  hasLoadedFromServer: boolean;
}): string | null {
  const { refreshState, isRefreshing, hasLoadedFromServer } = options;
  const progress = formatRefreshProgress(refreshState);

  if (!hasLoadedFromServer) {
    return 'Проверяем список на сервере.';
  }
  if (isRefreshing) {
    return progress ? `Фоновый синк: ${progress}.` : 'Фоновый синк списка.';
  }
  if (refreshState?.backoffActive) {
    return 'MAX временно ограничил синк. Продолжим автоматически.';
  }
  if (refreshState?.manualRefreshBlockedReason === 'recent_sync') {
    const syncedAt = formatRefreshTime(refreshState.lastSyncedAt);
    return syncedAt ? `Синхронизировано в ${syncedAt}.` : 'Недавно синхронизировано.';
  }
  if (refreshState?.complete) {
    const syncedAt = formatRefreshTime(refreshState.lastSyncedAt);
    return syncedAt ? `Обновлено в ${syncedAt}.` : 'Список синхронизирован.';
  }

  return progress ? `Синк: ${progress}.` : null;
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

export function ChatsPage({ api }: { api: ApiTransport }) {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [canAccessSystem, setCanAccessSystem] = useState(false);
  const [launchContextTabHint, setLaunchContextTabHint] = useState<ManagedTab | null>(null);
  const [visibleLaunchContext, setVisibleLaunchContext] = useState<VisibleLaunchContext | null>(
    null,
  );
  const [refreshRequestByTab, setRefreshRequestByTab] = useState<
    Record<ManagedTab, ManagedEntitiesReloadRequest>
  >({
    chat: { nonce: 0, behavior: 'default' },
    channel: { nonce: 0, behavior: 'default' },
  });
  const lastRefreshAtRef = useRef(0);
  const awaitingReturnRefreshRef = useRef(false);
  const activeTab = normalizeEntityType(
    searchParams.get('view'),
    launchContextTabHint ?? readLastEntityType(),
  ) as ManagedTab;
  const activeEntitiesKey = getEntitiesKey(activeTab);
  const chatsState = useManagedEntitiesSync({
    api,
    entityType: 'chat',
    enabled: activeTab === 'chat' || launchContextTabHint === 'chat',
    reloadNonce: refreshRequestByTab.chat.nonce,
    reloadBehavior: refreshRequestByTab.chat.behavior,
    resumeOnVisibilityReturn: true,
    backgroundRefreshOnFirstLoad: true,
    persistLocalCache: true,
    localCacheScope: 'home',
    preserveVisibleDataOnEmptyComplete: true,
    keepVisibleOnSameSnapshotVersion: true,
  });
  const channelsState = useManagedEntitiesSync({
    api,
    entityType: 'channel',
    enabled: activeTab === 'channel' || launchContextTabHint === 'channel',
    reloadNonce: refreshRequestByTab.channel.nonce,
    reloadBehavior: refreshRequestByTab.channel.behavior,
    resumeOnVisibilityReturn: true,
    backgroundRefreshOnFirstLoad: true,
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
    manualRefreshBlockedReason === 'in_progress' && !activeEntitiesState.isRefreshing;
  const isManualRefreshBlocked =
    isRefreshTemporarilyBlocked || isManualRefreshCoolingDown || isManualRefreshInProgressByState;
  const refreshStatusLabel = buildRefreshStatusLabel({
    refreshState,
    isRefreshing: isFetching,
    hasLoadedFromServer: activeEntitiesState.hasLoadedFromServer,
  });

  const isNoEntitiesForTab =
    !isLoading &&
    !queryError &&
    isSyncSettled &&
    Array.isArray(activeEntities) &&
    activeEntities.length === 0;

  const [filteredEntities, visibleEntitiesCount, hasVisibleLaunchContext] = useMemo(
    () => {
      const provisionalLaunchEntity =
        visibleLaunchContext && visibleLaunchContext.tab === activeTab
          ? {
              id: visibleLaunchContext.chatId,
              title: visibleLaunchContext.title,
              createdAt: '',
              entityType: activeTab,
              link: visibleLaunchContext.link ?? null,
              avatarUrl: visibleLaunchContext.avatarUrl ?? null,
              channelOverview: null,
              assignedBots: [],
              primaryBotId: null,
              sharedMode: 'owned' as const,
            }
          : null;

      return buildHomeView({
        entities: activeEntities,
        query,
        activeTab,
        visibleLaunchContext,
        provisionalEntity: provisionalLaunchEntity,
      });
    },
    [activeEntities, activeTab, query, visibleLaunchContext],
  );
  const showSearchCard = !isNoEntitiesForTab || hasVisibleLaunchContext;
  const showEmptyState = isNoEntitiesForTab && !hasVisibleLaunchContext;
  const limitedStagger =
    filteredEntities.length > CHAT_CARD_STAGGER_THRESHOLD ? CHAT_CARD_STAGGER_LIMIT : null;

  function queueRefresh(tab: ManagedTab, behavior: ManagedEntitiesReloadRequest['behavior']) {
    lastRefreshAtRef.current = Date.now();
    awaitingReturnRefreshRef.current = false;
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
    const markRefreshOnReturn = () => {
      awaitingReturnRefreshRef.current = true;
    };

    const refreshAfterReturn = () => {
      if (!awaitingReturnRefreshRef.current) {
        return;
      }
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      if (activeEntitiesState.isLoading || activeEntitiesState.isRefreshing) {
        return;
      }
      if (
        activeEntitiesState.hasLoadedFromServer &&
        activeEntitiesState.snapshot?.stale === false &&
        activeEntitiesState.isSyncComplete
      ) {
        awaitingReturnRefreshRef.current = false;
        return;
      }

      const now = Date.now();
      if (now - lastRefreshAtRef.current < LIST_VISIBILITY_REFRESH_MIN_INTERVAL_MS) {
        return;
      }

      awaitingReturnRefreshRef.current = false;
      handleRefresh();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        markRefreshOnReturn();
        return;
      }

      refreshAfterReturn();
    };

    window.addEventListener('blur', markRefreshOnReturn);
    window.addEventListener('pagehide', markRefreshOnReturn);
    window.addEventListener('focus', refreshAfterReturn);
    window.addEventListener('pageshow', refreshAfterReturn);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('blur', markRefreshOnReturn);
      window.removeEventListener('pagehide', markRefreshOnReturn);
      window.removeEventListener('focus', refreshAfterReturn);
      window.removeEventListener('pageshow', refreshAfterReturn);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [
    activeEntitiesState.hasLoadedFromServer,
    activeEntitiesState.isLoading,
    activeEntitiesState.isRefreshing,
    activeEntitiesState.isSyncComplete,
    activeEntitiesState.snapshot?.stale,
    activeTab,
    isFetching,
    isManualRefreshBlocked,
  ]);

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

  function prefetchChatSettings(chatId: string) {
    preloadSettingsPage();
    void queryClient
      .prefetchQuery({
        queryKey: ['settings-screen', chatId],
        queryFn: () => api.request(`/chats/${chatId}/settings-screen`),
      })
      .catch(() => undefined);
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
    preloadChannelSettingsPage();
    void queryClient
      .prefetchQuery({
        queryKey: ['channel-settings-screen', chatId],
        queryFn: () => api.request(`/channels/${chatId}/settings-screen`),
      })
      .catch(() => undefined);
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
    <div className="page-stack page-enter">
      {showSearchCard ? (
        <GlassCard className="chats-search-card" padding="sm" elevated>
          <div className="chats-search-card__head">
            <div className="chats-search-card__title">
              <div className="chats-search-card__title-row">
                <h1>{tabLabel}</h1>
                <div className="chats-search-card__meta">
                  <button
                    type="button"
                    className="button button--ghost chats-search-card__refresh"
                    onClick={() => handleRefresh(activeTab, 'manual')}
                    disabled={isFetching || isManualRefreshBlocked}
                    aria-label="Обновить"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      className={isFetching ? 'is-spinning' : undefined}
                    >
                      <path
                        d="M20 12a8 8 0 1 1-2.34-5.66"
                        fill="none"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="1.8"
                      />
                      <path
                        d="M20 4v5h-5"
                        fill="none"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="1.8"
                      />
                    </svg>
                  </button>
                  <span
                    className="chats-search-card__count"
                    aria-label={`Найдено ${visibleEntitiesCount}`}
                  >
                    {visibleEntitiesCount}
                  </span>
                </div>
              </div>
              {refreshStatusLabel ? (
                <p className="chats-search-card__status">{refreshStatusLabel}</p>
              ) : null}
            </div>
          </div>

          <label className="field field--search chats-search-card__field" htmlFor="chat-search">
            <span>{searchLabel}</span>
            <input
              id="chat-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
            />
          </label>
        </GlassCard>
      ) : null}

      <Suspense fallback={null}>
        <LazyLaunchContextSection
          api={api}
          activeTab={activeTab}
          chatsState={chatsState}
          channelsState={channelsState}
          onLaunchContextTabChange={setLaunchContextTabHint}
          onVisibleLaunchContextChange={(nextValue) => {
            setVisibleLaunchContext((currentValue) => {
              if (
                currentValue?.tab === nextValue?.tab &&
                currentValue?.chatId === nextValue?.chatId
              ) {
                return currentValue;
              }

              return nextValue;
            });
          }}
          onQueueRefresh={queueRefresh}
          onSystemAccessChange={setCanAccessSystem}
        />
      </Suspense>

      {showSystemCard ? (
        <Suspense fallback={null}>
          <LazySystemEntryCard api={api} />
        </Suspense>
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
      filteredEntities.length === 0 &&
      !hasVisibleLaunchContext ? (
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
            const staggerIndex =
              limitedStagger === null ? index : index < limitedStagger ? index : null;
            const className = staggerIndex === null ? 'chat-card' : 'chat-card stagger-in';
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
