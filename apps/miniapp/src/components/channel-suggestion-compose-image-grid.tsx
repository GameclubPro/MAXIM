import {
  ArrowLeft,
  ArrowRight,
  Camera as IconoirCamera,
  Xmark as IconoirXmark,
} from 'iconoir-react';
import type { PreparedSuggestionAttachment } from '../lib/channel-suggestion-media';
import { formatDialogAttachmentSize } from '../lib/dialog-attachments';
import { cn } from '../lib/cn';

export default function ChannelSuggestionComposeImageGrid({
  attachments,
  preparingCount = 0,
  busy = false,
  maxImages,
  onRemove,
  onMove,
  preview = false,
}: {
  attachments: PreparedSuggestionAttachment[];
  preparingCount?: number;
  busy?: boolean;
  maxImages: number;
  onRemove: (index: number) => void;
  onMove?: (index: number, direction: -1 | 1) => void;
  preview?: boolean;
}) {
  const cappedPreparingCount = Math.max(
    0,
    Math.min(preparingCount, maxImages - attachments.length),
  );
  const visibleCount = Math.min(attachments.length + cappedPreparingCount, maxImages);

  return (
    <div
      className={cn(
        'channel-suggest-composer__image-grid',
        `is-count-${visibleCount}`,
        busy && 'is-busy',
        preview && 'is-preview',
      )}
      role="list"
      aria-label={`Вложения: ${visibleCount}`}
    >
      {attachments.map((attachment, attachmentIndex) => {
        const previewUrl = attachment.previewUrl?.trim() ?? '';
        const fileName = attachment.fileName?.trim() || `Фото ${attachmentIndex + 1}`;

        return (
          <div
            key={`${fileName}-${attachmentIndex}`}
            className={cn('channel-suggest-composer__image-tile', busy && 'is-uploading')}
            role="listitem"
            aria-label={fileName}
          >
            {attachment.type === 'video' && previewUrl ? (
              <video
                src={previewUrl}
                controls
                playsInline
                preload="metadata"
                aria-label={fileName}
              />
            ) : previewUrl ? (
              <img src={previewUrl} alt={fileName} loading="lazy" />
            ) : (
              <IconoirCamera aria-hidden focusable="false" />
            )}

            {!preview ? (
              <button
                type="button"
                className="channel-suggest-composer__image-remove"
                disabled={busy}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => onRemove(attachmentIndex)}
                aria-label={`Убрать ${fileName}`}
                title={`Убрать ${fileName}`}
              >
                <IconoirXmark aria-hidden focusable="false" />
              </button>
            ) : null}
            <div className="channel-suggest-composer__image-caption">
              <span>
                {attachment.type === 'video' ? 'Видео' : `Фото ${attachmentIndex + 1}`} ·{' '}
                {formatDialogAttachmentSize(attachment.size)}
              </span>
              {!preview && attachments.length > 1 && onMove ? (
                <span className="channel-suggest-composer__image-order">
                  <button
                    type="button"
                    disabled={busy || attachmentIndex === 0}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => onMove(attachmentIndex, -1)}
                    aria-label={`Переместить фото ${attachmentIndex + 1} раньше`}
                    title="Переместить раньше"
                  >
                    <ArrowLeft aria-hidden />
                  </button>
                  <button
                    type="button"
                    disabled={busy || attachmentIndex === attachments.length - 1}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => onMove(attachmentIndex, 1)}
                    aria-label={`Переместить фото ${attachmentIndex + 1} позже`}
                    title="Переместить позже"
                  >
                    <ArrowRight aria-hidden />
                  </button>
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
      {Array.from({ length: cappedPreparingCount }, (_, index) => (
        <div
          key={`preparing-${index}`}
          className="channel-suggest-composer__image-tile is-loading"
          role="listitem"
          aria-label="Готовим фото"
        >
          <span className="channel-suggest-composer__image-loader" aria-hidden>
            <IconoirCamera aria-hidden focusable="false" />
          </span>
        </div>
      ))}
    </div>
  );
}
