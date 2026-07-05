import { cn } from '../lib/cn';
import { MaxMarkdownPreview } from './max-markdown-preview';
import { ResetIcon } from './ui/reset-icon';
import './managed-broadcast-history-card.css';

type BroadcastDraftCardProps = {
  preview: string;
  fallback?: string;
  facts: string[];
  disabled?: boolean;
  onOpen: () => void;
  onReset: () => void;
};

export function BroadcastDraftCard({
  preview,
  fallback = 'Добавьте текст, фото или видео',
  facts,
  disabled = false,
  onOpen,
  onReset,
}: BroadcastDraftCardProps) {
  const normalizedPreview = preview.trim();

  return (
    <div
      className={cn('managed-broadcast-card', 'broadcast-draft-card', 'is-warning', 'is-editable')}
    >
      <button
        type="button"
        className="managed-broadcast-card__surface"
        onClick={onOpen}
        disabled={disabled}
      >
        <div className="managed-broadcast-card__top">
          <span className="managed-broadcast-card__main">
            <span className="managed-broadcast-card__headline">
              <strong>Черновик</strong>
            </span>
            {normalizedPreview ? (
              <MaxMarkdownPreview
                value={normalizedPreview}
                className="managed-broadcast-card__preview max-markdown-preview--clamp-2"
                normalizeWhitespace
              />
            ) : (
              <span className="managed-broadcast-card__preview">{fallback}</span>
            )}
          </span>
          <span className="managed-broadcast-card__aside">
            <span className={cn('managed-broadcast-card__metric', 'is-warning')}>
              <small>Состояние</small>
              <strong>Не сохранён</strong>
            </span>
          </span>
        </div>

        {facts.length > 0 ? (
          <div className="managed-broadcast-card__facts">
            {facts.map((fact) => (
              <span key={`broadcast-draft-${fact}`}>{fact}</span>
            ))}
          </div>
        ) : null}
      </button>

      <div className="managed-broadcast-card__actions">
        <button type="button" className="button button--ghost" onClick={onOpen} disabled={disabled}>
          Открыть
        </button>
        <button
          type="button"
          className="managed-broadcast-card__quick-action"
          onClick={onReset}
          disabled={disabled}
          aria-label="Очистить черновик"
          title="Очистить"
        >
          <ResetIcon />
        </button>
      </div>
    </div>
  );
}
