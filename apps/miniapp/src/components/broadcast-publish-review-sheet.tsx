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
  return (
    <ActionConfirmSheet
      id={id}
      open={open}
      title="Подтвердить"
      previewTitle={
        text || hasMedia ? (
          <MaxMarkdownPreview
            value={text}
            className="action-confirm-sheet__preview-markdown max-markdown-preview--clamp-2"
            normalizeWhitespace
            fallback={hasMedia ? 'Медиа' : null}
          />
        ) : undefined
      }
      previewMeta={
        facts.length > 0 ? (
          <span className="broadcast-review-facts">
            {facts.map((fact) => (
              <span key={`${id}-${fact}`}>{fact}</span>
            ))}
          </span>
        ) : undefined
      }
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
