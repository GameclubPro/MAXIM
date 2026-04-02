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
import type { ManagedEntitiesRefreshState, Me } from '@maxim/contracts';
import addBotToChatImage from '../assets/onboarding/add-bot-to-chat.jpg';
import grantBotAdminRightsImage from '../assets/onboarding/grant-bot-admin-rights.jpg';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { describeApiError } from '../lib/api-error';
import { getMe } from '../lib/api/root-client';
import type { ApiTransport } from '../lib/api/transport';
import { saveChatTitle, saveChatTitles } from '../lib/chat-titles';
import {
  normalizeEntityType,
  readLastEntityType,
  saveLastEntityId,
  saveLastEntityType,
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
  behavior: 'default' | 'recovery';
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

function getEntitiesKey(tab: ManagedTab): 'chats' | 'channels' {
  return tab === 'chat' ? 'chats' : 'channels';
}

function shouldPrefetchFromPointerEvent(event: ReactPointerEvent<HTMLElement>): boolean {
  return event.pointerType === 'mouse';
}

function resolveLaunchContextTab(
  launchContext: Me['launchContext'] | null | undefined,
): ManagedTab | null {
  if (launchContext?.chatType === 'chat') {
    return 'chat';
  }
  if (launchContext?.chatType === 'channel') {
    return 'channel';
  }

  return null;
}

function buildLaunchContextPrimaryRoute(
  launchContext: NonNullable<Me['launchContext']>,
  tab: ManagedTab,
): string {
  return tab === 'chat'
    ? `/chat/${launchContext.chatId}/settings`
    : `/channel/${launchContext.chatId}/settings`;
}

function buildLaunchContextSecondaryRoute(
  launchContext: NonNullable<Me['launchContext']>,
  tab: ManagedTab,
): string {
  return tab === 'chat'
    ? `/chat/${launchContext.chatId}/events`
    : `/channel/${launchContext.chatId}/stats`;
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
    return progress
      ? `Синхронизация в фоне: ${progress}.`
      : 'Синхронизируем список и права администратора.';
  }
  if (refreshState?.backoffActive) {
    return 'MAX временно ограничил синк. Продолжим автоматически.';
  }
  if (refreshState?.manualRefreshBlockedReason === 'recent_sync') {
    const syncedAt = formatRefreshTime(refreshState.lastSyncedAt);
    return syncedAt ? `Недавно синхронизировано в ${syncedAt}.` : 'Недавно синхронизировано.';
  }
  if (refreshState?.complete) {
    const syncedAt = formatRefreshTime(refreshState.lastSyncedAt);
    return syncedAt ? `Последняя синхронизация в ${syncedAt}.` : 'Список синхронизирован.';
  }

  return progress ? `Продолжаем фоновый синк: ${progress}.` : null;
}

function buildPendingSyncDescription(options: {
  tab: ManagedTab;
  refreshState: ManagedEntitiesRefreshState | null;
  hasLoadedFromServer: boolean;
}): string {
  const entityPlural = options.tab === 'chat' ? 'чаты' : 'каналы';
  const progress = formatRefreshProgress(options.refreshState);

  if (!options.hasLoadedFromServer) {
    return `Сначала проверяем ${entityPlural} на сервере и подтягиваем текущий контекст запуска.`;
  }
  if (progress) {
    return `Проверяем права администратора в MAX и продолжаем фоновый sync. Обработано ${progress}.`;
  }

  return 'Обновляем локальный каталог и проверяем текущие права администратора в MAX.';
}

export function ChatsPage({ api }: { api: ApiTransport }) {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [me, setMe] = useState<Me | null>(null);
  const [refreshRequestByTab, setRefreshRequestByTab] = useState<
    Record<ManagedTab, ManagedEntitiesReloadRequest>
  >({
    chat: { nonce: 0, behavior: 'default' },
    channel: { nonce: 0, behavior: 'default' },
  });
  const lastRefreshAtRef = useRef(0);
  const awaitingReturnRefreshRef = useRef(false);
  const launchContextRecoveryKeyRef = useRef<string | null>(null);
  const launchContextTab = resolveLaunchContextTab(me?.launchContext ?? null);
  const activeTab = normalizeEntityType(
    searchParams.get('view'),
    launchContextTab ?? readLastEntityType(),
  ) as ManagedTab;
  const activeEntitiesKey = getEntitiesKey(activeTab);
  const chatsState = useManagedEntitiesSync({
    api,
    entityType: 'chat',
    enabled: activeTab === 'chat' || launchContextTab === 'chat',
    reloadNonce: refreshRequestByTab.chat.nonce,
    reloadBehavior: refreshRequestByTab.chat.behavior,
    resumeOnVisibilityReturn: true,
    backgroundRefreshOnFirstLoad: true,
    persistLocalCache: true,
    localCacheScope: 'home',
  });
  const channelsState = useManagedEntitiesSync({
    api,
    entityType: 'channel',
    enabled: activeTab === 'channel' || launchContextTab === 'channel',
    reloadNonce: refreshRequestByTab.channel.nonce,
    reloadBehavior: refreshRequestByTab.channel.behavior,
    resumeOnVisibilityReturn: true,
    backgroundRefreshOnFirstLoad: true,
    persistLocalCache: true,
    localCacheScope: 'home',
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

  const filteredEntities = useMemo(() => {
    if (!Array.isArray(activeEntities)) {
      return [];
    }

    const normalized = query.trim().toLowerCase();

    if (!normalized) {
      return activeEntities;
    }

    return activeEntities.filter((entity) => {
      const haystack = `${entity.title} ${entity.id}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [activeEntities, query]);
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
    if (behavior === 'default' && (isManualRefreshBlocked || isFetching)) {
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
  }, [activeEntitiesState.isLoading, activeEntitiesState.isRefreshing]);

  useEffect(() => {
    const controller = new AbortController();

    void getMe(api, { signal: controller.signal })
      .then((nextMe) => {
        setMe(nextMe);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setMe((current) =>
            current
              ? {
                  ...current,
                  canAccessSystem: false,
                }
              : null,
          );
        }
      });

    return () => controller.abort();
  }, [api]);

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

  const canAccessSystem = me?.canAccessSystem === true;
  const launchContext = me?.launchContext ?? null;
  const launchContextEntitiesState =
    launchContextTab === 'chat'
      ? chatsState
      : launchContextTab === 'channel'
        ? channelsState
        : null;
  const launchContextEntity =
    launchContext && launchContextEntitiesState?.data
      ? (launchContextEntitiesState.data.find((entity) => entity.id === launchContext.chatId) ??
        null)
      : null;
  const launchContextRecoveryKey =
    launchContext && launchContextTab ? `${launchContextTab}:${launchContext.chatId}` : null;
  const launchContextPrimaryRoute =
    launchContext && launchContextTab
      ? buildLaunchContextPrimaryRoute(launchContext, launchContextTab)
      : null;
  const launchContextSecondaryRoute =
    launchContext && launchContextTab
      ? buildLaunchContextSecondaryRoute(launchContext, launchContextTab)
      : null;
  const launchContextTitle =
    launchContextEntity?.title ??
    launchContext?.chatTitle ??
    (launchContextTab === 'channel' ? 'Текущий канал' : 'Текущий чат');
  const launchContextProgress = formatRefreshProgress(
    launchContextEntitiesState?.refreshState ?? null,
  );
  const launchContextRetryAfterSec =
    typeof launchContextEntitiesState?.refreshState?.manualRefreshRetryAfterMs === 'number' &&
    launchContextEntitiesState.refreshState.manualRefreshRetryAfterMs > 0
      ? Math.max(
          1,
          Math.ceil(launchContextEntitiesState.refreshState.manualRefreshRetryAfterMs / 1_000),
        )
      : null;
  const launchContextIsChecking =
    launchContext !== null &&
    launchContextEntity === null &&
    Boolean(
      launchContextEntitiesState &&
      (!launchContextEntitiesState.hasLoadedFromServer ||
        launchContextEntitiesState.isRefreshing ||
        (!launchContextEntitiesState.isSyncComplete &&
          !launchContextEntitiesState.isBackoffActive)),
    );
  const launchContextDescription =
    launchContext === null || launchContextTab === null || launchContextEntitiesState === null
      ? null
      : launchContextEntity
        ? launchContextTab === 'chat'
          ? 'Этот чат уже доступен в mini app. Можно сразу перейти в настройки или события.'
          : 'Этот канал уже доступен в mini app. Можно сразу перейти в настройки или статистику.'
        : !launchContextEntitiesState.hasLoadedFromServer
          ? `Проверяем ${launchContextTab === 'chat' ? 'чат' : 'канал'} на сервере и подтягиваем свежие права администратора.`
          : launchContextEntitiesState.isBackoffActive
            ? `MAX временно ограничил проверку. Повторим автоматически${launchContextRetryAfterSec ? ` через ${launchContextRetryAfterSec} с` : ''}.`
            : launchContextEntitiesState.error
              ? `Не удалось подтвердить доступ к ${launchContextTab === 'chat' ? 'чату' : 'каналу'} в этой сессии.`
              : launchContextProgress
                ? `Этот ${launchContextTab === 'chat' ? 'чат' : 'канал'} пока не появился в общем списке. Продолжаем синк: ${launchContextProgress}.`
                : `Этот ${launchContextTab === 'chat' ? 'чат' : 'канал'} открыт из MAX, но пока не прошёл полную проверку. Обычно это значит, что бот ещё не админ или MAX не отдал свежий список.`;

  useEffect(() => {
    if (
      !launchContext ||
      !launchContextTab ||
      !launchContextEntitiesState ||
      !launchContextRecoveryKey ||
      launchContextEntity ||
      launchContextEntitiesState.error ||
      launchContextEntitiesState.isBackoffActive ||
      !launchContextEntitiesState.hasLoadedFromServer
    ) {
      return;
    }
    if (launchContextRecoveryKeyRef.current === launchContextRecoveryKey) {
      return;
    }

    launchContextRecoveryKeyRef.current = launchContextRecoveryKey;
    console.warn(
      'Launch context entity missing after lightweight pass, starting recovery refresh',
      {
        chatId: launchContext.chatId,
        chatType: launchContext.chatType,
      },
    );
    queueRefresh(launchContextTab, 'recovery');
  }, [
    launchContext,
    launchContextEntitiesState,
    launchContextEntity,
    launchContextRecoveryKey,
    launchContextTab,
  ]);

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
  const showLaunchContextCard = Boolean(
    launchContext && launchContextTab && launchContextPrimaryRoute && launchContextDescription,
  );
  const launchContextBadge =
    launchContextTab === 'channel'
      ? 'Текущий канал'
      : launchContextTab === 'chat'
        ? 'Текущий чат'
        : '';

  return (
    <div className="page-stack page-enter">
      {!isNoEntitiesForTab ? (
        <GlassCard className="chats-search-card" padding="sm" elevated>
          <div className="chats-search-card__head">
            <div className="chats-search-card__title">
              <div className="chats-search-card__title-row">
                <h1>{tabLabel}</h1>
                <div className="chats-search-card__meta">
                  <button
                    type="button"
                    className="button button--ghost chats-search-card__refresh"
                    onClick={() => handleRefresh()}
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
                    aria-label={`Найдено ${filteredEntities.length}`}
                  >
                    {filteredEntities.length}
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

      {showLaunchContextCard && launchContext && launchContextPrimaryRoute ? (
        <GlassCard className="launch-context-card" elevated>
          <div className="launch-context-card__head">
            <span className="chip launch-context-card__badge">{launchContextBadge}</span>
            {launchContextIsChecking ? (
              <span className="launch-context-card__meta">Проверка идёт</span>
            ) : null}
          </div>
          <div className="launch-context-card__body">
            <div className="launch-context-card__identity">
              <EntityAvatar
                title={launchContextTitle}
                entityType={launchContextTab ?? 'chat'}
                avatarUrl={launchContextEntity?.avatarUrl ?? null}
                className="launch-context-card__avatar"
              />
              <div className="launch-context-card__copy">
                <h2>{launchContextTitle}</h2>
                <p>{launchContextDescription}</p>
              </div>
            </div>

            <div className="launch-context-card__actions">
              <Link
                to={launchContextPrimaryRoute}
                className="button button--accent"
                state={
                  launchContextTab === 'channel'
                    ? {
                        chatTitle: launchContextTitle,
                        chatLink: launchContextEntity?.link ?? '',
                        avatarUrl: launchContextEntity?.avatarUrl ?? null,
                      }
                    : {
                        chatTitle: launchContextTitle,
                        avatarUrl: launchContextEntity?.avatarUrl ?? null,
                      }
                }
                onClick={() => {
                  if (!launchContextTab) {
                    return;
                  }
                  saveLastEntityId(launchContextTab, launchContext.chatId);
                  saveChatTitle(launchContext.chatId, launchContextTitle);
                }}
              >
                {launchContextTab === 'channel'
                  ? 'Открыть настройки канала'
                  : 'Открыть настройки чата'}
              </Link>
              {launchContextEntity && launchContextSecondaryRoute ? (
                <Link
                  to={launchContextSecondaryRoute}
                  className="button button--ghost"
                  state={{
                    chatTitle: launchContextTitle,
                    avatarUrl: launchContextEntity.avatarUrl ?? null,
                  }}
                  onClick={() => {
                    if (!launchContextTab) {
                      return;
                    }
                    saveLastEntityId(launchContextTab, launchContext.chatId);
                    saveChatTitle(launchContext.chatId, launchContextTitle);
                  }}
                >
                  {launchContextTab === 'channel' ? 'Статистика' : 'События'}
                </Link>
              ) : (
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => handleRefresh(launchContextTab ?? activeTab, 'recovery')}
                  disabled={launchContextEntitiesState?.isBackoffActive === true}
                >
                  {launchContextIsChecking ? 'Проверяем...' : 'Проверить снова'}
                </button>
              )}
            </div>
          </div>
        </GlassCard>
      ) : null}

      {showSystemCard ? (
        <Suspense
          fallback={
            <GlassCard className="system-root-card" elevated>
              <div className="system-root-card__copy">
                <h2>Операционный центр</h2>
                <p>Подготавливаю live-сводку по webhook, очередям и MAX-лимитам.</p>
              </div>
            </GlassCard>
          }
        >
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
                onClick={() => handleRefresh()}
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

      {isNoEntitiesForTab && activeTab === 'chat' ? (
        <section
          className="chats-onboarding"
          aria-label="Как подключить бота в MAX к групповому чату"
        >
          <GlassCard className="chats-onboarding__hero" elevated>
            <div className="chats-onboarding__hero-top">
              <span className="chip chats-onboarding__badge">2 шага • 1 минута</span>
            </div>
            <div className="chats-onboarding__hero-text">
              <h1>Нет доступных чатов</h1>
              <p>
                Чтобы увидеть чат в приложении, добавьте чат-бота в чат и выдайте ему права
                администратора. После этого откройте mini app из нужного чата, а список подтянется
                после серверной проверки.
              </p>
            </div>
          </GlassCard>

          <GlassCard
            className="onboarding-step-card stagger-in"
            style={{ animationDelay: '40ms' }}
            elevated
          >
            <div className="onboarding-step-card__content">
              <h2>1. Добавьте бота в чат</h2>
              <ul>
                <li>Откройте нужный групповой чат в MAX.</li>
                <li>Нажмите название чата → «Добавить участников».</li>
                <li>Найдите бота и добавьте его в чат.</li>
              </ul>
            </div>
            <figure className="onboarding-step-card__media">
              <img
                src={addBotToChatImage}
                alt="Добавление бота в участники группового чата в MAX."
                loading="lazy"
              />
              <figcaption>Экран добавления участников в MAX.</figcaption>
            </figure>
          </GlassCard>

          <GlassCard
            className="onboarding-step-card stagger-in"
            style={{ animationDelay: '80ms' }}
            elevated
          >
            <div className="onboarding-step-card__content">
              <h2>2. Назначьте бота администратором</h2>
              <ul>
                <li>Откройте профиль чата → «Права администратора».</li>
                <li>Выберите бота и включите нужные права.</li>
                <li>Минимально для модерации: «Читать сообщения» и «Удалять сообщения».</li>
              </ul>
            </div>
            <figure className="onboarding-step-card__media">
              <img
                src={grantBotAdminRightsImage}
                alt="Назначение бота администратором в настройках прав чата MAX."
                loading="lazy"
              />
              <figcaption>Экран прав администратора для бота.</figcaption>
            </figure>
          </GlassCard>

          <button
            type="button"
            className="button button--accent onboarding-refresh"
            onClick={() => handleRefresh()}
            disabled={isFetching || isRefreshTemporarilyBlocked}
          >
            {isFetching ? 'Обновляем...' : 'Я добавил бота, обновить'}
          </button>
        </section>
      ) : null}

      {isNoEntitiesForTab && activeTab === 'channel' ? (
        <GlassCard>
          <StatusState
            tone="neutral"
            title="Каналы не найдены"
            description="Добавьте бота в канал с правами администратора, затем откройте mini app из этого канала и дождитесь серверной проверки."
            action={
              <button
                type="button"
                className="button button--accent"
                onClick={() => handleRefresh()}
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
      !isNoEntitiesForTab &&
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

      {!isLoading && !queryError && !isNoEntitiesForTab && filteredEntities.length > 0 ? (
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
