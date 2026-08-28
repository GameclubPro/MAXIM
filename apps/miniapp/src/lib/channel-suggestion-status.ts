import type { ChannelDialogMessage } from '@maxim/contracts/channel-dialog';

export type SuggestionStatusPresentation = {
  badge: string;
  headline: string;
  note: string;
  tone: 'pending' | 'published' | 'cancelled';
};

export function resolveSuggestionStatus(
  message: ChannelDialogMessage,
): SuggestionStatusPresentation {
  if (message.reviewStatus === 'published') {
    if (!message.publishedUrl) {
      return {
        badge: 'Принято',
        headline: 'Редактор создал публикацию',
        note: 'Отправка поста выполняется отдельно; итог зависит от статуса публикации.',
        tone: 'published',
      };
    }
    return {
      badge: 'Опубликовано',
      headline: 'Пост вышел в канале',
      note: 'Редактор взял предложку в публикацию.',
      tone: 'published',
    };
  }

  if (message.reviewStatus === 'cancelled') {
    return {
      badge: 'Отклонено',
      headline: 'Идея не ушла в публикацию',
      note: 'Можно доработать и отправить заново.',
      tone: 'cancelled',
    };
  }

  const delivery = message.suggestionDelivery;
  if (delivery) {
    switch (delivery.state) {
      case 'queued':
        return {
          badge: 'В очереди',
          headline: 'Ждёт доставки редакторам',
          note: 'Материал сохранён и находится в очереди доставки.',
          tone: 'pending',
        };
      case 'delivered':
        return {
          badge: 'На проверке',
          headline: 'Материал доставлен редакторам',
          note:
            delivery.targetCount > 1
              ? `Подтверждена доставка ${delivery.deliveredCount} из ${delivery.targetCount}.`
              : 'Доставка редактору подтверждена.',
          tone: 'pending',
        };
      case 'partially_delivered':
        return {
          badge: 'Доставлено частично',
          headline: 'Доставлено части редакторов',
          note:
            delivery.targetCount > 0
              ? `Подтверждена доставка ${delivery.deliveredCount} из ${delivery.targetCount}. Для остальных доставка пока не подтверждена.`
              : 'Часть редакторов получила материал, остальная доставка не подтверждена.',
          tone: 'pending',
        };
      case 'no_reachable_editor':
        return {
          badge: 'Сохранено',
          headline: 'Сохранено, редакторы пока недоступны',
          note: 'Материал остался в истории, но доставка редакторам не подтверждена.',
          tone: 'pending',
        };
      case 'uncertain':
        return {
          badge: 'Проверяем',
          headline: 'Доставка требует проверки',
          note: 'Материал сохранён. Итог доставки уточняется; дождитесь обновления статуса.',
          tone: 'pending',
        };
    }
  }

  if (message.delivered === false) {
    return {
      badge: 'Сохранено',
      headline: 'Предложка сохранена',
      note: 'Доставка редакторам пока не подтверждена.',
      tone: 'pending',
    };
  }

  return {
    badge: 'На проверке',
    headline: 'Материал ушёл редакторам',
    note: 'Бот уже отправил предложку админам. Дополнения после отправки идут новой предложкой.',
    tone: 'pending',
  };
}
