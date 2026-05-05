import type { CSSProperties } from 'react';
import { cn } from '../lib/cn';

export type BroadcastStudioSignalTone = 'ready' | 'pending' | 'warning' | 'danger' | 'neutral';

export type BroadcastStudioSignal = {
  label: string;
  value: string;
  tone?: BroadcastStudioSignalTone;
};

type BroadcastStudioHeaderProps = {
  title: string;
  subtitle: string;
  readyCount: number;
  totalCount: number;
  signals: BroadcastStudioSignal[];
  busy?: boolean;
  editing?: boolean;
};

export function BroadcastStudioHeader({
  title,
  subtitle,
  readyCount,
  totalCount,
  signals,
  busy = false,
  editing = false,
}: BroadcastStudioHeaderProps) {
  const safeTotal = Math.max(1, totalCount);
  const normalizedReadyCount = Math.min(Math.max(0, readyCount), safeTotal);
  const progress = Math.round((normalizedReadyCount / safeTotal) * 100);
  const progressStyle = { '--broadcast-studio-progress': `${progress}%` } as CSSProperties;

  return (
    <section
      className={cn('broadcast-studio-command', busy && 'is-busy', editing && 'is-editing')}
      aria-label="Сводка рассылки"
    >
      <div className="broadcast-studio-command__hero">
        <div className="broadcast-studio-command__copy">
          <strong>{title}</strong>
          <small>{subtitle}</small>
        </div>

        <div
          className="broadcast-studio-command__score"
          aria-label={`Готово ${normalizedReadyCount} из ${safeTotal}`}
        >
          <strong>
            {normalizedReadyCount}/{safeTotal}
          </strong>
        </div>
      </div>

      <div className="broadcast-studio-command__meter" style={progressStyle} aria-hidden>
        <span />
      </div>

      <div className="broadcast-studio-command__signals">
        {signals.map((signal, index) => (
          <span
            key={`${signal.label}-${signal.value}-${index}`}
            className={cn('broadcast-studio-command__signal', `is-${signal.tone ?? 'neutral'}`)}
            aria-label={`${signal.label}: ${signal.value}`}
          >
            <strong>{signal.value}</strong>
          </span>
        ))}
      </div>
    </section>
  );
}

export default BroadcastStudioHeader;
