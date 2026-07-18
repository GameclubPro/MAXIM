import { Copy, EditPencil, MoreHoriz, Pause, Play, RefreshDouble, Xmark } from 'iconoir-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MaxMarkdownPreview } from '../../components/max-markdown-preview';
import { cn } from '../../lib/cn';
import { isTopmostModalDialog, useDialogFocusTrap } from '../../lib/dialog-focus';
import { useNativeBackHandler } from '../../lib/native-back';

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
  editLabel?: string;
  cancelLabel?: string;
  onPause?: () => void;
  onEdit?: () => void;
  onResume?: () => void;
  onRetry?: () => void;
  onDuplicate?: () => void;
  onCancel?: () => void;
  footer?: ReactNode;
};

function resolvePublicationActionMenuPortalTarget(): Element | null {
  if (typeof document === 'undefined') {
    return null;
  }
  return document.querySelector('.design-preview__device-screen') ?? document.body;
}

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
  editLabel = 'Изменить публикацию',
  cancelLabel = 'Отменить публикацию',
  onPause,
  onEdit,
  onResume,
  onRetry,
  onDuplicate,
  onCancel,
  footer,
}: PublicationFeedCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuPanelRef = useRef<HTMLElement | null>(null);
  const firstActionRef = useRef<HTMLButtonElement | null>(null);
  const menuTitleId = useId();
  const hasMenu = canEdit || canPause || canResume || canRetry || canDuplicate || canCancel;
  const primaryActionLabel = primaryAction ? `${primaryAction.label}: ${title}` : undefined;
  const [audience, schedule, ...additionalMeta] = meta;
  const scheduleLabel = schedule?.replace(/^Следующая · /u, '') ?? null;
  const menuPortalTarget = menuOpen ? resolvePublicationActionMenuPortalTarget() : null;

  useEffect(() => {
    if (busy) {
      setMenuOpen(false);
    }
  }, [busy]);

  useDialogFocusTrap(menuOpen, menuPanelRef, firstActionRef);
  useNativeBackHandler(
    () => {
      setMenuOpen(false);
      return true;
    },
    { enabled: menuOpen, priority: 710 },
  );

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }
    const previousBodyOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      const panel = menuPanelRef.current;
      if (event.key !== 'Escape' || !panel || !isTopmostModalDialog(panel)) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      setMenuOpen(false);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  function runMenuAction(action: () => void) {
    setMenuOpen(false);
    action();
  }

  const menuActions: Array<{
    key: string;
    label: string;
    icon: ReactNode;
    danger?: boolean;
    onClick: () => void;
  }> = [];
  if (canEdit && onEdit) {
    menuActions.push({
      key: 'edit',
      label: editLabel,
      icon: <EditPencil aria-hidden />,
      onClick: onEdit,
    });
  }
  if (canResume && onResume) {
    menuActions.push({
      key: 'resume',
      label: 'Запустить',
      icon: <Play aria-hidden />,
      onClick: onResume,
    });
  }
  if (canPause && onPause) {
    menuActions.push({
      key: 'pause',
      label: 'Пауза',
      icon: <Pause aria-hidden />,
      onClick: onPause,
    });
  }
  if (canRetry && onRetry) {
    menuActions.push({
      key: 'retry',
      label: 'Повторить',
      icon: <RefreshDouble aria-hidden />,
      onClick: onRetry,
    });
  }
  if (canDuplicate && onDuplicate) {
    menuActions.push({
      key: 'duplicate',
      label: 'Дублировать',
      icon: <Copy aria-hidden />,
      onClick: onDuplicate,
    });
  }
  if (canCancel && onCancel) {
    menuActions.push({
      key: 'cancel',
      label: cancelLabel,
      icon: <Xmark aria-hidden />,
      danger: true,
      onClick: onCancel,
    });
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
        <button
          type="button"
          className="publication-feed-card__menu-trigger"
          aria-label={`Действия: ${title}`}
          title="Действия"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(true)}
          disabled={busy}
        >
          <MoreHoriz aria-hidden focusable="false" />
        </button>
      ) : null}

      {menuPortalTarget
        ? createPortal(
            <div className="publication-action-menu">
              <button
                type="button"
                className="publication-action-menu__backdrop"
                onClick={() => setMenuOpen(false)}
                aria-label="Закрыть меню действий"
                tabIndex={-1}
              />
              <section
                ref={menuPanelRef}
                className="publication-action-menu__panel"
                role="dialog"
                aria-modal="true"
                aria-labelledby={menuTitleId}
                tabIndex={-1}
              >
                <div className="publication-action-menu__grabber" aria-hidden />
                <header className="publication-action-menu__header">
                  <span>
                    <strong id={menuTitleId}>Действия</strong>
                    <small>{title}</small>
                  </span>
                  <button
                    type="button"
                    onClick={() => setMenuOpen(false)}
                    aria-label="Закрыть меню"
                  >
                    <Xmark aria-hidden />
                  </button>
                </header>
                <div className="publication-action-menu__actions">
                  {menuActions.map((action, index) => (
                    <button
                      ref={index === 0 ? firstActionRef : undefined}
                      key={action.key}
                      type="button"
                      className={cn(action.danger && 'is-danger')}
                      onClick={() => runMenuAction(action.onClick)}
                      disabled={busy}
                    >
                      {action.icon}
                      <span>{action.label}</span>
                    </button>
                  ))}
                </div>
              </section>
            </div>,
            menuPortalTarget,
          )
        : null}
    </article>
  );
}
