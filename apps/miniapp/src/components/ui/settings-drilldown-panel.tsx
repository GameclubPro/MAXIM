import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { useKeyboardOpen } from '../../lib/use-keyboard-open';

type SettingsDrilldownPanelProps = {
  id: string;
  open: boolean;
  title: string;
  summary?: string;
  tone?: 'sky' | 'mint' | 'amber' | 'rose' | 'ink';
  onClose: () => void;
  children: ReactNode;
  className?: string;
  footer?: ReactNode;
  keepFooterVisibleWhenKeyboardOpen?: boolean;
};

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M5.5 5.5L14.5 14.5M14.5 5.5L5.5 14.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function resolveDrilldownPortalTarget(): Element | null {
  if (typeof document === 'undefined') {
    return null;
  }

  return document.querySelector('.design-preview__device-screen') ?? document.body;
}

export function SettingsDrilldownPanel({
  id,
  open,
  title,
  summary,
  tone = 'sky',
  onClose,
  children,
  className,
  footer,
  keepFooterVisibleWhenKeyboardOpen = false,
}: SettingsDrilldownPanelProps) {
  const backdropRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const isKeyboardOpen = useKeyboardOpen(120, open);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const { body, documentElement } = document;
    const previousBodyOverflow = body.style.overflow;
    const previousDocumentOverflow = documentElement.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    body.classList.add('settings-drilldown-open');
    body.style.overflow = 'hidden';
    documentElement.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      body.classList.remove('settings-drilldown-open');
      body.style.overflow = previousBodyOverflow;
      documentElement.style.overflow = previousDocumentOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleNativeClose = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };

    const backdrop = backdropRef.current;
    const closeButton = closeButtonRef.current;

    backdrop?.addEventListener('click', handleNativeClose);
    closeButton?.addEventListener('click', handleNativeClose);

    return () => {
      backdrop?.removeEventListener('click', handleNativeClose);
      closeButton?.removeEventListener('click', handleNativeClose);
    };
  }, [onClose, open]);

  const portalTarget = open ? resolveDrilldownPortalTarget() : null;
  if (!open || !portalTarget) {
    return null;
  }

  const titleId = `${id}-title`;
  const summaryId = summary ? `${id}-summary` : undefined;
  const shouldRenderFooter =
    Boolean(footer) && (!isKeyboardOpen || keepFooterVisibleWhenKeyboardOpen);

  return createPortal(
    <div className="settings-drilldown" aria-hidden={!open}>
      <button
        ref={backdropRef}
        type="button"
        className="settings-drilldown__backdrop"
        aria-label="Закрыть панель"
      />

      <section
        className={cn(
          'settings-drilldown__panel',
          `settings-drilldown__panel--tone-${tone}`,
          className,
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={summaryId}
      >
        <header className="settings-drilldown__header">
          <div className="settings-drilldown__title-wrap">
            <h3 id={titleId} className="settings-drilldown__title">
              {title}
            </h3>
            {summary ? (
              <p id={summaryId} className="settings-drilldown__summary">
                {summary}
              </p>
            ) : null}
          </div>

          <button
            ref={closeButtonRef}
            type="button"
            className="settings-drilldown__close"
            aria-label="Закрыть панель"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="settings-drilldown__content">
          <div className="settings-drilldown__body">{children}</div>
          {shouldRenderFooter ? <div className="settings-drilldown__footer">{footer}</div> : null}
        </div>
      </section>
    </div>,
    portalTarget,
  );
}
