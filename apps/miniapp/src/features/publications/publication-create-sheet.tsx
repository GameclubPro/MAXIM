import { EditPencil, Forward, Xmark } from 'iconoir-react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { isTopmostModalDialog, useDialogFocusTrap } from '../../lib/dialog-focus';
import { useNativeBackHandler } from '../../lib/native-back';
import './publication-create-sheet.css';

type PublicationCreateSheetProps = {
  open: boolean;
  busy?: boolean;
  onClose: () => void;
  onWrite: () => void;
  onForward: () => void;
};

function resolvePublicationCreatePortalTarget(): Element | null {
  if (typeof document === 'undefined') {
    return null;
  }
  return document.querySelector('.design-preview__device-screen') ?? document.body;
}

export function PublicationCreateSheet({
  open,
  busy = false,
  onClose,
  onWrite,
  onForward,
}: PublicationCreateSheetProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const firstActionRef = useRef<HTMLButtonElement | null>(null);

  useDialogFocusTrap(open, panelRef, firstActionRef);
  useNativeBackHandler(
    () => {
      if (!busy) {
        onClose();
      }
      return true;
    },
    { enabled: open, priority: 730 },
  );

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (event.key !== 'Escape' || !panel || !isTopmostModalDialog(panel)) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!busy) {
        onClose();
      }
    };

    document.body.classList.add('publication-create-sheet-open');
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.classList.remove('publication-create-sheet-open');
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [busy, onClose, open]);

  const portalTarget = open ? resolvePublicationCreatePortalTarget() : null;
  if (!portalTarget) {
    return null;
  }

  return createPortal(
    <div className="publication-create-sheet">
      <button
        type="button"
        className="publication-create-sheet__backdrop"
        onClick={onClose}
        disabled={busy}
        tabIndex={-1}
        aria-label="Закрыть выбор способа"
      />
      <section
        ref={panelRef}
        className="publication-create-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="publication-create-title"
        tabIndex={-1}
      >
        <div className="publication-create-sheet__grabber" aria-hidden />
        <header className="publication-create-sheet__header">
          <strong id="publication-create-title">Новый пост</strong>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Закрыть">
            <Xmark aria-hidden />
          </button>
        </header>
        <div className="publication-create-sheet__actions">
          <button ref={firstActionRef} type="button" onClick={onWrite} disabled={busy}>
            <EditPencil aria-hidden />
            <span>Написать</span>
          </button>
          <button type="button" onClick={onForward} disabled={busy}>
            <Forward aria-hidden />
            <span>{busy ? 'Открываю...' : 'Переслать'}</span>
          </button>
        </div>
      </section>
    </div>,
    portalTarget,
  );
}
