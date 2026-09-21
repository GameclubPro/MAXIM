import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, RefreshDouble, ShieldCheck } from 'iconoir-react';
import type { MessageRetentionState, UpdateMessageRetention } from '@maxim/contracts/settings';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { SegmentedControl } from '../../components/ui/segmented-control';
import type { ApiTransport } from '../../lib/api/transport';
import {
  getMessageRetention,
  updateMessageRetention,
} from '../../lib/api/message-retention-client';
import { ApiRequestError } from '../../lib/api-request-error';
import { useManagedEntityLeaveGuard } from '../../lib/managed-entity-navigation';
import {
  retentionCount,
  retentionDate,
  retentionEditorState,
} from './settings-message-retention-editor-state';
import './settings-message-retention.css';

const labels: Record<MessageRetentionState['status'], string> = {
  off: 'Выключено',
  unavailable: 'Отключено оператором',
  shadow: 'Проверка без удаления',
  running: 'Работает',
  delayed: 'С задержкой',
  paused: 'Пауза',
  capacity_paused: 'Учёт приостановлен',
  no_access: 'Нет прав',
  error: 'Ошибка',
};

export type SettingsMessageRetentionEditorProps = {
  api: ApiTransport;
  chatId: string;
  onClose: () => void;
  onSnapshot: (state: MessageRetentionState) => void;
};

export function SettingsMessageRetentionEditor({
  api,
  chatId,
  onClose,
  onSnapshot,
}: SettingsMessageRetentionEditorProps) {
  const [draft, setDraft] = useState<UpdateMessageRetention | null>(null);
  const client = useQueryClient();
  const queryKey = ['message-retention', chatId];
  const save = useMutation({
    mutationFn: (input: UpdateMessageRetention) => updateMessageRetention(api, chatId, input),
    onMutate: () => client.cancelQueries({ queryKey, exact: true }),
    onSuccess: async (value) => {
      await client.cancelQueries({ queryKey, exact: true });
      client.setQueryData<MessageRetentionState>(queryKey, (old) =>
        old && old.revision > value.revision ? old : value,
      );
      setDraft(null);
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.status === 409)
        void client.invalidateQueries({ queryKey, exact: true });
    },
  });
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getMessageRetention(api, chatId, signal),
    staleTime: 15_000,
    retry: false,
    refetchInterval: save.isPending ? false : 30_000,
  });
  const state = query.data;
  useEffect(() => {
    if (state) onSnapshot(state);
  }, [state, onSnapshot]);
  const { current, dirty, conflict } = retentionEditorState(state, draft);
  const saveConflict = save.error instanceof ApiRequestError && save.error.status === 409;
  const error = saveConflict ? null : (save.error ?? query.error);
  const showConflict = conflict || saveConflict;
  const change = (patch: Partial<Pick<UpdateMessageRetention, 'enabled' | 'hours'>>) => {
    if (!current) return;
    save.reset();
    setDraft({ ...current, ...patch });
  };
  const discard = () => {
    setDraft(null);
    save.reset();
  };
  const refresh = () => {
    save.reset();
    void query.refetch();
  };
  const commit = async () => {
    if (!current || showConflict || query.isError) return false;
    try {
      await save.mutateAsync(current);
      return true;
    } catch {
      return false;
    }
  };
  useManagedEntityLeaveGuard({ dirty, saving: save.isPending, save: commit, discard });
  const readStatus = query.error instanceof ApiRequestError ? query.error.status : null;
  const status = query.isError
    ? readStatus === 401
      ? 'Сессия истекла'
      : readStatus === 403
        ? 'Нет доступа'
        : 'Нет соединения'
    : state
      ? labels[state.status]
      : 'Загрузка';
  const statusTone = query.isError ? 'error' : (state?.status ?? 'loading');

  return (
    <SettingsDrilldownPanel
      id="settings-message-retention"
      open
      title="Удаление старых сообщений"
      className="message-retention-panel"
      onClose={() => {
        if (!save.isPending) onClose();
      }}
      confirmCloseWhen={dirty}
      onDiscardChanges={discard}
      headerAction={
        <button
          type="button"
          className="settings-drilldown__close"
          aria-label="Обновить состояние"
          title="Обновить состояние"
          disabled={save.isPending || query.isFetching}
          onClick={refresh}
        >
          <RefreshDouble className={query.isFetching ? 'retention-refreshing' : undefined} />
        </button>
      }
      footer={
        <div className="message-retention-footer">
          <span aria-live="polite">
            {save.isPending
              ? 'Сохранение'
              : dirty
                ? 'Есть изменения'
                : save.isSuccess
                  ? 'Сохранено'
                  : ''}
          </span>
          <button
            type="button"
            className="button button--accent"
            disabled={!dirty || save.isPending || !current || showConflict || query.isError}
            onClick={() => void commit()}
          >
            {save.isPending ? 'Сохраняем' : 'Сохранить'}
          </button>
        </div>
      }
    >
      <div className="message-retention-settings">
        <div
          className="message-retention-status"
          data-status={statusTone}
          role="status"
          aria-live="polite"
        >
          <span className="message-retention-status__dot" aria-hidden />
          <span>{status}</span>
          {state && !query.isError ? (
            <time
              dateTime={new Date(query.dataUpdatedAt).toISOString()}
              title="Последнее обновление"
            >
              {new Date(query.dataUpdatedAt).toLocaleTimeString('ru-RU', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>
          ) : null}
        </div>
        {error ? (
          <div className="message-retention-feedback" role="alert">
            <strong>
              {state ? 'Не удалось обновить данные' : 'Не удалось загрузить настройки'}
            </strong>
            <p>{error instanceof Error ? error.message : 'Ошибка соединения'}</p>
            <button
              type="button"
              className="button button--ghost"
              disabled={query.isFetching || save.isPending}
              onClick={refresh}
            >
              <RefreshDouble aria-hidden /> Повторить
            </button>
          </div>
        ) : null}
        {showConflict && state ? (
          <div className="message-retention-feedback" role="alert">
            <strong>Настройки изменены в другом сеансе</strong>
            <p>На сервере: {state.enabled ? `старше ${state.hours} ч` : 'выключено'}.</p>
            <div className="message-retention-feedback__actions">
              <button
                type="button"
                className="button button--ghost"
                disabled={save.isPending}
                onClick={discard}
              >
                <RefreshDouble aria-hidden /> Принять настройки
              </button>
              <button
                type="button"
                className="button button--ghost"
                disabled={save.isPending || query.isError || !current}
                onClick={() => {
                  if (current) save.mutate({ ...current, expectedRevision: state.revision });
                }}
              >
                <Check aria-hidden /> Сохранить мой вариант
              </button>
            </div>
          </div>
        ) : null}
        {!state && query.isPending ? (
          <div
            className="message-retention-skeleton"
            aria-label="Загрузка настроек"
            aria-busy="true"
          >
            <span />
            <span />
            <span />
          </div>
        ) : null}
        {current && state ? (
          <>
            <div className="message-retention-settings__row">
              <label htmlFor="message-retention-enabled">Удаление по сроку</label>
              <label className="settings-native-switch">
                <input
                  id="message-retention-enabled"
                  type="checkbox"
                  role="switch"
                  checked={current.enabled}
                  disabled={save.isPending || (state.status === 'unavailable' && !current.enabled)}
                  onChange={(event) => change({ enabled: event.target.checked })}
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
                onChange={(value) => change({ hours: value === '24' ? 24 : 48 })}
              />
            </fieldset>
            <div className="message-retention-exclusions">
              <ShieldCheck aria-hidden />
              <div>
                <span>Исключения</span>
                <p>Администраторы, закрепы, боты</p>
              </div>
            </div>
            <dl className="message-retention-stats">
              {[
                { label: 'Ожидают', value: state.pendingCount },
                { label: 'Удалены / нет в чате', value: state.deletedCount },
                { label: 'Пропущены', value: state.skippedCount },
              ].map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd
                    title={item.value.toLocaleString('ru-RU')}
                    aria-label={item.value.toLocaleString('ru-RU')}
                  >
                    {retentionCount(item.value)}
                  </dd>
                </div>
              ))}
            </dl>
            <dl className="message-retention-settings__facts">
              {state.captureAfter ? (
                <div>
                  <dt>Учёт с</dt>
                  <dd>
                    <time dateTime={state.captureAfter}>{retentionDate(state.captureAfter)}</time>
                  </dd>
                </div>
              ) : null}
              {state.oldestDueAt &&
              state.pendingCount > 0 &&
              new Date(state.oldestDueAt).getTime() < Date.now() ? (
                <div>
                  <dt>Ожидают удаления с</dt>
                  <dd>
                    <time dateTime={state.oldestDueAt}>{retentionDate(state.oldestDueAt)}</time>
                  </dd>
                </div>
              ) : null}
              {state.pausedAt ? (
                <div>
                  <dt>Пауза учёта с</dt>
                  <dd>
                    <time dateTime={state.pausedAt}>{retentionDate(state.pausedAt)}</time>
                  </dd>
                </div>
              ) : null}
            </dl>
          </>
        ) : null}
      </div>
    </SettingsDrilldownPanel>
  );
}
