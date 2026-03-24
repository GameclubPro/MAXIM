import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import addBotToChatImage from '../assets/onboarding/add-bot-to-chat.jpg';
import grantBotAdminRightsImage from '../assets/onboarding/grant-bot-admin-rights.jpg';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { getChannels, getChats } from '../lib/api/root-client';
import { describeApiError } from '../lib/api-error';
import type { ApiTransport } from '../lib/api/transport';
import { saveChatTitle, saveChatTitles } from '../lib/chat-titles';
import {
  normalizeEntityType,
  readLastEntityType,
  saveLastEntityId,
  saveLastEntityType,
} from '../lib/last-chat';
import {
  preloadChannelSettingsPage,
  preloadChannelStatsPage,
  preloadEventsPage,
  preloadSettingsPage,
} from './lazy-pages';

type ManagedTab = 'chat' | 'channel';
const LIST_VISIBILITY_REFRESH_MIN_INTERVAL_MS = 15_000;

function getEntitiesKey(tab: ManagedTab): 'chats' | 'channels' {
  return tab === 'chat' ? 'chats' : 'channels';
}

export function ChatsPage({ api }: { api: ApiTransport }) {
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [entities, setEntities] = useState<{
    chats: Awaited<ReturnType<typeof getChats>> | null;
    channels: Awaited<ReturnType<typeof getChannels>> | null;
  }>({
    chats: null,
    channels: null,
  });
  const [loadingState, setLoadingState] = useState<'idle' | 'loading' | 'refreshing' | 'error'>(
    'loading',
  );
  const [loadError, setLoadError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);
  const lastRefreshAtRef = useRef(0);
  const awaitingReturnRefreshRef = useRef(false);
  const deferredQuery = useDeferredValue(query);
  const activeTab = normalizeEntityType(
    searchParams.get('view'),
    readLastEntityType(),
  ) as ManagedTab;
  const activeEntitiesKey = getEntitiesKey(activeTab);

  useEffect(() => {
    let cancelled = false;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const refresh = refreshNonce > 0;
    const hasEntities = entities[activeEntitiesKey] !== null;

    setLoadingState(hasEntities ? 'refreshing' : 'loading');
    setLoadError(null);

    const loadEntities =
      activeTab === 'chat' ? getChats(api, { refresh }) : getChannels(api, { refresh });

    void loadEntities
      .then((nextEntities) => {
        if (cancelled || requestId !== requestIdRef.current) {
          return;
        }

        setEntities((current) => ({
          ...current,
          [activeEntitiesKey]: nextEntities,
        }));
        setLoadingState('idle');
      })
      .catch((error: unknown) => {
        if (cancelled || requestId !== requestIdRef.current) {
          return;
        }

        setLoadError(error instanceof Error ? error : new Error('Не удалось загрузить список.'));
        setLoadingState(hasEntities ? 'idle' : 'error');
      });

    return () => {
      cancelled = true;
    };
  }, [activeEntitiesKey, activeTab, api, refreshNonce]);

  const activeEntities = useMemo(() => {
    return entities[activeEntitiesKey];
  }, [activeEntitiesKey, entities]);

  const isLoading = loadingState === 'loading' && activeEntities === null;
  const isFetching = loadingState === 'refreshing';
  const queryError = activeEntities === null && loadingState === 'error' ? loadError : null;

  const isNoEntitiesForTab =
    !isLoading && !queryError && Array.isArray(activeEntities) && activeEntities.length === 0;

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

  function handleRefresh() {
    lastRefreshAtRef.current = Date.now();
    awaitingReturnRefreshRef.current = false;
    startTransition(() => {
      setRefreshNonce((current) => current + 1);
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
      if (loadingState === 'loading' || loadingState === 'refreshing') {
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
  }, [loadingState]);

  useEffect(() => {
    const allEntities = [...(entities.chats ?? []), ...(entities.channels ?? [])];
    if (allEntities.length === 0) {
      return;
    }

    saveChatTitles(allEntities);
  }, [entities]);

  useEffect(() => {
    saveLastEntityType(activeTab);
  }, [activeTab]);

  const tabLabel = activeTab === 'chat' ? 'Чаты' : 'Каналы';
  const searchLabel = activeTab === 'chat' ? 'Поиск чата' : 'Поиск канала';
  const searchPlaceholder = activeTab === 'chat' ? 'Поиск чата' : 'Поиск канала';

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
                    disabled={isFetching}
                    aria-label={isFetching ? 'Обновляем список' : 'Обновить список'}
                    title={isFetching ? 'Обновляем список' : 'Обновить список'}
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
                администратора.
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
            disabled={isFetching}
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
            description="Добавьте бота в канал с правами администратора, и он появится в этом списке."
            action={
              <button
                type="button"
                className="button button--accent"
                onClick={handleRefresh}
                disabled={isFetching}
              >
                {isFetching ? 'Обновляем...' : 'Обновить'}
              </button>
            }
          />
        </GlassCard>
      ) : null}

      {!isLoading && !queryError && !isNoEntitiesForTab && filteredEntities.length === 0 ? (
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
          {filteredEntities.map((entity, index) => (
            <GlassCard
              as="article"
              key={entity.id}
              className="chat-card stagger-in"
              style={{ animationDelay: `${index * 55}ms` }}
            >
              <div className="chat-card__header">
                <h3>{entity.title}</h3>
              </div>

              {activeTab === 'chat' ? (
                <div className="chat-card__actions">
                  <Link
                    to={`/chat/${entity.id}/settings`}
                    className="button button--accent"
                    state={{ chatTitle: entity.title }}
                    onClick={() => {
                      saveLastEntityId('chat', entity.id);
                      saveChatTitle(entity.id, entity.title);
                    }}
                    onPointerEnter={preloadSettingsPage}
                    onTouchStart={preloadSettingsPage}
                  >
                    Настройки
                  </Link>
                  <Link
                    to={`/chat/${entity.id}/events`}
                    className="button button--ghost"
                    state={{ chatTitle: entity.title }}
                    onClick={() => {
                      saveLastEntityId('chat', entity.id);
                      saveChatTitle(entity.id, entity.title);
                    }}
                    onPointerEnter={preloadEventsPage}
                    onTouchStart={preloadEventsPage}
                  >
                    События
                  </Link>
                </div>
              ) : (
                <div className="chat-card__actions">
                  <Link
                    to={`/channel/${entity.id}/settings`}
                    className="button button--accent"
                    state={{ chatTitle: entity.title, chatLink: entity.link ?? '' }}
                    onClick={() => {
                      saveLastEntityId('channel', entity.id);
                      saveChatTitle(entity.id, entity.title);
                    }}
                    onPointerEnter={preloadChannelSettingsPage}
                    onTouchStart={preloadChannelSettingsPage}
                  >
                    Настройки
                  </Link>
                  <Link
                    to={`/channel/${entity.id}/stats`}
                    className="button button--ghost"
                    state={{ chatTitle: entity.title }}
                    onClick={() => {
                      saveLastEntityId('channel', entity.id);
                      saveChatTitle(entity.id, entity.title);
                    }}
                    onPointerEnter={preloadChannelStatsPage}
                    onTouchStart={preloadChannelStatsPage}
                  >
                    Статистика
                  </Link>
                </div>
              )}
            </GlassCard>
          ))}
        </section>
      ) : null}
    </div>
  );
}
