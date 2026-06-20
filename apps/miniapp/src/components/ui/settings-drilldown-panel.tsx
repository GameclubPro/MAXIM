import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { useNativeBackHandler } from '../../lib/native-back';
import { useKeyboardOpen } from '../../lib/use-keyboard-open';

type DrilldownScrollLockState = {
  bodyOverflow: string;
  documentOverflow: string;
};

type SettingsDrilldownPanelProps = {
  id: string;
  open: boolean;
  title: string;
  summary?: string;
  variant?: 'sheet' | 'screen';
  tone?: 'sky' | 'mint' | 'amber' | 'rose' | 'ink';
  onClose: () => void;
  children: ReactNode;
  className?: string;
  overlayClassName?: string;
  footer?: ReactNode;
  keepFooterVisibleWhenKeyboardOpen?: boolean;
};

let activeDrilldownLocks = 0;
let drilldownScrollLockState: DrilldownScrollLockState | null = null;
let drilldownUnlockFrame: number | null = null;

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

  if (typeof window !== 'undefined' && window.__MAXIM_FORCE_NATIVE_VISUAL_MODE__ === true) {
    return document.body;
  }

  return document.querySelector('.design-preview__device-screen') ?? document.body;
}

function cancelScheduledDrilldownUnlock(): void {
  if (drilldownUnlockFrame === null || typeof window === 'undefined') {
    return;
  }

  window.cancelAnimationFrame(drilldownUnlockFrame);
  drilldownUnlockFrame = null;
}

function restoreDrilldownScrollLock(): void {
  drilldownUnlockFrame = null;

  if (activeDrilldownLocks > 0 || !drilldownScrollLockState) {
    return;
  }

  const { body, documentElement } = document;
  body.classList.remove('settings-drilldown-open');
  body.style.overflow = drilldownScrollLockState.bodyOverflow;
  documentElement.style.overflow = drilldownScrollLockState.documentOverflow;
  drilldownScrollLockState = null;
}

function acquireDrilldownScrollLock(): void {
  cancelScheduledDrilldownUnlock();

  if (activeDrilldownLocks === 0) {
    const { body, documentElement } = document;
    drilldownScrollLockState ??= {
      bodyOverflow: body.style.overflow,
      documentOverflow: documentElement.style.overflow,
    };
    body.classList.add('settings-drilldown-open');
    body.style.overflow = 'hidden';
    documentElement.style.overflow = 'hidden';
  }

  activeDrilldownLocks += 1;
}

function releaseDrilldownScrollLock(): void {
  activeDrilldownLocks = Math.max(0, activeDrilldownLocks - 1);

  if (activeDrilldownLocks > 0 || drilldownUnlockFrame !== null || typeof window === 'undefined') {
    return;
  }

  drilldownUnlockFrame = window.requestAnimationFrame(restoreDrilldownScrollLock);
}

export function SettingsDrilldownPanel({
  id,
  open,
  title,
  summary,
  variant = 'sheet',
  tone = 'sky',
  onClose,
  children,
  className,
  overlayClassName,
  footer,
  keepFooterVisibleWhenKeyboardOpen = false,
}: SettingsDrilldownPanelProps) {
  const backdropRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const isKeyboardOpen = useKeyboardOpen(120, open);

  useNativeBackHandler(
    () => {
      onClose();
      return true;
    },
    { enabled: open, priority: 620 },
  );

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    acquireDrilldownScrollLock();

    return () => {
      releaseDrilldownScrollLock();
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
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
    <div
      className={cn(
        'settings-drilldown',
        variant === 'screen' && 'settings-drilldown--screen',
        overlayClassName,
      )}
      aria-hidden={!open}
    >
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
