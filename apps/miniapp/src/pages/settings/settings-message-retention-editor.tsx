import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshDouble } from 'iconoir-react';
import type { MessageRetentionState, UpdateMessageRetention } from '@maxim/contracts/settings';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { SegmentedControl } from '../../components/ui/segmented-control';
import type { ApiTransport } from '../../lib/api/transport';
import {
  getMessageRetention,
  updateMessageRetention,
} from '../../lib/api/message-retention-client';
import './settings-message-retention.css';
import { messageRetentionStatusLabels as labels } from './settings-message-retention-model';

export function SettingsMessageRetentionEditor({
  api,
  chatId,
  onClose,
  onSnapshot,
}: {
  api: ApiTransport;
  chatId: string;
  onClose: () => void;
  onSnapshot: (state: MessageRetentionState) => void;
}) {
  const [draft, setDraft] = useState<UpdateMessageRetention | null>(null);
  const client = useQueryClient();
  const queryKey = ['message-retention', chatId];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getMessageRetention(api, chatId, signal),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const save = useMutation({
    mutationFn: (input: UpdateMessageRetention) => updateMessageRetention(api, chatId, input),
    onSuccess: (value) => {
      client.setQueryData(queryKey, value);
      setDraft(null);
    },
  });
  const state = query.data;
  useEffect(() => {
    if (state) onSnapshot(state);
  }, [state, onSnapshot]);
  const current =
    draft ??
    (state
      ? { enabled: state.enabled, hours: state.hours, expectedRevision: state.revision }
      : null);
  const dirty = Boolean(
    draft && state && (draft.enabled !== state.enabled || draft.hours !== state.hours),
  );
  const status = state ? labels[state.status] : query.isError ? 'Ошибка' : 'Загрузка';
  const error = save.error ?? query.error;
  const refresh = async () => {
    save.reset();
    setDraft(null);
    await query.refetch();
  };

  return (
    <SettingsDrilldownPanel
      id="settings-message-retention"
      open
      title="Удаление старых сообщений"
      summary={status}
      onClose={() => {
        if (!save.isPending) onClose();
      }}
      confirmCloseWhen={dirty}
      onDiscardChanges={() => setDraft(null)}
      headerAction={
        <button
          type="button"
          className="settings-drilldown__close"
          aria-label="Обновить состояние"
          title="Обновить состояние"
          disabled={save.isPending || dirty}
          onClick={() => void refresh()}
        >
          <RefreshDouble />
        </button>
      }
      footer={
        <button
          type="button"
          className="button button--primary"
          disabled={!dirty || save.isPending || !current}
          onClick={() => {
            if (current) save.mutate(current);
          }}
        >
          {save.isPending ? 'Сохраняем' : 'Сохранить'}
        </button>
      }
    >
      <div className="message-retention-settings">
        {error ? (
          <div role="alert">
            {error instanceof Error ? error.message : 'Не удалось загрузить настройки'}
          </div>
        ) : null}
        {current && state ? (
          <>
            <div className="message-retention-settings__row">
              <span>Удаление по сроку</span>
              <label className="settings-native-switch" aria-label="Удаление по сроку">
                <input
                  type="checkbox"
                  role="switch"
                  checked={current.enabled}
                  disabled={save.isPending || (state.status === 'unavailable' && !current.enabled)}
                  onChange={(event) => setDraft({ ...current, enabled: event.target.checked })}
                />
                <span className="toggle-switch" aria-hidden>
                  <span className="toggle-switch__thumb" />
                </span>
              </label>
            </div>
            <fieldset disabled={save.isPending}>
              <legend>Возраст сообщений</legend>
              <SegmentedControl
                ariaLabel="Возраст сообщений"
                value={current.hours === 24 ? '24' : '48'}
                options={[
                  { value: '24', label: '24 часа', disabled: save.isPending },
                  { value: '48', label: '48 часов', disabled: save.isPending },
                ]}
                onChange={(value) => setDraft({ ...current, hours: value === '24' ? 24 : 48 })}
              />
            </fieldset>
            <dl className="message-retention-settings__facts">
              <div>
                <dt>Исключения</dt>
                <dd>Администраторы, закрепы, боты</dd>
              </div>
              <div>
                <dt>Ожидают</dt>
                <dd>{state.pendingCount.toLocaleString('ru-RU')}</dd>
              </div>
              <div>
                <dt>Удалены или отсутствуют</dt>
                <dd>{state.deletedCount.toLocaleString('ru-RU')}</dd>
              </div>
              <div>
                <dt>Пропущены или отменены</dt>
                <dd>{state.skippedCount.toLocaleString('ru-RU')}</dd>
              </div>
              {state.captureAfter ? (
                <div>
                  <dt>Учёт с</dt>
                  <dd>{new Date(state.captureAfter).toLocaleString('ru-RU')}</dd>
                </div>
              ) : null}
              {state.pausedAt ? (
                <div>
                  <dt>Новые сообщения не учитываются с</dt>
                  <dd>{new Date(state.pausedAt).toLocaleString('ru-RU')}</dd>
                </div>
              ) : null}
            </dl>
          </>
        ) : (
          <p role="status">{query.isError ? 'Настройки недоступны' : 'Загрузка настроек'}</p>
        )}
      </div>
    </SettingsDrilldownPanel>
  );
}
