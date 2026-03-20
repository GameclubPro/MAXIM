import { cn } from '../../lib/cn';

export type SettingsSectionIconName =
  | 'links'
  | 'rules'
  | 'greeting'
  | 'warning'
  | 'ads'
  | 'topic'
  | 'repeat'
  | 'shield'
  | 'moon'
  | 'send'
  | 'tools'
  | 'comments'
  | 'spark'
  | 'poll'
  | 'gift';

export type SettingsSectionTone = 'sky' | 'mint' | 'amber' | 'rose' | 'ink';

type SettingsSectionToggleProps = {
  title: string;
  summary?: string;
  status?: string;
  icon: SettingsSectionIconName;
  tone: SettingsSectionTone;
  open: boolean;
  controls: string;
  onClick: () => void;
};

function SettingsSectionIcon({ name }: { name: SettingsSectionIconName }) {
  if (name === 'links') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
        <path
          d="M10.1 13.9L13.9 10.1M8 15.9L6.6 17.3A3.1 3.1 0 1 1 2.2 12.9L5.5 9.6A3.1 3.1 0 0 1 9.9 14"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M16 8l1.4-1.4a3.1 3.1 0 1 1 4.4 4.4l-3.3 3.3a3.1 3.1 0 0 1-4.4-4.4"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (name === 'rules') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
        <path
          d="M7 4.8h8.7a2.5 2.5 0 0 1 2.5 2.5v9.4a2.5 2.5 0 0 1-2.5 2.5H8.3a2.5 2.5 0 0 1-2.5-2.5V6.5A1.7 1.7 0 0 1 7.5 4.8Z"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M9.2 9.1h5.6M9.2 12.2h5.6M9.2 15.3h3.4"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (name === 'greeting') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
        <path
          d="M7.8 12.4V7.8A1.8 1.8 0 0 1 9.6 6h.5c1 0 1.8.8 1.8 1.8v4.1M12 11.4V6.8A1.8 1.8 0 0 1 13.8 5h.4A1.8 1.8 0 0 1 16 6.8v6.7"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M7.8 10.6a1.8 1.8 0 0 0-3.6 0v3.1c0 2.9 2.4 5.3 5.3 5.3h4.2a5.6 5.6 0 0 0 5.6-5.6v-1.3a1.8 1.8 0 0 0-3.6 0"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (name === 'warning') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
        <path
          d="M12 8.2v5.3M12 17.2h.01M10 4.8l-6.2 10.7A2 2 0 0 0 5.5 18h13a2 2 0 0 0 1.7-3L14 4.8a2.3 2.3 0 0 0-4 0Z"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (name === 'ads') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
        <path
          d="M6.6 10.2V8.1c0-1 .8-1.8 1.8-1.8h1.2c2.1 0 4.1-.8 5.6-2.3l1.3-1.2c.5-.5 1.3-.1 1.3.6v15.2c0 .7-.8 1.1-1.3.6l-1.3-1.2c-1.5-1.5-3.5-2.3-5.6-2.3H8.4c-1 0-1.8-.8-1.8-1.8v-2.1"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M6.5 15.1l-1 2.4c-.3.7.2 1.5 1 1.5H8"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (name === 'topic') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
        <path
          d="M9.6 4.8L4.8 12l4.8 7.2M14.4 4.8L19.2 12l-4.8 7.2M12 3.8v16.4"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (name === 'repeat') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
        <path
          d="M8.2 8.2h7.4a3.2 3.2 0 0 1 0 6.4H7.7"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M10.1 4.9L6.7 8.2l3.4 3.4M15.8 15.8H8.4a3.2 3.2 0 1 1 0-6.4h7.9"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M13.9 19.1l3.4-3.3-3.4-3.4"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (name === 'shield') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
        <path
          d="M12 3.8 18.1 6v4.9c0 4.2-2.5 7.9-6.1 9.3-3.6-1.4-6.1-5.1-6.1-9.3V6L12 3.8Z"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M9.1 10.2h5.8M9.1 13.2h5.8"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (name === 'moon') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
        <path
          d="M15.9 4.8a7.7 7.7 0 1 0 3.3 14.6A8.6 8.6 0 1 1 15.9 4.8Z"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (name === 'send') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
        <path
          d="M21 4 10.5 14.5M21 4l-6.8 16.1a.6.6 0 0 1-1.1 0L10.4 14.5 4 11.9a.6.6 0 0 1 0-1.1L20 4.1A.6.6 0 0 1 21 4Z"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (name === 'tools') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
        <path
          d="M14.8 5.2a4 4 0 0 0-5.4 5.1l-4.2 4.2a1.7 1.7 0 1 0 2.4 2.4l4.2-4.2a4 4 0 0 0 5.1-5.4l-2 2-1.9-.4-.4-1.9 2.2-1.8Z"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (name === 'comments') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
        <path
          d="M7 6.5h10A3.5 3.5 0 0 1 20.5 10v4a3.5 3.5 0 0 1-3.5 3.5h-4.8L8 21v-3.5H7A3.5 3.5 0 0 1 3.5 14v-4A3.5 3.5 0 0 1 7 6.5Z"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M9 11.2h6M9 14h4.1"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (name === 'spark') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
        <path
          d="m12 3.8 1.9 4.8 4.8 1.9-4.8 1.9-1.9 4.8-1.9-4.8-4.8-1.9 4.8-1.9L12 3.8ZM18.4 15.4l.8 2 .8.8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (name === 'poll') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
        <path
          d="M6.5 18.5V11M12 18.5V6.5M17.5 18.5V13.5"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M4.5 20h15"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (name === 'gift') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
        <path
          d="M5.5 10.2h13v8.1a1.7 1.7 0 0 1-1.7 1.7H7.2a1.7 1.7 0 0 1-1.7-1.7v-8.1ZM4.2 7.7A2.2 2.2 0 0 1 6.4 5.5H17.6a2.2 2.2 0 1 1 0 4.4H6.4a2.2 2.2 0 0 1-2.2-2.2Z"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M12 5.5v14.5M5.5 10.2h13M9.2 5.5c-.9-.7-2.4-1.9-2.4-3a1.7 1.7 0 0 1 3.4 0c0 .9-.7 1.9-1.3 3ZM14.8 5.5c.9-.7 2.4-1.9 2.4-3a1.7 1.7 0 1 0-3.4 0c0 .9.7 1.9 1.3 3Z"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
      <path
        d="M12 4.6a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 0 1 0-6.8Z"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.3 9.6 4.8 8.1l-1.6 2.8 2 1.1a7.2 7.2 0 0 0 0 2.1l-2 1.1 1.6 2.8 1.9-1a7.6 7.6 0 0 0 1.8 1l.3 2.1H12m0-15.3 1.3-1.5 2.8 1.6-1 2a7 7 0 0 1 1.7 1l1.9-1 1.6 2.8-2 1.1c.1.7.1 1.4 0 2.1l2 1.1-1.6 2.8-1.9-1a7 7 0 0 1-1.7 1l-1 2H12"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SettingsSectionToggle({
  title,
  summary,
  status,
  icon,
  tone,
  open,
  controls,
  onClick,
}: SettingsSectionToggleProps) {
  const trimmedSummary = summary?.trim() ?? '';
  const hasSummary = trimmedSummary.length > 0;
  const trimmedStatus = status?.trim() ?? '';
  const hasStatus = trimmedStatus.length > 0;

  return (
    <button
      type="button"
      className={cn(
        'settings-section__toggle',
        !hasSummary && 'is-compact',
        !hasStatus && 'is-stateless',
      )}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onClick}
    >
      <span className="settings-section__toggle-top">
        <span className={cn('settings-section__icon-badge', `is-${tone}`)} aria-hidden>
          <SettingsSectionIcon name={icon} />
        </span>
        {hasStatus ? (
          <span className={cn('settings-section__status-chip', `is-${tone}`)}>{trimmedStatus}</span>
        ) : null}
      </span>

      <span className="settings-section__toggle-main">
        <h3>{title}</h3>
        {hasSummary ? <small>{trimmedSummary}</small> : null}
      </span>
    </button>
  );
}
