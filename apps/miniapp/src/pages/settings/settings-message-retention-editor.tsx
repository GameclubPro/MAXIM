import { lazy, Suspense, useEffect, useReducer, useState } from 'react';
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
  parseBotPermissionBlocker,
  type BotPermissionBlocker,
} from '../../lib/bot-permission-error';
import {
  isRetentionRevisionConflict,
  isRetentionWriteUncertain,
  retentionCount,
  retentionDate,
  retentionDraftReducer,
  retentionEditorState,
} from './settings-message-retention-editor-state';
import './settings-message-retention.css';

const PermissionDialog = lazy(() =>
  import('../../components/bot-permission-required-dialog').then((module) => ({
    default: module.BotPermissionRequiredDialog,
  })),
);

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
  onSnapshot: (state: MessageRetentionState, receivedAt: number) => void;
};

export function SettingsMessageRetentionEditor({
  api,
  chatId,
  onClose,
  onSnapshot,
}: SettingsMessageRetentionEditorProps) {
  const [editor, dispatch] = useReducer(retentionDraftReducer, { chatId, draft: null });
  const draft = editor.chatId === chatId ? editor.draft : null;
  const [permissionBlocker, setPermissionBlocker] = useState<BotPermissionBlocker | null>(null);
  const [uncertainWrite, setUncertainWrite] = useState(false);
  const [recoveredSave, setRecoveredSave] = useState(false);
  const client = useQueryClient();
  const queryKey = ['message-retention', chatId];
  const save = useMutation({
    mutationFn: async (input: UpdateMessageRetention): Promise<MessageRetentionState> => {
      try {
        return await updateMessageRetention(api, chatId, input);
      } catch (error) {
        if (isRetentionWriteUncertain(error)) {
          // FLAG: A lost PUT reply can conceal a committed destructive policy. Read authority
          // before offering another write or a discard; an unconfirmed read keeps closing blocked.
          setUncertainWrite(true);
          const latest = await query.refetch();
          if (!latest.isError && latest.data) {
            setUncertainWrite(false);
            if (latest.data.enabled === input.enabled && latest.data.hours === input.hours)
              return latest.data;
          }
        }
        throw error;
      }
    },
    onMutate: () => {
      setRecoveredSave(false);
      return client.cancelQueries({ queryKey, exact: true });
    },
    onSuccess: async (value) => {
      await client.cancelQueries({ queryKey, exact: true });
      client.setQueryData<MessageRetentionState>(queryKey, (old) =>
        old && old.revision > value.revision ? old : value,
      );
      dispatch({ type: 'discard', chatId });
      setPermissionBlocker(null);
      setUncertainWrite(false);
    },
    onError: (error) => {
      setPermissionBlocker(parseBotPermissionBlocker(error));
      if (isRetentionRevisionConflict(error))
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
    if (state) onSnapshot(state, query.dataUpdatedAt);
  }, [state, onSnapshot, query.dataUpdatedAt]);
  useEffect(() => {
    dispatch({ type: 'snapshot', chatId, state });
  }, [chatId, state]);
  const { current, dirty, conflict } = retentionEditorState(state, draft);
  const saveConflict = isRetentionRevisionConflict(save.error);
  const writeError = saveConflict || recoveredSave ? null : save.error;
  const closeBlocked = save.isPending || uncertainWrite;
  const showConflict = conflict || saveConflict;
  const change = (patch: Partial<Pick<UpdateMessageRetention, 'enabled' | 'hours'>>) => {
    if (!current || closeBlocked) return;
    save.reset();
    setRecoveredSave(false);
    setPermissionBlocker(null);
    dispatch({ type: 'edit', chatId, draft: { ...current, ...patch } });
  };
  const discard = () => {
    if (closeBlocked) return;
    dispatch({ type: 'discard', chatId });
    save.reset();
    setRecoveredSave(false);
    setPermissionBlocker(null);
  };
  const refresh = async () => {
    if (save.isPending) return;
    const latest = await query.refetch();
    if (!latest.isError && latest.data) {
      if (
        uncertainWrite &&
        save.variables &&
        latest.data.enabled === save.variables.enabled &&
        latest.data.hours === save.variables.hours
      ) {
        setRecoveredSave(true);
        save.reset();
      }
      setUncertainWrite(false);
    }
  };
  const commit = async () => {
    if (!current || showConflict || query.isError || closeBlocked) return false;
    try {
      await save.mutateAsync(current);
      return true;
    } catch {
      return false;
    }
  };
  // FLAG: Navigation must stay blocked until a write settles, even if a cache update
  // already matches the draft while its response is still being reconciled.
  useManagedEntityLeaveGuard({
    dirty: dirty || closeBlocked,
    saving: closeBlocked,
    save: commit,
    discard,
  });
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
        if (!closeBlocked) onClose();
      }}
      closeDisabled={closeBlocked}
      confirmCloseWhen={dirty}
      onDiscardChanges={discard}
      headerAction={
        <button
          type="button"
          className="settings-drilldown__close"
          aria-label="Обновить состояние"
          title="Обновить состояние"
          disabled={save.isPending || query.isFetching}
          onClick={() => void refresh()}
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
                : save.isSuccess || recoveredSave
                  ? 'Сохранено'
                  : ''}
          </span>
          <button
            type="button"
            className="button button--accent"
            disabled={!dirty || closeBlocked || !current || showConflict || query.isError}
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
        {query.error ? (
          <div className="message-retention-feedback" role="alert">
            <strong>
              {state ? 'Не удалось обновить данные' : 'Не удалось загрузить настройки'}
            </strong>
            <p>{query.error instanceof Error ? query.error.message : 'Ошибка соединения'}</p>
            <button
              type="button"
              className="button button--ghost"
              disabled={query.isFetching || save.isPending}
              onClick={() => void refresh()}
            >
              <RefreshDouble aria-hidden /> Повторить
            </button>
          </div>
        ) : null}
        {writeError ? (
          <div className="message-retention-feedback" role="alert">
            <strong>
              {uncertainWrite
                ? 'Сохранение пока не подтверждено'
                : 'Не удалось сохранить изменения'}
            </strong>
            <p>{writeError instanceof Error ? writeError.message : 'Ошибка соединения'}</p>
            {uncertainWrite ? (
              <p>Проверим настройки на сервере перед повтором или закрытием.</p>
            ) : null}
            <button
              type="button"
              className="button button--ghost"
              disabled={
                save.isPending ||
                query.isFetching ||
                (!uncertainWrite && (showConflict || query.isError))
              }
              onClick={() => void (uncertainWrite ? refresh() : commit())}
            >
              <RefreshDouble aria-hidden />{' '}
              {uncertainWrite ? 'Проверить сохранение' : 'Повторить сохранение'}
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
                disabled={closeBlocked}
                onClick={discard}
              >
                <RefreshDouble aria-hidden /> Принять настройки
              </button>
              <button
                type="button"
                className="button button--ghost"
                disabled={closeBlocked || query.isError || !current}
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
                  disabled={closeBlocked || (state.status === 'unavailable' && !current.enabled)}
                  onChange={(event) => change({ enabled: event.target.checked })}
                />
                <span className="toggle-switch" aria-hidden>
                  <span className="toggle-switch__thumb" />
                </span>
              </label>
            </div>
            <p className="message-retention-policy">
              Удаляем только новые сообщения, полученные после включения. Старую историю не очищаем.
              После повторного включения учёт начинается заново. Удалённые сообщения восстановить
              нельзя.
            </p>
            <fieldset disabled={closeBlocked}>
              <legend>Возраст сообщений</legend>
              <SegmentedControl
                ariaLabel="Возраст сообщений"
                value={current.hours === 24 ? '24' : '48'}
                options={[
                  { value: '24', label: '24 часа', disabled: closeBlocked },
                  { value: '48', label: '48 часов', disabled: closeBlocked },
                ]}
                onChange={(value) => change({ hours: value === '24' ? 24 : 48 })}
              />
            </fieldset>
            {state.enabled && current.enabled && state.hours !== current.hours ? (
              <p className="message-retention-policy" role="status">
                Новый срок применяется и к уже учтённым сообщениям.
                {current.hours < state.hours
                  ? ' Сообщения старше 24 часов смогут удаляться сразу после сохранения.'
                  : ' Ещё не удалённые сообщения будут ожидать 48 часов.'}
              </p>
            ) : null}
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
      {permissionBlocker ? (
        <Suspense fallback={null}>
          <PermissionDialog
            id="message-retention-permission"
            blocker={permissionBlocker}
            isRechecking={save.isPending}
            onClose={() => {
              if (!save.isPending) setPermissionBlocker(null);
            }}
            onRecheck={() => void commit()}
          />
        </Suspense>
      ) : null}
    </SettingsDrilldownPanel>
  );
}
