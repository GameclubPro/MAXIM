import type { ChannelDialogMessage } from '@maxim/contracts/channel-dialog';
import { Attachment as IconoirAttachment } from 'iconoir-react';
import { resolveSuggestionStatus } from '../lib/channel-suggestion-status';
import { cn } from '../lib/cn';
import { MaxMarkdownPreview } from './max-markdown-preview';

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function resolveSuggestionText(message: ChannelDialogMessage): string {
  const normalized = message.text.trim();
  if (normalized) {
    return normalized;
  }

  if (message.hasVideo && !message.hasImage) {
    return 'Предложение отправлено только с видео.';
  }

  const imageCount = Math.max(
    message.imageCount ?? 0,
    message.imageFileNames?.length ?? 0,
    message.imageFileName ? 1 : 0,
  );
  if (imageCount > 1) {
    return `Предложение отправлено с ${imageCount} фото.`;
  }

  if (message.hasImage && !message.hasVideo) {
    return 'Предложение отправлено только с фото.';
  }

  return 'Предложение отправлено только с медиа.';
}

function resolveSuggestionAttachmentLabel(message: ChannelDialogMessage): string {
  if (message.hasVideo) {
    const fileName = message.videoFileName?.trim();
    return fileName ? `Видео · ${fileName}` : 'Видео приложено';
  }

  const imageCount = Math.max(
    message.imageCount ?? 0,
    message.imageFileNames?.length ?? 0,
    message.imageFileName ? 1 : 0,
  );
  if (imageCount > 1) {
    return `Фото · ${imageCount} шт.`;
  }

  const fileName = message.imageFileName?.trim();
  return fileName ? `Фото · ${fileName}` : 'Фото приложено';
}

export default function ChannelSuggestionHistory({
  messages,
}: {
  messages: ChannelDialogMessage[];
}) {
  return (
    <div className="channel-suggest-list channel-suggest-list--history">
      {messages.map((message) => {
        const status = resolveSuggestionStatus(message);
        const suggestionText = resolveSuggestionText(message);
        const hasSuggestionText = message.text.trim().length > 0;
        const hasMedia =
          message.hasImage ||
          message.hasVideo ||
          Boolean(message.imageFileName || message.videoFileName);

        return (
          <article key={message.id} className={cn('channel-suggest-card', `is-${status.tone}`)}>
            <div className="channel-suggest-card__head">
              <span className={cn('channel-suggest-status', `is-${status.tone}`)}>
                {status.badge}
              </span>
              <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
            </div>

            <p className={cn(!hasSuggestionText && 'is-muted')}>
              {hasSuggestionText && message.textFormat === 'markdown' ? (
                <MaxMarkdownPreview value={message.text} preserveLinks fallback={suggestionText} />
              ) : (
                suggestionText
              )}
            </p>

            {hasMedia ? (
              <span className="channel-suggest-card__media">
                <IconoirAttachment aria-hidden focusable="false" />
                {resolveSuggestionAttachmentLabel(message)}
              </span>
            ) : null}

            {status.detail ? (
              <p className="channel-suggest-card__status-detail">{status.detail}</p>
            ) : null}

            {message.publishedUrl ? (
              <a
                className="channel-suggest-card__link"
                href={message.publishedUrl}
                target="_blank"
                rel="noreferrer"
              >
                Открыть пост
              </a>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
