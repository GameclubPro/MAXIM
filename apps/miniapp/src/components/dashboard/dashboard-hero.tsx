import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { GlassCard } from '../ui/glass-card';

type DashboardHeroChip = {
  label: string;
  className?: string;
};

type DashboardHeroProps = {
  accent: 'chat' | 'channel';
  eyebrow: string;
  title: string;
  summary: string;
  rangeControl: ReactNode;
  backTo: string;
  lastUpdated?: string | null;
  badge?: string | null;
  chips?: DashboardHeroChip[];
};

export function DashboardHero({
  accent,
  eyebrow,
  title,
  summary,
  rangeControl,
  backTo,
  lastUpdated = null,
  badge = null,
  chips = [],
}: DashboardHeroProps) {
  return (
    <GlassCard className={`dashboard-hero dashboard-hero--${accent}`} elevated>
      <div className="dashboard-hero__top">
        <Link to={backTo} className="button button--ghost dashboard-hero__back">
          Назад
        </Link>
        {badge ? <span className="dashboard-hero__badge">{badge}</span> : null}
      </div>

      <div className="dashboard-hero__body">
        <p className="dashboard-hero__eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="dashboard-hero__summary">{summary}</p>
        {lastUpdated ? <p className="dashboard-hero__meta">{lastUpdated}</p> : null}
      </div>

      <div className="dashboard-hero__controls">{rangeControl}</div>

      {chips.length > 0 ? (
        <div className="dashboard-hero__chips">
          {chips.map((chip) => (
            <span key={chip.label} className={chip.className ?? 'chip'}>
              {chip.label}
            </span>
          ))}
        </div>
      ) : null}
    </GlassCard>
  );
}
