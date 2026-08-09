import type { ReactNode, Ref } from 'react';
import { Link } from 'react-router';
import { cn } from '../../lib/cn';
import { BackChevronIcon } from './entity-header-icons';

type CompactStickyHeaderProps = {
  backTo: string;
  backLabel: string;
  onBack?: () => void;
  title: string;
  subtitle?: string;
  avatar?: ReactNode;
  aside?: ReactNode;
  hidden?: boolean;
  compact?: boolean;
  className?: string;
  headerRef?: Ref<HTMLElement>;
};

export function CompactStickyHeader({
  backTo,
  backLabel,
  onBack,
  title,
  subtitle,
  avatar = null,
  aside = null,
  hidden = false,
  compact = false,
  className,
  headerRef,
}: CompactStickyHeaderProps) {
  return (
    <header
      ref={headerRef}
      className={cn(
        'compact-page-header',
        compact && 'is-compact',
        hidden && 'is-hidden',
        className,
      )}
    >
      <div className="compact-page-header__bar">
        {onBack ? (
          <button
            type="button"
            className="compact-page-header__back"
            aria-label={backLabel}
            onClick={onBack}
          >
            <BackChevronIcon />
          </button>
        ) : (
          <Link to={backTo} className="compact-page-header__back" aria-label={backLabel}>
            <BackChevronIcon />
          </Link>
        )}

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
