import { InfoCircle } from 'iconoir-react';
import { cn } from '../../lib/cn';

export function SettingsHintAnchor<HintKey extends string>({
  hintKey,
  openHintKey,
  onToggleHint,
  label,
  children,
}: {
  hintKey: HintKey;
  openHintKey: HintKey | null;
  onToggleHint: (key: HintKey) => void;
  label: string;
  children: string;
}) {
  const isOpen = openHintKey === hintKey;

  return (
    <span className="channel-settings-hint-anchor">
      <button
        type="button"
        className={cn('settings-info-button', isOpen && 'is-open')}
        data-hint-key={hintKey}
        aria-label={label}
        title={label}
        aria-controls={`settings-hint-${hintKey}`}
        aria-describedby={isOpen ? `settings-hint-${hintKey}` : undefined}
        aria-expanded={isOpen}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onToggleHint(hintKey);
        }}
      >
        <InfoCircle aria-hidden />
      </button>
      {isOpen ? (
        <p
          id={`settings-hint-${hintKey}`}
          className="channel-settings-hint-popover"
          role="note"
          aria-label={label}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {children}
        </p>
      ) : null}
    </span>
  );
}
