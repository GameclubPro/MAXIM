import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Refresh } from 'iconoir-react';
import {
  advertisingSendSchema,
  advertisingStateSchema,
} from '@maxim/contracts/advertising-placement';
import type { ApiTransport } from '../../lib/api/transport';
import { openMaxBotLink } from '../../lib/max-bridge';
import { SkeletonCard } from '../../components/ui/skeleton';

export default function SettingsAdvertisingWorkspace({
  api,
  chatId,
  userId,
}: {
  api: ApiTransport;
  chatId: string;
  userId: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['advertising-placement', userId, chatId];
  const path = `/chats/${encodeURIComponent(chatId)}/advertising-placement`;
  const requestId = useRef<string | null>(null);
  const [acknowledgedId, setAcknowledgedId] = useState<string | null>(null);
  const query = useQuery({
    queryKey,
    queryFn: async () => advertisingStateSchema.parse(await api.request(path)),
    refetchInterval: (q) => (q.state.data?.lastSend?.status === 'SENDING' ? 5000 : false),
    refetchOnWindowFocus: 'always',
    retry: false,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const settings = useMutation({
    mutationFn: async (enabled: boolean) =>
      advertisingStateSchema.parse(
        await api.request(path, {
          method: 'PUT',
          body: JSON.stringify({ enabled, revision: query.data!.revision }),
        }),
      ),
    onSuccess: (state) => queryClient.setQueryData(queryKey, state),
    onError: () => {
      void refresh();
    },
  });
  const send = useMutation({
    mutationFn: async () => {
      requestId.current ??= crypto.randomUUID();
      return advertisingSendSchema.parse(
        await api.request(`${path}/send`, {
          method: 'POST',
          body: JSON.stringify({
            requestId: requestId.current,
            revision: query.data!.revision,
            previousSendId: query.data!.lastSend?.id ?? null,
            acknowledgeUncertain:
              acknowledgedId !== null && acknowledgedId === query.data!.lastSend?.id,
          }),
        }),
      );
    },
    onSuccess: (lastSend) => {
      queryClient.setQueryData(queryKey, { ...query.data!, lastSend });
      requestId.current = null;
      setAcknowledgedId(null);
      void refresh();
    },
    onError: () => {
      void refresh();
    },
  });
  if (!query.data && query.isPending) return <SkeletonCard lines={4} />;
  if (!query.data || query.isError)
    return (
      <div className="advertising-workspace">
        <p role="alert">Не удалось открыть площадку. Проверьте доступ к чату и повторите.</p>
        <button className="button button--ghost" onClick={() => void query.refetch()}>
          <Refresh aria-hidden />
          Обновить
        </button>
      </div>
    );
  const data = query.data;
  const status = data.lastSend?.status;
  const pending = settings.isPending || send.isPending;
  const uncertain = status === 'UNCERTAIN';
  const ready =
    data.enabled &&
    data.bindingCurrent &&
    !!data.listing &&
    !data.lookupFailed &&
    !query.isFetching;
  const message =
    status === 'SENT'
      ? 'Кнопка отправлена'
      : status === 'SENDING'
        ? 'Отправляем кнопку…'
        : status === 'FAILED'
          ? 'Кнопка не отправлена. Обновите проверку перед новой отправкой.'
          : uncertain
            ? 'MAX не подтвердил отправку. Проверьте чат: повторная отправка может создать вторую кнопку.'
            : null;
  return (
    <div className="advertising-workspace">
      <div className="advertising-workspace__row">
        <strong>{data.enabled ? 'Включена' : 'Выключена'}</strong>
        <button
          className="button button--ghost advertising-workspace__tool"
          aria-label="Проверить площадку"
          title="Проверить площадку"
          disabled={pending || query.isFetching}
          onClick={() => void query.refetch()}
        >
          <Refresh aria-hidden />
        </button>
        <label className="settings-native-switch" aria-label="Включить рекламную площадку">
          <input
            type="checkbox"
            checked={data.enabled}
            disabled={pending || (!data.enabled && (!data.listing || data.lookupFailed))}
            onChange={(event) => settings.mutate(event.target.checked)}
          />
          <span className="toggle-switch" aria-hidden>
            <span className="toggle-switch__thumb" />
          </span>
        </label>
      </div>
      {data.lookupFailed ? (
        <p role="status">Не удалось проверить площадку в Связке.</p>
      ) : data.listing ? (
        <div className="advertising-workspace__listing">
          <strong>{data.listing.title}</strong>
          <button
            className="button button--ghost advertising-workspace__tool"
            aria-label="Открыть площадку"
            title="Открыть площадку"
            onClick={() => openMaxBotLink(data.listing!.url)}
          >
            <ArrowUpRight aria-hidden />
          </button>
        </div>
      ) : (
        <>
          <p>Активная площадка этого чата в Связке не найдена.</p>
          <button className="button button--ghost" onClick={() => openMaxBotLink(data.connectUrl)}>
            <ArrowUpRight aria-hidden />
            Подключить в Связке
          </button>
        </>
      )}
      {data.listing && (
        <figure className="advertising-workspace__preview" aria-label="Предпросмотр сообщения">
          <p>Реклама и взаимопиар в этом чате</p>
          <span>
            Рекламная площадка <ArrowUpRight aria-hidden />
          </span>
        </figure>
      )}
      {data.enabled && data.listing && !data.bindingCurrent && (
        <>
          <p role="status">Площадка изменилась. Подключите её заново.</p>
          <button
            className="button button--ghost"
            disabled={pending}
            onClick={() => settings.mutate(true)}
          >
            Подключить заново
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
      {send.isError && <p role="alert">Отправка не подтверждена. Обновите состояние.</p>}
      {settings.isError && (
        <p role="alert">Не удалось изменить настройку. Обновите проверку и повторите.</p>
      )}
      {uncertain && (
        <label className="advertising-workspace__ack">
          <input
            type="checkbox"
            checked={acknowledgedId === data.lastSend!.id}
            onChange={(event) => setAcknowledgedId(event.target.checked ? data.lastSend!.id : null)}
          />
          Проверил чат. Отправить ещё раз.
        </label>
      )}
      <button
        className="button button--accent"
        disabled={
          !ready ||
          pending ||
          status === 'SENDING' ||
          (uncertain && acknowledgedId !== data.lastSend?.id)
        }
        onClick={() => send.mutate()}
      >
        {send.isPending ? 'Отправляем…' : 'Отправить кнопку'}
      </button>
      <p className="advertising-workspace__note">Выключение не удаляет уже отправленную кнопку.</p>
    </div>
  );
}
