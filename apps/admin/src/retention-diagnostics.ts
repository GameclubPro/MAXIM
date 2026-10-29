import type {
  SafetyDeskRetentionRuntimeItem,
  SafetyDeskRetentionRuntimeResponse,
} from '@maxim/contracts/safety-desk';

type RetentionDiagnosticsItem = Pick<
  SafetyDeskRetentionRuntimeItem,
  | 'hasTerminalReview'
  | 'hasUnresolvedReceipt'
  | 'connectionStatus'
  | 'historyStatus'
  | 'diagnostics'
  | 'coverage'
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
  if (item.hasUnresolvedReceipt) labels.push('Результат удаления не подтверждён');
  if (item.connectionStatus && item.connectionStatus !== 'connected') {
    labels.push(
      {
        missing: '«Ластик» не подключён',
        no_access: '«Ластику» нужны права',
        unknown: 'Подключение не подтверждено',
      }[item.connectionStatus],
    );
  }

  const diagnostics = item.diagnostics;
  if (item.coverage?.executionStopped) labels.push('Выполнение очистки недоступно');
  if (item.coverage?.protectedHistory) labels.push('Защищённая часть истории отложена');
  if (item.coverage?.gap) labels.push('Полнота обхода не подтверждена');
  const detailedHistory =
    item.coverage?.protectedHistory ||
    item.coverage?.gap ||
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

export function retentionCountLabel(value: number, complete: boolean | undefined): string {
  const count = value.toLocaleString('ru-RU');
  return complete === false
    ? `не менее ${count}`
    : complete === true
      ? count
      : `${count} · полнота неизвестна`;
}

export function retentionWorkerWarning(
  runtime: Pick<SafetyDeskRetentionRuntimeResponse, 'mode' | 'health'>,
): string | null {
  const worker = runtime.health?.workers?.cleanup;
  if (runtime.mode === 'off' || !worker || worker.healthy) return null;
  if (!worker.running) return 'Исполнитель очистки недоступен.';
  if (!worker.ready) return 'Исполнитель очистки ещё не готов.';
  if (worker.progressOverdue) return 'Исполнитель очистки не подтверждает прогресс.';
  return 'Работа исполнителя очистки не подтверждена.';
}

export function retentionPageWarning(
  runtime: Pick<SafetyDeskRetentionRuntimeResponse, 'incomplete' | 'unavailableSources'>,
): string | null {
  if (runtime.unavailableSources?.length) return 'Часть источников диагностики недоступна.';
  if (runtime.incomplete === true) return 'Диагностика этой страницы неполная.';
  if (runtime.incomplete === undefined) return 'Полнота диагностики не подтверждена.';
  return null;
}

export function retentionSourceLabel(source: SafetyDeskRetentionRuntimeItem['source']): string {
  return source === 'eraser'
    ? 'Ластик'
    : source === 'legacy'
      ? 'Прежняя очистка'
      : 'Источник не указан';
}

const connectionLabels = {
  pending: 'Ожидает подключения',
  expired: 'Срок ожидания истёк',
  cancelled: 'Запрос отменён',
  activated: 'Очистка включена по запросу',
};

export function retentionConnectionLabel(
  request: SafetyDeskRetentionRuntimeItem['connectionRequest'],
): string {
  return request ? connectionLabels[request.status] : 'Нет запроса';
}

export function retentionConnectionErrorLabel(
  error: NonNullable<SafetyDeskRetentionRuntimeItem['connectionRequest']>['lastError'],
): string | null {
  if (error === null) return null;
  const labels = {
    ...errorLabels,
    actor_rights_missing: 'У инициатора запроса нет прав администратора',
    queue_race: 'Постановка проверки в очередь отложена',
    connection_proof_stale: 'Подтверждение прав устарело',
    connection_guard_changed: 'Условия подключения изменились',
    connection_check_failed: 'Не удалось проверить подключение',
    ERASER_CONNECTION_STOPPED: 'Ожидание подключения завершено',
  } satisfies Record<
    NonNullable<SafetyDeskRetentionRuntimeItem['connectionRequest']>['lastError'] & string,
    string
  >;
  return labels[error];
}
