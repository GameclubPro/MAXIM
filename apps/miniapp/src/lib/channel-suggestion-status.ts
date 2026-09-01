import type { ChannelDialogMessage } from '@maxim/contracts/channel-dialog';

export type SuggestionStatusPresentation = {
  badge: string;
  detail?: string;
  tone: 'pending' | 'published' | 'cancelled';
};

export function resolveSuggestionStatus(
  message: ChannelDialogMessage,
): SuggestionStatusPresentation {
  if (message.reviewStatus === 'published') {
    if (!message.publishedUrl) {
      return {
        badge: 'Принято',
        tone: 'published',
      };
    }
    return {
      badge: 'Опубликовано',
      tone: 'published',
    };
  }

  if (message.reviewStatus === 'cancelled') {
    return {
      badge: 'Отклонено',
      tone: 'cancelled',
    };
  }

  const delivery = message.suggestionDelivery;
  if (delivery) {
    switch (delivery.state) {
      case 'queued':
        return {
          badge: 'В очереди',
          tone: 'pending',
        };
      case 'delivered':
        return {
          badge: 'На рассмотрении',
          tone: 'pending',
        };
      case 'partially_delivered':
        return {
          badge: 'Доставлено частично',
          detail:
            delivery.targetCount > 0
              ? `Доставлено редакторам: ${delivery.deliveredCount} из ${delivery.targetCount}`
              : 'Не все редакторы получили предложение',
          tone: 'pending',
        };
      case 'no_reachable_editor':
        return {
          badge: 'Не доставлено',
          detail: 'Редакторы пока недоступны',
          tone: 'pending',
        };
      case 'uncertain':
        return {
          badge: 'Проверяем',
          tone: 'pending',
        };
    }
  }

  if (message.delivered === false) {
    return {
      badge: 'Не доставлено',
      detail: 'Доставка редакторам не подтверждена',
      tone: 'pending',
    };
  }

  return {
    badge: 'На рассмотрении',
    tone: 'pending',
  };
}
