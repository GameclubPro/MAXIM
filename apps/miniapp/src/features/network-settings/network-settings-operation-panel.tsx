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
  const applied = operation.outcomes.filter(
    (row) => row.status === 'COMMITTED' || row.status === 'COMPLETE',
  ).length;
  return (
    <section className="network-settings-page__operation" aria-live="polite">
      <h2>{STATUS[operation.status]}</h2>
      <p>
        Сохранено: {applied} из {operation.outcomes.length}
      </p>
      {resumeOperationId && !controller.preview && operation.status === 'PREPARED' ? (
        <p>
          Предпросмотр восстановлен для просмотра статуса. Для применения заново выберите и
          проверьте изменения.
        </p>
      ) : null}
      <ul>
        {operation.outcomes.map((row) => (
          <li key={row.entityId}>
            <strong>{recipientTitles.get(row.entityId) || 'Сообщество'}</strong>
            <span>{outcomeLabel(row)}</span>
            <small>{row.entityId}</small>
            {row.failureMessage ? <small>{row.failureMessage}</small> : null}
          </li>
        ))}
      </ul>
      {controller.canStartAgain ? (
        <button type="button" onClick={onStartAgain}>
          Изменить настройки снова
        </button>
      ) : null}
      {controller.failedRecipients.length > 0 && controller.failedRecipients.length <= 500 ? (
        <button type="button" onClick={onRetry}>
          {controller.retryChanges.length || controller.navigationAllowlist
            ? 'Проверить повтор для неприменённых'
            : 'Открыть настройки неприменённых'}{' '}
          ({controller.failedRecipients.length})
        </button>
      ) : controller.failedRecipients.length > 500 ? (
        <p>
          Для повторной проверки выберите до 500 неприменённых сообществ или заново проверьте всю
          категорию.
        </p>
      ) : null}
      <small>Номер операции: {operation.operationId}</small>
    </section>
  );
}
