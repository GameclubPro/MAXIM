import { Refresh, VideoCamera, WarningCircle } from 'iconoir-react';
import { useId } from 'react';
import { cn } from '../../lib/cn';
import './publication-video-tool.css';

type PublicationVideoToolProps = {
  active: boolean;
  disabled: boolean;
  preparing: boolean;
  needsReselection: boolean;
  onFile: (file: File | undefined) => Promise<void>;
};

export function PublicationVideoTool({
  active,
  disabled,
  preparing,
  needsReselection,
  onFile,
}: PublicationVideoToolProps) {
  const statusId = useId();
  const label = preparing
    ? 'Готовим видео'
    : needsReselection
      ? 'Выбрать видео снова'
      : 'Добавить видео';

  return (
    <label
      className={cn(
        'broadcast-content-composer__tool',
        'publication-video-tool',
        active && 'is-active',
        needsReselection && 'is-danger',
        disabled && 'is-disabled',
      )}
      aria-label={label}
      aria-disabled={disabled}
      aria-busy={preparing || undefined}
      title={label}
    >
      <VideoCamera aria-hidden focusable="false" />
      {preparing || needsReselection ? (
        <span
          className={cn(
            'publication-video-tool__state',
            preparing && 'is-preparing',
            needsReselection && 'needs-reselection',
          )}
          aria-hidden
        >
          {needsReselection ? (
            <WarningCircle aria-hidden focusable="false" />
          ) : (
            <Refresh aria-hidden focusable="false" />
          )}
        </span>
      ) : null}
      {preparing || needsReselection ? (
        <span id={statusId} className="publication-video-tool__description">
          {label}
        </span>
      ) : null}
      <input
        type="file"
        accept="video/mp4,video/quicktime,video/x-matroska,video/webm,.mp4,.mov,.mkv,.webm"
        aria-label={label}
        aria-invalid={needsReselection || undefined}
        aria-describedby={preparing || needsReselection ? statusId : undefined}
        disabled={disabled}
        onChange={(event) => {
          const input = event.currentTarget;
          void onFile(input.files?.[0]).finally(() => {
            input.value = '';
          });
        }}
      />
    </label>
  );
}
