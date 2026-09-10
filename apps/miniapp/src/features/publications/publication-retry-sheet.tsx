import { RefreshDouble, Xmark } from 'iconoir-react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { PublicationRetryContentMode } from '@maxim/contracts/publication';
import { isTopmostModalDialog, useDialogFocusTrap } from '../../lib/dialog-focus';
import { useNativeBackHandler } from '../../lib/native-back';
import './publication-retry-sheet.css';

type PublicationRetrySheetProps = {
  open: boolean;
  busy?: boolean;
  onClose: () => void;
  onSelect: (mode: PublicationRetryContentMode) => void;
};

function resolvePublicationRetryPortalTarget(): Element | null {
  if (typeof document === 'undefined') {
    return null;
  }
  return document.body;
}

export function PublicationRetrySheet({
  open,
  busy = false,
  onClose,
  onSelect,
}: PublicationRetrySheetProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const firstChoiceRef = useRef<HTMLButtonElement | null>(null);
  useDialogFocusTrap(open, panelRef, firstChoiceRef);

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
    document.body.classList.add('publication-retry-sheet-open');
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.classList.remove('publication-retry-sheet-open');
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [busy, onClose, open]);

  const portalTarget = open ? resolvePublicationRetryPortalTarget() : null;
  if (!portalTarget) {
    return null;
  }

  return createPortal(
    <div className="publication-retry-sheet">
      <button
        type="button"
        className="publication-retry-sheet__backdrop"
        onClick={onClose}
        disabled={busy}
        tabIndex={-1}
        aria-label="Закрыть выбор версии"
      />
      <section
        ref={panelRef}
        className="publication-retry-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="publication-retry-title"
        tabIndex={-1}
      >
        <div className="publication-retry-sheet__grabber" aria-hidden />
        <header className="publication-retry-sheet__header">
          <strong id="publication-retry-title">Повторить отправку</strong>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Закрыть">
            <Xmark aria-hidden />
          </button>
        </header>
        <div className="publication-retry-sheet__choices">
          <button
            ref={firstChoiceRef}
            type="button"
            onClick={() => onSelect('original')}
            disabled={busy}
          >
            <RefreshDouble aria-hidden />
            <span>
              <strong>Прежний вариант</strong>
              <small>Пост на момент отправки</small>
            </span>
          </button>
          <button
            type="button"
            className="is-latest"
            onClick={() => onSelect('latest')}
            disabled={busy}
          >
            <RefreshDouble aria-hidden />
            <span>
              <strong>С последними правками</strong>
              <small>Пост с сохранёнными изменениями</small>
            </span>
          </button>
        </div>
      </section>
    </div>,
    portalTarget,
  );
}
