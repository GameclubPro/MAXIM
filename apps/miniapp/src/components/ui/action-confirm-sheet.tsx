import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';

type ActionConfirmSheetProps = {
  id: string;
  open: boolean;
  title: string;
  summary?: string;
  previewTitle?: ReactNode;
  previewMeta?: ReactNode;
  confirmLabel: string;
  confirmBusyLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'accent';
  isBusy?: boolean;
  extraActionLabel?: string;
  extraActionBusyLabel?: string;
  extraActionBusy?: boolean;
  extraActionDisabled?: boolean;
  onExtraAction?: () => void;
  onClose: () => void;
  onConfirm: () => void;
};

export function ActionConfirmSheet({
  id,
  open,
  title,
  summary,
  previewTitle,
  previewMeta,
  confirmLabel,
  confirmBusyLabel = 'Сохраняем...',
  cancelLabel = 'Отмена',
  tone = 'danger',
  isBusy = false,
  extraActionLabel,
  extraActionBusyLabel = '...',
  extraActionBusy = false,
  extraActionDisabled = false,
  onExtraAction,
  onClose,
  onConfirm,
}: ActionConfirmSheetProps) {
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const { body, documentElement } = document;
    const previousBodyOverflow = body.style.overflow;
    const previousDocumentOverflow = documentElement.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isBusy) {
        onClose();
      }
    };

    body.classList.add('action-confirm-sheet-open');
    body.style.overflow = 'hidden';
    documentElement.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      body.classList.remove('action-confirm-sheet-open');
      body.style.overflow = previousBodyOverflow;
      documentElement.style.overflow = previousDocumentOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isBusy, onClose, open]);

  if (!open || typeof document === 'undefined') {
    return null;
  }

  const titleId = `${id}-title`;
  const summaryId = summary ? `${id}-summary` : undefined;

  return createPortal(
    <div className="action-confirm-sheet" aria-hidden={!open}>
      <button
        type="button"
        className="action-confirm-sheet__backdrop"
        aria-label="Закрыть подтверждение"
        onClick={onClose}
        disabled={isBusy}
      />

      <section
        className={cn('action-confirm-sheet__panel', `action-confirm-sheet__panel--${tone}`)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={summaryId}
      >
        <div className="action-confirm-sheet__grabber" aria-hidden />

        <div className="action-confirm-sheet__body">
          <div className="action-confirm-sheet__head">
            <strong id={titleId}>{title}</strong>
            {summary ? <small id={summaryId}>{summary}</small> : null}
          </div>

          {previewTitle || previewMeta ? (
            <div className="action-confirm-sheet__preview">
              {previewTitle ? (
                <div className="action-confirm-sheet__preview-title">{previewTitle}</div>
              ) : null}
              {previewMeta ? (
                <div className="action-confirm-sheet__preview-meta">{previewMeta}</div>
              ) : null}
            </div>
          ) : null}

          <div className="action-confirm-sheet__actions">
            {extraActionLabel && onExtraAction ? (
              <button
                type="button"
                className="action-confirm-sheet__button action-confirm-sheet__button--ghost"
                onClick={onExtraAction}
                disabled={isBusy || extraActionBusy || extraActionDisabled}
              >
                {extraActionBusy ? extraActionBusyLabel : extraActionLabel}
              </button>
            ) : null}
            <button
              type="button"
              className="action-confirm-sheet__button action-confirm-sheet__button--ghost"
              onClick={onClose}
              disabled={isBusy}
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              className={cn(
                'action-confirm-sheet__button',
                tone === 'danger'
                  ? 'action-confirm-sheet__button--danger'
                  : 'action-confirm-sheet__button--accent',
              )}
              onClick={onConfirm}
              disabled={isBusy}
            >
              {isBusy ? confirmBusyLabel : confirmLabel}
            </button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
