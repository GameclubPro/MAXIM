import type {
  PublicationDelivery,
  PublicationPostActionCommand,
  PublicationPostActionRequest,
} from '@maxim/contracts/publication';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Timer, Pin, Trash, Xmark } from 'iconoir-react';
import { useState } from 'react';
import { ActionConfirmSheet } from '../../components/ui/action-confirm-sheet';
import { useToast } from '../../components/ui/toast';
import { executePublicationPostAction } from '../../lib/api/publication-post-actions-client';
import type { ApiTransport } from '../../lib/api/transport';
import { describeUserFacingError } from '../../lib/user-facing-error';
import { createPublicationRequestId } from './publication-request-identity';
import { formatPublicationScheduleField } from './publication-time-presentation';
import { PublicationOnceFields } from './publication-zoned-fields';
import './publication-delivery-actions.css';

const LABELS: Record<PublicationPostActionCommand, string> = {
  cancel_delete: 'Отменить автоудаление',
  reschedule_delete: 'Изменить время удаления',
  retry_delete: 'Повторить удаление',
  retry_pin: 'Повторить закрепление',
};
const ICONS = {
  cancel_delete: Xmark,
  reschedule_delete: Timer,
  retry_delete: Trash,
  retry_pin: Pin,
};

export function PublicationDeliveryActions({
  api,
  publicationId,
  delivery,
  timezone = 'Europe/Moscow',
  disabled = false,
}: {
  api: ApiTransport;
  publicationId: string;
  delivery: PublicationDelivery;
  timezone?: string;
  disabled?: boolean;
}) {
  const [command, setCommand] = useState<PublicationPostActionRequest | null>(null);
  const [dateFields, setDateFields] = useState({ date: '', time: '' });
  const [dateValid, setDateValid] = useState(true);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['publications', 'deliveries', publicationId] });
  const mutation = useMutation({
    mutationFn: (request: PublicationPostActionRequest) =>
      executePublicationPostAction(api, publicationId, delivery.id, request),
    onSuccess: async (_result, request) => {
      setCommand(null);
      pushToast({
        tone: 'success',
        title:
          request.action === 'cancel_delete'
            ? 'Автоудаление отменено'
            : request.action === 'reschedule_delete'
              ? 'Время удаления сохранено'
              : 'Повтор поставлен в очередь',
      });
      await refresh();
    },
    onError: () => {
      void refresh();
    },
  });
  const actions = delivery.postActions?.allowedActions ?? [];
  const version = delivery.postActions?.version;
  if ((!version || actions.length === 0 || delivery.status !== 'SENT') && !command) return null;
  const busy = disabled || mutation.isPending;
  const chooseTime = (at: string) => {
    const [date = '', time = ''] = formatPublicationScheduleField(at, timezone).split('T');
    setDateFields({ date, time });
    setDateValid(true);
    setCommand((current) =>
      current?.action === 'reschedule_delete' ? { ...current, deleteAt: at } : current,
    );
  };

  return (
    <>
      <div
        className="publication-delivery-actions"
        role="group"
        aria-label={`Действия с постом в ${delivery.target.title}`}
      >
        {actions.map((action) => {
          const Icon = ICONS[action];
          return (
            <button
              type="button"
              key={action}
              title={LABELS[action]}
              aria-label={`${LABELS[action]}: ${delivery.target.title}`}
              disabled={busy || delivery.postActions?.busy}
              onClick={() => {
                mutation.reset();
                const base = { requestId: createPublicationRequestId(), expectedVersion: version! };
                if (action === 'reschedule_delete') {
                  const at = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
                  const [date = '', time = ''] = formatPublicationScheduleField(at, timezone).split(
                    'T',
                  );
                  setDateFields({ date, time });
                  setDateValid(true);
                  setCommand({ ...base, action, deleteAt: at });
                } else setCommand({ ...base, action });
              }}
            >
              <Icon aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <ActionConfirmSheet
        id={`publication-action-${delivery.id}`}
        open={command !== null}
        title={command ? `${LABELS[command.action]}?` : ''}
        previewTitle={delivery.target.title}
        previewMeta={
          <div className="publication-delivery-actions__form">
            {command?.action === 'reschedule_delete' ? (
              <>
                <select
                  aria-label="Новый срок удаления"
                  value=""
                  disabled={busy}
                  onChange={(event) => {
                    if (event.target.value)
                      chooseTime(
                        new Date(Date.now() + Number(event.target.value) * 60_000).toISOString(),
                      );
                  }}
                >
                  <option value="">Выбрать срок</option>
                  <option value="60">Через час</option>
                  <option value="1440">Через сутки</option>
                  <option value="10080">Через неделю</option>
                </select>
                <PublicationOnceFields
                  {...dateFields}
                  timezone={timezone}
                  disabled={busy}
                  onChange={(date, time, at) => {
                    setDateFields({ date, time });
                    setDateValid(at !== null);
                    if (at)
                      setCommand((current) =>
                        current?.action === 'reschedule_delete'
                          ? { ...current, deleteAt: at }
                          : current,
                      );
                  }}
                />
                <small>{timezone}</small>
                {!dateValid ? <p role="alert">Укажите дату и время.</p> : null}
              </>
            ) : null}
            {mutation.error ? (
              <p role="alert">
                {describeUserFacingError(mutation.error, 'Не удалось изменить действие')}
              </p>
            ) : null}
          </div>
        }
        summary={
          command?.action === 'cancel_delete'
            ? 'Автоудаление и его повторы будут отменены. Уже удалённый пост не восстановится.'
            : command?.action === 'retry_pin'
              ? 'Пост не будет отправлен повторно. При закреплении сохраняется выбранный режим уведомления.'
              : undefined
        }
        confirmLabel={command ? LABELS[command.action] : 'Подтвердить'}
        confirmBusyLabel="Сохраняю..."
        tone={command?.action === 'retry_delete' ? 'danger' : 'accent'}
        isBusy={busy}
        cancelLabel="Назад"
        onClose={() => {
          if (!mutation.isPending) setCommand(null);
        }}
        onConfirm={() => {
          if (command && (command.action !== 'reschedule_delete' || dateValid))
            mutation.mutate(command);
        }}
      />
    </>
  );
}
