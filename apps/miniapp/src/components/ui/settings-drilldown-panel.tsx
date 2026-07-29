import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { isTopmostModalDialog, useDialogFocusTrap } from '../../lib/dialog-focus';
import { useNativeBackHandler } from '../../lib/native-back';
import { useKeyboardOpen } from '../../lib/use-keyboard-open';

const LazyActionConfirmSheet = lazy(() =>
  import('./action-confirm-sheet').then((module) => ({ default: module.ActionConfirmSheet })),
);

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
  headerAction?: ReactNode;
  footer?: ReactNode;
  keepFooterVisibleWhenKeyboardOpen?: boolean;
  confirmCloseWhen?: boolean;
  onDiscardChanges?: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
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
  headerAction,
  footer,
  keepFooterVisibleWhenKeyboardOpen = false,
  confirmCloseWhen = false,
  onDiscardChanges,
  initialFocusRef,
}: SettingsDrilldownPanelProps) {
  const backdropRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const [discardConfirmationOpen, setDiscardConfirmationOpen] = useState(false);
  const isKeyboardOpen = useKeyboardOpen(120, open);
  useDialogFocusTrap(open, panelRef, initialFocusRef ?? panelRef);

  const requestClose = useCallback(() => {
    if (confirmCloseWhen) {
      setDiscardConfirmationOpen(true);
      return;
    }

    onClose();
  }, [confirmCloseWhen, onClose]);

  useNativeBackHandler(
    () => {
      requestClose();
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
        const panel = panelRef.current;
        if (!panel || !isTopmostModalDialog(panel)) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        requestClose();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, requestClose]);

  useEffect(() => {
    if (!open || !confirmCloseWhen) {
      setDiscardConfirmationOpen(false);
    }
  }, [confirmCloseWhen, open]);

  const portalTarget = open ? resolveDrilldownPortalTarget() : null;
  if (!open || !portalTarget) {
    return null;
  }

  const titleId = `${id}-title`;
  const summaryId = summary ? `${id}-summary` : undefined;
  const shouldRenderFooter =
    Boolean(footer) && (!isKeyboardOpen || keepFooterVisibleWhenKeyboardOpen);

  return (
    <>
      {createPortal(
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
            tabIndex={-1}
            onClick={requestClose}
          />

          <section
            ref={panelRef}
            className={cn(
              'settings-drilldown__panel',
              `settings-drilldown__panel--tone-${tone}`,
              className,
            )}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={summaryId}
            tabIndex={-1}
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

              <div className="settings-drilldown__header-actions">
                {headerAction}
                <button
                  type="button"
                  className="settings-drilldown__close"
                  aria-label="Закрыть панель"
                  onClick={requestClose}
                >
                  <CloseIcon />
                </button>
              </div>
            </header>

            <div className="settings-drilldown__content">
              <div className="settings-drilldown__body">{children}</div>
              {shouldRenderFooter ? (
                <div className="settings-drilldown__footer">{footer}</div>
              ) : null}
            </div>
          </section>
        </div>,
        portalTarget,
      )}
      {discardConfirmationOpen ? (
        <Suspense fallback={null}>
          <LazyActionConfirmSheet
            id={`${id}-discard-confirmation`}
            open
            title="Не сохранять изменения?"
            summary="Изменения в этом разделе будут отменены."
            confirmLabel="Не сохранять"
            cancelLabel="Продолжить настройку"
            tone="danger"
            onClose={() => setDiscardConfirmationOpen(false)}
            onConfirm={() => {
              setDiscardConfirmationOpen(false);
              onDiscardChanges?.();
              onClose();
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
}
