import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  PublicationDelivery,
  PublicationDetails,
  PublicationDeliveryStatus,
  PublicationOccurrenceSummary,
  PublicationOccurrenceStatus,
  PublicationSummary,
} from '@maxim/contracts/publication';
import { EditPencil, RefreshDouble, Xmark } from 'iconoir-react';
import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { MaxMarkdownPreview } from '../../components/max-markdown-preview';
import { EntityAvatar } from '../../components/ui/entity-avatar';
import { StatusState } from '../../components/ui/status-state';
import { describeUserFacingError } from '../../lib/user-facing-error';
import { getPublication, listPublicationDeliveries } from '../../lib/api/publication-client';
import type { ApiTransport } from '../../lib/api/transport';
import { formatRussianCountLabel } from '../../lib/broadcast-audience';
import { cn } from '../../lib/cn';
import { isTopmostModalDialog, useDialogFocusTrap } from '../../lib/dialog-focus';
import { useNativeBackHandler } from '../../lib/native-back';
import { formatPublicationDeliveryError } from './publication-delivery-error';
import {
  getPublicationActionCapabilities,
  getPublicationActionableDelivery,
  isPublicationOccurrenceContentStale,
} from './publication-model';
import {
  isAmbiguousDeliveryPhaseComplete,
  mergePublicationDeliveryPages,
  mergePublicationPages,
  shouldPollPublicationDeliveryPages,
} from './publication-pagination';

type PublicationDetailsSheetProps = {
  api: ApiTransport;
  publication: PublicationSummary | null;
  allowEdit?: boolean;
  busy?: boolean;
  covered?: boolean;
  onClose: () => void;
  onCancel: (publication: PublicationSummary) => void;
  onEdit: (publicationId: string) => void;
  onRetry: (publication: PublicationDetails, occurrence: PublicationOccurrenceSummary) => void;
  onResolveAmbiguous: (
    publicationId: string,
    occurrenceId: string,
    deliveryId: string,
    resolution: 'mark_sent' | 'mark_failed',
  ) => void;
};

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('ru-RU', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date)
    : value;
}

const OCCURRENCE_STATUS_LABELS: Record<PublicationOccurrenceStatus, string> = {
  SCHEDULED: 'Запланировано',
  IN_PROGRESS: 'Отправляется',
  SENT: 'Опубликовано',
  PARTIAL: 'Частично',
  FAILED: 'Ошибка',
  AMBIGUOUS: 'Нужно проверить',
  CANCELED: 'Отменено',
};

const DELIVERY_STATUS_LABELS: Record<PublicationDeliveryStatus, string> = {
  PENDING: 'Ожидает',
  SENDING: 'Отправляется',
  SENT: 'Опубликовано',
  FAILED: 'Ошибка',
  AMBIGUOUS: 'Нужно проверить',
  CANCELED: 'Отменено',
};

const PUBLICATION_DELIVERY_PAGE_SIZE = 50;

function formatOccurrenceRevision(
  occurrence: PublicationOccurrenceSummary,
  latestContentRevision: number,
): string | null {
  if (occurrence.contentRevision === undefined && occurrence.usesLatestContent === undefined) {
    return null;
  }
  if (isPublicationOccurrenceContentStale(occurrence, latestContentRevision)) {
    return occurrence.contentRevision
      ? `Версия ${occurrence.contentRevision} · актуальная ${latestContentRevision}`
      : `Есть актуальная версия ${latestContentRevision}`;
  }
  return `Версия ${occurrence.contentRevision ?? latestContentRevision}`;
}

function getStaleDeliveryContentRevision(
  delivery: PublicationDelivery,
  latestContentRevision: number,
): number | null {
  const contentRevision = delivery.contentRevision;
  return contentRevision !== undefined && contentRevision !== latestContentRevision
    ? contentRevision
    : null;
}

function resolvePublicationDetailsPortalTarget(): Element | null {
  if (typeof document === 'undefined') {
    return null;
  }
  return document.querySelector('.design-preview__device-screen') ?? document.body;
}

export function PublicationDetailsSheet({
  api,
  publication,
  allowEdit = true,
  busy = false,
  covered = false,
  onClose,
  onCancel,
  onEdit,
  onRetry,
  onResolveAmbiguous,
}: PublicationDetailsSheetProps) {
  const open = publication !== null;
  const panelRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  useDialogFocusTrap(open && !covered, panelRef, closeButtonRef);
  const detailsQuery = useQuery({
    queryKey: ['publications', 'details', publication?.id],
    queryFn: () => getPublication(api, publication?.id ?? ''),
    enabled: open,
    refetchInterval: (query) => {
      const details = query.state.data;
      const delivery = details ? getPublicationActionableDelivery(details) : null;
      return details &&
        delivery &&
        (delivery.pending > 0 ||
          (details.lifecycle === 'ACTIVE' &&
            details.schedule?.mode === 'now' &&
            delivery.total === 0))
        ? 5_000
        : false;
    },
  });
  const actionableDelivery = detailsQuery.data
    ? getPublicationActionableDelivery(detailsQuery.data)
    : publication
      ? getPublicationActionableDelivery(publication)
      : null;
  const shouldPollDeliveries = Boolean(
    detailsQuery.data &&
    actionableDelivery &&
    (actionableDelivery.pending > 0 ||
      (detailsQuery.data.lifecycle === 'ACTIVE' &&
        detailsQuery.data.schedule?.mode === 'now' &&
        actionableDelivery.total === 0)),
  );
  const ambiguousCount = actionableDelivery?.ambiguous ?? 0;
  const hasAmbiguous = ambiguousCount > 0;
  const ambiguousDeliveriesQuery = useInfiniteQuery({
    queryKey: ['publications', 'deliveries', publication?.id, 'ambiguous'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listPublicationDeliveries(api, publication?.id ?? '', {
        status: 'AMBIGUOUS',
        limit: PUBLICATION_DELIVERY_PAGE_SIZE,
        cursor: pageParam ?? undefined,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: open && hasAmbiguous,
    refetchInterval: (query) =>
      shouldPollPublicationDeliveryPages(shouldPollDeliveries, query.state.data?.pages)
        ? 5_000
        : false,
  });
  const {
    fetchNextPage: fetchNextAmbiguousPage,
    hasNextPage: hasNextAmbiguousPage,
    isFetchingNextPage: isFetchingNextAmbiguousPage,
    isSuccess: ambiguousDeliveriesLoaded,
  } = ambiguousDeliveriesQuery;
  const hasAmbiguousDeliveryData = Boolean(ambiguousDeliveriesQuery.data);
  const ambiguousInitialError =
    hasAmbiguous && ambiguousDeliveriesQuery.isError && !hasAmbiguousDeliveryData;
  const ambiguousPhaseComplete = isAmbiguousDeliveryPhaseComplete({
    hasAmbiguous,
    hasData: hasAmbiguousDeliveryData,
    hasNextPage: hasNextAmbiguousPage,
    isError: ambiguousDeliveriesQuery.isError,
    isFetchingNextPage: isFetchingNextAmbiguousPage,
    isSuccess: ambiguousDeliveriesLoaded,
  });
  const deliveriesQuery = useInfiniteQuery({
    queryKey: ['publications', 'deliveries', publication?.id, 'all'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listPublicationDeliveries(api, publication?.id ?? '', {
        excludeStatus: hasAmbiguous ? 'AMBIGUOUS' : undefined,
        limit: PUBLICATION_DELIVERY_PAGE_SIZE,
        cursor: pageParam ?? undefined,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: open && ambiguousPhaseComplete,
    refetchInterval: (query) =>
      shouldPollPublicationDeliveryPages(shouldPollDeliveries, query.state.data?.pages)
        ? 5_000
        : false,
  });

  useEffect(() => {
    if (
      !open ||
      !hasAmbiguous ||
      !ambiguousDeliveriesLoaded ||
      !hasNextAmbiguousPage ||
      isFetchingNextAmbiguousPage
    ) {
      return;
    }
    void fetchNextAmbiguousPage();
  }, [
    ambiguousDeliveriesLoaded,
    fetchNextAmbiguousPage,
    hasAmbiguous,
    hasNextAmbiguousPage,
    isFetchingNextAmbiguousPage,
    open,
  ]);

  const ambiguousDeliveries = useMemo(
    () => (hasAmbiguous ? mergePublicationPages(ambiguousDeliveriesQuery.data?.pages) : []),
    [ambiguousDeliveriesQuery.data?.pages, hasAmbiguous],
  );
  const deliveries = useMemo(
    () =>
      mergePublicationDeliveryPages(
        hasAmbiguous,
        ambiguousDeliveriesQuery.data?.pages,
        ambiguousPhaseComplete ? deliveriesQuery.data?.pages : undefined,
      ),
    [
      ambiguousDeliveriesQuery.data?.pages,
      ambiguousPhaseComplete,
      deliveriesQuery.data?.pages,
      hasAmbiguous,
    ],
  );

  useNativeBackHandler(
    () => {
      if (busy) {
        return false;
      }
      onClose();
      return true;
    },
    { enabled: open && !covered, priority: 720 },
  );

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (event.key !== 'Escape' || !panel || !isTopmostModalDialog(panel)) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!busy) {
        onClose();
      }
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [busy, onClose, open]);

  const portalTarget = open ? resolvePublicationDetailsPortalTarget() : null;
  if (!open || !portalTarget) {
    return null;
  }

  const details = detailsQuery.data;
  const actionCapabilities = getPublicationActionCapabilities(details ?? publication);
  const editLabel =
    actionCapabilities.editScope === 'future'
      ? 'Изменить будущие отправки'
      : actionCapabilities.editScope === 'retry'
        ? 'Изменить версию для повтора'
        : 'Изменить расписание';

  return createPortal(
    <div className="publication-details-sheet" aria-hidden={covered || undefined} inert={covered}>
      <button
        type="button"
        className="publication-details-sheet__backdrop"
        onClick={onClose}
        aria-label="Закрыть детали"
        disabled={busy}
      />
      <section
        ref={panelRef}
        className="publication-details-sheet__panel"
        role="dialog"
        aria-modal={covered ? undefined : true}
        aria-labelledby="publication-details-title"
        tabIndex={-1}
      >
        <div className="publication-details-sheet__grabber" aria-hidden />
        <header className="publication-details-sheet__header">
          <span>
            <strong id="publication-details-title">{publication.title || 'Публикация'}</strong>
            <small>
              {formatRussianCountLabel(
                publication.targetCount,
                'получатель',
                'получателя',
                'получателей',
              )}
            </small>
          </span>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            disabled={busy}
          >
            <Xmark aria-hidden />
          </button>
        </header>

        <div className="publication-details-sheet__body">
          {detailsQuery.isLoading ? (
            <StatusState tone="neutral" title="Загружаю детали" />
          ) : detailsQuery.isError && !details ? (
            <StatusState
              tone="danger"
              title="Не удалось открыть"
              description={describeUserFacingError(detailsQuery.error, 'Повторите ещё раз.')}
            />
          ) : details ? (
            <>
              <div className="publication-details-sheet__message">
                {details.content.media.length > 0 ? (
                  <span className="publication-details-sheet__media">
                    {details.hasVideo ? 'Видео' : `${details.mediaCount} фото`}
                  </span>
                ) : null}
                <MaxMarkdownPreview
                  value={details.content.text}
                  normalizeWhitespace
                  fallback={details.hasVideo ? 'Видео без текста' : null}
                />
              </div>

              <section className="publication-details-section">
                <strong>Получатели</strong>
                <div className="publication-details-targets">
                  {details.targets.map((target) => (
                    <div key={`${target.entityType}:${target.chatId}`}>
                      <EntityAvatar
                        title={target.title}
                        entityType={target.entityType}
                        avatarUrl={target.avatarUrl}
                      />
                      <span className="publication-details-targets__copy">
                        <strong>{target.title}</strong>
                        <small>{target.entityType === 'channel' ? 'Канал' : 'Чат'}</small>
                      </span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="publication-details-section">
                <strong>Запуски</strong>
                <div className="publication-occurrences">
                  {details.occurrences.length > 0 ? (
                    details.occurrences.map((occurrence) => {
                      const revisionLabel = formatOccurrenceRevision(
                        occurrence,
                        details.content.revision,
                      );
                      const staleContent = isPublicationOccurrenceContentStale(
                        occurrence,
                        details.content.revision,
                      );
                      return (
                        <div
                          key={occurrence.id}
                          className={cn(`is-${occurrence.status.toLowerCase()}`)}
                        >
                          <span className="publication-deliveries__copy">
                            <strong>{formatDateTime(occurrence.scheduledAt)}</strong>
                            <small>
                              Отправлено {occurrence.delivery.sent}/{occurrence.delivery.total}
                            </small>
                            {revisionLabel ? (
                              <small
                                className={cn(
                                  'publication-occurrences__revision',
                                  staleContent && 'is-stale',
                                )}
                              >
                                {revisionLabel}
                              </small>
                            ) : null}
                          </span>
                          <span className="publication-occurrences__actions">
                            <span className="publication-occurrences__status">
                              {OCCURRENCE_STATUS_LABELS[occurrence.status]}
                            </span>
                            {occurrence.canRetry ? (
                              <button
                                type="button"
                                onClick={() => onRetry(details, occurrence)}
                                disabled={busy}
                                aria-label="Повторить запуск"
                              >
                                <RefreshDouble aria-hidden />
                              </button>
                            ) : null}
                          </span>
                        </div>
                      );
                    })
                  ) : (
                    <span className="publication-details-empty">Запусков пока нет</span>
                  )}
                </div>
              </section>

              <section className="publication-details-section">
                <div className="publication-details-section__head">
                  <strong>Доставка</strong>
                  <span
                    className={cn(
                      'publication-details-section__total',
                      ambiguousDeliveries.length > 0 && 'is-danger',
                    )}
                  >
                    Отправлено {details.delivery.sent}/{details.delivery.total}
                    {ambiguousDeliveries.length > 0
                      ? ` · проверить ${Math.max(ambiguousCount, ambiguousDeliveries.length)}`
                      : ''}
                  </span>
                </div>
                {deliveries.length > 0 ? (
                  <div className="publication-deliveries">
                    {deliveries.map((delivery) => {
                      const staleContentRevision = getStaleDeliveryContentRevision(
                        delivery,
                        details.content.revision,
                      );
                      const deliveryError = formatPublicationDeliveryError(delivery.lastError);
                      return (
                        <div key={delivery.id}>
                          <EntityAvatar
                            title={delivery.target.title}
                            entityType={delivery.target.entityType}
                            avatarUrl={delivery.target.avatarUrl}
                          />
                          <span>
                            <strong>{delivery.target.title}</strong>
                            <small
                              className={cn(
                                'publication-deliveries__status',
                                `is-${delivery.status.toLowerCase()}`,
                              )}
                            >
                              {DELIVERY_STATUS_LABELS[delivery.status]}
                            </small>
                            {staleContentRevision ? (
                              <small className="publication-deliveries__revision">
                                Версия {staleContentRevision}
                              </small>
                            ) : null}
                            {deliveryError ? (
                              <small className="publication-deliveries__error">
                                {deliveryError}
                              </small>
                            ) : null}
                          </span>
                          {delivery.status === 'AMBIGUOUS' ? (
                            <span className="publication-delivery-resolution">
                              <button
                                type="button"
                                aria-label={`Подтвердить публикацию в ${delivery.target.title}`}
                                onClick={() =>
                                  onResolveAmbiguous(
                                    details.id,
                                    delivery.occurrenceId,
                                    delivery.id,
                                    'mark_sent',
                                  )
                                }
                                disabled={busy}
                              >
                                Опубликовано
                              </button>
                              <button
                                type="button"
                                className="is-danger"
                                aria-label={`Отметить неотправленной для ${delivery.target.title}`}
                                onClick={() =>
                                  onResolveAmbiguous(
                                    details.id,
                                    delivery.occurrenceId,
                                    delivery.id,
                                    'mark_failed',
                                  )
                                }
                                disabled={busy}
                              >
                                Не отправлено
                              </button>
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : ambiguousInitialError ? (
                  <span className="publication-details-empty">Не удалось загрузить проверку</span>
                ) : ambiguousDeliveriesQuery.isLoading ||
                  !ambiguousPhaseComplete ||
                  deliveriesQuery.isLoading ? (
                  <span className="publication-details-empty">Загрузка...</span>
                ) : ambiguousDeliveriesQuery.isError || deliveriesQuery.isError ? (
                  <span className="publication-details-empty">Детали доставки недоступны</span>
                ) : (
                  <span className="publication-details-empty">Доставок пока нет</span>
                )}
                {deliveries.length > 0 && (!ambiguousPhaseComplete || deliveriesQuery.isLoading) ? (
                  <span className="publication-details-pagination-state">Загрузка...</span>
                ) : null}
                {ambiguousInitialError ? (
                  <button
                    type="button"
                    className="publication-details-load-more"
                    onClick={() => void ambiguousDeliveriesQuery.refetch()}
                    disabled={ambiguousDeliveriesQuery.isFetching}
                  >
                    Повторить
                  </button>
                ) : ambiguousDeliveriesQuery.isFetchNextPageError ? (
                  <button
                    type="button"
                    className="publication-details-load-more"
                    onClick={() => void ambiguousDeliveriesQuery.fetchNextPage()}
                    disabled={ambiguousDeliveriesQuery.isFetchingNextPage}
                  >
                    Повторить
                  </button>
                ) : null}
                {ambiguousPhaseComplete && deliveriesQuery.hasNextPage ? (
                  <button
                    type="button"
                    className="publication-details-load-more"
                    onClick={() => void deliveriesQuery.fetchNextPage()}
                    disabled={deliveriesQuery.isFetchingNextPage}
                  >
                    {deliveriesQuery.isFetchingNextPage
                      ? 'Загрузка...'
                      : deliveriesQuery.isFetchNextPageError
                        ? 'Повторить'
                        : 'Показать ещё'}
                  </button>
                ) : ambiguousPhaseComplete && deliveriesQuery.isError && !deliveriesQuery.data ? (
                  <button
                    type="button"
                    className="publication-details-load-more"
                    onClick={() => void deliveriesQuery.refetch()}
                  >
                    Повторить
                  </button>
                ) : null}
              </section>
            </>
          ) : null}
        </div>

        <footer className="publication-details-sheet__footer">
          {allowEdit && actionCapabilities.canEdit ? (
            <button
              type="button"
              className="publications-primary"
              onClick={() => onEdit(publication.id)}
              disabled={busy}
            >
              <EditPencil aria-hidden />
              <span>{editLabel}</span>
            </button>
          ) : null}
          {actionCapabilities.canCancel ? (
            <button
              type="button"
              className="publication-details-sheet__cancel"
              onClick={() => onCancel(details ?? publication)}
              disabled={busy}
            >
              <Xmark aria-hidden />
              <span>
                {actionCapabilities.hasFutureSends
                  ? 'Отменить будущие отправки'
                  : 'Отменить публикацию'}
              </span>
            </button>
          ) : null}
          <button type="button" onClick={onClose} disabled={busy}>
            Закрыть
          </button>
        </footer>
      </section>
    </div>,
    portalTarget,
  );
}
