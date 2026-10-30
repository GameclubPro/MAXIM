import type { MarketplaceListing } from '@maxim/contracts/karavan-marketplace-management';

export const publicationReasons = {
  published: 'В магазине',
  marketplace_unavailable: 'Магазин закрыт для покупателей',
  chat_unavailable: 'Чат магазина недоступен',
  store_unavailable: 'Витрина продавца недоступна',
  awaiting_review: 'Заявка на проверке',
  changes_requested: 'Требуется доработка заявки',
  rejected: 'Заявка отклонена',
  suspended: 'Скрыт администратором',
  seller_paused: 'Приостановлено продавцом',
  withdrawn: 'Продавец отозвал размещение',
  platform_review: 'Витрина на проверке Каравана',
  rules_acceptance_required: 'Продавец ещё не принял правила',
  category_not_allowed: 'Категория не разрешена',
  no_published_offers: 'Нет опубликованных объявлений',
} satisfies Record<MarketplaceListing['publicationReason'], string>;
