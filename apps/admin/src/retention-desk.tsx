import type { SafetyDeskRetentionRuntimeItem } from '@maxim/contracts/safety-desk';
import { useRetentionDesk, type RetentionDeskProps } from './retention-desk-state';
import { buildRetentionRetryRequest, formatDateTime } from './safety-desk-model';
import {
  retentionCountLabel,
  retentionDiagnosticLabels,
  retentionSourceLabel,
  retentionWorkerWarning,
  retentionPageWarning,
} from './retention-diagnostics';
import { RetentionConnectionDetails, RetentionRuntimeDetails } from './retention-details';

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
    previewPageAfter,
    previewTrail,
    trail,
    pageAfter,
    loading,
    previewLoading,
    busyMessageId,
    pageError,
    previewNotice,
    retryPage,
    loadPreview,
    refreshPreview,
    nextPreviewPage,
    previousPreviewPage,
    retry,
    nextPage,
    previousPage,
  } = useRetentionDesk(props);
  return (
    <section className="retention-desk" aria-label="Очистка старых сообщений">
      <section className="retention-runtime queue-panel">
        <header className="retention-toolbar">
          <div>
            <h2>«Ластик»: очистка по сроку</h2>
            <p>Новые сообщения и доступная история. Закрепы, правила и розыгрыши защищены.</p>
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
                {retentionPageWarning(runtime) && (
                  <p className="retention-alert">{retentionPageWarning(runtime)}</p>
                )}
                {retentionWorkerWarning(runtime) && (
                  <p className="retention-alert" role="status">
                    {retentionWorkerWarning(runtime)}
                  </p>
                )}
                {!runtime.items.length && !runtime.unavailableSources?.length ? (
                  <p className="queue-empty">
                    {runtime.incomplete === false
                      ? pageAfter || runtime.nextAfter
                        ? 'На этой странице чатов нет.'
                        : 'Чатов с настройкой очистки пока нет.'
                      : 'Данные о чатах на этой странице не подтверждены.'}
                  </p>
                ) : (
                  <div className="retention-table-scroll">
                    <table className="retention-table">
                      <thead>
                        <tr>
                          <th>Чат / срок</th>
                          <th>Состояние</th>
                          <th>В очереди</th>
                          <th>Больше нет / пропущено</th>
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
                                {item.chatId} ·{' '}
                                {item.hours === 168 ? '1 неделя' : `${item.hours} ч`} ·{' '}
                                {item.enabled ? 'Включено' : 'Выключено'}
                              </small>
                              <small>{retentionSourceLabel(item.source)}</small>
                            </td>
                            <td>
                              <span
                                className={`risk-badge ${['error', 'no_access', 'capacity_paused'].includes(item.status) ? 'is-high' : 'is-neutral'}`}
                              >
                                {statusLabels[item.status]}
                              </span>
                              {retentionDiagnosticLabels(item).map((label) => (
                                <small key={label}>{label}</small>
                              ))}
                            </td>
                            <td>
                              {retentionCountLabel(
                                item.pendingCount,
                                item.progress?.pendingCountComplete,
                              )}
                              <small>
                                {item.progress
                                  ? `Готовы по сроку: ${retentionCountLabel(item.progress.eligibleCount, item.progress.eligibleCountComplete)}`
                                  : 'Готовность по сроку неизвестна'}
                              </small>
                              {item.progress?.oldestEligibleDueAt && (
                                <small>
                                  Ожидают с {dateLabel(item.progress.oldestEligibleDueAt)}
                                </small>
                              )}
                              {item.progress && (
                                <small>
                                  Результат не подтверждён:{' '}
                                  {retentionCountLabel(
                                    item.progress.unknownCount,
                                    item.progress.unknownCountComplete,
                                  )}
                                </small>
                              )}
                              {item.progress?.oldestUnknownAt && (
                                <small>
                                  Неопределённый результат с{' '}
                                  {dateLabel(item.progress.oldestUnknownAt)}
                                </small>
                              )}
                              <small>
                                {item.coverage?.lastCompletedAt
                                  ? `Полный обход: ${dateLabel(item.coverage.lastCompletedAt)}`
                                  : 'Полный обход не подтверждён'}
                              </small>
                            </td>
                            <td>
                              {item.deletedCount} / {item.skippedCount}
                              {item.confirmationCounts ? (
                                <>
                                  <small>Первое подтверждение:</small>
                                  <small>
                                    По ответу удаления: {item.confirmationCounts.deleteAcknowledged}
                                  </small>
                                  <small>
                                    По уведомлению: {item.confirmationCounts.removalReceipt}
                                  </small>
                                  <small>
                                    Прежний счётчик без источника:{' '}
                                    {item.confirmationCounts.historicalUnknown}
                                  </small>
                                </>
                              ) : (
                                <small>Источники подтверждений неизвестны</small>
                              )}
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
                        {runtime.unavailableSources?.map((item) => (
                          <tr key={`unavailable:${item.source}:${item.chatId}`}>
                            <td>
                              <strong>{item.chatTitle || item.chatId}</strong>
                              <small>
                                {item.chatId} · {retentionSourceLabel(item.source)}
                              </small>
                            </td>
                            <td colSpan={5}>
                              <span className="risk-badge is-high">Источник недоступен</span>
                              <small>
                                {item.reason === 'not_initialized'
                                  ? 'Сохранённое подключение найдено, настройки источника недоступны.'
                                  : item.reason === 'invalid_response'
                                    ? 'Не удалось проверить ответ источника.'
                                    : 'Не удалось получить состояние очистки.'}{' '}
                                Счётчики неизвестны.
                              </small>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <RetentionRuntimeDetails runtime={runtime} />
              </>
            )
          )}
        </div>
        <footer className="retention-pagination">
          <span>
            {runtime
              ? `Снимок: ${dateLabel(runtime.generatedAt)} · до 50 чатов на странице${runtime.nextAfter ? ' · список продолжается' : pageAfter ? ' · последняя страница' : ''}`
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
              <p>До 20 сообщений на странице. Повтор только ставит запись в очередь.</p>
            </div>
            <button
              className="ghost-action"
              disabled={previewLoading || busyMessageId !== null}
              onClick={() => void refreshPreview()}
            >
              Обновить диагностику
            </button>
          </header>
          <div className="retention-preview-scroll">
            <RetentionConnectionDetails item={selected} />
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
                  <p className="retention-snapshot">
                    {retentionSourceLabel(preview.source)} ·{' '}
                    {preview.nextAfter
                      ? 'Показана часть сообщений, требующих проверки.'
                      : preview.incomplete === undefined
                        ? 'Полнота списка неизвестна.'
                        : preview.incomplete
                          ? 'Показана часть сообщений, требующих проверки.'
                          : 'Конец списка.'}
                  </p>
                  {!preview.items.length ? (
                    <p className="queue-empty">
                      {preview.incomplete === false &&
                      !preview.nextAfter &&
                      previewPageAfter === null
                        ? 'Сообщений, требующих проверки, нет.'
                        : 'На этой странице сообщений нет.'}
                    </p>
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
          <footer className="retention-pagination">
            <span>До 20 сообщений на странице</span>
            <button
              className="ghost-action"
              disabled={previewLoading || !previewTrail.length || busyMessageId !== null}
              onClick={() => void previousPreviewPage()}
            >
              Предыдущие сообщения
            </button>
            <button
              className="ghost-action"
              disabled={previewLoading || !preview?.nextAfter || busyMessageId !== null}
              onClick={() => void nextPreviewPage()}
            >
              Следующие сообщения
            </button>
          </footer>
        </section>
      )}
    </section>
  );
}

function dateLabel(value: string | null): string {
  return value ? formatDateTime(new Date(value)) : '—';
}
