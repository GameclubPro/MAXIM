import { Camera as IconoirCamera, Xmark as IconoirXmark } from 'iconoir-react';
import type { PreparedCommentDialogAttachment } from '../lib/dialog-attachments';
import { cn } from '../lib/cn';

export default function ChannelSuggestionComposeImageGrid({
  attachments,
  preparingCount = 0,
  busy = false,
  maxImages,
  onRemove,
}: {
  attachments: PreparedCommentDialogAttachment[];
  preparingCount?: number;
  busy?: boolean;
  maxImages: number;
  onRemove: (index: number) => void;
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
      )}
      role="list"
      aria-label={`Фото: ${visibleCount}`}
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
            {previewUrl ? (
              <img src={previewUrl} alt={fileName} loading="lazy" />
            ) : (
              <IconoirCamera aria-hidden focusable="false" />
            )}

            <button
              type="button"
              className="channel-suggest-composer__image-remove"
              onClick={() => onRemove(attachmentIndex)}
              aria-label={`Убрать ${fileName}`}
            >
              <IconoirXmark aria-hidden focusable="false" />
            </button>
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
