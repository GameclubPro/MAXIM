import type { VkParsingPost, VkParsingSource } from '@maxim/contracts';
import { describeApiError } from '../../lib/api-error';

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

const UNSUPPORTED_ATTACHMENT_LABELS: Record<string, string> = {
  article: 'Статья',
  audio: 'Аудио',
  audio_playlist: 'Плейлист',
  clip: 'Клип',
  copy_history: 'Репост',
  doc: 'Документ',
  event: 'Событие',
  market: 'Товар',
  market_album: 'Подборка товаров',
  page: 'Страница',
  photo: 'Фото',
  photos_list: 'Список фото',
  podcast: 'Подкаст',
  poll: 'Опрос',
  video: 'Видео',
  video_playlist: 'Плейлист видео',
};

const TECHNICAL_ERROR_PATTERN =
  /\b(?:api|rps|p95|worker|rollback|dry[- ]?run|prisma|redis|bullmq|sql|stack|exception|invalid|failed|content-length|econn\w*|etimedout|statuscode)\b|[{}[\]<>]/iu;

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
      const label = UNSUPPORTED_ATTACHMENT_LABELS[item.type.toLowerCase()] ?? 'Вложение';
      return `${label}${count}`;
    })
    .join(', ');
}

export function normalizeApiError(error: unknown): string {
  const text = describeApiError(error, '').trim();
  const normalized = text.toLowerCase();

  if (/rate[ _-]?limit|too many requests|\b429\b|ограничил(?:а|и)?\s+запрос/iu.test(text)) {
    return 'VK временно ограничил запросы. Повторите позже.';
  }
  if (
    /нет связи|не отвечает|network|failed to fetch|load failed|timeout|timed out|econn/iu.test(text)
  ) {
    return 'Нет связи с сервисом. Повторите.';
  }
  if (/unauthori[sz]ed|forbidden|\b(?:401|403)\b|сессия истекла/iu.test(text)) {
    return 'Не удалось подтвердить доступ. Откройте приложение заново.';
  }
  if (
    text &&
    /[А-Яа-яЁё]/u.test(text) &&
    !TECHNICAL_ERROR_PATTERN.test(text) &&
    !normalized.startsWith('api request failed:') &&
    text.length <= 180
  ) {
    return text;
  }

  return 'Не удалось выполнить действие. Повторите.';
}

export function formatVkSourceProblem(
  source: Pick<
    VkParsingSource,
    'autoPublishPausedReason' | 'circuitOpenedAt' | 'circuitReason' | 'lastError' | 'syncStatus'
  >,
): string | null {
  if (source.autoPublishPausedReason === 'circuit_breaker' || source.circuitOpenedAt) {
    return 'Автопубликация приостановлена.';
  }
  if (source.syncStatus === 'BACKOFF') {
    return 'VK временно ограничил обновление. Повторим автоматически.';
  }
  if (source.syncStatus === 'ERROR' || source.lastError || source.circuitReason) {
    return 'Не удалось обновить источник.';
  }

  return null;
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
  if (post.publishLockedAt) {
    const startedAt = formatVkPostDate(post.publishLockedAt);
    return {
      label: 'Публикуется',
      title: startedAt ? `Публикация началась ${startedAt}` : 'Публикация началась',
      tone: 'warning',
    };
  }

  if (post.publishQueuedAt) {
    const scheduled = post.publishScheduledAt ? formatVkPostDate(post.publishScheduledAt) : '';
    return {
      label: 'В очереди',
      title: scheduled
        ? `Запланирован на ${scheduled}`
        : `Ждёт публикации с ${formatVkPostDate(post.publishQueuedAt)}`,
      tone: 'warning',
    };
  }

  if (post.status === 'FAILED' && post.publishAttemptCount > 0) {
    return {
      label: 'Не опубликован',
      title: 'Проверьте пост и повторите публикацию.',
      tone: 'danger',
    };
  }

  return null;
}

export function formatVkPostIssue(post: VkParsingPost): VkParsingPostIssue | null {
  if (post.status !== 'FAILED') {
    return null;
  }

  const rawDetail = post.autoPublishError ?? post.lastError ?? '';
  const isMediaIssue =
    /\b(media|upload|photo|image|attachment)\b|медиа|фото|изображ|вложени/iu.test(rawDetail) ||
    post.photoUrls.length > 0;

  return {
    title: isMediaIssue ? 'Медиа не загрузилось' : 'Публикация не прошла',
    detail: isMediaIssue
      ? 'Попробуйте ещё раз или уберите недоступное вложение.'
      : 'Проверьте пост и повторите публикацию.',
    isMediaIssue,
  };
}

export function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}
