import type { ChatSummary } from '@maxim/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import addBotToChatImage from '../assets/onboarding/add-bot-to-chat.jpg';
import grantBotAdminRightsImage from '../assets/onboarding/grant-bot-admin-rights.jpg';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { describeApiError } from '../lib/api-error';
import type { ApiTransport } from '../lib/api/transport';
import { saveChatTitle, saveChatTitles } from '../lib/chat-titles';
import {
  normalizeEntityType,
  readLastEntityId,
  readLastEntityType,
  readRecentEntityIds,
  saveLastEntityId,
  saveLastEntityType,
  saveRecentEntityVisit,
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
const DEFAULT_DASHBOARD_RANGE = '7d';
const DEFAULT_CHANNEL_STATS_RANGE = '7d';
const QUICK_ACCESS_LIMIT = 4;
const LIST_INITIAL_VISIBLE = 24;
const LIST_PAGE_SIZE = 24;

function getEntitiesKey(tab: ManagedTab): 'chats' | 'channels' {
  return tab === 'chat' ? 'chats' : 'channels';
}

function formatManagedEntitiesCount(count: number, entityType: ManagedTab): string {
  if (entityType === 'channel') {
    if (count % 10 === 1 && count % 100 !== 11) {
      return `${count} канал`;
    }
    if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) {
      return `${count} канала`;
    }
    return `${count} каналов`;
  }

  if (count % 10 === 1 && count % 100 !== 11) {
    return `${count} чат`;
  }
  if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) {
    return `${count} чата`;
  }
  return `${count} чатов`;
}

function formatScenarioCount(count: number): string {
  if (count % 10 === 1 && count % 100 !== 11) {
    return `${count} сценарий`;
  }
  if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) {
    return `${count} сценария`;
  }
  return `${count} сценариев`;
}

function buildEntityDescription(entity: ChatSummary, entityType: ManagedTab): string {
  if (entityType === 'chat') {
    return 'Настройки, правила и журнал событий';
  }

  const overview = entity.channelOverview;
  if (!overview) {
    return 'Настройки канала и статистика публикаций';
  }

  const fragments: string[] = [];
  if (overview.enabledScenariosCount > 0) {
    fragments.push(formatScenarioCount(overview.enabledScenariosCount));
  }
  if (overview.commentsEnabled) {
    fragments.push('Комментарии');
  }
  if (overview.postSuggestionsEnabled) {
    fragments.push('Посты от подписчиков');
  }
  if (overview.commentsModerationEnabled) {
    fragments.push('Модерация комментариев');
  }

  return fragments.length > 0
    ? fragments.join(' • ')
    : 'Настройки канала и статистика публикаций';
}

function buildSyncStatusLabel(params: {
  isFetching: boolean;
  isRefreshTemporarilyBlocked: boolean;
  isSyncPending: boolean;
  nextPollAfterMs: number;
}): string {
  if (params.isFetching) {
    return 'Синхронизация';
  }
  if (params.isRefreshTemporarilyBlocked) {
    return `Пауза ${Math.max(1, Math.ceil(params.nextPollAfterMs / 1000))}с`;
  }
  if (params.isSyncPending) {
    return 'Каталог обновляется';
  }
  return 'Каталог готов';
}

function buildSyncStatusTone(params: {
  isFetching: boolean;
  isRefreshTemporarilyBlocked: boolean;
  isSyncPending: boolean;
}): 'active' | 'paused' | 'ready' {
  if (params.isFetching || params.isSyncPending) {
    return 'active';
  }
  if (params.isRefreshTemporarilyBlocked) {
    return 'paused';
  }
  return 'ready';
}

export function ChatsPage({ api }: { api: ApiTransport }) {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(LIST_INITIAL_VISIBLE);
  const [refreshNonceByTab, setRefreshNonceByTab] = useState<Record<ManagedTab, number>>({
    chat: 0,
    channel: 0,
  });
  const lastRefreshAtRef = useRef(0);
  const awaitingReturnRefreshRef = useRef(false);
  const deferredQuery = useDeferredValue(query);
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
    resumeOnVisibilityReturn: true,
    skipInitialSyncIfCached: true,
  });
  const channelsState = useManagedEntitiesSync({
    api,
    entityType: 'channel',
    enabled: activeTab === 'channel',
    reloadNonce: refreshNonceByTab.channel,
    resumeOnVisibilityReturn: true,
    skipInitialSyncIfCached: true,
  });

  const activeEntities = useMemo(() => {
    return activeEntitiesKey === 'chats' ? chatsState.data : channelsState.data;
  }, [activeEntitiesKey, channelsState.data, chatsState.data]);

  const activeEntitiesState = activeTab === 'chat' ? chatsState : channelsState;
  const isLoading = activeEntitiesState.isLoading;
  const isFetching = activeEntitiesState.isRefreshing;
  const queryError = activeEntitiesState.error;
  const refreshState = activeEntitiesState.refreshState;
  const isSyncSettled = activeEntitiesState.isSyncComplete || activeEntitiesState.isBackoffActive;
  const isSyncPending = !isLoading && !queryError && !isSyncSettled;
  const isRefreshTemporarilyBlocked =
    activeEntitiesState.isBackoffActive && (refreshState?.nextPollAfterMs ?? 0) > 0;

  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const hasQuery = normalizedQuery.length > 0;
  const activeLastEntityId = readLastEntityId(activeTab);
  const recentEntityIds = useMemo(() => readRecentEntityIds(activeTab), [activeTab]);

  const isNoEntitiesForTab =
    !isLoading &&
    !queryError &&
    isSyncSettled &&
    Array.isArray(activeEntities) &&
    activeEntities.length === 0;

  const searchableEntities = useMemo(() => {
    if (!Array.isArray(activeEntities)) {
      return [];
    }

    return activeEntities.map((entity) => ({
      entity,
      searchText: `${entity.title} ${entity.id}`.toLowerCase(),
    }));
  }, [activeEntities]);

  const filteredEntities = useMemo(() => {
    if (!normalizedQuery) {
      return searchableEntities.map((item) => item.entity);
    }

    return searchableEntities
      .filter((item) => item.searchText.includes(normalizedQuery))
      .map((item) => item.entity);
  }, [normalizedQuery, searchableEntities]);

  const quickAccessEntities = useMemo(() => {
    if (hasQuery || filteredEntities.length === 0 || recentEntityIds.length === 0) {
      return [];
    }

    const entityById = new Map(filteredEntities.map((entity) => [entity.id, entity]));
    return recentEntityIds
      .map((entityId) => entityById.get(entityId) ?? null)
      .filter((entity): entity is ChatSummary => entity !== null)
      .slice(0, QUICK_ACCESS_LIMIT);
  }, [filteredEntities, hasQuery, recentEntityIds]);

  const listEntities = useMemo(() => {
    if (quickAccessEntities.length === 0) {
      return filteredEntities;
    }

    const quickAccessIds = new Set(quickAccessEntities.map((entity) => entity.id));
    return filteredEntities.filter((entity) => !quickAccessIds.has(entity.id));
  }, [filteredEntities, quickAccessEntities]);

  const visibleEntities = useMemo(
    () => listEntities.slice(0, visibleCount),
    [listEntities, visibleCount],
  );
  const remainingEntitiesCount = Math.max(0, listEntities.length - visibleEntities.length);

  const headerSummary = hasQuery
    ? `Найдено ${filteredEntities.length} из ${Array.isArray(activeEntities) ? activeEntities.length : 0}`
    : `В управлении ${formatManagedEntitiesCount(filteredEntities.length, activeTab)}`;
  const syncStatusLabel = buildSyncStatusLabel({
    isFetching,
    isRefreshTemporarilyBlocked,
    isSyncPending,
    nextPollAfterMs: refreshState?.nextPollAfterMs ?? 0,
  });
  const syncStatusTone = buildSyncStatusTone({
    isFetching,
    isRefreshTemporarilyBlocked,
    isSyncPending,
  });
  const syncStatusClassName =
    syncStatusTone === 'ready'
      ? 'chip chip--success'
      : syncStatusTone === 'paused'
        ? 'chip chip--warning'
        : 'chip';

  function handleRefresh() {
    if (isRefreshTemporarilyBlocked) {
      return;
    }

    lastRefreshAtRef.current = Date.now();
    awaitingReturnRefreshRef.current = false;
    startTransition(() => {
      setRefreshNonceByTab((current) => ({
        ...current,
        [activeTab]: current[activeTab] + 1,
      }));
    });
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
    setVisibleCount(LIST_INITIAL_VISIBLE);
  }, [activeTab, normalizedQuery]);

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
        queryKey: ['logs-dashboard', chatId, DEFAULT_DASHBOARD_RANGE],
        queryFn: () =>
          api.request(
            `/chats/${chatId}/logs-dashboard?range=${encodeURIComponent(DEFAULT_DASHBOARD_RANGE)}`,
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

  function rememberEntity(entity: ChatSummary) {
    saveLastEntityId(activeTab, entity.id);
    saveRecentEntityVisit(activeTab, entity.id);
    saveChatTitle(entity.id, entity.title);
  }

  const tabLabel = activeTab === 'chat' ? 'Чаты' : 'Каналы';
  const searchLabel =
    activeTab === 'chat' ? 'Поиск чата по названию или ID' : 'Поиск канала по названию или ID';
  const searchPlaceholder = activeTab === 'chat' ? 'Поиск по чатам' : 'Поиск по каналам';
  const refreshButtonLabel = isFetching ? 'Обновляем каталог' : 'Обновить каталог';
  const listSectionTitle = activeTab === 'chat' ? 'Все чаты' : 'Все каналы';
  const quickAccessTitle = activeTab === 'chat' ? 'Быстрый доступ к чатам' : 'Быстрый доступ к каналам';

  return (
    <div className="page-stack page-enter">
      {!isNoEntitiesForTab ? (
        <GlassCard className="chats-search-card" padding="sm" elevated>
          <div className="chats-search-card__head">
            <div className="chats-search-card__title">
              <div className="chats-search-card__title-row">
                <div>
                  <h1>{tabLabel}</h1>
                  <p>{headerSummary}</p>
                </div>
                <div className="chats-search-card__meta">
                  <span className={syncStatusClassName}>{syncStatusLabel}</span>
                  <button
                    type="button"
                    className="button button--ghost chats-search-card__refresh"
                    onClick={handleRefresh}
                    disabled={isFetching || isRefreshTemporarilyBlocked}
                    aria-label={refreshButtonLabel}
                    title={refreshButtonLabel}
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
              autoComplete="off"
              enterKeyHint="search"
            />
          </label>
        </GlassCard>
      ) : null}

      {isLoading ? (
        <GlassCard className="managed-entities-panel managed-entities-panel--loading" padding="sm" elevated>
          <div className="managed-entities-panel__head">
            <div className="managed-entities-panel__title">
              <h2 style={{ margin: 0, fontSize: '1rem', lineHeight: 1.2 }}>Загружаем каталог</h2>
              <p style={{ margin: 0, fontSize: '0.8rem', lineHeight: 1.35, color: 'var(--text-muted)' }}>
                Подтягиваем доступные {tabLabel.toLowerCase()} и проверяем актуальные права.
              </p>
            </div>
          </div>
          <section className="managed-entities-skeleton-list" aria-label="Загрузка">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="managed-entities-skeleton-row">
                <SkeletonCard lines={2} />
              </div>
            ))}
          </section>
        </GlassCard>
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
                Чтобы увидеть чат в «Майор Максимов», добавьте бота в чат и выдайте ему права
                администратора. После этого быстрее всего открыть приложение прямо из нужного
                чата.
              </p>
            </div>
          </GlassCard>

          <GlassCard className="onboarding-step-card" elevated>
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

          <GlassCard className="onboarding-step-card" elevated>
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
            description="Попробуйте изменить запрос или искать по ID."
          />
        </GlassCard>
      ) : null}

      {!isLoading && !queryError && !isNoEntitiesForTab && filteredEntities.length > 0 ? (
        <div className="page-stack">
          {quickAccessEntities.length > 0 ? (
            <GlassCard className="managed-entities-panel" padding="sm" elevated>
              <div className="managed-entities-panel__head">
                <div className="managed-entities-panel__title">
                  <h2 style={{ margin: 0, fontSize: '1rem', lineHeight: 1.2 }}>{quickAccessTitle}</h2>
                  <p style={{ margin: 0, fontSize: '0.8rem', lineHeight: 1.35, color: 'var(--text-muted)' }}>
                    Недавно открытые сущности всегда под рукой.
                  </p>
                </div>
                <span className="chats-search-card__count">{quickAccessEntities.length}</span>
              </div>

              <section className="managed-entities-list" aria-label={quickAccessTitle}>
                {quickAccessEntities.map((entity) => {
                  const isLastOpened = entity.id === activeLastEntityId;
                  const primaryHref =
                    activeTab === 'chat'
                      ? `/chat/${entity.id}/settings`
                      : `/channel/${entity.id}/settings`;
                  const secondaryHref =
                    activeTab === 'chat'
                      ? `/chat/${entity.id}/events`
                      : `/channel/${entity.id}/stats`;
                  const primaryLabel = '>';
                  const secondaryLabel = activeTab === 'chat' ? 'События' : 'Статистика';
                  const state =
                    activeTab === 'chat'
                      ? { chatTitle: entity.title, avatarUrl: entity.avatarUrl ?? null }
                      : {
                          chatTitle: entity.title,
                          chatLink: entity.link ?? '',
                          avatarUrl: entity.avatarUrl ?? null,
                        };
                  const prefetchPrimary =
                    activeTab === 'chat'
                      ? () => prefetchChatSettings(entity.id)
                      : () => prefetchChannelSettings(entity.id);
                  const prefetchSecondary =
                    activeTab === 'chat'
                      ? () => prefetchChatEvents(entity.id)
                      : () => prefetchChannelStats(entity.id);

                  return (
                    <article key={entity.id} className="managed-entities-row managed-entities-row--quick">
                      <Link
                        to={primaryHref}
                        className="managed-entities-row__main"
                        state={state}
                        onClick={() => rememberEntity(entity)}
                        onPointerEnter={prefetchPrimary}
                        onTouchStart={prefetchPrimary}
                      >
                        <EntityAvatar
                          title={entity.title}
                          entityType={activeTab}
                          avatarUrl={entity.avatarUrl ?? null}
                          className="managed-entities-row__avatar"
                        />
                        <div className="managed-entities-row__body">
                          <div className="managed-entities-row__titleline">
                            <h3>{entity.title}</h3>
                            <div className="managed-entities-row__flags">
                              {isLastOpened ? (
                                <span className="chip chip--success">
                                  Последний
                                </span>
                              ) : (
                                <span className="chip">Недавно</span>
                              )}
                            </div>
                          </div>
                          <p className="managed-entities-row__description">
                            {buildEntityDescription(entity, activeTab)}
                          </p>
                        </div>
                        <span className="managed-entities-row__primary-action">{primaryLabel}</span>
                      </Link>
                      <Link
                        to={secondaryHref}
                        className="button button--ghost managed-entities-row__secondary"
                        state={state}
                        onClick={() => rememberEntity(entity)}
                        onPointerEnter={prefetchSecondary}
                        onTouchStart={prefetchSecondary}
                      >
                        {secondaryLabel}
                      </Link>
                    </article>
                  );
                })}
              </section>
            </GlassCard>
          ) : null}

          {visibleEntities.length > 0 ? (
            <GlassCard className="managed-entities-panel" padding="sm" elevated>
              <div className="managed-entities-panel__head">
                <div className="managed-entities-panel__title">
                  <h2 style={{ margin: 0, fontSize: '1rem', lineHeight: 1.2 }}>{listSectionTitle}</h2>
                  <p style={{ margin: 0, fontSize: '0.8rem', lineHeight: 1.35, color: 'var(--text-muted)' }}>
                    {hasQuery
                      ? 'Результаты поиска по названию и ID.'
                      : 'Компактный список для быстрого перехода к настройкам.'}
                  </p>
                </div>
                <span className="chats-search-card__count">{listEntities.length}</span>
              </div>

              <section className="managed-entities-list" aria-label={listSectionTitle}>
                {visibleEntities.map((entity) => {
                  const isLastOpened = entity.id === activeLastEntityId;
                  const primaryHref =
                    activeTab === 'chat'
                      ? `/chat/${entity.id}/settings`
                      : `/channel/${entity.id}/settings`;
                  const secondaryHref =
                    activeTab === 'chat'
                      ? `/chat/${entity.id}/events`
                      : `/channel/${entity.id}/stats`;
                  const primaryLabel = '>';
                  const secondaryLabel = activeTab === 'chat' ? 'События' : 'Статистика';
                  const state =
                    activeTab === 'chat'
                      ? { chatTitle: entity.title, avatarUrl: entity.avatarUrl ?? null }
                      : {
                          chatTitle: entity.title,
                          chatLink: entity.link ?? '',
                          avatarUrl: entity.avatarUrl ?? null,
                        };
                  const prefetchPrimary =
                    activeTab === 'chat'
                      ? () => prefetchChatSettings(entity.id)
                      : () => prefetchChannelSettings(entity.id);
                  const prefetchSecondary =
                    activeTab === 'chat'
                      ? () => prefetchChatEvents(entity.id)
                      : () => prefetchChannelStats(entity.id);

                  return (
                    <article key={entity.id} className="managed-entities-row">
                      <Link
                        to={primaryHref}
                        className="managed-entities-row__main"
                        state={state}
                        onClick={() => rememberEntity(entity)}
                        onPointerEnter={prefetchPrimary}
                        onTouchStart={prefetchPrimary}
                      >
                        <EntityAvatar
                          title={entity.title}
                          entityType={activeTab}
                          avatarUrl={entity.avatarUrl ?? null}
                          className="managed-entities-row__avatar"
                        />
                        <div className="managed-entities-row__body">
                          <div className="managed-entities-row__titleline">
                            <h3>{entity.title}</h3>
                            <div className="managed-entities-row__flags">
                              {isLastOpened ? (
                                <span className="chip chip--success">
                                  Последний
                                </span>
                              ) : null}
                            </div>
                          </div>
                          <p className="managed-entities-row__description">
                            {buildEntityDescription(entity, activeTab)}
                          </p>
                        </div>
                        <span className="managed-entities-row__primary-action">{primaryLabel}</span>
                      </Link>
                      <Link
                        to={secondaryHref}
                        className="button button--ghost managed-entities-row__secondary"
                        state={state}
                        onClick={() => rememberEntity(entity)}
                        onPointerEnter={prefetchSecondary}
                        onTouchStart={prefetchSecondary}
                      >
                        {secondaryLabel}
                      </Link>
                    </article>
                  );
                })}
              </section>

              {remainingEntitiesCount > 0 ? (
                <button
                  type="button"
                  className="button button--ghost managed-entities-load-more"
                  onClick={() =>
                    setVisibleCount((current) =>
                      Math.min(current + LIST_PAGE_SIZE, listEntities.length),
                    )
                  }
                >
                  Показать ещё {Math.min(LIST_PAGE_SIZE, remainingEntitiesCount)}
                </button>
              ) : null}
            </GlassCard>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
