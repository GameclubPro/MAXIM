import type { MessageRetentionState } from '@maxim/contracts/settings';

export const messageRetentionStatusLabels: Record<MessageRetentionState['status'], string> = {
  off: 'Выкл',
  unavailable: 'Недоступно',
  shadow: 'Наблюдение',
  running: 'Вкл',
  delayed: 'Отложено',
  paused: 'Пауза',
  capacity_paused: 'Пауза',
  no_access: 'Нет прав',
  error: 'Ошибка',
};

export function retentionEligibleSince(state: MessageRetentionState): string | null {
  return state.progress && state.progress.eligibleCount > 0
    ? state.progress.oldestEligibleDueAt
    : null;
}

export function retentionHistoryLabel(state: MessageRetentionState): string | null {
  if (!state.historyStatus || state.historyStatus === 'off') return null;
  if (state.coverage?.gap) return 'Часть истории ещё не проверена';
  if (state.coverage?.protectedHistory) return 'Часть истории отложена';
  return {
    pending: 'Ожидает очистки',
    running: 'Очищается',
    complete: 'Проверена',
    blocked: 'Часть истории отложена',
  }[state.historyStatus];
}
