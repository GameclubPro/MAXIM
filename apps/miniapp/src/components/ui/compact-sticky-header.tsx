import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { BackChevronIcon } from './entity-header-icons';

type CompactStickyHeaderProps = {
  backTo: string;
  backLabel: string;
  title: string;
  aside?: ReactNode;
  hidden?: boolean;
  compact?: boolean;
  className?: string;
};

export function CompactStickyHeader({
  backTo,
  backLabel,
  title,
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

        <div className="compact-page-header__title-wrap">
          <h1 className="compact-page-header__title">{title}</h1>
        </div>

        {aside ? <div className="compact-page-header__aside">{aside}</div> : null}
      </div>
    </header>
  );
}
