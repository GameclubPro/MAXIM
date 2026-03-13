import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import addBotToChatImage from '../assets/onboarding/add-bot-to-chat.jpg';
import grantBotAdminRightsImage from '../assets/onboarding/grant-bot-admin-rights.jpg';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import type { ApiClient } from '../lib/api-client';
import { cn } from '../lib/cn';
import { saveChatTitle, saveChatTitles } from '../lib/chat-titles';
import {
  normalizeEntityType,
  readLastEntityType,
  saveLastEntityId,
  saveLastEntityType,
} from '../lib/last-chat';

type ManagedTab = 'chat' | 'channel';

export function ChatsPage({ api }: { api: ApiClient }) {
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const activeTab = normalizeEntityType(
    searchParams.get('view'),
    readLastEntityType(),
  ) as ManagedTab;

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

  useEffect(() => {
    saveLastEntityType(activeTab);
  }, [activeTab]);

  const tabLabel = activeTab === 'chat' ? 'Чаты' : 'Каналы';
  const searchLabel = activeTab === 'chat' ? 'Поиск по чатам' : 'Поиск по каналам';
  const searchPlaceholder = activeTab === 'chat' ? 'Поиск чата или ID' : 'Поиск канала или ID';
  const tabSubtitle =
    activeTab === 'chat' ? 'Настройки и события' : 'Посты, реакции и обсуждения';

  return (
    <div className="page-stack page-enter">
      {!isNoEntitiesForTab ? (
        <GlassCard
          className={cn(
            'chats-search-card',
            activeTab === 'channel' && 'chats-search-card--channel',
          )}
          padding="sm"
          elevated
        >
          <div className="chats-search-card__head">
            <div className="chats-search-card__title">
              <div className="chats-search-card__title-row">
                <h1>{tabLabel}</h1>
                <span
                  className="chats-search-card__count"
                  aria-label={`Найдено ${filteredEntities.length}`}
                >
                  {filteredEntities.length}
                </span>
              </div>
              <p>{tabSubtitle}</p>
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
                      saveLastEntityId('chat', entity.id);
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
                      saveLastEntityId('chat', entity.id);
                      saveChatTitle(entity.id, entity.title);
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
                    state={{ chatTitle: entity.title, chatLink: entity.link ?? '' }}
                    onClick={() => {
                      saveLastEntityId('channel', entity.id);
                      saveChatTitle(entity.id, entity.title);
                    }}
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
