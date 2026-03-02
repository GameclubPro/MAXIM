import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import addBotToChatImage from '../assets/onboarding/add-bot-to-chat.jpg';
import grantBotAdminRightsImage from '../assets/onboarding/grant-bot-admin-rights.jpg';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import type { ApiClient } from '../lib/api-client';
import { saveChatTitle, saveChatTitles } from '../lib/chat-titles';
import { saveLastChatId } from '../lib/last-chat';

export function ChatsPage({ api }: { api: ApiClient }) {
  const [query, setQuery] = useState('');

  const chatsQuery = useQuery({
    queryKey: ['chats'],
    queryFn: () => api.getChats(),
  });
  const isNoChats =
    !chatsQuery.isLoading && !chatsQuery.error && (chatsQuery.data?.length ?? 0) === 0;

  const filteredChats = useMemo(() => {
    const source = chatsQuery.data ?? [];
    const normalized = query.trim().toLowerCase();

    if (!normalized) {
      return source;
    }

    return source.filter((chat) => {
      const haystack = `${chat.title} ${chat.id}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [chatsQuery.data, query]);

  useEffect(() => {
    if (!chatsQuery.data) {
      return;
    }

    saveChatTitles(chatsQuery.data);
  }, [chatsQuery.data]);

  return (
    <div className="page-stack page-enter">
      {!isNoChats ? (
        <GlassCard className="chats-search-card" padding="sm" elevated>
          <div className="chats-search-card__head">
            <div className="chats-search-card__title">
              <h1>Чаты</h1>
              <p>Быстрый доступ к настройкам и логам.</p>
            </div>
            <div className="chats-search-card__meta" aria-live="polite">
              <strong>{filteredChats.length}</strong>
              <small>найдено</small>
            </div>
          </div>
          <label className="field field--search chats-search-card__field" htmlFor="chat-search">
            <span>Поиск по названию или ID</span>
            <input
              id="chat-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Например: support"
            />
          </label>
        </GlassCard>
      ) : null}

      {chatsQuery.isLoading ? (
        <section className="chat-grid" aria-label="Загрузка чатов">
          {Array.from({ length: 4 }).map((_, index) => (
            <GlassCard key={index} as="article" className="chat-card">
              <SkeletonCard lines={3} />
            </GlassCard>
          ))}
        </section>
      ) : null}

      {chatsQuery.error ? (
        <GlassCard>
          <StatusState
            tone="danger"
            title="Не удалось загрузить чаты"
            description={(chatsQuery.error as Error).message}
            action={
              <button
                type="button"
                className="button button--danger"
                onClick={() => void chatsQuery.refetch()}
              >
                Повторить
              </button>
            }
          />
        </GlassCard>
      ) : null}

      {isNoChats ? (
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
                Чтобы увидеть чат в MAXIM, добавьте бота в чат и выдайте ему права администратора.
              </p>
            </div>
            <div className="chats-onboarding__sources">
              <a
                href="https://help.max.ru/help/chats/add-members-chat"
                target="_blank"
                rel="noopener noreferrer"
              >
                MAX Help: как добавить участника в чат
              </a>
              <a
                href="https://help.max.ru/help/chats/assign-administrator-rights"
                target="_blank"
                rel="noopener noreferrer"
              >
                MAX Help: как назначить администратора
              </a>
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

          <GlassCard className="onboarding-tip stagger-in" style={{ animationDelay: '120ms' }}>
            <h3>Если бот не находится или не добавляется</h3>
            <p>
              Проверьте в настройках бота, что разрешено добавление в групповые чаты:{' '}
              <a
                href="https://dev.max.ru/docs/help/bots/settings"
                target="_blank"
                rel="noopener noreferrer"
              >
                dev.max.ru/docs/help/bots/settings
              </a>
              .
            </p>
          </GlassCard>

          <button
            type="button"
            className="button button--accent onboarding-refresh"
            onClick={() => void chatsQuery.refetch()}
            disabled={chatsQuery.isFetching}
          >
            {chatsQuery.isFetching ? 'Обновляем...' : 'Я добавил бота, обновить'}
          </button>
        </section>
      ) : null}

      {!chatsQuery.isLoading && !chatsQuery.error && !isNoChats && filteredChats.length === 0 ? (
        <GlassCard>
          <StatusState
            tone="neutral"
            title="Чаты не найдены"
            description="Попробуйте изменить поисковый запрос."
          />
        </GlassCard>
      ) : null}

      {!chatsQuery.isLoading && !chatsQuery.error && !isNoChats && filteredChats.length > 0 ? (
        <section className="chat-grid" aria-label="Список чатов">
          {filteredChats.map((chat, index) => (
            <GlassCard
              as="article"
              key={chat.id}
              className="chat-card stagger-in"
              style={{ animationDelay: `${index * 55}ms` }}
            >
              <div className="chat-card__header">
                <h3>{chat.title}</h3>
                <span className="chip">ID: {chat.id}</span>
              </div>
              <p className="chat-card__created">
                Создан:{' '}
                {new Date(chat.createdAt).toLocaleDateString('ru-RU', {
                  day: '2-digit',
                  month: 'long',
                  year: 'numeric',
                })}
              </p>
              <div className="chat-card__actions">
                <Link
                  to={`/chat/${chat.id}/settings`}
                  className="button button--accent"
                  state={{ chatTitle: chat.title }}
                  onClick={() => {
                    saveLastChatId(chat.id);
                    saveChatTitle(chat.id, chat.title);
                  }}
                >
                  Настройки
                </Link>
                <Link
                  to={`/chat/${chat.id}/events`}
                  className="button button--ghost"
                  state={{ chatTitle: chat.title }}
                  onClick={() => {
                    saveLastChatId(chat.id);
                    saveChatTitle(chat.id, chat.title);
                  }}
                >
                  Логи
                </Link>
              </div>
            </GlassCard>
          ))}
        </section>
      ) : null}
    </div>
  );
}
