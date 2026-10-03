import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  chatSettingsSchema,
  REQUIRED_SUBSCRIPTION_MAX_CHANNELS,
  type ChatSettings,
} from '@maxim/contracts';
import { useSettingsRequiredSubscription } from '../../src/pages/settings/use-settings-required-subscription';
import { RequiredSubscriptionExternalSource } from '../../src/pages/settings/settings-required-subscription-ui';
import type { ApiTransport } from '../../src/lib/api/transport';
import '../../src/styles.css';
import '../../src/pages/settings-page.css';
import '../../src/styles/moderation-workspace.css';

const api: ApiTransport = {
  async request(path, init) {
    const response = await fetch(`/api${path}`, init);
    const body = await response.json();
    document.body.dataset.settledRequests = String(
      Number(document.body.dataset.settledRequests ?? 0) + 1,
    );
    if (!response.ok) throw new Error(body.message);
    return body;
  },
  requestKeepalive() {},
};
const chatsList = {
  data: [],
  isLoading: false,
  isRefreshing: false,
  error: null,
  isBackoffActive: false,
};

function Harness() {
  const [chatId, setChatId] = useState('chat-a');
  const [draft, setDraft] = useState<ChatSettings | null>(() => chatSettingsSchema.parse({}));
  const [notifications, setNotifications] = useState<string[]>([]);
  const state = useSettingsRequiredSubscription({
    api,
    chatId,
    draft,
    setDraft,
    enabled: false,
    chatsList,
    serverChannels: undefined,
    refreshChats() {},
    clearSelectionError() {},
    formatError: (error) => (error instanceof Error ? error.message : String(error)),
    onResolved: (channel) => setNotifications((current) => [...current, channel.id]),
    onResolveError: () => setNotifications((current) => [...current, 'error']),
  });
  return (
    <main style={{ maxWidth: 420, margin: 'auto', padding: 16 }}>
      <h1>Обязательная подписка</h1>
      <p data-testid="chat">{chatId}</p>
      <button
        onClick={() => {
          setChatId(chatId === 'chat-a' ? 'chat-b' : 'chat-a');
          setDraft(
            chatSettingsSchema.parse({
              requiredSubscriptionChannelIds: ['local-source'],
              requiredSubscriptionEnabled: true,
              antiSpamEnabled: true,
            }),
          );
        }}
      >
        Другой чат
      </button>
      <button
        onClick={() =>
          setDraft((current) =>
            current ? { ...current, antiSpamEnabled: !current.antiSpamEnabled } : current,
          )
        }
      >
        Изменить черновик
      </button>
      <button onClick={() => state.addRequiredSubscriptionChannel('local-source')}>
        Добавить локальный источник
      </button>
      <button onClick={() => state.removeRequiredSubscriptionChannel('local-source')}>
        Удалить локальный источник
      </button>
      <button
        onClick={() => {
          for (let index = 0; index < REQUIRED_SUBSCRIPTION_MAX_CHANNELS; index += 1) {
            state.addRequiredSubscriptionChannel(`local-${index}`);
          }
        }}
      >
        Заполнить список
      </button>
      <RequiredSubscriptionExternalSource
        value={state.requiredSubscriptionExternalChannelValue}
        error={state.requiredSubscriptionExternalChannelError}
        loading={state.isResolvingRequiredSubscriptionChannel}
        limitReached={false}
        onChange={(value) => {
          state.setRequiredSubscriptionExternalChannelValue(value);
          state.setRequiredSubscriptionExternalChannelError('');
        }}
        onSubmit={state.handleResolveRequiredSubscriptionExternalChannel}
      />
      <output style={{ display: 'block', overflowWrap: 'anywhere' }} data-testid="draft">
        {JSON.stringify({
          ids: draft?.requiredSubscriptionChannelIds,
          enabled: draft?.requiredSubscriptionEnabled,
          antiSpamEnabled: draft?.antiSpamEnabled,
          expires: draft?.requiredSubscriptionExpiresAt,
        })}
      </output>
      <output style={{ display: 'block', overflowWrap: 'anywhere' }} data-testid="notifications">
        {JSON.stringify(notifications)}
      </output>
    </main>
  );
}

document.body.dataset.miniappProfile = 'moderation';
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
