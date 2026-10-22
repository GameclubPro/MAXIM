import { useState } from 'react';
import type { NetworkSettingsOperationResponse } from '@maxim/contracts/network-settings';
import type { useNetworkSettingsController } from './network-settings-controller';

export type NetworkSettingsOperationPanelProps = {
  operation: NetworkSettingsOperationResponse;
  controller: Pick<
    ReturnType<typeof useNetworkSettingsController>,
    'preview' | 'canStartAgain' | 'failedRecipients' | 'retryChanges' | 'navigationAllowlist'
  >;
  recipientTitles: ReadonlyMap<string, string>;
  resumeOperationId?: string;
  onStartAgain: () => void;
  onRetry: () => void;
};

const STATUS: Record<NetworkSettingsOperationResponse['status'], string> = {
  PREVIEWING: 'Проверяем изменения',
  PREPARED: 'Изменения готовы к подтверждению',
  AUTHORIZING: 'Проверяем доступ',
  RUNNING: 'Применяем настройки',
  COMPLETE: 'Настройки применены',
  PARTIAL: 'Применена часть изменений',
  FAILED: 'Изменения не применены',
};
const OUTCOME: Record<NetworkSettingsOperationResponse['outcomes'][number]['status'], string> = {
  PENDING: 'Ожидает проверки',
  VALIDATED: 'Проверено',
  AUTHORIZED: 'Доступ подтверждён',
  COMMITTED: 'Сохранено, обновляем состояние',
  COMPLETE: 'Применено',
  FAILED: 'Не применено',
};
function outcomeLabel(row: NetworkSettingsOperationResponse['outcomes'][number]): string {
  if (row.status !== 'FAILED') return OUTCOME[row.status];
  if (row.failureCode === 'PREFLIGHT_ABORTED') return 'Проверка остановлена';
  return row.failureCode === 'DENIED'
    ? 'Нет доступа'
    : row.failureCode === 'CONFLICT'
      ? 'Конфликт изменений'
      : row.failureCode === 'INVALID'
        ? 'Проверьте параметры'
        : 'Ошибка применения';
}
export function NetworkSettingsOperationPanel({
  operation,
  controller,
  recipientTitles,
  resumeOperationId,
  onStartAgain,
  onRetry,
}: NetworkSettingsOperationPanelProps) {
  const [limit, setLimit] = useState(50);
  const applied = operation.outcomes.filter(
    (row) => row.status === 'COMMITTED' || row.status === 'COMPLETE',
  ).length;
  const failures = operation.outcomes.filter((row) => row.status === 'FAILED');
  const otherOutcomes = operation.outcomes.filter((row) => row.status !== 'FAILED');
  const outcomes = (rows: typeof operation.outcomes) => (
    <ul className="network-settings-outcomes">
      {rows.slice(0, limit).map((row) => (
        <li key={row.entityId}>
          <strong>{recipientTitles.get(row.entityId) || 'Сообщество'}</strong>
          <span>{outcomeLabel(row)}</span>
          {row.failureMessage ? <small>{row.failureMessage}</small> : null}
        </li>
      ))}
    </ul>
  );
  return (
    <section className="network-settings-page__operation" aria-live="polite">
      <h2>{STATUS[operation.status]}</h2>
      {!['PREVIEWING', 'PREPARED'].includes(operation.status) ? (
        <p>
          {operation.outcomes.some((row) => row.status === 'COMMITTED') ? 'Записано' : 'Применено'}:{' '}
          {applied} из {operation.outcomes.length}
        </p>
      ) : null}
      {resumeOperationId && !controller.preview && operation.status === 'PREPARED' ? (
        <p>
          {controller.canStartAgain
            ? 'Эта проверка не применялась. Откройте настройки и задайте изменения заново.'
            : 'Подтверждаем состояние операции. Результат пока неизвестен.'}
        </p>
      ) : null}
      {failures.length ? outcomes(failures) : null}
      <details className="network-settings-details">
        <summary>Подробности применения</summary>
        {otherOutcomes.length ? outcomes(otherOutcomes) : null}
        {Math.max(failures.length, otherOutcomes.length) > limit ? (
          <button type="button" onClick={() => setLimit((value) => value + 50)}>
            Показать ещё результаты
          </button>
        ) : null}
        <small>Номер операции: {operation.operationId}</small>
      </details>
      {controller.canStartAgain ? (
        <button type="button" onClick={onStartAgain}>
          {operation.status === 'PREPARED' ? 'Открыть новые настройки' : 'Изменить настройки'}
        </button>
      ) : null}
      {controller.failedRecipients.length > 0 ? (
        <button type="button" onClick={onRetry}>
          {controller.retryChanges.length || controller.navigationAllowlist
            ? 'Проверить повтор для неприменённых'
            : 'Открыть настройки неприменённых'}{' '}
          ({Math.min(500, controller.failedRecipients.length)})
        </button>
      ) : null}
      {controller.failedRecipients.length > 500 ? (
        <p>
          Следующий пакет — 500 сообществ. Оставшиеся {controller.failedRecipients.length - 500}{' '}
          будут доступны здесь отдельно.
        </p>
      ) : null}
    </section>
  );
}
