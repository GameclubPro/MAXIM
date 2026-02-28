import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
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
              <button type="button" className="button button--danger" onClick={() => void chatsQuery.refetch()}>
                Повторить
              </button>
            }
          />
        </GlassCard>
      ) : null}

      {!chatsQuery.isLoading && !chatsQuery.error && filteredChats.length === 0 ? (
        <GlassCard>
          <StatusState
            tone="neutral"
            title="Чаты не найдены"
            description={
              chatsQuery.data && chatsQuery.data.length > 0
                ? 'Попробуйте изменить поисковый запрос.'
                : 'Доступных чатов нет. Убедитесь, что вы и бот являетесь админами одного чата.'
            }
          />
        </GlassCard>
      ) : null}

      {!chatsQuery.isLoading && !chatsQuery.error && filteredChats.length > 0 ? (
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
                Создан: {new Date(chat.createdAt).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })}
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
