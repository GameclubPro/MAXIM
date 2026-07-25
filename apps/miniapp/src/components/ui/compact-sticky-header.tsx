import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '../../lib/cn';
import { BackChevronIcon } from './entity-header-icons';

type CompactStickyHeaderProps = {
  backTo: string;
  backLabel: string;
  title: string;
  subtitle?: string;
  avatar?: ReactNode;
  aside?: ReactNode;
  hidden?: boolean;
  compact?: boolean;
  className?: string;
};

export function CompactStickyHeader({
  backTo,
  backLabel,
  title,
  subtitle,
  avatar = null,
  aside = null,
  hidden = false,
  compact = false,
  className,
}: CompactStickyHeaderProps) {
  return (
    <header
      className={cn(
        'compact-page-header',
        compact && 'is-compact',
        hidden && 'is-hidden',
        className,
      )}
    >
      <div className="compact-page-header__bar">
        <Link to={backTo} className="compact-page-header__back" aria-label={backLabel}>
          <BackChevronIcon />
        </Link>

        <div className="compact-page-header__identity">
          {avatar ? <div className="compact-page-header__avatar-wrap">{avatar}</div> : null}

          <div className="compact-page-header__title-wrap">
            {subtitle ? <span className="compact-page-header__subtitle">{subtitle}</span> : null}
            <h1 className="compact-page-header__title">{title}</h1>
          </div>
        </div>

        <div className="compact-page-header__aside">{aside}</div>
      </div>
    </header>
  );
}
