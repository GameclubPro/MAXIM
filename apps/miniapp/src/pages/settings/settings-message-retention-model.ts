import type { MessageRetentionState } from '@maxim/contracts/settings';

export const messageRetentionStatusLabels: Record<MessageRetentionState['status'], string> = {
  off: 'Выкл',
  unavailable: 'Недоступно',
  shadow: 'Наблюдение',
  running: 'Вкл',
  delayed: 'С задержкой',
  paused: 'Пауза',
  capacity_paused: 'Пауза',
  no_access: 'Нет прав',
  error: 'Ошибка',
};
