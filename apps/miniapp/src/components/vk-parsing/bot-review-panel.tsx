import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChatBubble, OpenNewWindow, RefreshCircle } from 'iconoir-react';
import type { ApiTransport } from '../../lib/api/transport';
import { getVkBotReviewState, updateVkBotReviewState } from '../../lib/api/vk-parsing-client';
import type { VkBotReviewSettingsRequest } from '@maxim/contracts/vk-parsing';
import { openLink } from '../../lib/max-bridge';
import { normalizeApiError } from './format';

export function useVkBotReviewState(api: ApiTransport, chatId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['vk-bot-review', chatId],
    queryFn: () => getVkBotReviewState(api, chatId),
    enabled,
    staleTime: 5000,
    refetchInterval: enabled ? 15_000 : false,
  });
}

export function BotReviewPanel({
  api,
  chatId,
  active,
}: {
  api: ApiTransport;
  chatId: string;
  active: boolean;
}) {
  const query = useVkBotReviewState(api, chatId, active);
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (action: VkBotReviewSettingsRequest['action']) =>
      updateVkBotReviewState(api, chatId, { action }),
    onSuccess: (state) => client.setQueryData(['vk-bot-review', chatId], state),
  });
  const state = query.data;
  if (!state && !query.error) return null;
  return (
    <section className="vk-bot-review-panel" aria-label="Согласование в личке">
      <div className="vk-bot-review-panel__heading">
        <ChatBubble aria-hidden />
        <h3>Согласование в личке</h3>
        {state ? <span>{state.pendingCount} ожидают</span> : null}
      </div>
      {state ? (
        <>
          <div className="vk-bot-review-panel__controls">
            <button
              type="button"
              className="button button--ghost"
              onClick={() => openLink(state.botUrl)}
            >
              <OpenNewWindow aria-hidden />
              {state.inboxConnected ? 'Открыть бота' : 'Подключить личку'}
            </button>
            {!state.recipientConfigured ? (
              <button
                type="button"
                className="button button--accent"
                disabled={!state.available || !state.inboxConnected || mutation.isPending}
                onClick={() => mutation.mutate('CONNECT')}
              >
                <ChatBubble aria-hidden />
                Получать мне
              </button>
            ) : null}
            {state.isRecipient ? (
              <label className="vk-bot-review-panel__toggle">
                <input
                  type="checkbox"
                  checked={!state.paused}
                  disabled={!state.available || mutation.isPending}
                  onChange={(event) => mutation.mutate(event.target.checked ? 'RESUME' : 'PAUSE')}
                />
                Доставка включена
              </label>
            ) : null}
            <button
              type="button"
              className="vk-parsing-icon-button"
              aria-label="Обновить подключение лички"
              title="Обновить подключение лички"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              <RefreshCircle aria-hidden />
            </button>
          </div>
          {state.recipientConfigured ? (
            <span className="vk-bot-review-panel__status">
              {state.isRecipient ? 'Получатель: вы' : 'Получатель: другой администратор'}
            </span>
          ) : null}
          {!state.available ? <p role="status">Согласование в боте временно недоступно.</p> : null}
        </>
      ) : null}
      {query.error || mutation.error ? (
        <p role="alert">{normalizeApiError(mutation.error ?? query.error)}</p>
      ) : null}
    </section>
  );
}
