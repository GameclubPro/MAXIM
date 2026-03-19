import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
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
  const navigate = useNavigate();

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
        <button
          type="button"
          className="compact-page-header__back"
          aria-label={backLabel}
          onClick={() => navigate(backTo)}
        >
          <BackChevronIcon />
        </button>

        <div className="compact-page-header__title-wrap">
          <h1 className="compact-page-header__title">{title}</h1>
        </div>

        {aside ? <div className="compact-page-header__aside">{aside}</div> : null}
      </div>
    </header>
  );
}
