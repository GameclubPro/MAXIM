import { AppIcon } from './ui/app-icon';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { isTopmostModalDialog, useDialogFocusTrap } from '../lib/dialog-focus';
import { useNativeBackHandler } from '../lib/native-back';
import { useVisualViewportOverlayStyle } from '../lib/use-visual-viewport-overlay-style';
import './admin-contact-toggle.css';
export function AdminContactPickerPanel({
  title = 'Администраторы чата',
  search,
  onSearch,
  onClose: close,
  children,
}: {
  title?: string;
  search: string;
  onSearch: (value: string) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const overlayStyle = useVisualViewportOverlayStyle(true);
  useDialogFocusTrap(true, panelRef, closeButtonRef);
  useNativeBackHandler(
    () => {
      close();
      return true;
    },
    { priority: 740 },
  );

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && panelRef.current && isTopmostModalDialog(panelRef.current)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [close]);

  const portalTarget = document.querySelector('.design-preview__device-screen') ?? document.body;
  return createPortal(
    <div className="admin-contact-picker" style={overlayStyle}>
      <button
        type="button"
        className="admin-contact-picker__backdrop"
        tabIndex={-1}
        aria-label="Закрыть выбор администратора"
        onClick={close}
      />
      <section
        ref={panelRef}
        className="admin-contact-picker__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="admin-contact-picker__header">
          <strong id={titleId}>{title}</strong>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={close}
            aria-label="Закрыть"
            title="Закрыть"
          >
            <AppIcon
              icon="Xmark"
              width="1.5em"
              height="1.5em"
              style={{ strokeWidth: 1.5 }}
              aria-hidden
            />
          </button>
        </header>
        <label className="admin-contact-picker__search">
          <AppIcon
            icon="Search"
            width="1.5em"
            height="1.5em"
            style={{ strokeWidth: 1.5 }}
            aria-hidden
          />
          <input
            type="search"
            value={search}
            maxLength={100}
            placeholder="Поиск по имени"
            aria-label="Поиск администратора"
            onChange={(event) => onSearch(event.target.value)}
          />
        </label>
        {children}
      </section>
    </div>,
    portalTarget,
  );
}
