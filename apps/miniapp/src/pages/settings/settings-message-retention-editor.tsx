import { AppIcon as IconoirSprite } from '../../components/ui/app-icon';
import { lazy, Suspense, useEffect, useReducer, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { MessageRetentionState, UpdateMessageRetention } from '@maxim/contracts/settings';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import {
  SharedMessageRetentionFields,
  SharedMessageRetentionExclusions,
} from './shared-message-retention-fields';
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
  isRetentionOperationConfirmed,
  isRetentionRevisionConflict,
  isRetentionWriteUncertain,
  retentionCount,
  retentionDate,
  retentionDraftReducer,
  retentionEditorState,
  retentionErrorMessage,
} from './settings-message-retention-editor-state';
import './settings-message-retention.css';

const PermissionDialog = lazy(() =>
  import('../../components/bot-permission-required-dialog').then((module) => ({
    default: module.BotPermissionRequiredDialog,
  })),
);

const labels: Record<MessageRetentionState['status'], string> = {
  off: 'Выключено',
  unavailable: 'Временно недоступно',
  shadow: 'Готовится к запуску',
  running: 'Работает',
  delayed: 'Удаление отложено',
  paused: 'Пауза',
  capacity_paused: 'Очистка приостановлена',
  no_access: 'Нужны права администратора',
  error: 'Не удалось продолжить очистку',
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
          // FLAG: An old GET cannot rule out a PUT still committing. Keep navigation and edits
          // blocked until this operation is confirmed; recovery reuses its exact request and ID.
          setUncertainWrite(true);
          const latest = await query.refetch();
          if (!latest.isError && latest.data && isRetentionOperationConfirmed(latest.data, input))
            return latest.data;
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
    onError: async (error, input) => {
      setPermissionBlocker(parseBotPermissionBlocker(error));
      if (isRetentionRevisionConflict(error)) {
        const latest = await query.refetch();
        // FLAG: A typed CAS rejection plus a newer authoritative revision fences the original
        // request. Other conflicts or an unreadable/older policy cannot settle its outcome.
        if (
          input.operationId &&
          !latest.isError &&
          latest.data &&
          latest.data.revision > input.expectedRevision
        )
          setUncertainWrite(false);
      }
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
  const writeError = (saveConflict && !uncertainWrite) || recoveredSave ? null : save.error;
  const closeBlocked = save.isPending || uncertainWrite;
  const showConflict = conflict || saveConflict;
  const change = (patch: Partial<Pick<UpdateMessageRetention, 'enabled' | 'hours'>>) => {
    if (!current || closeBlocked) return;
    save.reset();
    setRecoveredSave(false);
    setPermissionBlocker(null);
    dispatch({
      type: 'edit',
      chatId,
      draft: { ...current, ...patch, operationId: crypto.randomUUID() },
    });
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
    if (
      !latest.isError &&
      latest.data &&
      uncertainWrite &&
      save.variables &&
      isRetentionOperationConfirmed(latest.data, save.variables)
    ) {
      setRecoveredSave(true);
      save.reset();
      setUncertainWrite(false);
      return true;
    }
    return false;
  };
  const recover = async () => {
    if (save.isPending || !uncertainWrite || !save.variables?.operationId) return;
    const input = save.variables;
    if (await refresh()) return;
    try {
      await save.mutateAsync(input);
    } catch {
      // Keep the original operation available until an authoritative response confirms it.
    }
  };
  const commit = async () => {
    if (!current || showConflict || query.isError || closeBlocked) return false;
    try {
      await save.mutateAsync({
        ...current,
        operationId: current.operationId ?? crypto.randomUUID(),
      });
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
      icon={<IconoirSprite variant="iconoir" icon="Clock" />}
      open
      title="Удаление старых сообщений"
      className="message-retention-panel"
      onClose={() => {
        if (!closeBlocked) onClose();
      }}
      closeDisabled={closeBlocked}
      confirmCloseWhen={dirty}
      onDiscardChanges={discard}
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
          <button
            type="button"
            className="settings-drilldown__close"
            aria-label="Обновить состояние"
            title="Обновить состояние"
            disabled={save.isPending || query.isFetching}
            onClick={() => void refresh()}
          >
            <IconoirSprite
              variant="iconoir"
              icon="RefreshDouble"
              className={query.isFetching ? 'retention-refreshing' : undefined}
            />
          </button>
        </div>
        {query.error ? (
          <div className="message-retention-feedback" role="alert">
            <strong>
              {state ? 'Не удалось обновить данные' : 'Не удалось загрузить настройки'}
            </strong>
            <p>{retentionErrorMessage(query.error)}</p>
            <button
              type="button"
              className="button button--ghost"
              disabled={query.isFetching || save.isPending}
              onClick={() => void refresh()}
            >
              <IconoirSprite variant="iconoir" icon="RefreshDouble" aria-hidden /> Повторить
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
            <p>{retentionErrorMessage(writeError)}</p>
            {uncertainWrite ? <p>Проверьте, сохранились ли настройки, перед закрытием.</p> : null}
            <button
              type="button"
              className="button button--ghost"
              disabled={
                save.isPending ||
                query.isFetching ||
                (!uncertainWrite && (showConflict || query.isError))
              }
              onClick={() => void (uncertainWrite ? recover() : commit())}
            >
              <IconoirSprite variant="iconoir" icon="RefreshDouble" aria-hidden />{' '}
              {uncertainWrite ? 'Проверить сохранение' : 'Повторить сохранение'}
            </button>
          </div>
        ) : null}
        {showConflict && state ? (
          <div className="message-retention-feedback" role="alert">
            <strong>Настройки уже изменились</strong>
            <p>
              Сейчас:{' '}
              {state.enabled
                ? `удаление старше ${state.hours === 168 ? '1 недели' : `${state.hours} часов`}`
                : 'очистка выключена'}
              .
            </p>
            <div className="message-retention-feedback__actions">
              <button
                type="button"
                className="button button--ghost"
                disabled={closeBlocked}
                onClick={discard}
              >
                <IconoirSprite variant="iconoir" icon="RefreshDouble" aria-hidden /> Загрузить
                сохранённые
              </button>
              <button
                type="button"
                className="button button--ghost"
                disabled={closeBlocked || query.isError || !current}
                onClick={() => {
                  if (current)
                    save.mutate({
                      ...current,
                      expectedRevision: state.revision,
                      operationId: crypto.randomUUID(),
                    });
                }}
              >
                <IconoirSprite variant="iconoir" icon="Check" aria-hidden /> Сохранить мой вариант
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
            <SharedMessageRetentionFields
              enabled={{ kind: 'common', value: current.enabled }}
              hours={{ kind: 'common', value: current.hours }}
              disabled={closeBlocked}
              enableDisabled={state.status === 'unavailable' && !current.enabled}
              connectionStatus={state.connectionStatus}
              onReconnect={
                state.enabled &&
                current.enabled &&
                !dirty &&
                !showConflict &&
                !query.isError &&
                ['missing', 'no_access'].includes(state.connectionStatus ?? '')
                  ? () => {
                      if (!closeBlocked)
                        save.mutate({ ...current, operationId: crypto.randomUUID() });
                    }
                  : undefined
              }
              onEnabledChange={(enabled) => change({ enabled })}
              onHoursChange={(hours) => change({ hours })}
            />
            {state.enabled && current.enabled && state.hours !== current.hours ? (
              <p className="message-retention-policy" role="status">
                Новый срок применяется ко всей доступной истории. Сообщения младше
                {current.hours === 168 ? ' 1 недели' : ` ${current.hours} часов`} удаляться не
                будут.
              </p>
            ) : null}
            <SharedMessageRetentionExclusions />
            {state.historyStatus && state.historyStatus !== 'off' ? (
              <dl className="message-retention-settings__facts">
                <div>
                  <dt>История чата</dt>
                  <dd>
                    {
                      {
                        pending: 'Ожидает очистки',
                        running: 'Очищается',
                        complete: 'Проверена',
                        blocked: 'Часть истории отложена',
                      }[state.historyStatus]
                    }
                  </dd>
                </div>
              </dl>
            ) : null}
            {state.enabled ||
            state.pendingCount + state.deletedCount + state.skippedCount > 0 ||
            state.enabledAt ||
            state.pausedAt ||
            (state.historyScannedCount ?? 0) > 0 ? (
              <details className="message-retention-progress">
                <summary>Подробности очистки</summary>
                <dl className="message-retention-stats">
                  {[
                    { label: 'Ожидают', value: state.pendingCount },
                    { label: 'Больше нет в чате', value: state.deletedCount },
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
                  {state.historyScannedCount !== undefined &&
                  (state.enabled || state.historyScannedCount > 0) ? (
                    <div>
                      <dt>Проверено сообщений</dt>
                      <dd>{retentionCount(state.historyScannedCount)}</dd>
                    </div>
                  ) : null}
                  {state.enabledAt ? (
                    <div>
                      <dt>Включено</dt>
                      <dd>
                        <time dateTime={state.enabledAt}>{retentionDate(state.enabledAt)}</time>
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
                      <dt>Очистка на паузе с</dt>
                      <dd>
                        <time dateTime={state.pausedAt}>{retentionDate(state.pausedAt)}</time>
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </details>
            ) : null}
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
