import { SendDiagonal, TestTube } from 'iconoir-react';
import { cn } from '../lib/cn';

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
  primaryLabel,
  primaryDisabled,
  onTest,
  onPrimary,
}: BroadcastPublishBarProps) {
  const showIssues = issues.length > 0 && !busy;

  return (
    <div className={cn('broadcast-publish-bar', showIssues && 'has-issues')}>
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
        <TestTube aria-hidden focusable="false" />
        <span>{testLabel}</span>
      </button>

      <button
        type="button"
        className="button button--accent broadcast-publish-bar__button"
        onClick={onPrimary}
        disabled={primaryDisabled}
      >
        <SendDiagonal aria-hidden focusable="false" />
        <span>{primaryLabel}</span>
      </button>
    </div>
  );
}

export default BroadcastPublishBar;
