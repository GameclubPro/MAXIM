import type { CSSProperties } from 'react';
import { cn } from '../lib/cn';

export type BroadcastStudioSignalTone = 'ready' | 'pending' | 'warning' | 'danger' | 'neutral';
export type BroadcastStudioSignalIcon = 'content' | 'audience' | 'channel' | 'time' | 'button';

export type BroadcastStudioSignal = {
  label: string;
  value: string;
  tone?: BroadcastStudioSignalTone;
  icon?: BroadcastStudioSignalIcon;
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

type BroadcastStudioChecklistProps = {
  title?: string;
  summary: string;
  ready: boolean;
  signals: BroadcastStudioSignal[];
};

function BroadcastSignalIcon({ icon }: { icon: BroadcastStudioSignalIcon }) {
  if (icon === 'audience') {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden>
        <path
          d="M7.6 9.2a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2.8 16.4c.4-2.7 2.2-4.4 4.8-4.4s4.4 1.7 4.8 4.4"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
        <path
          d="M13.1 8.7a2.3 2.3 0 1 0 0-4.6M13.8 12.2c1.9.3 3 1.7 3.4 4.2"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (icon === 'channel') {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden>
        <path
          d="M3.2 10.2 16.7 3.8 13 16.2l-3.1-4.1-4.5 2.1 1.1-3.3Z"
          stroke="currentColor"
          strokeWidth="1.65"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (icon === 'time') {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden>
        <circle cx="10" cy="10" r="6.6" stroke="currentColor" strokeWidth="1.7" />
        <path
          d="M10 6.4v4l2.7 1.6"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (icon === 'button') {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden>
        <rect
          x="3.3"
          y="5.3"
          width="13.4"
          height="9.4"
          rx="3"
          stroke="currentColor"
          strokeWidth="1.7"
        />
        <path d="M7 10h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M4 5.6h12M4 10h8.5M4 14.4h6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

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
  const readyLabel =
    normalizedReadyCount === safeTotal ? 'Готово' : `${normalizedReadyCount}/${safeTotal}`;

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
          <strong>{readyLabel}</strong>
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
            <span className="broadcast-studio-command__signal-icon">
              <BroadcastSignalIcon icon={signal.icon ?? 'content'} />
            </span>
            <span className="broadcast-studio-command__signal-copy">
              <span className="broadcast-studio-command__signal-label">{signal.label}</span>
              <strong>{signal.value}</strong>
            </span>
          </span>
        ))}
      </div>
    </section>
  );
}

export function BroadcastStudioChecklist({
  title = 'Проверка',
  summary,
  ready,
  signals,
}: BroadcastStudioChecklistProps) {
  return (
    <section
      className={cn('broadcast-flight-check', ready && 'is-ready')}
      aria-label="Проверка рассылки"
    >
      <div className="broadcast-flight-check__head">
        <span className="broadcast-flight-check__copy">
          <strong>{title}</strong>
          <small>{summary}</small>
        </span>
        <span className={cn('broadcast-flight-check__badge', ready && 'is-ready')}>
          {ready ? 'Готово' : 'Черновик'}
        </span>
      </div>

      <div className="broadcast-flight-check__grid">
        {signals.map((signal, index) => (
          <span
            key={`${signal.label}-${signal.value}-${index}`}
            className={cn('broadcast-flight-check__item', `is-${signal.tone ?? 'neutral'}`)}
          >
            <span className="broadcast-flight-check__icon" aria-hidden>
              <BroadcastSignalIcon icon={signal.icon ?? 'content'} />
            </span>
            <span className="broadcast-flight-check__item-copy">
              <small>{signal.label}</small>
              <strong>{signal.value}</strong>
            </span>
          </span>
        ))}
      </div>
    </section>
  );
}

export default BroadcastStudioHeader;
