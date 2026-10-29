import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  chatSettingsSchema,
  stopWordsPolicySchema,
  type ChatSettingsScreenResponse,
} from '@maxim/contracts/settings';
import { useSettingsDraft } from '../../src/pages/settings/use-settings-draft';
import { ApiRequestError } from '../../src/lib/api-request-error';
import type { ApiTransport } from '../../src/lib/api/transport';

const revision = '2026-10-03T00:00:00.000Z';
const initial = chatSettingsSchema.parse({
  settingsRevision: revision,
  antiSpamEnabled: false,
  commentsAllEnabled: true,
  messageCountLimitMessages: 5,
  stopWordsRevision: 7,
  stopWordsPolicy: stopWordsPolicySchema.parse({ enabled: false }),
});
const api: ApiTransport = {
  async request(path, init) {
    const response = await fetch(`/api${path}`, init);
    const body = await response.text();
    if (!response.ok) throw new ApiRequestError(response.status, body, 'Не удалось сохранить');
    return JSON.parse(body);
  },
  requestKeepalive() {},
};
function Harness() {
  const [chatId, setChatId] = useState('chat-a');
  const [events, setEvents] = useState<string[]>([]);
  const query = useQuery({
    queryKey: ['settings-screen', chatId],
    queryFn: async () =>
      ({
        settings: await api.request(`/chats/${chatId}/settings`),
      }) as Promise<ChatSettingsScreenResponse>,
    initialData: () => ({ settings: { ...initial } }) as ChatSettingsScreenResponse,
    staleTime: Infinity,
  });
  const state = useSettingsDraft({
    api,
    chatId,
    serverSettings: query.data?.settings,
    refetchSettings: query.refetch,
    onHydrated() {},
    onStopWordsSaved() {},
    onSaved: () => setEvents((current) => [...current, 'saved']),
    onError: () => setEvents((current) => [...current, 'error']),
  });
  return (
    <main>
      <button onClick={() => setChatId(chatId === 'chat-a' ? 'chat-b' : 'chat-a')}>
        Другой чат
      </button>
      <button onClick={() => void query.refetch()}>Обновить</button>
      <label>
        Стоп-слова
        <input
          type="checkbox"
          checked={state.draft?.stopWordsPolicy?.enabled ?? false}
          onChange={(event) =>
            state.setDraft((current) =>
              current?.stopWordsPolicy
                ? {
                    ...current,
                    stopWordsPolicy: { ...current.stopWordsPolicy, enabled: event.target.checked },
                  }
                : current,
            )
          }
        />
      </label>
      <label>
        Антиспам
        <input
          type="checkbox"
          checked={state.draft?.antiSpamEnabled ?? false}
          onChange={(event) =>
            state.setDraft((current) =>
              current ? { ...current, antiSpamEnabled: event.target.checked } : current,
            )
          }
        />
      </label>
      <label>
        Лимит
        <input
          type="number"
          value={state.draft?.nightModeStartTimeMinutes ?? 0}
          onChange={(event) =>
            state.setDraft((current) =>
              current
                ? { ...current, nightModeStartTimeMinutes: Number(event.target.value) }
                : current,
            )
          }
        />
      </label>
      <label>
        Порог сообщений
        <input
          type="number"
          value={state.draft?.messageCountLimitMessages ?? 0}
          onChange={(event) =>
            state.setDraft((current) =>
              current
                ? { ...current, messageCountLimitMessages: Number(event.target.value) }
                : current,
            )
          }
        />
      </label>
      <button
        disabled={!state.draft || state.isSavingSettings}
        onClick={() => {
          if (state.draft)
            state.saveSectionMutation.mutate({ section: 'limits', payload: state.draft });
        }}
      >
        {state.isSavingSettings ? 'Сохраняем' : 'Сохранить'}
      </button>
      <button
        disabled={!state.draft || state.isSavingSettings}
        onClick={() => {
          if (state.draft)
            void state.saveWorkspaceDraft(state.draft).then(
              () => setEvents((current) => [...current, 'workspace saved']),
              () => setEvents((current) => [...current, 'workspace error']),
            );
        }}
      >
        Сохранить всё
      </button>
      <button
        disabled={!state.draft || state.isSavingSettings}
        onClick={() => {
          if (state.draft)
            state.saveSectionMutation.mutate({ section: 'stopWords', payload: state.draft });
        }}
      >
        Сохранить стоп-слова
      </button>
      <output data-testid="state">
        {JSON.stringify({
          chatId,
          draft: state.draft,
          dirty: state.hasChanges,
          conflict: state.settingsConflict,
          events,
        })}
      </output>
      <output data-testid="server">{JSON.stringify(query.data?.settings)}</output>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider
    client={
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      })
    }
  >
    <Harness />
  </QueryClientProvider>,
);
