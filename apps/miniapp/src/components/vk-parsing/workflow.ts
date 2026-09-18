import type {
  UpdateVkParsingSourceRequest,
  VkParsingPost,
  VkParsingSettings,
  VkParsingSource,
} from '@maxim/contracts';

export function vkSourceLinkKey(value: string): string {
  const input = value.trim().replace(/^@/u, '');
  try {
    const url = new URL(
      /^https?:\/\//iu.test(input)
        ? input
        : input.includes('/')
          ? `https://${input}`
          : `https://vk.ru/${input}`,
    );
    const host = url.hostname.toLowerCase().replace(/^(?:www\.|m\.)/u, '');
    if (host !== 'vk.com' && host !== 'vk.ru') return '';
    return url.pathname.split('/').filter(Boolean)[0]?.toLowerCase() ?? '';
  } catch {
    return '';
  }
}

export function vkAllDayScheduleUpdate() {
  return {
    workHoursStart: '00:00',
    workHoursEnd: '00:00',
    quietHoursStart: null,
    quietHoursEnd: null,
  };
}

export type VkSourceDeliveryMode = 'MANUAL' | 'QUEUE' | 'IMMEDIATE' | 'BOT_REVIEW' | 'REVIEW';

export function resolveSourceDeliveryMode(
  source: Pick<VkParsingSource, 'publishMode' | 'autoPublishEnabled'>,
): VkSourceDeliveryMode {
  if (source.publishMode === 'BOT_REVIEW' || source.publishMode === 'REVIEW')
    return source.publishMode;
  return source.autoPublishEnabled ? source.publishMode : 'MANUAL';
}

export function buildSourceDeliveryUpdate(
  mode: VkSourceDeliveryMode,
): UpdateVkParsingSourceRequest {
  return {
    publishMode: mode === 'MANUAL' ? 'QUEUE' : mode,
    autoPublishEnabled: mode === 'QUEUE' || mode === 'IMMEDIATE',
  };
}

export function describeVkSource(
  source: VkParsingSource,
  settings: Pick<VkParsingSettings, 'autoPublishEnabled' | 'autoPublishKillSwitchEnabled'>,
) {
  if (!source.importEnabled) return { label: 'На паузе', tone: 'muted' } as const;
  if (source.syncStatus === 'ERROR' || source.circuitOpenedAt)
    return { label: 'Нужна проверка', tone: 'danger' } as const;
  if (source.syncStatus === 'SYNCING' || source.syncStatus === 'QUEUED')
    return { label: 'Обновляется', tone: 'warning' } as const;
  if (source.syncStatus === 'BACKOFF') return { label: 'Повторим позже', tone: 'warning' } as const;
  if (source.publishMode === 'BOT_REVIEW') return { label: 'В личку', tone: 'review' } as const;
  if (source.autoPublishPausedReason === 'circuit_breaker')
    return { label: 'Сработала защита', tone: 'danger' } as const;
  if (source.publishMode === 'REVIEW') return { label: 'На проверку', tone: 'review' } as const;
  if (
    source.autoPublishEnabled &&
    settings.autoPublishEnabled &&
    !settings.autoPublishKillSwitchEnabled &&
    !source.autoPublishPausedAt
  ) {
    return {
      label: source.publishMode === 'IMMEDIATE' ? 'Авто · сразу' : 'Авто · по очереди',
      tone: 'success',
    } as const;
  }
  return { label: 'В приложении', tone: 'muted' } as const;
}

export function vkPostBlockedReason(
  post: Pick<
    VkParsingPost,
    'lastError' | 'autoPublishError' | 'publishLockedAt' | 'publishQueuedAt' | 'botReview'
  >,
): string | null {
  const errors = [post.lastError, post.autoPublishError].map((error) => error?.trim() ?? '');
  if (errors.some((error) => error.startsWith('[max.send_ambiguous]')))
    return 'Сначала проверьте, появился ли пост в MAX. Повторная отправка остановлена.';
  if (errors.some((error) => error.startsWith('[max.send_confirmed_persistence_pending]')))
    return 'Пост уже отправлен. Подтверждаем результат.';
  if (post.botReview?.deliveryState === 'AMBIGUOUS')
    return 'Проверьте сообщение в личке. Повторная отправка остановлена.';
  if (post.publishLockedAt) return 'Пост отправляется.';
  if (post.publishQueuedAt) return 'Пост уже в очереди.';
  return null;
}

export function vkReviewLabel(post: Pick<VkParsingPost, 'botReview'>): string {
  const review = post.botReview;
  if (!review) return 'Готов к согласованию';
  if (review.status === 'REJECTED') return 'Отклонён';
  if (review.status === 'APPROVED') return 'Одобрен';
  if (review.status === 'CANCELLED') return 'Согласование отменено';
  if (review.deliveryState === 'AMBIGUOUS') return 'Проверьте личку';
  if (review.deliveryState === 'ERROR') return 'Не удалось отправить';
  if (review.deliveryState === 'DELIVERED') return 'Ждёт вашего решения';
  return 'Отправляем на согласование';
}

export function vkDraftFingerprint(draft: {
  text: string;
  textFormat: string;
  photoUrls: string[];
  videoUrls: string[];
  linkUrls: string[];
}): string {
  return JSON.stringify(draft);
}
