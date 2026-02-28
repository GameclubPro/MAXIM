import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import type { ApiClient } from '../lib/api-client';

export function EventsPage({ api }: { api: ApiClient }) {
  const { chatId } = useParams();

  const eventsQuery = useQuery({
    queryKey: ['events', chatId],
    queryFn: () => api.getEvents(chatId ?? ''),
    enabled: Boolean(chatId),
    refetchInterval: 10_000,
  });

  if (eventsQuery.isLoading) {
    return <p>Загрузка журнала...</p>;
  }

  if (eventsQuery.error) {
    return <p>Ошибка загрузки: {(eventsQuery.error as Error).message}</p>;
  }

  return (
    <section className="panel">
      <h2>Журнал модерации: {chatId}</h2>
      <div className="events-table">
        <div className="events-row events-head">
          <span>Время</span>
          <span>Пользователь</span>
          <span>Правило</span>
          <span>Действие</span>
        </div>
        {eventsQuery.data?.map((event) => (
          <div className="events-row" key={event.id}>
            <span>{new Date(event.createdAt).toLocaleString('ru-RU')}</span>
            <span>{event.userId}</span>
            <span>{event.ruleCode}</span>
            <span>{event.action}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
