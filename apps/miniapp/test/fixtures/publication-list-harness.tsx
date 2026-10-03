import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePublicationList } from '../../src/features/publications/use-publication-list';
import { usePublicationCalendar } from '../../src/features/publications/use-publication-calendar';
import { createEmptyPublicationDraft } from '../../src/features/publications/publication-model';
import type { ApiTransport } from '../../src/lib/api/transport';
const api: ApiTransport = {
  async request(path, init) {
    const response = await fetch(`/api${path}`, init);
    if (!response.ok) throw Error('Ошибка списка');
    return response.json();
  },
  requestKeepalive() {},
};
const initial = createEmptyPublicationDraft([
  { id: 'target-a', entityType: 'channel', title: 'Канал', avatarUrl: null, channelOverview: null },
]);
function Harness() {
  const [editor, setEditor] = useState(false);
  const state = usePublicationList(api, true, editor);
  const calendar = usePublicationCalendar(
    api,
    editor,
    { ...initial, timingMode: 'schedule' },
    { kind: 'edit', publicationId: 'publication-a', expectedRevision: 1, editScope: null },
  );
  return (
    <main>
      <label>
        Поиск
        <input
          value={state.query}
          onChange={(event) => {
            state.setQuery(event.target.value);
            state.setPublicationHubRoute({ query: event.target.value });
          }}
        />
      </label>
      <button
        onClick={() => {
          state.setEntityFilter('channel');
          state.setPublicationHubRoute({ entity: 'channel' });
        }}
      >
        Каналы
      </button>
      <button onClick={() => state.changeView('history')}>История</button>
      <button onClick={() => setEditor((value) => !value)}>Редактор</button>
      <button
        disabled={!state.currentListQuery.hasNextPage}
        onClick={() => void state.currentListQuery.fetchNextPage()}
      >
        Ещё
      </button>
      <output data-testid="state">
        {JSON.stringify({
          view: state.view,
          query: state.query,
          entity: state.entityFilter,
          pages: state.currentListQuery.data?.pages.length ?? 0,
          marker: state.currentListQuery.data?.pages.at(-1)?.nextCursor ?? null,
          calendar: calendar.data,
          editor,
        })}
      </output>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <BrowserRouter>
      <Harness />
    </BrowserRouter>
  </QueryClientProvider>,
);
