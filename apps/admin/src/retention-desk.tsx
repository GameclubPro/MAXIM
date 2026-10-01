import type { SafetyDeskRetentionRuntimeItem } from '@maxim/contracts/safety-desk';
import { useRetentionDesk, type RetentionDeskProps } from './retention-desk-state';
import { buildRetentionRetryRequest, formatDateTime } from './safety-desk-model';

const statusLabels: Record<SafetyDeskRetentionRuntimeItem['status'], string> = {
  off: 'Выключено',
  unavailable: 'Недоступно',
  shadow: 'Наблюдение',
  running: 'Работает',
  delayed: 'Задержка',
  paused: 'Приостановлено',
  capacity_paused: 'Лимит очереди',
  no_access: 'Нет прав',
  error: 'Ошибка',
};

export function RetentionDesk(props: RetentionDeskProps) {
  const {
    runtime,
    selected,
    preview,
    trail,
    loading,
    previewLoading,
    busyMessageId,
    pageError,
    previewNotice,
    retryPage,
    loadPreview,
    retry,
    nextPage,
    previousPage,
  } = useRetentionDesk(props);
  return (
    <section className="retention-desk" aria-label="Очистка старых сообщений">
      <section className="retention-runtime queue-panel">
        <header className="retention-toolbar">
          <div>
            <h2>Очистка по сроку</h2>
            <p>Новые сообщения после включения. История чата не загружается.</p>
          </div>
          <span className="risk-badge is-neutral">
            {runtime ? `Режим: ${runtime.mode}` : 'Загрузка'}
          </span>
        </header>
        <div className="retention-runtime-scroll">
          {pageError && (
            <div className="retention-alert" role="alert">
              <span>{pageError}</span>
              <button className="ghost-action" disabled={loading} onClick={() => void retryPage()}>
                Повторить загрузку
              </button>
            </div>
          )}
          {loading ? (
            <p className="queue-empty" role="status">
              Загружаю чаты…
            </p>
          ) : (
            runtime &&
            !pageError && (
              <>
                <div className="retention-quotas" aria-label="Лимиты очереди">
                  {runtime.quotas.map((quota) => (
                    <span
                      key={quota.shard}
                      className={quota.pendingCount >= quota.cap ? 'is-full' : ''}
                    >
                      Сегмент {quota.shard}: {quota.pendingCount} / {quota.cap}
                    </span>
                  ))}
                </div>
                {!runtime.items.length ? (
                  <p className="queue-empty">Чатов с настройкой очистки пока нет.</p>
                ) : (
                  <div className="retention-table-scroll">
                    <table className="retention-table">
                      <thead>
                        <tr>
                          <th>Чат / срок</th>
                          <th>Состояние</th>
                          <th>В очереди</th>
                          <th>Удалено / пропущено</th>
                          <th>Следующий запуск</th>
                          <th>Диагностика</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runtime.items.map((item) => (
                          <tr
                            key={item.chatId}
                            className={selected?.chatId === item.chatId ? 'is-selected' : ''}
                          >
                            <td>
                              <strong>{item.chatTitle || item.chatId}</strong>
                              <small>
                                {item.chatId} · {item.hours} ч ·{' '}
                                {item.enabled ? 'Включено' : 'Выключено'}
                              </small>
                            </td>
                            <td>
                              <span
                                className={`risk-badge ${['error', 'no_access', 'capacity_paused'].includes(item.status) ? 'is-high' : 'is-neutral'}`}
                              >
                                {statusLabels[item.status]}
                              </span>
                              {item.hasTerminalReview && <small>Нужна проверка</small>}
                              {item.hasUnresolvedReceipt && (
                                <small>Проверяется результат MAX</small>
                              )}
                            </td>
                            <td>
                              {item.pendingCount}
                              <small>
                                {item.oldestDueAt
                                  ? `Старейшее: ${dateLabel(item.oldestDueAt)}`
                                  : 'Нет ожидающих'}
                              </small>
                            </td>
                            <td>
                              {item.deletedCount} / {item.skippedCount}
                            </td>
                            <td>{dateLabel(item.nextRunAt)}</td>
                            <td>
                              <button
                                className="ghost-action"
                                disabled={busyMessageId !== null}
                                onClick={() => void loadPreview(item)}
                              >
                                Проверить
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )
          )}
        </div>
        <footer className="retention-pagination">
          <span>
            {runtime
              ? `Снимок: ${dateLabel(runtime.generatedAt)} · до 50 чатов`
              : 'До 50 чатов на странице'}
          </span>
          <button
            className="ghost-action"
            disabled={loading || !trail.length || busyMessageId !== null}
            onClick={() => void previousPage()}
          >
            Назад
          </button>
          <button
            className="ghost-action"
            disabled={loading || !runtime?.nextAfter || pageError !== '' || busyMessageId !== null}
            onClick={() => void nextPage()}
          >
            Далее
          </button>
        </footer>
      </section>
      {selected && (
        <section className="retention-preview queue-panel" aria-label="Диагностика очистки">
          <header className="retention-toolbar">
            <div>
              <h2>{selected.chatTitle || selected.chatId}</h2>
              <p>До 20 сообщений, требующих проверки. Повтор только ставит запись в очередь.</p>
            </div>
            <button
              className="ghost-action"
              disabled={previewLoading || busyMessageId !== null}
              onClick={() => void loadPreview(selected)}
            >
              Обновить диагностику
            </button>
          </header>
          <div className="retention-preview-scroll">
            {!selected.enabled && (
              <p className="retention-alert">Очистка выключена. Повтор недоступен.</p>
            )}
            {previewNotice && (
              <p className="retention-alert" role="status">
                {previewNotice}
              </p>
            )}
            {previewLoading ? (
              <p className="queue-empty" role="status">
                Загружаю диагностику…
              </p>
            ) : (
              preview && (
                <>
                  <p className="retention-snapshot">
                    Ревизия {preview.revision} · запуск {preview.activationId}
                  </p>
                  {!preview.items.length ? (
                    <p className="queue-empty">Сообщений, требующих проверки, нет.</p>
                  ) : (
                    <div className="retention-candidates">
                      {preview.items.map((item) => (
                        <article key={item.messageId} className="retention-candidate">
                          <div>
                            <strong>Сообщение {item.messageId}</strong>
                            <span>
                              Автор {item.authorId || 'не указан'} · создано{' '}
                              {dateLabel(item.sourceAt)} · срок {dateLabel(item.dueAt)}
                            </span>
                            <span>
                              Состояние: {item.status} · причина: {item.outcomeCode ?? 'не указана'}
                            </span>
                            <span>
                              Удаление: {item.intentStatus ?? 'нет задания'} · попыток:{' '}
                              {item.intentAttemptCount ?? 0}
                              {item.reconcileAfter
                                ? ` · проверка после ${dateLabel(item.reconcileAfter)}`
                                : ''}
                            </span>
                          </div>
                          {selected.enabled && buildRetentionRetryRequest(preview, item) ? (
                            <button
                              className="primary-action"
                              disabled={busyMessageId !== null}
                              onClick={() => void retry(item)}
                            >
                              {busyMessageId === item.messageId
                                ? 'Возвращаю…'
                                : 'Вернуть в очередь'}
                            </button>
                          ) : (
                            <span className="retention-retry-denied">Повтор не разрешён</span>
                          )}
                        </article>
                      ))}
                    </div>
                  )}
                </>
              )
            )}
          </div>
        </section>
      )}
    </section>
  );
}

function dateLabel(value: string | null): string {
  return value ? formatDateTime(new Date(value)) : '—';
}
