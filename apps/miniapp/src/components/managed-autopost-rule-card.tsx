import { AppIcon as IconoirSprite } from './ui/app-icon';
import type { ManagedAutopostRuleSummary } from '@maxim/contracts';

import { cn } from '../lib/cn';
import { describeUserFacingError } from '../lib/user-facing-error';
import { MaxMarkdownPreview } from './max-markdown-preview';
import './managed-broadcast-history-card.css';

type ManagedAutopostRuleCardProps = {
  rule: ManagedAutopostRuleSummary;
  nextLabel: string;
  facts: string[];
  isBusy?: boolean;
  onPause: () => void;
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
  onPause,
  onDelete,
}: ManagedAutopostRuleCardProps) {
  const errorMessage = rule.lastError
    ? describeUserFacingError(new Error(rule.lastError), 'Не удалось выполнить отправку.')
    : null;
  const tone = resolveRuleTone(rule.status);
  const badge = resolveRuleBadge(rule.status);
  const title = resolveRuleTitle(rule, nextLabel);
  const hasNextLabel = nextLabel.trim().length > 0;
  const canPause = rule.status === 'ACTIVE';

  return (
    <div className={cn('managed-broadcast-card', 'managed-autopost-rule-card', `is-${tone}`)}>
      <div className="managed-broadcast-card__surface is-static">
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

        {errorMessage ? (
          <small className="managed-broadcast-card__error" title={errorMessage}>
            {errorMessage}
          </small>
        ) : null}
      </div>

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
            <IconoirSprite variant="iconoir" icon="Pause" aria-hidden focusable="false" />
            <span>Пауза</span>
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
            <IconoirSprite variant="iconoir" icon="MoreHoriz" aria-hidden focusable="false" />
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
              <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden focusable="false" />
              <span>Отменить</span>
            </button>
          </div>
        </details>
      </div>
    </div>
  );
}

export default ManagedAutopostRuleCard;
