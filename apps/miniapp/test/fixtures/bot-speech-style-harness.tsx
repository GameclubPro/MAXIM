import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { chatSettingsSchema, type ChatSettingsScreenResponse } from '@maxim/contracts/settings';
import {
  getBotSpeechEditableTemplate,
  resolveBotSpeechStyle,
  type BotSpeechStyle,
} from '@maxim/contracts/bot-speech';
import { useSettingsDraft } from '../../src/pages/settings/use-settings-draft';
import SettingsSpeechStylePanel from '../../src/pages/settings/settings-speech-style-panel';
import { BotSpeechMessageEditorSheet } from '../../src/components/bot-speech-message-editor-sheet';
import { updateBotSpeechStyle } from '../../src/lib/api/chat-settings-client';
import { ApiRequestError } from '../../src/lib/api-request-error';
import type { ApiTransport } from '../../src/lib/api/transport';
import '../../src/styles.css';
import '../../src/styles/settings-drilldown-core.css';
import '../../src/styles/settings-native-controls.css';
import '../../src/styles/settings-native-polish.css';
import '../../src/pages/settings-page.css';

const initial = chatSettingsSchema.parse({
  settingsRevision: new URLSearchParams(location.search).has('legacy')
    ? undefined
    : '2026-10-04T09:00:00.000Z',
  botSpeechStyle: null,
  greetingBotMessageText: getBotSpeechEditableTemplate('POLICE', 'greetingBotMessageText'),
  linkWarnMessageText: '  **Мой текст** {user}\r\n ',
  botSpeechMedia: { linkWarnMessageText: { base64: 'aGVsbG8=', mimeType: 'image/png' } },
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
  const queryClient = useQueryClient();
  const [chatId, setChatId] = useState('chat-a');
  const [pending, setPending] = useState<BotSpeechStyle | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const query = useQuery({
    queryKey: ['settings-screen', chatId],
    queryFn: async () =>
      ({ settings: await api.request(`/chats/${chatId}/settings`) }) as ChatSettingsScreenResponse,
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
    onSaved() {},
    onError() {},
  });
  const save = useMutation({
    onMutate: () => ({
      isCurrentSettingsScope: state.isCurrentSettingsScope,
      syncSavedBotSpeechStyle: state.syncSavedBotSpeechStyle,
    }),
    mutationFn: (style: BotSpeechStyle) => updateBotSpeechStyle(api, chatId, style),
    onSuccess: async (saved, _style, scope) => {
      await scope?.syncSavedBotSpeechStyle(saved);
      if (!scope?.isCurrentSettingsScope()) return;
      setPending(null);
      setEvents((current) => [...current, 'saved']);
    },
    onError: (_error, _style, scope) => {
      if (scope?.isCurrentSettingsScope()) setEvents((current) => [...current, 'error']);
    },
  });
  const active = resolveBotSpeechStyle(state.draft?.botSpeechStyle);
  return (
    <main>
      <button
        data-testid="cache-newer"
        onClick={() =>
          queryClient.setQueryData(['settings-screen', chatId], {
            ...query.data,
            settings: {
              ...query.data.settings,
              greetingBotMessageText: 'Новейший текст',
              botSpeechStyle: 'FRIENDLY',
              settingsRevision: '2026-10-04T11:00:00.000Z',
            },
          })
        }
      >
        Новейшие настройки
      </button>
      <button
        data-testid="change-chat"
        onClick={() => {
          setPending(null);
          setChatId(chatId === 'chat-a' ? 'chat-b' : 'chat-a');
        }}
      >
        Другой чат
      </button>
      <button onClick={() => setPending(active)}>Стиль речи</button>
      <button onClick={() => setEditorOpen(true)}>Приветствие</button>
      <label>
        Свой текст
        <input
          value={state.draft?.linkWarnMessageText ?? ''}
          onChange={(event) => {
            const value = event.target.value;
            state.setDraft((current) =>
              current ? { ...current, linkWarnMessageText: value } : current,
            );
          }}
        />
      </label>
      <output data-testid="state" hidden>
        {JSON.stringify({
          chatId,
          draft: state.draft,
          cached: query.data.settings,
          dirty: state.hasChanges,
          events,
          pending,
        })}
      </output>
      {pending && (
        <SettingsSpeechStylePanel
          activeStyle={state.draft?.botSpeechStyle ?? null}
          selectedStyle={pending}
          isSaving={save.isPending}
          onSelect={setPending}
          onClose={() => setPending(null)}
          onCancel={() => setPending(null)}
          onDiscard={() => setPending(active)}
          onSave={(style) => save.mutate(style)}
        />
      )}
      {editorOpen && state.draft && (
        <BotSpeechMessageEditorSheet
          title="Приветствие"
          ariaLabel="Редактор приветствия"
          value={state.draft.greetingBotMessageText}
          defaultValue={getBotSpeechEditableTemplate(active, 'greetingBotMessageText')}
          onChange={(value) =>
            state.setDraft((current) =>
              current ? { ...current, greetingBotMessageText: value } : current,
            )
          }
          onReset={() =>
            state.setDraft((current) =>
              current ? { ...current, greetingBotMessageText: '' } : current,
            )
          }
          onClose={() => setEditorOpen(false)}
        />
      )}
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
