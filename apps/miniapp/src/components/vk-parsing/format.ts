import type { VkParsingPost } from '@maxim/contracts';

export type VkParsingPublishState = {
  label: string;
  title: string;
  tone: 'danger' | 'warning';
};

export type VkParsingPostIssue = {
  title: string;
  detail: string;
  isMediaIssue: boolean;
};

export function formatVkPostDate(value: string | null): string {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function formatVkSourceRetry(value: string | null): string {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function formatDurationSeconds(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }
  if (value < 60) {
    return `${value}с`;
  }
  const minutes = Math.floor(value / 60);
  if (minutes < 60) {
    return `${minutes}м`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}ч`;
}

export function formatPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '0%';
  }

  return `${Math.round(value * 100)}%`;
}

export function formatVkSourceSyncLabel(source: {
  syncStatus: string;
  nextSyncAt: string | null;
  nextRetryAt?: string | null;
  circuitOpenedAt?: string | null;
  lastError: string | null;
}): string | null {
  if (source.circuitOpenedAt) {
    return 'Требует действия';
  }
  if (source.syncStatus === 'QUEUED') {
    return 'В очереди';
  }
  if (source.syncStatus === 'SYNCING') {
    return 'Обновляется';
  }
  if (source.syncStatus === 'BACKOFF') {
    const retryAt = formatVkSourceRetry(source.nextRetryAt ?? source.nextSyncAt);
    return retryAt ? `Повтор ${retryAt}` : 'Повтор позже';
  }
  if (source.syncStatus === 'ERROR' || source.lastError) {
    return 'Ошибка';
  }

  return null;
}

export function formatUnsupportedAttachmentSummary(post: VkParsingPost): string | null {
  if (!post.unsupportedAttachments.length) {
    return null;
  }

  return post.unsupportedAttachments
    .slice(0, 3)
    .map((item) => {
      const count = item.count > 1 ? ` x${item.count}` : '';
      return `${item.label || item.type}${count}`;
    })
    .join(', ');
}

export function normalizeApiError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Не удалось выполнить действие.';
  }

  const text = error.message.trim();
  if (text.startsWith('API request failed:')) {
    return text.replace(/^API request failed:\s*\d+\s*/u, '').trim() || 'Ошибка API.';
  }

  return text || 'Не удалось выполнить действие.';
}

export function formatVkSkipReason(reason: VkParsingPost['skipReason']): string | null {
  if (reason === 'AD') {
    return 'Реклама';
  }
  if (reason === 'EMPTY_AFTER_LINK_FILTER') {
    return 'Только ссылки';
  }
  if (reason === 'NO_SUPPORTED_CONTENT') {
    return 'Без поддерживаемого контента';
  }

  return null;
}

export function formatVkPostStatus(post: VkParsingPost): string | null {
  if (post.status === 'PUBLISHED') {
    return post.autoPublishedAt ? 'Авто' : 'Опубликован';
  }
  if (post.status === 'CHANGED_AFTER_PUBLISH') {
    return 'Изменён';
  }
  if (post.status === 'UNAVAILABLE') {
    return 'Недоступен';
  }
  if (post.status === 'SKIPPED') {
    return formatVkSkipReason(post.skipReason) ?? 'Пропущен';
  }
  if (post.status === 'FAILED') {
    return 'Ошибка';
  }

  return null;
}

export function formatVkPublishState(post: VkParsingPost): VkParsingPublishState | null {
  const attemptText = post.publishAttemptCount > 0 ? `, попыток: ${post.publishAttemptCount}` : '';

  if (post.publishLockedAt) {
    return {
      label: 'Публикуется',
      title: `Забрано воркером ${formatVkPostDate(post.publishLockedAt)}${attemptText}`,
      tone: 'warning',
    };
  }

  if (post.publishQueuedAt) {
    const scheduled = post.publishScheduledAt ? formatVkPostDate(post.publishScheduledAt) : '';
    return {
      label: post.publishAttemptCount > 0 ? 'Повтор в очереди' : 'В очереди',
      title: scheduled
        ? `Запланирован на ${scheduled}${attemptText}`
        : `Ждёт публикации с ${formatVkPostDate(post.publishQueuedAt)}${attemptText}`,
      tone: 'warning',
    };
  }

  if (post.status === 'FAILED' && post.publishAttemptCount > 0) {
    return {
      label: `Попыток ${post.publishAttemptCount}`,
      title: post.lastError ?? post.autoPublishError ?? 'Публикация завершилась ошибкой',
      tone: 'danger',
    };
  }

  return null;
}

export function formatVkPostIssue(post: VkParsingPost): VkParsingPostIssue | null {
  if (post.status !== 'FAILED') {
    return null;
  }

  const rawDetail = post.autoPublishError ?? post.lastError ?? 'Публикация завершилась ошибкой.';
  const detail = rawDetail.length > 110 ? `${rawDetail.slice(0, 107)}...` : rawDetail;
  const isMediaIssue =
    /\b(media|upload|photo|image|attachment)\b|медиа|фото|изображ|вложени/iu.test(rawDetail) ||
    post.photoUrls.length > 0;

  return {
    title: isMediaIssue ? 'Медиа не загрузилось' : 'Публикация не прошла',
    detail,
    isMediaIssue,
  };
}

export function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}
