const actionNames: Record<string, string> = {
  NONE: 'Оставить сообщение',
  IGNORE: 'Оставить сообщение',
  REVIEW_ONLY: 'Проверить вручную',
  WARN: 'Есть признаки рекламы',
  DELETE: 'Удалить сообщение',
  DELETE_ONLY: 'Удалить без наказания',
  DELETE_AND_ESCALATE: 'Удалить; наказание по настройкам чата',
};
const subtypeNames: Record<string, string> = {
  SERVICE_OFFER: 'Предложение услуг',
  SERVICES: 'Предложение услуг',
  GOODS: 'Продажа товаров',
  GOODS_RETAIL: 'Торговля товарами',
  GROUP_PROMOTION: 'Продвижение канала или группы',
  PROPERTY_AGENCY: 'Услуги агентства недвижимости',
  PROPERTY_AGENT: 'Услуги агентства недвижимости',
  PROPERTY_COMMERCIAL: 'Коммерческая недвижимость',
  RECRUITMENT: 'Набор работников',
  INFOPRODUCT: 'Продажа курсов и обучения',
  INFO_PRODUCT: 'Продажа курсов и обучения',
  CHANNEL_PLACEMENT: 'Платная публикация в канале',
  BUYOUT: 'Скупка товаров',
  HIGH_RISK: 'Опасное предложение',
  GENERIC: 'Общие признаки рекламы',
};
const reasonNames: Record<string, string> = {
  'high-risk-signal': 'Признаки опасного предложения',
  'risk:escalation-grade': 'Признаки нарушения, требующего наказания',
  'evidence:action-direct': 'Прямое предложение сделки',
  'evidence:high-risk-only': 'Опасное предложение без прямой сделки',
  'policy:guarded-local-direct': 'Есть признаки частного объявления',
  'evidence:direct:price-contact': 'Указаны цена и контакты',
  'evidence:direct:price-link': 'Указаны цена и ссылка',
  'evidence:direct:link-contact': 'Указаны ссылка и контакты',
  'evidence:direct:transaction-contact': 'Предложена сделка и указаны контакты',
  'direct-price-contact': 'Указаны цена и контакты',
  'mass-distribution': 'Признаки массовой рассылки',
  'fp-risk-high': 'Высокий риск ошибочного удаления',
  'fp-risk-policy-high': 'Высокий риск ошибочного удаления',
  'review:medium-band': 'Неоднозначные признаки рекламы',
  'review:near-threshold': 'Оценка близка к границе удаления',
  'review:conflicting-negative-signals': 'Есть признаки обычного сообщения',
  'review:campaign-dependent': 'Решение зависит от повторений в других чатах',
  'review:paid-review-work': 'Предложена оплата за отзывы',
  'review:organized-wellness-trip': 'Предложена организованная поездка',
  'review:generic-subtype': 'Не удалось уточнить вид рекламы',
  'review:private-sale-override': 'Похоже на частную продажу',
  'review:past-retail-purchase': 'Рассказ о прошлой покупке',
  'review:third-party-service-recommendation': 'Рекомендация чужой услуги',
  'review:handmade-showcase-without-direct-deal': 'Показ изделия без предложения сделки',
  'review:classifier-ambiguous': 'Смысл сообщения неоднозначен',
  'review:ambiguous-transport-review-only': 'Неясно, предлагает ли автор перевозку',
  'image-set-incomplete': 'Получены не все фотографии',
  'no-independent-delete-source': 'На фотографии недостаточно признаков для удаления',
  'image-independent-two-pass-delete': 'Реклама подтверждена двумя проверками фотографии',
};
const evidenceNames: Record<string, string> = {
  HIGH_RISK: 'Признаки опасного предложения',
  DIRECT: 'Прямое предложение сделки',
  STRUCTURED: 'Несколько связанных признаков рекламы',
  BORDERLINE: 'Неоднозначные признаки рекламы',
  HARD_NEGATIVE: 'Признаки обычного сообщения',
};
const cohortNames: Record<string, string> = {
  'commercial-text': 'Текст сообщения',
  'owned-service-contrast-v1': 'Кто предлагает услугу',
  'sliding-campaign-v1': 'Повторения в разных чатах',
};

export function commercialReviewActionName(value: string): string {
  return actionNames[value] ?? 'Требуется проверка решения';
}

export function commercialReviewReasonName(value: string): string {
  if (reasonNames[value]) return reasonNames[value];
  if (subtypeNames[value]) return subtypeNames[value];
  if (value.startsWith('subtype:'))
    return subtypeNames[value.slice('subtype:'.length)] ?? 'Общие признаки рекламы';
  if (value.startsWith('action:')) return commercialReviewActionName(value.slice('action:'.length));
  if (value.startsWith('evidence:'))
    return evidenceNames[value.slice('evidence:'.length)] ?? 'Дополнительные признаки рекламы';
  if (
    value.startsWith('safe-context:') ||
    value.startsWith('caption-safe-context:') ||
    value.startsWith('image-safe-context:')
  )
    return 'Есть признаки обычного сообщения';
  if (value.startsWith('missing-anchor:')) return 'Не хватает обязательных признаков рекламы';
  if (value.startsWith('suppressed:')) return 'Сработала защита от ошибочного удаления';
  if (value.startsWith('campaign-strength:')) return 'Учтены повторения в разных чатах';
  if (value.startsWith('action-score:')) return 'Учтена сила признаков рекламы';
  if (value.startsWith('review-priority:')) return 'Учтена важность ручной проверки';
  if (value.startsWith('classifier:')) return 'Дополнительная проверка смысла сообщения';
  return 'Дополнительное основание для проверки';
}

export function commercialReviewCohortName(value: string): string {
  return cohortNames[value] ?? 'Дополнительная проверка сообщения';
}
