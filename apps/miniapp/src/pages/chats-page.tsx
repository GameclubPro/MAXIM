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

export function ChatsPage({ api }: { api: ApiTransport }) {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [canAccessSystem, setCanAccessSystem] = useState(false);
  const [refreshNonceByTab, setRefreshNonceByTab] = useState<Record<ManagedTab, number>>({
    chat: 0,
    channel: 0,
  });
  const lastRefreshAtRef = useRef(0);
  const awaitingReturnRefreshRef = useRef(false);
  const activeTab = normalizeEntityType(
    searchParams.get('view'),
    readLastEntityType(),
  ) as ManagedTab;
  const activeEntitiesKey = getEntitiesKey(activeTab);
  const chatsState = useManagedEntitiesSync({
    api,
    entityType: 'chat',
    enabled: activeTab === 'chat',
    reloadNonce: refreshNonceByTab.chat,
    skipInitialSyncIfCached: true,
    backgroundRefreshOnFirstLoad: true,
    persistLocalCache: true,
    localCacheScope: 'home',
  });
  const channelsState = useManagedEntitiesSync({
    api,
    entityType: 'channel',
    enabled: activeTab === 'channel',
    reloadNonce: refreshNonceByTab.channel,
    skipInitialSyncIfCached: true,
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

  function handleRefresh() {
    if (isManualRefreshBlocked || isFetching) {
      return;
    }

    lastRefreshAtRef.current = Date.now();
    awaitingReturnRefreshRef.current = false;
    setRefreshNonceByTab((current) => ({
      ...current,
      [activeTab]: current[activeTab] + 1,
    }));
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
      .then((me) => {
        setCanAccessSystem(me.canAccessSystem === true);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setCanAccessSystem(false);
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
        queryKey: [
          'logs-dashboard',
          chatId,
          DEFAULT_DASHBOARD_RANGE,
          false,
          true,
        ],
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
                    onClick={handleRefresh}
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
              <button type="button" className="button button--danger" onClick={handleRefresh}>
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
            description="Обновляем локальный каталог и проверяем текущие права администратора в MAX."
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
                администратора. После этого быстрее всего открыть приложение прямо из нужного чата.
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
            onClick={handleRefresh}
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
            description="Добавьте бота в канал с правами администратора. Чтобы он появился сразу, откройте приложение прямо из этого канала."
            action={
              <button
                type="button"
                className="button button--accent"
                onClick={handleRefresh}
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
              <GlassCard
                as="article"
                key={entity.id}
                className={className}
                style={style}
              >
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
                        saveLastEntityId('chat', entity.id);
                        saveChatTitle(entity.id, entity.title);
                      }}
                      onPointerEnter={(event) => {
                        if (shouldPrefetchFromPointerEvent(event)) {
                          prefetchChatEvents(entity.id);
                        }
                      }}
                      onPointerDown={(event) => {
                        if (event.pointerType !== 'mouse') {
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
