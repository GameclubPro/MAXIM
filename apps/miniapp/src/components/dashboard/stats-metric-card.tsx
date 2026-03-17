import { GlassCard } from '../ui/glass-card';

type StatsMetricCardProps = {
  label: string;
  value: string;
  detail?: string;
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
};

export function StatsMetricCard({
  label,
  value,
  detail,
  tone = 'neutral',
}: StatsMetricCardProps) {
  return (
    <GlassCard
      as="article"
      padding="sm"
      elevated
      className={`stats-metric-card stats-metric-card--${tone}`}
    >
      <small>{label}</small>
      <strong>{value}</strong>
      {detail ? <span>{detail}</span> : null}
    </GlassCard>
  );
}
