import type { ChannelOverview } from '@maxim/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import addBotToChatImage from '../assets/onboarding/add-bot-to-chat.jpg';
import grantBotAdminRightsImage from '../assets/onboarding/grant-bot-admin-rights.jpg';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { cn } from '../lib/cn';
import type { ApiClient } from '../lib/api-client';
import { saveChatTitle, saveChatTitles } from '../lib/chat-titles';
import { saveLastChatId, saveLastEntityType } from '../lib/last-chat';

type ManagedTab = 'chat' | 'channel';

const DEFAULT_CHANNEL_OVERVIEW: ChannelOverview = {
  enabledScenariosCount: 1,
  commentsEnabled: true,
  postSuggestionsEnabled: false,
  commentsModerationEnabled: false,
  commentsSlowModeSeconds: 0,
};

function formatSlowMode(seconds: number): string {
  if (seconds <= 0) {
    return 'Нет';
  }

  if (seconds < 60) {
    return `${seconds}с`;
  }

  if (seconds % 60 === 0) {
    return `${seconds / 60}м`;
  }

  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return `${minutes}м ${restSeconds}с`;
}

function resolveChannelOverviewStatus(enabledScenariosCount: number): {
  label: string;
  tone: 'ready' | 'partial' | 'empty';
} {
  if (enabledScenariosCount >= 2) {
    return { label: 'Все включено', tone: 'ready' };
  }

  if (enabledScenariosCount === 1) {
    return { label: 'Частично настроен', tone: 'partial' };
  }

  return { label: 'Нужно настроить', tone: 'empty' };
}

function ChannelOverviewCard({ overview }: { overview: ChannelOverview | null }) {
  const resolvedOverview = overview ?? DEFAULT_CHANNEL_OVERVIEW;
  const status = resolveChannelOverviewStatus(resolvedOverview.enabledScenariosCount);

  return (
    <section className="channel-overview-card" aria-label="Краткая статистика канала">
      <div className="channel-overview-card__hero">
        <div className="channel-overview-card__score">
          <span className="channel-overview-card__eyebrow">Активно</span>
          <strong>{resolvedOverview.enabledScenariosCount}/2</strong>
          <span className="channel-overview-card__hint">сценария канала</span>
        </div>

        <span className={cn('channel-overview-card__status', `is-${status.tone}`)}>
          {status.label}
        </span>
      </div>

      <div className="channel-overview-card__grid">
        <article
          className={cn('channel-overview-card__metric', resolvedOverview.commentsEnabled && 'is-on')}
        >
          <small>Комментарии</small>
          <strong>{resolvedOverview.commentsEnabled ? 'Вкл' : 'Выкл'}</strong>
        </article>

        <article
          className={cn(
            'channel-overview-card__metric',
            resolvedOverview.postSuggestionsEnabled && 'is-on',
          )}
        >
          <small>Предложка</small>
          <strong>{resolvedOverview.postSuggestionsEnabled ? 'Вкл' : 'Выкл'}</strong>
        </article>

        <article
          className={cn(
            'channel-overview-card__metric',
            resolvedOverview.commentsModerationEnabled && 'is-on',
          )}
        >
          <small>Модерация</small>
          <strong>{resolvedOverview.commentsModerationEnabled ? 'Вкл' : 'Выкл'}</strong>
        </article>

        <article
          className={cn(
            'channel-overview-card__metric',
            resolvedOverview.commentsSlowModeSeconds > 0 && 'is-on',
          )}
        >
          <small>Пауза</small>
          <strong>{formatSlowMode(resolvedOverview.commentsSlowModeSeconds)}</strong>
        </article>
      </div>
    </section>
  );
}

export function ChatsPage({ api }: { api: ApiClient }) {
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState<ManagedTab>('chat');

  const entitiesQuery = useQuery({
    queryKey: ['managed-entities'],
    queryFn: async () => {
      const [chats, channels] = await Promise.all([api.getChats(), api.getChannels()]);
      return {
        chats,
        channels,
      };
    },
  });

  const activeEntities = useMemo(() => {
    const data = entitiesQuery.data;
    if (!data) {
      return [];
    }

    return activeTab === 'chat' ? data.chats : data.channels;
  }, [activeTab, entitiesQuery.data]);

  const isNoEntitiesForTab =
    !entitiesQuery.isLoading && !entitiesQuery.error && activeEntities.length === 0;

  const filteredEntities = useMemo(() => {
    const normalized = query.trim().toLowerCase();

    if (!normalized) {
      return activeEntities;
    }

    return activeEntities.filter((entity) => {
      const haystack = `${entity.title} ${entity.id}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [activeEntities, query]);

  useEffect(() => {
    if (!entitiesQuery.data) {
      return;
    }

    saveChatTitles([...entitiesQuery.data.chats, ...entitiesQuery.data.channels]);
  }, [entitiesQuery.data]);

  const tabLabel = activeTab === 'chat' ? 'Чаты' : 'Каналы';

  return (
    <div className="page-stack page-enter">
      {!isNoEntitiesForTab ? (
        <GlassCard className="chats-search-card" padding="sm" elevated>
          <div className="chats-search-card__head">
            <div className="chats-search-card__title">
              <h1>{tabLabel}</h1>
              <p>
                {activeTab === 'chat'
                  ? 'Быстрый доступ к настройкам и событиям.'
                  : 'Настройки предложки, реакций и обсуждения через бота.'}
              </p>
            </div>
            <div className="chats-search-card__meta" aria-live="polite">
              <strong>{filteredEntities.length}</strong>
              <small>найдено</small>
            </div>
          </div>

          <div className="chat-card__actions" role="tablist" aria-label="Тип сущности">
            <button
              type="button"
              className={activeTab === 'chat' ? 'button button--accent' : 'button button--ghost'}
              onClick={() => setActiveTab('chat')}
              role="tab"
              aria-selected={activeTab === 'chat'}
            >
              Чаты
            </button>
            <button
              type="button"
              className={activeTab === 'channel' ? 'button button--accent' : 'button button--ghost'}
              onClick={() => setActiveTab('channel')}
              role="tab"
              aria-selected={activeTab === 'channel'}
            >
              Каналы
            </button>
          </div>

          <label className="field field--search chats-search-card__field" htmlFor="chat-search">
            <span>Поиск по названию или ID</span>
            <input
              id="chat-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={activeTab === 'chat' ? 'Например: support' : 'Например: новости'}
            />
          </label>
        </GlassCard>
      ) : null}

      {entitiesQuery.isLoading ? (
        <section className="chat-grid" aria-label="Загрузка">
          {Array.from({ length: 4 }).map((_, index) => (
            <GlassCard key={index} as="article" className="chat-card">
              <SkeletonCard lines={3} />
            </GlassCard>
          ))}
        </section>
      ) : null}

      {entitiesQuery.error ? (
        <GlassCard>
          <StatusState
            tone="danger"
            title="Не удалось загрузить список"
            description={(entitiesQuery.error as Error).message}
            action={
              <button
                type="button"
                className="button button--danger"
                onClick={() => void entitiesQuery.refetch()}
              >
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
            onClick={() => void entitiesQuery.refetch()}
            disabled={entitiesQuery.isFetching}
          >
            {entitiesQuery.isFetching ? 'Обновляем...' : 'Я добавил бота, обновить'}
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
                onClick={() => void entitiesQuery.refetch()}
                disabled={entitiesQuery.isFetching}
              >
                {entitiesQuery.isFetching ? 'Обновляем...' : 'Обновить'}
              </button>
            }
          />
        </GlassCard>
      ) : null}

      {!entitiesQuery.isLoading &&
      !entitiesQuery.error &&
      !isNoEntitiesForTab &&
      filteredEntities.length === 0 ? (
        <GlassCard>
          <StatusState
            tone="neutral"
            title={`${tabLabel} не найдены`}
            description="Попробуйте изменить поисковый запрос."
          />
        </GlassCard>
      ) : null}

      {!entitiesQuery.isLoading &&
      !entitiesQuery.error &&
      !isNoEntitiesForTab &&
      filteredEntities.length > 0 ? (
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
                <span className="chip">ID: {entity.id}</span>
              </div>

              <p className="chat-card__created">
                Создан:{' '}
                {new Date(entity.createdAt).toLocaleDateString('ru-RU', {
                  day: '2-digit',
                  month: 'long',
                  year: 'numeric',
                })}
              </p>

              {activeTab === 'chat' ? (
                <div className="chat-card__actions">
                  <Link
                    to={`/chat/${entity.id}/settings`}
                    className="button button--accent"
                    state={{ chatTitle: entity.title }}
                    onClick={() => {
                      saveLastChatId(entity.id);
                      saveLastEntityType('chat');
                      saveChatTitle(entity.id, entity.title);
                    }}
                  >
                    Настройки
                  </Link>
                  <Link
                    to={`/chat/${entity.id}/events`}
                    className="button button--ghost"
                    state={{ chatTitle: entity.title }}
                    onClick={() => {
                      saveLastChatId(entity.id);
                      saveLastEntityType('chat');
                      saveChatTitle(entity.id, entity.title);
                    }}
                  >
                    События
                  </Link>
                </div>
              ) : (
                <>
                  <ChannelOverviewCard overview={entity.channelOverview} />

                  <div className="chat-card__actions chat-card__actions--single">
                    <Link
                      to={`/channel/${entity.id}/settings`}
                      className="button button--accent"
                      state={{ chatTitle: entity.title, chatLink: entity.link ?? '' }}
                      onClick={() => {
                        saveLastChatId(entity.id);
                        saveLastEntityType('channel');
                        saveChatTitle(entity.id, entity.title);
                      }}
                    >
                      Настройки
                    </Link>
                  </div>
                </>
              )}
            </GlassCard>
          ))}
        </section>
      ) : null}
    </div>
  );
}
