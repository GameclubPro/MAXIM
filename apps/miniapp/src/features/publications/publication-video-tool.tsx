import { Refresh, VideoCamera, WarningCircle } from 'iconoir-react';
import { useId } from 'react';
import { cn } from '../../lib/cn';
import { PUBLICATION_VIDEO_MAX_SIZE_MB } from './publication-video-preparation';
import './publication-video-tool.css';

type PublicationVideoToolProps = {
  active: boolean;
  disabled: boolean;
  preparing: boolean;
  needsReselection: boolean;
  errorId?: string;
  blockedReason?: string | null;
  onFile: (file: File | undefined) => Promise<void>;
  onBlocked?: () => void;
};

export function PublicationVideoTool({
  active,
  disabled,
  preparing,
  needsReselection,
  errorId,
  blockedReason = null,
  onFile,
  onBlocked,
}: PublicationVideoToolProps) {
  const statusId = useId();
  const interactionBlocked = Boolean(blockedReason) && !disabled;
  const label = interactionBlocked
    ? blockedReason!
    : preparing
      ? 'Готовим видео'
      : needsReselection
        ? 'Выбрать видео снова'
        : 'Добавить видео';

  return (
    <span
      className={cn(
        'broadcast-content-composer__tool',
        'publication-video-tool',
        active && 'is-active',
        (needsReselection || errorId) && 'is-danger',
        interactionBlocked && 'is-blocked',
        disabled && 'is-disabled',
      )}
      aria-busy={preparing || undefined}
      title={`${label}. Максимум ${PUBLICATION_VIDEO_MAX_SIZE_MB} МБ`}
    >
      <VideoCamera aria-hidden focusable="false" />
      {preparing || needsReselection || errorId ? (
        <span
          className={cn(
            'publication-video-tool__state',
            preparing && 'is-preparing',
            (needsReselection || errorId) && 'needs-reselection',
          )}
          aria-hidden
        >
          {needsReselection || errorId ? (
            <WarningCircle aria-hidden focusable="false" />
          ) : (
            <Refresh aria-hidden focusable="false" />
          )}
        </span>
      ) : null}
      <span id={statusId} className="publication-video-tool__description">
        {label}. Максимум {PUBLICATION_VIDEO_MAX_SIZE_MB} МБ. MP4, MOV, MKV, WebM.
      </span>
      {interactionBlocked ? (
        <button
          type="button"
          className="publication-video-tool__blocker"
          aria-label={label}
          title={label}
          onClick={onBlocked}
        />
      ) : (
        <input
          type="file"
          accept="video/mp4,video/quicktime,video/x-matroska,video/webm,.mp4,.mov,.mkv,.webm"
          aria-label={label}
          aria-invalid={needsReselection || Boolean(errorId) || undefined}
          aria-describedby={[statusId, errorId].filter(Boolean).join(' ')}
          disabled={disabled}
          onChange={(event) => {
            const input = event.currentTarget;
            void onFile(input.files?.[0]).finally(() => {
              input.value = '';
            });
          }}
        />
      )}
    </span>
  );
}
