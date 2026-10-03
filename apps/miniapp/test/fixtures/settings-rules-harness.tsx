import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { chatRulesSchema, type ChatSettingsScreenResponse } from '@maxim/contracts/settings';
import { useSettingsRules } from '../../src/pages/settings/use-settings-rules';
import { ApiRequestError } from '../../src/lib/api-request-error';
import type { ApiTransport } from '../../src/lib/api/transport';
const initial = chatRulesSchema.parse({
  text: 'Сохранённые правила',
  publishedMessageId: 'old-post',
  publishedUrl: 'https://max.ru/old-post',
});
const api: ApiTransport = {
  async request(path, init) {
    const response = await fetch(`/api${path}`, init);
    const body = await response.text();
    if (!response.ok) throw new ApiRequestError(response.status, body, 'Ошибка сохранения');
    return JSON.parse(body);
  },
  requestKeepalive() {},
};
function Harness() {
  const [chatId, setChatId] = useState('chat-a');
  const [events, setEvents] = useState<string[]>([]);
  const query = useQuery({
    queryKey: ['settings-screen', chatId],
    queryFn: async () => ({ rules: initial }) as ChatSettingsScreenResponse,
    initialData: () => ({ rules: initial }) as ChatSettingsScreenResponse,
    enabled: false,
  });
  const state = useSettingsRules({
    api,
    chatId,
    serverRules: query.data?.rules,
    currentRulesTextSource: null,
    isUpdatingRulesAttachment: false,
    pushToast: (toast) => setEvents((current) => [...current, toast.title]),
  });
  return (
    <main>
      <button onClick={() => setChatId(chatId === 'chat-a' ? 'chat-b' : 'chat-a')}>
        Другой чат
      </button>
      <label>
        Правила
        <textarea
          aria-label="Правила"
          value={state.rulesDraft?.text ?? ''}
          disabled={state.isRulesDraftEditingDisabled}
          onChange={(event) =>
            state.setRulesDraft((draft) => (draft ? { ...draft, text: event.target.value } : draft))
          }
        />
      </label>
      <button disabled={state.isRulesBusy} onClick={() => void state.handleSaveRulesDraft()}>
        Сохранить
      </button>
      <button disabled={state.isRulesBusy} onClick={() => void state.handlePublishRules()}>
        Опубликовать
      </button>
      <button disabled={state.isRulesBusy} onClick={state.confirmResetPublishedRules}>
        Удалить публикацию
      </button>
      <output data-testid="state">
        {JSON.stringify({
          chatId,
          draft: state.rulesDraft,
          dirty: state.hasRulesChanges,
          busy: state.isRulesBusy,
          events,
        })}
      </output>
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
