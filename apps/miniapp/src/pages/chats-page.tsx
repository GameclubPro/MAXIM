import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { ApiClient } from '../lib/api-client';

export function ChatsPage({ api }: { api: ApiClient }) {
  const chatsQuery = useQuery({
    queryKey: ['chats'],
    queryFn: () => api.getChats(),
  });

  if (chatsQuery.isLoading) {
    return <p>Загрузка чатов...</p>;
  }

  if (chatsQuery.error) {
    return <p>Не удалось загрузить чаты: {(chatsQuery.error as Error).message}</p>;
  }

  if (!chatsQuery.data || chatsQuery.data.length === 0) {
    return <p>Доступных чатов нет. Добавьте ваш userId в allowlist для нужного чата.</p>;
  }

  return (
    <section className="panel-grid">
      {chatsQuery.data.map((chat) => (
        <article className="panel" key={chat.id}>
          <h3>{chat.title}</h3>
          <p>ID: {chat.id}</p>
          <div className="actions">
            <Link to={`/chat/${chat.id}/settings`}>Открыть настройки</Link>
            <Link to={`/chat/${chat.id}/events`}>Открыть логи</Link>
          </div>
        </article>
      ))}
    </section>
  );
}
