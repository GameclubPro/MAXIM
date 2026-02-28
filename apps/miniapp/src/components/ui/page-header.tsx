import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

type PageHeaderProps = {
  title: string;
  subtitle?: string;
  badge?: string;
  actions?: ReactNode;
  className?: string;
};

export function PageHeader({ title, subtitle, badge, actions, className }: PageHeaderProps) {
  return (
    <header className={cn('page-header', className)}>
      <div className="page-header__main">
        {badge ? <span className="page-header__badge">{badge}</span> : null}
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}
