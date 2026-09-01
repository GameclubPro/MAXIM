import { Refresh, VideoCamera, WarningCircle } from 'iconoir-react';
import { useId } from 'react';
import { cn } from '../../lib/cn';
import './publication-video-tool.css';

type PublicationVideoToolProps = {
  active: boolean;
  disabled: boolean;
  preparing: boolean;
  needsReselection: boolean;
  blockedReason?: string | null;
  onFile: (file: File | undefined) => Promise<void>;
  onBlocked?: () => void;
};

export function PublicationVideoTool({
  active,
  disabled,
  preparing,
  needsReselection,
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
        needsReselection && 'is-danger',
        interactionBlocked && 'is-blocked',
        disabled && 'is-disabled',
      )}
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
      )}
    </span>
  );
}
