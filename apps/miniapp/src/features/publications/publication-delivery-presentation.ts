import type { PublicationDelivery } from '@maxim/contracts/publication';

export function getPublicationDeliveryPresentation(
  delivery: Pick<PublicationDelivery, 'status' | 'dispatchStopped'>,
): { label: string; showPendingTiming: boolean; stopNotice: string | null } {
  const labels: Record<PublicationDelivery['status'], string> = {
    PENDING: 'В очереди',
    SENDING: 'Отправляется',
    SENT: 'Опубликовано',
    FAILED: 'Ошибка',
    AMBIGUOUS: 'Нужно проверить',
    CANCELED: 'Отменено',
  };
  const stopped = delivery.dispatchStopped === true;
  return {
    label:
      stopped && delivery.status === 'PENDING'
        ? 'Отправка остановлена'
        : stopped && delivery.status === 'SENDING'
          ? 'Результат начатой попытки уточняется'
          : labels[delivery.status],
    showPendingTiming: delivery.status === 'PENDING' && !stopped,
    stopNotice:
      stopped && (delivery.status === 'SENDING' || delivery.status === 'AMBIGUOUS')
        ? 'Дальнейшая отправка остановлена'
        : null,
  };
}
