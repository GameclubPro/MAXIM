import { ActionConfirmSheet } from '../../components/ui/action-confirm-sheet';
import { MaxMarkdownPreview } from '../../components/max-markdown-preview';
import { PublicationRetrySheet } from './publication-retry-sheet';
import { getPublicationActionCapabilities } from './publication-model';
import type { usePublicationActions } from './use-publication-actions';

export function PublicationActionSheet({
  actions,
}: {
  actions: ReturnType<typeof usePublicationActions>;
}) {
  const { actionTarget, setActionTarget, actionMutation } = actions;
  const cancelsFutureSends = Boolean(
    actionTarget?.action === 'cancel' &&
    getPublicationActionCapabilities(actionTarget.publication).hasFutureSends,
  );
  return (
    <>
      <ActionConfirmSheet
        id="publication-action"
        open={actionTarget !== null}
        title={
          actionTarget?.action === 'cancel'
            ? cancelsFutureSends
              ? 'Отменить будущие отправки?'
              : 'Отменить публикацию?'
            : actionTarget?.action === 'pause'
              ? 'Поставить на паузу?'
              : 'Запустить расписание?'
        }
        summary={
          cancelsFutureSends
            ? 'Будущие отправки отменятся, а ошибки нельзя будет повторить.'
            : undefined
        }
        previewTitle={
          actionTarget?.publication.title ? (
            actionTarget.publication.title
          ) : actionTarget?.publication.contentPreview ? (
            <MaxMarkdownPreview
              value={actionTarget.publication.contentPreview}
              sourceFormat={actionTarget.publication.contentPreviewFormat}
              normalizeWhitespace
            />
          ) : undefined
        }
        confirmLabel={
          actionTarget?.action === 'cancel'
            ? 'Отменить'
            : actionTarget?.action === 'pause'
              ? 'Пауза'
              : 'Запустить'
        }
        confirmBusyLabel="Сохраняем..."
        tone={actionTarget?.action === 'cancel' ? 'danger' : 'accent'}
        isBusy={actionMutation.isPending}
        onClose={() => !actionMutation.isPending && setActionTarget(null)}
        onConfirm={() => actionTarget && actionMutation.mutate(actionTarget)}
      />
    </>
  );
}

export function PublicationDeliveryActionSheets({
  actions,
}: {
  actions: ReturnType<typeof usePublicationActions>;
}) {
  const {
    ambiguousTarget,
    setAmbiguousTarget,
    retryChoiceTarget,
    setRetryChoiceTarget,
    retryMutation,
    resolveAmbiguousMutation,
  } = actions;
  return (
    <>
      <PublicationRetrySheet
        open={retryChoiceTarget !== null}
        busy={retryMutation.isPending}
        onClose={() => !retryMutation.isPending && setRetryChoiceTarget(null)}
        onSelect={(contentMode) => {
          if (!retryChoiceTarget) {
            return;
          }
          if (contentMode === 'latest') {
            retryMutation.mutate({
              publicationId: retryChoiceTarget.publicationId,
              occurrenceId: retryChoiceTarget.occurrenceId,
              contentMode,
              expectedPublicationVersion: retryChoiceTarget.publicationVersion,
              expectedContentRevision: retryChoiceTarget.latestContentRevision,
            });
            return;
          }
          retryMutation.mutate({
            publicationId: retryChoiceTarget.publicationId,
            occurrenceId: retryChoiceTarget.occurrenceId,
            contentMode,
          });
        }}
      />

      <ActionConfirmSheet
        id="publication-resolve-ambiguous"
        open={ambiguousTarget !== null}
        title={
          ambiguousTarget?.resolution === 'mark_sent'
            ? 'Сообщение опубликовано?'
            : 'Сообщение не отправлено?'
        }
        summary="Это ручная проверка неоднозначной отправки."
        confirmLabel="Подтвердить"
        confirmBusyLabel="Сохраняем..."
        tone={ambiguousTarget?.resolution === 'mark_failed' ? 'danger' : 'accent'}
        isBusy={resolveAmbiguousMutation.isPending}
        onClose={() => !resolveAmbiguousMutation.isPending && setAmbiguousTarget(null)}
        onConfirm={() => ambiguousTarget && resolveAmbiguousMutation.mutate(ambiguousTarget)}
      />
    </>
  );
}
