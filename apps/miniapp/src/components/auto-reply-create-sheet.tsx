import { ChatBubble, EditPencil, Xmark } from 'iconoir-react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { isTopmostModalDialog, useDialogFocusTrap } from '../lib/dialog-focus';
import { useNativeBackHandler } from '../lib/native-back';
import './auto-reply-create-sheet.css';

function resolvePortalTarget(): Element | null {
  if (typeof document === 'undefined') {
    return null;
  }
  return document.querySelector('.design-preview__device-screen') ?? document.body;
}

export function AutoReplyCreateSheet({
  open,
  busy = false,
  onClose,
  onWrite,
  onOpenBot,
}: {
  open: boolean;
  busy?: boolean;
  onClose: () => void;
  onWrite: () => void;
  onOpenBot: () => void;
}) {
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
      if (event.key !== 'Escape' || !panelRef.current || !isTopmostModalDialog(panelRef.current)) {
        return;
      }
      event.preventDefault();
      if (!busy) {
        onClose();
      }
    };
    document.body.classList.add('auto-reply-create-sheet-open');
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.classList.remove('auto-reply-create-sheet-open');
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [busy, onClose, open]);

  const portalTarget = open ? resolvePortalTarget() : null;
  if (!portalTarget) {
    return null;
  }

  return createPortal(
    <div className="auto-reply-create-sheet">
      <button
        type="button"
        className="auto-reply-create-sheet__backdrop"
        aria-label="Закрыть выбор способа"
        tabIndex={-1}
        disabled={busy}
        onClick={onClose}
      />
      <section
        ref={panelRef}
        className="auto-reply-create-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auto-reply-create-title"
        tabIndex={-1}
      >
        <div className="auto-reply-create-sheet__grabber" aria-hidden />
        <header className="auto-reply-create-sheet__header">
          <strong id="auto-reply-create-title">Новый автоответ</strong>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Закрыть">
            <Xmark aria-hidden />
          </button>
        </header>
        <div className="auto-reply-create-sheet__actions">
          <button ref={firstActionRef} type="button" onClick={onWrite} disabled={busy}>
            <EditPencil aria-hidden />
            <span>Создать здесь</span>
          </button>
          <button type="button" onClick={onOpenBot} disabled={busy}>
            <ChatBubble aria-hidden />
            <span>{busy ? 'Открываю...' : 'Открыть Публика'}</span>
          </button>
        </div>
      </section>
    </div>,
    portalTarget,
  );
}
