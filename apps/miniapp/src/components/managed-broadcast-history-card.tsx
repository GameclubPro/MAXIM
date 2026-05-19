import type { ManagedBroadcastSummary } from '@maxim/contracts';
import {
  Copy as IconoirCopy,
  MoreHoriz as IconoirMoreHoriz,
  RefreshDouble as IconoirRefreshDouble,
  Trash as IconoirTrash,
} from 'iconoir-react';
import { MaxMarkdownPreview } from './max-markdown-preview';
import { ManagedBroadcastDeliveryMeter } from './managed-broadcast-delivery-meter';
import { cn } from '../lib/cn';

type ManagedBroadcastHistoryTone = 'active' | 'warning' | 'danger' | 'muted';

type ManagedBroadcastHistoryMetric = {
  label: string;
  value: string;
  caption: string;
  tone: ManagedBroadcastHistoryTone;
};

type ManagedBroadcastHistoryCardProps = {
  broadcast: ManagedBroadcastSummary;
  tone: ManagedBroadcastHistoryTone;
  badge: string;
  title: string;
  metric: ManagedBroadcastHistoryMetric;
  facts: string[];
  canEdit: boolean;
  canCancel: boolean;
  isBusy: boolean;
  isDeleting: boolean;
  isDuplicating: boolean;
  isRetrying: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onRetry: () => void;
  onDelete: () => void;
};

export function ManagedBroadcastHistoryCard({
  broadcast,
  tone,
  badge,
  title,
  metric,
  facts,
  canEdit,
  canCancel,
  isBusy,
  isDeleting,
  isDuplicating,
  isRetrying,
  onEdit,
  onDuplicate,
  onRetry,
  onDelete,
}: ManagedBroadcastHistoryCardProps) {
  const disablePrimary = isBusy || isDeleting;
  const content = (
    <>
      <div className="managed-broadcast-card__top">
        <span className="managed-broadcast-card__main">
          <span className="managed-broadcast-card__headline">
            <span
              className={cn('managed-broadcast-card__badge', `is-${tone}`)}
              title={badge}
              aria-label={badge}
            />
            <strong>{title}</strong>
          </span>
          <MaxMarkdownPreview
            value={broadcast.textPreview}
            className="managed-broadcast-card__preview max-markdown-preview--clamp-2"
            normalizeWhitespace
            fallback={broadcast.hasImage ? 'Фото без текста' : null}
          />
        </span>
        <span className="managed-broadcast-card__aside">
          <span className={cn('managed-broadcast-card__metric', `is-${metric.tone}`)}>
            <small>{metric.label}</small>
            <strong>{metric.value}</strong>
            <span>{metric.caption}</span>
          </span>
        </span>
      </div>

      {facts.length > 0 ? (
        <div className="managed-broadcast-card__facts">
          {facts.map((fact) => (
            <span key={`${broadcast.id}-${fact}`}>{fact}</span>
          ))}
        </div>
      ) : null}

      <ManagedBroadcastDeliveryMeter broadcast={broadcast} />

      {broadcast.lastError ? (
        <small className="managed-broadcast-card__error" title={broadcast.lastError}>
          {broadcast.lastError}
        </small>
      ) : null}
    </>
  );

  return (
    <div
      className={cn('managed-broadcast-card', `is-${tone}`, canEdit && 'is-editable')}
      data-broadcast-id={broadcast.id}
    >
      {canEdit ? (
        <button
          type="button"
          className="managed-broadcast-card__surface"
          onClick={onEdit}
          disabled={disablePrimary}
        >
          {content}
        </button>
      ) : (
        <div className={cn('managed-broadcast-card__surface', 'is-static')}>{content}</div>
      )}

      <div className="managed-broadcast-card__actions">
        {broadcast.canRetry ? (
          <button
            type="button"
            className="managed-broadcast-card__quick-action is-retry"
            onClick={onRetry}
            disabled={isBusy}
            aria-label={isRetrying ? 'Повторяем отправку' : 'Повторить отправку'}
            title={isRetrying ? 'Повторяем' : 'Повторить'}
          >
            <IconoirRefreshDouble aria-hidden focusable="false" />
            <span>{isRetrying ? '...' : 'Повторить'}</span>
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
              onClick={(event) => {
                event.currentTarget.closest('details')?.removeAttribute('open');
                onDuplicate();
              }}
              disabled={isBusy}
            >
              <IconoirCopy aria-hidden focusable="false" />
              <span>{isDuplicating ? 'Копируем...' : 'Дублировать'}</span>
            </button>

            {canCancel ? (
              <button
                type="button"
                className="is-danger"
                onClick={(event) => {
                  event.currentTarget.closest('details')?.removeAttribute('open');
                  onDelete();
                }}
                disabled={isBusy}
              >
                <IconoirTrash aria-hidden focusable="false" />
                <span>{isDeleting ? 'Удаляем...' : 'Удалить'}</span>
              </button>
            ) : null}
          </div>
        </details>
      </div>
    </div>
  );
}

export default ManagedBroadcastHistoryCard;
