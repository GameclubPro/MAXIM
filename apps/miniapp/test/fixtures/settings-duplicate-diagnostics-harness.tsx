import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { chatSettingsSchema, type ChatSettingsScreenResponse } from '@maxim/contracts/settings';
import type { ApiTransport } from '../../src/lib/api/transport';
import { ApiRequestError } from '../../src/lib/api-request-error';
import SettingsDuplicateDiagnostics from '../../src/pages/settings/settings-duplicate-diagnostics';
import { useSettingsDraft } from '../../src/pages/settings/use-settings-draft';
import '../../src/styles.css';
import '../../src/pages/settings/settings-duplicate-stage.css';
import '../../src/pages/settings/settings-duplicate-preview.css';

const initialSettings = chatSettingsSchema.parse({
  antiDuplicateEnabled: true,
  settingsRevision: '2026-10-05T00:00:00.000Z',
});
document.body.dataset.miniappProfile = 'moderation';

function Harness() {
  const [chatId, setChatId] = useState('chat-a');
  const [userId, setUserId] = useState('user-1');
  const [visible, setVisible] = useState(true);
  const api = useMemo<ApiTransport>(
    () => ({
      async request(path, init) {
        const response = await fetch(`/api${path}`, {
          ...init,
          headers: { ...init?.headers, 'x-test-user': userId },
        });
        const body = await response.text();
        if (!response.ok) throw new ApiRequestError(response.status, body, 'Ошибка запроса');
        return JSON.parse(body);
      },
      requestKeepalive() {},
    }),
    [userId],
  );
  const screen = useQuery<ChatSettingsScreenResponse>({
    queryKey: ['settings-screen', chatId],
    queryFn: async () => {
      const response = (await api.request(
        `/chats/${chatId}/settings-screen`,
      )) as ChatSettingsScreenResponse;
      return { ...response, settings: chatSettingsSchema.parse(response.settings) };
    },
    initialData: { settings: initialSettings } as ChatSettingsScreenResponse,
  });
  const settings = useSettingsDraft({
    api,
    chatId,
    userId,
    serverSettings: screen.data?.settings,
    refetchSettings: screen.refetch,
    onHydrated() {},
    onStopWordsSaved() {},
    onSaved() {},
    onError() {},
  });
  return (
    <main style={{ padding: 16, maxWidth: 520, margin: '0 auto' }}>
      <nav aria-label="Навигация проверки" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button onClick={() => setChatId('chat-a')}>Чат A</button>
        <button onClick={() => setChatId('chat-b')}>Чат B</button>
        <button onClick={() => setUserId('user-1')}>Пользователь 1</button>
        <button onClick={() => setUserId('user-2')}>Пользователь 2</button>
        <button onClick={() => setVisible(false)}>Уйти с экрана</button>
        <button onClick={() => setVisible(true)}>Вернуться</button>
      </nav>
      <p data-testid="identity">
        {userId}:{chatId}
      </p>
      <button
        disabled={!settings.draft || settings.isSavingSettings}
        onClick={() =>
          settings.draft &&
          settings.saveSectionMutation.mutate({
            section: 'duplicates',
            payload: { ...settings.draft, antiDuplicateEnabled: false },
          })
        }
      >
        Сохранить выключение
      </button>
      {visible && <SettingsDuplicateDiagnostics api={api} chatId={chatId} userId={userId} />}
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
