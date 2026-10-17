import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDialogFocusTrap } from '../lib/dialog-focus';
import { useNativeBackHandler, NATIVE_BACK_MODAL_CONFIRM_PRIORITY } from '../lib/native-back';
import { hydrateMirroredItem, readLocalMirrorItem, saveMirroredItem } from '../lib/native-storage';
import './max-incident-notice.css';

const ACKNOWLEDGEMENT_KEY = 'maxim:incident:max-2026-10-16:acknowledged:v1';
let dismissedThisSession = false;

export default function MaxIncidentNotice() {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const dismiss = useCallback(() => {
    dismissedThisSession = true;
    setOpen(false);
  }, []);

  useEffect(() => {
    if (dismissedThisSession || readLocalMirrorItem(ACKNOWLEDGEMENT_KEY) === '1') return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      cancelled = true;
    }, 1_500);
    void hydrateMirroredItem(ACKNOWLEDGEMENT_KEY).then((value) => {
      window.clearTimeout(timer);
      if (cancelled || dismissedThisSession) return;
      setOpen(value !== '1');
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    return () => dialog.close();
  }, [open]);

  useDialogFocusTrap(open, dialogRef, titleRef, returnFocusRef);
  useNativeBackHandler(
    () => {
      dismiss();
      return true;
    },
    { enabled: open, priority: NATIVE_BACK_MODAL_CONFIRM_PRIORITY },
  );

  if (!open) return null;

  return createPortal(
    <dialog
      ref={dialogRef}
      className="max-incident-notice"
      role="dialog"
      aria-modal="true"
      aria-labelledby="max-incident-notice-title"
      aria-describedby="max-incident-notice-description"
      onKeyDownCapture={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
    >
      <div className="max-incident-notice__scroll">
        <div className="max-incident-notice__masthead" aria-hidden="true">
          <span className="max-incident-notice__symbol">
            <svg viewBox="0 0 32 32" fill="none">
              <path
                d="M16 6v11m0 7v.1"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
              />
              <path
                d="M6 9a13 13 0 0 0 0 14M26 9a13 13 0 0 1 0 14"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                opacity=".45"
              />
            </svg>
          </span>
          <span className="max-incident-notice__date">С 16 октября</span>
        </div>
        <p className="max-incident-notice__eyebrow">Важное уведомление</p>
        <h2 id="max-incident-notice-title" ref={titleRef} tabIndex={-1}>
          Массовый сбой
          <br />
          на стороне MAX
        </h2>
        <div id="max-incident-notice-description" className="max-incident-notice__copy">
          <p>
            С 16 октября платформа MAX работает нестабильно: ответы API задерживаются, а часть
            событий не передаётся ботам. Это временно влияет на скорость ответов, публикации и
            выполнение отдельных действий.
          </p>
          <p className="max-incident-notice__reassurance">
            Мы следим за ситуацией и ожидаем восстановления стабильной работы MAX. Спасибо за
            терпение и понимание.
          </p>
        </div>
      </div>
      <footer className="max-incident-notice__footer">
        <button
          type="button"
          className="max-incident-notice__acknowledge"
          onClick={() => {
            saveMirroredItem(ACKNOWLEDGEMENT_KEY, '1');
            dismiss();
          }}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
            <path
              d="m5 12 4 4L19 6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Ознакомлен
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}
