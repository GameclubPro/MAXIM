import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import type { StatusTone } from './ui-types';

type StatusStateProps = {
  title: string;
  description?: string;
  tone?: StatusTone;
  action?: ReactNode;
  className?: string;
};

const toneIconMap: Record<StatusTone, string> = {
  neutral: 'i',
  success: '✓',
  warning: '!',
  danger: '×',
};

export function StatusState({
  title,
  description,
  tone = 'neutral',
  action,
  className,
}: StatusStateProps) {
  const role = tone === 'danger' ? 'alert' : 'status';
  return (
    <section
      className={cn('status-state', `status-state--${tone}`, className)}
      role={role}
      aria-live={role === 'alert' ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      <div className="status-state__icon" aria-hidden>
        {toneIconMap[tone]}
      </div>
      <div className="status-state__content">
        <h3>{title}</h3>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className="status-state__action">{action}</div> : null}
    </section>
  );
}
