import { cn } from '../lib/cn';
import { BookmarkGlyph, SendGlyph, TestGlyph } from './ui/compact-icons';

export type BroadcastPublishIssueAction = {
  label: string;
  onClick: () => void;
};

type BroadcastPublishBarProps = {
  title: string;
  meta?: string;
  issues?: BroadcastPublishIssueAction[];
  busy?: boolean;
  testLabel: string;
  testAriaLabel: string;
  testDisabled: boolean;
  secondaryLabel?: string;
  secondaryDisabled?: boolean;
  onSecondary?: () => void;
  primaryLabel: string;
  primaryDisabled: boolean;
  onTest: () => void;
  onPrimary: () => void;
};

export function BroadcastPublishBar({
  title,
  meta = '',
  issues = [],
  busy = false,
  testLabel,
  testAriaLabel,
  testDisabled,
  secondaryLabel,
  secondaryDisabled = false,
  onSecondary,
  primaryLabel,
  primaryDisabled,
  onTest,
  onPrimary,
}: BroadcastPublishBarProps) {
  const showIssues = issues.length > 0 && !busy;
  const showSecondary = Boolean(secondaryLabel && onSecondary);

  return (
    <div
      className={cn(
        'broadcast-publish-bar',
        showIssues && 'has-issues',
        showSecondary && 'has-secondary',
      )}
    >
      <div className={cn('broadcast-publish-bar__copy', showIssues && 'has-issues')}>
        <strong>{title}</strong>
        {meta ? <small>{meta}</small> : null}
        {showIssues ? (
          <span className="broadcast-publish-bar__issues" aria-label="Не готово">
            {issues.map((issue) => (
              <button
                key={`broadcast-publish-issue-${issue.label}`}
                type="button"
                className="broadcast-publish-bar__issue"
                onClick={issue.onClick}
              >
                {issue.label}
              </button>
            ))}
          </span>
        ) : null}
      </div>

      <button
        type="button"
        className="button button--ghost broadcast-publish-bar__test"
        onClick={onTest}
        disabled={testDisabled}
        aria-label={testAriaLabel}
        title={testAriaLabel}
      >
        <TestGlyph aria-hidden focusable="false" />
        <span>{testLabel}</span>
      </button>

      {showSecondary ? (
        <button
          type="button"
          className="button button--ghost broadcast-publish-bar__secondary"
          onClick={onSecondary}
          disabled={secondaryDisabled}
          aria-label={secondaryLabel}
          title={secondaryLabel}
        >
          <BookmarkGlyph aria-hidden focusable="false" />
          <span>{secondaryLabel}</span>
        </button>
      ) : null}

      <button
        type="button"
        className="button button--accent broadcast-publish-bar__button broadcast-publish-bar__primary"
        onClick={onPrimary}
        disabled={primaryDisabled}
        aria-label={primaryLabel}
        title={primaryLabel}
      >
        <SendGlyph aria-hidden focusable="false" />
        <span>{primaryLabel}</span>
      </button>
    </div>
  );
}

export default BroadcastPublishBar;
