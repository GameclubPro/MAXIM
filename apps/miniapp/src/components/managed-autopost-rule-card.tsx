import type { ManagedAutopostRuleSummary } from '@maxim/contracts';
import {
  MoreHoriz as IconoirMoreHoriz,
  Pause as IconoirPause,
  Play as IconoirPlay,
  Xmark as IconoirXmark,
} from 'iconoir-react';
import { cn } from '../lib/cn';
import { MaxMarkdownPreview } from './max-markdown-preview';
import './managed-broadcast-history-card.css';

type ManagedAutopostRuleCardProps = {
  rule: ManagedAutopostRuleSummary;
  nextLabel: string;
  facts: string[];
  isBusy?: boolean;
  onOpen: () => void;
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
};

function resolveRuleTone(status: ManagedAutopostRuleSummary['status']) {
  if (status === 'ERROR') {
    return 'danger';
  }
  if (status === 'PAUSED') {
    return 'warning';
  }
  if (status === 'COMPLETED') {
    return 'muted';
  }
  return 'active';
}

function resolveRuleBadge(status: ManagedAutopostRuleSummary['status']) {
  if (status === 'PAUSED') {
    return 'Пауза';
  }
  if (status === 'ERROR') {
    return 'Ошибка';
  }
  if (status === 'COMPLETED') {
    return 'Завершён';
  }
  return 'Активен';
}

function resolveRuleTitle(rule: ManagedAutopostRuleSummary, nextLabel: string) {
  const explicitTitle = rule.title.trim();
  if (explicitTitle) {
    return explicitTitle;
  }

  const preview = rule.textPreview.trim();
  if (preview && preview !== 'Пусто') {
    return preview.slice(0, 64);
  }

  return nextLabel.trim() || 'Автопост';
}

export function ManagedAutopostRuleCard({
  rule,
  nextLabel,
  facts,
  isBusy = false,
  onOpen,
  onPause,
  onResume,
  onDelete,
}: ManagedAutopostRuleCardProps) {
  const tone = resolveRuleTone(rule.status);
  const badge = resolveRuleBadge(rule.status);
  const title = resolveRuleTitle(rule, nextLabel);
  const hasNextLabel = nextLabel.trim().length > 0;
  const canPause = rule.status === 'ACTIVE';
  const canResume = rule.status === 'PAUSED' || rule.status === 'ERROR';

  return (
    <div
      className={cn(
        'managed-broadcast-card',
        'managed-autopost-rule-card',
        `is-${tone}`,
        'is-editable',
      )}
    >
      <button
        type="button"
        className="managed-broadcast-card__surface"
        onClick={onOpen}
        disabled={isBusy}
      >
        <div className="managed-broadcast-card__top">
          <span className="managed-broadcast-card__main">
            <span className="managed-broadcast-card__headline">
              <span className={cn('managed-broadcast-card__badge', `is-${tone}`)}>{badge}</span>
              <strong>{title}</strong>
            </span>
            <MaxMarkdownPreview
              value={rule.textPreview}
              className="managed-broadcast-card__preview max-markdown-preview--clamp-2"
              normalizeWhitespace
              fallback={
                rule.hasImage ? 'Фото без текста' : rule.hasVideo ? 'Видео без текста' : null
              }
            />
          </span>
          <span className="managed-broadcast-card__aside">
            <span className={cn('managed-broadcast-card__metric', `is-${tone}`)}>
              <small>{hasNextLabel ? 'Следующий' : 'Состояние'}</small>
              <strong>{hasNextLabel ? nextLabel : badge}</strong>
            </span>
          </span>
        </div>

        {facts.length > 0 ? (
          <div className="managed-broadcast-card__facts">
            {facts.map((fact) => (
              <span key={`${rule.id}-${fact}`}>{fact}</span>
            ))}
          </div>
        ) : null}

        {rule.lastError ? (
          <small className="managed-broadcast-card__error" title={rule.lastError}>
            {rule.lastError}
          </small>
        ) : null}
      </button>

      <div className="managed-broadcast-card__actions">
        {canPause ? (
          <button
            type="button"
            className="managed-broadcast-card__quick-action"
            onClick={onPause}
            disabled={isBusy}
            aria-label="Поставить автопост на паузу"
            title="Пауза"
          >
            <IconoirPause aria-hidden focusable="false" />
            <span>Пауза</span>
          </button>
        ) : null}

        {canResume ? (
          <button
            type="button"
            className="managed-broadcast-card__quick-action"
            onClick={onResume}
            disabled={isBusy}
            aria-label="Возобновить автопост"
            title="Возобновить"
          >
            <IconoirPlay aria-hidden focusable="false" />
            <span>Возобновить</span>
          </button>
        ) : null}

        <details className={cn('managed-broadcast-card__menu', isBusy && 'is-disabled')}>
          <summary
            className="managed-broadcast-card__menu-trigger"
            aria-label="Действия"
            title="Действия"
            aria-disabled={isBusy}
            onClick={(event) => {
              if (isBusy) {
                event.preventDefault();
              }
            }}
          >
            <IconoirMoreHoriz aria-hidden focusable="false" />
          </summary>

          <div className="managed-broadcast-card__menu-popover">
            <button
              type="button"
              className="is-danger"
              onClick={(event) => {
                event.currentTarget.closest('details')?.removeAttribute('open');
                onDelete();
              }}
              disabled={isBusy}
            >
              <IconoirXmark aria-hidden focusable="false" />
              <span>Отменить</span>
            </button>
          </div>
        </details>
      </div>
    </div>
  );
}

export default ManagedAutopostRuleCard;
