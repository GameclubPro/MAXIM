import { useQueryClient } from '@tanstack/react-query';
import { startTransition, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ChatSummary } from '@maxim/contracts';
import addBotToChatImage from '../assets/onboarding/add-bot-to-chat.jpg';
import grantBotAdminRightsImage from '../assets/onboarding/grant-bot-admin-rights.jpg';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { describeApiError } from '../lib/api-error';
import type { ApiTransport } from '../lib/api/transport';
import { saveChatTitle, saveChatTitles } from '../lib/chat-titles';
import { cn } from '../lib/cn';
import {
  normalizeEntityType,
  readLastEntityId,
  readLastEntityType,
  saveLastEntityId,
  saveLastEntityType,
} from '../lib/last-chat';
import { readPinnedEntityIds, togglePinnedEntity } from '../lib/pinned-entities';
import { useManagedEntitiesSync } from '../lib/use-managed-entities-sync';
import {
  preloadChannelSettingsPage,
  preloadChannelStatsPage,
  preloadEventsPage,
  preloadSettingsPage,
} from './lazy-pages';

type ManagedTab = 'chat' | 'channel';
const CHAT_CARD_STAGGER_STEP_MS = 45;
const CHAT_CARD_STAGGER_LIMIT = 10;
const CHAT_CARD_STAGGER_THRESHOLD = 24;
const DEFAULT_DASHBOARD_RANGE = '7d';
const DEFAULT_CHANNEL_STATS_RANGE = '7d';
const MANAGED_ENTITIES_CACHE_MAX_AGE_MS = 5 * 60 * 1_000;
const SYNC_STATUS_REFRESH_INTERVAL_MS = 30_000;
const SYNC_STATUS_BACKOFF_INTERVAL_MS = 1_000;

function getEntitiesKey(tab: ManagedTab): 'chats' | 'channels' {
  return tab === 'chat' ? 'chats' : 'channels';
}

function formatRelativeSyncTime(timestampMs: number, nowMs: number): string {
  const diffMs = Math.max(0, nowMs - timestampMs);
  const diffSeconds = Math.round(diffMs / 1_000);

  if (diffSeconds < 10) {
    return 'только что';
  }
  if (diffSeconds < 60) {
    return `${diffSeconds}с назад`;
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}м назад`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}ч назад`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}д назад`;
}

function formatRemainingSyncTime(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  if (totalSeconds < 60) {
    return `${totalSeconds}с`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}м` : `${minutes}м ${seconds}с`;
}

function sortEntitiesForDisplay(
  entities: ChatSummary[],
  pinnedIds: readonly string[],
  lastViewedEntityId: string,
): ChatSummary[] {
  if (entities.length < 2) {
    return entities;
  }

  const pinnedOrder = new Map(pinnedIds.map((id, index) => [id, index] as const));
  return [...entities].sort((left, right) => {
    const leftPinned = pinnedOrder.has(left.id);
    const rightPinned = pinnedOrder.has(right.id);

    if (leftPinned && rightPinned) {
      return (pinnedOrder.get(left.id) ?? 0) - (pinnedOrder.get(right.id) ?? 0);
    }
    if (leftPinned !== rightPinned) {
      return leftPinned ? -1 : 1;
    }

    if (left.id === lastViewedEntityId && right.id !== lastViewedEntityId) {
      return -1;
    }
    if (right.id === lastViewedEntityId && left.id !== lastViewedEntityId) {
      return 1;
    }

    return 0;
  });
}

export function ChatsPage({ api }: { api: ApiTransport }) {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [statusNowMs, setStatusNowMs] = useState(() => Date.now());
  const [pinnedIdsByTab, setPinnedIdsByTab] = useState<Record<ManagedTab, string[]>>(() => ({
    chat: readPinnedEntityIds('chat'),
    channel: readPinnedEntityIds('channel'),
  }));
  const [refreshNonceByTab, setRefreshNonceByTab] = useState<Record<ManagedTab, number>>({
    chat: 0,
    channel: 0,
  });
  const deferredQuery = useDeferredValue(query);
  const activeTab = normalizeEntityType(
    searchParams.get('view'),
    readLastEntityType(),
  ) as ManagedTab;
  const lastViewedEntityId = readLastEntityId(activeTab);
  const activeEntitiesKey = getEntitiesKey(activeTab);
  const chatsState = useManagedEntitiesSync({
    api,
    entityType: 'chat',
    enabled: activeTab === 'chat',
    reloadNonce: refreshNonceByTab.chat,
    resumeOnVisibilityReturn: true,
    skipInitialSyncIfCached: true,
    cacheMaxAgeMs: MANAGED_ENTITIES_CACHE_MAX_AGE_MS,
  });
  const channelsState = useManagedEntitiesSync({
    api,
    entityType: 'channel',
    enabled: activeTab === 'channel',
    reloadNonce: refreshNonceByTab.channel,
    resumeOnVisibilityReturn: true,
    skipInitialSyncIfCached: true,
    cacheMaxAgeMs: MANAGED_ENTITIES_CACHE_MAX_AGE_MS,
  });

  const activeEntities = useMemo(() => {
    return activeEntitiesKey === 'chats' ? chatsState.data : channelsState.data;
  }, [activeEntitiesKey, channelsState.data, chatsState.data]);

  const activeEntitiesState = activeTab === 'chat' ? chatsState : channelsState;
  const isLoading = activeEntitiesState.isLoading;
  const isFetching = activeEntitiesState.isRefreshing;
  const queryError = activeEntitiesState.error;
  const refreshState = activeEntitiesState.refreshState;
  const activePinnedIds = pinnedIdsByTab[activeTab];
  const activePinnedIdsSet = useMemo(() => new Set(activePinnedIds), [activePinnedIds]);
  const isSyncSettled = activeEntitiesState.isSyncComplete || activeEntitiesState.isBackoffActive;
  const isSyncPending = !isLoading && !queryError && !isSyncSettled;
  const isRefreshTemporarilyBlocked =
    activeEntitiesState.isBackoffActive && (refreshState?.nextPollAfterMs ?? 0) > 0;

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

    const normalized = deferredQuery.trim().toLowerCase();

    if (!normalized) {
      return activeEntities;
    }

    return activeEntities.filter((entity) => {
      const haystack = `${entity.title} ${entity.id}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [activeEntities, deferredQuery]);
  const visibleEntities = useMemo(
    () => sortEntitiesForDisplay(filteredEntities, activePinnedIds, lastViewedEntityId),
    [activePinnedIds, filteredEntities, lastViewedEntityId],
  );
  const pinnedEntities = useMemo(() => {
    if (
      !Array.isArray(activeEntities) ||
      activeEntities.length === 0 ||
      activePinnedIds.length === 0
    ) {
      return [];
    }

    return sortEntitiesForDisplay(
      activeEntities.filter((entity) => activePinnedIdsSet.has(entity.id)),
      activePinnedIds,
      lastViewedEntityId,
    );
  }, [activeEntities, activePinnedIds, activePinnedIdsSet, lastViewedEntityId]);
  const limitedStagger =
    visibleEntities.length > CHAT_CARD_STAGGER_THRESHOLD ? CHAT_CARD_STAGGER_LIMIT : null;
  const syncStatus = useMemo(() => {
    if (isLoading && (!Array.isArray(activeEntities) || activeEntities.length === 0)) {
      return { text: 'Загружаем список…', tone: 'accent' as const };
    }
    if (isFetching) {
      return { text: 'Фоново обновляем список', tone: 'accent' as const };
    }
    if (isRefreshTemporarilyBlocked) {
      return {
        text: `MAX временно замедлил обновление, повтор через ${formatRemainingSyncTime(
          refreshState?.nextPollAfterMs ?? 0,
        )}`,
        tone: 'warning' as const,
      };
    }
    if (isSyncPending) {
      return { text: 'Проверяем новые доступные чаты в фоне', tone: 'neutral' as const };
    }
    if (activeEntitiesState.lastSyncedAtMs) {
      return {
        text: `Обновлено ${formatRelativeSyncTime(activeEntitiesState.lastSyncedAtMs, statusNowMs)}`,
        tone: 'success' as const,
      };
    }
    return { text: 'Локальный список готов', tone: 'neutral' as const };
  }, [
    activeEntities,
    activeEntitiesState.lastSyncedAtMs,
    isFetching,
    isLoading,
    isRefreshTemporarilyBlocked,
    isSyncPending,
    refreshState?.nextPollAfterMs,
    statusNowMs,
  ]);

  function handleRefresh() {
    if (isRefreshTemporarilyBlocked) {
      return;
    }

    startTransition(() => {
      setRefreshNonceByTab((current) => ({
        ...current,
        [activeTab]: current[activeTab] + 1,
      }));
    });
  }

  useEffect(() => {
    const intervalMs = isRefreshTemporarilyBlocked
      ? SYNC_STATUS_BACKOFF_INTERVAL_MS
      : SYNC_STATUS_REFRESH_INTERVAL_MS;
    const intervalId = window.setInterval(() => {
      setStatusNowMs(Date.now());
    }, intervalMs);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isRefreshTemporarilyBlocked]);

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

  function handleTogglePinned(entityId: string) {
    startTransition(() => {
      setPinnedIdsByTab((current) => ({
        ...current,
        [activeTab]: togglePinnedEntity(activeTab, entityId),
      }));
    });
  }

  function rememberEntity(entityType: ManagedTab, entity: ChatSummary) {
    saveLastEntityId(entityType, entity.id);
    saveChatTitle(entity.id, entity.title);
  }

  function buildPrimaryEntityPath(entityType: ManagedTab, entityId: string): string {
    return entityType === 'chat' ? `/chat/${entityId}/settings` : `/channel/${entityId}/settings`;
  }

  function buildPrimaryEntityState(entityType: ManagedTab, entity: ChatSummary) {
    if (entityType === 'chat') {
      return { chatTitle: entity.title, avatarUrl: entity.avatarUrl ?? null };
    }

    return {
      chatTitle: entity.title,
      chatLink: entity.link ?? '',
      avatarUrl: entity.avatarUrl ?? null,
    };
  }

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

  const tabLabel = activeTab === 'chat' ? 'Чаты' : 'Каналы';
  const searchLabel = activeTab === 'chat' ? 'Поиск чата' : 'Поиск канала';
  const searchPlaceholder = activeTab === 'chat' ? 'Поиск чата' : 'Поиск канала';
  const refreshButtonLabel = isFetching ? 'Обновляем список' : 'Обновить список';

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
                    aria-label={`Найдено ${visibleEntities.length}`}
                  >
                    {visibleEntities.length}
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <span
                  className={cn(
                    'chip chats-search-card__status-chip',
                    syncStatus.tone === 'warning' && 'chip--warning',
                    syncStatus.tone === 'success' && 'chip--success',
                  )}
                >
                  {syncStatus.text}
                </span>
                {pinnedEntities.length > 0 ? (
                  <span className="chip chats-search-card__status-chip">
                    Закреплено {pinnedEntities.length}
                  </span>
                ) : null}
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

      {!isLoading && !queryError && deferredQuery.trim() === '' && pinnedEntities.length > 0 ? (
        <GlassCard padding="sm" elevated style={{ display: 'grid', gap: 12 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <h2 style={{ margin: 0, fontSize: '0.96rem' }}>Закреплённые</h2>
            <span className="chip">{pinnedEntities.length}</span>
          </div>
          <div style={{ display: 'flex', gap: 10, overflowX: 'auto' }}>
            {pinnedEntities.map((entity) => (
              <Link
                key={entity.id}
                to={buildPrimaryEntityPath(activeTab, entity.id)}
                state={buildPrimaryEntityState(activeTab, entity)}
                onClick={() => rememberEntity(activeTab, entity)}
                onPointerEnter={() =>
                  activeTab === 'chat'
                    ? prefetchChatSettings(entity.id)
                    : prefetchChannelSettings(entity.id)
                }
                onTouchStart={() =>
                  activeTab === 'chat'
                    ? prefetchChatSettings(entity.id)
                    : prefetchChannelSettings(entity.id)
                }
                style={{
                  minWidth: 'min(220px, 62vw)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '12px 14px',
                  borderRadius: 18,
                  textDecoration: 'none',
                  color: 'var(--text-primary)',
                  border: '1px solid rgba(62, 96, 127, 0.12)',
                  background: 'rgba(255, 255, 255, 0.78)',
                }}
              >
                <EntityAvatar
                  title={entity.title}
                  entityType={activeTab}
                  avatarUrl={entity.avatarUrl ?? null}
                />
                <span
                  style={{
                    display: 'block',
                    minWidth: 0,
                    fontWeight: 700,
                    lineHeight: 1.25,
                    overflow: 'hidden',
                  }}
                >
                  {entity.title}
                </span>
              </Link>
            ))}
          </div>
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
      visibleEntities.length === 0 ? (
        <GlassCard>
          <StatusState
            tone="neutral"
            title={`${tabLabel} не найдены`}
            description="Попробуйте изменить поисковый запрос."
          />
        </GlassCard>
      ) : null}

      {!isLoading && !queryError && !isNoEntitiesForTab && visibleEntities.length > 0 ? (
        <section className="chat-grid" aria-label="Список">
          {visibleEntities.map((entity, index) => {
            const staggerIndex =
              limitedStagger === null ? index : index < limitedStagger ? index : null;
            const className = staggerIndex === null ? 'chat-card' : 'chat-card stagger-in';
            const style =
              staggerIndex === null
                ? undefined
                : { animationDelay: `${staggerIndex * CHAT_CARD_STAGGER_STEP_MS}ms` };
            const isPinned = activePinnedIdsSet.has(entity.id);

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
                    <h3>{entity.title}</h3>
                  </div>
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => handleTogglePinned(entity.id)}
                    aria-pressed={isPinned}
                    aria-label={isPinned ? 'Убрать из закреплённых' : 'Закрепить'}
                    title={isPinned ? 'Убрать из закреплённых' : 'Закрепить'}
                    style={{
                      width: 40,
                      minWidth: 40,
                      height: 40,
                      padding: 0,
                      borderRadius: 999,
                      color: isPinned ? '#c28b11' : 'rgba(86, 116, 145, 0.9)',
                      ...(isPinned ? { borderColor: 'rgba(232, 176, 49, 0.24)' } : {}),
                    }}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                      <path
                        d="M12 3.8l2.43 4.92 5.43.79-3.93 3.83.93 5.41L12 16.18l-4.86 2.57.93-5.41L4.14 9.51l5.43-.79L12 3.8z"
                        fill="currentColor"
                      />
                    </svg>
                  </button>
                </div>

                {activeTab === 'chat' ? (
                  <div className="chat-card__actions">
                    <Link
                      to={`/chat/${entity.id}/settings`}
                      className="button button--accent"
                      state={{ chatTitle: entity.title, avatarUrl: entity.avatarUrl ?? null }}
                      onClick={() => rememberEntity('chat', entity)}
                      onPointerEnter={() => prefetchChatSettings(entity.id)}
                      onTouchStart={() => prefetchChatSettings(entity.id)}
                    >
                      Настройки
                    </Link>
                    <Link
                      to={`/chat/${entity.id}/events`}
                      className="button button--ghost"
                      state={{ chatTitle: entity.title, avatarUrl: entity.avatarUrl ?? null }}
                      onClick={() => rememberEntity('chat', entity)}
                      onPointerEnter={() => prefetchChatEvents(entity.id)}
                      onTouchStart={() => prefetchChatEvents(entity.id)}
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
                      onClick={() => rememberEntity('channel', entity)}
                      onPointerEnter={() => prefetchChannelSettings(entity.id)}
                      onTouchStart={() => prefetchChannelSettings(entity.id)}
                    >
                      Настройки
                    </Link>
                    <Link
                      to={`/channel/${entity.id}/stats`}
                      className="button button--ghost"
                      state={{ chatTitle: entity.title, avatarUrl: entity.avatarUrl ?? null }}
                      onClick={() => rememberEntity('channel', entity)}
                      onPointerEnter={() => prefetchChannelStats(entity.id)}
                      onTouchStart={() => prefetchChannelStats(entity.id)}
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
