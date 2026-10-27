import type { SafetyDeskRetentionRuntimeItem } from '@maxim/contracts/safety-desk';

type RetentionDiagnosticsItem = Pick<
  SafetyDeskRetentionRuntimeItem,
  | 'hasTerminalReview'
  | 'hasUnresolvedReceipt'
  | 'connectionStatus'
  | 'historyStatus'
  | 'diagnostics'
>;

type RetentionError = NonNullable<
  NonNullable<SafetyDeskRetentionRuntimeItem['diagnostics']>['lastError']
>;

const errorLabels: Record<RetentionError, string> = {
  bot_removed: '«Ластик» удалён из чата',
  eraser_rights_missing: '«Ластику» нужны права на чтение и удаление',
  membership_unknown: 'MAX не подтвердил права «Ластика»',
  queue_unavailable: 'Очередь очистки недоступна',
  worker_error: 'Ошибка обработки очистки',
  transport_unknown: 'Ответ MAX не получен',
  malformed_response: 'MAX вернул некорректный ответ',
  pin_unknown: 'MAX не подтвердил закреплённое сообщение',
  history_unknown: 'MAX не подтвердил содержимое истории',
  history_boundary_unknown: 'MAX вернул историю за границей запроса',
  history_duplicate: 'MAX вернул повторяющиеся сообщения истории',
  delete_unconfirmed: 'MAX не подтвердил результат удаления',
  unknown: 'Причина последней ошибки не распознана',
};

const historyLabels = {
  pending: 'История: ожидает',
  running: 'История: обход',
  complete: 'История: обход завершён',
  blocked: 'История: часть истории отложена',
  off: 'История: выключена',
} satisfies Record<NonNullable<SafetyDeskRetentionRuntimeItem['historyStatus']>, string>;

export function retentionDiagnosticLabels(item: RetentionDiagnosticsItem): string[] {
  const labels: string[] = [];
  if (item.hasTerminalReview) labels.push('Нужна проверка');
  if (item.hasUnresolvedReceipt) labels.push('Проверяется результат MAX');
  if (item.connectionStatus && item.connectionStatus !== 'connected') {
    labels.push(
      {
        missing: '«Ластик» не подключён',
        no_access: '«Ластику» нужны права',
        unknown: 'Подключение проверяется',
      }[item.connectionStatus],
    );
  }

  const diagnostics = item.diagnostics;
  const detailedHistory =
    diagnostics?.historyBoundaryBlocked ||
    diagnostics?.awaitingCurrentProtection ||
    diagnostics?.awaitingHistoricalProtection;
  if (item.historyStatus && !(item.historyStatus === 'blocked' && detailedHistory)) {
    labels.push(historyLabels[item.historyStatus]);
  }
  if (!diagnostics) return labels;

  if (diagnostics.historyBoundaryBlocked) {
    labels.push('История: граница обхода не подтверждена');
  }
  if (diagnostics.awaitingCurrentProtection) {
    labels.push('Нет подтверждения защиты новых сообщений');
  }
  if (diagnostics.awaitingHistoricalProtection) {
    labels.push('Нет подтверждения защиты старой истории');
  }
  const error = diagnostics.lastError;
  const duplicateConnection =
    (error === 'bot_removed' && item.connectionStatus === 'missing') ||
    (error === 'eraser_rights_missing' && item.connectionStatus === 'no_access');
  if (error && !duplicateConnection) labels.push(errorLabels[error]);
  return labels;
}
