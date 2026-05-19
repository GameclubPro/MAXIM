import { MaxMarkdownPreview } from './max-markdown-preview';
import { ActionConfirmSheet } from './ui/action-confirm-sheet';

type BroadcastPublishReviewSheetProps = {
  id: string;
  open: boolean;
  text: string;
  hasMedia: boolean;
  facts: string[];
  confirmLabel: string;
  confirmBusyLabel: string;
  isBusy: boolean;
  extraActionBusy: boolean;
  extraActionDisabled: boolean;
  onExtraAction: () => void;
  onClose: () => void;
  onConfirm: () => void;
};

export function BroadcastPublishReviewSheet({
  id,
  open,
  text,
  hasMedia,
  facts,
  confirmLabel,
  confirmBusyLabel,
  isBusy,
  extraActionBusy,
  extraActionDisabled,
  onExtraAction,
  onClose,
  onConfirm,
}: BroadcastPublishReviewSheetProps) {
  const hasAllAudience = facts.some((fact) => /все\s+чат/iu.test(fact));
  const previewMeta =
    facts.length > 0 ? (
      <span className="broadcast-review-stack">
        <span className="broadcast-review-facts">
          {hasAllAudience ? <span className="broadcast-review-alert">Все чаты</span> : null}
          {facts.map((fact) => (
            <span key={`${id}-${fact}`}>{fact}</span>
          ))}
        </span>
      </span>
    ) : undefined;

  return (
    <ActionConfirmSheet
      id={id}
      open={open}
      title="Проверка"
      previewTitle={
        text || hasMedia ? (
          <span className="broadcast-review-card">
            {hasMedia ? <span className="broadcast-review-card__media">Медиа</span> : null}
            <span className="broadcast-review-card__bubble">
              <MaxMarkdownPreview
                value={text}
                className="broadcast-review-card__markdown max-markdown-preview--clamp-2"
                normalizeWhitespace
                fallback={hasMedia ? 'Медиа' : null}
              />
            </span>
          </span>
        ) : undefined
      }
      previewMeta={previewMeta}
      confirmLabel={confirmLabel}
      confirmBusyLabel={confirmBusyLabel}
      cancelLabel="Назад"
      tone="accent"
      isBusy={isBusy}
      extraActionLabel="Тест"
      extraActionBusyLabel="Тест..."
      extraActionBusy={extraActionBusy}
      extraActionDisabled={extraActionDisabled}
      onExtraAction={onExtraAction}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}

export default BroadcastPublishReviewSheet;
