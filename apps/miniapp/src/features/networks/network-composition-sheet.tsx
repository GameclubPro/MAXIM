import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ManagedEntityFavoriteType, ManagedEntityType } from '@maxim/contracts';
import type { ApiTransport } from '../../lib/api/transport';
import { useHomeEntityFavorites } from '../../lib/home-entity-favorites-context';
import { useManagedEntityNetworkCompositionDraft } from '../../lib/home-entity-networks-context';
import { useManagedEntityLeaveGuard } from '../../lib/managed-entity-navigation';
import { useNativeBackHandler } from '../../lib/native-back';
import { useVisualViewportOverlayStyle } from '../../lib/use-visual-viewport-overlay-style';
import { isTopmostModalDialog, useDialogFocusTrap } from '../../lib/dialog-focus';
import { ActionConfirmSheet } from '../../components/ui/action-confirm-sheet';
import { AppIcon } from '../../components/ui/app-icon';
import { EntityAvatar } from '../../components/ui/entity-avatar';
import {
  HOME_ENTITY_FAVORITE_TYPES,
  getHomeEntityFavoriteTypes,
} from '../../lib/home-entity-favorites';
import { useNetworkEntries } from './network-community-list';

export function NetworkCompositionSheet({
  api,
  entityType,
  favoriteType,
  onClose,
}: {
  api: ApiTransport;
  entityType: ManagedEntityType;
  favoriteType: ManagedEntityFavoriteType;
  onClose: () => void;
}) {
  const { snapshot, actions } = useHomeEntityFavorites();
  const draft = useManagedEntityNetworkCompositionDraft({ entityType, favoriteType });
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [discardOpen, setDiscardOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewReady, setReviewReady] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const panel = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const saving = draft.phase === 'saving';
  const overlayStyle = useVisualViewportOverlayStyle(true);
  const labels = snapshot.labels.resolved;
  const entries = useNetworkEntries({
    api,
    scopeKey: snapshot.actor.scope,
    entityType,
    search,
    compositionEpoch: snapshot.byType[entityType].compositionEpoch,
  });
  const changes = useMemo(
    () => new Map(draft.changes.map((change) => [change.entityId, change])),
    [draft.changes],
  );
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [query]);
  useDialogFocusTrap(true, panel, closeButton);
  const requestClose = () => {
    if (saving || reviewing) return;
    if (draft.dirty) setDiscardOpen(true);
    else onClose();
  };
  const closeRequest = useRef(requestClose);
  closeRequest.current = requestClose;
  useNativeBackHandler(
    () => {
      requestClose();
      return true;
    },
    { priority: 700 },
  );
  useManagedEntityLeaveGuard({
    dirty: draft.dirty,
    saving: saving || reviewing,
    discardOnly: true,
    save: async () => false,
    discard: draft.discard,
  });
  useEffect(() => {
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && panel.current && isTopmostModalDialog(panel.current)) {
        event.preventDefault();
        closeRequest.current();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = bodyOverflow;
      window.removeEventListener('keydown', keydown);
    };
  }, []);
  const save = async () => {
    setError(null);
    try {
      const result = await draft.save();
      if (result?.refresh === 'complete') onClose();
    } catch {
      setError(
        'Не удалось подтвердить сохранение. Черновик сохранён — обновите состав и проверьте изменения.',
      );
      setReviewReady(false);
    }
  };
  const review = async () => {
    setReviewing(true);
    setReviewReady(false);
    setError(null);
    try {
      await actions.refreshCatalogue(entityType);
      await actions.refreshAssignments(entityType);
      setReviewReady(true);
    } catch {
      setError('Не удалось прочитать актуальный состав. Изменения сохранены в черновике.');
    } finally {
      setReviewing(false);
    }
  };
  const requiresReview = draft.phase === 'review-required' || draft.compositionChanged;
  return createPortal(
    <>
      <div className="network-composition-overlay" style={overlayStyle}>
        <button
          type="button"
          className="network-composition-backdrop"
          aria-label="Закрыть состав сетки"
          tabIndex={-1}
          disabled={saving}
          onClick={requestClose}
        />
        <section
          className="network-composition-sheet"
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby="network-composition-title"
          tabIndex={-1}
        >
          <header>
            <div>
              <small>{entityType === 'chat' ? 'Сетка чатов' : 'Сетка каналов'}</small>
              <h2 id="network-composition-title">{labels[favoriteType]}</h2>
            </div>
            <button
              ref={closeButton}
              type="button"
              className="networks-icon-button"
              aria-label="Закрыть"
              disabled={saving}
              onClick={requestClose}
            >
              <AppIcon icon="Xmark" />
            </button>
          </header>
          <div className="network-composition-sheet__body">
            <p className="networks-caption">
              Перенос изменяет категорию. «Не в избранном» убирает сообщество из сетки.
            </p>
            <label className="networks-search">
              <AppIcon icon="Search" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Найти сообщество"
                aria-label="Поиск сообществ"
              />
            </label>
            {requiresReview ? (
              <div className="networks-notice" role="alert">
                <strong>Нужно согласовать состав</strong>
                <p>
                  Состав изменился или ответ на сохранение не получен. Проверьте актуальные
                  назначения перед новой записью.
                </p>
                <button type="button" disabled={reviewing || saving} onClick={() => void review()}>
                  {reviewing ? 'Обновляем…' : 'Прочитать актуальный состав'}
                </button>
                {reviewReady ? (
                  <>
                    <ul className="network-composition-review">
                      {draft.changes.map((change) => (
                        <li key={change.entityId}>
                          <strong>
                            {entries.items.find((item) => item.id === change.entityId)?.title ??
                              'Сообщество'}
                          </strong>
                          <span>
                            Сейчас:{' '}
                            {(() => {
                              const current = getHomeEntityFavoriteTypes(
                                snapshot.assignments,
                                entityType,
                                change.entityId,
                              )[0];
                              return current ? labels[current] : 'Не в избранном';
                            })()}{' '}
                            → {change.favoriteType ? labels[change.favoriteType] : 'Не в избранном'}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      onClick={() => {
                        try {
                          draft.rebaseAfterReview();
                          setReviewReady(false);
                          setError(null);
                        } catch {
                          setReviewReady(false);
                          setError(
                            'Состав снова изменился. Прочитайте его ещё раз перед согласованием.',
                          );
                        }
                      }}
                    >
                      Принять актуальную основу
                    </button>
                    <small>После проверки нажмите «Сохранить» отдельно.</small>
                  </>
                ) : null}
              </div>
            ) : null}
            {entries.items.map((item) => {
              const change = changes.get(item.id);
              const value = change ? change.favoriteType : item.favoriteType;
              return (
                <label className="network-community-row network-composition-row" key={item.id}>
                  <EntityAvatar
                    title={item.title}
                    entityId={item.id}
                    entityType={item.entityType}
                    avatarUrl={item.avatarUrl}
                  />
                  <span className="network-community-row__text">
                    <strong>{item.title}</strong>
                    <small>
                      {change
                        ? 'Назначение изменено'
                        : item.favoriteType
                          ? labels[item.favoriteType]
                          : 'Не в избранном'}
                    </small>
                    <select
                      aria-label={`Категория: ${item.title}`}
                      value={value ?? ''}
                      disabled={saving || requiresReview || (draft.count >= 500 && !change)}
                      onChange={(event) => {
                        setError(null);
                        draft.stage(
                          item,
                          (event.target.value || null) as ManagedEntityFavoriteType | null,
                        );
                      }}
                    >
                      <option value="">Не в избранном</option>
                      {HOME_ENTITY_FAVORITE_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {labels[type]}
                        </option>
                      ))}
                    </select>
                  </span>
                </label>
              );
            })}
            {entries.loading ? <p role="status">Загружаем…</p> : null}
            {!entries.loading && !entries.error && entries.items.length === 0 ? (
              <p className="networks-caption">Сообщества не найдены.</p>
            ) : null}
            {entries.error ? (
              <div role="alert" className="networks-notice">
                <p>{entries.error}</p>
                <button type="button" onClick={entries.refresh}>
                  Обновить список
                </button>
              </div>
            ) : null}
            {entries.nextCursor && !entries.loading && !entries.error ? (
              <button type="button" className="networks-more" onClick={entries.loadMore}>
                Показать ещё
              </button>
            ) : null}
          </div>
          <footer>
            <span aria-live="polite">
              {draft.count} изменений{draft.count >= 500 ? ' · лимит пакета' : ''}
            </span>
            {error ? <p role="alert">{error}</p> : null}
            {draft.phase === 'saved-refresh-pending' ? (
              <div className="networks-notice" role="status">
                <p>Состав сохранён. Осталось обновить отображение.</p>
                <button
                  type="button"
                  onClick={() =>
                    void actions
                      .refreshCatalogue(entityType)
                      .then(onClose)
                      .catch(() =>
                        setError('Сохранение подтверждено. Обновить отображение пока не удалось.'),
                      )
                  }
                >
                  Обновить
                </button>
              </div>
            ) : null}
            <button
              type="button"
              className="networks-primary"
              disabled={!draft.dirty || saving || reviewing || requiresReview}
              onClick={() => void save()}
            >
              {saving ? 'Сохраняем…' : 'Сохранить состав'}
            </button>
          </footer>
        </section>
      </div>
      <ActionConfirmSheet
        id="network-composition-discard"
        open={discardOpen}
        title="Сбросить изменения состава?"
        summary="Сохранённый состав останется прежним."
        confirmLabel="Сбросить и закрыть"
        cancelLabel="Продолжить редактирование"
        onClose={() => setDiscardOpen(false)}
        onConfirm={() => {
          draft.discard();
          onClose();
        }}
      />
    </>,
    document.querySelector('.design-preview__device-screen') ?? document.body,
  );
}
