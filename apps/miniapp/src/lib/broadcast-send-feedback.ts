import type { SendBroadcastResult } from '@maxim/contracts';

export type BroadcastSendFeedback = {
  kind: 'delivered' | 'started' | 'scheduled' | 'partial' | 'failed' | 'unconfirmed';
  tone: 'success' | 'info' | 'danger';
  title: string;
  description?: string;
  clearDraft: boolean;
  notification: 'success' | 'warning' | 'error';
};

export function buildBroadcastSendFeedback(
  result: Pick<
    SendBroadcastResult,
    | 'targetChats'
    | 'sentChats'
    | 'failedChats'
    | 'nextSendAt'
    | 'scheduleId'
    | 'scheduledSlots'
    | 'scheduledOccurrences'
  >,
): BroadcastSendFeedback {
  const persisted = result.scheduleId !== null;
  const hasFutureSend =
    result.nextSendAt !== null ||
    result.scheduledOccurrences > 0 ||
    result.scheduledSlots.length > 0;

  if (result.failedChats > 0) {
    if (result.sentChats > 0) {
      return {
        kind: 'partial',
        tone: 'info',
        title: 'Часть публикаций с ошибкой',
        description: `Отправлено: ${result.sentChats}/${result.targetChats}, ошибок: ${result.failedChats}.`,
        clearDraft: true,
        notification: 'warning',
      };
    }

    return {
      kind: 'failed',
      tone: 'danger',
      title: 'Публикация не отправлена',
      description: persisted
        ? `Не доставлено: ${result.failedChats}/${result.targetChats}. Запись сохранена в списке публикаций для проверки получателей.`
        : `Не доставлено: ${result.failedChats}/${result.targetChats}. Проверьте доступ бота и получателей.`,
      clearDraft: persisted,
      notification: 'error',
    };
  }

  if (result.sentChats === result.targetChats) {
    return hasFutureSend
      ? {
          kind: 'started',
          tone: 'success',
          title: 'Публикация запущена',
          description: `Первая отправка доставлена: ${result.sentChats}/${result.targetChats}.`,
          clearDraft: true,
          notification: 'success',
        }
      : {
          kind: 'delivered',
          tone: 'success',
          title: 'Публикация отправлена',
          description: `Доставлено: ${result.sentChats}/${result.targetChats}.`,
          clearDraft: true,
          notification: 'success',
        };
  }

  if (hasFutureSend) {
    return {
      kind: 'scheduled',
      tone: 'success',
      title: 'Публикация запланирована',
      clearDraft: true,
      notification: 'success',
    };
  }

  if (result.sentChats > 0) {
    return {
      kind: 'unconfirmed',
      tone: 'info',
      title: 'Результат требует проверки',
      description: `Подтверждено: ${result.sentChats}/${result.targetChats}. Откройте историю отправки.`,
      clearDraft: true,
      notification: 'warning',
    };
  }

  return {
    kind: 'unconfirmed',
    tone: 'danger',
    title: 'Отправка не подтверждена',
    description: persisted
      ? 'Ни одна доставка не подтверждена. Запись сохранена в списке публикаций; не запускайте её повторно.'
      : 'Ни одна доставка не подтверждена. Черновик сохранён.',
    clearDraft: persisted,
    notification: 'error',
  };
}
