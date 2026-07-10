import { Copy, EditPencil, MoreHoriz, Pause, Play, RefreshDouble, Trash } from 'iconoir-react';
import type { ReactNode } from 'react';
import { MaxMarkdownPreview } from '../../components/max-markdown-preview';
import { cn } from '../../lib/cn';

export type PublicationFeedTone = 'active' | 'warning' | 'danger' | 'muted';

type PublicationFeedCardProps = {
  id: string;
  title: string;
  preview: string;
  fallback?: string | null;
  eyebrow: string;
  meta: string[];
  tone: PublicationFeedTone;
  busy?: boolean;
  primaryAction?: { label: string; onClick: () => void } | null;
  canPause?: boolean;
  canEdit?: boolean;
  canResume?: boolean;
  canRetry?: boolean;
  canDuplicate?: boolean;
  canDelete?: boolean;
  onPause?: () => void;
  onEdit?: () => void;
  onResume?: () => void;
  onRetry?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  footer?: ReactNode;
};

export function PublicationFeedCard({
  id,
  title,
  preview,
  fallback = null,
  eyebrow,
  meta,
  tone,
  busy = false,
  primaryAction = null,
  canPause = false,
  canEdit = false,
  canResume = false,
  canRetry = false,
  canDuplicate = false,
  canDelete = false,
  onPause,
  onEdit,
  onResume,
  onRetry,
  onDuplicate,
  onDelete,
  footer,
}: PublicationFeedCardProps) {
  const hasMenu = canEdit || canPause || canResume || canRetry || canDuplicate || canDelete;
  const content = (
    <>
      <span className="publication-feed-card__head">
        <span className={cn('publication-feed-card__status', `is-${tone}`)}>{eyebrow}</span>
        <strong>{title}</strong>
      </span>
      <MaxMarkdownPreview
        value={preview}
        normalizeWhitespace
        fallback={fallback}
        className="publication-feed-card__preview max-markdown-preview--clamp-2"
      />
      {meta.length > 0 ? (
        <span className="publication-feed-card__meta">
          {meta.map((item) => (
            <span key={`${id}-${item}`}>{item}</span>
          ))}
        </span>
      ) : null}
    </>
  );

  return (
    <article className={cn('publication-feed-card', `is-${tone}`)} data-publication-id={id}>
      {primaryAction ? (
        <button
          type="button"
          className="publication-feed-card__surface"
          onClick={primaryAction.onClick}
          disabled={busy}
          aria-label={primaryAction.label}
        >
          {content}
        </button>
      ) : (
        <div className="publication-feed-card__surface is-static">{content}</div>
      )}

      {footer ? <div className="publication-feed-card__footer">{footer}</div> : null}

      {hasMenu ? (
        <details className={cn('publication-feed-card__menu', busy && 'is-disabled')}>
          <summary aria-label="Действия" title="Действия" aria-disabled={busy}>
            <MoreHoriz aria-hidden />
          </summary>
          <div className="publication-feed-card__menu-popover">
            {canEdit && onEdit ? (
              <button type="button" onClick={onEdit} disabled={busy}>
                <EditPencil aria-hidden />
                <span>Редактировать</span>
              </button>
            ) : null}
            {canResume && onResume ? (
              <button type="button" onClick={onResume} disabled={busy}>
                <Play aria-hidden />
                <span>Запустить</span>
              </button>
            ) : null}
            {canPause && onPause ? (
              <button type="button" onClick={onPause} disabled={busy}>
                <Pause aria-hidden />
                <span>Пауза</span>
              </button>
            ) : null}
            {canRetry && onRetry ? (
              <button type="button" onClick={onRetry} disabled={busy}>
                <RefreshDouble aria-hidden />
                <span>Повторить</span>
              </button>
            ) : null}
            {canDuplicate && onDuplicate ? (
              <button type="button" onClick={onDuplicate} disabled={busy}>
                <Copy aria-hidden />
                <span>Дублировать</span>
              </button>
            ) : null}
            {canDelete && onDelete ? (
              <button type="button" className="is-danger" onClick={onDelete} disabled={busy}>
                <Trash aria-hidden />
                <span>Удалить</span>
              </button>
            ) : null}
          </div>
        </details>
      ) : null}
    </article>
  );
}
