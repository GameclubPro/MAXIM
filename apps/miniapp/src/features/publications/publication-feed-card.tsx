import { Copy, EditPencil, MoreHoriz, Pause, Play, RefreshDouble, Xmark } from 'iconoir-react';
import { useEffect, useRef, type ReactNode } from 'react';
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
  canCancel?: boolean;
  onPause?: () => void;
  onEdit?: () => void;
  onResume?: () => void;
  onRetry?: () => void;
  onDuplicate?: () => void;
  onCancel?: () => void;
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
  canCancel = false,
  onPause,
  onEdit,
  onResume,
  onRetry,
  onDuplicate,
  onCancel,
  footer,
}: PublicationFeedCardProps) {
  const menuRef = useRef<HTMLDetailsElement | null>(null);
  const hasMenu = canEdit || canPause || canResume || canRetry || canDuplicate || canCancel;
  const primaryActionLabel = primaryAction ? `${primaryAction.label}: ${title}` : undefined;
  const [audience, schedule, ...additionalMeta] = meta;
  const scheduleLabel = schedule?.replace(/^Следующая · /u, '') ?? null;

  useEffect(() => {
    if (busy) {
      menuRef.current?.removeAttribute('open');
    }
  }, [busy]);

  function runMenuAction(action: () => void) {
    menuRef.current?.removeAttribute('open');
    action();
  }

  const content = (
    <>
      <span className="publication-feed-card__head">
        <span className={cn('publication-feed-card__status', `is-${tone}`)}>
          <span aria-hidden className="publication-feed-card__status-dot" />
          {eyebrow}
        </span>
        {scheduleLabel ? (
          <span
            className="publication-feed-card__schedule"
            title={schedule ?? undefined}
            aria-label={schedule ?? undefined}
          >
            {scheduleLabel}
          </span>
        ) : null}
      </span>
      <strong className="publication-feed-card__title">{title}</strong>
      <MaxMarkdownPreview
        value={preview}
        normalizeWhitespace
        fallback={fallback}
        className="publication-feed-card__preview max-markdown-preview--clamp-2"
      />
      {audience || additionalMeta.length > 0 ? (
        <span className="publication-feed-card__meta">
          {audience ? (
            <span className="publication-feed-card__audience" title={audience}>
              {audience}
            </span>
          ) : null}
          {additionalMeta.map((item) => (
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
          aria-label={primaryActionLabel}
        >
          {content}
        </button>
      ) : (
        <div className="publication-feed-card__surface is-static">{content}</div>
      )}

      {footer ? <div className="publication-feed-card__footer">{footer}</div> : null}

      {hasMenu ? (
        <details ref={menuRef} className={cn('publication-feed-card__menu', busy && 'is-disabled')}>
          <summary
            aria-label={`Действия: ${title}`}
            title="Действия"
            aria-disabled={busy || undefined}
            tabIndex={busy ? -1 : undefined}
            onClick={(event) => {
              if (busy) {
                event.preventDefault();
              }
            }}
          >
            <MoreHoriz aria-hidden focusable="false" />
          </summary>
          <div
            className="publication-feed-card__menu-popover"
            role="group"
            aria-label={`Действия: ${title}`}
          >
            {canEdit && onEdit ? (
              <button type="button" onClick={() => runMenuAction(onEdit)} disabled={busy}>
                <EditPencil aria-hidden />
                <span>Редактировать</span>
              </button>
            ) : null}
            {canResume && onResume ? (
              <button type="button" onClick={() => runMenuAction(onResume)} disabled={busy}>
                <Play aria-hidden />
                <span>Запустить</span>
              </button>
            ) : null}
            {canPause && onPause ? (
              <button type="button" onClick={() => runMenuAction(onPause)} disabled={busy}>
                <Pause aria-hidden />
                <span>Пауза</span>
              </button>
            ) : null}
            {canRetry && onRetry ? (
              <button type="button" onClick={() => runMenuAction(onRetry)} disabled={busy}>
                <RefreshDouble aria-hidden />
                <span>Повторить</span>
              </button>
            ) : null}
            {canDuplicate && onDuplicate ? (
              <button type="button" onClick={() => runMenuAction(onDuplicate)} disabled={busy}>
                <Copy aria-hidden />
                <span>Дублировать</span>
              </button>
            ) : null}
            {canCancel && onCancel ? (
              <button
                type="button"
                className="is-danger"
                onClick={() => runMenuAction(onCancel)}
                disabled={busy}
              >
                <Xmark aria-hidden />
                <span>Отменить</span>
              </button>
            ) : null}
          </div>
        </details>
      ) : null}
    </article>
  );
}
