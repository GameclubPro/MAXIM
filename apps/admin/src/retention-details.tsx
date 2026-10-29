import type {
  SafetyDeskRetentionRuntimeItem,
  SafetyDeskRetentionRuntimeResponse,
  SafetyDeskRetentionPreviewResponse,
} from '@maxim/contracts/safety-desk';
import { formatDateTime } from './safety-desk-model';
import { retentionConnectionErrorLabel, retentionConnectionLabel } from './retention-diagnostics';

const date = (value: string | null) =>
  value ? formatDateTime(new Date(value)) : 'не подтверждено';

export function RetentionProtectionDetails({
  preview,
}: {
  preview: SafetyDeskRetentionPreviewResponse;
}) {
  if (preview.source !== 'eraser') return null;
  const report = preview.protection;
  if (!report || report.status === 'unavailable')
    return <p className="retention-alert">Отчёт о защите истории недоступен.</p>;
  const evidence = preview.protectionEvidence;
  const synchronized =
    evidence &&
    report.deliveredEvidence &&
    evidence.checksum === report.deliveredEvidence.checksum &&
    evidence.sourceRevision === report.sourceRevision;
  const phases = [
    ['Розыгрыши', report.imports.giveawayEntities],
    ['Журнал правил', report.imports.rulesAudit],
    ['Журнал публикаций розыгрышей', report.imports.giveawayAudit],
    ['Старые удаления', report.imports.legacyHolds],
    ['Исключённые источники', report.imports.sourceHolds],
  ] as const;
  return (
    <details className="retention-operational-details">
      <summary>
        Защита истории: {synchronized ? 'версия подтверждена' : 'синхронизация не подтверждена'}
      </summary>
      <p>
        Версия источника: {report.sourceRevision} · передана:{' '}
        {report.deliveredRevision < 0 ? 'нет' : report.deliveredRevision}
      </p>
      <p>
        История до {date(report.historicalGapBefore)} полностью не подтверждена. Старые сообщения
        модулей сохраняют защиту.
      </p>
      <ul>
        {phases.map(([name, complete]) => (
          <li key={name}>
            {name}: {complete ? 'импорт завершён' : 'ожидает продолжения'}
          </li>
        ))}
      </ul>
      <p>
        Каталог: {report.catalog.ready ? 'проверен' : 'проверяется'} · записей в контрольной сумме:{' '}
        {report.catalog.referencesHashed}
      </p>
      {evidence && (
        <>
          <p>
            Подтверждённый интервал: {date(evidence.completeFrom)} —{' '}
            {date(evidence.completeThrough)}. Источник: непрерывная защита после передачи чата.
          </p>
          <p>
            Контрольная сумма: <code>{evidence.checksum}</code>
          </p>
        </>
      )}
      {report.legacyRetirement && (
        <p>
          Старый механизм:{' '}
          {report.legacyRetirement.scanComplete ? 'проход завершён' : 'проход продолжается'}. Без
          отправки завершено: {report.legacyRetirement.retiredCount}; подтверждения переданы на
          учёт: {report.legacyRetirement.reconciliationCount}; сохранено при проходе:{' '}
          {report.legacyRetirement.retainedAtScan}. Это снимок прохода, а не текущее число
          неизвестных результатов.
        </p>
      )}
    </details>
  );
}

export function RetentionConnectionDetails({ item }: { item: SafetyDeskRetentionRuntimeItem }) {
  const request = item.connectionRequest;
  if (request === undefined)
    return <p className="retention-snapshot">Сведения о запросе подключения недоступны.</p>;
  if (!request) return null;
  const error = retentionConnectionErrorLabel(request.lastError);
  return (
    <details className="retention-operational-details">
      <summary>Запрос подключения: {retentionConnectionLabel(request)}</summary>
      <p>
        Инициатор: {request.actorUserId} · ревизия {request.policyRevision}
      </p>
      <p>Операция: {request.operationId}</p>
      <p>
        Срок ожидания: {date(request.expiresAt)} · обновлён {date(request.updatedAt)}
      </p>
      {request.status === 'pending' && request.nextAttemptAt && (
        <p>Следующая проверка подключения: {date(request.nextAttemptAt)}</p>
      )}
      {error && <p>{error}</p>}
    </details>
  );
}

const purposeLabels = {
  bot_rights: 'Права бота',
  actor_rights: 'Права инициатора',
  pin: 'Закрепы',
  live_scan: 'Обход по сроку',
  history_scan: 'Старая история',
  safety_rights: 'Права при полном обходе',
  safety_scan: 'Полный обход',
  delete: 'Удаление',
  presence: 'Наличие сообщения',
  identity: 'Данные бота',
  subscriptions: 'Подписки',
};

export function RetentionRuntimeDetails({
  runtime,
}: {
  runtime: SafetyDeskRetentionRuntimeResponse;
}) {
  const metrics = runtime.transportMetrics;
  const health = runtime.health;
  return (
    <details className="retention-operational-details">
      <summary>Работа исполнителя и обращения к MAX</summary>
      {health ? (
        <>
          <p>
            Планировщик: {health.schedulerHealthy ? 'работает' : 'работа не подтверждена'} ·
            последний успешный цикл {date(health.schedulerLastSuccessfulAt)}
          </p>
          <p>
            Проверки подключения:{' '}
            {health.connectionSchedulerHealthy === undefined
              ? 'нет данных'
              : health.connectionSchedulerHealthy
                ? 'работают'
                : 'работа не подтверждена'}{' '}
            · последний цикл {date(health.connectionSchedulerLastSuccessfulAt ?? null)}
          </p>
          {health.workers ? (
            Object.entries(health.workers).map(([kind, worker]) => (
              <p key={kind}>
                {kind === 'cleanup' ? 'Очистка' : 'Подключение'}:{' '}
                {worker.healthy ? 'работает' : 'работа не подтверждена'} · занято{' '}
                {worker.occupiedSlots} · наблюдение {date(worker.sampledAt)} · последнее завершение{' '}
                {date(worker.lastCompletedAt)}
                {worker.progressOverdue ? ' · превышен срок ожидания прогресса' : ''}
                {worker.lastErrorAt ? ` · последняя ошибка ${date(worker.lastErrorAt)}` : ''}
              </p>
            ))
          ) : (
            <p>Состояние исполнителей неизвестно.</p>
          )}
        </>
      ) : (
        <p>Состояние исполнителей неизвестно.</p>
      )}
      <p>
        Сохранённая пауза MAX:{' '}
        {runtime.cooldown
          ? runtime.cooldown.durableUntil
            ? `до ${date(runtime.cooldown.durableUntil)}`
            : 'нет'
          : 'неизвестна'}
      </p>
      {metrics ? (
        <>
          <p>
            Счётчики текущего процесса с {date(metrics.since)} · наблюдение{' '}
            {date(metrics.observedAt)}
          </p>
          <p>
            Положительных ответов удаления: {metrics.deleteAcknowledged}. Это число ответов, оно
            может пересекаться с подтверждениями по уведомлениям.
          </p>
          <p>
            Отложено из-за паузы: {metrics.cooldownDeferrals} · допуск недоступен:{' '}
            {metrics.admissionUnavailable} · отклонено повторной проверкой: {metrics.guardRejected}
          </p>
          <p>
            Наблюдавшаяся пауза MAX:{' '}
            {metrics.observedCooldownUntil ? `до ${date(metrics.observedCooldownUntil)}` : 'нет'}
          </p>
          <div className="retention-table-scroll">
            <table className="retention-table">
              <thead>
                <tr>
                  <th>Назначение</th>
                  <th>Запросы</th>
                  <th>Ответы</th>
                  <th>HTTP 2xx</th>
                  <th>HTTP 429</th>
                  <th>Сеть</th>
                </tr>
              </thead>
              <tbody>
                {metrics.requests.map((row) => (
                  <tr key={row.purpose}>
                    <td>{purposeLabels[row.purpose]}</td>
                    <td>{row.attempts}</td>
                    <td>{row.responses}</td>
                    <td>{row.httpSuccesses}</td>
                    <td>{row.rateLimited}</td>
                    <td>{row.transportErrors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p>Счётчики обращений к MAX недоступны.</p>
      )}
    </details>
  );
}
