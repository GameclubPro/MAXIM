import type { PublisherPostImportSession } from '@maxim/contracts/publisher';

export type PublisherPostImportPresentation = {
  title: string;
  detail: string | null;
  tone: 'neutral' | 'ready' | 'danger';
  action: 'open-bot' | 'open-draft' | 'retry' | null;
};

function describeImportFailure(code: PublisherPostImportSession['failureCode']): string {
  switch (code) {
    case 'invalid_forward':
      return 'Перешлите исходный пост';
    case 'message_unavailable':
      return 'Пост больше недоступен';
    case 'unsupported_content':
      return 'Этот формат не поддерживается';
    case 'text_too_long':
      return 'Пост слишком длинный';
    case 'too_many_images':
      return 'В посте слишком много фото';
    case 'image_too_large':
    case 'media_too_large':
      return 'Медиа слишком большое';
    case 'media_download_failed':
      return 'Не удалось загрузить медиа';
    case 'processing_timeout':
      return 'Перенос занял слишком много времени';
    default:
      return 'Не удалось перенести пост';
  }
}

function describeImportOmissions(
  omissions: PublisherPostImportSession['omissions'],
): string | null {
  if (omissions.includes('buttons_not_imported')) {
    return 'Кнопки не перенесены';
  }
  if (omissions.includes('formatting_not_preserved')) {
    return 'Форматирование упрощено';
  }
  return null;
}

export function resolvePublisherPostImportPresentation(
  session: PublisherPostImportSession,
): PublisherPostImportPresentation | null {
  switch (session.status) {
    case 'waiting':
      return {
        title: 'Жду пост',
        detail: null,
        tone: 'neutral',
        action: session.botUrl ? 'open-bot' : null,
      };
    case 'processing':
      return { title: 'Готовлю черновик', detail: null, tone: 'neutral', action: null };
    case 'ready':
      return {
        title: 'Черновик готов',
        detail: describeImportOmissions(session.omissions),
        tone: 'ready',
        action: session.publicationId ? 'open-draft' : null,
      };
    case 'failed':
      return {
        title: describeImportFailure(session.failureCode),
        detail: null,
        tone: 'danger',
        action: 'retry',
      };
    case 'expired':
      return { title: 'Время вышло', detail: null, tone: 'neutral', action: 'retry' };
    case 'canceled':
      return null;
  }
}
