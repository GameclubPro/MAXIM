import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Refresh } from 'iconoir-react';
import {
  duplicateDiagnosticsResponseSchema,
  type DuplicateDeletionAttempt,
  type DuplicateObservationOutcome,
} from '@maxim/contracts/settings';
import type { ApiTransport } from '../../lib/api/transport';

export const DUPLICATE_ATTEMPT_LABELS: Record<DuplicateDeletionAttempt['outcome'], string> = {
  DELETED: 'Удалено',
  ALREADY_ABSENT: 'Сообщение уже отсутствует',
  PENDING: 'Ожидает удаления',
  RETRYING: 'Ожидает повторной попытки',
  WAITING_ACCESS: 'Ожидает доступа к удалению',
  UNCONFIRMED: 'Удаление не подтверждено',
  EXPIRED: 'Срок удаления истёк',
  CANCELLED: 'Удаление отменено',
  OBSERVED: 'Наблюдение без удаления',
};
const REASON_LABELS: Record<NonNullable<DuplicateDeletionAttempt['reason']>, string> = {
  IMMUNITY: 'Иммунитет участника',
  AUTHOR_LEFT: 'Автор вышел из чата',
  CONTENT_CHANGED: 'Совпадение больше не подтверждается',
  POLICY_CHANGED: 'Условия проверки изменились',
  UNKNOWN: 'Причина не подтверждена',
};
const OBSERVATION_LABELS: Record<DuplicateObservationOutcome, string> = {
  OFF: 'Проверка остановлена',
  SCHEDULE_CLOSED: 'Вне расписания',
  EVENT_TIME_REJECTED: 'Время сообщения не подтверждено',
  UNTRACKED: 'Сообщение исключено из проверки',
  CONTENT_UNVERIFIED: 'Содержимое не подтверждено',
  UNSUPPORTED_CONTENT: 'Неподдерживаемое содержимое',
  MEDIA_QUEUED: 'Медиа передано на проверку',
  MEDIA_CANDIDATE: 'Первое медиа ожидает сравнения',
  SOURCE_UNAVAILABLE: 'Исходное сообщение недоступно',
  POLICY_CHANGED: 'Режим проверки изменился',
  SETTINGS_CHANGED: 'Настройки или доступ изменились',
  STALE: 'Версия сообщения устарела',
  DEADLINE_EXPIRED: 'Срок проверки истёк',
  DEFERRED: 'Проверка отложена',
  COMPARISON_FAILED: 'Сравнение не завершилось',
  UNAVAILABLE: 'Проверку не удалось начать',
  COMPARED_NO_MATCH: 'Сравнено: повтора сверх допуска нет',
  MATCHED_INELIGIBLE: 'Совпадение без права действия',
  MATCHED_OBSERVE: 'Совпадение в режиме наблюдения',
  MATCHED_ACTION_FAILED: 'Совпадение: передача действия не завершилась',
  ENFORCEMENT_REQUESTED: 'Совпадение передано на проверку действия',
};
function formatTime(value: string) {
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function SettingsDuplicateDiagnostics({
  api,
  chatId,
  userId,
}: {
  api: ApiTransport;
  chatId: string;
  userId: string | null;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['duplicate-diagnostics', userId, chatId];
  const path = `/chats/${encodeURIComponent(chatId)}/duplicate-diagnostics`;
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) =>
      duplicateDiagnosticsResponseSchema.parse(await api.request(path, { signal })),
    enabled: Boolean(userId),
    staleTime: 30_000,
    // FLAG: Reopening after save must refresh the saved state even while the old cache is fresh.
    refetchOnMount: 'always',
    retry: false,
    refetchOnWindowFocus: false,
  });
  const recheck = useMutation({
    mutationFn: async () =>
      duplicateDiagnosticsResponseSchema.parse(
        await api.request(`${path}/recheck`, { method: 'POST' }),
      ),
    onSuccess: (data) => queryClient.setQueryData(queryKey, data),
  });
  const busy = query.isFetching || recheck.isPending;
  const failed = query.isError || recheck.isError;
  const data = query.data;
  const capability = failed ? 'UNKNOWN' : data?.capability.state;
  const capabilityLabel = busy
    ? 'Проверяем права'
    : capability === 'CONFIRMED'
      ? 'Права удаления подтверждены'
      : capability === 'MISSING'
        ? 'Нет прав удаления'
        : 'Права удаления не подтверждены';
  return (
    <section className="duplicate-diagnostics" aria-label="Состояние бота">
      <div className="duplicate-diagnostics__heading">
        <div>
          <h3 className="duplicate-stage__title">Состояние бота</h3>
          <p
            className="duplicate-diagnostics__status"
            data-state={busy ? 'UNKNOWN' : (capability ?? 'UNKNOWN')}
            role="status"
          >
            {capabilityLabel}
          </p>
        </div>
        <button
          type="button"
          className="button button--ghost duplicate-diagnostics__refresh"
          aria-label="Проверить права"
          title="Проверить права"
          disabled={busy || !userId}
          onClick={() => recheck.mutate()}
        >
          <Refresh aria-hidden />
        </button>
      </div>
      {failed && (
        <p className="field__hint" role="alert">
          Не удалось обновить проверку
        </p>
      )}
      {data && (
        <details className="duplicate-diagnostics__history">
          <summary>Проверка и история</summary>
          <dl className="duplicate-diagnostics__facts">
            <div>
              <dt>Сохранённая настройка</dt>
              <dd>{data.enabled ? 'Включён' : 'Выключен'}</dd>
            </div>
            <div>
              <dt>Режим</dt>
              <dd>
                {data.mode === 'FULL'
                  ? 'Действия по настройкам'
                  : data.mode === 'DELETE_ONLY'
                    ? 'Расширенная проверка: только удаление'
                    : data.mode === 'OFF'
                      ? 'Проверка остановлена'
                      : data.mode === 'OBSERVE'
                        ? 'Наблюдение без удаления'
                        : data.mode === 'LEGACY_TEXT'
                          ? 'Основная проверка текста'
                          : 'Не подтверждён'}
              </dd>
            </div>
            <div>
              <dt>Права проверены</dt>
              <dd>
                {data.capability.checkedAt ? formatTime(data.capability.checkedAt) : 'Нет данных'}
              </dd>
            </div>
          </dl>
          <h4 className="duplicate-stage__title">Проверка сообщений</h4>
          {!data.observation || data.observation.state === 'UNAVAILABLE' ? (
            <p role="status">Статистика проверок временно недоступна</p>
          ) : data.observation.state === 'NO_DATA' ? (
            <p role="status">Данные о проверках ещё не поступили</p>
          ) : (
            <>
              <p className="field__hint">
                Неполная статистика попыток с {formatTime(data.observation.since)}. Повторные
                попытки учитываются отдельно; обновление может запаздывать.
              </p>
              <p>
                {data.observation.coverage === null
                  ? 'Нет данных для оценки полноты сравнения'
                  : `Сравнение завершено: ${data.observation.verifiedAttempts} из ${data.observation.supportedAttempts} поддерживаемых попыток (${Math.round(data.observation.coverage * 100)}%)`}
              </p>
              <dl className="duplicate-diagnostics__facts">
                {data.observation.outcomes.map(({ outcome, count }) => (
                  <div key={outcome}>
                    <dt>{OBSERVATION_LABELS[outcome]}</dt>
                    <dd>{count}</dd>
                  </div>
                ))}
              </dl>
              <p className="field__hint">Результат сравнения не подтверждает удаление сообщения.</p>
            </>
          )}
          <h4 className="duplicate-stage__title">Последние попытки удаления</h4>
          <div className="duplicate-diagnostics__history-meta">
            <span>За 24 часа</span>
            <time dateTime={data.generatedAt}>{formatTime(data.generatedAt)}</time>
          </div>
          {!data.history.available ? (
            <p role="status">История временно недоступна</p>
          ) : (
            <>
              {data.history.limited && <p className="field__hint">Неполная выборка</p>}
              {data.history.attempts.length === 0 ? (
                <p>
                  {data.history.limited
                    ? 'В выборке нет попыток антидубля'
                    : 'Попыток удаления не было'}
                </p>
              ) : (
                <ol className="duplicate-diagnostics__attempts">
                  {data.history.attempts.map((attempt) => (
                    <li key={attempt.id}>
                      <time dateTime={attempt.createdAt}>{formatTime(attempt.createdAt)}</time>
                      <div>
                        <strong>{DUPLICATE_ATTEMPT_LABELS[attempt.outcome]}</strong>
                        {attempt.reason && <span>{REASON_LABELS[attempt.reason]}</span>}
                        {attempt.original && (
                          <>
                            <span>Оригинал: {formatTime(attempt.original.publishedAt)}</span>
                            <span>
                              Повтор разрешён с {formatTime(attempt.original.repeatAllowedAt)}
                            </span>
                            <span>Номер оригинала: {attempt.original.messageId}</span>
                          </>
                        )}
                        {attempt.nextAttemptAt && (
                          <span>Следующая попытка: {formatTime(attempt.nextAttemptAt)}</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </details>
      )}
    </section>
  );
}
