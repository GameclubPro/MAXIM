import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { BackChevronIcon } from './entity-header-icons';

type SettingsDrilldownPanelProps = {
  id: string;
  open: boolean;
  title: string;
  summary?: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
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

export function SettingsDrilldownPanel({
  id,
  open,
  title,
  summary,
  onClose,
  children,
  className,
}: SettingsDrilldownPanelProps) {
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

  if (!open || typeof document === 'undefined') {
    return null;
  }

  const titleId = `${id}-title`;
  const summaryId = summary ? `${id}-summary` : undefined;

  return createPortal(
    <div className="settings-drilldown" aria-hidden={!open}>
      <button
        type="button"
        className="settings-drilldown__backdrop"
        aria-label="Закрыть панель"
        onClick={onClose}
      />

      <section
        className={cn('settings-drilldown__panel', className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={summaryId}
      >
        <header className="settings-drilldown__header">
          <button
            type="button"
            className="settings-drilldown__back"
            onClick={onClose}
            aria-label="Назад к списку настроек"
          >
            <BackChevronIcon />
            <span>Назад</span>
          </button>

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
            type="button"
            className="settings-drilldown__close"
            onClick={onClose}
            aria-label="Закрыть панель"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="settings-drilldown__body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}
